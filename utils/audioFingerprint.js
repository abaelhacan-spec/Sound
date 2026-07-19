import FFT from 'fft.js';
import * as FileSystem from 'expo-file-system';

// حجم نافذة FFT - لازم تكون قوة 2 (256, 512, 1024, 2048...)
export const FFT_SIZE = 1024;

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
 * يستخرج "البصمة الترددية" (Spectral Fingerprint) من عينات صوتية خام
 * باستخدام Fast Fourier Transform، ثم يطبّع النتيجة كي تكون
 * المقارنة مستقلة عن علو الصوت المطلق.
 */
export function extractSpectralFingerprint(samples) {
  const fft = new FFT(FFT_SIZE);
  const input = new Array(FFT_SIZE).fill(0);

  // نستخدم أول FFT_SIZE عينة فقط من المقطع
  for (let i = 0; i < Math.min(samples.length, FFT_SIZE); i++) {
    input[i] = samples[i];
  }

  const output = fft.createComplexArray();
  fft.realTransform(output, input);
  fft.completeSpectrum(output);

  const magnitudes = [];
  for (let i = 0; i < FFT_SIZE; i += 2) {
    const real = output[i];
    const imag = output[i + 1];
    magnitudes.push(Math.sqrt(real * real + imag * imag));
  }

  // نأخذ فقط النصف الأول (الترددات الموجبة ذات المعنى الفيزيائي)
  const halfSpectrum = magnitudes.slice(0, magnitudes.length / 2);

  const maxVal = Math.max(...halfSpectrum, 1e-6);
  return halfSpectrum.map((m) => m / maxVal);
}

/**
 * يحسب درجة التشابه (Cosine Similarity) بين بصمتين ترددتين.
 * القيمة بين 0 (مختلف تمامًا) و 1 (متطابق تمامًا).
 */
export function cosineSimilarity(fingerprintA, fingerprintB) {
  if (!fingerprintA || !fingerprintB) return 0;

  const len = Math.min(fingerprintA.length, fingerprintB.length);
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    dotProduct += fingerprintA[i] * fingerprintB[i];
    normA += fingerprintA[i] ** 2;
    normB += fingerprintB[i] ** 2;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * يحسب متوسط عدة بصمات (مفيد عند أخذ أكثر من عينة معايرة
 * للحصول على بصمة مرجعية أكثر استقرارًا).
 */
export function averageFingerprints(fingerprints) {
  if (fingerprints.length === 0) return null;
  const len = fingerprints[0].length;
  const avg = new Array(len).fill(0);

  for (const fp of fingerprints) {
    for (let i = 0; i < len; i++) {
      avg[i] += fp[i] / fingerprints.length;
    }
  }
  return avg;
}
