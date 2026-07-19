import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  FINGERPRINT: 'REFERENCE_FINGERPRINT',
  PHONE_NUMBER: 'TARGET_PHONE_NUMBER',
  THRESHOLD: 'MATCH_THRESHOLD',
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
