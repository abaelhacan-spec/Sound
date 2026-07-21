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
import { readWavAsSamples, computeRMS, cosineSimilarity } from '../utils/audioFingerprint';
import { loadEmbeddingModel, extractEmbedding } from '../utils/embeddingModel';
import {
  loadAlarmReferenceEmbeddings,
  loadKnockReferenceEmbeddings,
  loadPhoneNumber,
  loadDetectionPaths,
  saveDetectionPaths,
  loadSimilarityThreshold,
} from '../utils/storage';

const COOLDOWN_MS = 30000; // مهلة قبل السماح باتصال جديد بعد الاتصال السابق
const CHUNK_DURATION_MS = 2000; // نفس مدة تسجيل عينات المعايرة
const MIN_ENERGY_RMS = 0.015; // بوابة طاقة رخيصة الحساب: أي مقطع أهدأ من هذا يُعتبر صمت ولا يُشغَّل عليه النموذج إطلاقًا (توفير بطارية)

// مرحلة التحقق النهائي: بعد تجاوز عتبة التشابه، نسجّل مقطعًا قصيرًا إضافيًا
// ونعيد فحصه قبل الاتصال فعليًا، لالتقاط الحالات النادرة (كصدى أو انعكاس
// عابر) التي قد تنجح بالصدفة في مقطع واحد فقط.
const CONFIRM_CHUNK_MS = 1000;

/** أقصى تشابه كوساين بين embedding حي وكل العينات المرجعية المخزَّنة */
function maxSimilarity(liveEmbedding, referenceEmbeddings) {
  let best = 0;
  for (const ref of referenceEmbeddings) {
    const sim = cosineSimilarity(liveEmbedding, ref);
    if (sim > best) best = sim;
  }
  return best;
}

export default function MonitoringScreen({ onBackToSettings }) {
  useKeepAwake();

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [status, setStatus] = useState('اضغط "ابدأ المراقبة" للبدء');
  const [lastAlarmSimilarity, setLastAlarmSimilarity] = useState(0);
  const [lastKnockSimilarity, setLastKnockSimilarity] = useState(0);
  const [callCount, setCallCount] = useState(0);
  const [lastTrigger, setLastTrigger] = useState(null); // 'alarm' | 'knock' | null
  const [knockDetectionEnabled, setKnockDetectionEnabled] = useState(true);
  const [alarmDetectionEnabled, setAlarmDetectionEnabled] = useState(true);

  const isMonitoringRef = useRef(false);
  const alarmEmbeddingsRef = useRef(null);
  const knockEmbeddingsRef = useRef(null);
  const thresholdRef = useRef(0.75);
  const lastCallTimeRef = useRef(0);
  const phoneNumberRef = useRef('');
  const knockEnabledRef = useRef(true);
  const alarmEnabledRef = useRef(true);
  const modelRef = useRef(null);

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
    const alarmEmbeddings = await loadAlarmReferenceEmbeddings();
    const knockEmbeddings = await loadKnockReferenceEmbeddings();
    const phone = await loadPhoneNumber();
    const threshold = await loadSimilarityThreshold();

    if (alarmDetectionEnabled && (!alarmEmbeddings || alarmEmbeddings.length === 0)) {
      Alert.alert('إعداد ناقص', 'لازم تعمل معايرة لصوت المنبه أولًا، أو عطّل مسار المنبه من هذه الشاشة');
      return;
    }
    if (knockDetectionEnabled && (!knockEmbeddings || knockEmbeddings.length === 0)) {
      Alert.alert('إعداد ناقص', 'لازم تعمل معايرة لطرق الباب أولًا، أو عطّل مسار الطرق من هذه الشاشة');
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

    setStatus('🧠 جاري تحميل نموذج التعرف الصوتي...');
    modelRef.current = await loadEmbeddingModel();

    alarmEmbeddingsRef.current = alarmEmbeddings;
    knockEmbeddingsRef.current = knockEmbeddings;
    thresholdRef.current = threshold;
    phoneNumberRef.current = phone;
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

  /** يسجّل مقطعًا إضافيًا قصيرًا ويعيد فحص التشابه ضد نفس مجموعة العينات المرجعية، قبل الاتصال فعليًا */
  async function runFinalConfirmation(referenceEmbeddings) {
    const uri = await recordChunk(CONFIRM_CHUNK_MS);
    const samples = await readWavAsSamples(uri);
    await deleteTempFile(uri);

    const energy = computeRMS(samples);
    if (energy < MIN_ENERGY_RMS) return false;

    const embedding = await extractEmbedding(samples, modelRef.current);
    const sim = maxSimilarity(embedding, referenceEmbeddings);
    return sim >= thresholdRef.current;
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

        const energy = computeRMS(samples);

        // بوابة الطاقة: صمت أو ضوضاء خافتة جدًا لا تستحق تشغيل النموذج إطلاقًا
        if (energy < MIN_ENERGY_RMS) {
          if (isMonitoringRef.current) setStatus('🟢 المراقبة شغالة... (صمت)');
          continue;
        }

        const embedding = await extractEmbedding(samples, modelRef.current);

        let alarmSim = 0;
        let knockSim = 0;
        if (alarmEnabledRef.current && alarmEmbeddingsRef.current) {
          alarmSim = maxSimilarity(embedding, alarmEmbeddingsRef.current);
          setLastAlarmSimilarity(alarmSim);
        }
        if (knockEnabledRef.current && knockEmbeddingsRef.current) {
          knockSim = maxSimilarity(embedding, knockEmbeddingsRef.current);
          setLastKnockSimilarity(knockSim);
        }

        const alarmPassed = alarmEnabledRef.current && alarmSim >= thresholdRef.current;
        const knockPassed = knockEnabledRef.current && knockSim >= thresholdRef.current;

        if (knockPassed && knockSim >= alarmSim) {
          setStatus(`🚪 تطابق طرق محتمل (${(knockSim * 100).toFixed(0)}%) — جاري التحقق النهائي...`);
          const confirmed = await runFinalConfirmation(knockEmbeddingsRef.current);
          const now = Date.now();
          if (confirmed) {
            if (now - lastCallTimeRef.current > COOLDOWN_MS) {
              triggerCall('knock');
              lastCallTimeRef.current = now;
              setCallCount((c) => c + 1);
            }
          } else if (isMonitoringRef.current) {
            setStatus('🟢 تم إلغاء الإنذار بعد التحقق النهائي... المراقبة شغالة');
          }
        } else if (alarmPassed) {
          setStatus(`🟡 تطابق منبه محتمل (${(alarmSim * 100).toFixed(0)}%) — جاري التحقق النهائي...`);
          const confirmed = await runFinalConfirmation(alarmEmbeddingsRef.current);
          const now = Date.now();
          if (confirmed) {
            if (now - lastCallTimeRef.current > COOLDOWN_MS) {
              triggerCall('alarm');
              lastCallTimeRef.current = now;
              setCallCount((c) => c + 1);
            }
          } else if (isMonitoringRef.current) {
            setStatus('🟢 تم إلغاء الإنذار بعد التحقق النهائي (لم يستمر الصوت)... المراقبة شغالة');
          }
        } else if (isMonitoringRef.current) {
          const parts = [];
          if (alarmEnabledRef.current) parts.push(`تشابه منبه: ${(alarmSim * 100).toFixed(0)}%`);
          if (knockEnabledRef.current) parts.push(`تشابه طرق: ${(knockSim * 100).toFixed(0)}%`);
          setStatus(`🟢 المراقبة شغالة... (${parts.join(' | ')})`);
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
        : '🔴 تم تأكيد صوت المنبه — جاري الاتصال...'
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
          <Text style={styles.statLabel}>تشابه منبه</Text>
          <Text style={styles.statValue}>{(lastAlarmSimilarity * 100).toFixed(0)}%</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>تشابه طرق</Text>
          <Text style={styles.statValue}>{(lastKnockSimilarity * 100).toFixed(0)}%</Text>
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
    fontSize: 20,
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
