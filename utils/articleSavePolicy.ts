import { hasMeaningfulArticleContent } from './articleContent.ts';

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
): boolean => {
  // A named, unsaved draft may be empty. An existing remote article must never
  // be overwritten by TipTap's empty `<p></p>` document through auto/lifecycle
  // save (or a save click while its body is still loading).
  if (hasText(input.articleId) && !hasMeaningfulArticleContent(input.plainText || '')) {
    return false;
  }

  return (
    hasText(input.articleKey)
    || hasText(input.title)
    || hasText(input.plainText)
  );
};
