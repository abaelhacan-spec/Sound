import { loadTensorflowModel } from 'react-native-fast-tflite';

/**
 * هذا الملف مسؤول بالكامل عن التعامل مع نموذج YAMNet الجاهز (TFLite)،
 * والذي يُستخدم هنا فقط كـ"مستخرج بصمة صوتية" (Embedding Extractor)
 * وليس كمصنّف. لا نستخدم إطلاقًا مخرجاته الخاصة بالتصنيف (521 فئة صوتية)،
 * فقط الطبقة قبل الأخيرة (Embedding بحجم 1024).
 *
 * ملاحظة تركيب مهمة: يجب وضع ملف النموذج الفعلي في:
 *   assets/yamnet.tflite
 * يمكن تحميله من TensorFlow Hub (نسخة TFLite الرسمية من Google):
 *   https://tfhub.dev/google/lite-model/yamnet/tflite/1
 * حجم الملف حوالي 3.7 ميجابايت.
 */

const SAMPLE_RATE = 16000;

// ⚠️ تصحيح جوهري: نسخة YAMNet TFLite الرسمية (lite-model/yamnet/tflite/1)
// تتوقع مدخلًا بطول ثابت تحديدًا = 15600 عينة (0.975 ثانية عند 16kHz)،
// وليس طولًا متغيرًا كما في نسخة TensorFlow SavedModel الكاملة. إرسال
// مقطع أطول (كالثانيتين المستخدمتين في هذا التطبيق) دفعة واحدة لنموذج
// بشكل مدخل ثابت قد يُنتج نتائج غير معرَّفة (قد تبدو متطابقة دائمًا،
// كما لاحظنا: تشابه 100% حتى بين أصوات مختلفة تمامًا)، لأن المكتبة قد
// تقرأ جزءًا غير صحيح من الذاكرة أو تتجاهل الفائض بصمت دون رمي خطأ.
//
// الحل: نقسّم أي مقطع أطول من الحجم الرسمي إلى إطارات متتالية، كل واحد
// بطول 15600 عينة بالضبط (نُكمّل آخر إطار ناقص بالأصفار عند الحاجة)،
// ونُشغّل النموذج على كل إطار بشكل منفصل، ثم نأخذ متوسط كل الـ embeddings
// الناتجة لتمثيل المقطع كاملاً — بدل الاعتماد على المكتبة لتقسيم الطول
// تلقائيًا داخليًا.
const MODEL_INPUT_SIZE = 15600;
const EMBED_DIM = 1024;

let modelPromise = null;

/**
 * يحمّل نموذج YAMNet مرة واحدة فقط (Singleton) ويعيد استخدامه في كل
 * استدعاء لاحق، تجنبًا لتكلفة إعادة تحميل الملف من التخزين في كل مقطع.
 */
export function loadEmbeddingModel() {
  if (!modelPromise) {
    modelPromise = loadTensorflowModel(require('../assets/yamnet.tflite'));
  }
  return modelPromise;
}

/**
 * يستخرج embedding واحد (1024 رقم) من إطار صوتي واحد بطول MODEL_INPUT_SIZE
 * بالضبط. هذا هو "استدعاء النموذج الصحيح" وفق الشكل الذي بُني عليه فعليًا.
 */
async function runModelOnSingleFrame(frameSamples, model) {
  const inputArray = Float32Array.from(frameSamples);
  const outputs = await model.run([inputArray]);

  // مخرجات YAMNet TFLite الرسمية بالترتيب المتوقَّع: [scores, embeddings, spectrogram].
  // لكن بعض إصدارات react-native-fast-tflite قد تُرجع المخرجات بترتيب مختلف
  // أو تُخفي بعضها، فلا يصح الاعتماد على outputs[1] كمؤشر ثابت دائمًا.
  let embeddingsFlat = null;

  // المحاولة 1: الترتيب الرسمي (outputs[1])
  if (outputs && outputs[1] && outputs[1].length % EMBED_DIM === 0 && outputs[1].length > 0) {
    embeddingsFlat = outputs[1];
  }

  // المحاولة 2: ابحث بين كل المخرجات عن أول tensor طوله مضاعف لـ 1024
  if (!embeddingsFlat && outputs) {
    for (let i = 0; i < outputs.length; i++) {
      const t = outputs[i];
      if (t && typeof t.length === 'number' && t.length > 0 && t.length % EMBED_DIM === 0) {
        embeddingsFlat = t;
        break;
      }
    }
  }

  if (!embeddingsFlat) {
    const shapesInfo = outputs
      ? outputs.map((t, i) => `outputs[${i}]: ${t ? t.length : 'undefined'}`).join(', ')
      : 'outputs غير معرَّفة بالكامل';
    throw new Error(
      `تعذّر تحديد tensor الـ embeddings من مخرجات النموذج. الأحجام المُرجَعة: ${shapesInfo}. ` +
      `تأكد أن ملف yamnet.tflite هو النسخة الصحيحة (classification variant, 3 outputs).`
    );
  }

  // مع مدخل بطول MODEL_INPUT_SIZE بالضبط (إطار واحد فقط)، يُفترض أن يُنتج
  // النموذج إطار embedding واحد بالضبط (1024 رقم). نحتفظ بمنطق قسمة
  // numFrames احتياطيًا فقط تحسبًا لأي سلوك داخلي غير متوقَّع من المكتبة.
  const numFrames = Math.floor(embeddingsFlat.length / EMBED_DIM);
  if (numFrames <= 0) {
    throw new Error('تعذّر استخراج أي إطار Embedding من هذا المقطع');
  }

  if (numFrames === 1) {
    return Array.from(embeddingsFlat.slice(0, EMBED_DIM));
  }

  // احتياطي: لو أنتجت المكتبة أكثر من إطار رغم كل شيء، نأخذ متوسطها
  const avg = new Array(EMBED_DIM).fill(0);
  for (let f = 0; f < numFrames; f++) {
    const offset = f * EMBED_DIM;
    for (let i = 0; i < EMBED_DIM; i++) {
      avg[i] += embeddingsFlat[offset + i] / numFrames;
    }
  }
  return avg;
}

/**
 * يستخرج "بصمة" (Embedding) واحدة تمثّل مقطعًا صوتيًا كاملاً، بغض النظر
 * عن طوله. يُقسِّم المقطع داخليًا إلى إطارات متتالية بطول MODEL_INPUT_SIZE
 * بالضبط (الحجم الرسمي الذي يتوقعه النموذج)، يُشغِّل النموذج على كل إطار
 * على حدة، ثم يأخذ متوسط كل الـ embeddings الناتجة لتمثيل المقطع كاملاً.
 *
 * @param {number[]} samples عينات صوتية مطبّعة بين -1 و 1 (16kHz، مونو)
 * @param {object} model الكائن المُرجَع من loadEmbeddingModel()
 * @returns {Promise<number[]>} متجه Embedding بحجم 1024
 */
export async function extractEmbedding(samples, model) {
  if (!samples || samples.length === 0) {
    throw new Error('لا توجد عينات صوتية لاستخراج البصمة منها');
  }

  // نقسّم المقطع إلى إطارات متتالية غير متراكبة، كل واحد بطول
  // MODEL_INPUT_SIZE بالضبط. الإطار الأخير الناقص يُكمَّل بالأصفار (صمت)
  // بدل تجاهله، حفاظًا على أي جزء من الصوت يقع في نهاية المقطع.
  const frames = [];
  for (let start = 0; start < samples.length; start += MODEL_INPUT_SIZE) {
    const end = Math.min(start + MODEL_INPUT_SIZE, samples.length);
    const frame = new Array(MODEL_INPUT_SIZE).fill(0);
    for (let i = start; i < end; i++) {
      frame[i - start] = samples[i];
    }
    frames.push(frame);

    // لو الإطار الأخير قصير جدًا (أقل من 10% من الحجم المطلوب)، لا يستحق
    // تشغيل النموذج عليه (غالبًا صمت متبقٍ لا يحمل معلومة مفيدة)
    if (end - start < MODEL_INPUT_SIZE * 0.1 && frames.length > 1) {
      frames.pop();
      break;
    }
  }

  if (frames.length === 0) {
    // مقطع أقصر من الحد الأدنى بكثير — إطار واحد مكمَّل بالأصفار
    frames.push(new Array(MODEL_INPUT_SIZE).fill(0).map((_, i) => samples[i] || 0));
  }

  const frameEmbeddings = [];
  for (const frame of frames) {
    const emb = await runModelOnSingleFrame(frame, model);
    frameEmbeddings.push(emb);
  }

  // متوسط كل embeddings الإطارات لتمثيل المقطع كاملاً بمتجه واحد
  const avg = new Array(EMBED_DIM).fill(0);
  for (const emb of frameEmbeddings) {
    for (let i = 0; i < EMBED_DIM; i++) {
      avg[i] += emb[i] / frameEmbeddings.length;
    }
  }
  return avg;
}
