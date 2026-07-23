export type ArticleSaveEligibilityInput = {
  articleId?: string | null;
  articleKey?: string | null;
  plainText?: string | null;
  title?: string | null;
};

const hasText = (value: string | null | undefined): boolean => (
  typeof value === 'string' && value.trim().length > 0
);

export const canPersistArticleDraft = (
  input: ArticleSaveEligibilityInput,
): boolean => (
  hasText(input.articleId)
  || hasText(input.articleKey)
  || hasText(input.title)
  || hasText(input.plainText)
);
