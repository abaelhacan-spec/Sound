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
  computeRMS,
  extractDominantFrequency,
  isFrequencyWithinTolerance,
  frequencyClosenessScore,
  extractBandEnergyDistribution,
  compareBandEnergyDistribution,
  computeEnvelope,
  computeEnvelopeSimilarity,
  extractRhythmPattern,
  compareRhythmPatterns,
  detectKnockPulses,
  extractKnockPulseShape,
  scoreKnockPulseShape,
  GENERIC_KNOCK_REFERENCE,
} from '../utils/audioFingerprint';
import {
  loadAlarmReferenceSamples,
  loadPhoneNumber,
  loadDetectionPaths,
  saveDetectionPaths,
  loadKnockCalibration,
} from '../utils/storage';

const COOLDOWN_MS = 30000; // مهلة قبل السماح باتصال جديد بعد الاتصال السابق
const CHUNK_DURATION_MS = 2500; // يغطي دورة كاملة (صوت+صمت) مع هامش أمان، بنفس مدة معايرة المنبه
const SAMPLE_RATE = 16000; // يجب أن يطابق sampleRate في audioRecorder.js

// ═══════════════════════════════════════════════════════════════════════
// ═══ إعدادات نظام التعرف متعدد المراحل — مسار المنبه ════════════════════
// ═══════════════════════════════════════════════════════════════════════
//
// بوابة الطاقة الدنيا: أي مقطع أهدأ من هذا الحد يُعتبر "صمت" ولا يُقارَن
// بأي بصمة إطلاقًا، لمنع تطابقات وهمية مع ضوضاء خافتة أو صمت المايك.
const MIN_ALARM_ENERGY_RMS = 0.015;

// شرط إلزامي (Hard Gate): التردد الأساسي المكتشف يجب أن يقع ضمن هذه
// النسبة من متوسط التردد الأساسي للعينات المرجعية الثلاث. صوت منبه
// الكمبيوتر نغمة واحدة ثابتة، فتردده مستقر بين العينات، ما يجعل هذا
// الشرط آمنًا وفعّالًا في استبعاد أي صوت آخر مبكرًا وبتكلفة حسابية زهيدة.
const FREQ_HARD_GATE_TOLERANCE_PERCENT = 7;
// نطاق تسامح أوسع قليلاً لحساب "نقطة الدقة" ضمن نظام النقاط (وليس الشرط
// الإلزامي نفسه)، حتى لا تُصفَّر النقطة بالكامل لصوت اجتاز الشرط الإلزامي
// بالكاد.
const FREQ_SCORE_TOLERANCE_PERCENT = 10;

// نظام النقاط المرجّحة (بعد اجتياز الشرطين الإلزاميين: الطاقة والتردد):
//   Cosine Similarity      → نقطتان
//   Envelope Similarity    → نقطتان
//   نمط الإيقاع            → نقطتان
//   توزيع الطاقة الترددي   → نقطة واحدة
//   دقة القرب من التردد    → نقطة واحدة
// المجموع الأقصى = 8 نقاط. عتبة القبول = 6 نقاط (75%).
// نقارن بكل واحدة من العينات المرجعية الثلاث على حدة، ونعتمد على أعلى
// نتيجة إجمالية بينها (Max Similarity)، بدل الاعتماد على متوسط العينات.
const ALARM_PASS_SCORE = 6;
const ALARM_MAX_SCORE = 8;

// مرحلة التحقق النهائي: بعد اجتياز الصوت لعتبة النقاط، نسجّل مقطعًا
// قصيرًا إضافيًا ونعيد فحصه بمعايير سريعة فقط (طاقة + تردد + تشابه طيفي)
// قبل الاتصال فعليًا. هذا يلتقط الحالات النادرة التي ينجح فيها مقطع واحد
// بالصدفة (كصدى أو انعكاس عابر) دون أن يكون الصوت مستمرًا فعليًا.
const CONFIRM_CHUNK_MS = 800;
const CONFIRM_COSINE_THRESHOLD = 0.75;

// ═══════════════════════════════════════════════════════════════════════
// ═══ إعدادات مسار كشف طرق الباب ══════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
//
// المرحلة الأولى (رخيصة الحساب، إقصاء أولي): كشف قفزة RMS مفاجئة.
// المرحلة الثانية (فقط على النبضات التي اجتازت المرحلة الأولى): تحليل
// شكل النبضة فيزيائيًا (Rise/Decay/Width/Bandwidth/Flatness) ومقارنته
// إما بملف طرق شخصي (لو فُعِّلت المعايرة الاختيارية بخمس طرقات حقيقية)
// أو بنطاقات عامة افتراضية لطرقة نموذجية.
const KNOCK_PULSE_SCORE_THRESHOLD = 0.5; // أقل درجة شكل مقبولة لاعتبار النبضة "طرقة محتملة"
const KNOCK_MIN_PULSES_PER_CHUNK = 2; // أقل عدد نبضات مؤهَّلة خلال المقطع الواحد لاعتباره "طرق باب" فعلي

export default function MonitoringScreen({ onBackToSettings }) {
  useKeepAwake();

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [status, setStatus] = useState('اضغط "ابدأ المراقبة" للبدء');
  const [lastAlarmScore, setLastAlarmScore] = useState(0); // من 0 إلى ALARM_MAX_SCORE
  const [callCount, setCallCount] = useState(0);
  const [lastTrigger, setLastTrigger] = useState(null); // 'alarm' | 'knock' | null
  const [knockDetectionEnabled, setKnockDetectionEnabled] = useState(true);
  const [alarmDetectionEnabled, setAlarmDetectionEnabled] = useState(true);

  const isMonitoringRef = useRef(false);
  const lastCallTimeRef = useRef(0);
  const alarmReferenceSamplesRef = useRef(null); // مصفوفة العينات المرجعية الثلاث كاملة
  const avgReferenceFreqRef = useRef(0);
  const phoneNumberRef = useRef('');
  const knockEnabledRef = useRef(true);
  const alarmEnabledRef = useRef(true);
  const knockProfileRef = useRef(GENERIC_KNOCK_REFERENCE); // ملف طرق شخصي أو عام
  const previousQualifiedKnockPulseCountRef = useRef(0); // لتتبّع النبضات المؤهَّلة المقسومة على حدود مقطعين

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
    const referenceSamples = await loadAlarmReferenceSamples();
    const phone = await loadPhoneNumber();
    const knockCalibration = await loadKnockCalibration();

    // العينات المرجعية مطلوبة فقط لو مسار المنبه مُفعّل
    if (alarmDetectionEnabled && (!referenceSamples || referenceSamples.length === 0)) {
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

    alarmReferenceSamplesRef.current = referenceSamples;
    if (referenceSamples && referenceSamples.length > 0) {
      avgReferenceFreqRef.current =
        referenceSamples.reduce((sum, s) => sum + s.dominantFreq, 0) / referenceSamples.length;
    }
    phoneNumberRef.current = phone;
    knockEnabledRef.current = knockDetectionEnabled;
    alarmEnabledRef.current = alarmDetectionEnabled;
    knockProfileRef.current =
      knockCalibration.enabled && knockCalibration.profile
        ? knockCalibration.profile
        : GENERIC_KNOCK_REFERENCE;

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

  /** يقارن مقطعًا حيًا بعينة مرجعية واحدة، ويرجع النقاط الجزئية والمجموع (من أصل 7، قبل إضافة نقطة دقة التردد) */
  function scoreAgainstReferenceSample(liveFingerprint, liveEnvelope, liveRhythm, liveBand, refSample) {
    const cosine = cosineSimilarity(liveFingerprint, refSample.fingerprint);
    const envelopeSim = computeEnvelopeSimilarity(liveEnvelope, refSample.envelope);
    const rhythmScore = compareRhythmPatterns(liveRhythm, refSample.rhythm);
    const bandScore = compareBandEnergyDistribution(liveBand, refSample.bandEnergy);

    const total = cosine * 2 + envelopeSim * 2 + rhythmScore * 2 + bandScore * 1; // من أصل 7
    return { cosine, envelopeSim, rhythmScore, bandScore, total };
  }

  /**
   * يقيّم مقطعًا صوتيًا كاملاً ضد كل العينات المرجعية، ويرجع أفضل نتيجة
   * (Max Similarity) بالإضافة لتفاصيلها. يُستخدم في التقييم الأساسي
   * وأيضًا (بشكل مبسّط جزئيًا) في مرحلة التحقق النهائي.
   */
  function evaluateAlarmChunk(samples) {
    const energy = computeRMS(samples);
    if (energy < MIN_ALARM_ENERGY_RMS) {
      return { passed: false, totalScore: 0, energy, dominantFreq: 0, bestCosine: 0 };
    }

    const fingerprint = extractSpectralFingerprint(samples);
    const dominantFreq = extractDominantFrequency(fingerprint, SAMPLE_RATE);

    const freqGatePass = isFrequencyWithinTolerance(
      dominantFreq,
      avgReferenceFreqRef.current,
      FREQ_HARD_GATE_TOLERANCE_PERCENT
    );
    if (!freqGatePass) {
      return { passed: false, totalScore: 0, energy, dominantFreq, bestCosine: 0 };
    }

    const envelope = computeEnvelope(samples, SAMPLE_RATE);
    const rhythm = extractRhythmPattern(envelope);
    const band = extractBandEnergyDistribution(fingerprint);

    let bestMatch = null;
    for (const refSample of alarmReferenceSamplesRef.current) {
      const result = scoreAgainstReferenceSample(fingerprint, envelope, rhythm, band, refSample);
      if (!bestMatch || result.total > bestMatch.total) bestMatch = result;
    }

    const freqClosenessPoints = frequencyClosenessScore(
      dominantFreq,
      avgReferenceFreqRef.current,
      FREQ_SCORE_TOLERANCE_PERCENT
    );
    const totalScore = bestMatch.total + freqClosenessPoints; // من أصل 8

    return {
      passed: totalScore >= ALARM_PASS_SCORE,
      totalScore,
      energy,
      dominantFreq,
      bestCosine: bestMatch.cosine,
    };
  }

  /** مرحلة التحقق النهائي: تسجيل مقطع قصير إضافي وإعادة فحصه بمعايير سريعة فقط */
  async function runFinalConfirmation() {
    const uri = await recordChunk(CONFIRM_CHUNK_MS);
    const samples = await readWavAsSamples(uri);
    await deleteTempFile(uri);

    const energy = computeRMS(samples);
    if (energy < MIN_ALARM_ENERGY_RMS) return false;

    const fingerprint = extractSpectralFingerprint(samples);
    const dominantFreq = extractDominantFrequency(fingerprint, SAMPLE_RATE);

    const freqOK = isFrequencyWithinTolerance(
      dominantFreq,
      avgReferenceFreqRef.current,
      FREQ_HARD_GATE_TOLERANCE_PERCENT
    );
    if (!freqOK) return false;

    let bestCosine = 0;
    for (const refSample of alarmReferenceSamplesRef.current) {
      const c = cosineSimilarity(fingerprint, refSample.fingerprint);
      if (c > bestCosine) bestCosine = c;
    }

    return bestCosine >= CONFIRM_COSINE_THRESHOLD;
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

        // ── المسار 1: تقييم المنبه بنظام النقاط متعدد المراحل ──
        let alarmEval = { passed: false, totalScore: 0 };
        if (alarmEnabledRef.current && alarmReferenceSamplesRef.current) {
          alarmEval = evaluateAlarmChunk(samples);
          setLastAlarmScore(alarmEval.totalScore);
        }

        // ── المسار 2: كشف نبضات طرق الباب المؤهَّلة شكليًا ──
        let knockDetected = false;
        let qualifiedPulseCount = 0;
        if (knockEnabledRef.current) {
          const { pulseTimestamps } = detectKnockPulses(samples, SAMPLE_RATE);
          for (const t of pulseTimestamps) {
            const shape = extractKnockPulseShape(samples, SAMPLE_RATE, t);
            const { score } = scoreKnockPulseShape(shape, knockProfileRef.current);
            if (score >= KNOCK_PULSE_SCORE_THRESHOLD) qualifiedPulseCount++;
          }
          // النبضتان المؤهَّلتان المطلوبتان قد تُقسمان بين نهاية مقطع وبداية
          // التالي بسبب فجوة التسجيل القصيرة بينهما؛ لذلك نعتبر الطرق
          // مكتشفًا أيضًا لو وُجدت نبضة مؤهَّلة واحدة في هذا المقطع ونبضة
          // مؤهَّلة واحدة على الأقل في المقطع السابق مباشرة.
          knockDetected =
            qualifiedPulseCount >= KNOCK_MIN_PULSES_PER_CHUNK ||
            (qualifiedPulseCount >= 1 && previousQualifiedKnockPulseCountRef.current >= 1);
        }

        if (knockDetected) {
          const now = Date.now();
          setStatus(`🚪 تم اكتشاف طرق على الباب (${qualifiedPulseCount} نبضة مؤهَّلة) — جاري الاتصال...`);
          if (now - lastCallTimeRef.current > COOLDOWN_MS) {
            triggerCall('knock');
            lastCallTimeRef.current = now;
            setCallCount((c) => c + 1);
          }
          previousQualifiedKnockPulseCountRef.current = 0; // تصفير لمنع تفعيل مزدوج من بقايا نفس الطرقة
        } else if (alarmEval.passed) {
          setStatus(
            `🟡 تطابق منبه محتمل (${alarmEval.totalScore.toFixed(1)}/${ALARM_MAX_SCORE}) — جاري التحقق النهائي...`
          );

          const confirmed = await runFinalConfirmation();
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
          previousQualifiedKnockPulseCountRef.current = qualifiedPulseCount;
        } else {
          previousQualifiedKnockPulseCountRef.current = qualifiedPulseCount;
          if (isMonitoringRef.current) {
            const parts = [];
            if (alarmEnabledRef.current) parts.push(`نقاط منبه: ${alarmEval.totalScore.toFixed(1)}/${ALARM_MAX_SCORE}`);
            if (knockEnabledRef.current) parts.push(`نبضات مؤهَّلة: ${qualifiedPulseCount}`);
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
          <Text style={styles.statLabel}>آخر نقاط تطابق منبه</Text>
          <Text style={styles.statValue}>
            {lastAlarmScore.toFixed(1)}/{ALARM_MAX_SCORE}
          </Text>
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
