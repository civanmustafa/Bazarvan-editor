export type ExternalSemanticKeywords = {
  primary: string;
  secondaries: string[];
  company: string;
  lsi: string[];
};

export type ExternalSemanticArticleInput = {
  title: string;
  plainText: string;
  articleLanguage: 'ar' | 'en';
  keywords: ExternalSemanticKeywords;
  goalContext: Record<string, unknown>;
};

export type ExternalSemanticTerms = {
  secondaries: string[];
  lsi: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const truncateText = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength).trim()}\n\n[Article excerpt shortened.]`;
};

const normalizeSemanticTerm = (value: string): string => value
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const semanticStopWords = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
  '\u0641\u064a', '\u0645\u0646', '\u0639\u0646', '\u0639\u0644\u0649', '\u0627\u0644\u0649',
  '\u0625\u0644\u0649', '\u0645\u0639', '\u0648', '\u0623\u0648', '\u0627\u0648', '\u0627\u0644',
].map(normalizeSemanticTerm));

const genericSemanticTerms = new Set([
  'information', 'tips', 'benefits', 'features', 'services', 'solutions', 'options',
  'complete guide', 'best option',
  '\u0645\u0639\u0644\u0648\u0645\u0627\u062a',
  '\u0646\u0635\u0627\u0626\u062d',
  '\u0641\u0648\u0627\u0626\u062f',
  '\u0645\u0645\u064a\u0632\u0627\u062a',
  '\u062e\u062f\u0645\u0627\u062a',
  '\u062d\u0644\u0648\u0644',
  '\u062e\u064a\u0627\u0631\u0627\u062a',
].map(normalizeSemanticTerm));

const getSemanticTokens = (value: string): string[] => normalizeSemanticTerm(value)
  .split(' ')
  .filter(token => token.length > 2 && !semanticStopWords.has(token));

const hasProtectedSemanticOverlap = (
  term: string,
  protectedTerms: string[],
): boolean => {
  const normalizedTerm = normalizeSemanticTerm(term);
  if (!normalizedTerm) return true;

  return protectedTerms.some((protectedTerm) => {
    const normalizedProtected = normalizeSemanticTerm(protectedTerm);
    if (!normalizedProtected) return false;
    if (normalizedTerm === normalizedProtected) return true;
    if (normalizedTerm.includes(normalizedProtected) || normalizedProtected.includes(normalizedTerm)) {
      return true;
    }

    const termTokens = new Set(normalizedTerm.split(' '));
    return getSemanticTokens(protectedTerm).some(token => termTokens.has(token));
  });
};

const toStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(toStringList);
  if (isRecord(value)) {
    return toStringList(
      value.term
      ?? value.text
      ?? value.keyword
      ?? value.value
      ?? value.name
      ?? value.label,
    );
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n\r,;\u060C\u061B|*\/#]+|\s+-\s+/g)
    .map(item => item.replace(/^[-\d.)\s]+/, '').replace(/[.,;\u060C\u061B]+$/g, '').trim())
    .filter(Boolean);
};

const firstList = (source: unknown, keys: string[]): string[] => {
  if (!isRecord(source)) return [];
  for (const key of keys) {
    const values = toStringList(source[key]);
    if (values.length > 0) return values;
  }
  return [];
};

const extractJsonRecord = (text: string): Record<string, unknown> => {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const source = fenced || trimmed;

  try {
    const parsed = JSON.parse(source);
    return isRecord(parsed) ? parsed : {};
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) return {};
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
};

const uniqueTerms = (values: string[]): string[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeSemanticTerm(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const parseExternalSemanticTerms = (
  responseText: string,
  primaryKeyword: string,
  companyName: string,
): ExternalSemanticTerms => {
  const source = extractJsonRecord(responseText);
  const nestedKeywords = isRecord(source.keywords) ? source.keywords : {};
  const semantic = isRecord(source.semantic) ? source.semantic : {};
  const seo = isRecord(source.seo) ? source.seo : {};
  const secondaryKeys = ['secondaries', 'alternativeForms', 'alternative_forms', 'alternatives', 'synonyms'];
  const lsiKeys = ['lsi', 'lsiKeywords', 'lsi_keywords', 'semanticTerms', 'semantic_terms', 'relatedTerms'];

  const secondaries = uniqueTerms([
    ...firstList(source, secondaryKeys),
    ...firstList(nestedKeywords, secondaryKeys),
    ...firstList(semantic, secondaryKeys),
    ...firstList(seo, secondaryKeys),
  ])
    .filter(term => normalizeSemanticTerm(term) !== normalizeSemanticTerm(primaryKeyword))
    .filter(term => !hasProtectedSemanticOverlap(term, [companyName]))
    .slice(0, 6);

  const lsiProtectedTerms = [primaryKeyword, companyName, ...secondaries].filter(Boolean);
  const lsi = uniqueTerms([
    ...firstList(source, lsiKeys),
    ...firstList(nestedKeywords, lsiKeys),
    ...firstList(semantic, lsiKeys),
    ...firstList(seo, lsiKeys),
  ])
    .filter(term => !hasProtectedSemanticOverlap(term, lsiProtectedTerms))
    .filter(term => !genericSemanticTerms.has(normalizeSemanticTerm(term)))
    .slice(0, 16);

  return { secondaries, lsi };
};

export const hasUsableExternalSemanticTerms = (
  terms: ExternalSemanticTerms,
  needsSecondaries: boolean,
  needsLsi: boolean,
): boolean => (
  (!needsSecondaries || terms.secondaries.length > 0)
  && (!needsLsi || terms.lsi.length > 0)
);

export const buildExternalSemanticPrompt = (
  article: ExternalSemanticArticleInput,
): string => [
  'You are an expert semantic SEO and LLM SEO editor.',
  'Generate natural alternative forms for the primary keyword and useful LSI terms.',
  'Use the article, page goal, audience, search intent, and company context.',
  'Do not rewrite the article.',
  '',
  `Output language: ${article.articleLanguage === 'en' ? 'English' : 'Arabic'}`,
  `Article title: ${article.title}`,
  `Primary keyword: ${article.keywords.primary}`,
  `Company or brand: ${article.keywords.company}`,
  `Existing alternative forms: ${article.keywords.secondaries.join(', ') || '-'}`,
  `Existing LSI terms: ${article.keywords.lsi.join(', ') || '-'}`,
  `Page goal context: ${JSON.stringify(article.goalContext)}`,
  '',
  'Article text:',
  '---',
  truncateText(article.plainText, 12_000),
  '---',
  '',
  'Rules:',
  '- Return 4 to 6 short alternative forms in secondaries.',
  '- Return 10 to 16 semantic entities, concepts, or contextual terms in lsi.',
  '- Keep every term in the article output language.',
  '- Do not repeat the primary keyword as an alternative form.',
  '- Do not include the company name in either list.',
  '- LSI terms must not contain the primary keyword or any alternative form.',
  '- Avoid generic filler terms and duplicates.',
  '- Return strict JSON only, without Markdown or explanation.',
  '',
  '{"secondaries":["..."],"lsi":["..."]}',
].join('\n');

export const buildExternalSemanticRepairPrompt = (
  article: ExternalSemanticArticleInput,
  previousResponse: string,
): string => [
  buildExternalSemanticPrompt(article),
  '',
  'The previous response did not contain usable arrays. Correct it once.',
  'Previous response:',
  truncateText(previousResponse, 4_000),
  'Return only the corrected JSON object.',
].join('\n');
