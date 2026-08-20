import type { GoalContext, Keywords } from '../types';
import { hasMeaningfulArticleContent } from './articleContent.ts';

export type ArticleSaveEligibilityInput = {
  articleId?: string | null;
  articleKey?: string | null;
  plainText?: string | null;
  title?: string | null;
  keywords?: Partial<Keywords> | null;
  goalContext?: Partial<GoalContext> | null;
};

export type ArticleBodyClearIntentInput = {
  articleId?: string | null;
  editorChangedAfterLoad: boolean;
  content?: unknown;
  contentHtml?: string | null;
  plainText?: string | null;
};

const hasText = (value: string | null | undefined): boolean => (
  typeof value === 'string' && value.trim().length > 0
);

const hasMeaningfulTextList = (values: readonly unknown[] | null | undefined): boolean => (
  Array.isArray(values) && values.some(value => hasText(typeof value === 'string' ? value : ''))
);

const hasMeaningfulKeywords = (keywords: Partial<Keywords> | null | undefined): boolean => {
  if (!keywords || typeof keywords !== 'object') return false;
  return (
    hasText(keywords.primary)
    || hasMeaningfulTextList(keywords.secondaries)
    || hasText(keywords.company)
    || hasMeaningfulTextList(keywords.lsi)
  );
};

const hasMeaningfulGoalContext = (goalContext: Partial<GoalContext> | null | undefined): boolean => {
  if (!goalContext || typeof goalContext !== 'object') return false;

  return Object.values(goalContext).some(value => {
    if (typeof value === 'string') return hasText(value);
    if (Array.isArray(value)) return hasMeaningfulTextList(value);
    return false;
  });
};

export const canPersistArticleDraft = (
  input: ArticleSaveEligibilityInput,
): boolean => {
  return (
    hasText(input.articleKey)
    || hasText(input.title)
    || hasText(input.plainText)
    || hasMeaningfulKeywords(input.keywords)
    || hasMeaningfulGoalContext(input.goalContext)
    || hasMeaningfulArticleContent(input.plainText || '')
  );
};

/**
 * Empty editor documents are normally rejected by the database safeguard so a
 * transient TipTap/load failure cannot erase a saved article. Only an existing
 * article that the user actually edited after loading may request a real clear.
 */
export const shouldClearPersistedArticleBody = (
  input: ArticleBodyClearIntentInput,
): boolean => (
  Boolean(input.articleId)
  && input.editorChangedAfterLoad
  && !hasMeaningfulArticleContent(input.content)
  && !hasMeaningfulArticleContent(input.contentHtml || '')
  && !hasMeaningfulArticleContent(input.plainText || '')
);
