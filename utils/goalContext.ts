import { INITIAL_GOAL_CONTEXT } from '../constants';
import { translations } from '../components/translations';
import type { ClientGoalContexts, GoalContext } from '../types';
import {
  formatContentWritingTargetWordRange,
  parseContentWritingTargetWordRange,
} from './contentWritingTargets';

type GoalTabTranslations = typeof translations.ar.goalTab;

export type GoalContextOption = {
  value: string;
  label: string;
};

export type GoalContextFieldConfig =
  | {
      key: keyof GoalContext;
      kind: 'select';
      label: string;
      options: GoalContextOption[];
      helpText?: string;
    }
  | {
      key: keyof GoalContext;
      kind: 'multi-choice';
      label: string;
      options: GoalContextOption[];
      customPlaceholder: string;
      helpText?: string;
    }
  | {
      key: keyof GoalContext;
      kind: 'text' | 'textarea';
      label: string;
      placeholder: string;
      visibleForAudienceScopes?: string[];
      helpText?: string;
    };

type GoalContextPreset = Pick<GoalContext, 'pageType' | 'objective' | 'audienceScope' | 'searchIntent'> & {
  id: string;
};

export type GoalContextPresetOption = {
  value: string;
  label: string;
  searchText: string;
  context: GoalContext;
};

const TARGET_LOCATION_AUDIENCE_SCOPES = ['local', 'country', 'regional'];
const GOAL_CONTEXT_FREE_TEXT_KEYS = new Set<keyof GoalContext>([
  'targetWordRange',
  'targetCountry',
  'targetAudience',
  'audienceNeeds',
  'readerOutcome',
  'desiredAction',
  'uniqueAngle',
  'evidenceRequirements',
  'freshnessRequirements',
  'brandVoice',
  'generatedBrief',
]);

export const parseGoalContextMultiValue = (value: string): string[] => {
  const seen = new Set<string>();
  return String(value || '')
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => {
      const normalized = item.toLocaleLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
};

export const serializeGoalContextMultiValue = (values: string[]): string => (
  parseGoalContextMultiValue(values.join('\n')).join('\n')
);

const mergeGoalContextValues = (...values: string[]): string => (
  serializeGoalContextMultiValue(values.flatMap(parseGoalContextMultiValue))
);

export const SMART_CONTENT_BRIEF_REQUIRED_KEYS: ReadonlyArray<keyof GoalContext> = [
  'pageType',
  'objective',
  'audienceScope',
  'searchIntent',
];

export const getSmartContentBriefMissingKeys = (
  context: Partial<GoalContext> | null | undefined,
): Array<keyof GoalContext> => {
  const normalized = normalizeGoalContext(context);
  return SMART_CONTENT_BRIEF_REQUIRED_KEYS.filter(
    key => !String(normalized[key] || '').trim(),
  );
};

const GOAL_CONTEXT_PRESETS: GoalContextPreset[] = [
  { id: 'service-convert-global-transactional', pageType: 'service', objective: 'convert', audienceScope: 'global', searchIntent: 'transactional' },
  { id: 'service-convert-country-transactional', pageType: 'service', objective: 'convert', audienceScope: 'country', searchIntent: 'transactional' },
  { id: 'service-convert-local-transactional', pageType: 'service', objective: 'convert', audienceScope: 'local', searchIntent: 'transactional' },
  { id: 'service-convert-regional-transactional', pageType: 'service', objective: 'convert', audienceScope: 'regional', searchIntent: 'transactional' },
  { id: 'service-compare-country-commercial', pageType: 'service', objective: 'compare', audienceScope: 'country', searchIntent: 'commercial' },
  { id: 'service-compare-regional-commercial', pageType: 'service', objective: 'compare', audienceScope: 'regional', searchIntent: 'commercial' },
  { id: 'service-educate-global-informational', pageType: 'service', objective: 'educate', audienceScope: 'global', searchIntent: 'informational' },
  { id: 'service-trust-country-commercial', pageType: 'service', objective: 'trust', audienceScope: 'country', searchIntent: 'commercial' },
  { id: 'service-support-global-support', pageType: 'service', objective: 'support', audienceScope: 'global', searchIntent: 'support-intent' },
  { id: 'news-educate-country-commercial', pageType: 'news', objective: 'educate', audienceScope: 'country', searchIntent: 'commercial' },
  { id: 'news-educate-country-informational', pageType: 'news', objective: 'educate', audienceScope: 'country', searchIntent: 'informational' },
  { id: 'news-educate-regional-informational', pageType: 'news', objective: 'educate', audienceScope: 'regional', searchIntent: 'informational' },
  { id: 'news-educate-global-informational', pageType: 'news', objective: 'educate', audienceScope: 'global', searchIntent: 'informational' },
  { id: 'article-educate-global-informational', pageType: 'article', objective: 'educate', audienceScope: 'global', searchIntent: 'informational' },
  { id: 'article-educate-country-informational', pageType: 'article', objective: 'educate', audienceScope: 'country', searchIntent: 'informational' },
  { id: 'article-educate-local-informational', pageType: 'article', objective: 'educate', audienceScope: 'local', searchIntent: 'informational' },
  { id: 'article-trust-country-informational', pageType: 'article', objective: 'trust', audienceScope: 'country', searchIntent: 'informational' },
  { id: 'article-support-global-support', pageType: 'article', objective: 'support', audienceScope: 'global', searchIntent: 'support-intent' },
  { id: 'guide-educate-global-informational', pageType: 'guide', objective: 'educate', audienceScope: 'global', searchIntent: 'informational' },
  { id: 'guide-educate-country-informational', pageType: 'guide', objective: 'educate', audienceScope: 'country', searchIntent: 'informational' },
  { id: 'guide-compare-global-commercial', pageType: 'guide', objective: 'compare', audienceScope: 'global', searchIntent: 'commercial' },
  { id: 'guide-support-global-support', pageType: 'guide', objective: 'support', audienceScope: 'global', searchIntent: 'support-intent' },
  { id: 'comparison-compare-global-commercial', pageType: 'comparison', objective: 'compare', audienceScope: 'global', searchIntent: 'commercial' },
  { id: 'comparison-compare-country-commercial', pageType: 'comparison', objective: 'compare', audienceScope: 'country', searchIntent: 'commercial' },
  { id: 'comparison-compare-regional-commercial', pageType: 'comparison', objective: 'compare', audienceScope: 'regional', searchIntent: 'commercial' },
  { id: 'comparison-convert-global-transactional', pageType: 'comparison', objective: 'convert', audienceScope: 'global', searchIntent: 'transactional' },
  { id: 'category-support-global-commercial-support', pageType: 'category', objective: 'category-support', audienceScope: 'global', searchIntent: 'commercial-support' },
  { id: 'category-support-country-commercial-support', pageType: 'category', objective: 'category-support', audienceScope: 'country', searchIntent: 'commercial-support' },
  { id: 'category-compare-regional-commercial', pageType: 'category', objective: 'compare', audienceScope: 'regional', searchIntent: 'commercial' },
  { id: 'category-convert-country-transactional', pageType: 'category', objective: 'convert', audienceScope: 'country', searchIntent: 'transactional' },
  { id: 'product-convert-global-transactional', pageType: 'product', objective: 'convert', audienceScope: 'global', searchIntent: 'transactional' },
  { id: 'product-convert-country-transactional', pageType: 'product', objective: 'convert', audienceScope: 'country', searchIntent: 'transactional' },
  { id: 'product-trust-global-commercial-support', pageType: 'product', objective: 'trust', audienceScope: 'global', searchIntent: 'commercial-support' },
  { id: 'product-support-global-support', pageType: 'product', objective: 'support', audienceScope: 'global', searchIntent: 'support-intent' },
  { id: 'landing-convert-global-transactional', pageType: 'landing', objective: 'convert', audienceScope: 'global', searchIntent: 'transactional' },
  { id: 'landing-convert-country-transactional', pageType: 'landing', objective: 'convert', audienceScope: 'country', searchIntent: 'transactional' },
  { id: 'landing-trust-global-commercial', pageType: 'landing', objective: 'trust', audienceScope: 'global', searchIntent: 'commercial' },
];

const CONTEXT_OPTION_TRANSLATION_KEYS: Partial<Record<keyof GoalContext, Record<string, keyof GoalTabTranslations['contextOptions']>>> = {
  pageType: {
    article: 'article',
    news: 'news',
    service: 'service',
    category: 'categoryPage',
    comparison: 'comparisonPage',
    landing: 'landing',
    guide: 'guide',
    product: 'product',
  },
  objective: {
    educate: 'educate',
    compare: 'compare',
    convert: 'convert',
    'category-support': 'categorySupport',
    trust: 'trust',
    support: 'support',
  },
  audienceScope: {
    local: 'local',
    country: 'country',
    regional: 'regional',
    global: 'global',
  },
  searchIntent: {
    informational: 'informational',
    commercial: 'commercial',
    'commercial-support': 'commercialSupport',
    transactional: 'transactional',
    navigational: 'navigational',
    'support-intent': 'supportIntent',
  },
};

const CHOICE_ALIASES: Partial<Record<keyof GoalContext, Record<string, string[]>>> = {
  pageType: {
    service: ['صفحة خدمة', 'صفحة الخدمة', 'service page'],
    category: ['صفحة تصنيف', 'صفحة تصنيف منتجات/خدمات', 'صفحة تصنيف منتجات خدمات', 'category page'],
    comparison: ['صفحة مقارنة', 'comparison page'],
    product: ['صفحة منتج', 'صفحة المنتج', 'product page'],
    landing: ['صفحة هبوط', 'landing page'],
  },
  objective: {
    educate: ['شرح', 'تثقيف', 'educate'],
    compare: ['اختيار', 'compare', 'choose'],
    convert: ['تحويل', 'بيع', 'حجز', 'شراء', 'convert'],
    'category-support': ['داعم', 'دعم التصنيف', 'category support'],
    trust: ['الثقة', 'ثقة', 'trust'],
    support: ['دعم', 'مساعدة', 'help'],
  },
  audienceScope: {
    local: ['محلي', 'مدينة', 'local'],
    country: ['دولة', 'بلد', 'country'],
    regional: ['إقليم', 'اقليم', 'منطقة', 'region'],
    global: ['عالمي', 'global'],
  },
  searchIntent: {
    informational: ['شرح', 'معلومة', 'معلومات', 'info'],
    commercial: ['اختيار', 'مقارنة', 'choose'],
    'commercial-support': ['تجاري', 'commercial support'],
    transactional: ['تنفيذ', 'شراء', 'action', 'buy'],
    navigational: ['وصول', 'navigate'],
    'support-intent': ['حل', 'solve'],
  },
};

const normalizeChoiceToken = (value?: unknown): string => (
  String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
);

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const asStoredString = (value: unknown): string => (
  typeof value === 'string' ? value : ''
);

const normalizeMappedChoice = (value: unknown, choiceMap: Record<string, string>, fallback: string): string => {
  const token = normalizeChoiceToken(value);
  if (!token) return fallback;
  return choiceMap[token] || asStoredString(value) || fallback;
};

export const CALL_TO_ACTION_PAGE_TYPES = ['service', 'category', 'product', 'landing'] as const;
export const CONCLUSION_PAGE_TYPES = ['article', 'news', 'comparison', 'guide'] as const;

export const isCallToActionPageContext = (goalContext?: Partial<GoalContext> | null): boolean => (
  CALL_TO_ACTION_PAGE_TYPES.includes(normalizeGoalContext(goalContext).pageType as typeof CALL_TO_ACTION_PAGE_TYPES[number])
);

export const isConclusionPageContext = (goalContext?: Partial<GoalContext> | null): boolean => (
  CONCLUSION_PAGE_TYPES.includes(normalizeGoalContext(goalContext).pageType as typeof CONCLUSION_PAGE_TYPES[number])
);

export type ContentWritingFinalSectionKind = 'conclusion' | 'call_to_action';

export const getContentWritingFinalSectionKind = (
  goalContext?: Partial<GoalContext> | null,
): ContentWritingFinalSectionKind => (
  isCallToActionPageContext(goalContext) ? 'call_to_action' : 'conclusion'
);

const usesTargetLocation = (audienceScope: string): boolean => (
  TARGET_LOCATION_AUDIENCE_SCOPES.includes(audienceScope)
);

const getStoredTargetLocation = (source: Record<string, any>): string => (
  asStoredString(
    source.targetCountry ||
    source.targetLocation ||
    source.targetMarket ||
    source.location ||
    source.country
  ).trim()
);

export const isProductPageContext = (goalContext?: Partial<GoalContext> | null): boolean => (
  normalizeGoalContext(goalContext).pageType === 'product'
);

export const normalizeGoalContext = (value?: Partial<GoalContext> | null): GoalContext => {
  const source = isRecord(value) ? value : {};
  const normalized = {
    ...INITIAL_GOAL_CONTEXT,
    ...source,
  };

  const pageTypeMap: Record<string, string> = {
    article: 'article',
    'article/guide': 'article',
    'مقالة': 'article',
    'مقالة/دليل': 'article',
    faq: 'article',
    news: 'news',
    'خبر': 'news',
    service: 'service',
    'service page': 'service',
    'خدمة': 'service',
    'صفحة خدمة': 'service',
    'صفحة الخدمة': 'service',
    category: 'category',
    'category page': 'category',
    'تصنيف': 'category',
    'صفحة تصنيف': 'category',
    'تصنيف منتجات/خدمات': 'category',
    'صفحة تصنيف منتجات/خدمات': 'category',
    comparison: 'comparison',
    'comparison page': 'comparison',
    'مقارنة': 'comparison',
    'صفحة مقارنة': 'comparison',
    product: 'product',
    'product page': 'product',
    'صفحة منتج': 'product',
    'صفحة المنتج': 'product',
    'منتج': 'product',
    landing: 'landing',
    'landing page': 'landing',
    'هبوط': 'landing',
    'صفحة هبوط': 'landing',
    guide: 'guide',
    'دليل': 'guide',
  };
  const objectiveMap: Record<string, string> = {
    sell: 'convert',
    bookings: 'convert',
    leads: 'convert',
    retention: 'support',
  };
  const intentMap: Record<string, string> = {
    'local-intent': 'informational',
  };

  const audienceScope = normalizeMappedChoice(normalized.audienceScope, {}, INITIAL_GOAL_CONTEXT.audienceScope);

  const hasReaderOutcomeValue = Object.prototype.hasOwnProperty.call(source, 'readerOutcome');
  const hasDesiredActionValue = Object.prototype.hasOwnProperty.call(source, 'desiredAction');
  const readerOutcome = hasReaderOutcomeValue || hasDesiredActionValue
    ? mergeGoalContextValues(
        asStoredString(source.readerOutcome),
        asStoredString(source.desiredAction),
      )
    : INITIAL_GOAL_CONTEXT.readerOutcome;
  const hasEvidenceRequirementsValue = Object.prototype.hasOwnProperty.call(source, 'evidenceRequirements');
  const hasFreshnessRequirementsValue = Object.prototype.hasOwnProperty.call(source, 'freshnessRequirements');
  const evidenceRequirements = hasEvidenceRequirementsValue || hasFreshnessRequirementsValue
    ? mergeGoalContextValues(
        asStoredString(source.evidenceRequirements),
        asStoredString(source.freshnessRequirements),
      )
    : INITIAL_GOAL_CONTEXT.evidenceRequirements;
  const rawTargetWordRange = asStoredString(normalized.targetWordRange).trim();
  const parsedTargetWordRange = parseContentWritingTargetWordRange(rawTargetWordRange);

  return {
    targetWordRange: parsedTargetWordRange
      ? formatContentWritingTargetWordRange(parsedTargetWordRange)
      : rawTargetWordRange,
    pageType: normalizeMappedChoice(normalized.pageType, pageTypeMap, INITIAL_GOAL_CONTEXT.pageType),
    objective: normalizeMappedChoice(normalized.objective, objectiveMap, INITIAL_GOAL_CONTEXT.objective),
    audienceScope,
    targetCountry: usesTargetLocation(audienceScope) ? getStoredTargetLocation(normalized) : '',
    targetAudience: asStoredString(normalized.targetAudience).trim(),
    audienceKnowledgeLevel: asStoredString(normalized.audienceKnowledgeLevel).trim(),
    audienceNeeds: asStoredString(normalized.audienceNeeds).trim(),
    readerOutcome,
    desiredAction: readerOutcome,
    marketingStage: asStoredString(normalized.marketingStage).trim(),
    uniqueAngle: asStoredString(normalized.uniqueAngle).trim(),
    evidenceRequirements,
    freshnessRequirements: evidenceRequirements,
    brandVoice: asStoredString(normalized.brandVoice).trim(),
    topicSensitivity: asStoredString(normalized.topicSensitivity).trim(),
    searchIntent: normalizeMappedChoice(normalized.searchIntent, intentMap, INITIAL_GOAL_CONTEXT.searchIntent),
    generatedBrief: asStoredString(
      normalized.generatedBrief ||
      (source as Record<string, unknown>).smartBrief ||
      (source as Record<string, unknown>).contentBrief,
    ).trim(),
  };
};

export const shouldShowTargetLocation = (context: Partial<GoalContext>): boolean => (
  usesTargetLocation(normalizeGoalContext(context).audienceScope)
);

export const isGoalContextFieldVisible = (
  field: GoalContextFieldConfig,
  context: Partial<GoalContext>,
): boolean => {
  if (field.kind !== 'text' || !field.visibleForAudienceScopes) return true;
  return field.visibleForAudienceScopes.includes(normalizeGoalContext(context).audienceScope);
};

export const updateGoalContextField = (
  currentContext: GoalContext,
  key: keyof GoalContext,
  value: string,
): GoalContext => {
  if (key === 'readerOutcome' || key === 'desiredAction') {
    return {
      ...currentContext,
      readerOutcome: value,
      desiredAction: value,
    };
  }

  if (key === 'evidenceRequirements' || key === 'freshnessRequirements') {
    return {
      ...currentContext,
      evidenceRequirements: value,
      freshnessRequirements: value,
    };
  }

  // Preserve spaces and line breaks while the user is actively typing.
  // normalizeGoalContext still trims these fields at persistence and prompt boundaries.
  if (GOAL_CONTEXT_FREE_TEXT_KEYS.has(key)) {
    return {
      ...currentContext,
      [key]: value,
    };
  }

  const nextContext = normalizeGoalContext({
    ...currentContext,
    [key]: value,
  });

  if (key === 'pageType' && value === 'category') {
    return {
      ...nextContext,
      objective: 'category-support',
    };
  }

  return nextContext;
};

export const normalizeClientGoalContexts = (
  value?: Record<string, Partial<GoalContext>> | null,
): ClientGoalContexts => {
  if (!isRecord(value)) return {};

  return Object.entries(value).reduce<ClientGoalContexts>((acc, [companyName, context]) => {
    const normalizedCompany = companyName.trim();
    if (normalizedCompany) {
      acc[normalizedCompany] = normalizeGoalContext({
        ...context,
        generatedBrief: '',
      });
    }
    return acc;
  }, {});
};

export const getGoalContextFields = (t: GoalTabTranslations): GoalContextFieldConfig[] => {
  const contextOptions = t.contextOptions;
  const isEnglish = t === translations.en.goalTab;
  const localized = (arabic: string, english: string): string => (
    isEnglish ? english : arabic
  );
  const multiOption = (
    value: string,
    arabic: string,
    english: string,
  ): GoalContextOption => ({
    value,
    label: localized(arabic, english),
  });
  const customPlaceholder = localized(
    'اكتب خيارًا آخر ثم اضغط Enter',
    'Type another option, then press Enter',
  );

  return [
    {
      key: 'targetWordRange',
      label: t.targetWordRange,
      kind: 'text',
      placeholder: t.targetWordRangePlaceholder,
      helpText: t.targetWordRangeHelp,
    },
    {
      key: 'pageType',
      label: t.pageType,
      kind: 'select',
      options: [
        { value: 'article', label: contextOptions.article },
        { value: 'news', label: contextOptions.news },
        { value: 'service', label: contextOptions.service },
        { value: 'category', label: contextOptions.categoryPage },
        { value: 'comparison', label: contextOptions.comparisonPage },
        { value: 'product', label: contextOptions.product },
        { value: 'landing', label: contextOptions.landing },
        { value: 'guide', label: contextOptions.guide },
      ],
    },
    {
      key: 'objective',
      label: t.objective,
      kind: 'select',
      helpText: t.objectiveHelp,
      options: [
        { value: 'educate', label: contextOptions.educate },
        { value: 'compare', label: contextOptions.compare },
        { value: 'convert', label: contextOptions.convert },
        { value: 'category-support', label: contextOptions.categorySupport },
        { value: 'trust', label: contextOptions.trust },
        { value: 'support', label: contextOptions.support },
      ],
    },
    {
      key: 'audienceScope',
      label: t.audienceScope,
      kind: 'select',
      options: [
        { value: 'local', label: contextOptions.local },
        { value: 'country', label: contextOptions.country },
        { value: 'regional', label: contextOptions.regional },
        { value: 'global', label: contextOptions.global },
      ],
    },
    {
      key: 'targetCountry',
      label: t.targetLocation,
      kind: 'text',
      placeholder: t.targetLocationPlaceholder,
      visibleForAudienceScopes: TARGET_LOCATION_AUDIENCE_SCOPES,
    },
    {
      key: 'searchIntent',
      label: t.searchIntent,
      kind: 'select',
      helpText: t.searchIntentHelp,
      options: [
        { value: 'informational', label: contextOptions.informational },
        { value: 'commercial', label: contextOptions.commercial },
        { value: 'commercial-support', label: contextOptions.commercialSupport },
        { value: 'transactional', label: contextOptions.transactional },
        { value: 'navigational', label: contextOptions.navigational },
        { value: 'support-intent', label: contextOptions.supportIntent },
      ],
    },
    {
      key: 'targetAudience',
      label: t.targetAudience,
      kind: 'multi-choice',
      customPlaceholder,
      options: [
        multiOption('general-interested-audience', 'جمهور عام مهتم بالموضوع', 'General audience interested in the topic'),
        multiOption('business-owners', 'أصحاب الأعمال والشركات', 'Business and company owners'),
        multiOption('decision-makers', 'صناع القرار والمديرون', 'Decision-makers and managers'),
        multiOption('professionals-specialists', 'المهنيون والمتخصصون', 'Professionals and specialists'),
        multiOption('beginners-learners', 'المبتدئون والمتعلمون', 'Beginners and learners'),
        multiOption('potential-customers', 'العملاء المحتملون', 'Potential customers'),
        multiOption('existing-customers', 'العملاء الحاليون', 'Existing customers'),
        multiOption('consumers-end-users', 'المستهلكون والمستخدمون النهائيون', 'Consumers and end users'),
      ],
    },
    {
      key: 'audienceKnowledgeLevel',
      label: t.audienceKnowledgeLevel,
      kind: 'multi-choice',
      customPlaceholder,
      options: [
        { value: 'beginner', label: contextOptions.beginner },
        { value: 'intermediate', label: contextOptions.intermediate },
        { value: 'expert', label: contextOptions.expert },
        { value: 'mixed', label: contextOptions.mixed },
        multiOption('non-technical', 'غير تقني', 'Non-technical'),
        multiOption('specialized-technical', 'تقني متخصص', 'Specialized technical'),
      ],
    },
    {
      key: 'audienceNeeds',
      label: t.audienceNeeds,
      kind: 'multi-choice',
      customPlaceholder,
      options: [
        multiOption('clear-practical-answers', 'إجابات واضحة وعملية', 'Clear, practical answers'),
        multiOption('step-by-step-guidance', 'خطوات تنفيذية مرتبة', 'Step-by-step guidance'),
        multiOption('compare-alternatives', 'مقارنة البدائل والخيارات', 'Compare alternatives and options'),
        multiOption('solve-specific-problem', 'حل مشكلة محددة', 'Solve a specific problem'),
        multiOption('costs-pricing', 'فهم التكاليف والأسعار', 'Understand costs and pricing'),
        multiOption('avoid-mistakes', 'تجنب الأخطاء والمخاطر', 'Avoid mistakes and risks'),
        multiOption('examples-use-cases', 'أمثلة وحالات استخدام', 'Examples and use cases'),
        multiOption('common-questions', 'إجابات عن الأسئلة الشائعة', 'Answers to common questions'),
      ],
    },
    {
      key: 'readerOutcome',
      label: localized('النتيجة والإجراء المطلوب للقارئ', 'Reader outcome and desired action'),
      kind: 'multi-choice',
      customPlaceholder,
      options: [
        multiOption('understand-and-next-step', 'فهم الموضوع ومعرفة الخطوة التالية', 'Understand the topic and know the next step'),
        multiOption('make-informed-decision', 'اتخاذ قرار مبني على معلومات', 'Make an informed decision'),
        multiOption('apply-recommendations', 'تطبيق الخطوات أو التوصيات', 'Apply the steps or recommendations'),
        multiOption('compare-and-choose', 'مقارنة الخيارات واختيار الأنسب', 'Compare options and choose the best fit'),
        multiOption('request-service-contact', 'طلب خدمة أو استشارة أو تواصل', 'Request a service, consultation, or contact'),
        multiOption('solve-problem-independently', 'حل المشكلة بصورة مستقلة', 'Solve the problem independently'),
        multiOption('build-confidence', 'زيادة الفهم والثقة بالقرار', 'Increase understanding and confidence'),
      ],
    },
    {
      key: 'marketingStage',
      label: t.marketingStage,
      kind: 'multi-choice',
      customPlaceholder,
      options: [
        { value: 'awareness', label: contextOptions.awareness },
        { value: 'consideration', label: contextOptions.consideration },
        { value: 'decision', label: contextOptions.decision },
        { value: 'retention', label: contextOptions.retentionStage },
        multiOption('loyalty-advocacy', 'الولاء والتوصية', 'Loyalty and advocacy'),
      ],
    },
    {
      key: 'uniqueAngle',
      label: t.uniqueAngle,
      kind: 'multi-choice',
      customPlaceholder,
      options: [
        multiOption('practical-actionable', 'طرح عملي واضح قابل للتطبيق', 'Clear, practical, and actionable'),
        multiOption('comprehensive-coverage', 'تغطية شاملة ومنظمة', 'Comprehensive, structured coverage'),
        multiOption('evidence-data-led', 'طرح مبني على الأدلة والبيانات', 'Evidence- and data-led'),
        multiOption('simple-for-beginners', 'تبسيط الموضوع للمبتدئين', 'Simplified for beginners'),
        multiOption('expert-depth', 'عمق متخصص للخبراء', 'Specialist depth for experts'),
        multiOption('local-market-context', 'ملاءمة للسوق أو المنطقة المستهدفة', 'Adapted to the target market or region'),
        multiOption('neutral-comparison', 'مقارنة محايدة تساعد على الاختيار', 'Neutral comparison that supports choice'),
        multiOption('mistakes-and-solutions', 'كشف الأخطاء الشائعة وحلولها', 'Common mistakes and their solutions'),
      ],
    },
    {
      key: 'evidenceRequirements',
      label: localized('متطلبات الأدلة وحداثة المعلومات', 'Evidence and information freshness'),
      kind: 'multi-choice',
      customPlaceholder,
      options: [
        multiOption('reliable-current-sources', 'مصادر موثوقة وحديثة', 'Reliable, current sources'),
        multiOption('official-primary-sources', 'مصادر رسمية وأولية', 'Official and primary sources'),
        multiOption('studies-statistics', 'دراسات وإحصائيات موثقة', 'Documented studies and statistics'),
        multiOption('expert-quotes', 'آراء أو اقتباسات خبراء', 'Expert opinions or quotations'),
        multiOption('cases-real-examples', 'دراسات حالة وأمثلة واقعية', 'Case studies and real examples'),
        multiOption('current-laws-regulations', 'قوانين ولوائح محدثة', 'Current laws and regulations'),
        multiOption('recent-prices-dates', 'أسعار وتواريخ ومعلومات زمنية حديثة', 'Recent prices, dates, and time-sensitive information'),
        multiOption('source-every-claim', 'توثيق كل ادعاء مهم بمصدر', 'Source every material claim'),
      ],
    },
    {
      key: 'brandVoice',
      label: t.brandVoice,
      kind: 'multi-choice',
      customPlaceholder,
      options: [
        multiOption('formal-professional', 'رسمي احترافي', 'Formal and professional'),
        multiOption('clear-simple', 'واضح وبسيط', 'Clear and simple'),
        multiOption('friendly-conversational', 'ودود وحواري', 'Friendly and conversational'),
        multiOption('authoritative-expert', 'خبير وموثوق', 'Authoritative and expert'),
        multiOption('neutral-objective', 'محايد وموضوعي', 'Neutral and objective'),
        multiOption('persuasive-balanced', 'إقناعي متوازن دون مبالغة', 'Persuasive and balanced without hype'),
        multiOption('educational-guiding', 'تعليمي وإرشادي', 'Educational and guiding'),
        multiOption('reassuring-supportive', 'مطمئن وداعم', 'Reassuring and supportive'),
      ],
    },
    {
      key: 'topicSensitivity',
      label: t.topicSensitivity,
      kind: 'multi-choice',
      customPlaceholder,
      options: [
        { value: 'standard', label: contextOptions.standardSensitivity },
        { value: 'health', label: contextOptions.healthSensitivity },
        { value: 'financial', label: contextOptions.financialSensitivity },
        { value: 'legal', label: contextOptions.legalSensitivity },
        { value: 'safety', label: contextOptions.safetySensitivity },
        multiOption('privacy-security', 'خصوصية وأمن معلومات', 'Privacy and information security'),
        multiOption('cultural-religious', 'ثقافي أو ديني', 'Cultural or religious'),
        multiOption('political-public', 'سياسي أو شأن عام', 'Political or public affairs'),
      ],
    },
  ];
};

const getFieldOptionLabel = (
  fields: GoalContextFieldConfig[],
  key: keyof GoalContext,
  value: string,
): string => {
  const field = fields.find(item => item.key === key);
  if (!field || (field.kind !== 'select' && field.kind !== 'multi-choice')) return value;
  if (field.kind === 'multi-choice') {
    return parseGoalContextMultiValue(value)
      .map(item => field.options.find(option => option.value === item)?.label || item)
      .join('، ');
  }
  return field.options.find(option => option.value === value)?.label || value;
};

export const formatGoalContextValue = (
  key: keyof GoalContext,
  value: string,
  t: GoalTabTranslations = translations.ar.goalTab,
): string => getFieldOptionLabel(getGoalContextFields(t), key, value);

const getTranslatedChoiceLabel = (
  t: GoalTabTranslations,
  key: keyof GoalContext,
  value: string,
  compact = false,
): string => {
  const optionKey = CONTEXT_OPTION_TRANSLATION_KEYS[key]?.[value];
  if (!optionKey) return value;
  if (compact) {
    const compactLabel = t.contextCompactOptions[
      optionKey as keyof GoalTabTranslations['contextCompactOptions']
    ];
    if (compactLabel) return compactLabel;
  }
  return t.contextOptions[optionKey] || value;
};

export const getGoalContextPresetOptions = (t: GoalTabTranslations): GoalContextPresetOption[] => {
  const fields = getGoalContextFields(t);

  return GOAL_CONTEXT_PRESETS.map(preset => {
    const context = normalizeGoalContext({
      ...INITIAL_GOAL_CONTEXT,
      ...preset,
    });
    const compactLabel = [
      getTranslatedChoiceLabel(t, 'pageType', preset.pageType, true),
      getTranslatedChoiceLabel(t, 'objective', preset.objective, true),
      getTranslatedChoiceLabel(t, 'audienceScope', preset.audienceScope, true),
      getTranslatedChoiceLabel(t, 'searchIntent', preset.searchIntent, true),
    ].join(' - ');
    const fullLabel = [
      getFieldOptionLabel(fields, 'pageType', preset.pageType),
      getFieldOptionLabel(fields, 'objective', preset.objective),
      getFieldOptionLabel(fields, 'audienceScope', preset.audienceScope),
      getFieldOptionLabel(fields, 'searchIntent', preset.searchIntent),
    ].join(' - ');

    return {
      value: preset.id,
      label: compactLabel,
      searchText: `${compactLabel} ${fullLabel}`,
      context,
    };
  });
};

export const formatGoalContextForCopy = (
  companyName: string,
  context: GoalContext,
  t: GoalTabTranslations,
): string => {
  const fields = getGoalContextFields(t);
  const normalizedContext = normalizeGoalContext(context);
  const lines = companyName.trim() ? [`${t.companyName}:`, companyName.trim(), ''] : [];

  fields
    .filter(field => isGoalContextFieldVisible(field, normalizedContext))
    .forEach(field => {
      const rawValue = normalizedContext[field.key] || '';
      const value = getFieldOptionLabel(fields, field.key, rawValue);
      lines.push(`${field.label}:`);
      lines.push(value || '-');
      lines.push('');
    });

  if (normalizedContext.generatedBrief) {
    lines.push(`${t.generatedBriefLabel}:`);
    lines.push(normalizedContext.generatedBrief);
    lines.push('');
  }

  return lines.join('\n').trim();
};

const normalizeToken = (value: string) => value.trim().toLowerCase();

const resolveChoiceFieldValue = (
  field: GoalContextFieldConfig,
  rawValue: string,
): { value: string; matched: boolean } => {
  const value = rawValue.trim();
  if (field.kind !== 'select' || !value) {
    return { value: INITIAL_GOAL_CONTEXT[field.key] || '', matched: false };
  }

  const normalizedValue = normalizeToken(value);
  const matchedOption = field.options.find(option => (
    normalizeToken(option.value) === normalizedValue ||
    normalizeToken(option.label) === normalizedValue
  ));

  return {
    value: matchedOption?.value || INITIAL_GOAL_CONTEXT[field.key] || '',
    matched: Boolean(matchedOption),
  };
};

const resolveFieldValue = (field: GoalContextFieldConfig, rawValue: string): string => {
  const value = rawValue.trim();
  if (!value) return INITIAL_GOAL_CONTEXT[field.key] || '';
  if (field.kind === 'text') return value;
  return resolveChoiceFieldValue(field, rawValue).value;
};

const getFieldByKey = (
  fields: GoalContextFieldConfig[],
  key: keyof GoalContext,
): GoalContextFieldConfig => {
  const field = fields.find(item => item.key === key);
  if (!field) throw new Error(`Missing goal context field: ${String(key)}`);
  return field;
};

const normalizeBulkMatchText = (value: string): string => value
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/\s*[\\/]\s*/g, ' ')
  .replace(/[|*•·,،;؛.\t\r\n]+/g, ' ')
  .replace(/[‐‑‒–—−-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const isAsciiLetter = (value: string) => /^[A-Za-z]$/.test(value);
const isDigit = (value: string) => /^\d$/.test(value);

const isLooseSeparator = (char: string, previous: string, next: string): boolean => {
  if (['|', '\t', '*', '•', '·', ',', '،', ';', '؛'].includes(char)) return true;
  if (['-', '–', '—'].includes(char)) return !(isAsciiLetter(previous) && isAsciiLetter(next));
  if (char === '.') return !(isAsciiLetter(previous) && isAsciiLetter(next)) && !(isDigit(previous) && isDigit(next));
  return false;
};

const getChoiceCandidates = (field: GoalContextFieldConfig): { value: string; token: string }[] => {
  if (field.kind !== 'select') return [];

  const seen = new Set<string>();
  const candidates = field.options.flatMap(option => {
    const aliases = CHOICE_ALIASES[field.key]?.[option.value] || [];
    return [option.label, option.value, ...aliases].map(rawValue => ({
      value: option.value,
      token: normalizeBulkMatchText(rawValue),
    }));
  });

  return candidates
    .filter(candidate => {
      if (!candidate.token || seen.has(candidate.token)) return false;
      seen.add(candidate.token);
      return true;
    })
    .sort((left, right) => right.token.length - left.token.length);
};

const isTokenBoundary = (value: string, index: number): boolean => (
  index <= 0 || index >= value.length || value[index] === ' '
);

const matchChoicePrefix = (
  field: GoalContextFieldConfig,
  rawText: string,
): { value: string; rest: string; matched: boolean } => {
  const text = normalizeBulkMatchText(rawText);
  const matchedCandidate = getChoiceCandidates(field).find(candidate => (
    text === candidate.token ||
    (text.startsWith(`${candidate.token} `) && isTokenBoundary(text, candidate.token.length))
  ));

  if (!matchedCandidate) {
    return { value: INITIAL_GOAL_CONTEXT[field.key] || '', rest: text, matched: false };
  }

  return {
    value: matchedCandidate.value,
    rest: text.slice(matchedCandidate.token.length).trim(),
    matched: true,
  };
};

const matchChoiceSuffix = (
  field: GoalContextFieldConfig,
  rawText: string,
): { value: string; before: string; matched: boolean } => {
  const text = normalizeBulkMatchText(rawText);
  const matchedCandidate = getChoiceCandidates(field).find(candidate => (
    text === candidate.token ||
    (text.endsWith(` ${candidate.token}`) && isTokenBoundary(text, text.length - candidate.token.length - 1))
  ));

  if (!matchedCandidate) {
    return { value: INITIAL_GOAL_CONTEXT[field.key] || '', before: text, matched: false };
  }

  return {
    value: matchedCandidate.value,
    before: text.slice(0, text.length - matchedCandidate.token.length).trim(),
    matched: true,
  };
};

const findChoiceStart = (
  field: GoalContextFieldConfig,
  rawText: string,
): { index: number; token: string } | null => {
  const text = normalizeBulkMatchText(rawText);
  let bestMatch: { index: number; token: string } | null = null;

  getChoiceCandidates(field).forEach(candidate => {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const index = text.indexOf(candidate.token, searchFrom);
      if (index === -1) break;

      const beforeBoundary = index === 0 || text[index - 1] === ' ';
      const afterIndex = index + candidate.token.length;
      const afterBoundary = afterIndex === text.length || text[afterIndex] === ' ';
      if (beforeBoundary && afterBoundary) {
        if (!bestMatch || index < bestMatch.index || (index === bestMatch.index && candidate.token.length > bestMatch.token.length)) {
          bestMatch = { index, token: candidate.token };
        }
        break;
      }

      searchFrom = index + 1;
    }
  });

  return bestMatch;
};

type FlexibleChoiceMatch = {
  key: keyof GoalContext;
  value: string;
  token: string;
  start: number;
  end: number;
};

const rangesOverlap = (
  left: Pick<FlexibleChoiceMatch, 'start' | 'end'>,
  right: Pick<FlexibleChoiceMatch, 'start' | 'end'>,
): boolean => left.start < right.end && right.start < left.end;

const findChoiceAnywhere = (
  field: GoalContextFieldConfig,
  rawText: string,
  usedRanges: Pick<FlexibleChoiceMatch, 'start' | 'end'>[] = [],
): FlexibleChoiceMatch | null => {
  const text = normalizeBulkMatchText(rawText);
  let bestMatch: FlexibleChoiceMatch | null = null;

  getChoiceCandidates(field).forEach(candidate => {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const start = text.indexOf(candidate.token, searchFrom);
      if (start === -1) break;

      const end = start + candidate.token.length;
      const beforeBoundary = start === 0 || text[start - 1] === ' ';
      const afterBoundary = end === text.length || text[end] === ' ';
      const overlapsUsedRange = usedRanges.some(range => rangesOverlap({ start, end }, range));

      if (beforeBoundary && afterBoundary && !overlapsUsedRange) {
        if (
          !bestMatch ||
          candidate.token.length > bestMatch.token.length ||
          (candidate.token.length === bestMatch.token.length && start < bestMatch.start)
        ) {
          bestMatch = {
            key: field.key,
            value: candidate.value,
            token: candidate.token,
            start,
            end,
          };
        }
        break;
      }

      searchFrom = start + 1;
    }
  });

  return bestMatch;
};

const removeMatchedRanges = (
  rawText: string,
  ranges: Pick<FlexibleChoiceMatch, 'start' | 'end'>[],
): string => {
  const text = normalizeBulkMatchText(rawText);
  if (!text || ranges.length === 0) return text;

  const chars = Array.from(text);
  ranges.forEach(range => {
    for (let index = range.start; index < range.end; index += 1) {
      chars[index] = ' ';
    }
  });

  return chars.join('').replace(/\s+/g, ' ').trim();
};

const parseFlexibleGoalContextText = (
  contextText: string,
  fields: GoalContextFieldConfig[],
): { context: Partial<GoalContext>; complete: boolean } => {
  const fieldKeys: (keyof GoalContext)[] = ['pageType', 'objective', 'audienceScope', 'searchIntent'];
  const matches: Partial<Record<keyof GoalContext, FlexibleChoiceMatch>> = {};
  const usedRanges: Pick<FlexibleChoiceMatch, 'start' | 'end'>[] = [];

  fieldKeys.forEach(key => {
    const field = getFieldByKey(fields, key);
    const match = findChoiceAnywhere(field, contextText, usedRanges);
    if (!match) return;

    matches[key] = match;
    usedRanges.push({ start: match.start, end: match.end });
  });

  const context: Partial<GoalContext> = {
    pageType: matches.pageType?.value || INITIAL_GOAL_CONTEXT.pageType,
    objective: matches.objective?.value || INITIAL_GOAL_CONTEXT.objective,
    audienceScope: matches.audienceScope?.value || INITIAL_GOAL_CONTEXT.audienceScope,
    searchIntent: matches.searchIntent?.value || INITIAL_GOAL_CONTEXT.searchIntent,
  };

  if (usesTargetLocation(context.audienceScope || '')) {
    context.targetCountry = removeMatchedRanges(contextText, usedRanges);
  }

  return {
    context,
    complete: fieldKeys.every(key => Boolean(matches[key])),
  };
};

const startsWithPageType = (
  value: string,
  fields: GoalContextFieldConfig[],
): boolean => {
  const pageTypeField = getFieldByKey(fields, 'pageType');
  return matchChoicePrefix(pageTypeField, value).matched;
};

const splitBulkCompanyAndContext = (
  line: string,
  fields: GoalContextFieldConfig[],
): { companyName: string; contextText: string } => {
  const chars = Array.from(line);

  for (let index = 0; index < chars.length; index += 1) {
    const previous = chars[index - 1] || '';
    const next = chars[index + 1] || '';
    if (!isLooseSeparator(chars[index], previous, next)) continue;

    const companyName = chars.slice(0, index).join('').trim();
    const contextText = chars.slice(index + 1).join('').trim();
    if (companyName && startsWithPageType(contextText, fields)) {
      return { companyName, contextText };
    }
  }

  const normalizedLine = normalizeBulkMatchText(line);
  const pageTypeField = getFieldByKey(fields, 'pageType');
  const contextStart = findChoiceStart(pageTypeField, normalizedLine);

  if (!contextStart) {
    return { companyName: normalizedLine, contextText: '' };
  }

  return {
    companyName: normalizedLine.slice(0, contextStart.index).trim(),
    contextText: normalizedLine.slice(contextStart.index).trim(),
  };
};

const parseBulkContextText = (
  contextText: string,
  fields: GoalContextFieldConfig[],
): Partial<GoalContext> => {
  const flexibleResult = parseFlexibleGoalContextText(contextText, fields);
  if (flexibleResult.complete) return flexibleResult.context;

  const pageTypeField = getFieldByKey(fields, 'pageType');
  const objectiveField = getFieldByKey(fields, 'objective');
  const audienceScopeField = getFieldByKey(fields, 'audienceScope');
  const searchIntentField = getFieldByKey(fields, 'searchIntent');
  const pageTypeMatch = matchChoicePrefix(pageTypeField, contextText);
  const objectiveMatch = matchChoicePrefix(objectiveField, pageTypeMatch.rest);
  const audienceScopeMatch = matchChoicePrefix(audienceScopeField, objectiveMatch.rest);
  const intentPrefixMatch = matchChoicePrefix(searchIntentField, audienceScopeMatch.rest);
  const intentSuffixMatch = matchChoiceSuffix(searchIntentField, audienceScopeMatch.rest);
  const audienceScope = audienceScopeMatch.value;
  const context: Partial<GoalContext> = {
    pageType: pageTypeMatch.value,
    objective: objectiveMatch.value,
    audienceScope,
  };

  if (usesTargetLocation(audienceScope)) {
    if (intentPrefixMatch.matched) {
      context.searchIntent = intentPrefixMatch.value;
    } else if (intentSuffixMatch.matched) {
      context.targetCountry = intentSuffixMatch.before;
      context.searchIntent = intentSuffixMatch.value;
    } else {
      context.targetCountry = audienceScopeMatch.rest;
      context.searchIntent = resolveFieldValue(searchIntentField, '');
    }
  } else {
    context.searchIntent = intentPrefixMatch.matched
      ? intentPrefixMatch.value
      : intentSuffixMatch.value;
  }

  return context;
};

export const parseGoalContextText = (
  text: string,
  t: GoalTabTranslations,
): GoalContext | null => {
  if (!text.trim()) return null;

  const fields = getGoalContextFields(t);
  const flexibleResult = parseFlexibleGoalContextText(text, fields);
  return flexibleResult.complete
    ? normalizeGoalContext(flexibleResult.context)
    : null;
};

export const parseClientGoalContextBulk = (
  text: string,
  t: GoalTabTranslations,
): { presets: ClientGoalContexts; skipped: number } => {
  const fields = getGoalContextFields(t);
  let skipped = 0;

  const presets = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .reduce<ClientGoalContexts>((acc, line) => {
      const { companyName, contextText } = splitBulkCompanyAndContext(line, fields);

      if (!companyName || !contextText) {
        skipped += 1;
        return acc;
      }

      acc[companyName] = normalizeGoalContext(parseBulkContextText(contextText, fields));
      return acc;
    }, {});

  return { presets, skipped };
};
