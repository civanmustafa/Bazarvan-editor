export const ARTICLE_STATUS_VALUES = [
  'content_preparation',
  'draft',
  'in_review',
  'published',
  'archived',
] as const;

export type ArticleStatus = typeof ARTICLE_STATUS_VALUES[number];
export type ArticleStatusFilter = 'all' | ArticleStatus;

type ArticleStatusDefinition = {
  value: ArticleStatus;
  labelAr: string;
  labelEn: string;
};

export const ARTICLE_STATUS_DEFINITIONS: readonly ArticleStatusDefinition[] = [
  { value: 'content_preparation', labelAr: 'تجهيز محتوى', labelEn: 'Content preparation' },
  { value: 'draft', labelAr: 'مسودة', labelEn: 'Draft' },
  { value: 'in_review', labelAr: 'جاهز', labelEn: 'Ready' },
  { value: 'published', labelAr: 'منشور', labelEn: 'Published' },
  { value: 'archived', labelAr: 'أرشيف', labelEn: 'Archived' },
];

export const ARTICLE_STATUS_OPTIONS = ARTICLE_STATUS_DEFINITIONS.map(definition => ({
  value: definition.value,
  label: definition.labelAr,
}));

export const ARTICLE_STATUS_LABELS_AR: Record<ArticleStatus, string> = Object.fromEntries(
  ARTICLE_STATUS_DEFINITIONS.map(definition => [definition.value, definition.labelAr]),
) as Record<ArticleStatus, string>;

export const DASHBOARD_ARTICLE_STATUS_TABS: readonly ArticleStatusFilter[] = [
  'all',
  'in_review',
  'content_preparation',
  'draft',
  'published',
  'archived',
];

export const DASHBOARD_PREFETCH_ARTICLE_STATUSES: readonly ArticleStatus[] = [
  'in_review',
  'content_preparation',
  'draft',
];

export const EXTERNAL_ANALYSIS_ARTICLE_STATUSES: readonly ArticleStatus[] = [
  'content_preparation',
  'draft',
];

const ARTICLE_STATUS_SET = new Set<string>(ARTICLE_STATUS_VALUES);
const EXTERNAL_ANALYSIS_ARTICLE_STATUS_SET = new Set<string>(EXTERNAL_ANALYSIS_ARTICLE_STATUSES);

const ARTICLE_STATUS_ALIASES: Record<string, ArticleStatus> = {
  ready: 'in_review',
  review: 'in_review',
  reviewing: 'in_review',
  'in review': 'in_review',
  'جاهز': 'in_review',
  'مراجعة': 'in_review',
  'content preparation': 'content_preparation',
  'prepare content': 'content_preparation',
  'preparing content': 'content_preparation',
  preparation: 'content_preparation',
  'تجهيز محتوى': 'content_preparation',
  'تجهيز المحتوى': 'content_preparation',
};

const normalizeStatusToken = (value: unknown): string => (
  typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
    : ''
);

export const isArticleStatus = (value: unknown): value is ArticleStatus => (
  typeof value === 'string' && ARTICLE_STATUS_SET.has(value)
);

export const normalizeArticleStatus = (
  value: unknown,
  fallback: ArticleStatus = 'draft',
): ArticleStatus => {
  if (isArticleStatus(value)) return value;
  const token = normalizeStatusToken(value);
  const canonicalToken = token.replace(/\s+/g, '_');
  if (isArticleStatus(canonicalToken)) return canonicalToken;
  return ARTICLE_STATUS_ALIASES[token] || fallback;
};

export const normalizeArticleStatusFilter = (value: unknown): ArticleStatusFilter => (
  value === 'all' ? 'all' : (isArticleStatus(value) ? value : 'all')
);

export const getArticleStatusLabel = (
  value: unknown,
  locale: string = 'ar',
): string => {
  const definition = ARTICLE_STATUS_DEFINITIONS.find(item => item.value === value);
  if (!definition) return typeof value === 'string' && value.trim() ? value : '-';
  return locale === 'en' ? definition.labelEn : definition.labelAr;
};

export const isExternalAnalysisArticleStatus = (value: unknown): boolean => (
  typeof value === 'string' && EXTERNAL_ANALYSIS_ARTICLE_STATUS_SET.has(value)
);

export const shouldClearArticleAiResults = (value: unknown): boolean => value === 'in_review';
