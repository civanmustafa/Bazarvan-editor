export type CompetitorSourceClass = 'commercial' | 'government';

export type CompetitorSourcePolicy = {
  sourceClass: CompetitorSourceClass;
  minimumWordCount: number;
  minimumUniqueTokenCount: number;
  contentWeight: number;
};

const STANDARD_POLICY: CompetitorSourcePolicy = {
  sourceClass: 'commercial',
  minimumWordCount: 0,
  minimumUniqueTokenCount: 0,
  contentWeight: 1,
};

/**
 * Every successfully extracted non-empty competitor text has the same neutral
 * writing weight. Length, vocabulary density, language, and ownership are not
 * extraction-quality gates.
 */
export const resolveCompetitorSourcePolicy = (_value: unknown): CompetitorSourcePolicy => STANDARD_POLICY;
