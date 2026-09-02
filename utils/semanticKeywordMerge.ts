import type { Keywords } from '../types';

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
  const same = (field: keyof Keywords): boolean => JSON.stringify(current[field] || []) === JSON.stringify(baseline[field] || []);
  return {
    ...current,
    secondaries: !googleOnly && same('secondaries') ? remote.secondaries : current.secondaries,
    lsi: !googleOnly && same('lsi') ? remote.lsi : current.lsi,
    googleTitles: same('googleTitles') ? remote.googleTitles : current.googleTitles,
    googleDescriptions: same('googleDescriptions') ? remote.googleDescriptions : current.googleDescriptions,
  };
};
