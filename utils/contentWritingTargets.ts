import type { ContentWritingQualityConfiguration } from '../constants/contentWritingQuality';

export const CONTENT_WRITING_AUTOMATIC_WORD_MULTIPLIER = 1.2;
export const CONTENT_WRITING_AUTOMATIC_WORD_TOLERANCE = 0.1;
export const CONTENT_WRITING_MIN_TARGET_WORDS = 650;
export const CONTENT_WRITING_MAX_TARGET_WORDS = 8_000;
export const CONTENT_WRITING_MIN_DYNAMIC_SECTIONS = 4;
export const CONTENT_WRITING_MAX_DYNAMIC_SECTIONS = 26;

export type ContentWritingWordRange = {
  min: number;
  max: number;
};

export type ContentWritingLengthTarget = {
  mode: 'manual' | 'automatic';
  targetWords: ContentWritingWordRange;
  centerWords: number;
  outlineSections: ContentWritingWordRange & {
    preferred: number;
  };
  automaticMultiplier: number | null;
  automaticTolerancePercent: number | null;
  baselineCompetitor: {
    position: number;
    title: string;
    url: string;
    wordCount: number;
  } | null;
  baselineMethod: 'manual' | 'robust_largest_non_outlier';
  competitorSampleCount: number;
  excludedOutlierCount: number;
};

type LengthTargetCompetitor = {
  position?: number;
  title?: string;
  url?: string;
  content: string;
};

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

const normalizeDigits = (value: string): string => Array.from(String(value || ''))
  .map(character => {
    const arabicIndex = ARABIC_DIGITS.indexOf(character);
    if (arabicIndex >= 0) return String(arabicIndex);
    const persianIndex = PERSIAN_DIGITS.indexOf(character);
    if (persianIndex >= 0) return String(persianIndex);
    return character;
  })
  .join('');

const boundedInteger = (
  value: number,
  minimum: number,
  maximum: number,
): number => Math.max(minimum, Math.min(Math.round(value), maximum));

export const parseContentWritingTargetWordRange = (
  value: unknown,
): ContentWritingWordRange | null => {
  const normalized = normalizeDigits(typeof value === 'string' ? value.trim() : '');
  if (!normalized) return null;
  const match = normalized.match(
    /^(\d{2,6})\s*(?:[-._*\/،,–—]+)\s*(\d{2,6})$/,
  );
  if (!match) return null;
  const left = Number(match[1]);
  const right = Number(match[2]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  const min = Math.min(left, right);
  const max = Math.max(left, right);
  if (
    min < CONTENT_WRITING_MIN_TARGET_WORDS
    || max > CONTENT_WRITING_MAX_TARGET_WORDS
  ) {
    return null;
  }
  return { min, max };
};

export const formatContentWritingTargetWordRange = (
  value: ContentWritingWordRange,
): string => `${value.min}-${value.max}`;

export const countContentWritingTargetWords = (value: string): number => (
  String(value || '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length || 0
);

export const deriveContentWritingOutlineSections = (
  targetWords: ContentWritingWordRange,
): ContentWritingLengthTarget['outlineSections'] => {
  const centerWords = Math.round((targetWords.min + targetWords.max) / 2);
  const centerBodyWords = Math.max(0, centerWords - 350);
  const preferred = boundedInteger(
    centerBodyWords / 180,
    CONTENT_WRITING_MIN_DYNAMIC_SECTIONS,
    CONTENT_WRITING_MAX_DYNAMIC_SECTIONS,
  );
  const feasibleMinimum = boundedInteger(
    Math.ceil(Math.max(0, targetWords.min - 450) / 300),
    CONTENT_WRITING_MIN_DYNAMIC_SECTIONS,
    CONTENT_WRITING_MAX_DYNAMIC_SECTIONS,
  );
  const feasibleMaximum = boundedInteger(
    Math.floor(Math.max(0, targetWords.max - 250) / 80),
    CONTENT_WRITING_MIN_DYNAMIC_SECTIONS,
    CONTENT_WRITING_MAX_DYNAMIC_SECTIONS,
  );
  const min = Math.max(
    feasibleMinimum,
    Math.max(CONTENT_WRITING_MIN_DYNAMIC_SECTIONS, preferred - 1),
  );
  const max = Math.max(
    min,
    Math.min(
      feasibleMaximum,
      Math.min(CONTENT_WRITING_MAX_DYNAMIC_SECTIONS, preferred + 2),
    ),
  );
  return {
    min,
    max,
    preferred: Math.max(min, Math.min(preferred, max)),
  };
};

const getMedian = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const resolveRobustBaselineCompetitor = (
  competitors: readonly LengthTargetCompetitor[],
): {
  baselineCompetitor: ContentWritingLengthTarget['baselineCompetitor'];
  sampleCount: number;
  excludedOutlierCount: number;
} => {
  const samples = competitors.map((competitor, index) => ({
    position: Number.isFinite(Number(competitor.position))
      ? Math.max(1, Math.round(Number(competitor.position)))
      : index + 1,
    title: String(competitor.title || '').trim(),
    url: String(competitor.url || '').trim(),
    wordCount: countContentWritingTargetWords(competitor.content),
  }))
    .filter(competitor => competitor.wordCount > 0);
  if (samples.length === 0) {
    return { baselineCompetitor: null, sampleCount: 0, excludedOutlierCount: 0 };
  }
  const median = getMedian(samples.map(sample => sample.wordCount));
  const outlierCeiling = samples.length >= 3
    ? Math.max(median * 1.75, median + 500)
    : Number.POSITIVE_INFINITY;
  const eligible = samples.filter(sample => sample.wordCount <= outlierCeiling);
  const baselineCompetitor = (eligible.length > 0 ? eligible : samples)
    .sort((left, right) => (
    right.wordCount - left.wordCount
    || left.position - right.position
    ))[0] || null;
  return {
    baselineCompetitor,
    sampleCount: samples.length,
    excludedOutlierCount: samples.length - eligible.length,
  };
};

export const resolveContentWritingLengthTarget = (options: {
  manualRange?: unknown;
  competitors: readonly LengthTargetCompetitor[];
}): ContentWritingLengthTarget => {
  const manualRange = parseContentWritingTargetWordRange(options.manualRange);
  const baseline = resolveRobustBaselineCompetitor(options.competitors);
  const baselineCompetitor = baseline.baselineCompetitor;
  if (manualRange) {
    return {
      mode: 'manual',
      targetWords: manualRange,
      centerWords: Math.round((manualRange.min + manualRange.max) / 2),
      outlineSections: deriveContentWritingOutlineSections(manualRange),
      automaticMultiplier: null,
      automaticTolerancePercent: null,
      baselineCompetitor,
      baselineMethod: 'manual',
      competitorSampleCount: baseline.sampleCount,
      excludedOutlierCount: baseline.excludedOutlierCount,
    };
  }

  const baselineWords = Math.max(
    CONTENT_WRITING_MIN_TARGET_WORDS,
    baselineCompetitor?.wordCount || CONTENT_WRITING_MIN_TARGET_WORDS,
  );
  const centerWords = Math.min(
    Math.floor(CONTENT_WRITING_MAX_TARGET_WORDS / (1 + CONTENT_WRITING_AUTOMATIC_WORD_TOLERANCE)),
    Math.round(baselineWords * CONTENT_WRITING_AUTOMATIC_WORD_MULTIPLIER),
  );
  const targetWords = {
    min: Math.max(
      CONTENT_WRITING_MIN_TARGET_WORDS,
      Math.floor(centerWords * (1 - CONTENT_WRITING_AUTOMATIC_WORD_TOLERANCE)),
    ),
    max: Math.min(
      CONTENT_WRITING_MAX_TARGET_WORDS,
      Math.ceil(centerWords * (1 + CONTENT_WRITING_AUTOMATIC_WORD_TOLERANCE)),
    ),
  };
  return {
    mode: 'automatic',
    targetWords,
    centerWords,
    outlineSections: deriveContentWritingOutlineSections(targetWords),
    automaticMultiplier: CONTENT_WRITING_AUTOMATIC_WORD_MULTIPLIER,
    automaticTolerancePercent: CONTENT_WRITING_AUTOMATIC_WORD_TOLERANCE * 100,
    baselineCompetitor,
    baselineMethod: 'robust_largest_non_outlier',
    competitorSampleCount: baseline.sampleCount,
    excludedOutlierCount: baseline.excludedOutlierCount,
  };
};

export const applyContentWritingLengthTargetToQualityConfiguration = (
  configuration: ContentWritingQualityConfiguration,
  target: ContentWritingLengthTarget,
): ContentWritingQualityConfiguration => ({
  ...configuration,
  policy: {
    ...configuration.policy,
    targetWords: { ...target.targetWords },
    outlineSections: {
      min: target.outlineSections.min,
      max: target.outlineSections.max,
    },
  },
});

export const getContentWritingBodyWordBudget = (
  targetWords: ContentWritingWordRange,
): ContentWritingWordRange => ({
  min: Math.max(0, targetWords.min - 450),
  max: Math.max(0, targetWords.max - 250),
});
