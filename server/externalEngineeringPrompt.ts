import type { ExternalEngineeringCommand } from './externalEngineeringCommands';

export type ExternalEngineeringPromptInput = {
  title: string;
  plainText: string;
  articleLanguage: 'ar' | 'en';
  keywords: {
    primary: string;
    secondaries: string[];
    company: string;
    lsi: string[];
  };
  goalContext: Record<string, unknown>;
  competitorUrls: string[];
  competitorTexts: string[];
};

const truncateText = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength).trim()}\n\n[تم اختصار المدخل.]`;
};

const formatCompetitorText = (value: string): string => truncateText(value, 8_000)
  .split(/\n{2,}/)
  .map(paragraph => paragraph.trim())
  .filter(Boolean)
  .map((paragraph, index) => `[الفقرة ${index + 1}] ${paragraph}`)
  .join('\n\n');

const buildCompetitorBlocks = (
  texts: string[],
  urls: string[],
): string => Array.from({ length: Math.max(texts.length, urls.length) }, (_, index) => {
  const text = texts[index]?.trim() || '';
  const url = urls[index]?.trim() || '';
  if (!text && !url) return '';
  return [
    `### المنافس ${index + 1}`,
    `الرابط: ${url || '-'}`,
    text ? 'نص الدليل:' : 'يمكن استخدام أداة سياق الروابط لهذا المنافس.',
    text ? formatCompetitorText(text) : '',
  ].filter(Boolean).join('\n');
}).filter(Boolean).join('\n\n');

export const EXTERNAL_ENGINEERING_OUTPUT_CONTRACT = [
  'أرجع JSON صالحًا فقط، ولا تضع أي نص خارج كائن JSON.',
  'استخدم هذا الشكل الدقيق في المستوى الأعلى:',
  '{"analysisMarkdown":"...","patches":[{"marker":"patch_1","operation":"insert_after_heading","title":"...","anchorText":"...","targetText":"","placementLabel":"...","contentMarkdown":"...","reason":"...","confidence":0.85}]}',
  'يحتوي analysisMarkdown على تقرير تشخيصي مختصر وعلامات [[PATCH:patch_1]] في المواضع المطلوبة فقط.',
  'لا تكرر عنوان بطاقة التعديل أو سببها أو موضعها أو محتواها داخل analysisMarkdown.',
  'اكتب analysisMarkdown وtitle وreason وplacementLabel باللغة العربية.',
  'اكتب contentMarkdown بلغة المقالة، وحافظ على targetText وanchorText حرفيًا كما وردا في المقالة.',
  'العمليات المسموح بها: replace_block وreplace_text وdelete_block وinsert_after_heading وinsert_before_heading وappend_to_section وinsert_before_faq وinsert_before_conclusion وappend_to_article.',
  'استخدم replace_block عند تغيير نص موجود، وضع النص الحالي داخل targetText.',
  'استخدم عملية إضافة فقط للمحتوى الجديد فعلًا.',
  'يجوز لكل بطاقة تعديل أن تحتوي قسم H2 مستقلًا واحدًا فقط، وقسّم الأقسام المتعددة إلى بطاقات منفصلة.',
  'إذا جاء الاقتراح من محتوى منافس، فاذكر رقم المنافس وفقرة الدليل داخل reason.',
  'إذا كان استنتاجًا من الذكاء الاصطناعي، فصرّح بذلك داخل reason بدل اختراع إحالة إلى منافس.',
  'لا تستخدم Markdown العريض داخل analysisMarkdown أو contentMarkdown.',
].join('\n');

export const buildExternalEngineeringPrompt = (
  command: ExternalEngineeringCommand,
  input: ExternalEngineeringPromptInput,
  execution: { sequence: number; total: number } = {
    sequence: command.sequence,
    total: 5,
  },
): string => [
  'أنت تنفذ أمرًا هندسيًا محفوظًا ضمن مهمة تحليل خارجية لمقالة.',
  `الأمر ${execution.sequence} من ${execution.total}: ${command.label}`,
  '',
  'تعليمات الأمر المحفوظ:',
  '---',
  command.prompt,
  '---',
  '',
  'سياق المقالة:',
  `لغة المقالة: ${input.articleLanguage === 'en' ? 'الإنجليزية' : 'العربية'}`,
  `عنوان المقالة: ${input.title}`,
  `الكلمة الأساسية: ${input.keywords.primary}`,
  `الصيغ البديلة: ${input.keywords.secondaries.join('، ')}`,
  `كلمات LSI: ${input.keywords.lsi.join('، ')}`,
  `الشركة أو العلامة التجارية: ${input.keywords.company}`,
  `سياق هدف الصفحة والجمهور: ${JSON.stringify(input.goalContext)}`,
  '',
  'نص المقالة الحالي:',
  '---',
  truncateText(input.plainText, 20_000),
  '---',
  '',
  'مدخلات المنافسين:',
  buildCompetitorBlocks(input.competitorTexts, input.competitorUrls),
  '',
  EXTERNAL_ENGINEERING_OUTPUT_CONTRACT,
].join('\n');

export const buildExternalEngineeringRepairPrompt = (
  previousResponse: string,
): string => [
  'حوّل الرد السابق إلى صيغة JSON الصارمة المطلوبة.',
  'حافظ على التحليل المفيد ونصوص المقالة المقترحة، ولا تضف ادعاءات جديدة.',
  '',
  EXTERNAL_ENGINEERING_OUTPUT_CONTRACT,
  '',
  'الرد السابق:',
  '---',
  truncateText(previousResponse, 20_000),
  '---',
].join('\n');
