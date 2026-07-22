import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  TextInput,
  ScrollView,
  Switch,
} from 'react-native';
import { Audio } from 'expo-av';
import {
  recordChunk,
  deleteTempFile,
  requestAudioPermission,
  configureAudioMode,
} from '../utils/audioRecorder';
import { readWavAsSamples, computeRMS } from '../utils/audioFingerprint';
import { loadEmbeddingModel, extractEmbedding } from '../utils/embeddingModel';
import {
  saveAlarmReferenceEmbeddings,
  saveKnockReferenceEmbeddings,
  savePhoneNumber,
  loadPhoneNumber,
  saveDetectionPaths,
  saveSimilarityThreshold,
  loadSimilarityThreshold,
} from '../utils/storage';

// عدد العينات الأدنى المطلوب لكل صوت. كل عينة تُحوَّل إلى Embedding واحد
// (1024 رقم) عبر YAMNet ثم تُخزَّن كما هي — لا حاجة لأي استخراج ميزات يدوي
// بعد الآن. زيادة هذا الرقم (مثلاً إلى 15-20) يُحسِّن الدقة تجريبيًا لأنه
// يمنح "سحابة" أوسع من نقاط المقارنة عند المطابقة (Max Similarity).
const SAMPLES_NEEDED = 5;
const KNOCK_SAMPLES_NEEDED = 5;
const CHUNK_MS = 2000; // كافية لتغطية نغمة المنبه أو الطرقة بالكامل، وأطول من حد YAMNet الأدنى (0.975s)
const MIN_GOOD_ENERGY_RMS = 0.015; // نفس حد الطاقة الدنيا المستخدم أثناء المراقبة، لتنبيه المستخدم مبكرًا لو العينة خافتة جدًا
const THRESHOLD_STEP = 0.05;
const THRESHOLD_MIN = 0.5;
const THRESHOLD_MAX = 0.95;

export default function CalibrationScreen({ onCalibrationComplete, onOpenDiagnostic }) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [alarmDetectionEnabled, setAlarmDetectionEnabled] = useState(true);
  const [knockDetectionEnabled, setKnockDetectionEnabled] = useState(true);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.75);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const soundRef = useRef(null);
  const modelRef = useRef(null);

  // ── حالة معايرة المنبه ──
  const [isRecording, setIsRecording] = useState(false);
  const [collectedAlarmEmbeddings, setCollectedAlarmEmbeddings] = useState([]);
  const [pendingSample, setPendingSample] = useState(null); // { uri, embedding, rms }

  // ── حالة معايرة طرق الباب ──
  const [isRecordingKnock, setIsRecordingKnock] = useState(false);
  const [collectedKnockEmbeddings, setCollectedKnockEmbeddings] = useState([]);
  const [pendingKnockSample, setPendingKnockSample] = useState(null); // { uri, embedding, rms }

  const [status, setStatus] = useState(
    'أدخل رقم الهاتف، ثم اضغط "تسجيل عينة" أثناء تشغيل صوت المنبه بجانب الهاتف'
  );

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
      }
      if (pendingSample?.uri) deleteTempFile(pendingSample.uri);
      if (pendingKnockSample?.uri) deleteTempFile(pendingKnockSample.uri);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadPhoneNumber().then((saved) => {
      if (saved) setPhoneNumber(saved);
    });
    loadSimilarityThreshold().then((saved) => {
      if (typeof saved === 'number' && !Number.isNaN(saved)) setSimilarityThreshold(saved);
    });
  }, []);

  /** يغيّر العتبة بخطوة ثابتة (±0.05) ويحفظها فورًا، بدون انتظار زر "حفظ الإعداد" */
  async function adjustThreshold(delta) {
    const next = Math.min(
      THRESHOLD_MAX,
      Math.max(THRESHOLD_MIN, Math.round((similarityThreshold + delta) * 100) / 100)
    );
    setSimilarityThreshold(next);
    await saveSimilarityThreshold(next);
  }

  /** يحمّل نموذج YAMNet مرة واحدة عند أول استخدام فعلي، وليس عند فتح الشاشة مباشرة */
  async function getModel() {
    if (!modelRef.current) {
      setIsModelLoading(true);
      try {
        modelRef.current = await loadEmbeddingModel();
      } finally {
        setIsModelLoading(false);
      }
    }
    return modelRef.current;
  }

  // ═══════════════════════════════════════════════════════════════════
  // ═══ معايرة صوت المنبه ═══════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════

  async function handleRecordSample() {
    if (!phoneNumber || phoneNumber.trim().length < 5) {
      Alert.alert('تنبيه', 'من فضلك أدخل رقم هاتف صحيح أولًا');
      return;
    }

    const hasPermission = await requestAudioPermission();
    if (!hasPermission) {
      Alert.alert('صلاحية مطلوبة', 'التطبيق يحتاج صلاحية المايكروفون للعمل');
      return;
    }

    let step = 'تحميل النموذج';
    try {
      setIsRecording(true);
      setStatus('🔴 جاري التسجيل... شغّل صوت المنبه الآن بجانب الهاتف');

      const model = await getModel();
      step = 'ضبط وضع الصوت';
      await configureAudioMode();
      step = 'فتح المايك وتسجيل المقطع';
      const uri = await recordChunk(CHUNK_MS);
      if (!uri) throw new Error('لم يُرجِع المسجّل مسار ملف صالح (uri فارغ)');
      step = 'قراءة ملف WAV';
      const samples = await readWavAsSamples(uri);
      if (!samples || samples.length === 0) {
        throw new Error('ملف الصوت فارغ أو غير قابل للقراءة');
      }
      const rms = computeRMS(samples);

      step = 'استخراج البصمة عبر YAMNet';
      setStatus('🧠 جاري استخراج البصمة الصوتية...');
      const embedding = await extractEmbedding(samples, model);

      setPendingSample({ uri, embedding, rms });
      setStatus('🎧 استمع للعينة وتأكد من جودتها، ثم اعتمدها أو أعد التسجيل');
    } catch (err) {
      Alert.alert('خطأ في خطوة: ' + step, err?.message || String(err));
    } finally {
      setIsRecording(false);
    }
  }

  async function handlePlayPending() {
    if (!pendingSample) return;
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      const { sound } = await Audio.Sound.createAsync({ uri: pendingSample.uri });
      soundRef.current = sound;
      setIsPlaying(true);
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.didJustFinish) setIsPlaying(false);
      });
      await sound.playAsync();
    } catch (err) {
      setIsPlaying(false);
      Alert.alert('خطأ', 'تعذر تشغيل العينة: ' + err.message);
    }
  }

  async function cleanupPlayingSound() {
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    setIsPlaying(false);
  }

  async function handleAcceptPending() {
    if (!pendingSample) return;
    const updated = [...collectedAlarmEmbeddings, pendingSample.embedding];
    setCollectedAlarmEmbeddings(updated);

    await cleanupPlayingSound();
    await deleteTempFile(pendingSample.uri);
    setPendingSample(null);

    setStatus(
      updated.length < SAMPLES_NEEDED
        ? `تم اعتماد ${updated.length} من ${SAMPLES_NEEDED} عينات. سجّل عينة أخرى.`
        : 'تم جمع كل عينات المنبه! يمكنك المتابعة لطرق الباب أو حفظ الإعداد.'
    );
  }

  async function handleRejectPending() {
    if (!pendingSample) return;
    await cleanupPlayingSound();
    await deleteTempFile(pendingSample.uri);
    setPendingSample(null);
    setStatus('تم تجاهل العينة. اضغط "تسجيل عينة" لإعادة المحاولة.');
  }

  async function handleReset() {
    if (pendingSample) {
      await cleanupPlayingSound();
      await deleteTempFile(pendingSample.uri);
      setPendingSample(null);
    }
    setCollectedAlarmEmbeddings([]);
    setStatus('تم مسح عينات المنبه. سجّلها من جديد.');
  }

  // ═══════════════════════════════════════════════════════════════════
  // ═══ معايرة طرق الباب ════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════

  async function handleRecordKnockSample() {
    const hasPermission = await requestAudioPermission();
    if (!hasPermission) {
      Alert.alert('صلاحية مطلوبة', 'التطبيق يحتاج صلاحية المايكروفون للعمل');
      return;
    }

    let step = 'تحميل النموذج';
    try {
      setIsRecordingKnock(true);
      setStatus('🔴 جاري التسجيل... اطرق الباب مرة واحدة بقوة اعتيادية الآن');

      const model = await getModel();
      step = 'ضبط وضع الصوت';
      await configureAudioMode();
      step = 'فتح المايك وتسجيل المقطع';
      const uri = await recordChunk(CHUNK_MS);
      if (!uri) throw new Error('لم يُرجِع المسجّل مسار ملف صالح (uri فارغ)');
      step = 'قراءة ملف WAV';
      const samples = await readWavAsSamples(uri);
      if (!samples || samples.length === 0) {
        throw new Error('ملف الصوت فارغ أو غير قابل للقراءة');
      }
      const rms = computeRMS(samples);

      step = 'استخراج البصمة عبر YAMNet';
      setStatus('🧠 جاري استخراج البصمة الصوتية...');
      const embedding = await extractEmbedding(samples, model);

      setPendingKnockSample({ uri, embedding, rms });
      setStatus('🎧 استمع للعينة وتأكد أنها التقطت الطرقة بوضوح، ثم اعتمدها أو أعد التسجيل');
    } catch (err) {
      Alert.alert('خطأ في خطوة: ' + step, err?.message || String(err));
    } finally {
      setIsRecordingKnock(false);
    }
  }

  async function handlePlayPendingKnock() {
    if (!pendingKnockSample) return;
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      const { sound } = await Audio.Sound.createAsync({ uri: pendingKnockSample.uri });
      soundRef.current = sound;
      setIsPlaying(true);
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.didJustFinish) setIsPlaying(false);
      });
      await sound.playAsync();
    } catch (err) {
      setIsPlaying(false);
      Alert.alert('خطأ', 'تعذر تشغيل العينة: ' + err.message);
    }
  }

  async function handleAcceptPendingKnock() {
    if (!pendingKnockSample) return;
    const updated = [...collectedKnockEmbeddings, pendingKnockSample.embedding];
    setCollectedKnockEmbeddings(updated);

    await cleanupPlayingSound();
    await deleteTempFile(pendingKnockSample.uri);
    setPendingKnockSample(null);

    setStatus(
      updated.length < KNOCK_SAMPLES_NEEDED
        ? `تم اعتماد ${updated.length} من ${KNOCK_SAMPLES_NEEDED} طرقات. سجّل طرقة أخرى.`
        : 'تم جمع كل طرقات المعايرة! يمكنك الآن حفظ الإعداد.'
    );
  }

  async function handleRejectPendingKnock() {
    if (!pendingKnockSample) return;
    await cleanupPlayingSound();
    await deleteTempFile(pendingKnockSample.uri);
    setPendingKnockSample(null);
    setStatus('تم تجاهل العينة. اضغط "تسجيل طرقة" لإعادة المحاولة.');
  }

  async function handleResetKnock() {
    if (pendingKnockSample) {
      await cleanupPlayingSound();
      await deleteTempFile(pendingKnockSample.uri);
      setPendingKnockSample(null);
    }
    setCollectedKnockEmbeddings([]);
    setStatus('تم مسح عينات طرق الباب. سجّلها من جديد.');
  }

  // ═══════════════════════════════════════════════════════════════════
  // ═══ إنهاء الإعداد وحفظه ═════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════

  async function handleFinishCalibration() {
    if (!phoneNumber || phoneNumber.trim().length < 5) {
      Alert.alert('تنبيه', 'من فضلك أدخل رقم هاتف صحيح أولًا');
      return;
    }

    if (pendingSample || pendingKnockSample) {
      Alert.alert('عينة بانتظار المراجعة', 'اعتمد العينة المسجّلة أو ألغِها أولًا قبل إنهاء الإعداد');
      return;
    }

    if (!alarmDetectionEnabled && !knockDetectionEnabled) {
      Alert.alert('لا يوجد مسار مفعّل', 'فعّل مسار كشف المنبه أو مسار كشف الطرق على الأقل');
      return;
    }

    if (alarmDetectionEnabled && collectedAlarmEmbeddings.length < SAMPLES_NEEDED) {
      Alert.alert('تنبيه', `لازم تسجل ${SAMPLES_NEEDED} عينات منبه على الأقل، أو عطّل مسار كشف المنبه أعلاه`);
      return;
    }

    if (knockDetectionEnabled && collectedKnockEmbeddings.length < KNOCK_SAMPLES_NEEDED) {
      Alert.alert('تنبيه', `لازم تسجل ${KNOCK_SAMPLES_NEEDED} طرقات على الأقل، أو عطّل مسار كشف الطرق أعلاه`);
      return;
    }

    if (alarmDetectionEnabled) {
      await saveAlarmReferenceEmbeddings(collectedAlarmEmbeddings);
    }
    if (knockDetectionEnabled) {
      await saveKnockReferenceEmbeddings(collectedKnockEmbeddings);
    }

    await savePhoneNumber(phoneNumber.trim());
    await saveDetectionPaths({
      alarmEnabled: alarmDetectionEnabled,
      knockEnabled: knockDetectionEnabled,
    });

    Alert.alert('تم الحفظ', 'تم حفظ إعدادات المراقبة بنجاح', [
      { text: 'حسنًا', onPress: () => onCalibrationComplete() },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>⚙️ إعداد المراقبة</Text>

      {isModelLoading && (
        <View style={styles.modelLoadingBox}>
          <ActivityIndicator color="#60a5fa" />
          <Text style={styles.modelLoadingText}>جاري تحميل نموذج التعرف الصوتي (مرة واحدة فقط)...</Text>
        </View>
      )}

      <Text style={styles.label}>رقم الهاتف المستهدف:</Text>
      <TextInput
        style={styles.input}
        value={phoneNumber}
        onChangeText={setPhoneNumber}
        placeholder="مثال: 0555123456"
        placeholderTextColor="#888"
        keyboardType="phone-pad"
      />

      <View style={styles.divider} />

      <Text style={styles.label}>مسارات الكشف المطلوبة:</Text>
      <View style={styles.togglesBox}>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>🔔 كشف صوت المنبه (يحتاج معايرة)</Text>
          <Switch value={alarmDetectionEnabled} onValueChange={setAlarmDetectionEnabled} />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>🚪 كشف طرق الباب (يحتاج معايرة)</Text>
          <Switch value={knockDetectionEnabled} onValueChange={setKnockDetectionEnabled} />
        </View>
      </View>

      <View style={styles.divider} />

      <Text style={styles.label}>🎚️ حساسية التعرف (العتبة):</Text>
      <Text style={styles.hint}>
        كلما قلّت القيمة زادت الحساسية (يلتقط أسهل، لكن احتمال اتصالات خاطئة أكبر).
        كلما زادت القيمة قلّت الحساسية (دقة أعلى، لكن قد يفوّت الصوت أحيانًا).
      </Text>
      <View style={styles.thresholdRow}>
        <TouchableOpacity
          style={styles.thresholdButton}
          onPress={() => adjustThreshold(-THRESHOLD_STEP)}
          disabled={similarityThreshold <= THRESHOLD_MIN}
        >
          <Text style={styles.thresholdButtonText}>−</Text>
        </TouchableOpacity>

        <Text style={styles.thresholdValue}>{similarityThreshold.toFixed(2)}</Text>

        <TouchableOpacity
          style={styles.thresholdButton}
          onPress={() => adjustThreshold(THRESHOLD_STEP)}
          disabled={similarityThreshold >= THRESHOLD_MAX}
        >
          <Text style={styles.thresholdButtonText}>+</Text>
        </TouchableOpacity>
      </View>

      {alarmDetectionEnabled && (
        <>
          <View style={styles.divider} />

          <Text style={styles.label}>معايرة صوت المنبه:</Text>
          <Text style={styles.hint}>
            سجّل {SAMPLES_NEEDED} عينات من صوت المنبه الحقيقي (كل عينة {(CHUNK_MS / 1000).toFixed(1)} ثانية).
            كل عينة تُحوَّل تلقائيًا إلى بصمة صوتية (Embedding) عبر نموذج ذكاء اصطناعي جاهز، وتُقارَن لاحقًا
            بأقرب تطابق أثناء المراقبة.
          </Text>

          <Text style={styles.progress}>
            العينات المعتمدة: {collectedAlarmEmbeddings.length} / {SAMPLES_NEEDED}
          </Text>

          <TouchableOpacity
            style={[styles.button, (isRecording || pendingSample) && styles.buttonDisabled]}
            onPress={handleRecordSample}
            disabled={isRecording || !!pendingSample}
          >
            {isRecording ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>🎙️ تسجيل عينة</Text>
            )}
          </TouchableOpacity>

          {pendingSample && (
            <View style={styles.reviewBox}>
              <Text style={styles.reviewTitle}>🎧 مراجعة العينة قبل الاعتماد</Text>
              <Text
                style={[
                  styles.reviewQuality,
                  pendingSample.rms < MIN_GOOD_ENERGY_RMS ? styles.reviewQualityWeak : styles.reviewQualityGood,
                ]}
              >
                {pendingSample.rms < MIN_GOOD_ENERGY_RMS
                  ? '⚠️ الصوت خافت — قرّب الهاتف من مصدر الصوت أو ارفع مستواه، وأعد التسجيل'
                  : '✅ مستوى الصوت جيد'}
              </Text>

              <TouchableOpacity style={styles.playButton} onPress={handlePlayPending}>
                <Text style={styles.buttonText}>{isPlaying ? '⏸️ جاري التشغيل...' : '▶️ استماع للعينة'}</Text>
              </TouchableOpacity>

              <View style={styles.reviewActionsRow}>
                <TouchableOpacity style={styles.rejectButton} onPress={handleRejectPending}>
                  <Text style={styles.buttonText}>🔁 إعادة التسجيل</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.acceptButton} onPress={handleAcceptPending}>
                  <Text style={styles.buttonText}>✅ اعتماد العينة</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {collectedAlarmEmbeddings.length > 0 && (
            <TouchableOpacity style={styles.secondaryButton} onPress={handleReset}>
              <Text style={styles.secondaryButtonText}>إعادة تعيين عينات المنبه</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      {knockDetectionEnabled && (
        <>
          <View style={styles.divider} />

          <Text style={styles.label}>معايرة طرق الباب:</Text>
          <Text style={styles.hint}>
            سجّل {KNOCK_SAMPLES_NEEDED} طرقات حقيقية على بابك (طرقة واحدة في كل تسجيل) لبناء بصمة صوتية
            خاصة بصوت طرق هذا الباب بالذات.
          </Text>

          <Text style={styles.progress}>
            الطرقات المعتمدة: {collectedKnockEmbeddings.length} / {KNOCK_SAMPLES_NEEDED}
          </Text>

          <TouchableOpacity
            style={[styles.button, (isRecordingKnock || pendingKnockSample) && styles.buttonDisabled]}
            onPress={handleRecordKnockSample}
            disabled={isRecordingKnock || !!pendingKnockSample}
          >
            {isRecordingKnock ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>🚪 تسجيل طرقة</Text>
            )}
          </TouchableOpacity>

          {pendingKnockSample && (
            <View style={styles.reviewBox}>
              <Text style={styles.reviewTitle}>🎧 مراجعة الطرقة قبل الاعتماد</Text>
              <Text
                style={[
                  styles.reviewQuality,
                  pendingKnockSample.rms < MIN_GOOD_ENERGY_RMS
                    ? styles.reviewQualityWeak
                    : styles.reviewQualityGood,
                ]}
              >
                {pendingKnockSample.rms < MIN_GOOD_ENERGY_RMS
                  ? '⚠️ الصوت خافت جدًا — اطرق بقوة أكبر وأعد المحاولة'
                  : '✅ مستوى الصوت جيد'}
              </Text>

              <TouchableOpacity style={styles.playButton} onPress={handlePlayPendingKnock}>
                <Text style={styles.buttonText}>
                  {isPlaying ? '⏸️ جاري التشغيل...' : '▶️ استماع للعينة'}
                </Text>
              </TouchableOpacity>

              <View style={styles.reviewActionsRow}>
                <TouchableOpacity style={styles.rejectButton} onPress={handleRejectPendingKnock}>
                  <Text style={styles.buttonText}>🔁 إعادة التسجيل</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.acceptButton} onPress={handleAcceptPendingKnock}>
                  <Text style={styles.buttonText}>✅ اعتماد الطرقة</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {collectedKnockEmbeddings.length > 0 && (
            <TouchableOpacity style={styles.secondaryButton} onPress={handleResetKnock}>
              <Text style={styles.secondaryButtonText}>إعادة تعيين طرقات المعايرة</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      <Text style={styles.status}>{status}</Text>

      <TouchableOpacity style={[styles.button, styles.finishButton]} onPress={handleFinishCalibration}>
        <Text style={styles.buttonText}>✅ حفظ وإنهاء الإعداد</Text>
      </TouchableOpacity>

      {onOpenDiagnostic && (
        <TouchableOpacity style={styles.diagnosticButton} onPress={onOpenDiagnostic}>
          <Text style={styles.diagnosticButtonText}>🔬 فحص النموذج (تشخيص)</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    paddingBottom: 60,
    backgroundColor: '#121212',
    flexGrow: 1,
  },
  title: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
  },
  modelLoadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  modelLoadingText: {
    color: '#93c5fd',
    fontSize: 12,
    marginLeft: 8,
  },
  label: {
    color: '#ccc',
    fontSize: 14,
    marginBottom: 8,
  },
  hint: {
    color: '#888',
    fontSize: 12,
    marginBottom: 12,
    lineHeight: 18,
  },
  input: {
    backgroundColor: '#1e1e1e',
    color: '#fff',
    padding: 12,
    borderRadius: 10,
    fontSize: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#333',
  },
  divider: {
    height: 1,
    backgroundColor: '#333',
    marginVertical: 20,
  },
  togglesBox: {
    backgroundColor: '#2a2a2a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  toggleLabel: {
    color: '#fff',
    fontSize: 14,
    flex: 1,
    marginRight: 8,
  },
  progress: {
    color: '#4CAF50',
    fontSize: 15,
    marginBottom: 16,
    textAlign: 'center',
  },
  thresholdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  thresholdButton: {
    backgroundColor: '#2563eb',
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thresholdButtonText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
  },
  thresholdValue: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    marginHorizontal: 24,
    minWidth: 70,
    textAlign: 'center',
  },
  reviewBox: {
    backgroundColor: '#232b3d',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#2563eb',
  },
  reviewTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  reviewQuality: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 19,
  },
  reviewQualityGood: {
    color: '#4ade80',
  },
  reviewQualityWeak: {
    color: '#facc15',
  },
  playButton: {
    backgroundColor: '#334155',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  reviewActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rejectButton: {
    backgroundColor: '#dc2626',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  acceptButton: {
    backgroundColor: '#16a34a',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    flex: 1,
    marginLeft: 8,
  },
  button: {
    backgroundColor: '#2563eb',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    padding: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  secondaryButtonText: {
    color: '#f87171',
    fontSize: 14,
  },
  status: {
    color: '#aaa',
    fontSize: 13,
    textAlign: 'center',
    marginVertical: 16,
    lineHeight: 20,
  },
  finishButton: {
    backgroundColor: '#16a34a',
    marginTop: 8,
  },
  diagnosticButton: {
    padding: 12,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  diagnosticButtonText: {
    color: '#475569',
    fontSize: 13,
    textDecorationLine: 'underline',
  },
});
