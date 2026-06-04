import { AI_PROMPTS } from './aiPrompts';
import type { AiAnalysisOptions, EngineeringPromptDefinition, EngineeringPromptId, EngineeringPrompts } from '../types';

export const ENGINEERING_PROMPT_PASSWORD = 'Rezan90';
export const CONTENT_SUMMARY_STORAGE_KEY = 'bazarvan-current-content-summary';

export const ENGINEERING_PROMPT_IDS = {
  smartAnalysis: {
    entityMap: 'smartAnalysis.entityMap',
    fullArticleAudit: 'smartAnalysis.fullArticleAudit',
    contentSummaryForCompetitors: 'smartAnalysis.contentSummaryForCompetitors',
    competitorGapAnalysis: 'smartAnalysis.competitorGapAnalysis',
    competitorContentComparison: 'smartAnalysis.competitorContentComparison',
    improveConclusion: 'smartAnalysis.improveConclusion',
    improveWeakest: 'smartAnalysis.improveWeakest',
    suggestNewIdea: 'smartAnalysis.suggestNewIdea',
    peopleQuestions: 'smartAnalysis.peopleQuestions',
    structuredContent: 'smartAnalysis.structuredContent',
    unsuitableSections: 'smartAnalysis.unsuitableSections',
  },
  toolbar: {
    suggestHeadings: 'toolbar.suggestHeadings',
    generateMeta: 'toolbar.generateMeta',
    suggestTitle: 'toolbar.suggestTitle',
    merge: 'toolbar.merge',
    rephrase: 'toolbar.rephrase',
    improveWording: 'toolbar.improveWording',
    simplifyText: 'toolbar.simplifyText',
    expand: 'toolbar.expand',
    expand50: 'toolbar.expand50',
    expand100: 'toolbar.expand100',
    summarize: 'toolbar.summarize',
    summarize50: 'toolbar.summarize50',
    summarize100: 'toolbar.summarize100',
    findStats: 'toolbar.findStats',
    evaluateSection: 'toolbar.evaluateSection',
    toQa: 'toolbar.toQa',
    toSteps: 'toolbar.toSteps',
    toTable: 'toolbar.toTable',
    changeTone: 'toolbar.changeTone',
  },
} as const;

export const DEFAULT_SMART_ANALYSIS_OPTIONS: AiAnalysisOptions = {
  manualCommand: true,
  articleTitle: true,
  articleToc: false,
  currentConclusion: false,
  editorText: true,
  competitorContent: false,
  targetKeywords: true,
  goalContext: true,
  companyName: false,
  keywordCriteria: false,
  basicStructureCriteria: false,
  headingsSequenceCriteria: false,
  productPageCriteria: false,
  interactionCtaCriteria: false,
  conclusionCriteria: false,
};

const IMPROVE_CONCLUSION_PROMPT = `أنت كاتب محتوى محترف وخبير SEO / AEO / GEO / LLM SEO، ومتخصص في تحسين خواتيم المحتوى بما يخدم هدف الصفحة والجمهور ونية البحث.

سيتم إرفاق البيانات التالية تلقائيا مع الطلب:
- عنوان المقالة.
- سياق هدف الصفحة والجمهور.
- جدول محتويات المقالة.
- الخاتمة الحالية إن وجدت.
- الكلمات المفتاحية المستهدفة.
- معايير الخاتمة المطلوب الالتزام بها.

المطلوب:
اكتب خاتمة محسّنة احترافية وطبيعية ومناسبة لهدف الصفحة، مع الالتزام الكامل بالمعايير المرفقة.

قواعد الكتابة:
- لا تكتب خاتمة عامة أو مكررة.
- اربط الخاتمة مباشرة بموضوع المقالة ونية البحث.
- لخّص القيمة الأساسية التي حصل عليها القارئ دون إعادة شرح المقالة.
- استخدم الكلمة المفتاحية الأساسية مرة واحدة فقط وبشكل طبيعي إن أمكن.
- استخدم صيغة بديلة أو كلمة LSI واحدة فقط إذا كان ذلك يخدم السياق.
- أضف CTA واضحا ومناسبا إذا كان هدف الصفحة خدميا أو تجاريا.
- إذا كان هدف الصفحة تعليميا، اجعل الخاتمة إرشادية لا بيعية.
- اجعل الخاتمة مناسبة للظهور في نتائج البحث وملخصات الذكاء الاصطناعي.
- لا تضف وعودا مبالغا فيها أو ادعاءات غير مثبتة.
- لا تستخدم حشوا إنشائيا مثل: في الختام، مما لا شك فيه، لا يخفى على أحد.
- حافظ على أسلوب بشري، مباشر، وواثق.

معايير التقييم قبل التسليم:
- هل الخاتمة تخدم نية البحث؟
- هل تربط المقالة بهدف الصفحة؟
- هل تحتوي على قيمة واضحة للقارئ؟
- هل تتضمن CTA مناسب دون مبالغة عند الحاجة؟
- هل الكلمة المفتاحية مستخدمة طبيعيا؟
- هل الخاتمة صالحة للاقتباس أو التلخيص من أدوات الذكاء الاصطناعي؟
- هل التزمت بجميع المعايير المرفقة؟

المخرجات المطلوبة:
الخاتمة المحسّنة فقط، دون شرح أو عناوين إضافية.`;

const CONTENT_SUMMARY_FOR_COMPETITORS_PROMPT = `حوّل المحتوى التالي إلى نسخة مختصرة جاهزة للنشر.

استخرج محتوي يشمل جميع العناوين الرئيسية والفرعية، ثم أعد تنظيم المحتوى بأسلوب تحريري مترابط يشبه مقالًا منشورًا.

حافظ على:
- جميع العناوين
- جميع الادعاءات المهمة
- جميع الكيانات
- الكلمات المفتاحية الأساسية والثانوية
- كلمات LSI
- المصطلحات الدلالية
- الفقرات والأفكار الأساسية
- المقارنات والخطوات والأسئلة إن وجدت

لا تضف معلومات خارج النص.
لا تحذف أي فكرة تؤثر على قيمة المحتوى.
قلل التكرار فقط دون إضعاف المعنى.`;

const COMPETITOR_GAP_ANALYSIS_PROMPT = `تصرّف كخبير محتوى SEO/AEO/GEO/LLM SEO، وقارن المحتوى الموجود في المحرر مع محتوى المنافسين المرفقين لاكتشاف الفجوات، نقاط القوة، نقاط الضعف، وفرص التحسين.

إليك المعلومات التالية:
- هدف الصفحة والجمهور.
- عنوان الصفحة أو القسم.
- الكلمة المفتاحية الأساسية والثانوية.
- الصيغ البديلة.
- المحتوى الحالي.
- محتوى المنافسين.

حلّل المقارنة من حيث:

- تغطية نية البحث.
- عمق المعلومات وقيمتها.
- الأسئلة التي يجيب عنها المنافسون ولا يجيب عنها المحتوى الحالي.
- البنية والعناوين وسهولة القراءة.
- SEO واستخدام الكلمات المفتاحية.
- قابلية الاقتباس في AI Overviews ومحركات الإجابة.
- الكيانات والمصطلحات المهمة.
- قوة الثقة وE-E-A-T.
- قوة التحويل والـ CTA.
- قم بالتأكد من المواصفات التقنية والخصائص إن وجدت في المحتوى أو لدى المنافسين.
- الادعاءات غير المدعومة أو المبالغات.

القواعد:

- لا تنسخ من المنافسين حرفيًا.
- لا تخترع معلومات أو أرقامًا أو ادعاءات.
- لا تقترح شهادات عملاء، صور، فيديوهات، Schema Data، أو روابط داخلية إلا إذا طُلب ذلك.
- لا تقدم نصائح عامة.
- اجعل التوصيات محددة وتوضح: ماذا أفعل؟ أين أطبقه؟ ولماذا؟

صيغة الإخراج المطلوبة:

1. ملخص تنفيذي

اكتب 5–8 نقاط توضّح قوة المحتوى، ضعفه، وأهم فرص التحسين.
وقدم اقتراحات تحسين لكل فجوة مع زر الموضع والنسخ والاستبدال كما العادة.

2. جدول مقارنة مختصر

استخدم جدول Markdown بالأعمدة التالية:
المحور | تقييم المحتوى الحالي | تفوق المنافسين | الفجوة | الأولوية
وقدم اقتراحات تحسين لكل فجوة مع زر الموضع والنسخ والاستبدال كما العادة.

غطِّ المحاور التالية:
نية البحث، عمق المعلومات، البنية، SEO، AEO/GEO/LLM، الكيانات، الثقة، التحويل.

3. فجوات المحتوى

قسّم الفجوات إلى:

- أسئلة ناقصة.
- نقاط مقارنة أو اختيار ناقصة.
- اعتراضات غير معالجة.
- تعريفات أو مفاهيم ناقصة.
- خطوات أو أمثلة ناقصة.
- وغيرها من المعايير المهمة المرتبطة بالمحتوى.
وقدم اقتراحات تحسين لكل فجوة ناقصة مع زر الموضع والنسخ والاستبدال كما العادة.

4. أفضل ما لدى المنافسين

اذكر 6–12 فكرة منهجية يمكن الاستفادة منها دون نسخ حرفي، مع توضيح طريقة تطبيقها في المحتوى الحالي.
وقدم اقتراحات تحسين لكل فجوة مع زر الموضع والنسخ والاستبدال كما العادة.

5. التوصيات العملية

قدّم 5 توصيات فقط مع نصوص جاهزة وقدم اقتراحات تحسين لكل فجوة مع زر الموضع والنسخ والاستبدال كما العادة، وكل توصية يجب أن تتضمن:

- ماذا أفعل؟
- أين أطبقه؟
- لماذا؟
- علامة تنفيذ بصيغة [[PATCH:patch_1]] أو [[PATCH:patch_2]] بدل كتابة النص الجاهز داخل التقرير.

تعليمات بطاقات التنفيذ:

- أي نص جاهز للإضافة أو الاستبدال يجب أن يكون داخل patches فقط، وليس داخل نص التقرير.
- أنشئ patch مستقلًا لكل توصية قابلة للتطبيق، بحيث يمكن للمستخدم النقر على الموضع لمعرفة مكان الإضافة، والنقر على النسخ، والنقر على التطبيق أو الإضافة داخل المحرر.
- استخدم operation المناسبة:
  - replace_block عند استبدال فقرة أو قسم موجود، مع وضع targetText حرفيًا من النص الحالي.
  - insert_after_heading عند إضافة فقرة بعد عنوان محدد.
  - append_to_section عند إضافة نص داخل قسم محدد.
  - insert_before_conclusion عند إضافة نص قبل الخاتمة.
  - insert_before_faq عند إضافة سؤال وجواب داخل قسم الأسئلة الشائعة.
  - append_to_article إذا لم يوجد موضع أدق.
- اكتب anchorText بدقة اعتمادًا على عنوان القسم أو الفقرة المرجعية داخل المحتوى الحالي.
- اكتب placementLabel بوضوح لشرح مكان الإضافة أو الاستبدال.
- اكتب contentMarkdown كنص نهائي جاهز للإدراج فقط، دون شرح أو عناوين تفسيرية.
- داخل التقرير، ضع علامة [[PATCH:patch_1]] في موضع التوصية التي تخص هذا النص حتى تظهر بطاقة التنفيذ في مكانها الصحيح.

6. الحكم النهائي

اختم بتقييم مختصر يوضح هل المحتوى الحالي أقوى أم أضعف من المنافسين، وما أول تعديل يجب تنفيذه.`;

const PREVIOUS_COMPETITOR_GAP_ANALYSIS_PROMPT = COMPETITOR_GAP_ANALYSIS_PROMPT
  .replace('\n- قم بالتأكد من المواصفات التقنية والخصائص إن وجدت في المحتوى أو لدى المنافسين.', '')
  .replaceAll('\nوقدم اقتراحات تحسين لكل فجوة مع زر الموضع والنسخ والاستبدال كما العادة.', '')
  .replace('\nوقدم اقتراحات تحسين لكل فجوة ناقصة مع زر الموضع والنسخ والاستبدال كما العادة.', '')
  .replace(
    'قدّم 5 توصيات فقط مع نصوص جاهزة وقدم اقتراحات تحسين لكل فجوة مع زر الموضع والنسخ والاستبدال كما العادة، وكل توصية يجب أن تتضمن:',
    'قدّم 5 توصيات فقط مع نصوص جاهزة، وكل توصية يجب أن تتضمن:'
  );

const PREVIOUS_COMPETITOR_GAP_ANALYSIS_PATCH_PROMPT = COMPETITOR_GAP_ANALYSIS_PROMPT
  .replace('\n- قم بالتأكد من المواصفات التقنية والخصائص إن وجدت في المحتوى أو لدى المنافسين.', '');

const COMPETITOR_CONTENT_COMPARISON_PROMPT = `# مقارنة المحتوى الحالي مع محتوى المنافسين + اقتراح محتوى جاهز

تصرّف كخبير محتوى SEO/AEO/GEO/LLM SEO، وقارن بين المحتوى الموجود في المحرر ومحتوى المنافسين المرفقين بهدف اكتشاف نقاط التميز، الفجوات، والتناقضات، ثم تقديم محتوى جاهز لسد الفجوات وتصحيح التعارضات.

افهم سياق الصفحة عند الحاجة من المعلومات المرفقة مثل:

* هدف الصفحة والجمهور.
* عنوان الصفحة أو القسم.
* الكلمة المفتاحية الأساسية.
* الكلمات المفتاحية الثانوية.
* نوع الصفحة.
* المحتوى الحالي داخل المحرر.
* محتوى المنافسين.
* وغيرها من المرفقات.

القواعد:

* قارن المعنى والأفكار الفعلية وليس التشابه اللفظي فقط.
* اجمع الأفكار المتشابهة ضمن نقطة واحدة.
* لا تخترع معلومات غير موجودة في المحتوى أو لا يمكن استنتاجها منطقيًا.
* لا تنسخ نصوص المنافسين حرفيًا.
* إذا كانت الفكرة موجودة جزئيًا في المحتوى الحالي، فلا تعتبرها فجوة إلا إذا كان المنافس يغطيها بعمق أكبر بشكل واضح.
* إذا لم تتمكن من العثور على العدد المطلوب من النقاط، اعرض المتاح فقط.
* اجعل النصوص المقترحة أصلية ومتوافقة مع أسلوب المحتوى الحالي.
* حافظ على نبرة المحتوى الحالية والكلمات المفتاحية المهمة عند كتابة النصوص المقترحة.

## 1. أفكار موجودة في المحتوى الحالي وغير موجودة لدى المنافسين

اعرض من 5 إلى 10 نقاط.

| الفكرة | سبب أهميتها |
| ------ | ----------- |
| ...    | ...         |

---

## 2. أفكار موجودة لدى المنافسين وغير موجودة في المحتوى الحالي

اعرض من 5 إلى 10 نقاط.

لكل فكرة اعرض:

### الفكرة

[اسم الفكرة]

### سبب أهمية إضافتها

[سطر أو سطران]

### نص مقترح جاهز للإضافة

لا تكتب النص المقترح داخل التقرير. ضع علامة تنفيذ واحدة بصيغة [[PATCH:patch_1]] أو [[PATCH:patch_2]]، ويجب أن يحتوي patch على فقرتين جاهزتين للنشر مفصولتين بسطر فارغ.

---

## 3. معلومات أو ادعاءات متضاربة

اعرض من 5 إلى 10 نقاط إن وجدت.

لكل نقطة اعرض:

| البند | المحتوى الحالي | المنافسون | مستوى التضارب         |
| ----- | -------------- | --------- | --------------------- |
| ...   | ...            | ...       | منخفض / متوسط / مرتفع |

### النص المقترح لتصحيح التضارب

لا تكتب النص المقترح داخل التقرير. ضع علامة تنفيذ واحدة بصيغة [[PATCH:patch_1]] أو [[PATCH:patch_2]]، ويجب أن يحتوي patch على فقرة جاهزة للنشر:

* تحافظ على دقة المعلومات.
* تزيل التعارض أو الغموض.
* تتوافق مع بقية المحتوى.
* لا تتبنى ادعاءات غير مؤكدة.
* تكون جاهزة للاستبدال أو الإضافة مباشرة.

---

## 4. فرص التحسين ذات الأولوية

رتب أهم 5 فرص تحسين حسب التأثير المتوقع على:

* SEO
* AEO
* GEO
* LLM SEO
* تجربة المستخدم

واستخدم الجدول التالي:

| الأولوية | الإجراء | التأثير المتوقع |
| -------- | ------- | --------------- |
| 1        | ...     | مرتفع           |
| 2        | ...     | مرتفع           |
| 3        | ...     | متوسط           |
| 4        | ...     | متوسط           |
| 5        | ...     | منخفض           |

---

## 5. الحكم النهائي

اكتب ملخصًا لا يتجاوز 10 أسطر يوضح:

* نقاط تفوق المحتوى الحالي.
* أهم الفجوات مقارنة بالمنافسين.
* عدد الأفكار القابلة للإضافة فورًا.
* عدد التضاربات التي تحتاج مراجعة.
* هل المحتوى الحالي متفوق أم متأخر عن المنافسين؟
* ما أول تعديل يجب تنفيذه للحصول على أكبر أثر؟

تعليمات تقنية لبطاقات التنفيذ داخل المحرر:

* أي نص جاهز للإضافة أو الاستبدال يجب أن يكون داخل patches فقط وليس داخل analysisMarkdown.
* في القسم 2، أنشئ patch مستقلًا لكل فكرة قابلة للإضافة، واجعل contentMarkdown يحتوي فقرتين جاهزتين للنشر.
* في القسم 3، أنشئ patch مستقلًا لكل تصحيح قابل للتطبيق.
* استخدم replace_block عند تصحيح ادعاء موجود داخل المحتوى الحالي، مع وضع targetText حرفيًا من النص الحالي.
* استخدم insert_after_heading أو append_to_section عند إضافة نص داخل قسم محدد.
* استخدم insert_before_conclusion عند إضافة نص قبل الخاتمة.
* استخدم append_to_article فقط إذا تعذر تحديد موضع أدق.
* اكتب anchorText اعتمادًا على عنوان القسم أو الفقرة المرجعية داخل المحتوى الحالي.
* اكتب placementLabel بوضوح مثل: داخل قسم كذا، بعد فقرة كذا، قبل الخاتمة.
* اكتب contentMarkdown كنص نهائي جاهز للإدراج فقط، دون شرح أو عناوين تفسيرية.
* داخل التقرير، ضع علامة [[PATCH:patch_1]] في موضع الفكرة أو التصحيح الذي يخص هذا النص حتى تظهر بطاقة الموضع والنسخ والاستبدال في مكانها الصحيح.
* لا تطلب الخاتمة الحالية أو معايير الخاتمة أو اسم الشركة أو جدول المحتويات، ولا تعتمد عليها إذا لم تكن مرفقة.`;

const FULL_ARTICLE_SEO_AI_AUDIT_PROMPT = `أنت خبير محتوى SEO/AEO/GEO/LLM SEO. افحص المحتوى التالي بعمق ولكن باختصار، وقيّمه من حيث مطابقته لنية البحث، كفاية الإجابة، قابلية الاقتباس في AI Overviews، الفجوات المعرفية، الأسئلة الناقصة، الادعاءات غير المدعومة، الكيانات الناقصة، البنية، وقوة التحويل.

بيانات الصفحة:
- الكلمة المفتاحية الأساسية: استخدم الكلمة الأساسية المرفقة تلقائيًا مع الطلب.
- الكلمات الثانوية: استخدم الكلمات الثانوية المرفقة تلقائيًا مع الطلب.
- نوع الصفحة: استخدم نوع الصفحة المرفق تلقائيًا مع الطلب.
- هدف الصفحة: استخدم هدف الصفحة المرفق تلقائيًا مع الطلب.
- الجمهور المستهدف: استخدم الجمهور المستهدف المرفق تلقائيًا مع الطلب.
- العلامة التجارية: استخدم اسم العلامة التجارية المرفق تلقائيًا مع الطلب.

المحتوى:
استخدم نص المحرر المرفق تلقائيًا مع الطلب. إذا كانت هناك معلومات أخرى مرفقة مثل معايير الكلمات أو البنية، فاستفد منها أيضًا.

المطلوب:

أخرج التحليل بالعربية وفق هذا التنسيق فقط:

1. ملخص سريع:
- التقييم العام من 100:
- أقوى نقطة في المحتوى:
- أخطر ضعف:
- هل المحتوى مناسب لنية البحث؟ نعم/جزئيًا/لا، مع السبب.

2. نية البحث والفجوات:
- نية البحث الأساسية:
- نوايا فرعية ناقصة:
- 5 أسئلة مهمة يجب إضافتها مع مكان إضافتها.

3. جاهزية AEO/GEO/LLM:
- هل توجد إجابات قابلة للاقتباس؟
- أفضل 3 جمل قابلة للاقتباس من النص.
- 3 جمل جديدة مقترحة أقوى للاقتباس.
- جواب محتمل قد يستخرجه Google AI Overview من المحتوى.

4. الادعاءات والكيانات:
- أهم الادعاءات التي تحتاج دعمًا أو تخفيفًا.
- أهم الكيانات الناقصة التي يجب إضافتها.
- أين تُضاف هذه الكيانات داخل المحتوى؟

5. البنية والتحويل:
- مشاكل العناوين والترتيب.
- الفقرات التي تحتاج تقسيمًا أو توضيحًا.
- مدى قوة CTA.

6. إعادة صياغة:
اختر أضعف فقرة وأعد كتابتها لتصبح أوضح، أقوى، أكثر إقناعًا، وأكثر قابلية للاقتباس.

7. توصيات عملية:
قدّم 7 توصيات فقط. لكل توصية اذكر:
- ماذا أفعل؟
- أين أطبقه؟
- لماذا مهم؟
- مثال قصير.

قيود الإخراج:
- اجعل الإجابات شديدة التركيز.
- لا تكرر نفس الملاحظة.
- لا تقدم نصائح عامة.
- لا تقترح صورًا أو فيديوهات أو Schema.
- اجعل الإجابة عملية ومباشرة.`;

const STRUCTURED_CONTENT_OPPORTUNITIES_PROMPT = `أنت خبير محتوى SEO / AEO / GEO / LLM SEO ومحلل بنية محتوى.

مهمتك هي فحص النص المرفق واكتشاف الفقرات أو المقاطع التي يمكن تحسينها بتحويلها إلى جدول أو قائمة آلية منظمة، بهدف جعل المحتوى أوضح للقارئ وأسهل للفهم، وأكثر قابلية للاستخلاص من محركات البحث وميزات الذكاء الاصطناعي مثل Google AI Overviews وAI Mode.

المطلوب:

1. اقرأ النص كاملًا بعمق.
2. استخرج الفقرات أو المقاطع التي تحتوي على معلومات متعددة يمكن تنظيمها بشكل أفضل.
3. حدّد هل الأنسب لكل فقرة هو:
   - جدول مقارنة
   - جدول معلومات
   - قائمة نقطية
   - قائمة مرقّمة
   - خطوات عملية
   - قائمة تحقق
   - جدول أسباب ونتائج
   - جدول مشكلة وحل
   - جدول خدمة وفائدة
   - جدول سؤال وجواب مختصر

4. لا تقترح تحويل أي فقرة إلى جدول أو قائمة إلا إذا كان التحويل سيضيف قيمة حقيقية للقارئ أو لمحركات البحث.
5. تجنّب الاقتراحات العامة، واذكر بدقة أين توجد الفقرة داخل النص.
6. لا تُعد كتابة النص كاملًا، بل ركّز فقط على المقاطع المناسبة للتحويل.

صيغة الإخراج المطلوبة:

أولًا: الملخص العام
قدّم خلاصة قصيرة توضّح هل النص يحتوي على فرص جيدة لإضافة جداول أو قوائم آلية، وما نوع التحويلات الأكثر فائدة.

ثانيًا: المقاطع المناسبة للتحويل

لكل مقطع مناسب، استخدم التنسيق التالي:

رقم المقطع:
[1]

مكان المقطع داخل النص:
[اذكر العنوان أو القسم أو بداية الفقرة التي يظهر فيها المقطع]

نوع التحويل المقترح:
[جدول / قائمة نقطية / قائمة مرقّمة / خطوات / قائمة تحقق / جدول مقارنة / جدول مشكلة وحل...]

الشكل المقترح:
[قدّم النموذج العملي الجاهز للتحويل هنا، على شكل جدول أو قائمة مكتوبة بالكامل]

قواعد مهمة:
- لا تكرر نفس الفكرة أكثر من مرة.
- لا تقترح جداول كثيرة بلا داعٍ.
- لا تستخدم عبارات عامة مثل "يمكن تحسينه" دون توضيح أين وكيف.
- يجب أن يكون كل اقتراح عمليًا وجاهزًا للتطبيق.
- يجب أن يكون الشكل المقترح قابلًا للنسخ مباشرة داخل المقال.
- حافظ على لغة واضحة ومهنية.`;

const UNSUITABLE_SECTIONS_AUDIT_PROMPT = `أنت خبير SEO Content Audit وLLM SEO.

سأعطيك نصًا، وكلمة مفتاحية أساسية، وصيغًا مرادفة، وكلمات LSI، وهدف الصفحة، وسياق الجمهور.

المطلوب:
حلّل النص ثم حدّد قسمين فقط غير مناسبين أو الأقل ملاءمة، بناءً على:
- توافقهما مع الكلمة المفتاحية الأساسية.
- توافقهما مع الصيغ المرادفة وكلمات LSI.
- خدمتهما لهدف الصفحة.
- فائدتهما للجمهور المستهدف.
- قابليتهما للاستخلاص في SEO / AEO / GEO / LLM.

صيغة الإخراج:
1. ملخص عام قصير.
2. القسم الأول غير المناسب:
- مكان القسم:
   - العنوان:
   - سبب المشكلة:
   - تأثيره على SEO/AEO/GEO/LLM:
   - الإجراء المقترح:
   - صياغة بديلة مختصرة تناسب هدف الصفحة والجمهور والاستهداف
3. القسم الثاني غير المناسب:
- مكان القسم:
   - العنوان:
   - سبب المشكلة:
   - تأثيره على SEO/AEO/GEO/LLM:
   - الإجراء المقترح:
   - صياغة بديلة مختصرة تناسب هدف الصفحة والجمهور والاستهداف

4. توصية نهائية.

الشروط:
- اختر قسمين فقط.
- لا تقترح حذف محتوى ضروري للثقة أو السلامة.
- لا تعتمد على كثافة الكلمات فقط.
- اربط كل ملاحظة بهدف الصفحة والجمهور والكلمات الدلالية.
- اجعل النقد عمليًا وقابلًا للتنفيذ.`;

const EVALUATE_SECTION_PROMPT = `أنت كاتب محتوى محترف وخبير SEO / AEO / GEO / LLM SEO، ومتخصص في تقييم ملاءمة الفقرات لأهداف الصفحات.

سيتم إرفاق الكلمة المفتاحية الأساسية، الصيغ المرادفة، كلمات LSI، نوع الصفحة، هدف الصفحة، نطاق الجمهور، الدولة أو السوق، الجمهور المستهدف، نية البحث، وسياق موضع النص تلقائيًا مع الطلب.

مهمتك:
قيّم النص المحدد فقط، وحدّد هل يناسب سياق الصفحة وهدفها، ثم اقترح أفضل تنسيق وصياغة محسّنة جاهزة للاستخدام.

النص المراد تقييمه:
"""
${'${selectedText}'}
"""

المطلوب:

1. الحكم العام
حدّد هل النص:
- مناسب
- مناسب جزئيًا
- غير مناسب

مع توضيح مختصر لمدى توافقه مع:
- الكلمة المفتاحية الأساسية
- الصيغ المرادفة وكلمات LSI
- هدف الصفحة
- نية البحث
- الجمهور المستهدف

2. المشاكل العملية
اذكر فقط المشاكل المؤثرة، مثل:
- عنوان غير مناسب
- تنسيق طويل أو مشتت
- ضعف الربط بالتحويل
- عبارات مبالغ فيها
- تكرار غير طبيعي للكلمة المفتاحية
- معلومات غير دقيقة أو تحتاج صياغة آمنة
- خروج عن هدف الصفحة أو نية البحث

3. أفضل شكل للقسم
حدّد أنسب تنسيق:
[فقرة مختصرة / جدول / قائمة نقطية / قائمة مرقمة / FAQ / قائمة تحقق]

واشرح باختصار لماذا هذا الشكل أفضل للقارئ وSEO وAEO/GEO/LLM.

4. عناوين بديلة
اقترح 2 إلى 4 عناوين مناسبة، مع مراعاة الكلمة المفتاحية الأساسية والصيغ المرادفة.

5. النسخة المحسّنة الجاهزة للاستخدام
أعد كتابة النص بالشكل الأنسب بحيث يكون:
- واضحًا ومباشرًا
- مناسبًا لنوع الصفحة وهدفها
- داعمًا للتحويل إذا كان الهدف بيعيًا
- متوافقًا مع SEO وAEO/GEO/LLM
- قابلًا للاقتباس والاستخلاص
- خاليًا من المبالغات والوعود المطلقة

6. ملاحظات سريعة
اذكر 3 ملاحظات عملية لتحسين النص داخل الصفحة.

قواعد مهمة:
- قيّم القسم المرفق فقط، وليس الصفحة كاملة.
- لا تعتمد على كثافة الكلمة المفتاحية فقط.
- لا تخترع معلومات غير موجودة.
- لا تضف أسعارًا، أسماء أطباء، شهادات، اعتمادات، أو وعود نتائج.
- لا تستخدم وعودًا مطلقة مثل: مضمون، آمن تمامًا، أفضل نتيجة، علاج نهائي.
- انتبه لأي عبارات غير مناسبة طبيًا، قانونيًا، تجاريًا، بيعيًا، أو تسويقيًا.
- استخدم لغة آمنة عند الحاجة مثل: قد يساعد، يمكن أن، حسب الحالة، بعد التقييم، تختلف النتائج من حالة لأخرى.
- لا تجعل النص دعائيًا بشكل مبالغ فيه.
- اربط كل توصية بهدف الصفحة، نية البحث، والجمهور.
- إذا كان النص مناسبًا جزئيًا، قل ذلك بوضوح واقترح تحسينه بدل حذفه.`;

const SUGGEST_HEADINGS_PROMPT = `أنت كاتب محتوى محترف وخبير SEO / AEO / GEO / LLM SEO، ومتخصص في تقييم ملائمة المحتوى لأهداف الصفحات.

حلّل العناوين التالية من حيث الوضوح، الجاذبية، نية البحث، القوة التسويقية، قابلية النقر، ومدى توافقها مع SEO.

سيتم إرفاق عنوان القسم والفقرة السابقة للنص المحدد والفقرة التالية للنص المحدد عند توفرها. هذه البيانات للاطلاع وفهم السياق فقط، وليست جزءًا من النص المطلوب تعديله أو إعادة كتابته.

بعد التحليل، قدّم لكل عنوان 3 بدائل محسّنة بشرط أن تكون:

- أكثر وضوحًا وجاذبية.
- مناسبة لمحركات البحث.
- طبيعية وغير مبالغ فيها.
- موجهة لجذب النقرات دون استخدام عناوين مضللة.
- مختلفة في الأسلوب بين: مباشر، تسويقي، واحترافي.
- لا تحتوي على إشارة نقطتين : بل ان تكون جملة واحدة متينة مترابطة.`;

const ENTITY_MAP_SEO_PROMPT = `حلّل المقال من منظور خريطة الكيانات الدلالية SEO / AEO / GEO / LLM SEO، وليس من منظور تكرار الكلمات المفتاحية فقط.

استخدم المرفقات التي اختارها المستخدم فقط من قائمة المرفقات. إذا لم تكن بعض البيانات مرفقة، لا تفترضها، واكتفِ بتحليل ما هو متاح.

المطلوب:

1. استخرج خريطة الكيانات الحالية في المقال، وقسّمها إلى:
- كيانات الخدمة أو المنتج
- كيانات المكان والسوق
- كيانات الجمهور والمشكلة
- كيانات الحلول والميزات
- كيانات الثقة والخبرة والإثبات
- كيانات السعر أو التكلفة إن وجدت
- كيانات الاعتراضات والمخاطر
- كيانات المقارنة والبدائل
- كيانات الأسئلة والنية البحثية

2. لكل كيان اذكر:
- هل هو مذكور أم ناقص؟
- هل ذُكر بشكل كافٍ أم سطحي؟
- أين ظهر داخل المقال إن كان موجودًا؟
- لماذا مهم لمحركات البحث أو للاقتباس من الذكاء الاصطناعي؟

3. استخرج أهم الكيانات الناقصة التي يجب إضافتها، مع ترتيبها حسب الأولوية:
- أولوية عالية
- أولوية متوسطة
- أولوية منخفضة

4. اقترح مكان إضافة كل كيان ناقص داخل المقال:
- بعد أي عنوان؟
- داخل أي فقرة؟
- هل يحتاج جملة فقط أم فقرة قصيرة أم قسم H2/H3 جديد؟

5. اقترح صياغات جاهزة للإضافة:
- 5 جمل قصيرة قابلة للإدراج مباشرة
- 3 فقرات قصيرة قابلة للاقتباس في AI Overviews أو إجابات الذكاء الاصطناعي
- 5 أسئلة FAQ مبنية على الكيانات الناقصة

6. قيّم جاهزية المقال دلاليًا:
- درجة تغطية الكيانات من 100
- أقوى كيان مغطى
- أخطر كيان ناقص
- هل المقال واضح بما يكفي لمحركات البحث ونماذج الذكاء الاصطناعي؟ نعم/جزئيًا/لا، مع السبب

قيود مهمة:
- لا تكرر نصائح عامة.
- لا تقترح كيانات خارج موضوع المقال أو خارج سياق الشركة.
- لا تحشو الكلمات المفتاحية.
- اجعل الإضافات طبيعية ومفيدة للقارئ.
- ركّز على تحسين الفهم، الثقة، الاكتمال، وقابلية الاقتباس.
- أخرج النتيجة بالعربية وبشكل منظم ومباشر.`;

export const ENGINEERING_PROMPT_DEFINITIONS: EngineeringPromptDefinition[] = [
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.entityMap,
    source: 'smartAnalysis',
    labelKey: 'entityMap',
    defaultValue: ENTITY_MAP_SEO_PROMPT,
    options: DEFAULT_SMART_ANALYSIS_OPTIONS,
  },
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.fullArticleAudit,
    source: 'smartAnalysis',
    labelKey: 'analyzeFull',
    defaultValue: FULL_ARTICLE_SEO_AI_AUDIT_PROMPT,
    options: DEFAULT_SMART_ANALYSIS_OPTIONS,
  },
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.contentSummaryForCompetitors,
    source: 'smartAnalysis',
    labelKey: 'contentSummaryForCompetitors',
    defaultValue: CONTENT_SUMMARY_FOR_COMPETITORS_PROMPT,
    options: {
      manualCommand: true,
      articleTitle: false,
      articleToc: false,
      currentConclusion: false,
      editorText: true,
      competitorContent: false,
      targetKeywords: false,
      companyName: false,
      goalContext: false,
      keywordCriteria: false,
      basicStructureCriteria: false,
      headingsSequenceCriteria: false,
      productPageCriteria: false,
      interactionCtaCriteria: false,
      conclusionCriteria: false,
    },
    skipPatchInstructions: true,
    savesContentSummary: true,
  },
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.competitorGapAnalysis,
    source: 'smartAnalysis',
    labelKey: 'competitorGapAnalysis',
    defaultValue: COMPETITOR_GAP_ANALYSIS_PROMPT,
    options: {
      ...DEFAULT_SMART_ANALYSIS_OPTIONS,
      competitorContent: true,
      articleToc: true,
      currentConclusion: true,
      companyName: true,
      keywordCriteria: true,
      basicStructureCriteria: true,
      headingsSequenceCriteria: true,
      productPageCriteria: true,
      interactionCtaCriteria: true,
      conclusionCriteria: true,
    },
  },
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.competitorContentComparison,
    source: 'smartAnalysis',
    labelKey: 'competitorContentComparison',
    defaultValue: COMPETITOR_CONTENT_COMPARISON_PROMPT,
    options: {
      ...DEFAULT_SMART_ANALYSIS_OPTIONS,
      articleToc: false,
      currentConclusion: false,
      competitorContent: true,
      companyName: false,
      keywordCriteria: true,
      basicStructureCriteria: true,
      headingsSequenceCriteria: true,
      productPageCriteria: true,
      interactionCtaCriteria: true,
      conclusionCriteria: false,
    },
  },
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.improveConclusion,
    source: 'smartAnalysis',
    labelKey: 'improveConclusion',
    defaultValue: IMPROVE_CONCLUSION_PROMPT,
    options: {
      manualCommand: true,
      articleTitle: true,
      articleToc: true,
      currentConclusion: true,
      editorText: false,
      targetKeywords: true,
      companyName: true,
      goalContext: true,
      keywordCriteria: false,
      basicStructureCriteria: false,
      headingsSequenceCriteria: false,
      productPageCriteria: false,
      interactionCtaCriteria: false,
      conclusionCriteria: true,
    },
  },
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.improveWeakest,
    source: 'smartAnalysis',
    labelKey: 'improveWeakest',
    defaultValue: `باستخدام بيانات الصفحة، الكلمات، الجمهور، نية البحث، معايير التحليل، ونص المحرر المرفقة تلقائيًا:
حدّد أضعف قسم أو فقرة في المقال من حيث SEO/AEO/GEO/LLM SEO ومطابقة هدف الصفحة.
أخرج فقط:
1. اسم القسم أو بداية الفقرة الضعيفة.
2. سبب الضعف باختصار.
3. نسخة محسنة جاهزة للاستبدال.
4. لماذا النسخة الجديدة أفضل.
لا تقدّم نصائح عامة ولا تقترح صورًا أو فيديوهات أو Schema.`,
    options: DEFAULT_SMART_ANALYSIS_OPTIONS,
  },
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.suggestNewIdea,
    source: 'smartAnalysis',
    labelKey: 'suggestNew',
    defaultValue: `باستخدام بيانات الصفحة، الكلمات، الجمهور، نية البحث، وسياق الهدف والجمهور المرفق تلقائيًا:
اقترح فكرة أو فقرة جديدة غير مذكورة في المقال وتضيف قيمة واضحة للقارئ وتزيد قابلية الاقتباس في AI Overviews.
أخرج فقط:
1. مكان الإضافة المقترح داخل المقال.
2. عنوان فرعي مناسب إن لزم.
3. الفقرة المقترحة جاهزة للإضافة.
4. سبب أهميتها للبحث والقرار والتحويل.
لا تقدّم أكثر من فكرة واحدة ولا تقترح صورًا أو فيديوهات أو Schema.`,
    options: {
      ...DEFAULT_SMART_ANALYSIS_OPTIONS,
      articleToc: true,
      keywordCriteria: true,
      basicStructureCriteria: true,
      headingsSequenceCriteria: true,
      productPageCriteria: true,
      interactionCtaCriteria: true,
    },
  },
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.peopleQuestions,
    source: 'smartAnalysis',
    labelKey: 'peopleQuestions',
    defaultValue: `استخرج أهم أسئلة الباحثين المرتبطة بالكلمة المفتاحية ونية البحث والجمهور المستهدف المرفقين تلقائيًا.
أخرج 10 أسئلة فقط، مع تقسيمها إلى:
- أسئلة قبل القرار.
- أسئلة مقارنة أو اختيار.
- أسئلة تكلفة أو سعر.
- أسئلة اعتراضات أو مخاطر.
لكل سؤال اذكر أين يمكن إضافته داخل المقال باختصار.`,
    options: DEFAULT_SMART_ANALYSIS_OPTIONS,
  },
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.structuredContent,
    source: 'smartAnalysis',
    labelKey: 'structuredContent',
    defaultValue: STRUCTURED_CONTENT_OPPORTUNITIES_PROMPT,
    options: DEFAULT_SMART_ANALYSIS_OPTIONS,
  },
  {
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.unsuitableSections,
    source: 'smartAnalysis',
    labelKey: 'unsuitableSections',
    defaultValue: UNSUITABLE_SECTIONS_AUDIT_PROMPT,
    options: DEFAULT_SMART_ANALYSIS_OPTIONS,
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.suggestHeadings,
    source: 'toolbar',
    labelKey: 'suggestHeadings',
    defaultValue: SUGGEST_HEADINGS_PROMPT,
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.generateMeta,
    source: 'toolbar',
    labelKey: 'generateMeta',
    defaultValue: AI_PROMPTS.GENERATE_META,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.suggestTitle,
    source: 'toolbar',
    labelKey: 'suggestTitle',
    defaultValue: AI_PROMPTS.SUGGEST_TITLE,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.merge,
    source: 'toolbar',
    labelKey: 'merge',
    defaultValue: AI_PROMPTS.MERGE,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.rephrase,
    source: 'toolbar',
    labelKey: 'rephrase',
    defaultValue: AI_PROMPTS.REPHRASE,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.improveWording,
    source: 'toolbar',
    labelKey: 'improveWording',
    defaultValue: AI_PROMPTS.IMPROVE_WORDING,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.simplifyText,
    source: 'toolbar',
    labelKey: 'simplify',
    defaultValue: AI_PROMPTS.SIMPLIFY_TEXT,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.expand,
    source: 'toolbar',
    labelKey: 'expand',
    defaultValue: AI_PROMPTS.EXPAND,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.expand50,
    source: 'toolbar',
    labelKey: 'expand50',
    defaultValue: AI_PROMPTS.EXPAND_50,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.expand100,
    source: 'toolbar',
    labelKey: 'expand100',
    defaultValue: AI_PROMPTS.EXPAND_100,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.summarize,
    source: 'toolbar',
    labelKey: 'summarize',
    defaultValue: AI_PROMPTS.SUMMARIZE,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.summarize50,
    source: 'toolbar',
    labelKey: 'summarize50',
    defaultValue: AI_PROMPTS.SUMMARIZE_50,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.summarize100,
    source: 'toolbar',
    labelKey: 'summarize100',
    defaultValue: AI_PROMPTS.SUMMARIZE_100,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.findStats,
    source: 'toolbar',
    labelKey: 'findStats',
    defaultValue: AI_PROMPTS.FIND_STATS,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.evaluateSection,
    source: 'toolbar',
    labelKey: 'evaluateSection',
    defaultValue: EVALUATE_SECTION_PROMPT,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.toQa,
    source: 'toolbar',
    labelKey: 'toQA',
    defaultValue: AI_PROMPTS.TO_QA,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.toSteps,
    source: 'toolbar',
    labelKey: 'toSteps',
    defaultValue: AI_PROMPTS.TO_STEPS,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.toTable,
    source: 'toolbar',
    labelKey: 'toTable',
    defaultValue: AI_PROMPTS.TO_TABLE,
    variables: ['${selectedText}'],
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.changeTone,
    source: 'toolbar',
    labelKey: 'changeTone',
    defaultValue: AI_PROMPTS.CHANGE_TONE('${tone}'),
    variables: ['${selectedText}', '${tone}'],
  },
];

export const DEFAULT_ENGINEERING_PROMPTS: EngineeringPrompts = ENGINEERING_PROMPT_DEFINITIONS.reduce((acc, definition) => {
  acc[definition.id] = definition.defaultValue;
  return acc;
}, {} as EngineeringPrompts);

const LEGACY_IMPROVE_WORDING_PROMPT = `قم بتحسين صياغة النص التالي لجعله أكثر احترافية وسلاسة، مع الحفاظ على نفس المعنى ونفس عدد الكلمات تقريبًا.\n\nالنص:\n---\n${'${selectedText}'}\n---`;
const LEGACY_SUGGEST_HEADINGS_PROMPT = 'حلل العناوين التالية وقدم 3 بدائل لكل منها.';
const PREVIOUS_GENERATE_META_PROMPT = `قم بتحليل المقال التالي واكتب وصف ميتا (Meta Description) موجزًا ومقنعًا بطول 140-160 حرفًا. استخدم الكلمة المفتاحية الرئيسية، نوع الصفحة، هدفها، الجمهور المستهدف، والعلامة التجارية المرفقة في السياق. أخرج وصفًا واحدًا فقط بدون شرح.\n\nالمقال:\n---\n${'${fullArticleText}'}\n---`;
const PREVIOUS_REPHRASE_PROMPT = `أعد صياغة النص التالي ببراعة ليكون أكثر وضوحًا وجاذبية وتنوعًا في الأسلوب، مع الحفاظ على المعنى الأصلي وأي كلمات مفتاحية موجودة.\n\nالنص:\n---\n${'${selectedText}'}\n---`;
const PREVIOUS_IMPROVE_WORDING_PROMPT = `قم بتحسين صياغة النص التالي لجعله أكثر احترافية وسلاسة، مع الالتزام الصارم بما يلي:
- حافظ على نفس الطول تقريبًا دون توسيع أو اختصار واضح.
- حافظ على جميع الكيانات الموجودة كما هي، مثل أسماء الأشخاص والشركات والمنتجات والخدمات والأماكن والمصطلحات.
- حافظ على نفس الادعاءات والمعلومات والحدود المذكورة في النص، ولا تضف ادعاءات جديدة ولا تحذف ادعاءات موجودة.
- لا تغيّر الأرقام أو النسب أو التواريخ أو أسماء العلامات التجارية.
- حسّن الأسلوب والوضوح فقط دون تغيير المعنى أو نطاق الكلام.

النص:
---
${'${selectedText}'}
---`;
const PREVIOUS_SIMPLIFY_TEXT_PROMPT = `أعد صياغة النص التالي لجعله أبسط وأسهل في الفهم والقراءة، مع الحفاظ على المعنى الأساسي. استخدم مفردات أبسط وجمل أقصر.\n\nالنص:\n---\n${'${selectedText}'}\n---`;
const PREVIOUS_EXPAND_PROMPT = `قم بتوسيع الفكرة التالية لتصبح فقرة كاملة وغنية بالمعلومات والتفاصيل والأمثلة ذات الصلة. اجعلها متماسكة ومقنعة.\n\nالفكرة:\n---\n${'${selectedText}'}\n---`;
const PREVIOUS_EXPAND_50_PROMPT = `قم بتوسيع النص التالي ليصبح أطول بنسبة 50% تقريبًا، مع إضافة تفاصيل وأمثلة ذات الصلة. حافظ على الفكرة الأساسية واجعل النص متماسكًا ومقنعًا.\n\nالنص:\n---\n${'${selectedText}'}\n---`;
const PREVIOUS_EXPAND_100_PROMPT = `قم بتوسيع النص التالي ليصبح ضعف طوله تقريبًا (أطول بنسبة 100%)، مع إضافة معلومات غنية وتفاصيل عميقة وأمثلة توضيحية. حافظ على الفكرة الأساسية واجعل النص متماسكًا ومقنعًا.\n\nالنص:\n---\n${'${selectedText}'}\n---`;
const PREVIOUS_SUMMARIZE_PROMPT = `لخص النص التالي في جملة أو جملتين موجزتين، مع استخلاص الفكرة الأساسية والنقاط الأكثر أهمية.\n\nالنص:\n---\n${'${selectedText}'}\n---`;
const PREVIOUS_SUMMARIZE_50_PROMPT = `لخص النص التالي ليصبح أقصر بنسبة 50% تقريبًا (إلى نصف طوله)، مع الحفاظ على النقاط الأساسية والمعلومات المهمة.\n\nالنص:\n---\n${'${selectedText}'}\n---`;
const PREVIOUS_SUMMARIZE_100_PROMPT = `لخص النص التالي بشكل مكثف جدًا في جملة واحدة فقط، مع استخلاص جوهر الفكرة الأساسية.\n\nالنص:\n---\n${'${selectedText}'}\n---`;
const PREVIOUS_FIND_STATS_PROMPT = `اقترح إحصائية أو مصدرًا موثوقًا يمكن استخدامه لدعم العبارة التالية. استخدم سياق الصفحة والجمهور المرفقين لاختيار مصدر مناسب. إذا لم تكن متأكدًا من رابط محدد، فلا تخترع رابطًا؛ اذكر نوع المصدر المناسب والعبارة الأكثر أمانًا.\n\nالعبارة:\n---\n${'${selectedText}'}\n---`;
const PREVIOUS_TO_QA_PROMPT = `حلل النص التالي وحوله إلى قسم للأسئلة والأجوبة (FAQ). قم بصياغة أسئلة منطقية وذات صلة من المحتوى، وقدم إجابات واضحة وموجزة من النص نفسه. استخدم تنسيق H3 للسؤال وفقرة للإجابة.\n\nالنص:\n---\n${'${selectedText}'}\n---`;
const PREVIOUS_TO_STEPS_PROMPT = `حول النص التالي إلى قائمة خطوات/نقاط عملية ومفصلة.
    القواعد الصارمة للإجابة:
    1. يجب أن تكون النتيجة عبارة عن "قائمة كاملة" في نص واحد.
    2. استخدم تنسيق Markdown للقوائم (ابدأ كل سطر بـ "- " أو "1. " للنقاط).
    3. افصل بين كل خطوة والأخرى بأسطر جديدة (Newlines).
    4. احتفظ بكل تفاصيل النص الأصلي ولا تختصر المعلومات.
    5. ممنوع تقسيم الخطوات إلى مصفوفة JSON، بل ضع القائمة كاملة كنص واحد داخل الاقتراح.

    النص المراد تحويله:
    ---
    ${'${selectedText}'}
    ---`;
const PREVIOUS_TO_TABLE_PROMPT = `قم بتحويل النص التالي الذي يحتوي على مقارنات أو بيانات إلى جدول HTML منظم قابل للإدراج مباشرة في المحرر. أرجع جدول HTML فقط يبدأ بـ <table> وينتهي بـ </table>، بدون شرح، وبدون أسوار كود Markdown مثل \`\`\`html.

النص:
---
${'${selectedText}'}
---`;
const PREVIOUS_CHANGE_TONE_PROMPT = `أعد كتابة النص التالي بالنبرة المحددة: "${'${tone}'}". حافظ على المعنى الأساسي ولكن عدّل الأسلوب والمفردات لتناسب النبرة الجديدة.

النص:
---
${'${selectedText}'}
---`;

const REPLACED_ENGINEERING_PROMPTS: Partial<Record<EngineeringPromptId, string[]>> = {
  [ENGINEERING_PROMPT_IDS.smartAnalysis.competitorGapAnalysis]: [
    PREVIOUS_COMPETITOR_GAP_ANALYSIS_PROMPT,
    PREVIOUS_COMPETITOR_GAP_ANALYSIS_PATCH_PROMPT,
  ],
  [ENGINEERING_PROMPT_IDS.toolbar.generateMeta]: [PREVIOUS_GENERATE_META_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.rephrase]: [PREVIOUS_REPHRASE_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.improveWording]: [LEGACY_IMPROVE_WORDING_PROMPT, PREVIOUS_IMPROVE_WORDING_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.simplifyText]: [PREVIOUS_SIMPLIFY_TEXT_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.expand]: [PREVIOUS_EXPAND_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.expand50]: [PREVIOUS_EXPAND_50_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.expand100]: [PREVIOUS_EXPAND_100_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.summarize]: [PREVIOUS_SUMMARIZE_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.summarize50]: [PREVIOUS_SUMMARIZE_50_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.summarize100]: [PREVIOUS_SUMMARIZE_100_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.findStats]: [PREVIOUS_FIND_STATS_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.toQa]: [PREVIOUS_TO_QA_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.toSteps]: [PREVIOUS_TO_STEPS_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.toTable]: [PREVIOUS_TO_TABLE_PROMPT],
  [ENGINEERING_PROMPT_IDS.toolbar.changeTone]: [PREVIOUS_CHANGE_TONE_PROMPT],
};

const sanitizeEngineeringPrompt = (id: EngineeringPromptId, value: string): string => {
  const replacedPrompts = REPLACED_ENGINEERING_PROMPTS[id] || [];
  if (replacedPrompts.some(prompt => value.trim() === prompt.trim())) {
    return DEFAULT_ENGINEERING_PROMPTS[id];
  }

  if (
    id === ENGINEERING_PROMPT_IDS.toolbar.suggestHeadings &&
    value.trim() === LEGACY_SUGGEST_HEADINGS_PROMPT.trim()
  ) {
    return DEFAULT_ENGINEERING_PROMPTS[id];
  }

  if (id !== ENGINEERING_PROMPT_IDS.smartAnalysis.structuredContent) return value;
  return value.replace(
    /\n+ثالثًا: أفضل 3 فرص ذات أولوية[\s\S]*?رابعًا: ملاحظات تحسين سريعة[\s\S]*?(?=\n+قواعد مهمة:)/,
    '\n'
  );
};

export const normalizeEngineeringPrompts = (prompts?: Partial<EngineeringPrompts> | null): EngineeringPrompts => {
  const normalized = { ...DEFAULT_ENGINEERING_PROMPTS };
  if (!prompts || typeof prompts !== 'object') return normalized;

  for (const definition of ENGINEERING_PROMPT_DEFINITIONS) {
    const value = prompts[definition.id];
    if (typeof value === 'string' && value.trim().length > 0) {
      normalized[definition.id] = sanitizeEngineeringPrompt(definition.id, value);
    }
  }

  return normalized;
};

export const getEngineeringPrompt = (prompts: EngineeringPrompts, id: EngineeringPromptId): string => {
  return prompts[id] || DEFAULT_ENGINEERING_PROMPTS[id] || '';
};

export const renderEngineeringPrompt = (template: string, variables: Record<string, string>): string => {
  return Object.entries(variables).reduce((prompt, [key, value]) => {
    return prompt.replaceAll(`\${${key}}`, value);
  }, template);
};
