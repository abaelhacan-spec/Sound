import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import CalibrationScreen from './screens/CalibrationScreen';
import MonitoringScreen from './screens/MonitoringScreen';
import { loadAlarmReferenceSamples, loadPhoneNumber, loadDetectionPaths } from './utils/storage';

export default function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [currentScreen, setCurrentScreen] = useState('calibration'); // 'calibration' | 'monitoring'

  useEffect(() => {
    checkExistingSetup();
  }, []);

  async function checkExistingSetup() {
    const referenceSamples = await loadAlarmReferenceSamples();
    const phone = await loadPhoneNumber();
    const { alarmEnabled } = await loadDetectionPaths();

    // الإعداد مكتمل لو فيه رقم هاتف، وعينات مرجعية للمنبه محفوظة (لو مسار المنبه مفعّل فقط)
    const setupComplete = phone && (!alarmEnabled || (referenceSamples && referenceSamples.length > 0));

    if (setupComplete) {
      setCurrentScreen('monitoring');
    } else {
      setCurrentScreen('calibration');
    }
    setIsLoading(false);
  }

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <StatusBar style="light" />
      {currentScreen === 'calibration' ? (
        <CalibrationScreen onCalibrationComplete={() => setCurrentScreen('monitoring')} />
      ) : (
        <MonitoringScreen onBackToSettings={() => setCurrentScreen('calibration')} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
