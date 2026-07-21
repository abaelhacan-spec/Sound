import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  // كل عنصر في المصفوفتين التاليتين هو Embedding واحد (متجه 1024 رقم)
  // ناتج من نموذج YAMNet لعينة معايرة واحدة مقبولة.
  ALARM_REFERENCE_EMBEDDINGS: 'ALARM_REFERENCE_EMBEDDINGS_V3',
  KNOCK_REFERENCE_EMBEDDINGS: 'KNOCK_REFERENCE_EMBEDDINGS_V3',
  PHONE_NUMBER: 'TARGET_PHONE_NUMBER',
  SIMILARITY_THRESHOLD: 'SIMILARITY_THRESHOLD_V3',
  ALARM_ENABLED: 'ALARM_DETECTION_ENABLED',
  KNOCK_ENABLED: 'KNOCK_DETECTION_ENABLED',
};

// ═══ العينات المرجعية (منبه + طرق) ═══════════════════════════════════════
// نفس منطق التخزين للاثنين تمامًا الآن، لأن كليهما أصبح "قائمة Embeddings"
// يُقارَن معها بأقرب جار (Max Cosine Similarity) بدل أي ميزات يدوية أخرى.

export async function saveAlarmReferenceEmbeddings(embeddings) {
  await AsyncStorage.setItem(KEYS.ALARM_REFERENCE_EMBEDDINGS, JSON.stringify(embeddings));
}

export async function loadAlarmReferenceEmbeddings() {
  const data = await AsyncStorage.getItem(KEYS.ALARM_REFERENCE_EMBEDDINGS);
  return data ? JSON.parse(data) : null;
}

export async function clearAlarmReferenceEmbeddings() {
  await AsyncStorage.removeItem(KEYS.ALARM_REFERENCE_EMBEDDINGS);
}

export async function saveKnockReferenceEmbeddings(embeddings) {
  await AsyncStorage.setItem(KEYS.KNOCK_REFERENCE_EMBEDDINGS, JSON.stringify(embeddings));
}

export async function loadKnockReferenceEmbeddings() {
  const data = await AsyncStorage.getItem(KEYS.KNOCK_REFERENCE_EMBEDDINGS);
  return data ? JSON.parse(data) : null;
}

export async function clearKnockReferenceEmbeddings() {
  await AsyncStorage.removeItem(KEYS.KNOCK_REFERENCE_EMBEDDINGS);
}

// ═══ إعدادات عامة ══════════════════════════════════════════════════════

export async function savePhoneNumber(number) {
  await AsyncStorage.setItem(KEYS.PHONE_NUMBER, number);
}

export async function loadPhoneNumber() {
  return (await AsyncStorage.getItem(KEYS.PHONE_NUMBER)) || '';
}

/**
 * عتبة التشابه (Cosine Similarity) المطلوبة لاعتبار الصوت الحي مطابقًا
 * لإحدى العينات المرجعية. قيمة بين 0 و 1. الافتراضي 0.75 نقطة انطلاق
 * معقولة تجريبيًا لـ embeddings من YAMNet، لكنها تحتاج ضبطًا ميدانيًا.
 */
export async function saveSimilarityThreshold(value) {
  await AsyncStorage.setItem(KEYS.SIMILARITY_THRESHOLD, String(value));
}

export async function loadSimilarityThreshold() {
  const data = await AsyncStorage.getItem(KEYS.SIMILARITY_THRESHOLD);
  return data ? parseFloat(data) : 0.75;
}

export async function saveDetectionPaths({ alarmEnabled, knockEnabled }) {
  await AsyncStorage.setItem(KEYS.ALARM_ENABLED, alarmEnabled ? '1' : '0');
  await AsyncStorage.setItem(KEYS.KNOCK_ENABLED, knockEnabled ? '1' : '0');
}

export async function loadDetectionPaths() {
  const alarm = await AsyncStorage.getItem(KEYS.ALARM_ENABLED);
  const knock = await AsyncStorage.getItem(KEYS.KNOCK_ENABLED);
  return {
    alarmEnabled: alarm === null ? true : alarm === '1',
    knockEnabled: knock === null ? true : knock === '1',
  };
}
