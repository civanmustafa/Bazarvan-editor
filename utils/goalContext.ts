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
    };

const normalizeChoiceToken = (value?: string | null): string => (
  String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
);

const normalizeMappedChoice = (value: string | undefined, choiceMap: Record<string, string>, fallback: string): string => {
  const token = normalizeChoiceToken(value);
  if (!token) return fallback;
  return choiceMap[token] || value || fallback;
};

export const isProductPageContext = (goalContext?: Partial<GoalContext> | null): boolean => (
  normalizeGoalContext(goalContext).pageType === 'product'
);

export const normalizeGoalContext = (value?: Partial<GoalContext> | null): GoalContext => {
  const normalized = {
    ...INITIAL_GOAL_CONTEXT,
    ...(value || {}),
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

  return {
    pageType: normalizeMappedChoice(normalized.pageType, pageTypeMap, INITIAL_GOAL_CONTEXT.pageType),
    objective: normalizeMappedChoice(normalized.objective, objectiveMap, INITIAL_GOAL_CONTEXT.objective),
    audienceScope: normalized.audienceScope,
    targetCountry: '',
    targetAudience: '',
    searchIntent: normalizeMappedChoice(normalized.searchIntent, intentMap, INITIAL_GOAL_CONTEXT.searchIntent),
  };
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
  return Object.entries(value || {}).reduce<ClientGoalContexts>((acc, [companyName, context]) => {
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

export const formatGoalContextForCopy = (
  companyName: string,
  context: GoalContext,
  t: GoalTabTranslations,
): string => {
  const fields = getGoalContextFields(t);
  const normalizedContext = normalizeGoalContext(context);
  const lines = companyName.trim() ? [`${t.companyName}:`, companyName.trim(), ''] : [];

  fields.forEach(field => {
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

const resolveFieldValue = (field: GoalContextFieldConfig, rawValue: string): string => {
  const value = rawValue.trim();
  if (!value) return INITIAL_GOAL_CONTEXT[field.key] || '';
  if (field.kind === 'text') return value;

  const normalizedValue = normalizeToken(value);
  const matchedOption = field.options.find(option => (
    normalizeToken(option.value) === normalizedValue ||
    normalizeToken(option.label) === normalizedValue
  ));

  return matchedOption?.value || INITIAL_GOAL_CONTEXT[field.key] || '';
};

const splitBulkLine = (line: string): string[] => {
  if (line.includes('|')) return line.split('|');
  if (line.includes('\t')) return line.split('\t');
  return line.split(/[,،;]/);
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
      const parts = splitBulkLine(line).map(part => part.trim());
      const companyName = parts[0];

      if (!companyName) {
        skipped += 1;
        return acc;
      }

      const context = fields.reduce<Partial<GoalContext>>((draft, field, index) => {
        return {
          ...draft,
          [field.key]: resolveFieldValue(field, parts[index + 1] || ''),
        };
      }, {});

      acc[companyName] = normalizeGoalContext(context);
      return acc;
    }, {});

  return { presets, skipped };
};
