import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  // ── مسار المنبه ──
  // بدل بصمة واحدة (متوسط)، نحفظ الآن العينات المرجعية الثلاث كاملة
  // (كل عينة: بصمة طيفية + تردد أساسي + envelope + نمط إيقاع + توزيع نطاقات)
  // لاستخدام "أعلى تشابه" (Max Similarity) بدل المتوسط أثناء المقارنة.
  ALARM_REFERENCE_SAMPLES: 'ALARM_REFERENCE_SAMPLES_V2',
  PHONE_NUMBER: 'TARGET_PHONE_NUMBER',
  THRESHOLD: 'MATCH_THRESHOLD',
  ALARM_ENABLED: 'ALARM_DETECTION_ENABLED',
  KNOCK_ENABLED: 'KNOCK_DETECTION_ENABLED',

  // ── مسار طرق الباب ──
  KNOCK_CALIBRATION_ENABLED: 'KNOCK_CALIBRATION_ENABLED',
  KNOCK_REFERENCE_PROFILE: 'KNOCK_REFERENCE_PROFILE',
};

// ═══ مسار المنبه ═══════════════════════════════════════════════════════

/**
 * يحفظ العينات المرجعية الثلاث كاملة (وليس بصمة واحدة متوسطة). كل عينة
 * كائن يحتوي: { fingerprint, dominantFreq, envelope, rhythm, bandEnergy }.
 * يُستخدم هذا أثناء المراقبة للمقارنة بكل عينة على حدة، واعتماد أعلى
 * درجة تطابق (Max Similarity) بدلًا من متوسط العينات.
 */
export async function saveAlarmReferenceSamples(samples) {
  await AsyncStorage.setItem(KEYS.ALARM_REFERENCE_SAMPLES, JSON.stringify(samples));
}

export async function loadAlarmReferenceSamples() {
  const data = await AsyncStorage.getItem(KEYS.ALARM_REFERENCE_SAMPLES);
  return data ? JSON.parse(data) : null; // null يعني: لا توجد معايرة محفوظة بعد
}

export async function clearAlarmReferenceSamples() {
  await AsyncStorage.removeItem(KEYS.ALARM_REFERENCE_SAMPLES);
}

export async function savePhoneNumber(number) {
  await AsyncStorage.setItem(KEYS.PHONE_NUMBER, number);
}

export async function loadPhoneNumber() {
  return (await AsyncStorage.getItem(KEYS.PHONE_NUMBER)) || '';
}

export async function saveThreshold(value) {
  await AsyncStorage.setItem(KEYS.THRESHOLD, String(value));
}

export async function loadThreshold() {
  const data = await AsyncStorage.getItem(KEYS.THRESHOLD);
  return data ? parseFloat(data) : 0.85; // قيمة افتراضية (تُستخدم كعتبة مساعدة، وليست المعيار الوحيد بعد الآن)
}

export async function saveDetectionPaths({ alarmEnabled, knockEnabled }) {
  await AsyncStorage.setItem(KEYS.ALARM_ENABLED, alarmEnabled ? '1' : '0');
  await AsyncStorage.setItem(KEYS.KNOCK_ENABLED, knockEnabled ? '1' : '0');
}

export async function loadDetectionPaths() {
  const alarm = await AsyncStorage.getItem(KEYS.ALARM_ENABLED);
  const knock = await AsyncStorage.getItem(KEYS.KNOCK_ENABLED);
  return {
    // القيم الافتراضية: المسارين مفعّلين (نفس السلوك السابق) لو لسه محدّش اختار
    alarmEnabled: alarm === null ? true : alarm === '1',
    knockEnabled: knock === null ? true : knock === '1',
  };
}

// ═══ مسار طرق الباب ════════════════════════════════════════════════════

/**
 * يحفظ حالة تفعيل المعايرة الاختيارية لطرق الباب، مع الملف المرجعي
 * الشخصي (متوسط خصائص 5 طرقات حقيقية) لو فُعِّلت. لو غير مفعّلة، يُستخدم
 * أثناء المراقبة GENERIC_KNOCK_REFERENCE الثابت بدلًا من هذا الملف.
 */
export async function saveKnockCalibration({ enabled, profile }) {
  await AsyncStorage.setItem(KEYS.KNOCK_CALIBRATION_ENABLED, enabled ? '1' : '0');
  if (profile) {
    await AsyncStorage.setItem(KEYS.KNOCK_REFERENCE_PROFILE, JSON.stringify(profile));
  } else {
    await AsyncStorage.removeItem(KEYS.KNOCK_REFERENCE_PROFILE);
  }
}

export async function loadKnockCalibration() {
  const enabledRaw = await AsyncStorage.getItem(KEYS.KNOCK_CALIBRATION_ENABLED);
  const profileRaw = await AsyncStorage.getItem(KEYS.KNOCK_REFERENCE_PROFILE);
  return {
    enabled: enabledRaw === '1',
    profile: profileRaw ? JSON.parse(profileRaw) : null,
  };
}

export async function clearKnockCalibration() {
  await AsyncStorage.removeItem(KEYS.KNOCK_CALIBRATION_ENABLED);
  await AsyncStorage.removeItem(KEYS.KNOCK_REFERENCE_PROFILE);
}
