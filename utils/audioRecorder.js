import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';

/**
 * يسجل مقطع صوت قصير (WAV, 16kHz, mono) لمدة محددة بالمللي ثانية،
 * ثم يرجع مسار الملف المؤقت.
 */
export async function recordChunk(durationMs = 1000) {
  const recording = new Audio.Recording();

  const recordingOptions = {
    android: {
      extension: '.wav',
      outputFormat: Audio.AndroidOutputFormat.DEFAULT,
      audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 128000,
    },
    ios: {
      extension: '.wav',
      audioQuality: Audio.IOSAudioQuality.MEDIUM,
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
