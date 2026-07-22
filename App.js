import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import CalibrationScreen from './screens/CalibrationScreen';
import MonitoringScreen from './screens/MonitoringScreen';
import DiagnosticScreen from './screens/DiagnosticScreen';
import {
  loadAlarmReferenceEmbeddings,
  loadKnockReferenceEmbeddings,
  loadPhoneNumber,
  loadDetectionPaths,
} from './utils/storage';

export default function App() {
  const [isLoading, setIsLoading] = useState(true);
  // أضفنا 'diagnostic' كشاشة ثالثة — يمكن الوصول إليها من شاشة المعايرة
  const [currentScreen, setCurrentScreen] = useState('calibration'); // 'calibration' | 'monitoring' | 'diagnostic'

  useEffect(() => {
    checkExistingSetup();
  }, []);

  async function checkExistingSetup() {
    const alarmEmbeddings = await loadAlarmReferenceEmbeddings();
    const knockEmbeddings = await loadKnockReferenceEmbeddings();
    const phone = await loadPhoneNumber();
    const { alarmEnabled, knockEnabled } = await loadDetectionPaths();

    // الإعداد مكتمل لو فيه رقم هاتف، وكل مسار مفعّل لديه عينات مرجعية محفوظة بالفعل
    const alarmReady = !alarmEnabled || (alarmEmbeddings && alarmEmbeddings.length > 0);
    const knockReady = !knockEnabled || (knockEmbeddings && knockEmbeddings.length > 0);
    const setupComplete = phone && alarmReady && knockReady;

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
        <CalibrationScreen
          onCalibrationComplete={() => setCurrentScreen('monitoring')}
          onOpenDiagnostic={() => setCurrentScreen('diagnostic')}
        />
      ) : currentScreen === 'monitoring' ? (
        <MonitoringScreen onBackToSettings={() => setCurrentScreen('calibration')} />
      ) : (
        <DiagnosticScreen onBack={() => setCurrentScreen('calibration')} />
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
