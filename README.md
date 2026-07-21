# Sound Monitor App — تطبيق مراقبة صوتية

تطبيق Expo/React Native يراقب صوتين محدَّدين (منبه إشعار + طرق باب)، وعند التعرف
على أيّ منهما — عبر مقارنة **بصمة صوتية (Audio Embedding)** حية بأقرب عينة مرجعية
سجّلها المستخدم أثناء المعايرة — يتصل تلقائيًا برقم هاتف محدد مسبقًا.

## ⚠️ ملاحظات مهمة قبل البدء

1. **هذا التطبيق لا يعمل على Expo Go** — يحتاج مكتبتين native حقيقيتين:
   `react-native-immediate-phone-call` (الاتصال التلقائي) و
   `react-native-fast-tflite` (تشغيل نموذج التعرف الصوتي). لازم **Development
   Build** أو **Prebuild + بناء APK**.
2. **يعمل على أندرويد فقط** — صلاحية `CALL_PHONE` بهذا الشكل غير مسموحة على iOS إطلاقًا.
3. **صلاحية `CALL_PHONE` حساسة** — أندرويد هيطلب منك تفعيلها يدويًا من إعدادات
   التطبيق بعد التثبيت (Settings > Apps > Sound Monitor > Permissions).
4. الشاشة يجب أن تبقى مفتوحة والتطبيق في المقدمة أثناء المراقبة.

## 🧠 كيف يعمل التعرف الصوتي

بدلًا من محاولة "تصنيف" كل الأصوات الممكنة، يستخدم التطبيق نهج
**Embedding + Nearest Neighbor Similarity**:

1. أثناء المعايرة، كل عينة تسجّلها (منبه أو طرقة) تمر على نموذج **YAMNet**
   الجاهز (مُدرَّب مسبقًا من Google على AudioSet) والذي يُخرِج **Embedding**
   بحجم 1024 رقم يمثّل "بصمة" الصوت — وليس تصنيفًا.
2. كل Embedding يُحفظ محليًا كما هو.
3. أثناء المراقبة، كل مقطع حي يمر على نفس النموذج، ويُقارَن Embedding الناتج
   بكل العينات المرجعية المخزَّنة عبر **Cosine Similarity**، وتُعتمَد أعلى
   نتيجة تشابه (Max Similarity).
4. لو التشابه مع عينات المنبه أو الطرق تجاوز العتبة → مرحلة تحقق نهائي قصيرة →
   اتصال تلقائي.

هذا يعني: **لا تدريب لنموذج من الصفر، ولا حاجة لفئة "Other"** — أي صوت لا يشبه
العينات المرجعية بما يكفي يُتجاهَل تلقائيًا.

### ⬇️ ملف النموذج مطلوب يدويًا (خطوة لازمة قبل أول تشغيل)

الكود يفترض وجود الملف التالي ولا يقوم بتنزيله تلقائيًا:

```
assets/yamnet.tflite
```

نزّله من TensorFlow Hub (النسخة الرسمية من Google، ~3.7 ميجابايت):
https://tfhub.dev/google/lite-model/yamnet/tflite/1

ضعه في مجلد `assets/` بنفس الاسم أعلاه قبل تشغيل `expo prebuild`.

## 📁 هيكل المشروع

```
monitor-app/
├── App.js                      # نقطة الدخول، يربط شاشتي الإعداد والمراقبة
├── app.json                    # إعدادات Expo، الصلاحيات، وplugin نموذج TFLite
├── babel.config.js
├── package.json                # قائمة المكتبات المطلوبة
├── assets/
│   └── yamnet.tflite           # (يُضاف يدويًا) نموذج استخراج الـ Embeddings
├── screens/
│   ├── CalibrationScreen.js    # تسجيل عينات المنبه والطرق المرجعية + رقم الهاتف
│   └── MonitoringScreen.js     # المراقبة الحية والاتصال التلقائي
└── utils/
    ├── audioRecorder.js        # تسجيل مقاطع صوت قصيرة (WAV)
    ├── embeddingModel.js       # تحميل YAMNet واستخراج Embeddings
    ├── audioFingerprint.js     # قراءة WAV + RMS + Cosine Similarity (أدوات عامة)
    └── storage.js              # حفظ/استرجاع الإعدادات محليًا (AsyncStorage)
```

## 🚀 خطوات التشغيل

### 1. تثبيت المتطلبات

```bash
cd monitor-app
npm install
```

### 2. إضافة ملف النموذج

ضع `yamnet.tflite` (رابط التنزيل أعلاه) داخل مجلد `assets/`.

### 3. تشغيل Prebuild لتوليد مجلد Android الأصلي

```bash
npx expo prebuild --platform android
```

الصلاحيات المطلوبة (RECORD_AUDIO, CALL_PHONE, WAKE_LOCK) وplugin
`react-native-fast-tflite` متضافين بالفعل عبر `app.json`.

### 4. التأكد من الصلاحيات في AndroidManifest.xml (تحقق يدوي)

افتح `android/app/src/main/AndroidManifest.xml` وتأكد من وجود:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.CALL_PHONE" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

### 5. بناء وتشغيل التطبيق على جهاز أندرويد حقيقي

```bash
npx expo run:android
```

**بديل: بناء APK جاهز للتوزيع (عبر EAS Build):**

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --platform android --profile preview
```

### 6. منح صلاحية الاتصال يدويًا (إجراء لازم مرة واحدة)

`إعدادات الهاتف > التطبيقات > Sound Monitor > الصلاحيات` → فعّل **"الهاتف / Phone"**.

## 🎛️ طريقة الاستخدام

1. **افتح التطبيق أول مرة** → هتظهر شاشة الإعداد
2. **أدخل رقم الهاتف** المطلوب الاتصال به عند التنبيه
3. **سجّل 5 عينات على الأقل** لكل صوت مفعّل (منبه و/أو طرق باب) — زيادة العدد
   (مثلاً 15-20) تحسّن الدقة تجريبيًا
4. **اضغط "حفظ وإنهاء الإعداد"** → ينتقل تلقائيًا لشاشة المراقبة
5. **اضغط "ابدأ المراقبة"** → التطبيق يسجل مقاطع قصيرة (2 ثانية) بشكل متكرر،
   ويستخرج Embedding لكل مقطع ويقارنه بالعينات المرجعية
6. عند تجاوز عتبة التشابه ونجاح التحقق النهائي → اتصال تلقائي

## ⚙️ إعدادات قابلة للتعديل (داخل الكود)

في `screens/MonitoringScreen.js`:

```javascript
const COOLDOWN_MS = 30000;          // مهلة قبل السماح باتصال تالٍ
const CHUNK_DURATION_MS = 2000;     // مدة كل مقطع تسجيل يُحلَّل
const MIN_ENERGY_RMS = 0.015;       // بوابة الطاقة قبل تشغيل النموذج (توفير بطارية)
const CONFIRM_CHUNK_MS = 1000;      // مدة مقطع التحقق النهائي
```

في `screens/CalibrationScreen.js`:

```javascript
const SAMPLES_NEEDED = 5;        // عدد عينات المنبه الأدنى (يفضَّل رفعه لاحقًا)
const KNOCK_SAMPLES_NEEDED = 5;  // عدد عينات الطرق الأدنى
```

## 🔧 ضبط الدقة (Threshold Tuning)

القيمة الافتراضية لعتبة التشابه (Cosine Similarity) هي `0.75` (مخزَّنة في
`utils/storage.js` عبر `loadSimilarityThreshold` / `saveSimilarityThreshold`).
بعد أول تجربة فعلية:

- **لو مفيش اتصالات بتحصل رغم سماع الصوت الصحيح** → قلّل العتبة تدريجيًا (مثلاً 0.65)
- **لو بيتصل بالغلط من أصوات تانية** → زوّد العتبة (مثلاً 0.85)

جرّب في نفس البيئة الفعلية (نفس الغرفة، نفس المسافة) وظبط القيمة حسب النتيجة العملية.

## 🐛 استكشاف الأخطاء الشائعة

| المشكلة | الحل المحتمل |
|---|---|
| خطأ عند تحميل النموذج / crash عند بدء المعايرة | تأكد من وجود `assets/yamnet.tflite` وأنك عملت `expo prebuild` من جديد بعد إضافته |
| التطبيق ميديش صلاحية `CALL_PHONE` | فعّلها يدويًا من إعدادات النظام كما بالخطوة 6 |
| `react-native-immediate-phone-call` أو `react-native-fast-tflite` مش شغالين | تأكد إنك عملت `expo prebuild` ومش شغال على Expo Go |
| دقة التعرف ضعيفة | سجّل عينات معايرة أكتر (ارفع `SAMPLES_NEEDED`) وجرب في نفس ظروف الاستخدام الفعلية، وعدّل العتبة |
| التطبيق بيستهلك بطارية بسرعة | وصّل الهاتف بالشاحن دائمًا أثناء المراقبة (متوقع بسبب التسجيل المستمر + تشغيل النموذج + إبقاء الشاشة مضاءة) |
| ملفات WAV مؤقتة بتتراكم | الكود بيمسحها تلقائيًا بعد كل تحليل عبر `deleteTempFile` |
