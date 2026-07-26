export type FindReplaceTextSegment = {
  text: string;
  from: number;
};

export type FindReplaceTextBlock = {
  segments: FindReplaceTextSegment[];
};

export type FindReplaceMatch = {
  from: number;
  to: number;
};

type NormalizedCharacterRange = {
  from: number;
  to: number;
};

const ARABIC_IGNORED_MARKS = /[\u0610-\u061A\u0640\u064B-\u065F\u0670\u06D6-\u06ED]/u;

const normalizeSearchCharacter = (character: string): string => {
  if (ARABIC_IGNORED_MARKS.test(character)) return '';
  if (/\s/u.test(character)) return ' ';

  switch (character) {
    case 'أ':
    case 'إ':
    case 'آ':
    case 'ٱ':
      return 'ا';
    case 'ى':
    case 'ئ':
      return 'ي';
    case 'ؤ':
      return 'و';
    case 'ة':
      return 'ه';
    default:
      return character.toLowerCase();
  }
};

const appendNormalizedText = (
  target: { text: string; ranges: NormalizedCharacterRange[] },
  text: string,
  from: number,
): void => {
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const characterLength = character.length;
    const characterFrom = from + index;
    const characterTo = characterFrom + characterLength;
    const normalized = normalizeSearchCharacter(character);

    if (!normalized) {
      const previousRange = target.ranges[target.ranges.length - 1];
      if (previousRange) previousRange.to = Math.max(previousRange.to, characterTo);
      index += characterLength;
      continue;
    }

    if (normalized === ' ' && target.text.endsWith(' ')) {
      const previousRange = target.ranges[target.ranges.length - 1];
      if (previousRange) previousRange.to = Math.max(previousRange.to, characterTo);
      index += characterLength;
      continue;
    }

    Array.from(normalized).forEach(normalizedCharacter => {
      target.text += normalizedCharacter;
      target.ranges.push({ from: characterFrom, to: characterTo });
    });
    index += characterLength;
  }
};

export const normalizeFindReplaceQuery = (value: string): string => {
  const normalized = { text: '', ranges: [] as NormalizedCharacterRange[] };
  appendNormalizedText(normalized, String(value || ''), 0);
  return normalized.text.trim();
};

export const findReplaceMatches = (
  blocks: readonly FindReplaceTextBlock[],
  query: string,
): FindReplaceMatch[] => {
  const normalizedQuery = normalizeFindReplaceQuery(query);
  if (!normalizedQuery) return [];

  return blocks.flatMap(block => {
    const normalized = { text: '', ranges: [] as NormalizedCharacterRange[] };
    let previousSegmentEnd: number | null = null;

    block.segments.forEach(segment => {
      if (!segment.text) return;
      if (previousSegmentEnd !== null && segment.from > previousSegmentEnd) {
        // Do not allow one replacement range to cross an unrepresented inline
        // atom such as an image. Explicit hard breaks arrive as space segments.
        appendNormalizedText(normalized, '\u0000', previousSegmentEnd);
      }
      appendNormalizedText(normalized, segment.text, segment.from);
      previousSegmentEnd = segment.from + segment.text.length;
    });

    const matches: FindReplaceMatch[] = [];
    let searchFrom = 0;
    while (searchFrom <= normalized.text.length - normalizedQuery.length) {
      const index = normalized.text.indexOf(normalizedQuery, searchFrom);
      if (index < 0) break;
      const firstRange = normalized.ranges[index];
      const lastRange = normalized.ranges[index + normalizedQuery.length - 1];
      if (firstRange && lastRange) {
        matches.push({ from: firstRange.from, to: lastRange.to });
      }
      searchFrom = index + Math.max(1, normalizedQuery.length);
    }
    return matches;
  });
};
