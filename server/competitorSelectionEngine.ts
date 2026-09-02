import type { CompetitorSearchResult } from './firecrawlCompetitorService.ts';

export type CompetitorIntent =
  | 'informational'
  | 'commercial'
  | 'transactional'
  | 'navigational'
  | 'local'
  | 'support'
  | 'unknown';

export type CompetitorPageType =
  | 'article'
  | 'guide'
  | 'comparison'
  | 'service'
  | 'product'
  | 'category'
  | 'landing'
  | 'news'
  | 'forum'
  | 'video'
  | 'homepage'
  | 'unknown';

export type CompetitorSelectionReasonCode =
  | 'auto-selected'
  | 'content-keyword-qualified'
  | 'targeting-evidence-confirmed'
  | 'primary-keyword-targeting'
  | 'alternative-keyword-targeting'
  | 'primary-keyword-in-content'
  | 'alternative-keyword-in-content'
  | 'article-title-targeting'
  | 'keyword-in-serp-title'
  | 'keyword-in-serp-description'
  | 'keyword-in-url'
  | 'keyword-in-page-title'
  | 'keyword-in-heading'
  | 'keyword-in-introduction'
  | 'keyword-in-body'
  | 'direct-intent-match'
  | 'page-type-match'
  | 'high-query-relevance'
  | 'strong-search-position'
  | 'target-location-match'
  | 'complete-search-metadata'
  | 'diverse-source';

export type CompetitorSelectionWarningCode =
  | 'intent-mismatch'
  | 'page-type-mismatch'
  | 'language-mismatch'
  | 'low-query-relevance'
  | 'homepage-result'
  | 'forum-or-video-result'
  | 'keyword-not-found-in-content'
  | 'content-qualification-unavailable'
  | 'utility-page'
  | 'own-domain';

export type CompetitorTargetingStatus = 'confirmed' | 'not_confirmed' | 'unknown';

export type CompetitorTargetingTermKind = 'primary' | 'alternative' | 'article_title';

export type CompetitorTargetingEvidenceSource =
  | 'serp_title'
  | 'serp_description'
  | 'url'
  | 'page_title'
  | 'h1'
  | 'headings'
  | 'introduction'
  | 'body';

export type CompetitorTargetingEvidence = {
  term: string;
  termKind: CompetitorTargetingTermKind;
  source: CompetitorTargetingEvidenceSource;
  matchType: 'exact' | 'equivalent_variant' | 'ordered_near';
  occurrences: number;
  score: number;
};

export type CompetitorContentQualification = {
  status: 'qualified' | 'not_qualified' | 'unavailable';
  score: number;
  matchedKeyword: string;
  matchKind:
    | 'primary'
    | 'alternative'
    | 'article_title'
    | 'ordered_primary'
    | 'ordered_alternative'
    | 'ordered_article_title'
    | 'none';
  locations: CompetitorTargetingEvidenceSource[];
  occurrences: number;
  wordCount: number;
  qualityScore: number;
  cacheHit: boolean;
  errorCode: string;
  version: string;
  /** Independent from extraction success; older persisted payloads omit it. */
  targetingStatus?: CompetitorTargetingStatus;
  /** Exact, reviewable reasons that established keyword targeting. */
  evidence?: CompetitorTargetingEvidence[];
  /** Whether a page response was available to inspect. */
  contentAvailability?: 'available' | 'unavailable';
  /** Whether the extracted main text is usable for competitor analysis. */
  contentUsability?: 'usable' | 'insufficient' | 'not_assessed';
};

export type ContentQualifiedCompetitorCandidate = CompetitorSearchResult & {
  contentQualification?: CompetitorContentQualification;
};

export type CompetitorSelectionSignals = {
  contentTargeting: number;
  intentMatch: number;
  relevance: number;
  searchStrength: number;
  pageTypeMatch: number;
  languageMatch: number;
  metadataQuality: number;
  locationMatch: number;
};

export type ScoredCompetitorSearchResult = CompetitorSearchResult & {
  selectionRank: number;
  selectionScore: number;
  confidence: number;
  autoSelected: boolean;
  eligible: boolean;
  inferredIntent: CompetitorIntent;
  inferredPageType: CompetitorPageType;
  reasonCodes: CompetitorSelectionReasonCode[];
  warningCodes: CompetitorSelectionWarningCode[];
  contentQualification?: CompetitorContentQualification;
  signals: CompetitorSelectionSignals;
};

export type CompetitorSelectionSummary = {
  strategy: 'automatic_review';
  engineVersion: string;
  targetIntent: CompetitorIntent;
  targetPageType: CompetitorPageType;
  confidence: number;
  candidateCount: number;
  reviewedCount: number;
  filteredCount: number;
  languageFilteredCount: number;
  contentQualificationAttempted: boolean;
  contentQualifiedCount: number;
  contentUnavailableCount: number;
  targetingConfirmedCount: number;
  contentUsableCount: number;
  autoSelectedCount: number;
  autoSelectedUrls: string[];
};

export type CompetitorSelectionResult = {
  results: ScoredCompetitorSearchResult[];
  summary: CompetitorSelectionSummary;
};

export type CompetitorSelectionContext = {
  query: string;
  queryType?: 'title' | 'primary_keyword';
  articleTitle?: string;
  primaryKeyword?: string;
  alternativeKeywords?: string[];
  language?: 'ar' | 'en';
  pageType?: string;
  searchIntent?: string;
  audienceScope?: string;
  targetCountry?: string;
  companyName?: string;
  ownDomains?: string[];
};

const ENGINE_VERSION = 'competitor-selection-v5-arabic-phrase-variants';
const INTENTS = ['informational', 'commercial', 'transactional', 'navigational', 'local', 'support'] as const;
type RankedIntent = typeof INTENTS[number];
type IntentVector = Record<RankedIntent, number>;

const clamp = (value: number, minimum = 0, maximum = 100): number => (
  Math.max(minimum, Math.min(maximum, value))
);

const roundScore = (value: number): number => Math.round(clamp(value));

export const normalizeCompetitorText = (value: unknown): string => String(value || '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\u064B-\u065F\u0670]/g, '')
  .replace(/\u0640/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ؤ/g, 'و')
  .replace(/ئ/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export type CompetitorTargetingTerm = {
  term: string;
  kind: CompetitorTargetingTermKind;
};

export type CompetitorTargetingSource = {
  source: CompetitorTargetingEvidenceSource;
  value: unknown;
};

const GENERIC_SINGLE_TARGET_TERMS = new Set([
  'ذهب', 'جهاز', 'اجهزه', 'كشف', 'مقال', 'مقاله', 'دليل', 'شرح', 'معلومات', 'سعر', 'اسعار',
  'افضل', 'شركه', 'شركات', 'خدمه', 'خدمات', 'منتج', 'منتجات', 'برنامج', 'برامج', 'موقع',
  'مواقع', 'العالم', 'شراء', 'بيع', 'guide', 'article', 'best', 'price', 'product', 'service',
].map(normalizeCompetitorText));

const targetingTokens = (value: unknown): string[] => (
  normalizeCompetitorText(value).split(' ').filter(Boolean)
);

const targetingTokenSequences = (value: unknown): string[][] => {
  const rawTokens = targetingTokens(value);
  const withoutWorldSuffix = rawTokens.length >= 2
    && rawTokens[rawTokens.length - 1] === 'العالم'
    && (rawTokens[rawTokens.length - 2] === 'في' || rawTokens[rawTokens.length - 2] === 'حول')
    ? rawTokens.slice(0, -2)
    : rawTokens;
  const collapseDetectorPhrase = (source: string[]): string[] => {
    const tokens: string[] = [];
    for (let index = 0; index < source.length; index += 1) {
      const token = source[index];
      const next = source[index + 1];
      // Treat the normal Arabic singular/plural spellings as one phrase unit:
      // "جهاز كشف", "أجهزة كشف", "كاشف", and "كاشفات" all describe a detector.
      if ((token === 'جهاز' || token === 'اجهزه') && (next === 'كشف' || next === 'الكشف')) {
        tokens.push('كاشف');
        index += 1;
        continue;
      }
      tokens.push(token === 'كاشفات' ? 'كاشف' : token);
    }
    return tokens;
  };
  const candidates = [
    rawTokens,
    withoutWorldSuffix,
    collapseDetectorPhrase(rawTokens),
    collapseDetectorPhrase(withoutWorldSuffix),
  ];
  const seen = new Set<string>();
  return candidates.filter(tokens => {
    const key = tokens.join(' ');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const arabicTargetTokenVariants = (value: string): Set<string> => {
  const variants = new Set([value]);
  const queue = [value];
  while (queue.length > 0) {
    const token = queue.shift() || '';
    const additions: string[] = [];
    if (/^[وف][\u0621-\u064a]/.test(token) && token.length >= 5) additions.push(token.slice(1));
    if (/^[بكل][\u0621-\u064a]/.test(token) && token.length >= 5) additions.push(token.slice(1));
    if (token.startsWith('لل') && token.length >= 5) additions.push(`ال${token.slice(2)}`);
    additions.forEach(addition => {
      if (addition.length < 3 || variants.has(addition)) return;
      variants.add(addition);
      queue.push(addition);
    });
  }
  return variants;
};

const targetingTokenMatches = (sourceToken: string, targetToken: string): boolean => (
  sourceToken === targetToken || arabicTargetTokenVariants(sourceToken).has(targetToken)
);

const countContiguousTargetMatches = (sourceTokens: string[], targetTokens: string[]): number => {
  if (targetTokens.length === 0 || sourceTokens.length < targetTokens.length) return 0;
  let matches = 0;
  for (let start = 0; start <= sourceTokens.length - targetTokens.length; start += 1) {
    if (targetTokens.every((token, offset) => targetingTokenMatches(sourceTokens[start + offset], token))) {
      matches += 1;
      start += Math.max(0, targetTokens.length - 1);
    }
  }
  return matches;
};

const hasOrderedNearTargetMatch = (sourceTokens: string[], targetTokens: string[]): boolean => {
  if (targetTokens.length < 2 || sourceTokens.length < targetTokens.length) return false;
  const maximumWindow = targetTokens.length + Math.max(2, Math.ceil(targetTokens.length * 0.35));
  for (let start = 0; start < sourceTokens.length; start += 1) {
    if (!targetingTokenMatches(sourceTokens[start], targetTokens[0])) continue;
    let targetIndex = 1;
    const end = Math.min(sourceTokens.length, start + maximumWindow);
    for (let index = start + 1; index < end && targetIndex < targetTokens.length; index += 1) {
      if (targetingTokenMatches(sourceTokens[index], targetTokens[targetIndex])) targetIndex += 1;
    }
    if (targetIndex === targetTokens.length) return true;
  }
  return false;
};

const isSpecificTargetingTerm = (term: string): boolean => {
  const tokens = targetingTokens(term);
  if (tokens.length >= 2) return true;
  const token = tokens[0] || '';
  if (!token || GENERIC_SINGLE_TARGET_TERMS.has(token)) return false;
  // A lone term is only evidence when it is specific enough to behave like a
  // name or specialist concept, rather than a broad topic word.
  return /[a-z]/i.test(token) ? token.length >= 4 : token.length >= 5;
};

export const buildCompetitorTargetTerms = (context: Pick<
  CompetitorSelectionContext,
  'primaryKeyword' | 'alternativeKeywords' | 'articleTitle'
>): CompetitorTargetingTerm[] => {
  const values: CompetitorTargetingTerm[] = [
    ...(context.primaryKeyword ? [{ term: context.primaryKeyword, kind: 'primary' as const }] : []),
    ...(context.alternativeKeywords || []).map(term => ({ term, kind: 'alternative' as const })),
    ...(context.articleTitle ? [{ term: context.articleTitle, kind: 'article_title' as const }] : []),
  ];
  const seen = new Set<string>();
  return values.flatMap(value => {
    const term = String(value.term || '').trim().slice(0, 300);
    const normalized = normalizeCompetitorText(term);
    if (!normalized || seen.has(normalized) || !isSpecificTargetingTerm(term)) return [];
    seen.add(normalized);
    return [{ term, kind: value.kind }];
  }).slice(0, 16);
};

const TARGETING_SOURCE_SCORES: Record<CompetitorTargetingEvidenceSource, number> = {
  serp_title: 93,
  serp_description: 76,
  url: 88,
  page_title: 96,
  h1: 96,
  headings: 84,
  introduction: 82,
  body: 68,
};

const decodeTargetingSourceValue = (value: unknown): string => {
  const text = String(value || '');
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * Finds deterministic evidence for a complete target phrase. Token order must
 * be preserved and only a small number of intervening words is tolerated.
 */
export const findCompetitorTargetingEvidence = (options: {
  terms: CompetitorTargetingTerm[];
  sources: CompetitorTargetingSource[];
}): CompetitorTargetingEvidence[] => options.terms.flatMap(target => {
  if (!isSpecificTargetingTerm(target.term)) return [];
  const targetSequences = targetingTokenSequences(target.term);
  const rawTargetTokens = targetingTokens(target.term);
  return options.sources.flatMap(({ source, value }) => {
    const decodedSource = decodeTargetingSourceValue(value);
    const sourceSequences = targetingTokenSequences(decodedSource);
    const rawOccurrences = countContiguousTargetMatches(targetingTokens(decodedSource), rawTargetTokens);
    const occurrences = Math.max(0, ...targetSequences.flatMap(targetTokens => (
      sourceSequences.map(sourceTokens => countContiguousTargetMatches(sourceTokens, targetTokens))
    )));
    const exact = rawOccurrences > 0;
    const equivalentVariant = !exact && occurrences > 0;
    const orderedNear = !exact && !equivalentVariant && targetSequences.some(targetTokens => (
      sourceSequences.some(sourceTokens => hasOrderedNearTargetMatch(sourceTokens, targetTokens))
    ));
    if (!exact && !equivalentVariant && !orderedNear) return [];
    const kindBonus = target.kind === 'primary' ? 4 : target.kind === 'article_title' ? 2 : 0;
    return [{
      term: target.term,
      termKind: target.kind,
      source,
      matchType: exact
        ? 'exact' as const
        : equivalentVariant
          ? 'equivalent_variant' as const
          : 'ordered_near' as const,
      occurrences: exact ? rawOccurrences : equivalentVariant ? occurrences : 1,
      score: roundScore(
        TARGETING_SOURCE_SCORES[source]
        + kindBonus
        + (exact ? 2 : equivalentVariant ? 0 : -8),
      ),
    }];
  });
}).sort((left, right) => (
  right.score - left.score
  || Number(right.matchType === 'exact') - Number(left.matchType === 'exact')
  || Number(right.matchType === 'equivalent_variant') - Number(left.matchType === 'equivalent_variant')
  || left.source.localeCompare(right.source)
));

const legacyMatchKindFromEvidence = (
  evidence?: CompetitorTargetingEvidence,
): CompetitorContentQualification['matchKind'] => {
  if (!evidence) return 'none';
  const ordered = evidence.matchType === 'ordered_near';
  if (evidence.termKind === 'primary') return ordered ? 'ordered_primary' : 'primary';
  if (evidence.termKind === 'alternative') return ordered ? 'ordered_alternative' : 'alternative';
  return ordered ? 'ordered_article_title' : 'article_title';
};

const normalizePhraseList = (values: string[]): string[] => (
  Array.from(new Set(values.map(normalizeCompetitorText).filter(Boolean)))
);

const INTENT_LEXICONS: Record<RankedIntent, string[]> = {
  informational: normalizePhraseList([
    'ما هو', 'ما هي', 'ماذا', 'لماذا', 'كيف', 'كيفية', 'طريقه', 'طرق', 'خطوات', 'دليل',
    'شرح', 'تعريف', 'معني', 'معلومات', 'فوائد', 'اسباب', 'انواع', 'متي', 'اين', 'هل',
    'نصائح', 'تعلم', 'كل ما تحتاج', 'الفرق بين', 'ما الفرق', 'امثله', 'استخدامات', 'مراحل',
    'شروط', 'متطلبات', 'مكونات', 'خصائص', 'وظائف', 'ما المقصود', 'مفهوم', 'اهميه', 'تاريخ',
    'what is', 'what are', 'why', 'how to', 'how does', 'guide', 'tutorial', 'explained',
    'definition', 'meaning', 'benefits', 'examples', 'types of', 'steps', 'tips', 'learn',
    'overview', 'introduction', 'complete guide', 'everything you need', 'requirements', 'features',
  ]),
  commercial: normalizePhraseList([
    'افضل', 'الافضل', 'مقارنه', 'مقابل', 'مراجعه', 'تقييم', 'تجربه', 'تجارب', 'اراء',
    'بدائل', 'بديل', 'الفرق بين', 'مميزات وعيوب', 'ايهما', 'اختيار', 'ترشيحات', 'قائمه',
    'الاكثر شهره', 'الاكثر استخداما', 'موصي به', 'دليل الشراء', 'قبل الشراء', 'هل يستحق',
    'مناسب لك', 'مقارنه اسعار', 'افضل شركه', 'افضل خدمه', 'افضل برنامج', 'افضل منصه',
    'best', 'top', 'compare', 'comparison', 'versus', 'vs', 'review', 'reviews', 'rating',
    'alternatives', 'pros and cons', 'which is better', 'recommended', 'buying guide',
    'worth it', 'customer reviews', 'user experiences', 'best software', 'best service',
  ]),
  transactional: normalizePhraseList([
    'شراء', 'اشتر', 'اطلب', 'طلب', 'سعر', 'اسعار', 'تكلفه', 'حجز', 'احجز', 'موعد', 'خصم',
    'كوبون', 'عرض', 'عروض', 'اشتراك', 'اشترك', 'سجل الان', 'تحميل', 'تنزيل', 'تواصل',
    'احصل علي', 'عرض سعر', 'تجربه مجانيه', 'متجر', 'بيع', 'دفع', 'تقسيط', 'شحن', 'توصيل',
    'خدمه اونلاين', 'اطلب الان', 'ابدأ الان', 'فتح حساب', 'انشاء حساب', 'استشاره', 'احجز استشاره',
    'buy', 'order', 'price', 'pricing', 'cost', 'book', 'booking', 'reserve', 'discount',
    'coupon', 'deal', 'subscribe', 'sign up', 'download', 'get started', 'free trial',
    'request quote', 'contact sales', 'shop', 'checkout', 'add to cart', 'purchase', 'hire',
  ]),
  navigational: normalizePhraseList([
    'الموقع الرسمي', 'تسجيل الدخول', 'دخول', 'حسابي', 'بوابه', 'رابط', 'رقم التواصل',
    'رقم الهاتف', 'واتساب', 'عنوان الشركه', 'فروع الشركه', 'خدمه العملاء', 'تطبيق',
    'official website', 'login', 'sign in', 'dashboard', 'portal', 'account', 'homepage',
    'customer service', 'phone number', 'contact number', 'app', 'website', 'official app',
  ]),
  local: normalizePhraseList([
    'بالقرب مني', 'قريب مني', 'اقرب', 'افضل مكان في', 'افضل شركه في', 'افضل خدمه في',
    'في مدينه', 'داخل مدينه', 'محلي', 'منطقه', 'حي', 'فرع', 'فروع', 'خريطه', 'موقعي',
    'near me', 'nearby', 'closest', 'local', 'in my area', 'in the city', 'branches',
    'locations', 'map', 'open now', 'directions', 'local service', 'local company',
  ]),
  support: normalizePhraseList([
    'حل مشكله', 'حل خطا', 'لا يعمل', 'لا يفتح', 'اصلاح', 'دعم', 'مساعده', 'كيف استخدم',
    'طريقه الاستخدام', 'اعدادات', 'استرجاع', 'الغاء', 'نسيت كلمه المرور', 'استعاده', 'تفعيل',
    'تحديث', 'تثبيت', 'ربط', 'اعداد', 'مشاكل شائعه', 'رمز الخطا', 'توقف', 'تعطل',
    'troubleshooting', 'fix', 'not working', 'error', 'support', 'help', 'how to use',
    'setup', 'settings', 'reset', 'recover', 'cancel', 'install', 'update', 'common issues',
    'error code', 'integration help', 'configuration', 'password reset',
  ]),
};

const PAGE_TYPE_LEXICONS: Record<Exclude<CompetitorPageType, 'unknown'>, string[]> = {
  article: normalizePhraseList([
    'مقال', 'مقالات', 'مدونه', 'شرح', 'تعرف علي', 'معلومات', 'article', 'blog', 'insights',
    'resources', 'learn', 'explained', 'overview',
  ]),
  guide: normalizePhraseList([
    'دليل', 'الدليل الكامل', 'خطوات', 'طريقه', 'كيف', 'كل ما تحتاج', 'guide', 'how to',
    'tutorial', 'step by step', 'complete guide', 'handbook', 'checklist', 'walkthrough',
  ]),
  comparison: normalizePhraseList([
    'افضل', 'مقارنه', 'مقابل', 'ايهما', 'بدائل', 'مراجعه', 'مميزات وعيوب', 'ترشيحات',
    'best', 'top', 'compare', 'comparison', 'versus', 'vs', 'alternatives', 'review',
    'pros and cons', 'which is better',
  ]),
  service: normalizePhraseList([
    'خدمات', 'خدمه', 'شركه', 'وكاله', 'مكتب', 'مقدم خدمه', 'حلول', 'استشارات',
    'services', 'service', 'agency', 'company', 'solutions', 'consulting', 'professional services',
    'request a quote', 'book a consultation',
  ]),
  product: normalizePhraseList([
    'منتج', 'سعر', 'شراء', 'اطلب', 'المواصفات', 'متوفر', 'اضف للسله', 'product', 'price',
    'buy', 'order', 'specifications', 'in stock', 'add to cart', 'shop', 'sku',
  ]),
  category: normalizePhraseList([
    'تصنيف', 'مجموعه', 'منتجات', 'خدماتنا', 'الاقسام', 'category', 'collection', 'catalog',
    'products', 'services', 'browse', 'shop by',
  ]),
  landing: normalizePhraseList([
    'ابدأ الان', 'احصل علي', 'سجل الان', 'اطلب عرض', 'صفحه هبوط', 'get started', 'sign up',
    'request quote', 'free trial', 'landing', 'campaign', 'offer',
  ]),
  news: normalizePhraseList([
    'خبر', 'اخبار', 'عاجل', 'اخر الاخبار', 'اليوم', 'تقرير', 'news', 'breaking', 'latest',
    'today', 'press release', 'announcement', 'report',
  ]),
  forum: normalizePhraseList([
    'منتدي', 'مجتمع', 'سؤال', 'اجابه', 'نقاش', 'forum', 'community', 'question', 'answers',
    'discussion', 'thread', 'reddit', 'quora',
  ]),
  video: normalizePhraseList([
    'فيديو', 'شاهد', 'يوتيوب', 'video', 'watch', 'youtube', 'vimeo', 'playlist',
  ]),
  homepage: [],
};

const STOP_WORDS = new Set(normalizePhraseList([
  'في', 'من', 'علي', 'الى', 'عن', 'مع', 'او', 'و', 'ثم', 'هو', 'هي', 'هذا', 'هذه', 'ذلك',
  'تلك', 'كل', 'احد', 'اكثر', 'اقل', 'جدا', 'جميع', 'لدي', 'لها', 'له', 'ما', 'كيف', 'لماذا',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'from', 'with', 'in', 'on', 'at', 'by',
  'is', 'are', 'be', 'this', 'that', 'these', 'those', 'your', 'our', 'you', 'we', 'how', 'what',
]));

const SOCIAL_DOMAINS = new Set([
  'facebook.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'linkedin.com',
  'pinterest.com', 'snapchat.com', 'youtube.com', 'youtu.be', 'vimeo.com', 'reddit.com',
  'quora.com', 'medium.com', 'threads.net', 'telegram.me', 't.me',
]);

const UTILITY_PATH_SEGMENTS = new Set([
  'login', 'signin', 'sign-in', 'signup', 'sign-up', 'register', 'account', 'privacy',
  'privacy-policy', 'terms', 'terms-of-service', 'cookies', 'contact', 'about', 'author',
  'authors', 'tag', 'tags', 'search', 'cart', 'checkout', 'careers', 'jobs', 'sitemap',
  'wp-login.php', 'تسجيل-الدخول', 'سياسة-الخصوصية', 'الشروط', 'اتصل-بنا', 'من-نحن',
]);

const COUNTRY_CODE_ENTRIES: Array<[string, string]> = [
  ['sa', 'SA'], ['السعوديه', 'SA'], ['المملكه العربيه السعوديه', 'SA'], ['saudi arabia', 'SA'],
  ['ae', 'AE'], ['الامارات', 'AE'], ['الامارات العربيه المتحده', 'AE'], ['united arab emirates', 'AE'], ['uae', 'AE'],
  ['tr', 'TR'], ['تركيا', 'TR'], ['turkey', 'TR'], ['turkiye', 'TR'], ['türkiye', 'TR'],
  ['iq', 'IQ'], ['العراق', 'IQ'], ['iraq', 'IQ'],
  ['kw', 'KW'], ['الكويت', 'KW'], ['kuwait', 'KW'],
  ['qa', 'QA'], ['قطر', 'QA'], ['qatar', 'QA'],
  ['bh', 'BH'], ['البحرين', 'BH'], ['bahrain', 'BH'],
  ['om', 'OM'], ['عمان', 'OM'], ['سلطنه عمان', 'OM'], ['oman', 'OM'],
  ['jo', 'JO'], ['الاردن', 'JO'], ['jordan', 'JO'],
  ['lb', 'LB'], ['لبنان', 'LB'], ['lebanon', 'LB'],
  ['eg', 'EG'], ['مصر', 'EG'], ['egypt', 'EG'],
  ['ma', 'MA'], ['المغرب', 'MA'], ['morocco', 'MA'],
  ['dz', 'DZ'], ['الجزائر', 'DZ'], ['algeria', 'DZ'],
  ['tn', 'TN'], ['تونس', 'TN'], ['tunisia', 'TN'],
  ['ly', 'LY'], ['ليبيا', 'LY'], ['libya', 'LY'],
  ['sy', 'SY'], ['سوريا', 'SY'], ['syria', 'SY'],
  ['ps', 'PS'], ['فلسطين', 'PS'], ['palestine', 'PS'],
  ['ye', 'YE'], ['اليمن', 'YE'], ['yemen', 'YE'],
  ['sd', 'SD'], ['السودان', 'SD'], ['sudan', 'SD'],
  ['us', 'US'], ['الولايات المتحده', 'US'], ['امريكا', 'US'], ['united states', 'US'], ['usa', 'US'],
  ['gb', 'GB'], ['المملكه المتحده', 'GB'], ['بريطانيا', 'GB'], ['united kingdom', 'GB'], ['uk', 'GB'],
  ['de', 'DE'], ['المانيا', 'DE'], ['germany', 'DE'],
  ['fr', 'FR'], ['فرنسا', 'FR'], ['france', 'FR'],
  ['ca', 'CA'], ['كندا', 'CA'], ['canada', 'CA'],
  ['au', 'AU'], ['استراليا', 'AU'], ['australia', 'AU'],
];

const COUNTRY_CODES = new Map(COUNTRY_CODE_ENTRIES.map(([label, code]) => [normalizeCompetitorText(label), code]));

export const resolveCompetitorCountryCode = (value: unknown): string => {
  const normalized = normalizeCompetitorText(value);
  if (!normalized || normalized === 'global' || normalized === 'عالمي') return '';
  if (/^[a-z]{2}$/.test(normalized)) return normalized.toUpperCase();
  return COUNTRY_CODES.get(normalized) || '';
};

export const extractCompetitorOwnDomains = (...values: unknown[]): string[] => {
  const domains = new Set<string>();
  values.forEach(value => {
    const raw = String(value || '').trim();
    if (!raw) return;
    const candidates = raw.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9\u00a1-\uffff-]+(?:\.[a-z0-9\u00a1-\uffff-]+)+(?:\/[^\s,;]*)?/gi) || [];
    candidates.forEach(candidate => {
      try {
        const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
        domains.add(url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''));
      } catch {
        // Company names without a public domain are intentionally ignored.
      }
    });
  });
  return Array.from(domains);
};

const emptyIntentVector = (): IntentVector => ({
  informational: 0.05,
  commercial: 0.05,
  transactional: 0.05,
  navigational: 0.05,
  local: 0.05,
  support: 0.05,
});

const addIntentLexiconSignals = (vector: IntentVector, text: string, scale = 1): void => {
  const haystack = ` ${normalizeCompetitorText(text)} `;
  INTENTS.forEach(intent => {
    INTENT_LEXICONS[intent].forEach(phrase => {
      if (!haystack.includes(` ${phrase} `)) return;
      const phraseWeight = phrase.includes(' ') ? 2.4 : 1.25;
      vector[intent] += phraseWeight * scale;
    });
  });
};

const addPageTypeIntentPrior = (vector: IntentVector, pageType: CompetitorPageType, scale = 1): void => {
  if (pageType === 'article' || pageType === 'guide' || pageType === 'news') vector.informational += 3 * scale;
  if (pageType === 'comparison') vector.commercial += 4 * scale;
  if (pageType === 'product' || pageType === 'category' || pageType === 'landing') vector.transactional += 4 * scale;
  if (pageType === 'service') {
    vector.transactional += 2.5 * scale;
    vector.commercial += 1.5 * scale;
  }
  if (pageType === 'forum') {
    vector.informational += 1.5 * scale;
    vector.support += 1.5 * scale;
  }
  if (pageType === 'homepage') vector.navigational += 4 * scale;
};

const addExplicitIntent = (vector: IntentVector, value: unknown): boolean => {
  const normalized = normalizeCompetitorText(value).replace(/\s+/g, '-');
  if (!normalized) return false;
  if (normalized.includes('commercial-support')) {
    vector.commercial += 8;
    vector.informational += 2;
    return true;
  }
  if (normalized.includes('support-intent') || normalized === 'support') {
    vector.support += 9;
    vector.informational += 2;
    return true;
  }
  const direct = INTENTS.find(intent => normalized.includes(intent));
  if (!direct) return false;
  vector[direct] += 10;
  return true;
};

const vectorTotal = (vector: IntentVector): number => (
  INTENTS.reduce((total, intent) => total + vector[intent], 0)
);

const normalizeIntentVector = (vector: IntentVector): IntentVector => {
  const total = vectorTotal(vector) || 1;
  return INTENTS.reduce<IntentVector>((normalized, intent) => {
    normalized[intent] = vector[intent] / total;
    return normalized;
  }, emptyIntentVector());
};

const dominantIntent = (vector: IntentVector): RankedIntent => (
  INTENTS.reduce((best, intent) => vector[intent] > vector[best] ? intent : best, INTENTS[0])
);

const cosineSimilarity = (left: IntentVector, right: IntentVector): number => {
  const dot = INTENTS.reduce((sum, intent) => sum + left[intent] * right[intent], 0);
  const leftMagnitude = Math.sqrt(INTENTS.reduce((sum, intent) => sum + left[intent] ** 2, 0));
  const rightMagnitude = Math.sqrt(INTENTS.reduce((sum, intent) => sum + right[intent] ** 2, 0));
  return leftMagnitude && rightMagnitude ? dot / (leftMagnitude * rightMagnitude) : 0;
};

const inferPageType = (result: CompetitorSearchResult): { type: CompetitorPageType; confidence: number } => {
  let url: URL | null = null;
  try {
    url = new URL(result.canonicalUrl || result.url);
  } catch {
    url = null;
  }
  const domain = (url?.hostname || result.domain).toLowerCase().replace(/^www\./, '');
  const pathname = url?.pathname || '/';
  if (SOCIAL_DOMAINS.has(domain) || domain.endsWith('.youtube.com')) {
    return { type: domain.includes('youtube') || domain === 'youtu.be' || domain.includes('vimeo') ? 'video' : 'forum', confidence: 96 };
  }
  if (pathname === '/' || pathname === '') return { type: 'homepage', confidence: 88 };

  const normalizedText = normalizeCompetitorText(`${result.title} ${result.description} ${pathname}`);
  const scores = new Map<CompetitorPageType, number>();
  (Object.keys(PAGE_TYPE_LEXICONS) as Array<Exclude<CompetitorPageType, 'unknown'>>).forEach(type => {
    let score = 0;
    const haystack = ` ${normalizedText} `;
    PAGE_TYPE_LEXICONS[type].forEach(phrase => {
      if (haystack.includes(` ${phrase} `)) score += phrase.includes(' ') ? 2.2 : 1.1;
    });
    scores.set(type, score);
  });

  const pathSignals: Array<[RegExp, CompetitorPageType, number]> = [
    [/\/(blog|blogs|article|articles|post|posts|insights|resources)\b/i, 'article', 4],
    [/\/(guide|guides|how-to|tutorial|learn|academy)\b/i, 'guide', 5],
    [/\/(compare|comparison|versus|vs|reviews?|alternatives?|best)\b/i, 'comparison', 5],
    [/\/(services?|solutions?|consulting|agency)\b/i, 'service', 5],
    [/\/(products?|shop|store|item|sku)\b/i, 'product', 5],
    [/\/(category|categories|collections?|catalog|departments?)\b/i, 'category', 5],
    [/\/(landing|campaign|offer|promo)\b/i, 'landing', 4],
    [/\/(news|press|updates?|latest)\b/i, 'news', 5],
    [/\/(forum|community|questions?|answers?|threads?)\b/i, 'forum', 5],
    [/\/(video|watch|playlist)\b/i, 'video', 5],
  ];
  pathSignals.forEach(([expression, type, weight]) => {
    if (expression.test(pathname)) scores.set(type, (scores.get(type) || 0) + weight);
  });

  const ranked = Array.from(scores.entries()).sort((left, right) => right[1] - left[1]);
  const [topType, topScore] = ranked[0] || ['unknown', 0];
  const secondScore = ranked[1]?.[1] || 0;
  if (topScore <= 0) return { type: 'unknown', confidence: 35 };
  return {
    type: topType,
    confidence: roundScore(55 + Math.min(35, topScore * 5) + Math.min(10, (topScore - secondScore) * 4)),
  };
};

const normalizeTargetPageType = (value: unknown): CompetitorPageType => {
  const normalized = normalizeCompetitorText(value);
  const mapping: Record<string, CompetitorPageType> = {
    article: 'article', 'مقال': 'article', news: 'news', 'اخبار': 'news', guide: 'guide', 'دليل': 'guide',
    comparison: 'comparison', 'مقارنه': 'comparison', service: 'service', 'خدمه': 'service',
    product: 'product', 'منتج': 'product', category: 'category', 'تصنيف': 'category',
    landing: 'landing', 'صفحه هبوط': 'landing',
  };
  return mapping[normalized] || 'unknown';
};

const pageTypeMatchScore = (target: CompetitorPageType, actual: CompetitorPageType): number => {
  if (target === 'unknown') return 72;
  if (target === actual) return 100;
  const compatiblePairs = new Map<string, number>([
    ['article:guide', 90], ['guide:article', 90], ['article:news', 72], ['news:article', 72],
    ['comparison:guide', 82], ['comparison:article', 75], ['guide:comparison', 75],
    ['service:landing', 88], ['landing:service', 88], ['service:category', 68],
    ['product:category', 82], ['category:product', 82], ['product:landing', 72],
    ['category:comparison', 68], ['article:comparison', 68],
  ]);
  if (actual === 'homepage') return target === 'service' || target === 'landing' ? 52 : 28;
  if (actual === 'forum' || actual === 'video') return 24;
  return compatiblePairs.get(`${target}:${actual}`) || 42;
};

const tokenize = (value: unknown): string[] => normalizeCompetitorText(value)
  .split(' ')
  .filter(token => token.length >= 2 && !STOP_WORDS.has(token));

const coverage = (queryTokens: string[], value: unknown): number => {
  if (queryTokens.length === 0) return 0;
  const tokens = new Set(tokenize(value));
  const matched = queryTokens.filter(token => tokens.has(token)).length;
  return matched / queryTokens.length;
};

const targetingVariantCoverage = (phrase: string, value: unknown): number => {
  const sourceSequences = targetingTokenSequences(decodeTargetingSourceValue(value));
  return Math.max(0, ...targetingTokenSequences(phrase).flatMap(targetSequence => {
    const queryTokens = Array.from(new Set(
      targetSequence.filter(token => token.length >= 2 && !STOP_WORDS.has(token)),
    ));
    return sourceSequences.map(sourceSequence => coverage(queryTokens, sourceSequence.join(' ')));
  }));
};

const hasTargetingVariantPhrase = (phrase: string, value: unknown): boolean => {
  const sourceSequences = targetingTokenSequences(decodeTargetingSourceValue(value));
  return targetingTokenSequences(phrase).some(targetSequence => (
    sourceSequences.some(sourceSequence => countContiguousTargetMatches(sourceSequence, targetSequence) > 0)
  ));
};

const queryRelevanceScore = (context: CompetitorSelectionContext, result: CompetitorSearchResult): number => {
  const phrases = [
    context.query,
    context.primaryKeyword || '',
    ...(context.alternativeKeywords || []),
    context.articleTitle || '',
  ].map(value => value.trim()).filter(Boolean);
  return Math.max(0, ...phrases.map(phrase => {
    const titleCoverage = targetingVariantCoverage(phrase, result.title);
    const descriptionCoverage = targetingVariantCoverage(phrase, result.description);
    const urlCoverage = targetingVariantCoverage(phrase, result.canonicalUrl || result.url);
    let score = titleCoverage * 55 + descriptionCoverage * 30 + urlCoverage * 15;
    if (hasTargetingVariantPhrase(phrase, result.title)) score += 18;
    if (targetingTokens(phrase).length > 0 && titleCoverage === 1) score += 8;
    return roundScore(score);
  }));
};

export type CompetitorLanguageAssessment = {
  compatible: boolean;
  detectedLanguage: 'ar' | 'latin' | 'mixed' | 'unknown';
  arabicLetterCount: number;
  latinLetterCount: number;
  arabicRatio: number;
  score: number;
};

export const assessCompetitorLanguage = (
  language: 'ar' | 'en',
  value: unknown,
): CompetitorLanguageAssessment => {
  const text = String(value || '')
    .replace(/https?:\/\/\S+|www\.\S+|\b\S+@\S+\.\S+\b/gi, ' ');
  const arabicLetters = (text.match(/[\u0621-\u063a\u0641-\u064a\u066e-\u06d3\u06fa-\u06ff]/g) || []).length;
  const latinLetters = (text.match(/\p{Script=Latin}/gu) || []).length;
  const total = arabicLetters + latinLetters;
  if (total < 12) {
    return {
      compatible: true,
      detectedLanguage: 'unknown',
      arabicLetterCount: arabicLetters,
      latinLetterCount: latinLetters,
      arabicRatio: total ? arabicLetters / total : 0,
      score: 65,
    };
  }
  const arabicRatio = arabicLetters / total;
  const detectedLanguage = arabicRatio >= 0.7
    ? 'ar'
    : arabicRatio <= 0.15
      ? 'latin'
      : 'mixed';
  const score = language === 'ar'
    ? arabicRatio >= 0.45 ? 100 : arabicRatio >= 0.25 && arabicLetters >= 8 ? 72 : 24
    : arabicRatio <= 0.15 ? 100 : arabicRatio <= 0.42 ? 70 : 28;
  return {
    compatible: language === 'ar'
      ? arabicLetters >= 8 && arabicRatio >= 0.25
      : score >= 50,
    detectedLanguage,
    arabicLetterCount: arabicLetters,
    latinLetterCount: latinLetters,
    arabicRatio,
    score,
  };
};

export const isCompetitorLanguageCompatible = (
  language: 'ar' | 'en',
  value: unknown,
): boolean => assessCompetitorLanguage(language, value).compatible;

const metadataQualityScore = (result: CompetitorSearchResult): number => {
  let score = 30;
  const titleLength = result.title.trim().length;
  const descriptionLength = result.description.trim().length;
  if (titleLength >= 20 && titleLength <= 120) score += 28;
  else if (titleLength >= 8) score += 16;
  if (descriptionLength >= 70 && descriptionLength <= 500) score += 30;
  else if (descriptionLength >= 25) score += 16;
  if ((result.canonicalUrl || result.url).startsWith('https://')) score += 12;
  return roundScore(score);
};

const locationMatchScore = (targetCountry: unknown, result: CompetitorSearchResult): number => {
  const target = normalizeCompetitorText(targetCountry);
  if (!target || target === 'global' || target === 'عالمي') return 75;
  const text = normalizeCompetitorText(`${result.title} ${result.description} ${result.domain}`);
  return text.includes(target) ? 100 : 62;
};

const hasUtilityPath = (result: CompetitorSearchResult): boolean => {
  try {
    const segments = new URL(result.canonicalUrl || result.url).pathname
      .split('/')
      .map(segment => decodeURIComponent(segment).toLowerCase())
      .filter(Boolean);
    return segments.some(segment => UTILITY_PATH_SEGMENTS.has(segment));
  } catch {
    return true;
  }
};

const domainMatches = (domain: string, candidates: Set<string>): boolean => {
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  return Array.from(candidates).some(candidate => normalized === candidate || normalized.endsWith(`.${candidate}`));
};

export const isCompetitorOwnDomain = (
  urlOrDomain: unknown,
  ownDomains: string[],
): boolean => {
  const raw = String(urlOrDomain || '').trim();
  if (!raw || ownDomains.length === 0) return false;
  let domain = raw;
  try {
    domain = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    // A raw hostname can still be checked by the same suffix policy.
  }
  return domainMatches(
    domain,
    new Set(extractCompetitorOwnDomains(...ownDomains)),
  );
};

const jaccardSimilarity = (left: string, right: string): number => {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = Array.from(leftTokens).filter(token => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
};

const selectDiverseCandidates = (
  results: ScoredCompetitorSearchResult[],
  maximum: number,
): Set<string> => {
  const selected: ScoredCompetitorSearchResult[] = [];
  const preferred = results.filter(result => result.eligible);
  const contentQualificationAttempted = results.some(result => Boolean(result.contentQualification));
  const metadataEvidenceOnly = contentQualificationAttempted
    ? []
    : results.filter(result => (
        result.reasonCodes.includes('targeting-evidence-confirmed')
        && !result.warningCodes.includes('language-mismatch')
        && !result.warningCodes.includes('forum-or-video-result')
        && result.selectionScore >= 45
      ));
  // A blocked page may still be selected from Google title/description/URL
  // evidence, because that evidence makes it eligible above. Never fill an
  // empty slot with a page that has neither page evidence nor SERP evidence.
  const pool = Array.from(
    new Map([...preferred, ...metadataEvidenceOnly].map(result => [result.canonicalUrl, result])).values(),
  );

  while (selected.length < Math.min(maximum, pool.length)) {
    const remaining = pool.filter(result => !selected.some(item => (
      item.canonicalUrl === result.canonicalUrl || item.domain === result.domain
    )));
    if (remaining.length === 0) break;
    const best = remaining
      .map(candidate => {
        const maximumSimilarity = selected.length === 0
          ? 0
          : Math.max(...selected.map(item => jaccardSimilarity(
              `${candidate.title} ${candidate.description}`,
              `${item.title} ${item.description}`,
            )));
        return { candidate, diversifiedScore: candidate.selectionScore - maximumSimilarity * 16 };
      })
      .sort((left, right) => right.diversifiedScore - left.diversifiedScore)[0]?.candidate;
    if (!best) break;
    selected.push(best);
  }
  return new Set(selected.map(result => result.canonicalUrl));
};

export const analyzeAndSelectCompetitors = (options: {
  context: CompetitorSelectionContext;
  candidates: ContentQualifiedCompetitorCandidate[];
  maxResults: number;
  maxSelected: number;
}): CompetitorSelectionResult => {
  const context = options.context;
  const targetingTerms = buildCompetitorTargetTerms(context);
  const targetPageType = normalizeTargetPageType(context.pageType);
  const candidateClassifications = options.candidates.map(candidate => {
    const pageType = inferPageType(candidate);
    const intentVector = emptyIntentVector();
    addIntentLexiconSignals(intentVector, `${candidate.title} ${candidate.description} ${candidate.canonicalUrl}`);
    addPageTypeIntentPrior(intentVector, pageType.type);
    const metadataEvidence = findCompetitorTargetingEvidence({
      terms: targetingTerms,
      sources: [
        { source: 'serp_title', value: candidate.title },
        { source: 'serp_description', value: candidate.description },
        { source: 'url', value: candidate.canonicalUrl || candidate.url },
      ],
    });
    return { candidate, pageType, intentVector: normalizeIntentVector(intentVector), metadataEvidence };
  });

  const targetVector = emptyIntentVector();
  addIntentLexiconSignals(
    targetVector,
    `${context.query} ${context.articleTitle || ''} ${context.primaryKeyword || ''} ${(context.alternativeKeywords || []).join(' ')}`,
    1.35,
  );
  addPageTypeIntentPrior(targetVector, targetPageType, 0.9);
  const explicitIntentProvided = addExplicitIntent(targetVector, context.searchIntent);
  if (normalizeCompetitorText(context.audienceScope) === 'local') targetVector.local += 5;
  candidateClassifications.slice(0, 10).forEach(classification => {
    INTENTS.forEach(intent => {
      targetVector[intent] += classification.intentVector[intent] * 0.45;
    });
  });
  const normalizedTargetVector = normalizeIntentVector(targetVector);
  const targetIntent = dominantIntent(normalizedTargetVector);
  const sortedTargetShares = INTENTS.map(intent => normalizedTargetVector[intent]).sort((a, b) => b - a);
  const intentMargin = (sortedTargetShares[0] || 0) - (sortedTargetShares[1] || 0);
  const summaryConfidence = roundScore(52 + intentMargin * 90 + (explicitIntentProvided ? 20 : 0));

  const ownDomains = new Set([
    ...(context.ownDomains || []),
    ...extractCompetitorOwnDomains(context.companyName),
  ].map(domain => domain.toLowerCase().replace(/^www\./, '')));

  let filteredCount = 0;
  let languageFilteredCount = 0;
  const contentQualificationAttempted = options.candidates.some(candidate => Boolean(candidate.contentQualification));
  const scored = candidateClassifications.flatMap(({ candidate, pageType, intentVector, metadataEvidence }) => {
    const ownDomain = domainMatches(candidate.domain, ownDomains);
    const utilityPage = hasUtilityPath(candidate);
    if (ownDomain || utilityPage) {
      filteredCount += 1;
      return [];
    }

    const languageAssessment = assessCompetitorLanguage(
      context.language === 'en' ? 'en' : 'ar',
      `${candidate.title} ${candidate.description}`,
    );
    if (context.language !== 'en' && !languageAssessment.compatible) {
      filteredCount += 1;
      languageFilteredCount += 1;
      return [];
    }

    const intentMatch = roundScore(cosineSimilarity(normalizedTargetVector, intentVector) * 100);
    const relevance = queryRelevanceScore(context, candidate);
    const searchStrength = roundScore(105 - Math.max(1, candidate.position) * 7);
    const pageMatch = pageTypeMatchScore(targetPageType, pageType.type);
    const languageMatch = languageAssessment.score;
    const metadataQuality = metadataQualityScore(candidate);
    const locationMatch = locationMatchScore(context.targetCountry, candidate);
    const qualification = candidate.contentQualification;
    const qualificationEvidence = qualification?.evidence || [];
    // Every complete-phrase signal is first-class evidence. A legacy content
    // precheck that did not see the phrase cannot invalidate a matching Google
    // title/description or URL; the two observations describe different surfaces.
    const combinedEvidence = Array.from(new Map(
      [...qualificationEvidence, ...metadataEvidence].map(evidence => [
        `${normalizeCompetitorText(evidence.term)}:${evidence.source}:${evidence.matchType}`,
        evidence,
      ]),
    ).values()).sort((left, right) => right.score - left.score);
    const targetingConfirmed = (
      qualification?.status === 'qualified'
      || qualification?.targetingStatus === 'confirmed'
      || combinedEvidence.length > 0
    );
    const targetingRejected = qualification?.status === 'not_qualified' && !targetingConfirmed;
    const strongestEvidence = combinedEvidence[0];
    const contentTargeting = targetingConfirmed
      ? Math.max(qualification?.score || 0, strongestEvidence?.score || 0)
      : 0;
    const effectiveQualification = qualification ? {
      ...qualification,
      score: contentTargeting,
      matchedKeyword: qualification.matchedKeyword || strongestEvidence?.term || '',
      matchKind: qualification.matchKind === 'none'
        ? legacyMatchKindFromEvidence(strongestEvidence)
        : qualification.matchKind,
      targetingStatus: targetingConfirmed
        ? 'confirmed' as const
        : qualification.targetingStatus || (targetingRejected ? 'not_confirmed' as const : 'unknown' as const),
      evidence: combinedEvidence,
      locations: Array.from(new Set([
        ...qualification.locations,
        ...combinedEvidence.map(evidence => evidence.source),
      ])),
    } : undefined;
    const socialOrVideo = pageType.type === 'forum' || pageType.type === 'video' || SOCIAL_DOMAINS.has(candidate.domain);
    const homepage = pageType.type === 'homepage';

    let selectionScore = qualification
      ? (
          contentTargeting * 0.45
          + intentMatch * 0.20
          + pageMatch * 0.12
          + searchStrength * 0.10
          + languageMatch * 0.08
          + locationMatch * 0.05
        )
      : (
          intentMatch * 0.30
          + relevance * 0.25
          + searchStrength * 0.15
          + pageMatch * 0.12
          + languageMatch * 0.08
          + metadataQuality * 0.05
          + locationMatch * 0.05
        );
    if (socialOrVideo) selectionScore -= 16;
    if (homepage && targetPageType !== 'service' && targetPageType !== 'landing') selectionScore -= 10;
    selectionScore = roundScore(selectionScore);

    const reasonCodes: CompetitorSelectionReasonCode[] = [];
    const warningCodes: CompetitorSelectionWarningCode[] = [];
    const contentEvidence = combinedEvidence.filter(evidence => (
      evidence.source !== 'serp_title'
      && evidence.source !== 'serp_description'
      && evidence.source !== 'url'
    ));
    if (targetingConfirmed) {
      reasonCodes.push('targeting-evidence-confirmed');
      if (qualification?.status === 'qualified' && (
        qualification.evidence === undefined || contentEvidence.length > 0
      )) reasonCodes.push('content-keyword-qualified');
      if (combinedEvidence.some(evidence => evidence.termKind === 'primary')) {
        reasonCodes.push('primary-keyword-targeting');
      }
      if (combinedEvidence.some(evidence => evidence.termKind === 'alternative')) {
        reasonCodes.push('alternative-keyword-targeting');
      }
      if (combinedEvidence.some(evidence => evidence.termKind === 'article_title')) {
        reasonCodes.push('article-title-targeting');
      }
      if (combinedEvidence.some(evidence => evidence.source === 'serp_title')) {
        reasonCodes.push('keyword-in-serp-title');
      }
      if (combinedEvidence.some(evidence => evidence.source === 'serp_description')) {
        reasonCodes.push('keyword-in-serp-description');
      }
      if (combinedEvidence.some(evidence => evidence.source === 'url')) {
        reasonCodes.push('keyword-in-url');
      }
      if (combinedEvidence.some(evidence => evidence.source === 'page_title')) {
        reasonCodes.push('keyword-in-page-title');
      }
      if (combinedEvidence.some(evidence => (
        evidence.source === 'h1' || evidence.source === 'headings'
      ))) reasonCodes.push('keyword-in-heading');
      if (combinedEvidence.some(evidence => evidence.source === 'introduction')) {
        reasonCodes.push('keyword-in-introduction');
      }
      if (combinedEvidence.some(evidence => evidence.source === 'body')) {
        reasonCodes.push('keyword-in-body');
      }
    }
    if (qualification?.status === 'qualified') {
      if (qualification.evidence === undefined && qualification.matchKind.includes('primary')) {
        reasonCodes.push('primary-keyword-in-content');
      } else if (qualification.evidence === undefined && qualification.matchKind.includes('alternative')) {
        reasonCodes.push('alternative-keyword-in-content');
      }
      if (contentEvidence.some(evidence => evidence.termKind === 'primary')) {
        reasonCodes.push('primary-keyword-in-content');
      }
      if (contentEvidence.some(evidence => evidence.termKind === 'alternative')) {
        reasonCodes.push('alternative-keyword-in-content');
      }
    } else if (qualification?.status === 'not_qualified') {
      warningCodes.push('keyword-not-found-in-content');
    } else if (qualification?.status === 'unavailable') {
      warningCodes.push('content-qualification-unavailable');
    }
    if (intentMatch >= 76) reasonCodes.push('direct-intent-match');
    else if (intentMatch < 52 && !targetingConfirmed) warningCodes.push('intent-mismatch');
    if (pageMatch >= 80) reasonCodes.push('page-type-match');
    else if (pageMatch < 52 && !targetingConfirmed) warningCodes.push('page-type-mismatch');
    if (relevance >= 68) reasonCodes.push('high-query-relevance');
    else if (relevance < 34 && !targetingConfirmed) warningCodes.push('low-query-relevance');
    if (candidate.position <= 5) reasonCodes.push('strong-search-position');
    if (locationMatch >= 95) reasonCodes.push('target-location-match');
    if (metadataQuality >= 78) reasonCodes.push('complete-search-metadata');
    if (languageMatch < 50) warningCodes.push('language-mismatch');
    if (homepage) warningCodes.push('homepage-result');
    if (socialOrVideo) warningCodes.push('forum-or-video-result');

    // A complete target phrase on any accepted surface is the hard relevance
    // gate requested by the editor workflow. Intent, page type, SERP position,
    // and score rank confirmed competitors; they do not veto that evidence.
    const eligible = (
      targetingConfirmed
      && languageMatch >= 50
      && !socialOrVideo
      && !targetingRejected
    );
    const confidence = roundScore(
      pageType.confidence * 0.35
      + summaryConfidence * 0.30
      + Math.min(100, metadataQuality + relevance * 0.25) * 0.35,
    );

    return [{
      ...candidate,
      selectionRank: 0,
      selectionScore,
      confidence,
      autoSelected: false,
      eligible,
      inferredIntent: dominantIntent(intentVector),
      inferredPageType: pageType.type,
      reasonCodes,
      warningCodes,
      contentQualification: effectiveQualification,
      signals: {
        contentTargeting,
        intentMatch,
        relevance,
        searchStrength,
        pageTypeMatch: pageMatch,
        languageMatch,
        metadataQuality,
        locationMatch,
      },
    } satisfies ScoredCompetitorSearchResult];
  });

  const reviewed = scored
    .sort((left, right) => right.selectionScore - left.selectionScore || left.position - right.position)
    .slice(0, Math.max(1, options.maxResults))
    .map((result, index) => ({ ...result, selectionRank: index + 1 }));
  const autoSelectedUrls = selectDiverseCandidates(reviewed, Math.max(1, options.maxSelected));
  const results = reviewed.map(result => {
    const autoSelected = autoSelectedUrls.has(result.canonicalUrl);
    return {
      ...result,
      autoSelected,
      // `eligible` is also the durable extraction gate. An unavailable page is
      // accepted only when Google/page evidence already confirmed targeting.
      eligible: result.eligible,
      reasonCodes: autoSelected
        ? [...result.reasonCodes, 'auto-selected' as const, 'diverse-source' as const]
        : result.reasonCodes,
    };
  });

  return {
    results,
    summary: {
      strategy: 'automatic_review',
      engineVersion: ENGINE_VERSION,
      targetIntent,
      targetPageType,
      confidence: summaryConfidence,
      candidateCount: options.candidates.length,
      reviewedCount: results.length,
      filteredCount,
      languageFilteredCount,
      contentQualificationAttempted,
      contentQualifiedCount: results.filter(result => result.contentQualification?.status === 'qualified').length,
      contentUnavailableCount: results.filter(result => result.contentQualification?.status === 'unavailable').length,
      targetingConfirmedCount: results.filter(result => (
        result.contentQualification?.targetingStatus === 'confirmed'
        || result.contentQualification?.status === 'qualified'
      )).length,
      contentUsableCount: results.filter(result => (
        result.contentQualification?.contentUsability === 'usable'
        || result.contentQualification?.status === 'qualified'
        || result.contentQualification?.status === 'not_qualified'
      )).length,
      autoSelectedCount: autoSelectedUrls.size,
      autoSelectedUrls: Array.from(autoSelectedUrls),
    },
  };
};
