// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// react-native-fast-tflite requires .tflite to be registered as an asset
// extension, otherwise Metro tries to resolve it as source code and fails
// with "Unable to resolve module ../assets/yamnet.tflite".
config.resolver.assetExts.push('tflite');

module.exports = config;
