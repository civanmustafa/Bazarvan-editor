export const INTERNAL_LINK_QUALITY_POLICY_VERSION = 1;
export const INTERNAL_LINK_ANCHOR_MIN_WORDS = 2;
export const INTERNAL_LINK_ANCHOR_MAX_WORDS = 5;

export type InternalLinkQualityPolicyValues = {
  minimumScore: number;
  maxLinksPer1000Words: number;
  absoluteMaximumLinks: number;
  maximumLinksPerTarget: number;
  minimumMatchedTerms: number;
  forbiddenAnchors: string[];
};

export const DEFAULT_INTERNAL_LINK_FORBIDDEN_ANCHORS = [
  'اضغط هنا',
  'اعرف المزيد',
  'اقرأ المزيد',
  'المزيد من التفاصيل',
  'click here',
  'learn more',
  'read more',
];

export const DEFAULT_INTERNAL_LINK_QUALITY_POLICY: InternalLinkQualityPolicyValues = {
  minimumScore: 45,
  maxLinksPer1000Words: 5,
  absoluteMaximumLinks: 20,
  maximumLinksPerTarget: 1,
  minimumMatchedTerms: 2,
  forbiddenAnchors: DEFAULT_INTERNAL_LINK_FORBIDDEN_ANCHORS,
};

const clampNumber = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
};

const normalizeForbiddenAnchors = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [...DEFAULT_INTERNAL_LINK_FORBIDDEN_ANCHORS];
  const unique = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, trimmed);
    if (unique.size >= 100) break;
  }
  return unique.size > 0
    ? [...unique.values()]
    : [...DEFAULT_INTERNAL_LINK_FORBIDDEN_ANCHORS];
};

export const normalizeInternalLinkQualityPolicy = (
  value?: Partial<InternalLinkQualityPolicyValues> | null,
): InternalLinkQualityPolicyValues => ({
  minimumScore: Math.round(clampNumber(
    value?.minimumScore,
    DEFAULT_INTERNAL_LINK_QUALITY_POLICY.minimumScore,
    0,
    100,
  )),
  maxLinksPer1000Words: Number(clampNumber(
    value?.maxLinksPer1000Words,
    DEFAULT_INTERNAL_LINK_QUALITY_POLICY.maxLinksPer1000Words,
    0.5,
    20,
  ).toFixed(2)),
  absoluteMaximumLinks: Math.round(clampNumber(
    value?.absoluteMaximumLinks,
    DEFAULT_INTERNAL_LINK_QUALITY_POLICY.absoluteMaximumLinks,
    1,
    50,
  )),
  maximumLinksPerTarget: Math.round(clampNumber(
    value?.maximumLinksPerTarget,
    DEFAULT_INTERNAL_LINK_QUALITY_POLICY.maximumLinksPerTarget,
    1,
    5,
  )),
  minimumMatchedTerms: Math.round(clampNumber(
    value?.minimumMatchedTerms,
    DEFAULT_INTERNAL_LINK_QUALITY_POLICY.minimumMatchedTerms,
    2,
    INTERNAL_LINK_ANCHOR_MAX_WORDS,
  )),
  forbiddenAnchors: normalizeForbiddenAnchors(value?.forbiddenAnchors),
});

export const countInternalLinkArticleWords = (articleText: string): number => (
  articleText.match(/[A-Za-z0-9\u0600-\u06FF]+/g)?.length || 0
);

export const calculateInternalLinkSuggestionBudget = (
  articleText: string,
  existingLinkCount: number,
  policyInput?: Partial<InternalLinkQualityPolicyValues> | null,
  requestedMaximum = Number.POSITIVE_INFINITY,
): number => {
  const wordCount = countInternalLinkArticleWords(articleText);
  if (wordCount === 0) return 0;
  const policy = normalizeInternalLinkQualityPolicy(policyInput);
  const densityMaximum = Math.max(
    1,
    Math.ceil((wordCount / 1_000) * policy.maxLinksPer1000Words),
  );
  const totalMaximum = Math.min(
    densityMaximum,
    policy.absoluteMaximumLinks,
    Number.isFinite(requestedMaximum)
      ? Math.max(0, Math.floor(requestedMaximum))
      : policy.absoluteMaximumLinks,
  );
  return Math.max(0, totalMaximum - Math.max(0, Math.floor(existingLinkCount)));
};
