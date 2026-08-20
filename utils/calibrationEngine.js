import { cosineSimilarity, detectPulsesFromEnvelope } from './audioFingerprint';

/**
 * ═══ Local Calibration Engine ═══════════════════════════════════════════
 * (بند 6 و10 من مواصفة AI Calibration Lab)
 *
 * لا يحتاج Gemini إطلاقًا — يعمل بالكامل محليًا وبلا اتصال إنترنت. يُستخدم
 * *قبل* استشارة Gemini (لتوليد ملخص إحصائي حقيقي نرسله له لاحقًا)، وأيضًا
 * *بعد* أي توصية من Gemini (لإعادة اختبارها فعليًا قبل اعتمادها — بند 9).
 *
 * شكل عنصر بيانات واحد في Dataset:
 * {
 *   id: string,
 *   label: 'alarm' | 'knock' | 'other',
 *   embedding: number[],   // من extractEmbedding() — YAMNet
 *   rms: number,           // من computeRMS()
 *   envelope: number[],    // من computeEnvelope() — فقط مطلوب لعينات قد تُقارَن كـ knock
 * }
 */

export function maxSimilarity(embedding, referenceEmbeddings) {
  let best = 0;
  for (const ref of referenceEmbeddings) {
    const sim = cosineSimilarity(embedding, ref);
    if (sim > best) best = sim;
  }
  return best;
}

/** يخلط المصفوفة عشوائيًا (Fisher-Yates) بدون تعديل الأصل */
function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * يقسّم Dataset إلى Calibration Set وValidation Set (بند 10). التقسيم
 * عشوائي لكن بنسبة ثابتة داخل كل فئة (label) على حدة، لضمان أن كل فئة
 * ممثَّلة بنفس النسبة تقريبًا في المجموعتين (Stratified Split) — بدل
 * تقسيم عشوائي كامل قد يترك فئة كاملة بلا عينات validation كافية.
 */
export function splitDataset(dataset, calibrationRatio = 0.7) {
  const byLabel = { alarm: [], knock: [], other: [] };
  const safeDataset = Array.isArray(dataset) ? dataset : [];
  for (const sample of safeDataset) {
    if (sample && byLabel[sample.label]) byLabel[sample.label].push(sample);
  }

  const calibrationSet = [];
  const validationSet = [];

  for (const label of Object.keys(byLabel)) {
    const shuffled = shuffle(byLabel[label]);
    if (shuffled.length === 0) continue; // فئة بلا عينات إطلاقًا — لا شيء لتقسيمه
    const splitAt = Math.max(1, Math.floor(shuffled.length * calibrationRatio));
    calibrationSet.push(...shuffled.slice(0, splitAt));
    validationSet.push(...shuffled.slice(splitAt));
  }

  return { calibrationSet: shuffle(calibrationSet), validationSet: shuffle(validationSet) };
}

/**
 * يحسب Precision/Recall/F1 لفئة واحدة من إحصائيات TP/FP/FN.
 * حالات حدّية:
 *  - لا توجد تنبؤات لهذه الفئة إطلاقًا ولا عينات حقيقية منها → Precision=1 (لا خطأ ارتُكب)
 *  - توجد عينات حقيقية لكن لم يُتنبَّأ بأي منها → Recall=0 (الحالة الخطيرة التي تسبب F1=0)
 */
function classMetrics(stats) {
  const { tp, fp, fn } = stats;
  const precision = tp + fp > 0 ? tp / (tp + fp) : tp === 0 && fn === 0 ? 1 : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1; // لا عينات حقيقية من هذه الفئة أصلاً => لا عقاب
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { ...stats, precision, recall, f1 };
}

/**
 * يقيّم configuration واحدة على مجموعة بيانات، بنفس منطق القرار المستخدم
 * فعليًا في MonitoringScreen.js (بوابة طاقة → تشابه → [لـ knock: فحص
 * نبضات AND تشابه] → أولوية الأعلى تشابهًا عند تعارض alarm/knock).
 *
 * ═══ v2 — إصلاح خلل الترجيح الذي كان يسمح بحلول تافهة ═══════════════════
 * النسخة السابقة كانت تحسب weightedErrorScore = FP×5 + FN×1 كمجموع خام غير
 * محدود، ما يجعل "رفض كل شيء تقريبًا" (Recall≈0, F1=0) حلاً "رخيصًا" رياضيًا
 * لمجرد أن وزن FN كان أقل من وزن FP. الآن evaluateConfig() لا يحسب أي وزن
 * إطلاقًا — فقط confusion matrix حقيقية وPrecision/Recall/F1 لكل فئة على
 * حدة، والقرار بشأن "ما هو مقبول" انتقل بالكامل إلى rankConfigs() أدناه
 * عبر فلتر Recall صريح، بدل دفنه داخل معادلة ترجيح قابلة للخداع.
 */
export function evaluateConfig(dataset, alarmRefs, knockRefs, config) {
  if (!config || !config.alarm || !config.knock || typeof config.energyGate !== 'number') {
    throw new Error('evaluateConfig: config غير مكتمل (يجب أن يحتوي energyGate وalarm.similarityThreshold وknock.similarityThreshold)');
  }

  const classes = ['alarm', 'knock', 'other'];
  const confusion = {
    alarm: { alarm: 0, knock: 0, other: 0 },
    knock: { alarm: 0, knock: 0, other: 0 },
    other: { alarm: 0, knock: 0, other: 0 },
  };

  const safeDataset = Array.isArray(dataset) ? dataset : [];
  const safeAlarmRefs = Array.isArray(alarmRefs) ? alarmRefs : [];
  const safeKnockRefs = Array.isArray(knockRefs) ? knockRefs : [];

  for (const sample of safeDataset) {
    // عينة بلا label معروف (alarm/knock/other) — تُهمَل بدل أن تكسر confusion[undefined]
    if (!sample || !confusion[sample.label]) continue;

    let finalPrediction;

    if (sample.rms < config.energyGate) {
      // بوابة الطاقة رفضت العينة بالكامل — تُعامَل كـ "لم يُكتشف شيء" (other)
      finalPrediction = 'other';
    } else {
      const alarmSim = safeAlarmRefs.length ? maxSimilarity(sample.embedding, safeAlarmRefs) : 0;
      const knockSim = safeKnockRefs.length ? maxSimilarity(sample.embedding, safeKnockRefs) : 0;

      const alarmPredicted = alarmSim >= config.alarm.similarityThreshold;

      // ── لم يتغيّر: Pulse Detection AND YAMNet Similarity لـ KNOCK ──
      let knockPredicted = knockSim >= config.knock.similarityThreshold;
      if (knockPredicted && sample.envelope) {
        const pulseResult = detectPulsesFromEnvelope(sample.envelope, 10, {
          energyRatioThreshold: config.knock.energyRatioThreshold,
          minAbsRms: config.knock.minAbsRms,
          minPulseGapMs: config.knock.minPulseGapMs,
        });
        const pulseCountOk =
          pulseResult.pulseCount >= config.knock.minPulses && pulseResult.pulseCount <= config.knock.maxPulses;
        const sharpnessOk = pulseResult.pulses.some((p) => p.sharpness >= config.knock.minAttackSharpness);
        knockPredicted = pulseCountOk && sharpnessOk;
      }

      finalPrediction = knockPredicted && knockSim >= alarmSim ? 'knock' : alarmPredicted ? 'alarm' : 'other';
    }

    confusion[sample.label][finalPrediction]++;
  }

  const perClass = {};
  for (const c of classes) {
    const stats = { tp: 0, fp: 0, fn: 0 };
    for (const actual of classes) {
      const n = confusion[actual][c];
      if (actual === c) stats.tp += n;
      else stats.fp += n; // تنبأ بـ c لكن الحقيقة فئة أخرى
    }
    for (const predicted of classes) {
      if (predicted !== c) stats.fn += confusion[c][predicted]; // الحقيقة c لكن تنبأ بغيرها
    }
    perClass[c] = classMetrics(stats);
  }

  const macroF1 = (perClass.alarm.f1 + perClass.knock.f1 + perClass.other.f1) / 3;
  // targetF1: متوسط الفئتين المستهدفتين فقط (alarm/knock) — هذا هو الهدف
  // الأساسي للـ optimizer الآن بدل مجموع FP/FN الموزون
  const targetF1 = (perClass.alarm.f1 + perClass.knock.f1) / 2;
  const totalFP = perClass.alarm.fp + perClass.knock.fp;
  const totalFN = perClass.alarm.fn + perClass.knock.fn;

  return { confusion, perClass, macroF1, targetF1, totalFP, totalFN };
}

/**
 * يفلتر ويرتّب نتائج evaluateConfig(): يستبعد كليًا أي configuration تفشل
 * تحت الحد الأدنى المطلوب للـ Recall لأي فئة مستهدفة (بند 4 و5 و8 من طلب
 * الإصلاح) — بدل معاقبتها بوزن قد يُخدَع. الناجون يُرتَّبون حسب targetF1
 * (Precision/Recall متوازنان معًا) تنازليًا، وFP يُستخدم فقط كـ tie-breaker
 * ثانوي عند تساوي F1 تمامًا.
 *
 * @param {number} minRecall الحد الأدنى المقبول للـ Recall (alarm وknock كلاهما)
 * @returns {{ ranked: Array, metRecallFloor: boolean }}
 */
export function rankConfigs(evaluatedResults, minRecall = 0.5) {
  // ── Defensive check: evaluatedResults قد يكون undefined/null/غير مصفوفة
  // إذا استُدعيت هذه الدالة مباشرة بمدخل خاطئ من مكان آخر مستقبلاً — بدل
  // الانهيار بخطأ محرك JS مبهم عند .filter(undefined), نُرجع حالة فارغة
  // واضحة وقابلة للتعامل معها من الواجهة.
  if (!Array.isArray(evaluatedResults) || evaluatedResults.length === 0) {
    return { ranked: [], metRecallFloor: false };
  }

  const passingFloor = evaluatedResults.filter(
    (r) => r?.perClass?.alarm?.recall >= minRecall && r?.perClass?.knock?.recall >= minRecall
  );
  const metRecallFloor = passingFloor.length > 0;
  const pool = metRecallFloor ? passingFloor : evaluatedResults;

  // استبعاد صارم إضافي: الحل التافه (Recall=0 لأي فئة مستهدفة) يُستبعد حتى
  // من الـ fallback إن وُجد بديل واحد على الأقل بلا هذا العيب
  const nonDegenerate = pool.filter((r) => r?.perClass?.alarm?.recall > 0 && r?.perClass?.knock?.recall > 0);
  const finalPool = nonDegenerate.length > 0 ? nonDegenerate : pool;

  finalPool.sort((a, b) => b.targetF1 - a.targetF1 || a.totalFP - b.totalFP);
  return { ranked: finalPool, metRecallFloor };
}

/**
 * بحث شبكي محلي (Local Optimization) على المعاملات الحقيقية الموجودة فعليًا
 * في هذا المشروع: عتبتا تشابه منفصلتان، بوابة طاقة، وحدة صعود نبضات KNOCK.
 * يُرجع أفضل N نتيجة بعد الفلترة والترتيب عبر rankConfigs()، بالإضافة إلى
 * علم metRecallFloor صريح بدل اختيار حل تافه بصمت عند فشل كل المحاولات.
 *
 * الشكل المُرجَع دائمًا (بدون استثناء، حتى في الحالات الحدّية):
 *   { results: Array<EvaluatedConfig>, metRecallFloor: boolean }
 * results قد تكون [] (مصفوفة فارغة) في أسوأ الحالات، لكن الكائن نفسه لن
 * يكون undefined أبدًا — هذا يمنع خطأ "Cannot convert undefined value to
 * object" الذي يحدث عند destructuring نتيجة undefined في الواجهة.
 *
 * @param {number} minRecall الحد الأدنى المقبول للـ Recall — يُمرَّر مباشرة لـ rankConfigs()
 */
export function runLocalGridSearch(calibrationSet, alarmRefs, knockRefs, ranges = {}, topN = 10, minRecall = 0.5) {
  // ── Defensive checks على كل مدخل قد يصل undefined/null من الواجهة ──
  const safeCalibrationSet = Array.isArray(calibrationSet) ? calibrationSet : [];
  const safeAlarmRefs = Array.isArray(alarmRefs) ? alarmRefs : [];
  const safeKnockRefs = Array.isArray(knockRefs) ? knockRefs : [];

  const {
    alarmThreshold = { min: 0.5, max: 0.9, step: 0.05 },
    knockThreshold = { min: 0.5, max: 0.9, step: 0.05 },
    energyGate = { min: 0.008, max: 0.03, step: 0.007 },
    minAttackSharpness = { min: 1.5, max: 5, step: 1 },
  } = ranges || {};

  const evaluated = [];

  for (let a = alarmThreshold.min; a <= alarmThreshold.max + 1e-9; a += alarmThreshold.step) {
    for (let k = knockThreshold.min; k <= knockThreshold.max + 1e-9; k += knockThreshold.step) {
      for (let e = energyGate.min; e <= energyGate.max + 1e-9; e += energyGate.step) {
        for (let s = minAttackSharpness.min; s <= minAttackSharpness.max + 1e-9; s += minAttackSharpness.step) {
          const config = {
            energyGate: Math.round(e * 1000) / 1000,
            alarm: { similarityThreshold: Math.round(a * 100) / 100 },
            knock: {
              similarityThreshold: Math.round(k * 100) / 100,
              minPulses: 1,
              maxPulses: 6,
              minAttackSharpness: Math.round(s * 10) / 10,
              energyRatioThreshold: 3.0,
              minAbsRms: 0.008,
              minPulseGapMs: 60,
            },
          };
          const evalResult = evaluateConfig(safeCalibrationSet, safeAlarmRefs, safeKnockRefs, config);
          evaluated.push({ config, ...evalResult });
        }
      }
    }
  }

  const { ranked, metRecallFloor } = rankConfigs(evaluated, minRecall);
  return { results: ranked.slice(0, topN), metRecallFloor };
}

/**
 * يكشف Overfitting محتملًا: فرق كبير بين أداء Calibration وValidation
 * لنفس الـ configuration، مقارنةً على targetF1 (alarm/knock) بدل f1 العام.
 */
export function checkOverfitting(calibrationResult, validationResult, f1GapThreshold = 0.15) {
  const f1Gap = Math.abs(calibrationResult.targetF1 - validationResult.targetF1);
  return { isOverfitting: f1Gap > f1GapThreshold, f1Gap };
}

/**
 * يبني ملخصًا إحصائيًا (بدون أي صوت خام) لإرساله إلى Gemini — بند 5 و7.
 * يتضمن الآن confusion matrix وper-class metrics بدل FP/FN الإجمالي فقط،
 * كي تكون توصيات Gemini مبنية على نفس المقاييس المتوازنة المستخدمة محليًا.
 */
export function buildGeminiDatasetSummary({ dataset, gridResults, calibrationResult, validationResult, overfitting, metRecallFloor }) {
  const counts = { alarm: 0, knock: 0, other: 0 };
  for (const s of dataset) counts[s.label] = (counts[s.label] || 0) + 1;

  const best = gridResults[0];
  const worst = gridResults[gridResults.length - 1];

  return {
    datasetStats: counts,
    metRecallFloor,
    bestConfiguration: best ? { config: best.config, metrics: pickMetrics(best) } : null,
    worstConfiguration: worst ? { config: worst.config, metrics: pickMetrics(worst) } : null,
    calibrationMetrics: pickMetrics(calibrationResult),
    validationMetrics: pickMetrics(validationResult),
    overfitting,
    topConfigurationsSample: gridResults.slice(0, 5).map((r) => ({ config: r.config, metrics: pickMetrics(r) })),
  };
}

function pickMetrics(r) {
  return {
    precision_alarm: r.perClass.alarm.precision,
    recall_alarm: r.perClass.alarm.recall,
    f1_alarm: r.perClass.alarm.f1,
    precision_knock: r.perClass.knock.precision,
    recall_knock: r.perClass.knock.recall,
    f1_knock: r.perClass.knock.f1,
    targetF1: r.targetF1,
    macroF1: r.macroF1,
    totalFP: r.totalFP,
    totalFN: r.totalFN,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══ Raw Dataset Diagnostics ════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//
// كل ما يلي أدوات قراءة/تلخيص فقط — لا تُستدعى من evaluateConfig() ولا من
// rankConfigs() ولا من runLocalGridSearch()، ولا تؤثر عليها بأي شكل. الهدف
// الوحيد هو حساب alarmSim/knockSim/pulseCount الخام لكل عينة *قبل* أي
// threshold أو energyGate، لعرضها تشخيصيًا كما هي. لا توجد هنا أي مقارنة
// بعتبة، ولا أي قرار تصنيف.

/** يتحقق أن القيمة رقم صالح للإحصاء (وليست NaN/undefined/null/Infinity) */
function isValidNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Percentile بطريقة الاستيفاء الخطي (Linear Interpolation) — نفس الطريقة
 * الشائعة افتراضيًا (مطابقة لـ numpy.percentile الافتراضي). المدخل يجب أن
 * يكون مصفوفة مُرتَّبة تصاعديًا مسبقًا.
 */
function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (p / 100) * (sortedValues.length - 1);
  const lowerIdx = Math.floor(rank);
  const upperIdx = Math.ceil(rank);
  if (lowerIdx === upperIdx) return sortedValues[lowerIdx];
  const weight = rank - lowerIdx;
  return sortedValues[lowerIdx] * (1 - weight) + sortedValues[upperIdx] * weight;
}

/**
 * يحسب Min/P10/P25/Median/P75/P90/Max/Mean لمصفوفة قيم خام، مع استبعاد
 * القيم غير الصالحة (NaN/undefined/null/Infinity) من الحساب مع عدّها.
 * @returns {{ count, invalidCount, min, p10, p25, median, p75, p90, max, mean } | { count: 0, invalidCount, ... : null }}
 */
export function computeRawStats(rawValues) {
  const valid = [];
  let invalidCount = 0;
  for (const v of rawValues) {
    if (isValidNumber(v)) valid.push(v);
    else invalidCount++;
  }

  if (valid.length === 0) {
    return { count: 0, invalidCount, min: null, p10: null, p25: null, median: null, p75: null, p90: null, max: null, mean: null };
  }

  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);

  return {
    count: sorted.length,
    invalidCount,
    min: sorted[0],
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/**
 * يحسب alarmSim/knockSim/pulseCount الخام لكل عينة في dataset — بنفس
 * الدوال المستخدمة فعليًا في evaluateConfig() (maxSimilarity وdetectPulsesFromEnvelope)
 * لكن *بدون* أي مقارنة بعتبة أو energyGate. النتيجة مُجمَّعة حسب label
 * الحقيقي (alarm/knock/other)، بالإضافة إلى نطاق عام (min→max) عبر كل
 * العينات مجتمعة.
 *
 * pulseParams: تُمرَّر من الخارج (نفس معاملات كشف النبضات الحالية —
 * energyRatioThreshold/minAbsRms/minPulseGapMs) فقط لأن detectPulsesFromEnvelope
 * تحتاجها لاستخراج pulseCount نفسه — هذه معاملات استخراج ميزة (feature
 * extraction)، وليست عتبة تصنيف؛ لا علاقة لها بـ alarm/knock similarityThreshold
 * أو energyGate المستخدَمين في evaluateConfig().
 *
 * @returns {{
 *   sampleCounts: { alarm: number, knock: number, other: number },
 *   overallRange: { alarmSim: {min,max}, knockSim: {min,max}, pulseCount: {min,max} },
 *   byLabel: {
 *     alarm: { alarmSim: StatsObj, knockSim: StatsObj, pulseCount: StatsObj },
 *     knock: { ... },
 *     other: { ... },
 *   },
 * }}
 */
export function computeRawFeatureDiagnostics(dataset, alarmRefs, knockRefs, pulseParams = {}) {
  const safeDataset = Array.isArray(dataset) ? dataset : [];
  const safeAlarmRefs = Array.isArray(alarmRefs) ? alarmRefs : [];
  const safeKnockRefs = Array.isArray(knockRefs) ? knockRefs : [];

  const raw = { alarm: { alarmSim: [], knockSim: [], pulseCount: [] }, knock: { alarmSim: [], knockSim: [], pulseCount: [] }, other: { alarmSim: [], knockSim: [], pulseCount: [] } };

  for (const sample of safeDataset) {
    if (!sample || !raw[sample.label]) continue;

    const alarmSim = safeAlarmRefs.length ? maxSimilarity(sample.embedding, safeAlarmRefs) : NaN;
    const knockSim = safeKnockRefs.length ? maxSimilarity(sample.embedding, safeKnockRefs) : NaN;

    let pulseCount = NaN;
    if (sample.envelope) {
      const pulseResult = detectPulsesFromEnvelope(sample.envelope, 10, pulseParams);
      pulseCount = pulseResult.pulseCount;
    }

    raw[sample.label].alarmSim.push(alarmSim);
    raw[sample.label].knockSim.push(knockSim);
    raw[sample.label].pulseCount.push(pulseCount);
  }

  const byLabel = {};
  for (const label of ['alarm', 'knock', 'other']) {
    byLabel[label] = {
      alarmSim: computeRawStats(raw[label].alarmSim),
      knockSim: computeRawStats(raw[label].knockSim),
      pulseCount: computeRawStats(raw[label].pulseCount),
    };
  }

  const sampleCounts = {
    alarm: raw.alarm.alarmSim.length,
    knock: raw.knock.alarmSim.length,
    other: raw.other.alarmSim.length,
  };

  // نطاق عام عبر كل العينات مجتمعة بغض النظر عن الفئة
  const allAlarmSim = [...raw.alarm.alarmSim, ...raw.knock.alarmSim, ...raw.other.alarmSim];
  const allKnockSim = [...raw.alarm.knockSim, ...raw.knock.knockSim, ...raw.other.knockSim];
  const allPulseCount = [...raw.alarm.pulseCount, ...raw.knock.pulseCount, ...raw.other.pulseCount];

  const overallAlarmSimStats = computeRawStats(allAlarmSim);
  const overallKnockSimStats = computeRawStats(allKnockSim);
  const overallPulseCountStats = computeRawStats(allPulseCount);

  return {
    sampleCounts,
    overallRange: {
      alarmSim: { min: overallAlarmSimStats.min, max: overallAlarmSimStats.max },
      knockSim: { min: overallKnockSimStats.min, max: overallKnockSimStats.max },
      pulseCount: { min: overallPulseCountStats.min, max: overallPulseCountStats.max },
    },
    invalidCounts: {
      alarmSim: raw.alarm.alarmSim.concat(raw.knock.alarmSim, raw.other.alarmSim).filter((v) => !isValidNumber(v)).length,
      knockSim: raw.alarm.knockSim.concat(raw.knock.knockSim, raw.other.knockSim).filter((v) => !isValidNumber(v)).length,
      pulseCount: raw.alarm.pulseCount.concat(raw.knock.pulseCount, raw.other.pulseCount).filter((v) => !isValidNumber(v)).length,
    },
    byLabel,
  };
}
