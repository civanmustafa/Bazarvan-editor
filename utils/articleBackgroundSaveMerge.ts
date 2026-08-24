import type { ArticleStorageSnapshot } from './editorContentStore';

type BackgroundSaveReason = 'manual' | 'auto' | 'lifecycle' | 'recovery';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const stringList = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : []
);

export const backgroundSaveNeedsGeneratedFieldGuard = (
  snapshot: ArticleStorageSnapshot,
  reason: BackgroundSaveReason,
): boolean => {
  if (reason !== 'auto' && reason !== 'lifecycle') return false;
  const keywords: Record<string, unknown> = isRecord(snapshot.keywords) ? snapshot.keywords : {};
  const goalContext: Record<string, unknown> = isRecord(snapshot.goalContext) ? snapshot.goalContext : {};
  return stringList(keywords.secondaries).length === 0
    || stringList(keywords.lsi).length === 0
    || !String(goalContext.generatedBrief || '').trim();
};

/**
 * A background worker can persist semantic terms or the generated brief while
 * an older editor tab is still open. An autosave from that tab must not erase
 * those server-generated fields. Manual saves remain authoritative so users
 * can still intentionally clear or replace the values.
 */
export const mergeServerGeneratedFieldsForBackgroundSave = (options: {
  snapshot: ArticleStorageSnapshot;
  reason: BackgroundSaveReason;
  persistedKeywords: unknown;
  persistedGoalContext: unknown;
}): ArticleStorageSnapshot => {
  const { snapshot, reason } = options;
  if (reason !== 'auto' && reason !== 'lifecycle') return snapshot;

  const incomingKeywords: Record<string, unknown> = isRecord(snapshot.keywords) ? snapshot.keywords : {};
  const persistedKeywords: Record<string, unknown> = isRecord(options.persistedKeywords) ? options.persistedKeywords : {};
  const incomingGoalContext: Record<string, unknown> = isRecord(snapshot.goalContext) ? snapshot.goalContext : {};
  const persistedGoalContext: Record<string, unknown> = isRecord(options.persistedGoalContext) ? options.persistedGoalContext : {};
  const incomingSecondaries = stringList(incomingKeywords.secondaries);
  const incomingLsi = stringList(incomingKeywords.lsi);
  const persistedSecondaries = stringList(persistedKeywords.secondaries);
  const persistedLsi = stringList(persistedKeywords.lsi);
  const incomingBrief = String(incomingGoalContext.generatedBrief || '').trim();
  const persistedBrief = String(persistedGoalContext.generatedBrief || '').trim();

  return {
    ...snapshot,
    keywords: {
      ...incomingKeywords,
      secondaries: incomingSecondaries.length > 0 ? incomingSecondaries : persistedSecondaries,
      lsi: incomingLsi.length > 0 ? incomingLsi : persistedLsi,
    },
    goalContext: {
      ...incomingGoalContext,
      generatedBrief: incomingBrief || persistedBrief,
    },
  } as ArticleStorageSnapshot;
};
