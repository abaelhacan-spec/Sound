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

  // مخرجات YAMNet TFLite الرسمية بالترتيب: [scores, embeddings, spectrogram]
  // مصفوفة الـ embeddings مُسطَّحة (flattened) بشكل [numFrames * 1024].
  const embeddingsFlat = outputs[1];
  const EMBED_DIM = 1024;
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
