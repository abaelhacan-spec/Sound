import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  // كل عنصر في المصفوفتين التاليتين هو Embedding واحد (متجه 1024 رقم)
  // ناتج من نموذج YAMNet لعينة معايرة واحدة مقبولة.
  ALARM_REFERENCE_EMBEDDINGS: 'ALARM_REFERENCE_EMBEDDINGS_V3',
  KNOCK_REFERENCE_EMBEDDINGS: 'KNOCK_REFERENCE_EMBEDDINGS_V3',
  PHONE_NUMBER: 'TARGET_PHONE_NUMBER',
  // محفوظة للتوافق الخلفي فقط (نسخ قديمة من التطبيق كانت تستخدم عتبة
  // واحدة مشتركة لكل من ALARM وKNOCK). لا تُستخدم في الكود الجديد إلا
  // كقيمة احتياطية إذا لم تكن العتبات المنفصلة محفوظة بعد.
  SIMILARITY_THRESHOLD: 'SIMILARITY_THRESHOLD_V3',
  ALARM_ENABLED: 'ALARM_DETECTION_ENABLED',
  KNOCK_ENABLED: 'KNOCK_DETECTION_ENABLED',

  // ── إعدادات منفصلة لكل مسار (تحل تدريجيًا محل SIMILARITY_THRESHOLD) ──
  ALARM_SIMILARITY_THRESHOLD: 'ALARM_SIMILARITY_THRESHOLD_V1',
  KNOCK_SIMILARITY_THRESHOLD: 'KNOCK_SIMILARITY_THRESHOLD_V1',
  ENERGY_GATE_RMS: 'ENERGY_GATE_RMS_V1',

  // ── معاملات طبقة كشف النبضات لـ KNOCK (audioFingerprint.detectPulses) ──
  KNOCK_PULSE_CONFIG: 'KNOCK_PULSE_CONFIG_V1',

  // ── الإعداد النهائي الناتج عن AI Calibration Lab (بدون أي مفتاح API) ──
  OFFLINE_AUDIO_CONFIG: 'OFFLINE_AUDIO_CONFIG_V1',
};

/** القيم الافتراضية لمعاملات كشف النبضات — انظر شرحها الكامل في detectPulses() */
export const DEFAULT_KNOCK_PULSE_CONFIG = {
  minPulses: 1,
  maxPulses: 6,
  minAttackSharpness: 3.0,
  energyRatioThreshold: 3.0,
  minAbsRms: 0.008,
  minPulseGapMs: 60,
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

// ═══ عتبات منفصلة لكل مسار + بوابة الطاقة ════════════════════════════════
// كانت النسخة السابقة تستخدم SIMILARITY_THRESHOLD واحدة مشتركة بين ALARM
// وKNOCK. الآن كل مسار له عتبته الخاصة القابلة للمعايرة عبر AI Calibration
// Lab بشكل مستقل، لأن حساسية كل صوت مختلفة عمليًا.

export async function saveAlarmSimilarityThreshold(value) {
  await AsyncStorage.setItem(KEYS.ALARM_SIMILARITY_THRESHOLD, String(value));
}

export async function loadAlarmSimilarityThreshold() {
  const data = await AsyncStorage.getItem(KEYS.ALARM_SIMILARITY_THRESHOLD);
  if (data !== null) return parseFloat(data);
  // احتياطي: النسخ القديمة كانت تحفظ عتبة مشتركة واحدة فقط
  return loadSimilarityThreshold();
}

export async function saveKnockSimilarityThreshold(value) {
  await AsyncStorage.setItem(KEYS.KNOCK_SIMILARITY_THRESHOLD, String(value));
}

export async function loadKnockSimilarityThreshold() {
  const data = await AsyncStorage.getItem(KEYS.KNOCK_SIMILARITY_THRESHOLD);
  if (data !== null) return parseFloat(data);
  return loadSimilarityThreshold();
}

/**
 * بوابة الطاقة (RMS) المستخدمة قبل تشغيل YAMNet — كانت قيمة ثابتة مبرمجة
 * (MIN_ENERGY_RMS = 0.015) في MonitoringScreen وCalibrationScreen. الآن
 * قابلة للمعايرة والحفظ، مع الإبقاء على 0.015 كقيمة افتراضية مطابقة
 * للسلوك السابق تمامًا إذا لم تُعايَر بعد.
 */
export async function saveEnergyGateRms(value) {
  await AsyncStorage.setItem(KEYS.ENERGY_GATE_RMS, String(value));
}

export async function loadEnergyGateRms() {
  const data = await AsyncStorage.getItem(KEYS.ENERGY_GATE_RMS);
  return data !== null ? parseFloat(data) : 0.015;
}

// ═══ معاملات كشف نبضات KNOCK ══════════════════════════════════════════════

export async function saveKnockPulseConfig(config) {
  await AsyncStorage.setItem(KEYS.KNOCK_PULSE_CONFIG, JSON.stringify(config));
}

export async function loadKnockPulseConfig() {
  const data = await AsyncStorage.getItem(KEYS.KNOCK_PULSE_CONFIG);
  if (!data) return { ...DEFAULT_KNOCK_PULSE_CONFIG };
  try {
    return { ...DEFAULT_KNOCK_PULSE_CONFIG, ...JSON.parse(data) };
  } catch (_) {
    return { ...DEFAULT_KNOCK_PULSE_CONFIG };
  }
}

// ═══ الإعداد النهائي offline (نتيجة AI Calibration Lab) ═══════════════════
// لا يحتوي إطلاقًا على Gemini API Key — فقط الأرقام النهائية المعتمدة.

export async function saveOfflineAudioConfig(config) {
  await AsyncStorage.setItem(KEYS.OFFLINE_AUDIO_CONFIG, JSON.stringify(config));
}

export async function loadOfflineAudioConfig() {
  const data = await AsyncStorage.getItem(KEYS.OFFLINE_AUDIO_CONFIG);
  return data ? JSON.parse(data) : null;
}

/**
 * يطبّق offlineAudioConfig كاملاً على كل مفاتيح storage.js المعنية دفعة
 * واحدة — تُستخدم عند "Apply Temporarily" وعند اعتماد الإعداد النهائي في
 * AI Calibration Lab.
 */
export async function applyOfflineAudioConfig(config) {
  if (config.alarm?.similarityThreshold !== undefined) {
    await saveAlarmSimilarityThreshold(config.alarm.similarityThreshold);
  }
  if (config.knock?.similarityThreshold !== undefined) {
    await saveKnockSimilarityThreshold(config.knock.similarityThreshold);
  }
  if (config.energyGate !== undefined) {
    await saveEnergyGateRms(config.energyGate);
  }
  if (config.knock) {
    const { minPulses, maxPulses, minAttackSharpness, energyRatioThreshold, minAbsRms, minPulseGapMs } = config.knock;
    await saveKnockPulseConfig({
      ...(minPulses !== undefined && { minPulses }),
      ...(maxPulses !== undefined && { maxPulses }),
      ...(minAttackSharpness !== undefined && { minAttackSharpness }),
      ...(energyRatioThreshold !== undefined && { energyRatioThreshold }),
      ...(minAbsRms !== undefined && { minAbsRms }),
      ...(minPulseGapMs !== undefined && { minPulseGapMs }),
    });
  }
}
