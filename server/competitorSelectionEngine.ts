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
  | 'utility-page'
  | 'own-domain';

export type CompetitorSelectionSignals = {
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
  language?: 'ar' | 'en';
  pageType?: string;
  searchIntent?: string;
  audienceScope?: string;
  targetCountry?: string;
  companyName?: string;
  ownDomains?: string[];
};

const ENGINE_VERSION = 'competitor-selection-v1';
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

const queryRelevanceScore = (context: CompetitorSelectionContext, result: CompetitorSearchResult): number => {
  const queryText = `${context.query} ${context.primaryKeyword || ''}`;
  const queryTokens = Array.from(new Set(tokenize(queryText)));
  const titleCoverage = coverage(queryTokens, result.title);
  const descriptionCoverage = coverage(queryTokens, result.description);
  const urlCoverage = coverage(queryTokens, result.canonicalUrl || result.url);
  let score = titleCoverage * 55 + descriptionCoverage * 30 + urlCoverage * 15;

  const normalizedTitle = normalizeCompetitorText(result.title);
  const normalizedQuery = normalizeCompetitorText(context.query);
  const normalizedPrimary = normalizeCompetitorText(context.primaryKeyword);
  if (normalizedQuery.length >= 5 && normalizedTitle.includes(normalizedQuery)) score += 18;
  if (normalizedPrimary.length >= 3 && normalizedTitle.includes(normalizedPrimary)) score += 16;
  if (queryTokens.length > 0 && titleCoverage === 1) score += 8;
  return roundScore(score);
};

const languageMatchScore = (language: 'ar' | 'en', value: string): number => {
  const arabicLetters = (value.match(/[\u0600-\u06ff]/g) || []).length;
  const latinLetters = (value.match(/[a-z]/gi) || []).length;
  const total = arabicLetters + latinLetters;
  if (total < 12) return 65;
  const arabicRatio = arabicLetters / total;
  if (language === 'ar') return arabicRatio >= 0.45 ? 100 : arabicRatio >= 0.18 ? 72 : 24;
  return arabicRatio <= 0.15 ? 100 : arabicRatio <= 0.42 ? 70 : 28;
};

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
  const fallback = results.filter(result => (
    !result.warningCodes.includes('language-mismatch')
    && !result.warningCodes.includes('forum-or-video-result')
    && result.selectionScore >= 45
  ));
  const pool = Array.from(
    new Map([...preferred, ...fallback].map(result => [result.canonicalUrl, result])).values(),
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
  candidates: CompetitorSearchResult[];
  maxResults: number;
  maxSelected: number;
}): CompetitorSelectionResult => {
  const context = options.context;
  const targetPageType = normalizeTargetPageType(context.pageType);
  const candidateClassifications = options.candidates.map(candidate => {
    const pageType = inferPageType(candidate);
    const intentVector = emptyIntentVector();
    addIntentLexiconSignals(intentVector, `${candidate.title} ${candidate.description} ${candidate.canonicalUrl}`);
    addPageTypeIntentPrior(intentVector, pageType.type);
    return { candidate, pageType, intentVector: normalizeIntentVector(intentVector) };
  });

  const targetVector = emptyIntentVector();
  addIntentLexiconSignals(targetVector, `${context.query} ${context.articleTitle || ''} ${context.primaryKeyword || ''}`, 1.35);
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
  const scored = candidateClassifications.flatMap(({ candidate, pageType, intentVector }) => {
    const ownDomain = domainMatches(candidate.domain, ownDomains);
    const utilityPage = hasUtilityPath(candidate);
    if (ownDomain || utilityPage) {
      filteredCount += 1;
      return [];
    }

    const intentMatch = roundScore(cosineSimilarity(normalizedTargetVector, intentVector) * 100);
    const relevance = queryRelevanceScore(context, candidate);
    const searchStrength = roundScore(105 - Math.max(1, candidate.position) * 7);
    const pageMatch = pageTypeMatchScore(targetPageType, pageType.type);
    const languageMatch = languageMatchScore(context.language === 'en' ? 'en' : 'ar', `${candidate.title} ${candidate.description}`);
    const metadataQuality = metadataQualityScore(candidate);
    const locationMatch = locationMatchScore(context.targetCountry, candidate);
    const socialOrVideo = pageType.type === 'forum' || pageType.type === 'video' || SOCIAL_DOMAINS.has(candidate.domain);
    const homepage = pageType.type === 'homepage';

    let selectionScore = (
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
    if (intentMatch >= 76) reasonCodes.push('direct-intent-match');
    else if (intentMatch < 52) warningCodes.push('intent-mismatch');
    if (pageMatch >= 80) reasonCodes.push('page-type-match');
    else if (pageMatch < 52) warningCodes.push('page-type-mismatch');
    if (relevance >= 68) reasonCodes.push('high-query-relevance');
    else if (relevance < 34) warningCodes.push('low-query-relevance');
    if (candidate.position <= 5) reasonCodes.push('strong-search-position');
    if (locationMatch >= 95) reasonCodes.push('target-location-match');
    if (metadataQuality >= 78) reasonCodes.push('complete-search-metadata');
    if (languageMatch < 50) warningCodes.push('language-mismatch');
    if (homepage) warningCodes.push('homepage-result');
    if (socialOrVideo) warningCodes.push('forum-or-video-result');

    const eligible = (
      selectionScore >= 52
      && intentMatch >= 45
      && relevance >= 25
      && languageMatch >= 50
      && !socialOrVideo
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
      signals: {
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
  const results = reviewed.map(result => ({
    ...result,
    autoSelected: autoSelectedUrls.has(result.canonicalUrl),
    reasonCodes: autoSelectedUrls.has(result.canonicalUrl)
      ? [...result.reasonCodes, 'auto-selected' as const, 'diverse-source' as const]
      : result.reasonCodes,
  }));

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
      autoSelectedCount: autoSelectedUrls.size,
      autoSelectedUrls: Array.from(autoSelectedUrls),
    },
  };
};
