export const META_DESCRIPTION_MIN_LENGTH = 140;
export const META_DESCRIPTION_MAX_LENGTH = 150;

export type MetaDescriptionValidation = {
  normalized: string;
  length: number;
  lengthValid: boolean;
  includesPrimaryKeyword: boolean;
  valid: boolean;
};

const normalizeForComparison = (value: string): string => value
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase();

export const normalizeMetaDescription = (value: unknown): string => (
  typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
);

export const countMetaDescriptionCharacters = (value: unknown): number => (
  Array.from(normalizeMetaDescription(value)).length
);

export const validateMetaDescription = (
  value: unknown,
  primaryKeyword: unknown,
): MetaDescriptionValidation => {
  const normalized = normalizeMetaDescription(value);
  const keyword = normalizeMetaDescription(primaryKeyword);
  const length = Array.from(normalized).length;
  const lengthValid = length >= META_DESCRIPTION_MIN_LENGTH
    && length <= META_DESCRIPTION_MAX_LENGTH;
  const includesPrimaryKeyword = Boolean(
    keyword
    && normalizeForComparison(normalized).includes(normalizeForComparison(keyword)),
  );
  return {
    normalized,
    length,
    lengthValid,
    includesPrimaryKeyword,
    valid: lengthValid && includesPrimaryKeyword,
  };
};

const decodeBasicHtmlEntities = (value: string): string => value
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>');

export const extractArticleTableOfContents = (
  contentHtml: unknown,
  plainText: unknown,
  maximumItems = 18,
): string[] => {
  const html = typeof contentHtml === 'string' ? contentHtml : '';
  const headings = Array.from(html.matchAll(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/gi))
    .map(match => normalizeMetaDescription(decodeBasicHtmlEntities(
      String(match[1] || '').replace(/<[^>]+>/g, ' '),
    )))
    .filter(Boolean);
  if (headings.length > 0) return Array.from(new Set(headings)).slice(0, maximumItems);

  const text = typeof plainText === 'string' ? plainText : '';
  return Array.from(new Set(
    text
      .split(/\r?\n/g)
      .map(line => normalizeMetaDescription(line.replace(/^#{1,6}\s+/, '')))
      .filter(line => line.length >= 4 && line.length <= 120),
  )).slice(0, maximumItems);
};

const jsonObjectFromText = (value: string): Record<string, unknown> | null => {
  const candidates = [
    value.trim(),
    value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() || '',
    value.match(/\{[\s\S]*\}/)?.[0]?.trim() || '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next safe JSON envelope.
    }
  }
  return null;
};

export const parseGeneratedMetaDescription = (value: string): string => {
  const parsed = jsonObjectFromText(value);
  const candidate = parsed?.metaDescription ?? parsed?.meta_description ?? parsed?.description;
  if (typeof candidate === 'string') return normalizeMetaDescription(candidate);
  if (!parsed) return normalizeMetaDescription(value.replace(/^['"“”]+|['"“”]+$/g, ''));
  return '';
};

export const buildMetaDescriptionPrompt = (input: {
  title: string;
  primaryKeyword: string;
  articleLanguage: 'ar' | 'en';
  tableOfContents: string[];
  goalContext: Record<string, unknown>;
  previousInvalidDescription?: string;
}): string => {
  const language = input.articleLanguage === 'en' ? 'English' : 'Arabic';
  const repair = input.previousInvalidDescription
    ? `\nThe previous draft was invalid and must be rewritten, not explained:\n${input.previousInvalidDescription}`
    : '';
  return [
    'Write one SEO meta description for the supplied article.',
    `Output language: ${language}.`,
    `The final description must contain exactly 140 to 150 Unicode characters, including spaces and punctuation.`,
    `Include the primary keyword exactly as supplied: ${input.primaryKeyword}`,
    'Reflect the page goal and the article table of contents. Do not invent facts, prices, guarantees, or claims.',
    'Use a natural, specific sentence that describes the page and encourages a relevant click without clickbait.',
    'Return JSON only in this exact shape: {"metaDescription":"..."}',
    `Article title: ${input.title}`,
    `Page goal context: ${JSON.stringify(input.goalContext)}`,
    `Table of contents: ${JSON.stringify(input.tableOfContents)}`,
    repair,
  ].join('\n');
};
