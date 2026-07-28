import type { GoalContext } from '../types';
import { normalizeGoalContext } from './goalContext';
import type {
  ContentWritingKnowledgeBase,
  ContentWritingSourceChunk,
} from './contentWritingKnowledge';

export const CONTENT_WRITING_FAQ_INDEPENDENCE_VERSION = 1;
export const CONTENT_WRITING_FAQ_MAX_ACCEPTED_QUESTIONS = 6;
export const CONTENT_WRITING_FAQ_BODY_DUPLICATE_THRESHOLD = 0.74;
export const CONTENT_WRITING_FAQ_PAIR_DUPLICATE_THRESHOLD = 0.68;

export type ContentWritingFaqIntent =
  | 'selection'
  | 'compatibility'
  | 'usage'
  | 'purchase'
  | 'payment'
  | 'shipping'
  | 'returns'
  | 'warranty'
  | 'pricing'
  | 'requirements'
  | 'process'
  | 'timing'
  | 'troubleshooting'
  | 'safety'
  | 'comparison'
  | 'eligibility'
  | 'support'
  | 'implications'
  | 'privacy'
  | 'cancellation'
  | 'other';

export type ContentWritingFaqQuestionSeedSource =
  | 'people_also_ask'
  | 'competitor_question'
  | 'knowledge_matrix'
  | 'page_context';

export type ContentWritingFaqQuestionSeed = {
  id: string;
  question: string;
  sourceType: ContentWritingFaqQuestionSeedSource;
  sourceChunkIds: string[];
  knowledgeItemIds: string[];
};

export type ContentWritingFaqIntentBlueprint = {
  intent: ContentWritingFaqIntent;
  labelAr: string;
  labelEn: string;
  guidanceAr: string;
  guidanceEn: string;
};

export type ContentWritingFaqCandidateDecision =
  | 'accepted'
  | 'rejected'
  | 'needs_information';

export type ContentWritingFaqCandidateSource =
  | ContentWritingFaqQuestionSeedSource
  | 'goal_based_extension';

export type ContentWritingFaqCandidate = {
  id: string;
  question: string;
  answer: string;
  intent: ContentWritingFaqIntent;
  sourceType: ContentWritingFaqCandidateSource;
  sourceLabel: string;
  decision: ContentWritingFaqCandidateDecision;
  decisionReason: string;
  newInformation: string[];
  nearestArticleExcerpt: string;
  informationGainScore: number;
  bodySimilarityScore: number;
  faqSimilarityScore: number;
  evidenceIdeaIds: string[];
  usedClaimIds: string[];
  sourceChunkIds: string[];
  guardReasons: string[];
};

export type ContentWritingFaqAudit = {
  version: number;
  pageType: string;
  intentBlueprints: ContentWritingFaqIntentBlueprint[];
  questionSeeds: ContentWritingFaqQuestionSeed[];
  candidates: ContentWritingFaqCandidate[];
  acceptedCount: number;
  rejectedCount: number;
  needsInformationCount: number;
  acceptedQuestionIds: string[];
};

export type ContentWritingFaqDraftEntry = {
  question: string;
  answer: string;
};

export type ContentWritingFaqDraftIndependence = {
  faqFound: boolean;
  entries: ContentWritingFaqDraftEntry[];
  bodyDuplicateQuestions: string[];
  faqDuplicateQuestions: string[];
  maximumBodySimilarity: number;
  maximumFaqSimilarity: number;
  passed: boolean;
};

export type ContentWritingFaqRevisionGuard = {
  accepted: boolean;
  reasons: string[];
  before: ContentWritingFaqDraftIndependence;
  after: ContentWritingFaqDraftIndependence;
  addedQuestions: string[];
  removedQuestions: string[];
};

const ARABIC_STOP_WORDS = new Set([
  'في', 'من', 'على', 'الى', 'إلى', 'عن', 'ما', 'ماذا', 'متى', 'كيف', 'هل', 'اي', 'أي',
  'او', 'أو', 'ثم', 'و', 'ف', 'ب', 'ك', 'ل', 'التي', 'الذي', 'هذا', 'هذه', 'ذلك', 'تلك',
  'هو', 'هي', 'هم', 'مع', 'عند', 'بعد', 'قبل', 'بين', 'كل', 'يمكن', 'يتم', 'تكون', 'يكون',
  'لدى', 'ضمن', 'عبر', 'قد', 'إذا', 'اذا', 'لم', 'لن', 'لا', 'نعم', 'هناك', 'المتاح', 'المتاحة',
]);

const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'can', 'do', 'does',
  'for', 'from', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the',
  'this', 'to', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your',
]);

const SEMANTIC_TOKEN_GROUPS: Array<[string, string[]]> = [
  ['payment', ['دفع', 'الدفع', 'سداد', 'السداد', 'تقسيط', 'بطاقه', 'بطاقة', 'تحويل', 'payment', 'pay', 'installment', 'card']],
  ['purchase', ['شراء', 'الشراء', 'طلب', 'الطلب', 'اقتناء', 'buy', 'purchase', 'order']],
  ['shipping', ['شحن', 'الشحن', 'توصيل', 'التوصيل', 'استلام', 'delivery', 'shipping', 'receive']],
  ['return', ['ارجاع', 'إرجاع', 'استرجاع', 'استرداد', 'refund', 'return', 'exchange']],
  ['warranty', ['ضمان', 'الضمان', 'كفاله', 'كفالة', 'warranty', 'guarantee']],
  ['usage', ['استخدام', 'الاستخدام', 'استعمال', 'تشغيل', 'العنايه', 'العناية', 'use', 'usage', 'operate', 'care']],
  ['compatibility', ['توافق', 'التوافق', 'متوافق', 'يناسب', 'ملائم', 'compatibility', 'compatible', 'fit']],
  ['size', ['مقاس', 'المقاس', 'حجم', 'الحجم', 'سعه', 'سعة', 'size', 'capacity']],
  ['price', ['سعر', 'السعر', 'تكلفه', 'تكلفة', 'التكلفه', 'التكلفة', 'price', 'cost']],
  ['duration', ['مده', 'مدة', 'المده', 'المدة', 'وقت', 'موعد', 'duration', 'time', 'schedule']],
  ['requirements', ['متطلبات', 'المتطلبات', 'شروط', 'الشروط', 'وثائق', 'requirements', 'prerequisites', 'documents']],
  ['problem', ['مشكله', 'مشكلة', 'خطا', 'خطأ', 'تعطل', 'فشل', 'problem', 'issue', 'error', 'troubleshoot']],
];

const FAQ_INTENTS = new Set<ContentWritingFaqIntent>([
  'selection',
  'compatibility',
  'usage',
  'purchase',
  'payment',
  'shipping',
  'returns',
  'warranty',
  'pricing',
  'requirements',
  'process',
  'timing',
  'troubleshooting',
  'safety',
  'comparison',
  'eligibility',
  'support',
  'implications',
  'privacy',
  'cancellation',
  'other',
]);

const SOURCE_TYPES = new Set<ContentWritingFaqCandidateSource>([
  'people_also_ask',
  'competitor_question',
  'knowledge_matrix',
  'page_context',
  'goal_based_extension',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown, maximum = 4_000): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const uniqueTextList = (
  value: unknown,
  maximumItems = 100,
  maximumLength = 500,
): string[] => Array.isArray(value)
  ? Array.from(new Set(
      value.map(item => toText(item, maximumLength)).filter(Boolean),
    )).slice(0, maximumItems)
  : [];

const clampScore = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number > 1 ? number / 100 : number));
};

const stripCodeFence = (value: string): string => value
  .trim()
  .replace(/^```(?:json|markdown|md)?\s*/i, '')
  .replace(/\s*```$/i, '')
  .trim();

const parseJsonObject = (value: unknown): Record<string, unknown> | null => {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = stripCodeFence(value);
  const candidates = [normalized];
  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  return null;
};

const normalizeArabic = (value: string): string => value
  .normalize('NFKD')
  .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ؤ/g, 'و')
  .replace(/ئ/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/ـ/g, '');

export const normalizeContentWritingFaqText = (value: string): string => (
  normalizeArabic(String(value || '').toLocaleLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
);

const canonicalizeToken = (value: string): string => {
  const normalized = normalizeContentWritingFaqText(value);
  const semanticGroup = SEMANTIC_TOKEN_GROUPS.find(([, variants]) => (
    variants.some(variant => normalizeContentWritingFaqText(variant) === normalized)
  ));
  return semanticGroup?.[0] || normalized;
};

const contentTokens = (value: string): Set<string> => new Set(
  normalizeContentWritingFaqText(value)
    .split(' ')
    .map(canonicalizeToken)
    .filter(token => (
      token.length >= 2
      && !ARABIC_STOP_WORDS.has(token)
      && !ENGLISH_STOP_WORDS.has(token)
    )),
);

export const calculateContentWritingFaqSimilarity = (
  left: string,
  right: string,
): number => {
  const leftTokens = contentTokens(left);
  const rightTokens = contentTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  leftTokens.forEach(token => {
    if (rightTokens.has(token)) intersection += 1;
  });
  const union = leftTokens.size + rightTokens.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const overlap = intersection / Math.min(leftTokens.size, rightTokens.size);
  return Number(((jaccard * 0.6) + (overlap * 0.4)).toFixed(3));
};

const plainMarkdown = (value: string): string => value
  .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/^\s{0,3}#{1,6}\s+/gm, '')
  .replace(/^\s*(?:[-+*•]|\d+[.)])\s+/gm, '')
  .replace(/[*_`~|]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const articleSegments = (markdown: string): string[] => (
  String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n|\n(?=#{1,6}\s)|\n(?=\|)/)
    .map(plainMarkdown)
    .filter(segment => contentTokens(segment).size >= 3)
    .slice(0, 500)
);

const maximumSimilarity = (value: string, segments: readonly string[]): number => (
  segments.reduce(
    (maximum, segment) => Math.max(maximum, calculateContentWritingFaqSimilarity(value, segment)),
    0,
  )
);

const hasQuestionShape = (value: string): boolean => {
  const normalized = normalizeContentWritingFaqText(value);
  if (!normalized || normalized.length < 8 || normalized.length > 300) return false;
  return /[؟?]\s*$/.test(value)
    || /^(?:هل|كيف|ما|ماذا|متى|اين|أين|لماذا|كم|اي|أي|من|what|how|when|where|why|which|who|can|does|do|is|are)\b/iu.test(normalized);
};

const normalizeQuestion = (value: string): string => (
  toText(value, 300)
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^[\-*•\d.)\s]+/, '')
    .trim()
);

const isPaaMarker = (value: string): boolean => (
  /(?:people\s+also\s+ask|people\s+also\s+search|أسئلة\s+يطرحها\s+الآخرون|يسأل\s+الناس\s+أيض)/iu.test(value)
);

export const extractContentWritingFaqQuestionSeeds = (options: {
  knowledge: ContentWritingKnowledgeBase;
  chunks: readonly ContentWritingSourceChunk[];
  goalContext?: Partial<GoalContext> | null;
  maximum?: number;
}): ContentWritingFaqQuestionSeed[] => {
  const maximum = Math.max(1, Math.min(100, Math.round(options.maximum || 50)));
  const seeds: ContentWritingFaqQuestionSeed[] = [];
  const seen = new Set<string>();
  const add = (
    question: string,
    sourceType: ContentWritingFaqQuestionSeedSource,
    sourceChunkIds: string[] = [],
    knowledgeItemIds: string[] = [],
  ): void => {
    const normalizedQuestion = normalizeQuestion(question);
    const key = normalizeContentWritingFaqText(normalizedQuestion);
    if (!hasQuestionShape(normalizedQuestion) || seen.has(key) || seeds.length >= maximum) return;
    seen.add(key);
    seeds.push({
      id: `FQS${String(seeds.length + 1).padStart(3, '0')}`,
      question: normalizedQuestion,
      sourceType,
      sourceChunkIds: Array.from(new Set(sourceChunkIds)),
      knowledgeItemIds: Array.from(new Set(knowledgeItemIds)),
    });
  };

  options.knowledge.items.forEach(item => {
    if (hasQuestionShape(item.topic)) {
      add(
        item.topic,
        /(?:people.?also.?ask|paa)/iu.test(item.kind)
          ? 'people_also_ask'
          : 'knowledge_matrix',
        item.sourceChunkIds,
        [item.id],
      );
    }
  });

  options.chunks.forEach(chunk => {
    const lines = chunk.text.replace(/\r\n?/g, '\n').split('\n');
    let paaWindow = 0;
    lines.forEach(line => {
      const trimmed = line.trim();
      if (isPaaMarker(trimmed)) {
        paaWindow = 8;
        return;
      }
      if (hasQuestionShape(trimmed)) {
        add(
          trimmed,
          paaWindow > 0 ? 'people_also_ask' : 'competitor_question',
          [chunk.id],
        );
      }
      if (paaWindow > 0) paaWindow -= 1;
    });
  });

  const normalizedGoal = normalizeGoalContext(options.goalContext);
  [
    normalizedGoal.audienceNeeds,
    normalizedGoal.readerOutcome,
    normalizedGoal.generatedBrief,
  ].forEach(value => {
    String(value || '')
      .split(/\r?\n|(?<=[؟?])\s+/)
      .forEach(question => add(question, 'page_context'));
  });
  return seeds;
};

const blueprint = (
  intent: ContentWritingFaqIntent,
  labelAr: string,
  labelEn: string,
  guidanceAr: string,
  guidanceEn: string,
): ContentWritingFaqIntentBlueprint => ({
  intent,
  labelAr,
  labelEn,
  guidanceAr,
  guidanceEn,
});

const COMMON_BLUEPRINTS: Record<string, ContentWritingFaqIntentBlueprint> = {
  selection: blueprint('selection', 'الاختيار', 'Selection', 'قاعدة عملية تساعد القارئ على اختيار الأنسب لحالته.', 'A practical rule for choosing the best fit.'),
  compatibility: blueprint('compatibility', 'التوافق', 'Compatibility', 'التوافق مع استخدام أو جهاز أو خيار آخر.', 'Compatibility with another use, device, or option.'),
  usage: blueprint('usage', 'الاستخدام والعناية', 'Usage and care', 'حالة استخدام أو عناية أو خطأ تطبيقي لم يشرحها المتن.', 'A usage, care, or application edge case not covered in the body.'),
  purchase: blueprint('purchase', 'الشراء والطلب', 'Purchase and ordering', 'خطوة أو شرط عملي في مسار الشراء.', 'A practical step or condition in the buying path.'),
  payment: blueprint('payment', 'الدفع', 'Payment', 'تفصيل موثق عن وسيلة الدفع أو توقيت التأكيد أو القيود.', 'A supported detail about payment methods, confirmation, or limits.'),
  shipping: blueprint('shipping', 'الشحن والاستلام', 'Shipping and delivery', 'تفصيل موثق عن الشحن أو التتبع أو الاستلام.', 'A supported shipping, tracking, or delivery detail.'),
  returns: blueprint('returns', 'الإرجاع والاستبدال', 'Returns and exchanges', 'شرط أو حالة موثقة للإرجاع أو الاستبدال.', 'A supported return or exchange condition.'),
  warranty: blueprint('warranty', 'الضمان', 'Warranty', 'نطاق الضمان أو الاستثناءات أو طريقة المطالبة.', 'Warranty coverage, exclusions, or claim steps.'),
  pricing: blueprint('pricing', 'السعر والتكلفة', 'Price and cost', 'عامل موثق يؤثر في السعر بدل تكرار رقم ظاهر.', 'A supported factor affecting price rather than repeating a visible number.'),
  requirements: blueprint('requirements', 'المتطلبات', 'Requirements', 'المتطلبات أو الوثائق أو التجهيزات السابقة.', 'Prerequisites, documents, or preparation.'),
  process: blueprint('process', 'آلية التنفيذ', 'Process', 'ما يحدث في مرحلة محددة أو بعد الطلب.', 'What happens at a specific stage or after ordering.'),
  timing: blueprint('timing', 'المدة والتوقيت', 'Timing', 'عامل أو حالة تؤثر في المدة أو الموعد.', 'A factor or edge case affecting duration or timing.'),
  troubleshooting: blueprint('troubleshooting', 'حل المشكلات', 'Troubleshooting', 'ما الذي يفعله المستخدم عند فشل المسار المعتاد.', 'What to do when the normal path fails.'),
  safety: blueprint('safety', 'السلامة والاستثناءات', 'Safety and exceptions', 'حالة عدم ملاءمة أو تحذير موثق.', 'A supported unsuitable case, exception, or warning.'),
  comparison: blueprint('comparison', 'المقارنة والقرار', 'Comparison and decision', 'قاعدة قرار لحالة استخدام محددة.', 'A decision rule for a specific use case.'),
  eligibility: blueprint('eligibility', 'الأهلية والملاءمة', 'Eligibility and fit', 'لمن يناسب العرض أو الخدمة ولمن لا يناسب.', 'Who the offer or service fits and who it does not.'),
  support: blueprint('support', 'الدعم والمتابعة', 'Support and follow-up', 'الدعم المتاح أو ما يحدث بعد التنفيذ.', 'Available support or what happens after completion.'),
  implications: blueprint('implications', 'الآثار العملية', 'Practical implications', 'ما الذي يعنيه التطور فعليًا لفئة محددة.', 'What a development practically means for a specific audience.'),
  privacy: blueprint('privacy', 'الخصوصية', 'Privacy', 'كيفية التعامل مع البيانات إذا كان ذلك موثقًا.', 'How data is handled when supported by evidence.'),
  cancellation: blueprint('cancellation', 'الإلغاء', 'Cancellation', 'شروط أو خطوات الإلغاء الموثقة.', 'Supported cancellation conditions or steps.'),
};

const PAGE_TYPE_INTENTS: Record<string, ContentWritingFaqIntent[]> = {
  product: ['selection', 'compatibility', 'usage', 'payment', 'shipping', 'returns', 'warranty', 'safety'],
  service: ['eligibility', 'requirements', 'process', 'timing', 'pricing', 'support', 'cancellation', 'payment'],
  category: ['selection', 'comparison', 'compatibility', 'pricing', 'purchase', 'shipping', 'returns'],
  landing: ['eligibility', 'process', 'pricing', 'privacy', 'cancellation', 'support', 'requirements'],
  article: ['troubleshooting', 'safety', 'comparison', 'requirements', 'process', 'support'],
  guide: ['troubleshooting', 'usage', 'safety', 'requirements', 'comparison', 'support'],
  comparison: ['comparison', 'selection', 'compatibility', 'pricing', 'usage', 'support'],
  news: ['implications', 'timing', 'eligibility', 'process', 'safety', 'support'],
};

export const getContentWritingFaqIntentBlueprints = (
  goalContext?: Partial<GoalContext> | null,
): ContentWritingFaqIntentBlueprint[] => {
  const pageType = normalizeGoalContext(goalContext).pageType;
  return (PAGE_TYPE_INTENTS[pageType] || PAGE_TYPE_INTENTS.article)
    .map(intent => COMMON_BLUEPRINTS[intent])
    .filter(Boolean);
};

const sourceLabel = (sourceType: ContentWritingFaqCandidateSource): string => {
  const labels: Record<ContentWritingFaqCandidateSource, string> = {
    people_also_ask: 'People Also Ask',
    competitor_question: 'Competitor question',
    knowledge_matrix: 'Knowledge matrix',
    page_context: 'Page context',
    goal_based_extension: 'Goal-based extension',
  };
  return labels[sourceType];
};

const normalizeIntent = (value: unknown): ContentWritingFaqIntent => {
  const intent = toText(value, 80) as ContentWritingFaqIntent;
  return FAQ_INTENTS.has(intent) ? intent : 'other';
};

const normalizeSourceType = (value: unknown): ContentWritingFaqCandidateSource => {
  const sourceType = toText(value, 80) as ContentWritingFaqCandidateSource;
  return SOURCE_TYPES.has(sourceType) ? sourceType : 'goal_based_extension';
};

const deriveSourceChunkIds = (
  evidenceIdeaIds: readonly string[],
  usedClaimIds: readonly string[],
  declaredChunkIds: readonly string[],
  knowledge: ContentWritingKnowledgeBase,
): string[] => {
  const result = new Set(declaredChunkIds);
  knowledge.items
    .filter(item => evidenceIdeaIds.includes(item.id))
    .flatMap(item => item.sourceChunkIds)
    .forEach(id => result.add(id));
  knowledge.claimLedger.claims
    .filter(claim => usedClaimIds.includes(claim.id))
    .flatMap(claim => claim.supportingSourceChunkIds)
    .forEach(id => result.add(id));
  return Array.from(result);
};

export const normalizeContentWritingFaqAudit = (options: {
  value: unknown;
  draft: string;
  knowledge: ContentWritingKnowledgeBase;
  chunks: readonly ContentWritingSourceChunk[];
  goalContext?: Partial<GoalContext> | null;
  questionSeeds?: readonly ContentWritingFaqQuestionSeed[];
}): ContentWritingFaqAudit => {
  const source = parseJsonObject(options.value);
  if (!source || !Array.isArray(source.candidates)) {
    throw new Error('The FAQ stage must return a structured candidate audit.');
  }
  const normalizedGoal = normalizeGoalContext(options.goalContext);
  const validIdeaIds = new Set(options.knowledge.items.map(item => item.id));
  const validClaimIds = new Set(options.knowledge.claimLedger.claims.map(claim => claim.id));
  const blockedClaimIds = new Set(options.knowledge.claimLedger.blockedClaimIds);
  const validChunkIds = new Set(options.chunks.map(chunk => chunk.id));
  const bodySegments = articleSegments(options.draft);
  const verifiedPaaQuestions = new Set(
    Array.from(options.questionSeeds || [])
      .filter(seed => seed.sourceType === 'people_also_ask')
      .map(seed => normalizeContentWritingFaqText(seed.question)),
  );
  const acceptedByIntent = new Set<ContentWritingFaqIntent>();
  const acceptedCandidates: ContentWritingFaqCandidate[] = [];
  const candidates: ContentWritingFaqCandidate[] = [];

  source.candidates.slice(0, 30).forEach((item, index) => {
    if (!isRecord(item)) return;
    const question = normalizeQuestion(toText(item.question, 300));
    if (!question) return;
    const answer = toText(item.answer, 4_000);
    const intent = normalizeIntent(item.intent);
    const declaredSourceType = normalizeSourceType(item.sourceType);
    const candidateSourceType = declaredSourceType === 'people_also_ask'
      && !verifiedPaaQuestions.has(normalizeContentWritingFaqText(question))
      ? 'goal_based_extension'
      : declaredSourceType;
    const evidenceIdeaIds = uniqueTextList(item.evidenceIdeaIds, 100, 120)
      .filter(id => validIdeaIds.has(id));
    const usedClaimIds = uniqueTextList(item.usedClaimIds, 100, 120)
      .filter(id => validClaimIds.has(id));
    const declaredChunkIds = uniqueTextList(item.sourceChunkIds, 100, 120)
      .filter(id => validChunkIds.has(id));
    const sourceChunkIds = deriveSourceChunkIds(
      evidenceIdeaIds,
      usedClaimIds,
      declaredChunkIds,
      options.knowledge,
    ).filter(id => validChunkIds.has(id));
    const newInformation = uniqueTextList(item.newInformation, 12, 500);
    const nearestArticleExcerpt = toText(item.nearestArticleExcerpt, 800);
    const declaredDecision = toText(item.decision, 40) as ContentWritingFaqCandidateDecision;
    const guardReasons: string[] = [];
    const bodySimilarityScore = Math.max(
      clampScore(item.bodySimilarityScore),
      maximumSimilarity(answer || question, bodySegments),
    );
    const informationGainScore = clampScore(item.informationGainScore);
    let faqSimilarityScore = 0;
    acceptedCandidates.forEach(previous => {
      faqSimilarityScore = Math.max(
        faqSimilarityScore,
        calculateContentWritingFaqSimilarity(
          `${question} ${answer}`,
          `${previous.question} ${previous.answer}`,
        ),
      );
    });

    if (!['accepted', 'rejected', 'needs_information'].includes(declaredDecision)) {
      guardReasons.push('invalid_model_decision');
    }
    if (declaredDecision === 'accepted' && !answer) guardReasons.push('answer_missing');
    if (declaredDecision === 'accepted' && newInformation.length === 0) {
      guardReasons.push('no_new_information_declared');
    }
    if (
      declaredDecision === 'accepted'
      && evidenceIdeaIds.length === 0
      && usedClaimIds.length === 0
      && sourceChunkIds.length === 0
    ) {
      guardReasons.push('evidence_missing');
    }
    if (usedClaimIds.some(id => blockedClaimIds.has(id))) {
      guardReasons.push('blocked_claim');
    }
    if (declaredDecision === 'accepted' && informationGainScore < 0.4) {
      guardReasons.push('information_gain_too_low');
    }
    if (declaredDecision === 'accepted' && bodySimilarityScore >= CONTENT_WRITING_FAQ_BODY_DUPLICATE_THRESHOLD) {
      guardReasons.push('duplicates_article_body');
    }
    if (declaredDecision === 'accepted' && faqSimilarityScore >= CONTENT_WRITING_FAQ_PAIR_DUPLICATE_THRESHOLD) {
      guardReasons.push('duplicates_another_faq');
    }
    if (declaredDecision === 'accepted' && acceptedByIntent.has(intent)) {
      guardReasons.push('duplicate_intent');
    }
    if (
      declaredDecision === 'accepted'
      && acceptedCandidates.length >= CONTENT_WRITING_FAQ_MAX_ACCEPTED_QUESTIONS
    ) {
      guardReasons.push('accepted_limit_reached');
    }

    let decision: ContentWritingFaqCandidateDecision = declaredDecision;
    if (!['accepted', 'rejected', 'needs_information'].includes(decision)) decision = 'rejected';
    if (guardReasons.includes('evidence_missing') || guardReasons.includes('answer_missing')) {
      decision = 'needs_information';
    } else if (guardReasons.length > 0) {
      decision = 'rejected';
    }
    const candidate: ContentWritingFaqCandidate = {
      id: toText(item.id, 80) || `FAQC${String(index + 1).padStart(3, '0')}`,
      question,
      answer: decision === 'accepted' ? answer : '',
      intent,
      sourceType: candidateSourceType,
      sourceLabel: toText(item.sourceLabel, 300) || sourceLabel(candidateSourceType),
      decision,
      decisionReason: toText(item.decisionReason, 1_000)
        || (guardReasons.length > 0 ? guardReasons.join(', ') : 'model_decision'),
      newInformation,
      nearestArticleExcerpt,
      informationGainScore,
      bodySimilarityScore,
      faqSimilarityScore,
      evidenceIdeaIds,
      usedClaimIds,
      sourceChunkIds,
      guardReasons,
    };
    candidates.push(candidate);
    if (candidate.decision === 'accepted') {
      acceptedCandidates.push(candidate);
      acceptedByIntent.add(candidate.intent);
    }
  });

  if (acceptedCandidates.length === 0) {
    throw new Error('The FAQ audit did not contain any independent, evidence-backed question.');
  }
  return {
    version: CONTENT_WRITING_FAQ_INDEPENDENCE_VERSION,
    pageType: normalizedGoal.pageType,
    intentBlueprints: getContentWritingFaqIntentBlueprints(normalizedGoal),
    questionSeeds: Array.from(options.questionSeeds || []),
    candidates,
    acceptedCount: acceptedCandidates.length,
    rejectedCount: candidates.filter(candidate => candidate.decision === 'rejected').length,
    needsInformationCount: candidates.filter(candidate => candidate.decision === 'needs_information').length,
    acceptedQuestionIds: acceptedCandidates.map(candidate => candidate.id),
  };
};

export const contentWritingFaqAuditToMarkdown = (
  audit: ContentWritingFaqAudit,
): string => audit.candidates
  .filter(candidate => candidate.decision === 'accepted')
  .map(candidate => `### ${candidate.question}\n\n${candidate.answer}`)
  .join('\n\n');

const faqRegionPattern = /^##[ \t]+(?:.*(?:الأسئلة\s+الشائعة|اسئلة\s+شائعة|frequently\s+asked|faq).*)\s*$/imu;

const splitFaqRegion = (markdown: string): { body: string; faq: string } => {
  const normalized = String(markdown || '').replace(/\r\n?/g, '\n');
  const match = faqRegionPattern.exec(normalized);
  if (!match) return { body: normalized, faq: '' };
  const start = match.index;
  const restStart = start + match[0].length;
  const nextH2 = /^##[ \t]+\S.*$/gm;
  nextH2.lastIndex = restStart;
  const nextMatch = nextH2.exec(normalized);
  const end = nextMatch?.index ?? normalized.length;
  return {
    body: `${normalized.slice(0, start)}\n${normalized.slice(end)}`.trim(),
    faq: normalized.slice(restStart, end).trim(),
  };
};

export const extractContentWritingFaqEntries = (
  markdown: string,
): ContentWritingFaqDraftEntry[] => {
  const { faq } = splitFaqRegion(markdown);
  if (!faq) return [];
  const headings: Array<{ question: string; start: number; contentStart: number }> = [];
  const pattern = /^###[ \t]+(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(faq)) !== null) {
    headings.push({
      question: normalizeQuestion(match[1]),
      start: match.index,
      contentStart: pattern.lastIndex,
    });
  }
  return headings.map((heading, index) => ({
    question: heading.question,
    answer: plainMarkdown(
      faq.slice(heading.contentStart, headings[index + 1]?.start ?? faq.length),
    ),
  })).filter(entry => entry.question && entry.answer);
};

export const evaluateContentWritingFaqDraftIndependence = (
  markdown: string,
): ContentWritingFaqDraftIndependence => {
  const region = splitFaqRegion(markdown);
  const entries = extractContentWritingFaqEntries(markdown);
  const bodySegments = articleSegments(region.body);
  const bodyDuplicateQuestions: string[] = [];
  const faqDuplicateQuestions: string[] = [];
  let maximumBodySimilarity = 0;
  let maximumFaqSimilarity = 0;
  entries.forEach((entry, index) => {
    const bodySimilarity = maximumSimilarity(entry.answer, bodySegments);
    maximumBodySimilarity = Math.max(maximumBodySimilarity, bodySimilarity);
    if (bodySimilarity >= CONTENT_WRITING_FAQ_BODY_DUPLICATE_THRESHOLD) {
      bodyDuplicateQuestions.push(entry.question);
    }
    entries.slice(0, index).forEach(previous => {
      const faqSimilarity = calculateContentWritingFaqSimilarity(
        `${entry.question} ${entry.answer}`,
        `${previous.question} ${previous.answer}`,
      );
      maximumFaqSimilarity = Math.max(maximumFaqSimilarity, faqSimilarity);
      if (faqSimilarity >= CONTENT_WRITING_FAQ_PAIR_DUPLICATE_THRESHOLD) {
        faqDuplicateQuestions.push(entry.question);
      }
    });
  });
  return {
    faqFound: Boolean(region.faq),
    entries,
    bodyDuplicateQuestions: Array.from(new Set(bodyDuplicateQuestions)),
    faqDuplicateQuestions: Array.from(new Set(faqDuplicateQuestions)),
    maximumBodySimilarity: Number(maximumBodySimilarity.toFixed(3)),
    maximumFaqSimilarity: Number(maximumFaqSimilarity.toFixed(3)),
    passed: Boolean(region.faq)
      && entries.length > 0
      && bodyDuplicateQuestions.length === 0
      && faqDuplicateQuestions.length === 0,
  };
};

const questionKeys = (entries: readonly ContentWritingFaqDraftEntry[]): Map<string, string> => new Map(
  entries.map(entry => [normalizeContentWritingFaqText(entry.question), entry.question]),
);

export const evaluateContentWritingFaqRevision = (options: {
  beforeMarkdown: string;
  candidateMarkdown: string;
  audit?: ContentWritingFaqAudit | null;
}): ContentWritingFaqRevisionGuard => {
  const before = evaluateContentWritingFaqDraftIndependence(options.beforeMarkdown);
  const after = evaluateContentWritingFaqDraftIndependence(options.candidateMarkdown);
  const beforeQuestions = questionKeys(before.entries);
  const afterQuestions = questionKeys(after.entries);
  const auditedQuestions = new Set(
    (options.audit?.candidates || [])
      .filter(candidate => candidate.decision === 'accepted')
      .map(candidate => normalizeContentWritingFaqText(candidate.question)),
  );
  const addedQuestions = Array.from(afterQuestions.entries())
    .filter(([key]) => !beforeQuestions.has(key))
    .map(([, question]) => question);
  const removedQuestions = Array.from(beforeQuestions.entries())
    .filter(([key]) => !afterQuestions.has(key))
    .map(([, question]) => question);
  const reasons: string[] = [];
  if (!after.faqFound || after.entries.length === 0) reasons.push('faq_removed');
  if (after.bodyDuplicateQuestions.length > before.bodyDuplicateQuestions.length) {
    reasons.push('faq_body_duplication_increased');
  }
  if (after.faqDuplicateQuestions.length > before.faqDuplicateQuestions.length) {
    reasons.push('faq_internal_duplication_increased');
  }
  if (
    auditedQuestions.size > 0
    && addedQuestions.some(question => !auditedQuestions.has(normalizeContentWritingFaqText(question)))
  ) {
    reasons.push('unaudited_faq_question_added');
  }
  return {
    accepted: reasons.length === 0,
    reasons,
    before,
    after,
    addedQuestions,
    removedQuestions,
  };
};

export const contentWritingFaqAuditToPromptJson = (
  audit: ContentWritingFaqAudit,
): string => JSON.stringify(audit, null, 2);
