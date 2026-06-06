import { INITIAL_GOAL_CONTEXT } from '../constants';
import { translations } from '../components/translations';
import type { ClientGoalContexts, GoalContext } from '../types';

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
    }
  | {
      key: keyof GoalContext;
      kind: 'text';
      label: string;
      placeholder: string;
      visibleForAudienceScopes?: string[];
    };

type GoalContextPreset = Pick<GoalContext, 'pageType' | 'objective' | 'audienceScope' | 'searchIntent'> & {
  id: string;
};

export type GoalContextPresetOption = {
  value: string;
  label: string;
  context: GoalContext;
};

const TARGET_LOCATION_AUDIENCE_SCOPES = ['local', 'country', 'regional'];

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
    faq: 'article',
    product: 'product',
    'product page': 'product',
    'صفحة منتج': 'product',
    'صفحة المنتج': 'product',
    'منتج': 'product',
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

  return {
    pageType: normalizeMappedChoice(normalized.pageType, pageTypeMap, INITIAL_GOAL_CONTEXT.pageType),
    objective: normalizeMappedChoice(normalized.objective, objectiveMap, INITIAL_GOAL_CONTEXT.objective),
    audienceScope,
    targetCountry: usesTargetLocation(audienceScope) ? getStoredTargetLocation(normalized) : '',
    targetAudience: asStoredString(normalized.targetAudience).trim(),
    searchIntent: normalizeMappedChoice(normalized.searchIntent, intentMap, INITIAL_GOAL_CONTEXT.searchIntent),
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
      acc[normalizedCompany] = normalizeGoalContext(context);
    }
    return acc;
  }, {});
};

export const getGoalContextFields = (t: GoalTabTranslations): GoalContextFieldConfig[] => {
  const contextOptions = t.contextOptions;

  return [
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
      options: [
        { value: 'informational', label: contextOptions.informational },
        { value: 'commercial', label: contextOptions.commercial },
        { value: 'commercial-support', label: contextOptions.commercialSupport },
        { value: 'transactional', label: contextOptions.transactional },
        { value: 'navigational', label: contextOptions.navigational },
        { value: 'support-intent', label: contextOptions.supportIntent },
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
  if (!field || field.kind !== 'select') return value;
  return field.options.find(option => option.value === value)?.label || value;
};

export const getGoalContextPresetOptions = (t: GoalTabTranslations): GoalContextPresetOption[] => {
  const fields = getGoalContextFields(t);

  return GOAL_CONTEXT_PRESETS.map(preset => {
    const context = normalizeGoalContext({
      ...INITIAL_GOAL_CONTEXT,
      ...preset,
    });
    const label = [
      getFieldOptionLabel(fields, 'pageType', preset.pageType),
      getFieldOptionLabel(fields, 'objective', preset.objective),
      getFieldOptionLabel(fields, 'audienceScope', preset.audienceScope),
      getFieldOptionLabel(fields, 'searchIntent', preset.searchIntent),
    ].join(' - ');

    return {
      value: preset.id,
      label,
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
      const rawValue = normalizedContext[field.key];
      const value = field.kind === 'text'
        ? rawValue
        : field.options.find(option => option.value === rawValue)?.label || rawValue;
      lines.push(`${field.label}:`);
      lines.push(value || '-');
      lines.push('');
    });

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
  const candidates = field.options.flatMap(option => [option.label, option.value].map(rawValue => ({
    value: option.value,
    token: normalizeBulkMatchText(rawValue),
  })));

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
