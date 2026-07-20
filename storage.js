import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  FINGERPRINT: 'REFERENCE_FINGERPRINT',
  PHONE_NUMBER: 'TARGET_PHONE_NUMBER',
  THRESHOLD: 'MATCH_THRESHOLD',
  ALARM_ENABLED: 'ALARM_DETECTION_ENABLED',
  KNOCK_ENABLED: 'KNOCK_DETECTION_ENABLED',
};

export async function saveReferenceFingerprint(fingerprint) {
  await AsyncStorage.setItem(KEYS.FINGERPRINT, JSON.stringify(fingerprint));
}

export async function loadReferenceFingerprint() {
  const data = await AsyncStorage.getItem(KEYS.FINGERPRINT);
  return data ? JSON.parse(data) : null;
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
  return data ? parseFloat(data) : 0.85; // قيمة افتراضية
}

export async function clearReferenceFingerprint() {
  await AsyncStorage.removeItem(KEYS.FINGERPRINT);
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
