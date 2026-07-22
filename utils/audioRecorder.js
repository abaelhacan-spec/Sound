import { Platform } from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';

// ─── Android: react-native-audio-record ───────────────────────────────────────
// expo-av على Android يستخدم MediaRecorder وهو لا يدعم PCM خاماً أبداً.
// react-native-audio-record تستخدم AudioRecord (API منخفض المستوى) وتنتج
// PCM 16-bit حقيقياً كـ chunks base64 عبر event callbacks.
// نجمع الـ chunks، نبني WAV صحيحاً في الذاكرة، نكتبه لـ cacheDirectory،
// ونُعيد URI — نفس واجهة iOS تماماً، دون تغيير في بقية الكود.
// ─── iOS: expo-av ─────────────────────────────────────────────────────────────
// يُنتج LinearPCM WAV صحيحاً مباشرةً — لا تغيير مطلوب.
// ─────────────────────────────────────────────────────────────────────────────

let AudioRecord = null;
if (Platform.OS === 'android') {
  try {
    AudioRecord = require('react-native-audio-record').default;
  } catch (e) {
    console.error('[audioRecorder] react-native-audio-record غير مثبّتة:', e.message);
  }
}

// ─── بناء WAV header (44 بايت) ────────────────────────────────────────────────
function buildWavHeader(numSamples, sampleRate, channels, bitsPerSample) {
  const dataSize = numSamples * channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44);
  const v = new DataView(buffer);

  const write4 = (offset, str) => {
    for (let i = 0; i < 4; i++) v.setUint8(offset + i, str.charCodeAt(i));
  };

  write4(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  write4(8, 'WAVE');
  write4(12, 'fmt ');
  v.setUint32(16, 16, true);          // fmt chunk size
  v.setUint16(20, 1, true);           // PCM = 1
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  v.setUint16(32, channels * (bitsPerSample / 8), true);
  v.setUint16(34, bitsPerSample, true);
  write4(36, 'data');
  v.setUint32(40, dataSize, true);

  return new Uint8Array(buffer);
}

// ─── تحويل Uint8Array إلى base64 (آمن للمصفوفات الكبيرة) ─────────────────────
function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ─── تسجيل Android عبر react-native-audio-record ────────────────────────────
async function recordChunkAndroid(durationMs) {
  if (!AudioRecord) {
    throw new Error(
      'react-native-audio-record غير متاحة.\n' +
      'شغّل: npm install react-native-audio-record\n' +
      'ثم: npx expo prebuild && npx expo run:android'
    );
  }

  const SAMPLE_RATE = 16000;
  const CHANNELS = 1;
  const BITS = 16;

  AudioRecord.init({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    bitsPerSample: BITS,
    audioSource: 6, // VOICE_RECOGNITION — أفضل لتسجيل الصوت البشري
    // بدون wavFile → streaming mode → لا حاجة لأذونات التخزين
  });

  const pcmChunks = [];
  const subscription = AudioRecord.on('data', (b64) => {
    // كل chunk: سلسلة base64 تمثل bytes من PCM 16-bit signed little-endian
    const binary = atob(b64);
    const chunk = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) chunk[i] = binary.charCodeAt(i);
    pcmChunks.push(chunk);
  });

  AudioRecord.start();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  await AudioRecord.stop();
  subscription.remove();

  // ─── دمج كل الـ chunks في مصفوفة واحدة ──────────────────────────────────
  const totalBytes = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  const pcmBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of pcmChunks) {
    pcmBytes.set(chunk, offset);
    offset += chunk.length;
  }

  if (totalBytes === 0) {
    throw new Error(
      'لم يُستلم أي بيانات صوتية من AudioRecord.\n' +
      'تأكد من منح إذن RECORD_AUDIO.'
    );
  }

  // ─── بناء WAV صحيح في الذاكرة ────────────────────────────────────────────
  const numSamples = totalBytes / (BITS / 8);
  const wavHeader = buildWavHeader(numSamples, SAMPLE_RATE, CHANNELS, BITS);

  const wavBytes = new Uint8Array(44 + totalBytes);
  wavBytes.set(wavHeader, 0);
  wavBytes.set(pcmBytes, 44);

  // ─── كتابة إلى cacheDirectory وإعادة URI ─────────────────────────────────
  const uri = FileSystem.cacheDirectory + `rec_android_${Date.now()}.wav`;
  await FileSystem.writeAsStringAsync(uri, uint8ToBase64(wavBytes), {
    encoding: FileSystem.EncodingType.Base64,
  });

  return uri;
}

// ─── تسجيل iOS عبر expo-av (PCM WAV حقيقي) ──────────────────────────────────
async function recordChunkIOS(durationMs) {
  const recording = new Audio.Recording();

  await recording.prepareToRecordAsync({
    android: {}, // لن يُستخدم
    ios: {
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
  });

  await recording.startAsync();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  await recording.stopAndUnloadAsync();

  return recording.getURI();
}

// ─── الواجهة العامة ───────────────────────────────────────────────────────────

export async function recordChunk(durationMs = 1000) {
  if (Platform.OS === 'android') {
    return recordChunkAndroid(durationMs);
  }
  return recordChunkIOS(durationMs);
}

export async function deleteTempFile(uri) {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (_) {
    // تجاهل — الملف ممكن يكون اتمسح بالفعل
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
