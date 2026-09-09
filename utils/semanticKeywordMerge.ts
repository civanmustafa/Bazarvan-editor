import type { Keywords } from '../types';

const normalizedStringList = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : []
);

const normalizedGoogleDescriptions = (value: unknown): Array<{ text: string; callToAction: string }> => (
  Array.isArray(value)
    ? value.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const source = item as Record<string, unknown>;
      const text = typeof source.text === 'string' ? source.text.trim() : '';
      const callToAction = typeof source.callToAction === 'string'
        ? source.callToAction.trim()
        : '';
      return text ? [{ text, callToAction }] : [];
    })
    : []
);

const sameStringList = (left: unknown, right: unknown): boolean => (
  JSON.stringify(normalizedStringList(left)) === JSON.stringify(normalizedStringList(right))
);

const sameGoogleDescriptions = (left: unknown, right: unknown): boolean => (
  JSON.stringify(normalizedGoogleDescriptions(left)) === JSON.stringify(normalizedGoogleDescriptions(right))
);

// Background generation may finish while the user edits another semantic
// field. Merge only fields unchanged since the last acknowledged save.
export const mergeSavedSemanticKeywords = (
  current: Keywords,
  savedSignature: string,
  remote: Keywords,
  googleOnly = false,
): Keywords => {
  let baseline: Keywords;
  try { baseline = JSON.parse(savedSignature).keywords; } catch { return current; }
  if (!baseline || current.primary !== baseline.primary || current.company !== baseline.company) return current;
  const same = (field: keyof Keywords): boolean => field === 'googleDescriptions'
    ? sameGoogleDescriptions(current[field], baseline[field])
    : sameStringList(current[field], baseline[field]);
  return {
    ...current,
    secondaries: !googleOnly && same('secondaries') ? remote.secondaries : current.secondaries,
    lsi: !googleOnly && same('lsi') ? remote.lsi : current.lsi,
    googleTitles: same('googleTitles') ? remote.googleTitles : current.googleTitles,
    googleDescriptions: same('googleDescriptions') ? remote.googleDescriptions : current.googleDescriptions,
  };
};

/**
 * The editor may acknowledge a background revision only after every field in
 * that revision is present locally. Otherwise the new concurrency token would
 * allow a later manual save to erase the worker result without a conflict.
 */
export const semanticKeywordUpdateWasAccepted = (
  local: Keywords,
  remote: Keywords,
  googleOnly = false,
): boolean => (
  (googleOnly || (
    sameStringList(local.secondaries, remote.secondaries)
    && sameStringList(local.lsi, remote.lsi)
  ))
  && sameStringList(local.googleTitles, remote.googleTitles)
  && sameGoogleDescriptions(local.googleDescriptions, remote.googleDescriptions)
);
