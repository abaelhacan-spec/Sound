import * as SecureStore from 'expo-secure-store';

/**
 * ═══ تخزين آمن لمفتاح Gemini API فقط ═══════════════════════════════════════
 *
 * هذا الملف هو المكان الوحيد في المشروع المسموح له بلمس Gemini API Key.
 * قواعد صارمة:
 *   - يُستخدم expo-secure-store حصرًا (Android Keystore / iOS Keychain)،
 *     وليس AsyncStorage إطلاقًا — المفتاح حساس ولا يجوز تخزينه بنص صريح
 *     في تخزين غير مشفّر.
 *   - المفتاح لا يُكتب أبدًا داخل أي console.log/warn/error في هذا الملف
 *     أو أي ملف آخر يستدعيه، لتفادي تسربه عبر crash reports أو logs.
 *   - المفتاح محلي على الجهاز فقط، ولا يُقرأ أو يُصدَّر إلا عند الحاجة
 *     الفعلية لاستدعاء Gemini API من داخل geminiClient.js.
 */

const GEMINI_KEY_STORAGE_KEY = 'gemini_api_key_v1';

export async function saveGeminiApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('مفتاح Gemini API فارغ أو غير صالح');
  }
  await SecureStore.setItemAsync(GEMINI_KEY_STORAGE_KEY, apiKey.trim());
}

export async function loadGeminiApiKey() {
  try {
    return await SecureStore.getItemAsync(GEMINI_KEY_STORAGE_KEY);
  } catch (_) {
    // SecureStore قد يرمي خطأ إذا لم يكن متاحًا على الجهاز (نادر جدًا) —
    // نتعامل معه كأن المفتاح غير موجود بدل تعطيل التطبيق بالكامل
    return null;
  }
}

export async function hasGeminiApiKey() {
  const key = await loadGeminiApiKey();
  return !!key && key.length > 0;
}

/**
 * يحذف المفتاح نهائيًا من SecureStore. تُستدعى عند:
 *   - الضغط على "Delete Gemini API Key" في أي وقت.
 *   - إنهاء جلسة AI Calibration (Finish AI Calibration).
 * لا تحذف هذه الدالة أي بيانات معايرة أو offline configuration — فقط
 * المفتاح نفسه.
 */
export async function deleteGeminiApiKey() {
  await SecureStore.deleteItemAsync(GEMINI_KEY_STORAGE_KEY);
}

/**
 * يُظهر نسخة مخفية من المفتاح للعرض في واجهة المستخدم (مثال: "••••••••1a2b")
 * — يعرض آخر 4 محارف فقط للمساعدة على التمييز بين مفاتيح متعددة، دون كشف
 * المفتاح كاملاً على الشاشة.
 */
export function maskApiKey(apiKey) {
  if (!apiKey) return '';
  const visibleSuffix = apiKey.slice(-4);
  return '•'.repeat(Math.max(8, apiKey.length - 4)) + visibleSuffix;
}
