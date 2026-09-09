export type ArticleEditorPresence = {
  articleId: string;
  userId: string;
  displayName: string;
  enteredAt: string;
  lastSeenAt: string;
};

export type ArticleEditorPresenceMap = Record<string, ArticleEditorPresence[]>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

export const normalizeArticleEditorPresence = (value: unknown): ArticleEditorPresence[] => {
  if (!Array.isArray(value)) return [];

  const normalized = value.flatMap(item => {
    if (!isRecord(item)) return [];
    const articleId = typeof item.articleId === 'string' ? item.articleId.trim() : '';
    const userId = typeof item.userId === 'string' ? item.userId.trim() : '';
    const displayName = typeof item.displayName === 'string' ? item.displayName.trim() : '';
    const enteredAt = typeof item.enteredAt === 'string' ? item.enteredAt : '';
    const lastSeenAt = typeof item.lastSeenAt === 'string' ? item.lastSeenAt : '';
    if (!articleId || !userId || !displayName) return [];
    return [{ articleId, userId, displayName, enteredAt, lastSeenAt }];
  });

  const byArticleAndUser = new Map<string, ArticleEditorPresence>();
  normalized.forEach(presence => {
    const key = `${presence.articleId}:${presence.userId}`;
    const previous = byArticleAndUser.get(key);
    if (!previous || presence.lastSeenAt > previous.lastSeenAt) {
      byArticleAndUser.set(key, presence);
    }
  });

  return [...byArticleAndUser.values()].sort((left, right) => (
    left.articleId.localeCompare(right.articleId)
    || left.displayName.localeCompare(right.displayName, 'ar')
  ));
};

export const groupArticleEditorPresence = (
  presence: ArticleEditorPresence[],
): ArticleEditorPresenceMap => presence.reduce<ArticleEditorPresenceMap>((grouped, item) => {
  grouped[item.articleId] = [...(grouped[item.articleId] || []), item];
  return grouped;
}, {});
