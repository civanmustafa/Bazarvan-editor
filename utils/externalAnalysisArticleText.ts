export const EXTERNAL_ENGINEERING_MINIMUM_ARTICLE_WORDS = 101;

export const countExternalEngineeringArticleWords = (value: unknown): number => (
  String(value || '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length || 0
);

export const externalEngineeringArticleTextIsReady = (value: unknown): boolean => (
  countExternalEngineeringArticleWords(value) >= EXTERNAL_ENGINEERING_MINIMUM_ARTICLE_WORDS
);
