import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import ImmediatePhoneCall from 'react-native-immediate-phone-call';
import {
  recordChunk,
  deleteTempFile,
  requestAudioPermission,
  configureAudioMode,
} from '../utils/audioRecorder';
import { readWavAsSamples, extractSpectralFingerprint, cosineSimilarity } from '../utils/audioFingerprint';
import { loadReferenceFingerprint, loadPhoneNumber, loadThreshold } from '../utils/storage';

const CONSECUTIVE_MATCHES_NEEDED = 3; // عدد المقاطع المتتالية المطلوب تطابقها
const COOLDOWN_MS = 30000; // مهلة قبل السماح باتصال جديد بعد الاتصال السابق
const CHUNK_DURATION_MS = 1200;

export default function MonitoringScreen({ onBackToSettings }) {
  useKeepAwake();

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [status, setStatus] = useState('اضغط "ابدأ المراقبة" للبدء');
  const [lastSimilarity, setLastSimilarity] = useState(0);
  const [callCount, setCallCount] = useState(0);

  const isMonitoringRef = useRef(false);
  const matchCountRef = useRef(0);
  const lastCallTimeRef = useRef(0);
  const referenceFingerprintRef = useRef(null);
  const phoneNumberRef = useRef('');
  const thresholdRef = useRef(0.85);

  useEffect(() => {
    return () => {
      isMonitoringRef.current = false;
    };
  }, []);

  async function startMonitoring() {
    const fingerprint = await loadReferenceFingerprint();
    const phone = await loadPhoneNumber();
    const threshold = await loadThreshold();

    if (!fingerprint) {
      Alert.alert('إعداد ناقص', 'لازم تعمل معايرة لصوت المنبه أولًا');
      return;
    }
    if (!phone) {
      Alert.alert('إعداد ناقص', 'لازم تدخل رقم الهاتف أولًا');
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
        const fingerprint = extractSpectralFingerprint(samples);
        await deleteTempFile(uri);

        const similarity = cosineSimilarity(
          fingerprint,
          referenceFingerprintRef.current
        );
        setLastSimilarity(similarity);

        if (similarity >= thresholdRef.current) {
          matchCountRef.current += 1;
          setStatus(
            `🟡 تطابق محتمل (${matchCountRef.current}/${CONSECUTIVE_MATCHES_NEEDED}) - تشابه ${(similarity * 100).toFixed(0)}%`
          );

          if (matchCountRef.current >= CONSECUTIVE_MATCHES_NEEDED) {
            const now = Date.now();
            if (now - lastCallTimeRef.current > COOLDOWN_MS) {
              triggerCall();
              lastCallTimeRef.current = now;
              setCallCount((c) => c + 1);
            }
            matchCountRef.current = 0;
          }
        } else {
          matchCountRef.current = 0;
          if (isMonitoringRef.current) {
            setStatus(
              `🟢 المراقبة شغالة... (تشابه آخر عينة: ${(similarity * 100).toFixed(0)}%)`
            );
          }
        }
      } catch (err) {
        setStatus('⚠️ خطأ أثناء التحليل: ' + err.message);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  function triggerCall() {
    setStatus('🔴 تم اكتشاف صوت التنبيه — جاري الاتصال...');
    try {
      ImmediatePhoneCall.immediatePhoneCall(phoneNumberRef.current);
    } catch (err) {
      Alert.alert('خطأ في الاتصال', err.message);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>📡 مراقبة الصوت</Text>

      <View style={styles.statusBox}>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>آخر تشابه</Text>
          <Text style={styles.statValue}>{(lastSimilarity * 100).toFixed(0)}%</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>عدد الاتصالات</Text>
          <Text style={styles.statValue}>{callCount}</Text>
        </View>
      </View>

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
    marginBottom: 24,
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
    marginBottom: 24,
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
