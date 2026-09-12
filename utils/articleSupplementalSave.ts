type ArticleSupplementalSaveHandler = () => Promise<void>;

const handlersByArticle = new Map<string, Set<ArticleSupplementalSaveHandler>>();

export const registerArticleSupplementalSaveHandler = (
  articleId: string,
  handler: ArticleSupplementalSaveHandler,
): (() => void) => {
  const normalizedArticleId = articleId.trim();
  if (!normalizedArticleId) return () => undefined;

  const handlers = handlersByArticle.get(normalizedArticleId) || new Set<ArticleSupplementalSaveHandler>();
  handlers.add(handler);
  handlersByArticle.set(normalizedArticleId, handlers);

  return () => {
    const currentHandlers = handlersByArticle.get(normalizedArticleId);
    if (!currentHandlers) return;
    currentHandlers.delete(handler);
    if (currentHandlers.size === 0) handlersByArticle.delete(normalizedArticleId);
  };
};

export const flushArticleSupplementalSaves = async (articleId: string | null): Promise<void> => {
  const normalizedArticleId = articleId?.trim() || '';
  if (!normalizedArticleId) return;
  const handlers = Array.from(handlersByArticle.get(normalizedArticleId) || []);
  await Promise.all(handlers.map(handler => handler()));
};
