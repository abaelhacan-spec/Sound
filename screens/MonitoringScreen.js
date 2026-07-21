import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Switch } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import ImmediatePhoneCall from 'react-native-immediate-phone-call';
import {
  recordChunk,
  deleteTempFile,
  requestAudioPermission,
  configureAudioMode,
} from '../utils/audioRecorder';
import {
  readWavAsSamples,
  extractSpectralFingerprint,
  cosineSimilarity,
  detectKnockPulses,
  computeRMS,
} from '../utils/audioFingerprint';
import {
  loadReferenceFingerprint,
  loadPhoneNumber,
  loadThreshold,
  loadDetectionPaths,
  saveDetectionPaths,
} from '../utils/storage';

const CONSECUTIVE_MATCHES_NEEDED = 3; // عدد المقاطع المتتالية المطلوب تطابقها (مسار المنبه)
const COOLDOWN_MS = 30000; // مهلة قبل السماح باتصال جديد بعد الاتصال السابق
const CHUNK_DURATION_MS = 2500; // يغطي دورة كاملة (صوت+صمت) مع هامش أمان، بنفس مدة المعايرة
const SAMPLE_RATE = 16000; // يجب أن يطابق sampleRate في audioRecorder.js

// إعدادات مسار كشف الطرق (لا يحتاج معايرة، يكشف أي نبضة صوت حادة ومفاجئة)
const KNOCK_MIN_PULSES_PER_CHUNK = 2; // أقل عدد نبضات خلال المقطع الواحد لاعتباره "طرق باب" فعلي

// بوابة الطاقة الدنيا لمسار المنبه: أي مقطع أهدأ من هذا الحد يُعتبر "صمت"
// ولا يُقارَن بالبصمة إطلاقًا، لمنع تطابقات وهمية مع ضوضاء خافتة أو صمت المايك.
// لو لاحظت أن الاتصالات الوهمية مستمرة رغم هذا، ارفع القيمة قليلاً (مثلاً 0.02).
// لو لاحظت أن المنبه الحقيقي لا يُكتشف، اخفضها قليلاً (مثلاً 0.008).
const MIN_ALARM_ENERGY_RMS = 0.015;

export default function MonitoringScreen({ onBackToSettings }) {
  useKeepAwake();

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [status, setStatus] = useState('اضغط "ابدأ المراقبة" للبدء');
  const [lastSimilarity, setLastSimilarity] = useState(0);
  const [callCount, setCallCount] = useState(0);
  const [lastTrigger, setLastTrigger] = useState(null); // 'alarm' | 'knock' | null
  const [knockDetectionEnabled, setKnockDetectionEnabled] = useState(true);
  const [alarmDetectionEnabled, setAlarmDetectionEnabled] = useState(true);

  const isMonitoringRef = useRef(false);
  const matchCountRef = useRef(0);
  const lastCallTimeRef = useRef(0);
  const referenceFingerprintRef = useRef(null);
  const phoneNumberRef = useRef('');
  const thresholdRef = useRef(0.85);
  const knockEnabledRef = useRef(true);
  const alarmEnabledRef = useRef(true);
  const previousKnockPulseCountRef = useRef(0); // لتتبّع النبضات المقسومة على حدود مقطعين متتاليين

  useEffect(() => {
    loadDetectionPaths().then(({ alarmEnabled, knockEnabled }) => {
      setAlarmDetectionEnabled(alarmEnabled);
      setKnockDetectionEnabled(knockEnabled);
    });

    return () => {
      isMonitoringRef.current = false;
    };
  }, []);

  async function startMonitoring() {
    const fingerprint = await loadReferenceFingerprint();
    const phone = await loadPhoneNumber();
    const threshold = await loadThreshold();

    // بصمة المنبه مطلوبة فقط لو مسار المنبه مُفعّل
    if (alarmDetectionEnabled && !fingerprint) {
      Alert.alert('إعداد ناقص', 'لازم تعمل معايرة لصوت المنبه أولًا، أو عطّل مسار المنبه من هذه الشاشة');
      return;
    }
    if (!phone) {
      Alert.alert('إعداد ناقص', 'لازم تدخل رقم الهاتف أولًا');
      return;
    }
    if (!alarmDetectionEnabled && !knockDetectionEnabled) {
      Alert.alert('لا يوجد مسار مفعّل', 'فعّل مسار كشف المنبه أو مسار كشف الطرق على الأقل');
      return;
    }

    const hasPermission = await requestAudioPermission();
    if (!hasPermission) {
      Alert.alert('صلاحية مطلوبة', 'التطبيق يحتاج صلاحية المايكروفون للعمل');
      return;
    }

    referenceFingerprintRef.current = fingerprint;
    phoneNumberRef.current = phone;
    thresholdRef.current = threshold;
    knockEnabledRef.current = knockDetectionEnabled;
    alarmEnabledRef.current = alarmDetectionEnabled;

    await saveDetectionPaths({
      alarmEnabled: alarmDetectionEnabled,
      knockEnabled: knockDetectionEnabled,
    });

    await configureAudioMode();

    isMonitoringRef.current = true;
    setIsMonitoring(true);
    setStatus('🟢 المراقبة شغالة...');

    monitoringLoop();
  }

  function stopMonitoring() {
    isMonitoringRef.current = false;
    setIsMonitoring(false);
    setStatus('تم إيقاف المراقبة');
  }

  async function monitoringLoop() {
    while (isMonitoringRef.current) {
      try {
        const uri = await recordChunk(CHUNK_DURATION_MS);
        if (!isMonitoringRef.current) {
          await deleteTempFile(uri);
          break;
        }

        const samples = await readWavAsSamples(uri);
        await deleteTempFile(uri);

        let alarmMatched = false;
        let similarity = 0;

        // ── المسار 1: مطابقة بصمة المنبه الترددية (مع بوابة طاقة دنيا) ──
        if (alarmEnabledRef.current && referenceFingerprintRef.current) {
          const overallEnergy = computeRMS(samples);
          if (overallEnergy >= MIN_ALARM_ENERGY_RMS) {
            const fingerprint = extractSpectralFingerprint(samples);
            similarity = cosineSimilarity(fingerprint, referenceFingerprintRef.current);
            setLastSimilarity(similarity);
            alarmMatched = similarity >= thresholdRef.current;
          } else {
            // المقطع هادئ جدًا (صمت تقريبًا) — لا تتم مقارنته بالبصمة إطلاقًا
            setLastSimilarity(0);
          }
        }

        // ── المسار 2: كشف نبضات طرق الباب المفاجئة (مع تراكب بين المقاطع) ──
        let knockDetected = false;
        let knockPulseCount = 0;
        if (knockEnabledRef.current) {
          const { pulseCount } = detectKnockPulses(samples, SAMPLE_RATE);
          knockPulseCount = pulseCount;
          // النبضتان المطلوبتان قد تُقسمان بين نهاية مقطع وبداية التالي بسبب
          // فجوة التسجيل القصيرة بينهما؛ لذلك نعتبر الطرق مكتشفًا أيضًا لو
          // وُجدت نبضة واحدة في هذا المقطع ونبضة واحدة على الأقل في المقطع
          // السابق مباشرة.
          knockDetected =
            pulseCount >= KNOCK_MIN_PULSES_PER_CHUNK ||
            (pulseCount >= 1 && previousKnockPulseCountRef.current >= 1);
        }

        if (knockDetected) {
          // الطرق يُكتشف فوريًا (لا يحتاج تكرار متتالي، فهو أصلاً يتطلب عدة نبضات ضمن المقطع نفسه)
          const now = Date.now();
          setStatus(`🚪 تم اكتشاف طرق على الباب (${knockPulseCount} نبضات) — جاري الاتصال...`);
          if (now - lastCallTimeRef.current > COOLDOWN_MS) {
            triggerCall('knock');
            lastCallTimeRef.current = now;
            setCallCount((c) => c + 1);
          }
          matchCountRef.current = 0;
          previousKnockPulseCountRef.current = 0; // تصفير لمنع تفعيل مزدوج من بقايا نفس الطرقة
        } else if (alarmMatched) {
          matchCountRef.current += 1;
          setStatus(
            `🟡 تطابق منبه محتمل (${matchCountRef.current}/${CONSECUTIVE_MATCHES_NEEDED}) - تشابه ${(similarity * 100).toFixed(0)}%`
          );

          if (matchCountRef.current >= CONSECUTIVE_MATCHES_NEEDED) {
            const now = Date.now();
            if (now - lastCallTimeRef.current > COOLDOWN_MS) {
              triggerCall('alarm');
              lastCallTimeRef.current = now;
              setCallCount((c) => c + 1);
            }
            matchCountRef.current = 0;
          }
          previousKnockPulseCountRef.current = knockPulseCount;
        } else {
          matchCountRef.current = 0;
          previousKnockPulseCountRef.current = knockPulseCount;
          if (isMonitoringRef.current) {
            const parts = [];
            if (alarmEnabledRef.current) parts.push(`تشابه منبه: ${(similarity * 100).toFixed(0)}%`);
            if (knockEnabledRef.current) parts.push(`نبضات طرق: ${knockPulseCount}`);
            setStatus(`🟢 المراقبة شغالة... (${parts.join(' | ')})`);
          }
        }
      } catch (err) {
        setStatus('⚠️ خطأ أثناء التحليل: ' + err.message);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  function triggerCall(source) {
    setLastTrigger(source);
    setStatus(
      source === 'knock'
        ? '🔴 تم اكتشاف طرق على الباب — جاري الاتصال...'
        : '🔴 تم اكتشاف صوت المنبه — جاري الاتصال...'
    );
    try {
      ImmediatePhoneCall.immediatePhoneCall(phoneNumberRef.current);
    } catch (err) {
      Alert.alert('خطأ في الاتصال', err.message);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>📡 مراقبة الصوت</Text>

      {!isMonitoring && (
        <View style={styles.togglesBox}>
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>🔔 كشف صوت المنبه</Text>
            <Switch value={alarmDetectionEnabled} onValueChange={setAlarmDetectionEnabled} />
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>🚪 كشف طرق الباب</Text>
            <Switch value={knockDetectionEnabled} onValueChange={setKnockDetectionEnabled} />
          </View>
        </View>
      )}

      <View style={styles.statusBox}>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>آخر تشابه منبه</Text>
          <Text style={styles.statValue}>{(lastSimilarity * 100).toFixed(0)}%</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>عدد الاتصالات</Text>
          <Text style={styles.statValue}>{callCount}</Text>
        </View>
      </View>

      {lastTrigger && (
        <Text style={styles.lastTriggerText}>
          آخر سبب اتصال: {lastTrigger === 'knock' ? 'طرق على الباب 🚪' : 'صوت منبه 🔔'}
        </Text>
      )}

      {!isMonitoring ? (
        <TouchableOpacity style={styles.startButton} onPress={startMonitoring}>
          <Text style={styles.buttonText}>▶️ ابدأ المراقبة</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.stopButton} onPress={stopMonitoring}>
          <Text style={styles.buttonText}>⏹️ إيقاف المراقبة</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.settingsButton} onPress={onBackToSettings}>
        <Text style={styles.settingsButtonText}>⚙️ العودة إلى الإعدادات</Text>
      </TouchableOpacity>

      <Text style={styles.footerNote}>
        تنبيه: يجب إبقاء الشاشة مفتوحة والتطبيق في المقدمة أثناء المراقبة، ويُفضّل
        توصيل الهاتف بالشاحن.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    padding: 24,
    paddingTop: 60,
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 16,
  },
  togglesBox: {
    backgroundColor: '#2a2a2a',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    marginBottom: 16,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  toggleLabel: {
    color: '#fff',
    fontSize: 15,
  },
  statusBox: {
    backgroundColor: '#2a2a2a',
    borderRadius: 12,
    padding: 20,
    width: '100%',
    marginBottom: 20,
    minHeight: 80,
    justifyContent: 'center',
  },
  statusText: {
    color: '#fff',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  statsRow: {
    flexDirection: 'row',
    width: '100%',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  statBox: {
    backgroundColor: '#2a2a2a',
    borderRadius: 12,
    padding: 16,
    flex: 1,
    marginHorizontal: 4,
    alignItems: 'center',
  },
  statLabel: {
    color: '#aaa',
    fontSize: 12,
    marginBottom: 4,
  },
  statValue: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
  },
  lastTriggerText: {
    color: '#facc15',
    fontSize: 13,
    marginBottom: 16,
  },
  startButton: {
    backgroundColor: '#16a34a',
    padding: 18,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
    marginBottom: 12,
  },
  stopButton: {
    backgroundColor: '#dc2626',
    padding: 18,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: 'bold',
  },
  settingsButton: {
    padding: 12,
    marginTop: 8,
  },
  settingsButtonText: {
    color: '#60a5fa',
    fontSize: 14,
  },
  footerNote: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 30,
    lineHeight: 18,
  },
});
