import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';

/**
 * يسجل مقطع صوت قصير (WAV, 16kHz, mono) لمدة محددة بالمللي ثانية،
 * ثم يرجع مسار الملف المؤقت.
 *
 * ─── Bug #2 الذي كان موجودًا (مُصلَح هنا) ────────────────────────────────
 * الكود القديم كان يستخدم:
 *   outputFormat: Audio.AndroidOutputFormat.DEFAULT   (= 0)
 *   audioEncoder: Audio.AndroidAudioEncoder.DEFAULT   (= 0)
 *
 * القيمة DEFAULT=0 على Android لا تعني "أفضل جودة" بل تعني حرفيًا:
 *   OutputFormat.DEFAULT → THREE_GPP (حاوية 3GPP) على كثير من الأجهزة
 *   AudioEncoder.DEFAULT → AMR_NB (ترميز صوتي مضغوط)
 *
 * النتيجة: الملف الناتج يحتوي صوتًا مضغوطًا (3GPP/AMR) وليس PCM خامًا،
 * رغم أن اسمه ينتهي بـ ".wav". عندما تحاول readWavAsSamples() قراءته
 * كـ PCM 16-bit من البايت 44، تقرأ بايتات من header 3GPP أو بيانات codec
 * مضغوطة وليس عينات صوتية حقيقية.
 *
 * بما أن header الـ 3GPP ثابتة تقريبًا في كل تسجيل، يرى YAMNet نفس
 * "الصوت المزيف" في كل مرة → embeddings متطابقة → تشابه 100%.
 *
 * ─── الإصلاح ──────────────────────────────────────────────────────────────
 * نستخدم MPEG_4 + AAC على Android مع تفعيل تنسيق PCM الخطي على iOS.
 * لكن المشكلة تبقى: MPEG_4/AAC ليس PCM خامًا أيضًا.
 *
 * ─── الحل الجذري ──────────────────────────────────────────────────────────
 * expo-av (v14) لا يدعم تسجيل PCM خام على Android عبر MediaRecorder.
 * الخيارات:
 *
 * الخيار A (مُطبَّق هنا): استخدام RecordingOptionsPresets.HIGH_QUALITY
 *   على iOS ينتج WAV PCM حقيقيًا.
 *   على Android ينتج AAC/M4A — لكن readWavAsSamples() ستكتشف ذلك وترمي
 *   خطأً واضحًا بدلاً من قراءة بيانات خاطئة بصمت.
 *
 * الخيار B (موصى به للإنتاج): استخدام مكتبة expo-audio (SDK 52+) أو
 *   react-native-audio-recorder-player التي تدعم PCM خامًا على Android.
 *
 * الخيار C (بديل): تسجيل بصيغة AAC/M4A وفك ضغطها باستخدام مكتبة codec.
 *
 * ملاحظة: إذا كان التطبيق يعمل على iOS فقط، الإصلاح في audioFingerprint.js
 * (تحليل WAV header بشكل صحيح) كافٍ وحده لحل مشكلة الـ embeddings المتطابقة.
 */
export async function recordChunk(durationMs = 1000) {
  const recording = new Audio.Recording();

  const recordingOptions = {
    android: {
      // ✅ مُصلَح: بدلاً من DEFAULT الذي ينتج 3GPP/AMR:
      // MPEG_4 + AAC هو التنسيق الأكثر استقرارًا على Android.
      // تحذير: لا يزال صوتًا مضغوطًا، لكن readWavAsSamples() ستكتشف ذلك
      // وترمي خطأً واضحًا (بدلاً من قراءة بيانات خاطئة بصمت كما كان قبلاً).
      // للحصول على PCM حقيقي على Android، انظر الخيار B في التعليق أعلاه.
      extension: '.m4a',
      outputFormat: Audio.AndroidOutputFormat.MPEG_4,
      audioEncoder: Audio.AndroidAudioEncoder.AAC,
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 128000,
    },
    ios: {
      // ✅ iOS: WAV PCM 16-bit حقيقي — هذا هو الإعداد الصحيح
      extension: '.wav',
      audioQuality: Audio.IOSAudioQuality.HIGH,
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 128000,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
    web: {},
  };

  await recording.prepareToRecordAsync(recordingOptions);
  await recording.startAsync();

  await new Promise((resolve) => setTimeout(resolve, durationMs));

  await recording.stopAndUnloadAsync();
  const uri = recording.getURI();
  return uri;
}

export async function deleteTempFile(uri) {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (e) {
    // تجاهل أخطاء الحذف (الملف ممكن يكون اتمسح بالفعل)
  }
}

export async function requestAudioPermission() {
  const { status } = await Audio.requestPermissionsAsync();
  return status === 'granted';
}

export async function configureAudioMode() {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: false,
  });
}
