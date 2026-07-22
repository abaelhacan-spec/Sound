import * as FileSystem from 'expo-file-system';

/**
 * هذا الملف مسؤول فقط عن أدوات عامة لا علاقة لها بأي نموذج معيّن:
 * قراءة ملفات WAV، حساب الطاقة (RMS)، وحساب التشابه بين متجهين (Cosine
 * Similarity) — تُستخدم مع Embeddings من YAMNet بدل البصمات الترددية
 * اليدوية القديمة (FFT)، لكن المنطق الرياضي نفسه صالح لأي متجه رقمي.
 */

/**
 * يُحلّل رأس ملف WAV القياسي بشكل صحيح ويُعيد إزاحة بداية بيانات الصوت الخام.
 *
 * الخطأ السابق: كان الكود يفترض دائمًا أن بيانات الصوت تبدأ من البايت 44
 * (الحجم القياسي لرأس fmt بطول 16 بايت). لكن هذا يكسر في حالتين شائعتين:
 *
 * 1. رأس fmt بطول 18 بايت (مع cbSize=0 extension): تبدأ البيانات من البايت 46.
 *    — شائع جدًا في تسجيلات Android حتى مع الإعدادات الصحيحة.
 *
 * 2. وجود chunks إضافية قبل "data": مثل LIST/INFO أو JUNK أو PAD.
 *    — تضيفها بعض تطبيقات Android لاحتواء metadata أو لأغراض محاذاة الذاكرة.
 *    — في هذه الحالة قد تبدأ البيانات من البايت 72 أو 100 أو أكثر.
 *
 * في كلتا الحالتين: قراءة البيانات من البايت 44 تعني قراءة bytes من metadata
 * أو header وليس من الصوت الفعلي، فيُرسَل إلى YAMNet بيانات ثابتة (دائمًا
 * نفس الـ header bytes) → embeddings متطابقة لكل التسجيلات → تشابه 100%.
 *
 * الإصلاح: نبحث عن مُعرِّف "data" داخل الملف بدلاً من افتراض إزاحة ثابتة.
 *
 * @param {Uint8Array} bytes بايتات الملف كاملة
 * @returns {{ dataOffset: number, sampleRate: number, bitsPerSample: number, channels: number }}
 * @throws {Error} إذا لم يكن الملف WAV PCM صالحاً
 */
function parseWavHeader(bytes) {
  // ─── التحقق من magic bytes ─────────────────────────────────────────────────
  // ملفات WAV تبدأ دائمًا بـ "RIFF" (52 49 46 46)
  // إذا لم تكن كذلك، الملف على الأرجح compressed (3GPP/AMR/AAC) وليس PCM WAV
  if (
    bytes[0] !== 0x52 || bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 || bytes[3] !== 0x46
  ) {
    // ────────────────────────────────────────────────────────────────────────
    // تشخيص Bug #2: Android مع AndroidOutputFormat.DEFAULT ينتج ملف 3GPP/AMR
    // وليس WAV/PCM. البايتات الأولى تكون صندوق ftyp أو header 3GPP.
    // رمز الخطأ: بدلاً من RIFF، نرى 00 00 00 1C فقط أو "ftyp"
    // ────────────────────────────────────────────────────────────────────────
    const firstFour = Array.from(bytes.slice(0, 4))
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
    throw new Error(
      `ملف الصوت ليس WAV/PCM صالحاً (أول 4 بايتات: ${firstFour} بدلاً من "52 49 46 46" = RIFF).\n\n` +
      `هذا يعني أن Android يسجّل بصيغة مضغوطة (3GPP/AMR/AAC) وليس PCM.\n` +
      `الحل: تأكد من إعدادات audioRecorder.js — راجع تعليقات Bug #2.`
    );
  }

  // ─── التحقق من "WAVE" ──────────────────────────────────────────────────────
  if (
    bytes[8] !== 0x57 || bytes[9] !== 0x41 ||
    bytes[10] !== 0x56 || bytes[11] !== 0x45
  ) {
    throw new Error('رأس RIFF ليس من نوع WAVE');
  }

  // ─── استخراج معلومات الـ fmt chunk ────────────────────────────────────────
  // نمشي على الـ chunks بدءًا من البايت 12
  let offset = 12;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let channels = 1;
  let dataOffset = -1;

  while (offset + 8 <= bytes.length) {
    // اسم الـ chunk: 4 أحرف ASCII
    const chunkId =
      String.fromCharCode(bytes[offset]) +
      String.fromCharCode(bytes[offset + 1]) +
      String.fromCharCode(bytes[offset + 2]) +
      String.fromCharCode(bytes[offset + 3]);

    // حجم الـ chunk: little-endian 32-bit
    const chunkSize =
      bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);

    if (chunkSize < 0 || offset + 8 + chunkSize > bytes.length + 1000) {
      // chunk size غير منطقي — نتوقف
      break;
    }

    if (chunkId === 'fmt ') {
      // audioFormat: 1 = PCM, 3 = IEEE float
      const audioFormat = bytes[offset + 8] | (bytes[offset + 9] << 8);
      if (audioFormat !== 1 && audioFormat !== 3) {
        throw new Error(
          `صيغة الصوت غير مدعومة: audioFormat=${audioFormat}. ` +
          `المطلوب: 1 (PCM) أو 3 (IEEE Float).`
        );
      }
      channels = bytes[offset + 10] | (bytes[offset + 11] << 8);
      sampleRate =
        bytes[offset + 12] |
        (bytes[offset + 13] << 8) |
        (bytes[offset + 14] << 16) |
        (bytes[offset + 15] << 24);
      bitsPerSample = bytes[offset + 22] | (bytes[offset + 23] << 8);
    } else if (chunkId === 'data') {
      // ──────────────────────────────────────────────────────────────────────
      // وجدنا chunk "data" — بيانات الصوت الفعلية تبدأ بعد 8 بايتات (اسم + حجم)
      // هذا هو الإصلاح الجوهري: بدلاً من dataStart = 44 (ثابت ومغلوط أحيانًا)،
      // نستخدم الإزاحة الفعلية التي وجدناها بالمسح.
      // ──────────────────────────────────────────────────────────────────────
      dataOffset = offset + 8;
      break;
    }

    // نتقدم إلى الـ chunk التالية (حجم الـ chunk يجب أن يكون زوجيًا)
    offset += 8 + chunkSize + (chunkSize % 2 === 1 ? 1 : 0);
  }

  if (dataOffset === -1) {
    throw new Error(
      'لم يُعثر على chunk "data" في ملف WAV. ' +
      'الملف قد يكون مقتطعًا أو بصيغة غير مدعومة.'
    );
  }

  return { dataOffset, sampleRate, bitsPerSample, channels };
}

/**
 * يحوّل ملف WAV (base64) إلى مصفوفة عينات صوتية مطبّعة (-1 إلى 1).
 * يدعم: WAV PCM 16-bit، mono أو stereo (يأخذ القناة الأولى فقط إذا كان stereo).
 *
 * الإصلاح الجوهري مقارنةً بالنسخة السابقة:
 * - لا يفترض أن البيانات تبدأ من البايت 44 (كان هذا يسبب قراءة header أو
 *   metadata كعينات صوتية، مما يجعل YAMNet يرى نفس البيانات في كل تسجيل).
 * - يُحلّل رأس WAV بشكل صحيح للعثور على chunk "data" الفعلية.
 * - يتحقق من magic bytes للكشف المبكر عن ملفات 3GPP/AMR/AAC المغلوطة.
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

  // ─── تحليل رأس WAV بشكل صحيح ──────────────────────────────────────────────
  const { dataOffset, bitsPerSample, channels } = parseWavHeader(bytes);

  // ─── استخراج العينات ────────────────────────────────────────────────────────
  const samples = [];

  if (bitsPerSample === 16) {
    // PCM 16-bit signed little-endian (الصيغة الأكثر شيوعًا)
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;

    for (let i = dataOffset; i + blockAlign - 1 < bytes.length; i += blockAlign) {
      // القناة الأولى فقط (mono أو القناة اليسرى في stereo)
      const raw = bytes[i] | (bytes[i + 1] << 8);
      const signed = raw > 32767 ? raw - 65536 : raw;
      samples.push(signed / 32768.0);
    }
  } else if (bitsPerSample === 8) {
    // PCM 8-bit unsigned (أقل شيوعًا)
    const blockAlign = channels;
    for (let i = dataOffset; i + blockAlign - 1 < bytes.length; i += blockAlign) {
      samples.push((bytes[i] - 128) / 128.0);
    }
  } else {
    throw new Error(
      `عمق البت ${bitsPerSample} غير مدعوم. المطلوب: 8 أو 16 بت.`
    );
  }

  if (samples.length === 0) {
    throw new Error(
      'لم يُستخرج أي عينة صوتية من الملف. ' +
      `حجم الملف: ${bytes.length} بايت، dataOffset: ${dataOffset}.`
    );
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
