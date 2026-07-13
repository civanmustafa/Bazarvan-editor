export const MAX_ARTICLE_COMPETITORS = 5;
export const COMPETITOR_SEARCH_RESULT_LIMIT = 10;
export const COMPETITOR_CONTENT_MAX_CHARS = 120_000;

export type CompetitorSearchMode = 'title' | 'primary_keyword';

export const createEmptyCompetitorSlots = (): string[] => (
  Array.from({ length: MAX_ARTICLE_COMPETITORS }, () => '')
);

export const normalizeCompetitorSlots = (value: unknown): string[] => {
  const source = Array.isArray(value) ? value : [];
  return createEmptyCompetitorSlots().map((_, index) => (
    typeof source[index] === 'string' ? source[index].trim() : ''
  ));
};
