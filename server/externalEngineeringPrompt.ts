import type { ExternalEngineeringCommand } from './externalEngineeringCommands';
import { truncatePromptTextDistributed } from '../utils/promptText.ts';

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

const EXTERNAL_ARTICLE_MAX_CHARS = 20_000;
const EXTERNAL_CONCLUSION_MAX_CHARS = 4_000;
const EXTERNAL_COMPETITOR_TOTAL_MAX_CHARS = 30_000;
const EXTERNAL_COMPETITOR_SINGLE_MAX_CHARS = 15_000;

const truncateText = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength).trim()}\n\n[تم اختصار المدخل.]`;
};

const truncateArticleText = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length <= EXTERNAL_ARTICLE_MAX_CHARS) return trimmed;

  const tailLength = Math.min(
    EXTERNAL_CONCLUSION_MAX_CHARS,
    Math.floor(EXTERNAL_ARTICLE_MAX_CHARS / 4),
  );
  const headLength = EXTERNAL_ARTICLE_MAX_CHARS - tailLength;
  return [
    trimmed.slice(0, headLength).trim(),
    '[تم اختصار منتصف المقال لتخفيف طلب API مع الاحتفاظ بالبداية والنهاية.]',
    trimmed.slice(-tailLength).trim(),
  ].join('\n\n');
};

const formatCompetitorText = (value: string, maxLength: number): string => truncatePromptTextDistributed(
  value,
  maxLength,
  {
    middle: '[تم اختصار جزء من نص المنافس؛ المقطع التالي عينة من الوسط.]',
    tail: '[تم اختصار جزء آخر؛ المقطع التالي من نهاية نص المنافس.]',
  },
)
  .split(/\n{2,}/)
  .map(paragraph => paragraph.trim())
  .filter(Boolean)
  .map((paragraph, index) => `[الفقرة ${index + 1}] ${paragraph}`)
  .join('\n\n');

const buildCompetitorBlocks = (
  texts: string[],
  urls: string[],
): string => {
  const slots = Array.from({ length: Math.max(texts.length, urls.length) }, (_, index) => ({
    index,
    text: texts[index]?.trim() || '',
    url: urls[index]?.trim() || '',
  })).filter(slot => slot.text || slot.url);
  const textSlotCount = slots.filter(slot => slot.text).length;
  const perCompetitorLimit = textSlotCount > 0
    ? Math.min(
        EXTERNAL_COMPETITOR_SINGLE_MAX_CHARS,
        Math.floor(EXTERNAL_COMPETITOR_TOTAL_MAX_CHARS / textSlotCount),
      )
    : 0;

  return slots.map(({ index, text, url }) => [
    `### المنافس ${index + 1}`,
    `الرابط: ${url || '-'}`,
    text ? 'نص الدليل:' : 'يمكن استخدام أداة سياق الروابط لهذا المنافس.',
    text ? formatCompetitorText(text, perCompetitorLimit) : '',
  ].filter(Boolean).join('\n')).join('\n\n');
};

const buildArticleToc = (plainText: string): string => plainText
  .split(/\r?\n/)
  .map(line => line.trim())
  .map(line => line.match(/^(#{1,6})\s+(.+)$/))
  .filter((match): match is RegExpMatchArray => Boolean(match))
  .slice(0, 80)
  .map(match => `${'  '.repeat(Math.max(0, match[1].length - 1))}- ${match[2].trim()}`)
  .join('\n');

const getCurrentConclusion = (plainText: string): string => {
  const trimmed = plainText.trim();
  if (!trimmed) return '';
  return trimmed.length <= EXTERNAL_CONCLUSION_MAX_CHARS
    ? trimmed
    : `[آخر جزء من المقال]\n${trimmed.slice(-EXTERNAL_CONCLUSION_MAX_CHARS).trim()}`;
};

export type ExternalEngineeringPromptMetrics = {
  promptChars: number;
  articleChars: number;
  competitorChars: number;
  usesUrlContextFallback: boolean;
};

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

const buildExternalEngineeringContextParts = (
  command: ExternalEngineeringCommand,
  input: ExternalEngineeringPromptInput,
  options: { includeCompetitors: boolean },
): string[] => {
  const context: string[] = [
    'سياق المقالة:',
    `لغة المقالة: ${input.articleLanguage === 'en' ? 'الإنجليزية' : 'العربية'}`,
  ];

  if (command.options.articleTitle) {
    context.push(`عنوان المقالة: ${input.title || '-'}`);
  }
  if (command.options.targetKeywords) {
    context.push(
      `الكلمة الأساسية: ${input.keywords.primary || '-'}`,
      `الصيغ البديلة: ${input.keywords.secondaries.join('، ') || '-'}`,
      `كلمات LSI: ${input.keywords.lsi.join('، ') || '-'}`,
    );
  }
  if (command.options.companyName) {
    context.push(`الشركة أو العلامة التجارية: ${input.keywords.company || '-'}`);
  }
  if (command.options.goalContext) {
    context.push(`سياق هدف الصفحة والجمهور: ${JSON.stringify(input.goalContext)}`);
  }
  if (command.options.articleToc) {
    context.push(`جدول محتويات المقالة:\n${buildArticleToc(input.plainText) || '- غير متاح من النص المحفوظ.'}`);
  }
  if (command.options.editorText) {
    context.push(`نص المقالة الحالي:\n---\n${truncateArticleText(input.plainText)}\n---`);
  }
  if (command.options.currentConclusion) {
    context.push(`الخاتمة الحالية أو آخر جزء من المقال:\n---\n${getCurrentConclusion(input.plainText) || '-'}\n---`);
  }
  if (options.includeCompetitors && command.options.competitorContent) {
    context.push(`مدخلات المنافسين:\n${buildCompetitorBlocks(input.competitorTexts, input.competitorUrls) || '- لا يوجد نص منافسين مرفق.'}`);
  }
  return context;
};

export const buildExternalEngineeringArticleContext = (
  command: ExternalEngineeringCommand,
  input: ExternalEngineeringPromptInput,
): string => buildExternalEngineeringContextParts(
  command,
  input,
  { includeCompetitors: false },
).join('\n\n');

export const buildExternalEngineeringPrompt = (
  command: ExternalEngineeringCommand,
  input: ExternalEngineeringPromptInput,
  execution: { sequence: number; total: number } = {
    sequence: command.sequence,
    total: 5,
  },
): string => {
  const context = buildExternalEngineeringContextParts(
    command,
    input,
    { includeCompetitors: true },
  );

  return [
    'أنت تنفذ أمرًا هندسيًا محفوظًا ضمن مهمة تحليل خارجية لمقالة.',
    `الأمر ${execution.sequence} من ${execution.total}: ${command.label}`,
    '',
    'تعليمات الأمر المحفوظ:',
    '---',
    command.prompt,
    '---',
    '',
    ...context,
    '',
    EXTERNAL_ENGINEERING_OUTPUT_CONTRACT,
  ].join('\n');
};

export const getExternalEngineeringPromptMetrics = (
  command: ExternalEngineeringCommand,
  input: ExternalEngineeringPromptInput,
  prompt?: string,
): ExternalEngineeringPromptMetrics => {
  const competitorBlocks = command.options.competitorContent
    ? buildCompetitorBlocks(input.competitorTexts, input.competitorUrls)
    : '';
  const hasCompetitorText = command.options.competitorContent
    && input.competitorTexts.some(value => Boolean(value.trim()));
  return {
    promptChars: prompt?.length || buildExternalEngineeringPrompt(command, input).length,
    articleChars: command.options.editorText ? truncateArticleText(input.plainText).length : 0,
    competitorChars: competitorBlocks.length,
    usesUrlContextFallback: command.options.competitorContent
      && !hasCompetitorText
      && input.competitorUrls.some(value => Boolean(value.trim())),
  };
};

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
