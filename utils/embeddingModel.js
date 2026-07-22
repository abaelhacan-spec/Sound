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
// YAMNet يحتاج 0.975 ثانية على الأقل من الصوت لإنتاج أول إطار embedding
// (نافذة 0.96 ثانية + هامش أمان بسيط لضمان عدم القطع).
const MIN_SAMPLES_REQUIRED = Math.ceil(0.975 * SAMPLE_RATE);

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
 * يستخرج "بصمة" (Embedding) واحدة تمثّل المقطع الصوتي بأكمله.
 *
 * YAMNet يُدخِل الصوت الخام (waveform) مباشرة، ويُخرِج مصفوفة أطر
 * (Frames) — إطار واحد لكل نافذة 0.96 ثانية (بتراكب 50%). كل إطار هو
 * متجه بحجم 1024. بما أن مقاطعنا (1.2 - 2.5 ثانية) قد تنتج أكثر من إطار
 * واحد، نأخذ متوسط كل الأطر الناتجة لإنتاج متجه واحد يمثل المقطع كاملاً
 * — بنفس فلسفة averageFingerprints المستخدمة سابقًا مع FFT.
 *
 * @param {number[]} samples عينات صوتية مطبّعة بين -1 و 1 (16kHz، مونو)
 * @param {object} model الكائن المُرجَع من loadEmbeddingModel()
 * @returns {Promise<number[]>} متجه Embedding بحجم 1024
 */
export async function extractEmbedding(samples, model) {
  let input = samples;

  // لو المقطع أقصر من الحد الأدنى المطلوب، نكمّله بالأصفار (صمت) بدل
  // رفض المقطع، لأن هذا نادر الحدوث ولا يستحق تعقيد إضافي في الواجهة.
  if (input.length < MIN_SAMPLES_REQUIRED) {
    const padded = new Array(MIN_SAMPLES_REQUIRED).fill(0);
    for (let i = 0; i < input.length; i++) padded[i] = input[i];
    input = padded;
  }

  const inputArray = Float32Array.from(input);
  const outputs = await model.run([inputArray]);

  const EMBED_DIM = 1024;

  // مخرجات YAMNet TFLite الرسمية بالترتيب المتوقَّع: [scores, embeddings, spectrogram].
  // لكن بعض إصدارات react-native-fast-tflite قد تُرجع المخرجات بترتيب مختلف
  // أو تُخفي بعضها، فلا يصح الاعتماد على outputs[1] كمؤشر ثابت دائمًا.
  let embeddingsFlat = null;

  // المحاولة 1: الترتيب الرسمي (outputs[1])
  if (outputs && outputs[1] && outputs[1].length % EMBED_DIM === 0 && outputs[1].length > 0) {
    embeddingsFlat = outputs[1];
  }

  // المحاولة 2: ابحث بين كل المخرجات عن أول tensor طوله مضاعف لـ 1024
  // — هذا بالضرورة tensor الـ embeddings، بغض النظر عن ترتيبه الفعلي.
  if (!embeddingsFlat && outputs) {
    for (let i = 0; i < outputs.length; i++) {
      const t = outputs[i];
      if (t && typeof t.length === 'number' && t.length > 0 && t.length % EMBED_DIM === 0) {
        embeddingsFlat = t;
        break;
      }
    }
  }

  // المحاولة 3: فشل كل شيء → رسالة خطأ تفصيلية تُظهر أحجام كل المخرجات
  // لتسهيل التشخيص لاحقًا بدل رسالة "length of undefined" المبهمة.
  if (!embeddingsFlat) {
    const shapesInfo = outputs
      ? outputs.map((t, i) => `outputs[${i}]: ${t ? t.length : 'undefined'}`).join(', ')
      : 'outputs غير معرَّفة بالكامل';
    throw new Error(
      `تعذّر تحديد tensor الـ embeddings من مخرجات النموذج. الأحجام المُرجَعة: ${shapesInfo}. ` +
      `تأكد أن ملف yamnet.tflite هو النسخة الصحيحة (classification variant, 3 outputs).`
    );
  }

  const numFrames = Math.floor(embeddingsFlat.length / EMBED_DIM);

  if (numFrames <= 0) {
    throw new Error('تعذّر استخراج أي إطار Embedding من هذا المقطع');
  }

  const avg = new Array(EMBED_DIM).fill(0);
  for (let f = 0; f < numFrames; f++) {
    const offset = f * EMBED_DIM;
    for (let i = 0; i < EMBED_DIM; i++) {
      avg[i] += embeddingsFlat[offset + i] / numFrames;
    }
  }

  return avg;
}
