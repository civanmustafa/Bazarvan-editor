import { AI_PROMPTS } from './aiPrompts';
import type { AiAnalysisOptions, EngineeringPromptDefinition, EngineeringPromptId, EngineeringPrompts } from '../types';

export const ENGINEERING_PROMPT_PASSWORD = 'Rezan90';

export const ENGINEERING_PROMPT_IDS = {
  smartAnalysis: {
    entityMap: 'smartAnalysis.entityMap',
    fullArticleAudit: 'smartAnalysis.fullArticleAudit',
    improveWeakest: 'smartAnalysis.improveWeakest',
    suggestNewIdea: 'smartAnalysis.suggestNewIdea',
    peopleQuestions: 'smartAnalysis.peopleQuestions',
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
    toQa: 'toolbar.toQa',
    toSteps: 'toolbar.toSteps',
    toTable: 'toolbar.toTable',
    changeTone: 'toolbar.changeTone',
  },
} as const;

export const DEFAULT_SMART_ANALYSIS_OPTIONS: AiAnalysisOptions = {
  manualCommand: true,
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

export const normalizeEngineeringPrompts = (prompts?: Partial<EngineeringPrompts> | null): EngineeringPrompts => {
  const normalized = { ...DEFAULT_ENGINEERING_PROMPTS };
  if (!prompts || typeof prompts !== 'object') return normalized;

  for (const definition of ENGINEERING_PROMPT_DEFINITIONS) {
    const value = prompts[definition.id];
    if (typeof value === 'string' && value.trim().length > 0) {
      normalized[definition.id] = value;
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
