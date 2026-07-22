import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { runDiagnosticTest } from '../utils/diagnosticTest';

/**
 * شاشة الاختبار التشخيصي المستقل لنموذج YAMNet.
 *
 * تضغط "ابدأ الاختبار" ← يُشغَّل النموذج على 4 إشارات اصطناعية (صمت، نغمة،
 * ضربة، ضجيج) دون حاجة لأي تسجيل أو ملف صوتي.
 *
 * هذا يتيح تشخيص ما إذا كانت المشكلة في:
 *   (أ) النموذج نفسه (embeddings متطابقة حتى مع إدخال اصطناعي مختلف)
 *   (ب) خط التسجيل/قراءة WAV (النموذج يعمل لكن الإدخال الحقيقي تالف)
 */
export default function DiagnosticScreen({ onBack }) {
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null); // null | 'passed' | 'failed'
  const scrollRef = useRef(null);

  async function startDiagnostic() {
    setIsRunning(true);
    setLogs([]);
    setResult(null);

    try {
      const { passed } = await runDiagnosticTest((line) => {
        setLogs((prev) => {
          const next = [...prev, line];
          // scroll to bottom
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
          return next;
        });
      });
      setResult(passed ? 'passed' : 'failed');
    } catch (err) {
      setLogs((prev) => [...prev, `\n🔴 خطأ غير متوقع: ${err.message}`]);
      setResult('failed');
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backText}>← رجوع</Text>
        </TouchableOpacity>
        <Text style={styles.title}>🔬 تشخيص النموذج</Text>
      </View>

      <Text style={styles.description}>
        يختبر هذا الفحص نموذج YAMNet مباشرةً بإشارات اصطناعية (صمت، نغمة، ضربة، ضجيج)
        {'\n'}دون أي تسجيل أو قراءة ملف WAV — لتحديد إذا كانت المشكلة في النموذج أم في خط التسجيل.
      </Text>

      {!isRunning && logs.length === 0 && (
        <TouchableOpacity style={styles.startButton} onPress={startDiagnostic}>
          <Text style={styles.startButtonText}>▶ ابدأ الاختبار التشخيصي</Text>
        </TouchableOpacity>
      )}

      {isRunning && (
        <View style={styles.runningRow}>
          <ActivityIndicator color="#60a5fa" />
          <Text style={styles.runningText}>جاري الاختبار... (10-30 ثانية)</Text>
        </View>
      )}

      {result && (
        <View style={[styles.resultBanner, result === 'passed' ? styles.resultPass : styles.resultFail]}>
          {result === 'passed' ? (
            <Text style={styles.resultText}>
              ✅ النموذج يعمل صحيحًا — المشكلة في خط التسجيل/WAV
            </Text>
          ) : (
            <Text style={styles.resultText}>
              🔴 مشكلة في النموذج أو استدعائه — انظر التقرير
            </Text>
          )}
        </View>
      )}

      {logs.length > 0 && (
        <ScrollView
          ref={scrollRef}
          style={styles.logBox}
          contentContainerStyle={styles.logContent}
        >
          {logs.map((line, idx) => (
            <Text key={idx} style={styles.logLine}>{line}</Text>
          ))}
        </ScrollView>
      )}

      {!isRunning && logs.length > 0 && (
        <TouchableOpacity style={styles.retryButton} onPress={startDiagnostic}>
          <Text style={styles.retryText}>🔄 إعادة الاختبار</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingTop: 56,
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  backButton: {
    marginRight: 12,
    padding: 8,
  },
  backText: {
    color: '#60a5fa',
    fontSize: 15,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  description: {
    color: '#94a3b8',
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 20,
    backgroundColor: '#1e293b',
    padding: 12,
    borderRadius: 10,
  },
  startButton: {
    backgroundColor: '#2563eb',
    padding: 18,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  startButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  runningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    gap: 10,
  },
  runningText: {
    color: '#94a3b8',
    fontSize: 14,
    marginLeft: 10,
  },
  resultBanner: {
    padding: 14,
    borderRadius: 10,
    marginBottom: 12,
    alignItems: 'center',
  },
  resultPass: {
    backgroundColor: '#14532d',
    borderWidth: 1,
    borderColor: '#16a34a',
  },
  resultFail: {
    backgroundColor: '#450a0a',
    borderWidth: 1,
    borderColor: '#dc2626',
  },
  resultText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  logBox: {
    flex: 1,
    backgroundColor: '#020617',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 12,
  },
  logContent: {
    padding: 12,
  },
  logLine: {
    color: '#94a3b8',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 17,
  },
  retryButton: {
    padding: 14,
    alignItems: 'center',
    marginBottom: 8,
  },
  retryText: {
    color: '#60a5fa',
    fontSize: 14,
  },
});
