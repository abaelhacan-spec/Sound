import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  TextInput,
  ScrollView,
} from 'react-native';
import {
  recordChunk,
  deleteTempFile,
  requestAudioPermission,
  configureAudioMode,
} from '../utils/audioRecorder';
import { readWavAsSamples, computeRMS, computeEnvelope } from '../utils/audioFingerprint';
import { loadEmbeddingModel, extractEmbedding } from '../utils/embeddingModel';
import {
  loadAlarmReferenceEmbeddings,
  loadKnockReferenceEmbeddings,
  loadAlarmSimilarityThreshold,
  loadKnockSimilarityThreshold,
  loadEnergyGateRms,
  loadKnockPulseConfig,
  loadOfflineAudioConfig,
  applyOfflineAudioConfig,
  saveOfflineAudioConfig,
} from '../utils/storage';
import {
  saveGeminiApiKey,
  loadGeminiApiKey,
  deleteGeminiApiKey,
  maskApiKey,
} from '../utils/secureKeyStore';
import { testGeminiConnection, requestGeminiCalibrationAnalysis } from '../utils/geminiClient';
import {
  splitDataset,
  evaluateConfig,
  runLocalGridSearch,
  checkOverfitting,
  buildGeminiDatasetSummary,
  computeRawFeatureDiagnostics,
} from '../utils/calibrationEngine';

// ─── أهداف حجم Dataset لكل فئة (بند 4 من المواصفة) ─────────────────────────
const DATASET_TARGETS = { alarm: 20, knock: 20, other: 30 };
const MIN_USABLE = { alarm: 10, knock: 10, other: 15 }; // حد أدنى للسماح بتشغيل Local Optimization حتى قبل بلوغ الهدف الكامل
const CHUNK_MS = 2000; // نفس مدة تسجيل عينات المعايرة العادية والمراقبة الحية — نفس الـ pipeline تمامًا
const MIN_RECALL_FLOOR = 0.5; // الحد الأدنى المقبول للـ Recall لـ alarm وknock (قابل للتعديل من واجهة المستخدم لاحقًا)
const MIN_ADOPTABLE_F1 = 0.5; // زر "اعتماد" يُعطَّل تلقائيًا تحت هذا الحد

const LABELS = {
  alarm: { title: '🔔 ALARM', hint: 'صوت منبه حقيقي — بمسافات وشدّات وأوضاع هاتف مختلفة' },
  knock: { title: '🚪 KNOCK', hint: 'طرقات باب حقيقية — ضعيفة وقوية ومتعددة وبسرعات مختلفة' },
  other: { title: '🌫️ OTHER', hint: 'بيئة حقيقية: صمت، ضجيج رواق، كلام، خطوات، إغلاق أبواب، سقوط أشياء...' },
};

/** يُنسّق رقمًا للعرض التشخيصي فقط — لا علاقة له بأي منطق قرار. null/undefined → '—' */
function fmtNum(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(decimals);
}

/** صف واحد من إحصائيات Raw لميزة واحدة (alarmSim/knockSim/pulseCount) — عرض فقط */
function RawStatsRow({ name, stats }) {
  const decimals = name === 'pulseCount' ? 0 : 2;
  if (!stats || stats.count === 0) {
    return (
      <View style={styles.diagStatsRow}>
        <Text style={styles.diagFeatureName}>{name}</Text>
        <Text style={styles.hint}>لا توجد قيم صالحة (N={stats?.count ?? 0}, invalid={stats?.invalidCount ?? 0})</Text>
      </View>
    );
  }
  return (
    <View style={styles.diagStatsRow}>
      <Text style={styles.diagFeatureName}>
        {name} (N={stats.count}{stats.invalidCount > 0 ? `, invalid=${stats.invalidCount}` : ''})
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={true}>
        <View style={styles.diagStatsValuesRow}>
          {[
            ['Min', stats.min],
            ['P10', stats.p10],
            ['P25', stats.p25],
            ['Median', stats.median],
            ['P75', stats.p75],
            ['P90', stats.p90],
            ['Max', stats.max],
            ['Mean', stats.mean],
          ].map(([label, value]) => (
            <View key={label} style={styles.diagStatCell}>
              <Text style={styles.diagStatCellLabel}>{label}</Text>
              <Text style={styles.diagStatCellValue}>{fmtNum(value, decimals)}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export default function AICalibrationLabScreen({ onBack }) {
  // ── Gemini API Configuration ──────────────────────────────────────────
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [savedKeyMasked, setSavedKeyMasked] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('not_configured'); // not_configured | testing | connected | invalid_key | network_error
  const [connectionMessage, setConnectionMessage] = useState('');

  // ── Dataset جمع العينات ────────────────────────────────────────────────
  const [dataset, setDataset] = useState({ alarm: [], knock: [], other: [] });
  const [recordingCategory, setRecordingCategory] = useState(null); // 'alarm' | 'knock' | 'other' | null
  const modelRef = useRef(null);

  // ── مراجع الإنتاج الحالية (من CalibrationScreen العادية) ────────────────
  const [productionRefs, setProductionRefs] = useState({ alarm: null, knock: null });
  const [currentConfig, setCurrentConfig] = useState(null); // العتبات/المعاملات المحفوظة حاليًا كخط أساس (Before)

  // ── Local Optimization ────────────────────────────────────────────────
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [topConfigs, setTopConfigs] = useState(null); // Top N بعد الفلترة (لجدول المقارنة)
  const [calibrationEvalResult, setCalibrationEvalResult] = useState(null); // أفضل واحدة (topConfigs[0])
  const [validationEvalResult, setValidationEvalResult] = useState(null);
  const [overfitting, setOverfitting] = useState(null);
  const [metRecallFloor, setMetRecallFloor] = useState(true);
  const validationSetRef = useRef([]); // يُحفظ من آخر تشغيل لـ Local Optimization لاستخدامه في جدول Top 5

  // ── Gemini Analysis ────────────────────────────────────────────────────
  const [isConsultingGemini, setIsConsultingGemini] = useState(false);
  const [geminiRecommendations, setGeminiRecommendations] = useState(null);
  const [geminiConfidence, setGeminiConfidence] = useState(null);
  const [appliedOverrides, setAppliedOverrides] = useState({}); // { paramName: recommendedValue }
  const [retestResult, setRetestResult] = useState(null); // { before, after }

  const [status, setStatus] = useState('ابدأ بجمع عينات ALARM وKNOCK وOTHER الحقيقية من بيئتك.');

  // ── Raw Dataset Diagnostics (تشخيصي بحت — لا يؤثر على أي قرار تصنيف) ──
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);

  useEffect(() => {
    (async () => {
      const [alarmRefs, knockRefs, alarmT, knockT, energyGate, pulseCfg, key] = await Promise.all([
        loadAlarmReferenceEmbeddings(),
        loadKnockReferenceEmbeddings(),
        loadAlarmSimilarityThreshold(),
        loadKnockSimilarityThreshold(),
        loadEnergyGateRms(),
        loadKnockPulseConfig(),
        loadGeminiApiKey(),
      ]);
      setProductionRefs({ alarm: alarmRefs || [], knock: knockRefs || [] });
      setCurrentConfig({
        energyGate,
        alarm: { similarityThreshold: alarmT },
        knock: { similarityThreshold: knockT, ...pulseCfg },
      });
      if (key) {
        setSavedKeyMasked(maskApiKey(key));
        setConnectionStatus('connected'); // متوفر ولم يُختبر بعد فعليًا في هذه الجلسة — يُعاد التحقق عند الضغط على Test
        setConnectionMessage('مفتاح محفوظ مسبقًا — اضغط Test Connection للتأكد أنه لا يزال صالحًا');
      }
    })();
  }, []);

  // ═══════════════════════════════════════════════════════════════════════
  // ═══ Gemini API Key ═══════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  async function handleSaveApiKey() {
    if (!apiKeyInput || apiKeyInput.trim().length < 10) {
      Alert.alert('تنبيه', 'أدخل مفتاح Gemini API صالحًا أولًا');
      return;
    }
    try {
      await saveGeminiApiKey(apiKeyInput.trim());
      setSavedKeyMasked(maskApiKey(apiKeyInput.trim()));
      setApiKeyInput('');
      setConnectionStatus('not_configured');
      setConnectionMessage('تم الحفظ محليًا وبأمان (SecureStore). اضغط Test Connection للتحقق.');
    } catch (err) {
      Alert.alert('خطأ', 'تعذّر حفظ المفتاح: ' + err.message);
    }
  }

  async function handleTestConnection() {
    setConnectionStatus('testing');
    setConnectionMessage('');
    const key = await loadGeminiApiKey();
    if (!key) {
      setConnectionStatus('not_configured');
      setConnectionMessage('لا يوجد مفتاح محفوظ بعد');
      return;
    }
    const result = await testGeminiConnection(key);
    setConnectionStatus(result.status);
    setConnectionMessage(result.message || (result.ok ? 'الاتصال ناجح ✅' : ''));
  }

  async function handleDeleteApiKey() {
    Alert.alert('حذف مفتاح Gemini', 'سيُحذف المفتاح فورًا من الجهاز. بيانات المعايرة والإعداد النهائي Offline لن يتأثرا.', [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'حذف',
        style: 'destructive',
        onPress: async () => {
          await deleteGeminiApiKey();
          setSavedKeyMasked('');
          setConnectionStatus('not_configured');
          setConnectionMessage('');
          setGeminiRecommendations(null);
          setGeminiConfidence(null);
          setAppliedOverrides({});
          setRetestResult(null);
          setStatus('تم حذف مفتاح Gemini API. النظام يعمل الآن Offline بالكامل.');
        },
      },
    ]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══ جمع عينات Dataset ════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  async function getModel() {
    if (!modelRef.current) modelRef.current = await loadEmbeddingModel();
    return modelRef.current;
  }

  async function handleRecordDatasetSample(category) {
    const hasPermission = await requestAudioPermission();
    if (!hasPermission) {
      Alert.alert('صلاحية مطلوبة', 'التطبيق يحتاج صلاحية المايكروفون للعمل');
      return;
    }

    try {
      setRecordingCategory(category);
      setStatus(`🔴 جاري تسجيل عينة ${LABELS[category].title}...`);

      const model = await getModel();
      await configureAudioMode();
      const uri = await recordChunk(CHUNK_MS);
      const samples = await readWavAsSamples(uri);
      await deleteTempFile(uri);

      if (!samples || samples.length === 0) throw new Error('ملف الصوت فارغ');

      // ── نفس الـ pipeline الموجود في Production بالضبط: نفس دوال
      //    readWavAsSamples/computeRMS/computeEnvelope/extractEmbedding ──
      const rms = computeRMS(samples);
      const envelope = computeEnvelope(samples, 16000);
      const embedding = await extractEmbedding(samples, model);

      const sample = { id: `${category}_${Date.now()}`, label: category, embedding, rms, envelope };
      setDataset((prev) => ({ ...prev, [category]: [...prev[category], sample] }));
      setStatus(
        `✅ تم إضافة عينة ${LABELS[category].title} (${dataset[category].length + 1}/${DATASET_TARGETS[category]})`
      );
    } catch (err) {
      Alert.alert('خطأ في التسجيل', err.message);
    } finally {
      setRecordingCategory(null);
    }
  }

  function handleClearCategory(category) {
    Alert.alert('مسح العينات', `سيُمسح كل عينات ${LABELS[category].title} المجمّعة في هذه الجلسة فقط.`, [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'مسح', style: 'destructive', onPress: () => setDataset((prev) => ({ ...prev, [category]: [] })) },
    ]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══ Local Optimization ═══════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  function buildFullDataset() {
    return [...dataset.alarm, ...dataset.knock, ...dataset.other];
  }

  async function handleRunLocalOptimization() {
    if (!productionRefs.alarm || productionRefs.alarm.length === 0 || !productionRefs.knock || productionRefs.knock.length === 0) {
      Alert.alert(
        'إعداد ناقص',
        'لازم تُكمل المعايرة العادية أولًا (شاشة الإعداد الرئيسية) لأن AI Calibration Lab يختبر تحسينات على مراجعك المعتمدة، لا يستبدلها.'
      );
      return;
    }
    for (const cat of ['alarm', 'knock', 'other']) {
      if (dataset[cat].length < MIN_USABLE[cat]) {
        Alert.alert(
          'Dataset غير كافٍ',
          `تحتاج ${MIN_USABLE[cat]} عينة على الأقل من ${LABELS[cat].title} (الهدف المثالي ${DATASET_TARGETS[cat]}). لديك حاليًا ${dataset[cat].length}.`
        );
        return;
      }
    }

    setIsOptimizing(true);
    setStatus('⚙️ جاري تشغيل Local Optimization (بحث شبكي محلي بلا إنترنت)...');
    try {
      const full = buildFullDataset();
      const splitResult = splitDataset(full, 0.7);
      // Defensive check: لو splitDataset لأي سبب لم تُرجع الشكل المتوقَّع
      if (!splitResult || !Array.isArray(splitResult.calibrationSet) || !Array.isArray(splitResult.validationSet)) {
        throw new Error('splitDataset لم تُرجع calibrationSet/validationSet بالشكل المتوقَّع');
      }
      const { calibrationSet, validationSet } = splitResult;
      validationSetRef.current = validationSet;

      const gridSearchOutput = runLocalGridSearch(
        calibrationSet,
        productionRefs.alarm,
        productionRefs.knock,
        {},
        10,
        MIN_RECALL_FLOOR
      );
      // Defensive check: runLocalGridSearch يجب أن تُرجع دائمًا { results, metRecallFloor }
      // — هذا الفحص يحوّل أي خلل توافق مستقبلي إلى رسالة خطأ واضحة بدل
      // انهيار محرك JS المبهم "Cannot convert undefined value to object"
      // الذي يحدث عند محاولة destructuring نتيجة undefined.
      if (!gridSearchOutput || !Array.isArray(gridSearchOutput.results)) {
        throw new Error('runLocalGridSearch لم تُرجع { results, metRecallFloor } كما هو متوقَّع — تحقق من توافق نسخة calibrationEngine.js');
      }
      const { results, metRecallFloor: floorMet } = gridSearchOutput;

      if (results.length === 0) {
        setTopConfigs([]);
        setCalibrationEvalResult(null);
        setValidationEvalResult(null);
        setOverfitting(null);
        setMetRecallFloor(false);
        setStatus('⚠️ لم يُنتِج البحث الشبكي أي configuration قابلة للتقييم. تحقّق من أن Dataset يحتوي فعليًا على عينات alarm/knock/other صالحة.');
        return;
      }

      const best = results[0];
      if (!best || !best.config) {
        throw new Error('أفضل configuration المُعادة من runLocalGridSearch لا تحتوي على config صالح');
      }

      const validationResult = evaluateConfig(validationSet, productionRefs.alarm, productionRefs.knock, best.config);
      const overfit = checkOverfitting(best, validationResult);

      setTopConfigs(results);
      setCalibrationEvalResult(best);
      setValidationEvalResult(validationResult);
      setOverfitting(overfit);
      setMetRecallFloor(floorMet);

      if (!floorMet) {
        setStatus(
          `⚠️ لم تنجح أي configuration في تحقيق حد أدنى Recall=${MIN_RECALL_FLOOR} لكل من ALARM وKNOCK. النتيجة المعروضة هي الأفضل المتاحة فقط — يُنصح بجمع عينات إيجابية أكثر أو تخفيف نطاق البحث بدل اعتمادها مباشرة.`
        );
      } else if (overfit.isOverfitting) {
        setStatus('⚠️ اكتمل البحث المحلي — لكن هناك مؤشر Possible Overfitting، راجع النتائج بعناية');
      } else {
        setStatus('✅ اكتمل البحث المحلي — راجع الجدول والنتائج أدناه قبل الاعتماد');
      }
    } catch (err) {
      Alert.alert('خطأ', 'فشل Local Optimization: ' + err.message);
      setStatus('❌ فشل Local Optimization: ' + err.message);
    } finally {
      setIsOptimizing(false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══ Gemini Analysis ══════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  async function handleConsultGemini() {
    if (!calibrationEvalResult) {
      Alert.alert('تنبيه', 'شغّل Local Optimization أولًا — Gemini يحلّل نتائجه، ولا يبدأ من الصفر');
      return;
    }
    const key = await loadGeminiApiKey();
    if (!key) {
      Alert.alert('تنبيه', 'أدخل واحفظ مفتاح Gemini API أولًا في الأعلى');
      return;
    }

    setIsConsultingGemini(true);
    setStatus('🤖 جاري إرسال الإحصائيات (بدون أي صوت خام) إلى Gemini للتحليل...');
    try {
      const summary = buildGeminiDatasetSummary({
        dataset: buildFullDataset(),
        gridResults: topConfigs,
        calibrationResult: calibrationEvalResult,
        validationResult: validationEvalResult,
        overfitting,
        metRecallFloor,
      });
      const analysis = await requestGeminiCalibrationAnalysis(key, summary);
      setGeminiRecommendations(analysis.recommendations.map((r) => ({ ...r, decision: null })));
      setGeminiConfidence(analysis.confidence);
      setStatus(`✅ استلمت ${analysis.recommendations.length} توصية من Gemini. راجعها واختبرها قبل الاعتماد.`);
    } catch (err) {
      Alert.alert('خطأ في تحليل Gemini', err.message);
      setStatus('⚠️ فشل تحليل Gemini — يمكنك الاستمرار بنتائج Local Optimization وحدها');
    } finally {
      setIsConsultingGemini(false);
    }
  }

  function applyRecommendation(rec) {
    setAppliedOverrides((prev) => ({ ...prev, [rec.parameter]: rec.recommended }));
    setGeminiRecommendations((prev) => prev.map((r) => (r.parameter === rec.parameter ? { ...r, decision: 'applied' } : r)));
  }

  function rejectRecommendation(rec) {
    setAppliedOverrides((prev) => {
      const next = { ...prev };
      delete next[rec.parameter];
      return next;
    });
    setGeminiRecommendations((prev) => prev.map((r) => (r.parameter === rec.parameter ? { ...r, decision: 'rejected' } : r)));
  }

  /** يبني configuration جديدة من أفضل نتيجة محلية + أي overrides مؤقتة من Gemini مُطبَّقة */
  function buildCandidateConfig() {
    const base = calibrationEvalResult.config;
    const candidate = JSON.parse(JSON.stringify(base));
    for (const [param, value] of Object.entries(appliedOverrides)) {
      if (param === 'alarmSimilarityThreshold') candidate.alarm.similarityThreshold = value;
      else if (param === 'knockSimilarityThreshold') candidate.knock.similarityThreshold = value;
      else if (param === 'energyGate') candidate.energyGate = value;
      else if (candidate.knock[param] !== undefined) candidate.knock[param] = value;
    }
    return candidate;
  }

  /** بند 9: أي توصية تُطبَّق مؤقتًا فقط، ثم يُعاد تشغيل Dataset بالكامل ويُعرض Before/After */
  async function handleRetest() {
    if (!calibrationEvalResult || !validationEvalResult) return;
    const candidate = buildCandidateConfig();
    const full = buildFullDataset();
    const afterResult = evaluateConfig(full, productionRefs.alarm, productionRefs.knock, candidate);
    const beforeResult = evaluateConfig(full, productionRefs.alarm, productionRefs.knock, currentConfig);
    setRetestResult({ before: beforeResult, after: afterResult, candidate });
    setStatus('🔁 تم إعادة الاختبار على كل Dataset. قارن Before/After أدناه قبل الاعتماد.');
  }

  async function handleAdoptConfiguration(configToAdopt, sourceLabel) {
    Alert.alert('اعتماد الإعداد', `سيُحفظ هذا الإعداد كإعداد Offline نهائي (${sourceLabel}). هل أنت متأكد؟`, [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'اعتماد',
        onPress: async () => {
          const finalConfig = {
            version: 1,
            mode: 'offline',
            alarm: { similarityThreshold: configToAdopt.alarm.similarityThreshold },
            knock: {
              similarityThreshold: configToAdopt.knock.similarityThreshold,
              minPulses: configToAdopt.knock.minPulses,
              maxPulses: configToAdopt.knock.maxPulses,
              minAttackSharpness: configToAdopt.knock.minAttackSharpness,
              energyRatioThreshold: configToAdopt.knock.energyRatioThreshold,
              minAbsRms: configToAdopt.knock.minAbsRms,
              minPulseGapMs: configToAdopt.knock.minPulseGapMs,
            },
            energyGate: configToAdopt.energyGate,
          };
          await applyOfflineAudioConfig(finalConfig);
          await saveOfflineAudioConfig(finalConfig);
          setCurrentConfig(configToAdopt);
          setStatus('✅ تم اعتماد الإعداد النهائي. المراقبة الحية ستستخدمه من الآن فصاعدًا (بدون أي Gemini).');
          Alert.alert('تم الاعتماد', 'الإعداد النهائي محفوظ الآن ويُستخدم في المراقبة الفعلية.');
        },
      },
    ]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══ إنهاء الجلسة ═════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  async function handleFinishAiCalibration() {
    const offline = await loadOfflineAudioConfig();
    if (!offline) {
      Alert.alert('لا يوجد إعداد نهائي', 'اعتمد configuration واحدة على الأقل (من Local Optimization أو بعد Retest) قبل إنهاء الجلسة.');
      return;
    }

    Alert.alert(
      'إنهاء AI Calibration',
      `ملخص:\nALARM threshold: ${offline.alarm.similarityThreshold}\nKNOCK threshold: ${offline.knock.similarityThreshold}\nEnergy gate: ${offline.energyGate}\n\nسيُحذف مفتاح Gemini API نهائيًا وسيعمل Sound Monitor Offline بالكامل. متابعة؟`,
      [
        { text: 'إلغاء', style: 'cancel' },
        {
          text: 'إنهاء وحذف المفتاح',
          style: 'destructive',
          onPress: async () => {
            await deleteGeminiApiKey();
            setSavedKeyMasked('');
            setConnectionStatus('not_configured');
            setConnectionMessage('');
            setGeminiRecommendations(null);
            setGeminiConfidence(null);
            setAppliedOverrides({});
            setRetestResult(null);
            Alert.alert(
              'تم',
              'AI Calibration completed. Gemini API Key has been deleted. Sound Monitor is now running Offline.'
            );
          },
        },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══ العرض ═══════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  // ── Raw Dataset Diagnostics: قراءة/تلخيص فقط — لا تُستخدم في أي قرار.
  //    تُحسَب من نفس dataset ونفس productionRefs المستخدمَين في Local
  //    Optimization، وبنفس معاملات استخراج pulseCount الحالية المحفوظة
  //    (currentConfig.knock)، دون تطبيق أي threshold أو energyGate عليها. ──
  const rawDiagnostics = useMemo(() => {
    const fullDataset = [...dataset.alarm, ...dataset.knock, ...dataset.other];
    if (fullDataset.length === 0) return null;
    const pulseParams = currentConfig?.knock
      ? {
          energyRatioThreshold: currentConfig.knock.energyRatioThreshold,
          minAbsRms: currentConfig.knock.minAbsRms,
          minPulseGapMs: currentConfig.knock.minPulseGapMs,
        }
      : {};
    return computeRawFeatureDiagnostics(fullDataset, productionRefs.alarm || [], productionRefs.knock || [], pulseParams);
  }, [dataset, productionRefs, currentConfig]);

  const statusColors = {
    not_configured: '#888',
    testing: '#60a5fa',
    connected: '#4ade80',
    invalid_key: '#f87171',
    network_error: '#facc15',
  };
  const statusLabels = {
    not_configured: 'Not configured',
    testing: 'جاري الاختبار...',
    connected: 'Connected',
    invalid_key: 'Invalid API Key',
    network_error: 'خطأ شبكة',
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>🧪 AI Calibration Lab</Text>
      <Text style={styles.subtitle}>
        Gemini يُستخدم هنا مؤقتًا فقط كمساعد معايرة. المراقبة اليومية دائمًا Offline بالكامل ولا تستدعي Gemini إطلاقًا.
      </Text>

      {/* ── Gemini API Configuration ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Gemini API Configuration</Text>

        {savedKeyMasked ? (
          <Text style={styles.maskedKey}>المفتاح المحفوظ: {savedKeyMasked}</Text>
        ) : (
          <TextInput
            style={styles.input}
            value={apiKeyInput}
            onChangeText={setApiKeyInput}
            placeholder="الصق مفتاح Gemini API هنا"
            placeholderTextColor="#888"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}

        <View style={styles.row}>
          {!savedKeyMasked && (
            <TouchableOpacity style={styles.smallButton} onPress={handleSaveApiKey}>
              <Text style={styles.buttonText}>💾 حفظ المفتاح</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.smallButton} onPress={handleTestConnection} disabled={connectionStatus === 'testing'}>
            {connectionStatus === 'testing' ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>🔌 Test Connection</Text>}
          </TouchableOpacity>
        </View>

        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: statusColors[connectionStatus] }]} />
          <Text style={[styles.statusText, { color: statusColors[connectionStatus] }]}>{statusLabels[connectionStatus]}</Text>
        </View>
        {!!connectionMessage && <Text style={styles.hint}>{connectionMessage}</Text>}

        {savedKeyMasked && (
          <TouchableOpacity style={styles.dangerButton} onPress={handleDeleteApiKey}>
            <Text style={styles.buttonText}>🗑️ Delete API Key</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── جمع Dataset ── */}
      {['alarm', 'knock', 'other'].map((cat) => (
        <View style={styles.section} key={cat}>
          <Text style={styles.sectionTitle}>{LABELS[cat].title}</Text>
          <Text style={styles.hint}>{LABELS[cat].hint}</Text>
          <Text style={styles.progress}>
            {dataset[cat].length} / {DATASET_TARGETS[cat]} عينة
          </Text>
          <View style={styles.row}>
            <TouchableOpacity
              style={styles.smallButton}
              onPress={() => handleRecordDatasetSample(cat)}
              disabled={recordingCategory !== null}
            >
              {recordingCategory === cat ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>🎙️ تسجيل عينة</Text>}
            </TouchableOpacity>
            {dataset[cat].length > 0 && (
              <TouchableOpacity style={styles.smallSecondaryButton} onPress={() => handleClearCategory(cat)}>
                <Text style={styles.secondaryButtonText}>مسح</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      ))}

      {/* ── Raw Dataset Diagnostics (تشخيصي بحت — لا يغيّر أي threshold أو قرار) ── */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.diagnosticsHeader} onPress={() => setDiagnosticsExpanded((v) => !v)}>
          <View>
            <Text style={styles.sectionTitle}>🔬 Raw Dataset Diagnostics</Text>
            <Text style={styles.hint}>Values before thresholds / gates</Text>
          </View>
          <Text style={styles.diagnosticsToggle}>{diagnosticsExpanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>

        {diagnosticsExpanded && (
          <>
            {!rawDiagnostics ? (
              <Text style={styles.hint}>لا توجد عينات مجمَّعة بعد — سجّل عينات ALARM/KNOCK/OTHER أولًا.</Text>
            ) : (
              <View style={styles.resultBox}>
                <Text style={styles.resultTitle}>Samples</Text>
                <Text style={styles.resultLine}>ALARM: {rawDiagnostics.sampleCounts.alarm}</Text>
                <Text style={styles.resultLine}>KNOCK: {rawDiagnostics.sampleCounts.knock}</Text>
                <Text style={styles.resultLine}>OTHER: {rawDiagnostics.sampleCounts.other}</Text>

                <Text style={styles.resultSubtitle}>Raw Feature Range (كل العينات مجتمعة):</Text>
                <Text style={styles.resultLine}>
                  alarmSim: {fmtNum(rawDiagnostics.overallRange.alarmSim.min)} → {fmtNum(rawDiagnostics.overallRange.alarmSim.max)}
                </Text>
                <Text style={styles.resultLine}>
                  knockSim: {fmtNum(rawDiagnostics.overallRange.knockSim.min)} → {fmtNum(rawDiagnostics.overallRange.knockSim.max)}
                </Text>
                <Text style={styles.resultLine}>
                  pulseCount: {fmtNum(rawDiagnostics.overallRange.pulseCount.min, 0)} → {fmtNum(rawDiagnostics.overallRange.pulseCount.max, 0)}
                </Text>

                {['alarm', 'knock', 'other'].map((label) => (
                  <View key={label} style={styles.diagnosticsLabelBlock}>
                    <Text style={styles.resultSubtitle}>{label.toUpperCase()}</Text>
                    {['alarmSim', 'knockSim', 'pulseCount'].map((feature) => (
                      <RawStatsRow key={feature} name={feature} stats={rawDiagnostics.byLabel[label][feature]} />
                    ))}
                  </View>
                ))}

                <Text style={styles.resultSubtitle}>Invalid</Text>
                <Text style={styles.resultLine}>alarmSim: {rawDiagnostics.invalidCounts.alarmSim}</Text>
                <Text style={styles.resultLine}>knockSim: {rawDiagnostics.invalidCounts.knockSim}</Text>
                <Text style={styles.resultLine}>pulseCount: {rawDiagnostics.invalidCounts.pulseCount}</Text>
              </View>
            )}
          </>
        )}
      </View>

      {/* ── Local Optimization ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>⚙️ Local Optimization</Text>
        <Text style={styles.hint}>
          بحث شبكي محلي بلا إنترنت — الهدف الأساسي هو أفضل توازن بين اكتشاف الأصوات الحقيقية ورفض الضوضاء (targetF1)،
          وليس فقط تقليل False Positives. أي configuration يفشل تحت Recall={MIN_RECALL_FLOOR} لـ ALARM أو KNOCK يُستبعد تلقائيًا من الترتيب.
        </Text>
        <TouchableOpacity style={styles.button} onPress={handleRunLocalOptimization} disabled={isOptimizing}>
          {isOptimizing ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>▶️ تشغيل Local Optimization</Text>}
        </TouchableOpacity>

        {calibrationEvalResult && validationEvalResult && (
          <View style={styles.resultBox}>
            {!metRecallFloor && (
              <Text style={styles.warningText}>
                ⚠️ لم تنجح أي configuration في تحقيق الحد الأدنى للـ Recall — هذه أفضل نتيجة متاحة فقط، وليست بالضرورة عملية.
              </Text>
            )}

            <Text style={styles.resultTitle}>أفضل Configuration (Calibration Set)</Text>
            <Text style={styles.resultLine}>ALARM threshold: {calibrationEvalResult.config.alarm.similarityThreshold}</Text>
            <Text style={styles.resultLine}>KNOCK threshold: {calibrationEvalResult.config.knock.similarityThreshold}</Text>
            <Text style={styles.resultLine}>Energy gate: {calibrationEvalResult.config.energyGate}</Text>

            {/* ── Precision/Recall/F1 منفصلة لكل فئة (بدل FP/FN فقط) ── */}
            <Text style={styles.resultSubtitle}>لكل فئة (Calibration Set):</Text>
            {['alarm', 'knock', 'other'].map((c) => (
              <Text style={styles.resultLine} key={c}>
                {c.toUpperCase()} — P: {calibrationEvalResult.perClass[c].precision.toFixed(2)} | R:{' '}
                {calibrationEvalResult.perClass[c].recall.toFixed(2)} | F1: {calibrationEvalResult.perClass[c].f1.toFixed(2)}
              </Text>
            ))}
            <Text style={styles.resultLine}>Target F1 (alarm+knock): {calibrationEvalResult.targetF1.toFixed(2)}</Text>

            {/* ── Confusion Matrix ── */}
            <Text style={styles.resultSubtitle}>Confusion Matrix (الحقيقة → التنبؤ):</Text>
            <View style={styles.matrixHeaderRow}>
              <Text style={styles.matrixCellHeader}> </Text>
              <Text style={styles.matrixCellHeader}>ALARM</Text>
              <Text style={styles.matrixCellHeader}>KNOCK</Text>
              <Text style={styles.matrixCellHeader}>OTHER</Text>
            </View>
            {['alarm', 'knock', 'other'].map((actual) => (
              <View style={styles.matrixRow} key={actual}>
                <Text style={styles.matrixCellLabel}>{actual.toUpperCase()}</Text>
                {['alarm', 'knock', 'other'].map((pred) => (
                  <Text
                    key={pred}
                    style={[styles.matrixCell, actual === pred && styles.matrixCellDiagonal]}
                  >
                    {calibrationEvalResult.confusion[actual][pred]}
                  </Text>
                ))}
              </View>
            ))}

            <Text style={styles.resultSubtitle}>على Validation Set (عينات لم تدخل التحسين):</Text>
            <Text style={styles.resultLine}>
              Target F1: {validationEvalResult.targetF1.toFixed(2)} | FP: {validationEvalResult.totalFP} | FN:{' '}
              {validationEvalResult.totalFN}
            </Text>
            {overfitting?.isOverfitting && (
              <Text style={styles.warningText}>⚠️ Possible Overfitting (فجوة Target F1: {overfitting.f1Gap.toFixed(2)})</Text>
            )}

            {calibrationEvalResult.targetF1 < MIN_ADOPTABLE_F1 ||
            calibrationEvalResult.perClass.alarm.recall === 0 ||
            calibrationEvalResult.perClass.knock.recall === 0 ? (
              <Text style={styles.warningText}>
                🚫 زر الاعتماد معطَّل: Target F1 ({calibrationEvalResult.targetF1.toFixed(2)}) أقل من الحد الأدنى المقبول (
                {MIN_ADOPTABLE_F1}), أو Recall لأحد الأصوات المستهدفة صفر. جرّب توسيع نطاق البحث أو جمع عينات أكثر.
              </Text>
            ) : (
              <TouchableOpacity
                style={styles.acceptButton}
                onPress={() => handleAdoptConfiguration(calibrationEvalResult.config, 'من Local Optimization مباشرة')}
              >
                <Text style={styles.buttonText}>✅ اعتماد هذا الإعداد</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── جدول مقارنة Top 5 ── */}
        {topConfigs && topConfigs.length > 0 && (
          <View style={styles.resultBox}>
            <Text style={styles.resultTitle}>مقارنة أفضل {Math.min(5, topConfigs.length)} Configurations</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={true}>
              <View>
                <View style={styles.tableHeaderRow}>
                  {['#', 'ALARM', 'KNOCK', 'Gate', 'Prec.', 'Recall', 'F1', 'FP', 'FN', 'ValF1'].map((h) => (
                    <Text key={h} style={styles.tableHeaderCell}>
                      {h}
                    </Text>
                  ))}
                </View>
                {topConfigs.slice(0, 5).map((r, idx) => {
                  const valResult = evaluateConfig(
                    validationSetRef.current,
                    productionRefs.alarm || [],
                    productionRefs.knock || [],
                    r.config
                  );
                  return (
                    <View style={styles.tableRow} key={idx}>
                      <Text style={styles.tableCell}>{idx + 1}</Text>
                      <Text style={styles.tableCell}>{r.config.alarm.similarityThreshold}</Text>
                      <Text style={styles.tableCell}>{r.config.knock.similarityThreshold}</Text>
                      <Text style={styles.tableCell}>{r.config.energyGate}</Text>
                      <Text style={styles.tableCell}>{((r.perClass.alarm.precision + r.perClass.knock.precision) / 2).toFixed(2)}</Text>
                      <Text style={styles.tableCell}>{((r.perClass.alarm.recall + r.perClass.knock.recall) / 2).toFixed(2)}</Text>
                      <Text style={styles.tableCell}>{r.targetF1.toFixed(2)}</Text>
                      <Text style={styles.tableCell}>{r.totalFP}</Text>
                      <Text style={styles.tableCell}>{r.totalFN}</Text>
                      <Text style={styles.tableCell}>{valResult.targetF1.toFixed(2)}</Text>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        )}
      </View>

      {/* ── Gemini Analysis ── */}
      {calibrationEvalResult && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🤖 Gemini Analysis</Text>
          <Text style={styles.hint}>يُرسَل فقط ملخص إحصائي رقمي (بدون صوت خام). Gemini لا يعدّل الكود مباشرة — فقط يقترح، ويُختبر كل اقتراح محليًا قبل اعتماده.</Text>
          <TouchableOpacity style={styles.button} onPress={handleConsultGemini} disabled={isConsultingGemini}>
            {isConsultingGemini ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>🤖 استشارة Gemini</Text>}
          </TouchableOpacity>

          {geminiRecommendations && geminiRecommendations.length > 0 && (
            <View style={styles.resultBox}>
              {geminiConfidence !== null && <Text style={styles.hint}>ثقة Gemini: {(geminiConfidence * 100).toFixed(0)}%</Text>}
              {geminiRecommendations.map((rec) => (
                <View key={rec.parameter} style={styles.recCard}>
                  <Text style={styles.recTitle}>{rec.parameter}</Text>
                  <Text style={styles.resultLine}>
                    {rec.current} → {rec.recommended}
                  </Text>
                  <Text style={styles.hint}>{rec.reason}</Text>
                  <View style={styles.row}>
                    <TouchableOpacity
                      style={[styles.smallButton, rec.decision === 'applied' && styles.buttonDisabled]}
                      onPress={() => applyRecommendation(rec)}
                    >
                      <Text style={styles.buttonText}>{rec.decision === 'applied' ? '✅ مُطبَّق مؤقتًا' : 'Apply Temporarily'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.smallSecondaryButton} onPress={() => rejectRecommendation(rec)}>
                      <Text style={styles.secondaryButtonText}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}

              <TouchableOpacity style={styles.button} onPress={handleRetest}>
                <Text style={styles.buttonText}>🔁 إعادة الاختبار (Retest) على كل Dataset</Text>
              </TouchableOpacity>

              {retestResult && (
                <View style={styles.resultBox}>
                  <Text style={styles.resultTitle}>Before → After</Text>
                  <Text style={styles.resultLine}>
                    Target F1 (alarm+knock): {retestResult.before.targetF1.toFixed(2)} → {retestResult.after.targetF1.toFixed(2)}
                  </Text>
                  <Text style={styles.resultLine}>
                    ALARM Recall: {retestResult.before.perClass.alarm.recall.toFixed(2)} → {retestResult.after.perClass.alarm.recall.toFixed(2)}
                  </Text>
                  <Text style={styles.resultLine}>
                    KNOCK Recall: {retestResult.before.perClass.knock.recall.toFixed(2)} → {retestResult.after.perClass.knock.recall.toFixed(2)}
                  </Text>
                  <Text style={styles.resultLine}>
                    False Positives: {retestResult.before.totalFP} → {retestResult.after.totalFP}
                  </Text>
                  <Text style={styles.resultLine}>
                    False Negatives: {retestResult.before.totalFN} → {retestResult.after.totalFN}
                  </Text>

                  {retestResult.after.targetF1 < MIN_ADOPTABLE_F1 ||
                  retestResult.after.perClass.alarm.recall === 0 ||
                  retestResult.after.perClass.knock.recall === 0 ? (
                    <Text style={styles.warningText}>
                      🚫 زر الاعتماد معطَّل: هذا الإعداد بعد Retest لا يحقق حدًا أدنى مقبولاً من Target F1/Recall. جرّب Reject على توصية والاختبار مجددًا.
                    </Text>
                  ) : (
                    <TouchableOpacity
                      style={styles.acceptButton}
                      onPress={() => handleAdoptConfiguration(retestResult.candidate, 'بعد Retest مع توصيات Gemini')}
                    >
                      <Text style={styles.buttonText}>✅ اعتماد الإعداد بعد Retest</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>
          )}
        </View>
      )}

      <Text style={styles.status}>{status}</Text>

      <TouchableOpacity style={[styles.button, styles.finishButton]} onPress={handleFinishAiCalibration}>
        <Text style={styles.buttonText}>🏁 Finish AI Calibration</Text>
      </TouchableOpacity>

      {onBack && (
        <TouchableOpacity style={styles.backButton} onPress={onBack}>
          <Text style={styles.backButtonText}>⬅️ رجوع</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 60, backgroundColor: '#121212', flexGrow: 1 },
  title: { color: '#fff', fontSize: 22, fontWeight: 'bold', marginBottom: 6, textAlign: 'center' },
  subtitle: { color: '#888', fontSize: 12, textAlign: 'center', marginBottom: 20, lineHeight: 18 },
  section: { backgroundColor: '#1e1e1e', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#2a2a2a' },
  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  hint: { color: '#888', fontSize: 12, marginBottom: 10, lineHeight: 17 },
  input: {
    backgroundColor: '#0f0f0f', color: '#fff', padding: 12, borderRadius: 10, fontSize: 15,
    marginBottom: 10, borderWidth: 1, borderColor: '#333',
  },
  maskedKey: { color: '#93c5fd', fontSize: 14, marginBottom: 10, fontFamily: 'monospace' },
  row: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { fontSize: 13, fontWeight: '600' },
  progress: { color: '#4CAF50', fontSize: 14, marginBottom: 10 },
  button: { backgroundColor: '#2563eb', padding: 14, borderRadius: 10, alignItems: 'center', marginBottom: 8 },
  smallButton: { backgroundColor: '#2563eb', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center' },
  smallSecondaryButton: { backgroundColor: '#333', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center' },
  acceptButton: { backgroundColor: '#16a34a', padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 10 },
  dangerButton: { backgroundColor: '#dc2626', padding: 12, borderRadius: 10, alignItems: 'center', marginTop: 6 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  secondaryButtonText: { color: '#f87171', fontSize: 14 },
  resultBox: { backgroundColor: '#161f30', borderRadius: 10, padding: 14, marginTop: 8, borderWidth: 1, borderColor: '#2563eb' },
  diagnosticsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  diagnosticsToggle: { color: '#93c5fd', fontSize: 16, paddingHorizontal: 8 },
  diagnosticsLabelBlock: { marginTop: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#243044' },
  diagStatsRow: { marginTop: 8 },
  diagFeatureName: { color: '#93c5fd', fontSize: 12, fontWeight: '700', marginBottom: 4 },
  diagStatsValuesRow: { flexDirection: 'row' },
  diagStatCell: { alignItems: 'center', width: 58, paddingVertical: 2 },
  diagStatCellLabel: { color: '#888', fontSize: 10 },
  diagStatCellValue: { color: '#ddd', fontSize: 12, fontWeight: '600' },
  matrixHeaderRow: { flexDirection: 'row', marginTop: 4 },
  matrixRow: { flexDirection: 'row', alignItems: 'center' },
  matrixCellHeader: { color: '#93c5fd', fontSize: 11, width: 56, textAlign: 'center', fontWeight: '700' },
  matrixCellLabel: { color: '#93c5fd', fontSize: 11, width: 56, fontWeight: '700' },
  matrixCell: { color: '#ddd', fontSize: 12, width: 56, textAlign: 'center', paddingVertical: 2 },
  matrixCellDiagonal: { color: '#4ade80', fontWeight: '700' },
  tableHeaderRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#333', paddingBottom: 4, marginBottom: 4 },
  tableHeaderCell: { color: '#93c5fd', fontSize: 11, width: 52, textAlign: 'center', fontWeight: '700' },
  tableRow: { flexDirection: 'row', paddingVertical: 3 },
  tableCell: { color: '#ddd', fontSize: 11, width: 52, textAlign: 'center' },
  resultTitle: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 6 },
  resultSubtitle: { color: '#93c5fd', fontSize: 12, marginTop: 8, marginBottom: 4 },
  resultLine: { color: '#ddd', fontSize: 13, marginBottom: 2 },
  warningText: { color: '#facc15', fontSize: 13, marginTop: 8, fontWeight: '600' },
  recCard: { backgroundColor: '#1a1a1a', borderRadius: 8, padding: 10, marginTop: 8 },
  recTitle: { color: '#60a5fa', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  status: { color: '#aaa', fontSize: 13, textAlign: 'center', marginVertical: 16, lineHeight: 20 },
  finishButton: { backgroundColor: '#7c3aed' },
  backButton: { padding: 12, alignItems: 'center', marginTop: 4 },
  backButtonText: { color: '#60a5fa', fontSize: 14 },
});
