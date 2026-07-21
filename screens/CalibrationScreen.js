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
  averageFingerprints,
  computeRMS,
} from '../utils/audioFingerprint';
import {
  saveReferenceFingerprint,
  savePhoneNumber,
  loadPhoneNumber,
  saveDetectionPaths,
} from '../utils/storage';

const SAMPLES_NEEDED = 3; // عدد العينات المطلوبة للمعايرة الدقيقة
const CALIBRATION_CHUNK_MS = 2500; // يغطي دورة كاملة (صوت+صمت) مع هامش أمان
const MIN_GOOD_ENERGY_RMS = 0.015; // نفس حد الطاقة الدنيا المستخدم أثناء المراقبة، لتنبيه المستخدم مبكرًا لو العينة خافتة جدًا

export default function CalibrationScreen({ onCalibrationComplete }) {
  const [isRecording, setIsRecording] = useState(false);
  const [samplesCollected, setSamplesCollected] = useState(0);
  const [collectedFingerprints, setCollectedFingerprints] = useState([]);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [alarmDetectionEnabled, setAlarmDetectionEnabled] = useState(true);
  const [knockDetectionEnabled, setKnockDetectionEnabled] = useState(true);
  const [pendingSample, setPendingSample] = useState(null); // { uri, fingerprint, energy } بانتظار مراجعة المستخدم
  const [isPlaying, setIsPlaying] = useState(false);
  const soundRef = useRef(null);
  const [status, setStatus] = useState(
    'أدخل رقم الهاتف، ثم اضغط "تسجيل عينة" أثناء تشغيل صوت المنبه بجانب الهاتف'
  );

  // تنظيف الصوت والملف المؤقت لو المستخدم غادر الشاشة وفيه عينة لسه معلّقة
  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
      }
      if (pendingSample?.uri) {
        deleteTempFile(pendingSample.uri);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const fingerprint = extractSpectralFingerprint(samples);
      const energy = computeRMS(samples);

      // لا نحذف الملف ولا نضيف العينة مباشرة — ننتظر مراجعة المستخدم أولًا
      setPendingSample({ uri, fingerprint, energy });
      setStatus('🎧 استمع للعينة تأكد من جودتها، ثم اعتمدها أو أعد التسجيل');
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
        if (s.didJustFinish) {
          setIsPlaying(false);
        }
      });
      await sound.playAsync();
    } catch (err) {
      setIsPlaying(false);
      Alert.alert('خطأ', 'تعذر تشغيل العينة: ' + err.message);
    }
  }

  async function cleanupPendingSound() {
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    setIsPlaying(false);
  }

  async function handleAcceptPending() {
    if (!pendingSample) return;
    const updated = [...collectedFingerprints, pendingSample.fingerprint];
    setCollectedFingerprints(updated);
    setSamplesCollected(updated.length);

    await cleanupPendingSound();
    await deleteTempFile(pendingSample.uri);
    setPendingSample(null);

    setStatus(
      updated.length < SAMPLES_NEEDED
        ? `تم اعتماد ${updated.length} من ${SAMPLES_NEEDED} عينات. سجّل عينة أخرى.`
        : 'تم جمع كل العينات! اضغط "حفظ وإنهاء الإعداد".'
    );
  }

  async function handleRejectPending() {
    if (!pendingSample) return;
    await cleanupPendingSound();
    await deleteTempFile(pendingSample.uri);
    setPendingSample(null);
    setStatus('تم تجاهل العينة. اضغط "تسجيل عينة" لإعادة المحاولة.');
  }

  async function handleFinishCalibration() {
    if (!phoneNumber || phoneNumber.trim().length < 5) {
      Alert.alert('تنبيه', 'من فضلك أدخل رقم هاتف صحيح أولًا');
      return;
    }

    if (pendingSample) {
      Alert.alert('عينة بانتظار المراجعة', 'اعتمد العينة المسجّلة أو ألغِها أولًا قبل إنهاء الإعداد');
      return;
    }

    if (!alarmDetectionEnabled && !knockDetectionEnabled) {
      Alert.alert('لا يوجد مسار مفعّل', 'فعّل مسار كشف المنبه أو مسار كشف الطرق على الأقل');
      return;
    }

    // المعايرة مطلوبة فقط لو مسار المنبه مفعّل
    if (alarmDetectionEnabled) {
      if (collectedFingerprints.length === 0) {
        Alert.alert('تنبيه', 'لازم تسجل عينة واحدة على الأقل، أو عطّل مسار كشف المنبه أعلاه');
        return;
      }
      const avgFingerprint = averageFingerprints(collectedFingerprints);
      await saveReferenceFingerprint(avgFingerprint);
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

  async function handleReset() {
    if (pendingSample) {
      await cleanupPendingSound();
      await deleteTempFile(pendingSample.uri);
      setPendingSample(null);
    }
    setCollectedFingerprints([]);
    setSamplesCollected(0);
    setStatus('تم المسح. سجّل العينات من جديد.');
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>⚙️ إعداد المراقبة</Text>

      <Text style={styles.label}>رقم الهاتف للاتصال عند التنبيه:</Text>
      <TextInput
        style={styles.input}
        value={phoneNumber}
        onChangeText={setPhoneNumber}
        placeholder="01xxxxxxxxx"
        keyboardType="phone-pad"
        placeholderTextColor="#888"
      />

      <View style={styles.divider} />

      <Text style={styles.label}>مسارات الكشف المطلوبة:</Text>
      <View style={styles.togglesBox}>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>🔔 كشف صوت المنبه (يحتاج معايرة)</Text>
          <Switch value={alarmDetectionEnabled} onValueChange={setAlarmDetectionEnabled} />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>🚪 كشف طرق الباب (بدون معايرة)</Text>
          <Switch value={knockDetectionEnabled} onValueChange={setKnockDetectionEnabled} />
        </View>
      </View>

      {alarmDetectionEnabled && (
        <>
          <View style={styles.divider} />

          <Text style={styles.label}>معايرة صوت المنبه:</Text>
          <Text style={styles.hint}>
            سجّل {SAMPLES_NEEDED} عينات من صوت المنبه الحقيقي (كل عينة {(CALIBRATION_CHUNK_MS / 1000).toFixed(1)} ثانية لتغطية دورة كاملة من الصوت والصمت) لضمان
            دقة أعلى في التعرف عليه.
          </Text>

          <Text style={styles.progress}>
            العينات المسجّلة: {samplesCollected} / {SAMPLES_NEEDED}
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
                  pendingSample.energy < MIN_GOOD_ENERGY_RMS
                    ? styles.reviewQualityWeak
                    : styles.reviewQualityGood,
                ]}
              >
                {pendingSample.energy < MIN_GOOD_ENERGY_RMS
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

          {samplesCollected > 0 && (
            <TouchableOpacity style={styles.secondaryButton} onPress={handleReset}>
              <Text style={styles.secondaryButtonText}>إعادة تعيين العينات</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      <Text style={styles.status}>{status}</Text>

      <TouchableOpacity
        style={[
          styles.button,
          styles.finishButton,
          alarmDetectionEnabled && collectedFingerprints.length === 0 && styles.buttonDisabled,
        ]}
        onPress={handleFinishCalibration}
        disabled={alarmDetectionEnabled && collectedFingerprints.length === 0}
      >
        <Text style={styles.buttonText}>✅ حفظ وإنهاء الإعداد</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#1a1a1a',
    padding: 24,
    paddingTop: 60,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 24,
    textAlign: 'center',
  },
  label: {
    fontSize: 16,
    color: '#fff',
    marginBottom: 8,
    fontWeight: '600',
  },
  hint: {
    fontSize: 13,
    color: '#aaa',
    marginBottom: 12,
    lineHeight: 20,
  },
  input: {
    backgroundColor: '#2a2a2a',
    color: '#fff',
    padding: 14,
    borderRadius: 10,
    fontSize: 16,
    marginBottom: 16,
    textAlign: 'right',
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
    marginBottom: 12,
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
  finishButton: {
    backgroundColor: '#16a34a',
    marginTop: 20,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  secondaryButton: {
    padding: 10,
    alignItems: 'center',
    marginBottom: 8,
  },
  secondaryButtonText: {
    color: '#ef4444',
    fontSize: 14,
  },
  status: {
    color: '#ccc',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 16,
    lineHeight: 20,
  },
});
