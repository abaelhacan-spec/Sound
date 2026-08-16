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
  for (const sample of dataset) {
    if (byLabel[sample.label]) byLabel[sample.label].push(sample);
  }

  const calibrationSet = [];
  const validationSet = [];

  for (const label of Object.keys(byLabel)) {
    const shuffled = shuffle(byLabel[label]);
    const splitAt = Math.max(1, Math.floor(shuffled.length * calibrationRatio));
    calibrationSet.push(...shuffled.slice(0, splitAt));
    validationSet.push(...shuffled.slice(splitAt));
  }

  return { calibrationSet: shuffle(calibrationSet), validationSet: shuffle(validationSet) };
}

/**
 * يقيّم configuration واحدة على مجموعة بيانات، بنفس منطق القرار المستخدم
 * فعليًا في MonitoringScreen.js (بوابة طاقة → تشابه → [لـ knock: فحص
 * نبضات] → أولوية الأعلى تشابهًا عند تعارض alarm/knock).
 *
 * fpWeight الافتراضي أعلى بكثير من fnWeight لأن الاتصال الوهمي (False
 * Positive) هو أخطر مشكلة في هذا التطبيق (بند 6 من المواصفة).
 */
export function evaluateConfig(dataset, alarmRefs, knockRefs, config, weights = { fpWeight: 5, fnWeight: 1 }) {
  let alarmTP = 0, alarmFP = 0, alarmFN = 0;
  let knockTP = 0, knockFP = 0, knockFN = 0;

  for (const sample of dataset) {
    if (sample.rms < config.energyGate) {
      if (sample.label === 'alarm') alarmFN++;
      if (sample.label === 'knock') knockFN++;
      continue;
    }

    const alarmSim = alarmRefs.length ? maxSimilarity(sample.embedding, alarmRefs) : 0;
    const knockSim = knockRefs.length ? maxSimilarity(sample.embedding, knockRefs) : 0;

    const alarmPredicted = alarmSim >= config.alarm.similarityThreshold;

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

    // نفس منطق الأولوية في MonitoringScreen: عند تعارض الاثنين، الأعلى تشابهًا يفوز
    const finalPrediction = knockPredicted && knockSim >= alarmSim ? 'knock' : alarmPredicted ? 'alarm' : 'other';

    if (sample.label === 'alarm') {
      if (finalPrediction === 'alarm') alarmTP++;
      else alarmFN++;
      if (finalPrediction === 'knock') knockFP++;
    } else if (sample.label === 'knock') {
      if (finalPrediction === 'knock') knockTP++;
      else knockFN++;
      if (finalPrediction === 'alarm') alarmFP++;
    } else {
      if (finalPrediction === 'alarm') alarmFP++;
      if (finalPrediction === 'knock') knockFP++;
    }
  }

  const totalFP = alarmFP + knockFP;
  const totalFN = alarmFN + knockFN;
  const totalTP = alarmTP + knockTP;

  const precision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 1;
  const recall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const weightedErrorScore = totalFP * weights.fpWeight + totalFN * weights.fnWeight;

  return {
    alarmTP, alarmFP, alarmFN,
    knockTP, knockFP, knockFN,
    totalTP, totalFP, totalFN,
    precision, recall, f1,
    weightedErrorScore,
  };
}

/**
 * بحث شبكي محلي (Local Optimization — بند 6) على المعاملات الحقيقية
 * الموجودة فعليًا في هذا المشروع: عتبتا تشابه منفصلتان، بوابة طاقة، ومعاملات
 * طبقة كشف نبضات KNOCK. يُرجع أفضل N نتيجة مرتّبة تصاعديًا حسب الخطأ الموزون.
 *
 * @param {object} ranges مدى كل معامل: { min, max, step } — قيم افتراضية معقولة مضمّنة
 */
export function runLocalGridSearch(calibrationSet, alarmRefs, knockRefs, ranges = {}, topN = 10) {
  const {
    alarmThreshold = { min: 0.5, max: 0.9, step: 0.05 },
    knockThreshold = { min: 0.5, max: 0.9, step: 0.05 },
    energyGate = { min: 0.008, max: 0.03, step: 0.007 },
    minAttackSharpness = { min: 1.5, max: 5, step: 1 },
  } = ranges;

  const results = [];

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
          const evalResult = evaluateConfig(calibrationSet, alarmRefs, knockRefs, config);
          results.push({ config, ...evalResult });
        }
      }
    }
  }

  results.sort((x, y) => x.weightedErrorScore - y.weightedErrorScore || y.f1 - x.f1);
  return results.slice(0, topN);
}

/**
 * يكشف Overfitting محتملًا: فرق كبير بين أداء Calibration وValidation
 * لنفس الـ configuration (بند 10 من المواصفة).
 */
export function checkOverfitting(calibrationResult, validationResult, f1GapThreshold = 0.15) {
  const f1Gap = Math.abs(calibrationResult.f1 - validationResult.f1);
  return { isOverfitting: f1Gap > f1GapThreshold, f1Gap };
}

/**
 * يبني ملخصًا إحصائيًا (بدون أي صوت خام) لإرساله إلى Gemini — بند 5 و7.
 * يتضمن فقط أرقامًا: إحصائيات Dataset، أفضل/أسوأ configurations، حالات
 * الخطأ، توزيعات similarity.
 */
export function buildGeminiDatasetSummary({ dataset, gridResults, calibrationResult, validationResult, overfitting }) {
  const counts = { alarm: 0, knock: 0, other: 0 };
  for (const s of dataset) counts[s.label] = (counts[s.label] || 0) + 1;

  const best = gridResults[0];
  const worst = gridResults[gridResults.length - 1];

  return {
    datasetStats: counts,
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
    precision: r.precision,
    recall: r.recall,
    f1: r.f1,
    alarmFP: r.alarmFP,
    alarmFN: r.alarmFN,
    knockFP: r.knockFP,
    knockFN: r.knockFN,
    weightedErrorScore: r.weightedErrorScore,
  };
}
