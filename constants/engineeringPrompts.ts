import { AI_PROMPTS } from './aiPrompts';
import type { AiAnalysisOptions, EngineeringPromptDefinition, EngineeringPromptId, EngineeringPrompts } from '../types';

export const ENGINEERING_PROMPT_PASSWORD = 'Rezan90';

export const ENGINEERING_PROMPT_IDS = {
  smartAnalysis: {
    entityMap: 'smartAnalysis.entityMap',
    fullArticleAudit: 'smartAnalysis.fullArticleAudit',
    improveConclusion: 'smartAnalysis.improveConclusion',
    improveWeakest: 'smartAnalysis.improveWeakest',
    suggestNewIdea: 'smartAnalysis.suggestNewIdea',
    peopleQuestions: 'smartAnalysis.peopleQuestions',
    structuredContent: 'smartAnalysis.structuredContent',
    unsuitableSections: 'smartAnalysis.unsuitableSections',
    meetingLinks: 'smartAnalysis.meetingLinks',
  },
  toolbar: {
    suggestHeadings: 'toolbar.suggestHeadings',
    generateMeta: 'toolbar.generateMeta',
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
  targetKeywords: true,
  goalContext: true,
  companyName: false,
  keywordCriteria: false,
  basicStructureCriteria: false,
  headingsSequenceCriteria: false,
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

const MEETING_LINKS_TASK_PROMPT = `You are a conversion-focused content editor and UX reviewer.

Review the attached editor text, page goal, audience context, target keywords, and brand/company name when provided.

Task:
Audit the content for places where a meeting link should be added, improved, or made clearer. Include Google Meet, Zoom Meeting, Microsoft Teams, Webex, GoTo Meeting, Whereby, Calendly, booking-calendar links, and any other online meeting or consultation links.

Output in Arabic only, using this exact structure:

1. Existing meeting links:
- List every meeting or booking link you find.
- Identify the platform when possible.
- Mention the surrounding section or CTA.
- Flag broken-looking, vague, duplicated, or poorly placed links.

2. Missing meeting-link opportunities:
- Suggest the best places to add a meeting link.
- Explain the intent of each link: consultation, demo, sales call, support call, interview, onboarding, or follow-up.
- Do not invent a real URL. Use placeholders such as [Google Meet link], [Zoom meeting link], [Teams meeting link], [booking link], or [meeting link].

3. Ready-to-insert CTA copy:
- Provide 3 to 6 short CTA options that can be inserted directly into the article.
- Include variants for Google Meet, Zoom Meeting, Teams/Webex, and a neutral "book a meeting" link.

4. Recommended placement:
- For each suggested CTA, state exactly where it should be inserted in the article.
- Keep recommendations practical and avoid adding too many links.

Rules:
- Do not create fake meeting URLs.
- Keep anchor text clear and trustworthy.
- Prefer one primary meeting CTA plus contextual secondary links when needed.
- If the content is not suitable for meetings, say so and suggest the safest alternative CTA.`;

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
    options: DEFAULT_SMART_ANALYSIS_OPTIONS,
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
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.meetingLinks,
    source: 'smartAnalysis',
    labelKey: 'meetingLinks',
    defaultValue: MEETING_LINKS_TASK_PROMPT,
    options: {
      ...DEFAULT_SMART_ANALYSIS_OPTIONS,
      companyName: true,
      interactionCtaCriteria: true,
    },
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.suggestHeadings,
    source: 'toolbar',
    labelKey: 'suggestHeadings',
    defaultValue: 'حلل العناوين التالية وقدم 3 بدائل لكل منها.',
  },
  {
    id: ENGINEERING_PROMPT_IDS.toolbar.generateMeta,
    source: 'toolbar',
    labelKey: 'generateMeta',
    defaultValue: AI_PROMPTS.GENERATE_META,
    variables: ['${fullArticleText}'],
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

const sanitizeEngineeringPrompt = (id: EngineeringPromptId, value: string): string => {
  if (
    id === ENGINEERING_PROMPT_IDS.toolbar.improveWording &&
    value.trim() === LEGACY_IMPROVE_WORDING_PROMPT.trim()
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
