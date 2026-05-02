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

export const normalizeGoalContext = (value?: Partial<GoalContext> | null): GoalContext => {
  const normalized = {
    ...INITIAL_GOAL_CONTEXT,
    ...(value || {}),
  };

  const objectiveMap: Record<string, string> = {
    sell: 'convert',
    bookings: 'convert',
    leads: 'convert',
    retention: 'support',
  };
  const awarenessMap: Record<string, string> = {
    'ready-to-buy': 'decision-ready',
  };
  const intentMap: Record<string, string> = {
    'local-intent': 'informational',
  };

  return {
    ...normalized,
    objective: objectiveMap[normalized.objective] || normalized.objective,
    audienceAwareness: awarenessMap[normalized.audienceAwareness] || normalized.audienceAwareness,
    searchIntent: intentMap[normalized.searchIntent] || normalized.searchIntent,
  };
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
        { value: 'comparison', label: contextOptions.comparisonPage },
        { value: 'product', label: contextOptions.product },
        { value: 'landing', label: contextOptions.landing },
        { value: 'guide', label: contextOptions.guide },
        { value: 'faq', label: contextOptions.faq },
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
        { value: 'trust', label: contextOptions.trust },
        { value: 'support', label: contextOptions.support },
      ],
    },
    {
      key: 'audienceAwareness',
      label: t.audienceAwareness,
      kind: 'select',
      options: [
        { value: 'unaware', label: contextOptions.unaware },
        { value: 'problem-aware', label: contextOptions.problemAware },
        { value: 'solution-aware', label: contextOptions.solutionAware },
        { value: 'product-aware', label: contextOptions.productAware },
        { value: 'decision-ready', label: contextOptions.decisionReady },
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
      label: t.targetCountry,
      kind: 'text',
      placeholder: t.targetCountryPlaceholder,
    },
    {
      key: 'targetAudience',
      label: t.targetAudience,
      kind: 'text',
      placeholder: t.targetAudiencePlaceholder,
    },
    {
      key: 'searchIntent',
      label: t.searchIntent,
      kind: 'select',
      options: [
        { value: 'informational', label: contextOptions.informational },
        { value: 'commercial', label: contextOptions.commercial },
        { value: 'transactional', label: contextOptions.transactional },
        { value: 'navigational', label: contextOptions.navigational },
        { value: 'support-intent', label: contextOptions.supportIntent },
      ],
    },
    {
      key: 'funnelStage',
      label: t.funnelStage,
      kind: 'select',
      options: [
        { value: 'awareness', label: contextOptions.awareness },
        { value: 'consideration', label: contextOptions.consideration },
        { value: 'decision', label: contextOptions.decision },
        { value: 'loyalty', label: contextOptions.loyalty },
      ],
    },
  ];
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
