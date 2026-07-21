import * as FileSystem from 'expo-file-system';

/**
 * هذا الملف الآن مسؤول فقط عن أدوات عامة لا علاقة لها بأي نموذج معيّن:
 * قراءة ملفات WAV، حساب الطاقة (RMS)، وحساب التشابه بين متجهين (Cosine
 * Similarity) — تُستخدم مع Embeddings من YAMNet بدل البصمات الترددية
 * اليدوية القديمة (FFT)، لكن المنطق الرياضي نفسه صالح لأي متجه رقمي.
 */

/**
 * يحوّل ملف WAV (base64) إلى مصفوفة عينات صوتية مطبّعة (-1 إلى 1)
 * يفترض أن الملف WAV بصيغة 16-bit PCM, mono
 */
export async function readWavAsSamples(uri) {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const binary = globalThis.atob
    ? globalThis.atob(base64)
    : Buffer.from(base64, 'base64').toString('binary');

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  // ملف WAV القياسي له header طوله 44 بايت قبل بيانات الصوت الخام
  const dataStart = 44;
  const samples = [];
  for (let i = dataStart; i < bytes.length - 1; i += 2) {
    const sample = (bytes[i + 1] << 8) | bytes[i]; // little-endian, 16-bit
    const signedSample = sample > 32767 ? sample - 65536 : sample;
    samples.push(signedSample / 32768);
  }
  return samples;
}

/**
 * يحسب طاقة RMS الكلية لمقطع صوتي خام كامل.
 * تُستخدم كـ"بوابة طاقة" (Energy Gate) رخيصة الحساب قبل تشغيل نموذج
 * الـ Embedding الأثقل حسابيًا: الصمت التام أو الضوضاء الخافتة جدًا لا
 * تستحق تشغيل النموذج إطلاقًا، فتوفير هذا الفحص المبكر يقلل استهلاك
 * البطارية بشكل ملحوظ أثناء المراقبة المستمرة.
 */
export function computeRMS(samples) {
  if (!samples || samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

/**
 * يحسب درجة التشابه (Cosine Similarity) بين متجهين (مثلاً بين Embedding
 * حي و Embedding مرجعي محفوظ). القيمة بين 0 (مختلف تمامًا) و 1 (متطابق
 * تمامًا). عام تمامًا وغير مرتبط بحجم متجه معيّن.
 */
export function cosineSimilarity(vectorA, vectorB) {
  if (!vectorA || !vectorB) return 0;

  const len = Math.min(vectorA.length, vectorB.length);
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    dotProduct += vectorA[i] * vectorB[i];
    normA += vectorA[i] ** 2;
    normB += vectorB[i] ** 2;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
