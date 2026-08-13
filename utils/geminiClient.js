/**
 * ═══ Gemini Client — يُستخدم فقط داخل AI Calibration Lab ═══════════════════
 *
 * قاعدة صارمة: هذا الملف لا يُستورَد إطلاقًا من MonitoringScreen.js أو من
 * أي ملف في مسار المراقبة اليومية (audioRecorder → audioFingerprint →
 * embeddingModel → storage). إذا وجدت استيرادًا لهذا الملف من هناك، فهذا
 * خطأ يجب إصلاحه فورًا لأنه يكسر متطلب "Gemini لا يدخل إطلاقًا في مسار
 * المراقبة اليومية ولا في Production Mode".
 *
 * المفتاح لا يُقرأ هنا مباشرة من التخزين — يُمرَّر كوسيط (parameter) من
 * الشاشة التي تستدعيه (AICalibrationLabScreen)، والتي بدورها تقرأه من
 * secureKeyStore.js فقط عند الحاجة الفعلية للاستدعاء.
 */

// النموذج قابل للتغيير بسهولة هنا دون التأثير على بقية الكود
const GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * يختبر أن المفتاح صالح فعليًا عبر استدعاء بسيط جدًا (رسالة قصيرة)، بدل
 * الاكتفاء بالتحقق من شكل النص فقط. يُستخدم في زر "Test Connection".
 *
 * @returns {Promise<{ ok: boolean, status: 'connected' | 'invalid_key' | 'network_error', message?: string }>}
 */
export async function testGeminiConnection(apiKey) {
  if (!apiKey || apiKey.trim().length === 0) {
    return { ok: false, status: 'not_configured', message: 'لم يتم إدخال مفتاح بعد' };
  }

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey.trim(),
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with the single word: OK' }] }],
      }),
    });

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { ok: false, status: 'invalid_key', message: 'مفتاح Gemini API غير صالح أو مرفوض' };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, status: 'network_error', message: `خطأ من الخادم (${response.status}): ${text.slice(0, 200)}` };
    }

    const data = await response.json();
    const hasContent = !!data?.candidates?.[0]?.content;
    return hasContent
      ? { ok: true, status: 'connected' }
      : { ok: false, status: 'network_error', message: 'استجابة غير متوقعة من Gemini' };
  } catch (err) {
    return { ok: false, status: 'network_error', message: err?.message || 'تعذّر الاتصال بالإنترنت' };
  }
}

/**
 * يرسل ملخص نتائج Local Optimization إلى Gemini ويطلب توصيات منظمة كـ
 * JSON فقط (بدون أي تعديل مباشر على الكود). انظر بند 7-8 من المواصفة.
 *
 * مهم: نُرسل فقط إحصائيات وأرقام مُستخرَجة مسبقًا (features/thresholds/
 * confusion counts) — لا نرسل أي تسجيل صوتي خام إطلاقًا.
 *
 * @param {string} apiKey
 * @param {object} datasetSummary ملخص شامل: إحصائيات، أفضل/أسوأ configurations،
 *   حالات False Positive/Negative، توزيعات features وsimilarity، نتائج validation
 * @returns {Promise<{
 *   recommendations: Array<{ parameter: string, current: number, recommended: number, reason: string }>,
 *   algorithmRecommendations: string[],
 *   confidence: number,
 * }>}
 */
export async function requestGeminiCalibrationAnalysis(apiKey, datasetSummary) {
  if (!apiKey) throw new Error('مفتاح Gemini API غير موجود');

  const systemPrompt = `أنت مهندس معايرة صوتي مساعد لتطبيق كشف أصوات (منبه/طرق باب) على الجوال.
سيُعطى لك ملخص إحصائي فقط (لا صوت خام) عن دورة معايرة محلية شملت: أفضل/أسوأ إعدادات، حالات False Positive/Negative، توزيعات features وsimilarity، نتائج validation.
مهمتك: تفسير أسباب الأخطاء، اقتراح قيم أفضل للمعاملات، وتحديد أنماط تميّز الفئات عن بعضها.
أعطِ وزنًا كبيرًا جدًا لتقليل False Positives لأن الاتصال الوهمي هو أخطر مشكلة في هذا التطبيق.
أعد الإجابة بصيغة JSON فقط، بدون أي نص إضافي قبله أو بعده أو أي Markdown fences، مطابقة تمامًا لهذا الشكل:
{
  "recommendations": [ { "parameter": "string", "current": number, "recommended": number, "reason": "string" } ],
  "algorithmRecommendations": ["string"],
  "confidence": number
}`;

  const userPrompt = `ملخص بيانات المعايرة:\n${JSON.stringify(datasetSummary, null, 2)}`;

  const response = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey.trim(),
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        response_mime_type: 'application/json',
        temperature: 0.2,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Gemini API رفض الطلب (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('لم يُرجِع Gemini أي محتوى قابل للتحليل');

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (_) {
    // احتياطي: لو أضاف النموذج fences رغم التعليمات
    const stripped = rawText.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(stripped);
  }

  if (!Array.isArray(parsed.recommendations)) {
    throw new Error('استجابة Gemini لا تطابق الشكل المتوقَّع (recommendations مفقودة)');
  }

  return {
    recommendations: parsed.recommendations || [],
    algorithmRecommendations: parsed.algorithmRecommendations || [],
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
  };
}
