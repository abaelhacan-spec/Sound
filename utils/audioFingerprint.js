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
 * باستخدام طريقة Welch (نوافذ متعددة متراكبة + متوسط)، بدلاً من الاكتفاء
 * بأول نافذة FFT فقط. هذا ضروري عندما يكون طول المقطع المسجَّل أكبر من
 * حجم نافذة FFT الواحدة (مثلاً مقطع مدته ثانيتان يحتوي نغمة صوت وفترة
 * صمت)، لأنه يضمن تغطية المقطع بالكامل بدلاً من الاكتفاء بجزء بسيط منه
 * فقط ثم تجاهل الباقي.
 *
 * الطريقة:
 *  - نقسّم العينات إلى نوافذ متتالية بحجم FFT_SIZE مع تراكب 50%
 *  - نطبّق نافذة Hann على كل جزء لتقليل تسرّب الطيف (spectral leakage)
 *  - نحسب FFT لكل نافذة على حدة
 *  - نأخذ متوسط الأطياف الناتجة عبر كل النوافذ
 *
 * النتيجة بصمة واحدة تمثل "متوسط" الصوت عبر المقطع بأكمله، بما يشمل
 * فترات الصوت وفترات الصمت معًا، وهو الأنسب لنمط صوت متكرر (نغمة ثم صمت).
 */
export function extractSpectralFingerprint(samples) {
  const hop = Math.floor(FFT_SIZE / 2); // تراكب 50%
  const hann = new Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  }

  const fft = new FFT(FFT_SIZE);
  const avgMagnitudes = new Array(FFT_SIZE / 2).fill(0);
  let windowCount = 0;

  for (let start = 0; start + FFT_SIZE <= samples.length; start += hop) {
    const windowed = new Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      windowed[i] = samples[start + i] * hann[i];
    }

    const output = fft.createComplexArray();
    fft.realTransform(output, windowed);
    fft.completeSpectrum(output);

    for (let i = 0; i < FFT_SIZE / 2; i++) {
      const real = output[i * 2];
      const imag = output[i * 2 + 1];
      avgMagnitudes[i] += Math.sqrt(real * real + imag * imag);
    }
    windowCount++;
  }

  // احتياط: لو المقطع أقصر من نافذة FFT واحدة، نحلل ما هو متاح فقط
  if (windowCount === 0) {
    const input = new Array(FFT_SIZE).fill(0);
    for (let i = 0; i < Math.min(samples.length, FFT_SIZE); i++) {
      input[i] = samples[i];
    }
    const output = fft.createComplexArray();
    fft.realTransform(output, input);
    fft.completeSpectrum(output);
    for (let i = 0; i < FFT_SIZE / 2; i++) {
      const real = output[i * 2];
      const imag = output[i * 2 + 1];
      avgMagnitudes[i] = Math.sqrt(real * real + imag * imag);
    }
    windowCount = 1;
  }

  const halfSpectrum = avgMagnitudes.map((m) => m / windowCount);

  const maxVal = Math.max(...halfSpectrum, 1e-6);
  return halfSpectrum.map((m) => m / maxVal);
}

/**
 * يحسب طاقة RMS الكلية لمقطع صوتي خام كامل (وليس نافذة واحدة فقط).
 * تُستخدم كـ"بوابة طاقة" (Energy Gate) قبل مطابقة بصمة المنبه: لأن البصمة
 * الترددية تُطبَّع دائمًا (قيمتها القصوى = 1) بغض النظر عن حجم الصوت،
 * فالصمت التام أو الضوضاء الخافتة جدًا قد يُطبَّع رياضيًا بشكل يشبه أي
 * بصمة مرجعية، ما يسبب تطابقات وهمية. حساب الطاقة الفعلية أولًا يمنع هذا.
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

// ─── كشف نبضات الطرق (Knock Onset Detection) ─────────────────────────────

/**
 * يكشف "نبضات صوت مفاجئة وحادة" ضمن مقطع صوتي خام (مناسب لطرق الباب،
 * على عكس FFT الذي يصلح للأصوات المستمرة الثابتة كالمنبه).
 *
 * الفكرة: نقسّم العينات إلى نوافذ زمنية قصيرة جدًا (مثلاً 20 مللي ثانية)،
 * نحسب "طاقة" كل نافذة (RMS)، ثم نبحث عن قفزات حادة ومفاجئة في الطاقة
 * (نافذة أعلى بكثير من متوسط الخلفية الحديثة) — وهذا هو "توقيع" الطرقة
 * الميكانيكية المفاجئة، ويختلف عن الصعود التدريجي في صوت الكلام أو الموسيقى.
 *
 * يرجع عدد النبضات المكتشفة ضمن المقطع بأكمله.
 */
export function detectKnockPulses(samples, sampleRate = 16000, options = {}) {
  const {
    windowMs = 20, // طول كل نافذة تحليل (مللي ثانية)
    energyRatioThreshold = 3.5, // كم ضعف يجب أن تكون الطاقة أعلى من متوسط الخلفية
    minPulseGapMs = 100, // أقل مسافة زمنية بين نبضتين منفصلتين (لتفادي عدّ نفس الطرقة مرتين)
    backgroundWindowCount = 8, // عدد النوافذ السابقة المستخدمة لحساب متوسط "الخلفية"
  } = options;

  const windowSize = Math.floor((windowMs / 1000) * sampleRate);
  if (windowSize <= 0 || samples.length < windowSize) return { pulseCount: 0, pulseTimestamps: [] };

  // حساب طاقة RMS لكل نافذة
  const energies = [];
  for (let start = 0; start + windowSize <= samples.length; start += windowSize) {
    let sumSquares = 0;
    for (let i = start; i < start + windowSize; i++) {
      sumSquares += samples[i] * samples[i];
    }
    energies.push(Math.sqrt(sumSquares / windowSize));
  }

  const pulseTimestamps = [];
  let lastPulseWindowIndex = -Infinity;
  const minGapWindows = Math.ceil(minPulseGapMs / windowMs);

  for (let i = backgroundWindowCount; i < energies.length; i++) {
    // متوسط طاقة الخلفية الحديثة (بدون النافذة الحالية)
    let backgroundSum = 0;
    for (let j = i - backgroundWindowCount; j < i; j++) {
      backgroundSum += energies[j];
    }
    const backgroundAvg = backgroundSum / backgroundWindowCount;

    const isSpike =
      energies[i] > backgroundAvg * energyRatioThreshold && energies[i] > 0.02; // حد أدنى مطلق لتفادي تضخيم ضجيج خافت جدًا

    if (isSpike && i - lastPulseWindowIndex >= minGapWindows) {
      pulseTimestamps.push((i * windowSize) / sampleRate); // بالثواني من بداية المقطع
      lastPulseWindowIndex = i;
    }
  }

  return { pulseCount: pulseTimestamps.length, pulseTimestamps };
}
