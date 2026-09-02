import { getUsableCompetitorText } from './competitorContent.ts';

/** Fill holes without moving saved texts, URLs, or in-flight extractions. */
export const fillEmptyCompetitorTextSlots = (
  current: readonly string[],
  incoming: readonly string[],
  reserved: readonly number[] = [],
): { texts: string[]; inserted: number[]; remaining: string[] } => {
  const texts = [...current];
  const inserted: number[] = [];
  const remaining: string[] = [];
  for (const value of incoming) {
    const text = getUsableCompetitorText(value);
    if (!text || texts.some(saved => getUsableCompetitorText(saved) === text)) continue;
    const index = texts.findIndex((saved, slot) => !getUsableCompetitorText(saved) && !reserved.includes(slot));
    if (index < 0) {
      remaining.push(value);
      continue;
    }
    texts[index] = value;
    inserted.push(index);
  }
  return { texts, inserted, remaining };
};

/** A new link must not be paired with another competitor's existing prose. */
export const fillEmptyCompetitorUrlSlots = (
  current: readonly string[],
  texts: readonly string[],
  incoming: readonly string[],
  reserved: readonly number[] = [],
): { urls: string[]; inserted: number[]; remaining: string[] } => {
  const urls = [...current];
  const inserted: number[] = [];
  const remaining: string[] = [];
  for (const value of incoming) {
    const url = value.trim();
    if (!url || urls.some(saved => saved.trim() === url)) continue;
    const index = urls.findIndex((saved, slot) => (
      !saved.trim() && !getUsableCompetitorText(texts[slot]) && !reserved.includes(slot)
    ));
    if (index < 0) {
      remaining.push(value);
      continue;
    }
    urls[index] = url;
    inserted.push(index);
  }
  return { urls, inserted, remaining };
};
