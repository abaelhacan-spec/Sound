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
import {
  readWavAsSamples,
  extractSpectralFingerprint,
  computeRMS,
  extractDominantFrequency,
  extractBandEnergyDistribution,
  computeEnvelope,
  extractRhythmPattern,
  detectKnockPulses,
  extractKnockPulseShape,
  averageKnockShapes,
} from '../utils/audioFingerprint';
import {
  saveAlarmReferenceSamples,
  savePhoneNumber,
  loadPhoneNumber,
  saveDetectionPaths,
  saveKnockCalibration,
} from '../utils/storage';

const SAMPLES_NEEDED = 3; // عدد عينات معايرة المنبه المطلوبة
const KNOCK_SAMPLES_NEEDED = 5; // عدد عينات معايرة طرق الباب الاختيارية
const CALIBRATION_CHUNK_MS = 2500; // يغطي دورة كاملة (صوت+صمت) مع هامش أمان لصوت المنبه
const KNOCK_CALIBRATION_CHUNK_MS = 1500; // كافية لالتقاط طرقة واحدة واضحة
const SAMPLE_RATE = 16000;
const MIN_GOOD_ENERGY_RMS = 0.015; // نفس حد الطاقة الدنيا المستخدم أثناء المراقبة، لتنبيه المستخدم مبكرًا لو العينة خافتة جدًا

export default function CalibrationScreen({ onCalibrationComplete }) {
  const [isRecording, setIsRecording] = useState(false);
  const [samplesCollected, setSamplesCollected] = useState(0);
  const [collectedAlarmSamples, setCollectedAlarmSamples] = useState([]); // كل عنصر: {fingerprint, dominantFreq, envelope, rhythm, bandEnergy, rms}
  const [phoneNumber, setPhoneNumber] = useState('');
  const [alarmDetectionEnabled, setAlarmDetectionEnabled] = useState(true);
  const [knockDetectionEnabled, setKnockDetectionEnabled] = useState(true);
  const [pendingSample, setPendingSample] = useState(null); // عينة منبه بانتظار المراجعة: { uri, features }
  const [isPlaying, setIsPlaying] = useState(false);
  const soundRef = useRef(null);

  // ── حالة معايرة طرق الباب الاختيارية ──
  const [knockCalibrationEnabled, setKnockCalibrationEnabled] = useState(false);
  const [isRecordingKnock, setIsRecordingKnock] = useState(false);
  const [knockShapesCollected, setKnockShapesCollected] = useState([]); // شكل نبضة لكل عينة مقبولة
  const [pendingKnockSample, setPendingKnockSample] = useState(null); // { uri, shape, pulseCount }

  const [status, setStatus] = useState(
    'أدخل رقم الهاتف، ثم اضغط "تسجيل عينة" أثناء تشغيل صوت المنبه بجانب الهاتف'
  );

  // تنظيف الصوت والملفات المؤقتة لو المستخدم غادر الشاشة وفيه عينات لسه معلّقة
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
  }, []);

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

    try {
      setIsRecording(true);
      setStatus('🔴 جاري التسجيل... شغّل صوت المنبه الآن بجانب الهاتف');

      await configureAudioMode();
      const uri = await recordChunk(CALIBRATION_CHUNK_MS);
      const samples = await readWavAsSamples(uri);

      // ── استخراج كل الخصائص المطلوبة للنظام الجديد دفعة واحدة ──
      const fingerprint = extractSpectralFingerprint(samples);
      const dominantFreq = extractDominantFrequency(fingerprint, SAMPLE_RATE);
      const bandEnergy = extractBandEnergyDistribution(fingerprint);
      const envelope = computeEnvelope(samples, SAMPLE_RATE);
      const rhythm = extractRhythmPattern(envelope); // نمط الإيقاع يُستخرج تلقائيًا من نفس المقطع، بدون خطوة إضافية من المستخدم
      const rms = computeRMS(samples);

      const features = { fingerprint, dominantFreq, bandEnergy, envelope, rhythm, rms };

      // لا نحذف الملف ولا نضيف العينة مباشرة — ننتظر مراجعة المستخدم أولًا
      setPendingSample({ uri, features });
      setStatus('🎧 استمع للعينة وتأكد من جودتها، ثم اعتمدها أو أعد التسجيل');
    } catch (err) {
      Alert.alert('خطأ', 'حدث خطأ أثناء التسجيل: ' + err.message);
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
    const updated = [...collectedAlarmSamples, pendingSample.features];
    setCollectedAlarmSamples(updated);
    setSamplesCollected(updated.length);

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
    setCollectedAlarmSamples([]);
    setSamplesCollected(0);
    setStatus('تم مسح عينات المنبه. سجّلها من جديد.');
  }

  // ═══════════════════════════════════════════════════════════════════
  // ═══ معايرة طرق الباب (اختيارية) ═════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════

  async function handleRecordKnockSample() {
    const hasPermission = await requestAudioPermission();
    if (!hasPermission) {
      Alert.alert('صلاحية مطلوبة', 'التطبيق يحتاج صلاحية المايكروفون للعمل');
      return;
    }

    try {
      setIsRecordingKnock(true);
      setStatus('🔴 جاري التسجيل... اطرق الباب مرة واحدة بقوة اعتيادية الآن');

      await configureAudioMode();
      const uri = await recordChunk(KNOCK_CALIBRATION_CHUNK_MS);
      const samples = await readWavAsSamples(uri);

      const { pulseCount, pulseTimestamps } = detectKnockPulses(samples, SAMPLE_RATE);

      if (pulseCount === 0) {
        setPendingKnockSample({ uri, shape: null, pulseCount: 0 });
        setStatus('⚠️ لم يُكتشف طرق واضح في هذه العينة');
        return;
      }

      // لو حصلت أكثر من نبضة (طرقتين بالغلط)، نختار الأقوى (الأعلى طاقة) كممثّل للعينة
      let strongestTimeSec = pulseTimestamps[0];
      if (pulseTimestamps.length > 1) {
        let bestEnergy = -1;
        for (const t of pulseTimestamps) {
          const centerIdx = Math.round(t * SAMPLE_RATE);
          const windowSamples = samples.slice(
            Math.max(0, centerIdx - 400),
            Math.min(samples.length, centerIdx + 400)
          );
          const energy = computeRMS(windowSamples);
          if (energy > bestEnergy) {
            bestEnergy = energy;
            strongestTimeSec = t;
          }
        }
      }

      const shape = extractKnockPulseShape(samples, SAMPLE_RATE, strongestTimeSec);
      setPendingKnockSample({ uri, shape, pulseCount });
      setStatus('🎧 استمع للعينة وتأكد أنها التقطت الطرقة بوضوح، ثم اعتمدها أو أعد التسجيل');
    } catch (err) {
      Alert.alert('خطأ', 'حدث خطأ أثناء التسجيل: ' + err.message);
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
    if (!pendingKnockSample || !pendingKnockSample.shape) return;
    const updated = [...knockShapesCollected, pendingKnockSample.shape];
    setKnockShapesCollected(updated);

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
    setKnockShapesCollected([]);
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

    if (pendingSample) {
      Alert.alert('عينة منبه بانتظار المراجعة', 'اعتمد العينة المسجّلة أو ألغِها أولًا قبل إنهاء الإعداد');
      return;
    }
    if (pendingKnockSample) {
      Alert.alert('عينة طرق بانتظار المراجعة', 'اعتمد العينة المسجّلة أو ألغِها أولًا قبل إنهاء الإعداد');
      return;
    }

    if (!alarmDetectionEnabled && !knockDetectionEnabled) {
      Alert.alert('لا يوجد مسار مفعّل', 'فعّل مسار كشف المنبه أو مسار كشف الطرق على الأقل');
      return;
    }

    if (alarmDetectionEnabled && collectedAlarmSamples.length < SAMPLES_NEEDED) {
      Alert.alert('تنبيه', `لازم تسجل ${SAMPLES_NEEDED} عينات منبه على الأقل، أو عطّل مسار كشف المنبه أعلاه`);
      return;
    }

    if (knockDetectionEnabled && knockCalibrationEnabled && knockShapesCollected.length < KNOCK_SAMPLES_NEEDED) {
      Alert.alert(
        'تنبيه',
        `فعّلت معايرة طرق الباب لكن لم تكمل ${KNOCK_SAMPLES_NEEDED} طرقات بعد. أكملها، أو عطّل مفتاح "معايرة طرق الباب" لاستخدام الكشف العام بدلًا منها`
      );
      return;
    }

    if (alarmDetectionEnabled) {
      await saveAlarmReferenceSamples(collectedAlarmSamples);
    }

    await savePhoneNumber(phoneNumber.trim());
    await saveDetectionPaths({
      alarmEnabled: alarmDetectionEnabled,
      knockEnabled: knockDetectionEnabled,
    });

    if (knockDetectionEnabled && knockCalibrationEnabled) {
      const profile = averageKnockShapes(knockShapesCollected);
      await saveKnockCalibration({ enabled: true, profile });
    } else {
      await saveKnockCalibration({ enabled: false, profile: null });
    }

    Alert.alert('تم الحفظ', 'تم حفظ إعدادات المراقبة بنجاح', [
      { text: 'حسنًا', onPress: () => onCalibrationComplete() },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>⚙️ إعداد المراقبة</Text>

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
          <Text style={styles.toggleLabel}>🚪 كشف طرق الباب (بدون معايرة إلزامية)</Text>
          <Switch value={knockDetectionEnabled} onValueChange={setKnockDetectionEnabled} />
        </View>
      </View>

      {alarmDetectionEnabled && (
        <>
          <View style={styles.divider} />

          <Text style={styles.label}>معايرة صوت المنبه:</Text>
          <Text style={styles.hint}>
            سجّل {SAMPLES_NEEDED} عينات من صوت المنبه الحقيقي (كل عينة {(CALIBRATION_CHUNK_MS / 1000).toFixed(1)} ثانية) لبناء ملف مرجعي دقيق يشمل الشكل الطيفي والزمني والإيقاعي للصوت.
          </Text>

          <Text style={styles.progress}>
            العينات المعتمدة: {samplesCollected} / {SAMPLES_NEEDED}
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
                  pendingSample.features.rms < MIN_GOOD_ENERGY_RMS
                    ? styles.reviewQualityWeak
                    : styles.reviewQualityGood,
                ]}
              >
                {pendingSample.features.rms < MIN_GOOD_ENERGY_RMS
                  ? '⚠️ الصوت خافت — قرّب الهاتف من مصدر الصوت أو ارفع مستواه، وأعد التسجيل'
                  : '✅ مستوى الصوت جيد'}
              </Text>
              <Text style={styles.reviewMeta}>
                التردد الأساسي المكتشف: {pendingSample.features.dominantFreq.toFixed(0)} Hz
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

          {samplesCollected > 0 && (
            <TouchableOpacity style={styles.secondaryButton} onPress={handleReset}>
              <Text style={styles.secondaryButtonText}>إعادة تعيين عينات المنبه</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      {knockDetectionEnabled && (
        <>
          <View style={styles.divider} />

          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>🎯 معايرة طرق الباب (اختياري، لدقة أعلى)</Text>
            <Switch value={knockCalibrationEnabled} onValueChange={setKnockCalibrationEnabled} />
          </View>

          {knockCalibrationEnabled && (
            <>
              <Text style={styles.hint}>
                سجّل {KNOCK_SAMPLES_NEEDED} طرقات حقيقية على بابك (طرقة واحدة في كل تسجيل) لبناء بصمة
                خاصة بصوت طرق هذا الباب بالذات، بدلًا من الاعتماد على نطاقات عامة لأي طرقة.
              </Text>

              <Text style={styles.progress}>
                الطرقات المعتمدة: {knockShapesCollected.length} / {KNOCK_SAMPLES_NEEDED}
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

                  {pendingKnockSample.pulseCount === 0 ? (
                    <Text style={[styles.reviewQuality, styles.reviewQualityWeak]}>
                      ⚠️ لم يُكتشف طرق واضح — اطرق بقوة أكبر وأعد المحاولة
                    </Text>
                  ) : (
                    <Text style={[styles.reviewQuality, styles.reviewQualityGood]}>
                      ✅ تم اكتشاف الطرقة بوضوح ({pendingKnockSample.pulseCount} نبضة)
                    </Text>
                  )}

                  <TouchableOpacity style={styles.playButton} onPress={handlePlayPendingKnock}>
                    <Text style={styles.buttonText}>
                      {isPlaying ? '⏸️ جاري التشغيل...' : '▶️ استماع للعينة'}
                    </Text>
                  </TouchableOpacity>

                  <View style={styles.reviewActionsRow}>
                    <TouchableOpacity style={styles.rejectButton} onPress={handleRejectPendingKnock}>
                      <Text style={styles.buttonText}>🔁 إعادة التسجيل</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.acceptButton,
                        pendingKnockSample.pulseCount === 0 && styles.buttonDisabled,
                      ]}
                      onPress={handleAcceptPendingKnock}
                      disabled={pendingKnockSample.pulseCount === 0}
                    >
                      <Text style={styles.buttonText}>✅ اعتماد الطرقة</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {knockShapesCollected.length > 0 && (
                <TouchableOpacity style={styles.secondaryButton} onPress={handleResetKnock}>
                  <Text style={styles.secondaryButtonText}>إعادة تعيين طرقات المعايرة</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </>
      )}

      <Text style={styles.status}>{status}</Text>

      <TouchableOpacity style={[styles.button, styles.finishButton]} onPress={handleFinishCalibration}>
        <Text style={styles.buttonText}>✅ حفظ وإنهاء الإعداد</Text>
      </TouchableOpacity>
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
  reviewMeta: {
    color: '#94a3b8',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 12,
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
});
