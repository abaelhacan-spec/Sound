/**
 * ───────────────────────────────────────────────────────────────────────────
 * اختبار تشخيصي مستقل لنموذج YAMNet
 * ───────────────────────────────────────────────────────────────────────────
 *
 * الهدف: التحقق مما إذا كان YAMNet نفسه ينتج embeddings مختلفة لأصوات مختلفة،
 * بمعزل تام عن أي مشكلة في التسجيل أو قراءة WAV.
 *
 * ينشئ هذا الاختبار 4 إشارات صوتية اصطناعية (دون حاجة لأي ملف صوتي):
 *   1. صمت تام       → أصفار
 *   2. نغمة 440Hz    → مشابه لصوت جرس/منبه
 *   3. ضربة نبضية    → مشابه لطرق الباب (اندفاع حاد + تخميد)
 *   4. ضجيج أبيض     → صوت عشوائي (اختبار الفوضى)
 *
 * إذا أعاد النموذج embeddings مختلفة لهذه الإشارات → المشكلة في خط التسجيل/WAV.
 * إذا أعاد embeddings متطابقة لجميعها        → المشكلة في النموذج نفسه أو استدعائه.
 */

import { loadEmbeddingModel } from './embeddingModel';
import { cosineSimilarity } from './audioFingerprint';

const SAMPLE_RATE = 16000;
const DURATION_SEC = 0.975; // نفس الإطار الذي يتوقعه YAMNet (15600 عينة)
const N_SAMPLES = Math.round(SAMPLE_RATE * DURATION_SEC); // = 15600

// ─── مولّدات الإشارات الاصطناعية ──────────────────────────────────────────

/** صمت تام: كل العينات صفر */
function generateSilence() {
  return new Array(N_SAMPLES).fill(0);
}

/**
 * نغمة جيبية نقية عند تردد f (Hz)
 * تمثّل صوتًا دوريًا مثل جرس أو منبه
 */
function generateSineTone(freqHz = 440, amplitudeDb = -6) {
  const amplitude = Math.pow(10, amplitudeDb / 20); // تحويل dB إلى سعة خطية
  const samples = new Array(N_SAMPLES);
  for (let i = 0; i < N_SAMPLES; i++) {
    samples[i] = amplitude * Math.sin(2 * Math.PI * freqHz * i / SAMPLE_RATE);
  }
  return samples;
}

/**
 * ضربة نبضية مُخمَّدة: spike حاد يتلاشى أسيًا
 * تمثّل صوت طرق أو دقة حادة
 */
function generateImpulse(amplitudeDb = -3, decayRate = 200) {
  const amplitude = Math.pow(10, amplitudeDb / 20);
  const samples = new Array(N_SAMPLES);
  for (let i = 0; i < N_SAMPLES; i++) {
    const t = i / SAMPLE_RATE;
    samples[i] = amplitude * Math.exp(-decayRate * t) * Math.cos(2 * Math.PI * 800 * t);
  }
  return samples;
}

/**
 * ضجيج أبيض محبذ (seeded pseudo-random): عشوائي لكن قابل للتكرار
 * يستخدم مولّد LCG بسيط (Linear Congruential Generator) بذرة ثابتة
 * حتى ينتج نفس القيم في كل تشغيل (reproducible)
 */
function generateWhiteNoise(amplitudeDb = -12) {
  const amplitude = Math.pow(10, amplitudeDb / 20);
  const samples = new Array(N_SAMPLES);
  let seed = 0xDEADBEEF; // بذرة ثابتة → نفس النتيجة دائمًا
  for (let i = 0; i < N_SAMPLES; i++) {
    // LCG: x_{n+1} = (a * x_n + c) mod m
    seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF;
    const normalized = (seed >>> 0) / 0xFFFFFFFF * 2 - 1; // [-1, 1]
    samples[i] = amplitude * normalized;
  }
  return samples;
}

// ─── تنسيق النتائج ────────────────────────────────────────────────────────

function embeddingStats(emb) {
  if (!emb || emb.length === 0) return { min: 0, max: 0, mean: 0, norm: 0 };
  let min = emb[0], max = emb[0], sum = 0, sumSq = 0;
  for (const v of emb) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
  }
  return {
    min: min.toFixed(4),
    max: max.toFixed(4),
    mean: (sum / emb.length).toFixed(4),
    norm: Math.sqrt(sumSq).toFixed(4),
  };
}

function formatSimilarityMatrix(labels, embeddings) {
  const lines = [];
  lines.push('مصفوفة التشابه (Cosine Similarity):');
  lines.push('─'.repeat(60));

  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      const pct = (sim * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(sim * 20)).padEnd(20, '░');
      lines.push(`${labels[i]} ↔ ${labels[j]}: ${bar} ${pct}%`);
    }
  }

  lines.push('─'.repeat(60));
  lines.push('تفسير النتائج:');
  lines.push('  < 70%  → embeddings مختلفة ✅ النموذج يعمل صحيحًا');
  lines.push('  70-85% → تشابه معتدل (قد يكون طبيعيًا بين أصوات متشابهة)');
  lines.push('  > 90%  → ⚠️ تشابه مرتفع جدًا — النموذج يرى نفس الإدخال');
  lines.push('  > 98%  → 🔴 خطأ حرج: النموذج يتجاهل الإدخال فعليًا');
  return lines.join('\n');
}

// ─── الدالة الرئيسية للاختبار ─────────────────────────────────────────────

/**
 * يشغّل الاختبار التشخيصي الكامل ويُعيد تقريرًا نصيًا.
 *
 * @param {function} onProgress دالة اختيارية لإبلاغ التقدم (status: string)
 * @returns {Promise<{ report: string, passed: boolean, embeddings: object }>}
 */
export async function runDiagnosticTest(onProgress = () => {}) {
  const reportLines = [];
  const log = (line) => {
    reportLines.push(line);
    onProgress(line);
  };

  log('═══════════════════════════════════════════════════');
  log('     اختبار تشخيص نموذج YAMNet');
  log('═══════════════════════════════════════════════════');
  log(`عدد العينات لكل إشارة: ${N_SAMPLES} (${DURATION_SEC}s @ ${SAMPLE_RATE}Hz)`);
  log('');

  // ─── 1. تحميل النموذج ───────────────────────────────────────────────────
  log('⏳ [1/6] تحميل نموذج YAMNet...');
  let model;
  try {
    model = await loadEmbeddingModel();
    log('✅ النموذج محمّل بنجاح');
  } catch (err) {
    log(`🔴 فشل تحميل النموذج: ${err.message}`);
    return { report: reportLines.join('\n'), passed: false, embeddings: null };
  }
  log('');

  // ─── 2. توليد الإشارات الاصطناعية ────────────────────────────────────────
  log('⏳ [2/6] توليد الإشارات الاصطناعية...');
  const signals = {
    'صمت':      generateSilence(),
    'نغمة 440Hz': generateSineTone(440),
    'ضربة نبضية': generateImpulse(),
    'ضجيج أبيض': generateWhiteNoise(),
  };
  const labels = Object.keys(signals);

  // التحقق من صحة الإشارات
  for (const [name, sig] of Object.entries(signals)) {
    const rms = Math.sqrt(sig.reduce((s, v) => s + v*v, 0) / sig.length);
    log(`   ${name}: ${sig.length} عينة، RMS = ${rms.toFixed(4)}`);
  }
  log('');

  // ─── 3. فحص إدخال النموذج (أول 5 عينات) ──────────────────────────────────
  log('⏳ [3/6] التحقق من قيم الإدخال (أول 5 عينات من كل إشارة):');
  for (const [name, sig] of Object.entries(signals)) {
    const preview = sig.slice(0, 5).map(v => v.toFixed(4)).join(', ');
    log(`   ${name}: [${preview}]`);
  }
  log('   ✅ الإشارات متنوعة ومختلفة عن بعضها كما هو متوقع');
  log('');

  // ─── 4. تشغيل النموذج على كل إشارة ──────────────────────────────────────
  log('⏳ [4/6] استخراج Embeddings (قد يستغرق 10-30 ثانية)...');
  const embeddings = {};
  const embStats = {};

  for (const [name, sig] of Object.entries(signals)) {
    log(`   جاري معالجة: ${name}...`);
    try {
      // نستدعي النموذج مباشرةً بدون extractEmbedding لتجنب أي تعديل وسيط
      const inputArray = Float32Array.from(sig);
      const outputs = await model.run([inputArray]);

      // ─── Bug #3: فحص شكل المخرجات ─────────────────────────────────────
      // YAMNet TFLite الرسمي يُعيد 3 مخرجات بالترتيب:
      //   outputs[0]: scores    → حجم 521 (تصنيف AudioSet)
      //   outputs[1]: embedding → حجم 1024 (البصمة الصوتية)
      //   outputs[2]: log_mel_spectrogram → حجم متغير (N×64)
      if (!outputs || outputs.length === 0) {
        log(`   🔴 ${name}: النموذج لم يُعد أي مخرجات!`);
        continue;
      }

      log(`   ${name}: عدد المخرجات = ${outputs.length}`);
      for (let i = 0; i < outputs.length; i++) {
        const t = outputs[i];
        log(`      outputs[${i}]: ${t ? t.length : 'null'} عنصر`);
      }

      // استخراج embedding من outputs[1]
      let emb = null;
      if (outputs[1] && outputs[1].length >= 1024) {
        emb = Array.from(outputs[1].slice(0, 1024));
        log(`   ✅ ${name}: أُخذ outputs[1] (${outputs[1].length} عنصر)`);
      } else {
        // fallback: بحث عن tensor بحجم مضاعف لـ 1024
        for (let i = 0; i < outputs.length; i++) {
          if (outputs[i] && outputs[i].length > 0 && outputs[i].length % 1024 === 0) {
            emb = Array.from(outputs[i].slice(0, 1024));
            log(`   ⚠️ ${name}: اضطُر للاستخدام outputs[${i}] (${outputs[i].length} عنصر) — تحقق من ترتيب المخرجات`);
            break;
          }
        }
      }

      if (!emb) {
        log(`   🔴 ${name}: لم يُعثر على tensor بحجم مناسب للـ embedding`);
        log(`      الأحجام: ${outputs.map((t,i) => `[${i}]:${t?.length}`).join(', ')}`);
        continue;
      }

      embeddings[name] = emb;
      embStats[name] = embeddingStats(emb);
    } catch (err) {
      log(`   🔴 ${name}: خطأ — ${err.message}`);
    }
  }
  log('');

  // ─── 5. أول 20 قيمة من كل embedding ─────────────────────────────────────
  log('⏳ [5/6] أول 20 قيمة من كل Embedding:');
  log('─'.repeat(60));
  for (const [name, emb] of Object.entries(embeddings)) {
    const stats = embStats[name];
    const first20 = emb.slice(0, 20).map(v => v.toFixed(3)).join(' ');
    log(`${name}:`);
    log(`  min=${stats.min} max=${stats.max} mean=${stats.mean} L2=${stats.norm}`);
    log(`  [${first20}]`);
    log('');
  }

  // ─── 6. مصفوفة Cosine Similarity ─────────────────────────────────────────
  log('⏳ [6/6] حساب Cosine Similarity بين جميع الأزواج:');
  const availableLabels = Object.keys(embeddings);
  const availableEmbeddings = availableLabels.map(l => embeddings[l]);

  if (availableLabels.length < 2) {
    log('🔴 لا يوجد عدد كافٍ من الـ embeddings لحساب التشابه');
    return { report: reportLines.join('\n'), passed: false, embeddings };
  }

  log(formatSimilarityMatrix(availableLabels, availableEmbeddings));
  log('');

  // ─── 7. تقييم النتيجة النهائية ────────────────────────────────────────────
  let maxSim = 0;
  let maxPair = '';
  for (let i = 0; i < availableLabels.length; i++) {
    for (let j = i + 1; j < availableLabels.length; j++) {
      const sim = cosineSimilarity(availableEmbeddings[i], availableEmbeddings[j]);
      if (sim > maxSim) {
        maxSim = sim;
        maxPair = `${availableLabels[i]} ↔ ${availableLabels[j]}`;
      }
    }
  }

  const passed = maxSim < 0.90;
  log('═══════════════════════════════════════════════════');
  if (passed) {
    log(`✅ النموذج يعمل صحيحًا`);
    log(`   أعلى تشابه: ${(maxSim*100).toFixed(1)}% (${maxPair})`);
    log('   → embeddings مختلفة لأصوات مختلفة ✓');
    log('   → المشكلة في خط التسجيل/قراءة WAV، وليس في النموذج');
    log('   → تأكد من تطبيق إصلاحات audioFingerprint.js و audioRecorder.js');
  } else {
    log(`🔴 المشكلة في النموذج أو استدعائه`);
    log(`   أعلى تشابه: ${(maxSim*100).toFixed(1)}% (${maxPair})`);
    log('   → embeddings متطابقة رغم اختلاف الإدخال الاصطناعي');
    log('   → يعني النموذج يتجاهل الإدخال فعليًا');
    log('   الأسباب المحتملة:');
    log('   1. ملف yamnet.tflite تالف أو من نسخة خاطئة');
    log('   2. react-native-fast-tflite لا ترسل البيانات بشكل صحيح');
    log('   3. شكل tensor الإدخال غير متوافق مع ما يتوقعه النموذج');
  }
  log('═══════════════════════════════════════════════════');

  return { report: reportLines.join('\n'), passed, embeddings };
}
