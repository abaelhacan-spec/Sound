import React, { useState } from 'react';
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
} from '../utils/audioFingerprint';
import {
  saveReferenceFingerprint,
  savePhoneNumber,
  loadPhoneNumber,
  saveDetectionPaths,
} from '../utils/storage';

const SAMPLES_NEEDED = 3; // عدد العينات المطلوبة للمعايرة الدقيقة
const CALIBRATION_CHUNK_MS = 2500; // يغطي دورة كاملة (صوت+صمت) مع هامش أمان

export default function CalibrationScreen({ onCalibrationComplete }) {
  const [isRecording, setIsRecording] = useState(false);
  const [samplesCollected, setSamplesCollected] = useState(0);
  const [collectedFingerprints, setCollectedFingerprints] = useState([]);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [alarmDetectionEnabled, setAlarmDetectionEnabled] = useState(true);
  const [knockDetectionEnabled, setKnockDetectionEnabled] = useState(true);
  const [status, setStatus] = useState(
    'أدخل رقم الهاتف، ثم اضغط "تسجيل عينة" أثناء تشغيل صوت المنبه بجانب الهاتف'
  );

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
      await deleteTempFile(uri);

      const updated = [...collectedFingerprints, fingerprint];
      setCollectedFingerprints(updated);
      setSamplesCollected(updated.length);
      setStatus(
        updated.length < SAMPLES_NEEDED
          ? `تم تسجيل ${updated.length} من ${SAMPLES_NEEDED} عينات. سجّل عينة أخرى.`
          : 'تم جمع كل العينات! اضغط "حفظ وإنهاء الإعداد".'
      );
    } catch (err) {
      Alert.alert('خطأ', 'حدث خطأ أثناء التسجيل: ' + err.message);
    } finally {
      setIsRecording(false);
    }
  }

  async function handleFinishCalibration() {
    if (!phoneNumber || phoneNumber.trim().length < 5) {
      Alert.alert('تنبيه', 'من فضلك أدخل رقم هاتف صحيح أولًا');
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

  function handleReset() {
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
            style={[styles.button, isRecording && styles.buttonDisabled]}
            onPress={handleRecordSample}
            disabled={isRecording}
          >
            {isRecording ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>🎙️ تسجيل عينة</Text>
            )}
          </TouchableOpacity>

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
