export const CLIENT_SEMANTIC_PROFILE_VERSION = 1;

export type ClientLinkDictionaryType = 'synonym' | 'topic' | 'excluded_term';

export type ClientLinkDictionaryEntry = {
  id: string;
  clientId: string;
  dictionaryType: ClientLinkDictionaryType;
  label: string;
  terms: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ClientSemanticPageInput = {
  id: string;
  clientId: string;
  inputUrl: string;
  finalUrl?: string;
  canonicalUrl?: string;
  pageTitle?: string;
  metaDescription?: string;
  h1?: string;
  h2?: string[];
  h3?: string[];
  slug?: string;
  pageLanguage?: string;
  contentHash?: string;
  extractedTerms?: string[];
  extractedPhrases?: string[];
};

export type ClientSemanticWeightedTerm = {
  term: string;
  weight: number;
  frequency: number;
  sources: string[];
};

export type ClientSemanticPhrase = {
  phrase: string;
  weight: number;
  size: number;
  sources: string[];
};

export type ClientSemanticStem = {
  stem: string;
  terms: string[];
  weight: number;
};

export type ClientSemanticDictionaryMatch = {
  dictionaryId: string;
  type: ClientLinkDictionaryType;
  label: string;
  matchedTerms: string[];
};

export type ClientSemanticCompletenessDetails = {
  title: boolean;
  description: boolean;
  h1: boolean;
  h2: boolean;
  h3: boolean;
  slug: boolean;
  language: boolean;
  canonical: boolean;
  extractedTerms: boolean;
  extractedPhrases: boolean;
};

export type ClientPageSemanticProfile = {
  pageId: string;
  clientId: string;
  profileVersion: number;
  sourceSignature: string;
  dictionarySignature: string;
  pageLanguage: string;
  pathSegments: string[];
  weightedTerms: ClientSemanticWeightedTerm[];
  phrases: ClientSemanticPhrase[];
  lightStems: ClientSemanticStem[];
  dictionaryMatches: ClientSemanticDictionaryMatch[];
  documentLength: number;
  completenessScore: number;
  completenessDetails: ClientSemanticCompletenessDetails;
  indexedAt: string;
};

type SourceText = {
  source: string;
  value: string;
  weight: number;
};

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TOKEN_PATTERN = /[A-Za-z0-9\u0600-\u06FF]+/g;

const BASE_STOP_WORDS = new Set([
  'في', 'من', 'الى', 'إلى', 'عن', 'على', 'علي', 'مع', 'حتى', 'ثم', 'او', 'أو',
  'ام', 'أم', 'بل', 'لا', 'نعم', 'و', 'ف', 'ب', 'ك', 'ل', 'لل', 'هو', 'هي',
  'هم', 'هن', 'هذا', 'هذه', 'ذلك', 'تلك', 'الذي', 'التي', 'الذين', 'كان', 'كانت',
  'يكون', 'تكون', 'يتم', 'تم', 'قد', 'لقد', 'ان', 'إن', 'أن', 'كما', 'كل', 'اي',
  'أي', 'غير', 'ما', 'ماذا', 'كيف', 'عند', 'بعد', 'قبل', 'بين', 'ضمن', 'حول',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'by', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'this', 'that', 'these',
  'those', 'it', 'its', 'you', 'your', 'we', 'our',
].map(value => normalizeSemanticText(value)));

export function normalizeSemanticText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(ARABIC_DIACRITICS, '')
    .replace(/\u0640/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC_CLIENT_PAGE_TITLES = new Set([
  'الرئيسية',
  'الصفحة الرئيسية',
  'الرئيسية للموقع',
  'أهلًا بكم',
  'مرحبا بكم',
  'home',
  'home page',
  'homepage',
  'welcome',
  'untitled',
].map(value => normalizeSemanticText(value)));

export const isGenericClientPageTitle = (value: string | undefined): boolean => (
  GENERIC_CLIENT_PAGE_TITLES.has(normalizeSemanticText(value || ''))
);

const stableSignature = (prefix: string, value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}_${value.length.toString(36)}`;
};

const uniqueStrings = (values: string[]): string[] => (
  [...new Set(values.map(value => value.trim()).filter(Boolean))]
);

const normalizeDictionary = (entries: ClientLinkDictionaryEntry[]): ClientLinkDictionaryEntry[] => (
  entries
    .filter(entry => entry.isActive)
    .map(entry => ({
      ...entry,
      label: entry.label.trim(),
      terms: uniqueStrings([entry.label, ...entry.terms]),
    }))
    .filter(entry => entry.label && entry.terms.length > 0)
    .sort((left, right) => (
      left.dictionaryType.localeCompare(right.dictionaryType)
      || left.label.localeCompare(right.label, 'ar')
      || left.id.localeCompare(right.id)
    ))
);

export const createClientDictionarySignature = (
  entries: ClientLinkDictionaryEntry[],
): string => {
  const normalized = normalizeDictionary(entries).map(entry => ({
    id: entry.id,
    type: entry.dictionaryType,
    label: normalizeSemanticText(entry.label),
    terms: entry.terms.map(normalizeSemanticText).filter(Boolean).sort(),
  }));
  return stableSignature('dictionary', JSON.stringify(normalized));
};

export const createClientPageSourceSignature = (
  page: ClientSemanticPageInput,
): string => stableSignature('source', JSON.stringify({
  inputUrl: page.inputUrl,
  finalUrl: page.finalUrl || '',
  canonicalUrl: page.canonicalUrl || '',
  title: page.pageTitle || '',
  description: page.metaDescription || '',
  h1: page.h1 || '',
  h2: page.h2 || [],
  h3: page.h3 || [],
  slug: page.slug || '',
  language: page.pageLanguage || '',
  hash: page.contentHash || '',
  terms: page.extractedTerms || [],
  phrases: page.extractedPhrases || [],
}));

const tokenize = (value: string, excludedTokens: Set<string>): string[] => (
  (normalizeSemanticText(value).match(TOKEN_PATTERN) || [])
    .filter(token => (
      token.length > 1
      && !BASE_STOP_WORDS.has(token)
      && !excludedTokens.has(token)
      && !/^\d+$/.test(token)
    ))
);

const isArabicToken = (value: string): boolean => /[\u0600-\u06FF]/.test(value);

export const lightStemArabicToken = (value: string): string => {
  let stem = normalizeSemanticText(value);
  if (!isArabicToken(stem) || stem.includes(' ')) return stem;

  if (stem.startsWith('وال') && stem.length >= 7) stem = stem.slice(3);
  else if (stem.startsWith('بال') && stem.length >= 7) stem = stem.slice(3);
  else if (stem.startsWith('كال') && stem.length >= 7) stem = stem.slice(3);
  else if (stem.startsWith('لل') && stem.length >= 6) stem = stem.slice(2);
  else if (stem.startsWith('ال') && stem.length >= 6) stem = stem.slice(2);
  else if (/^[وفبكل]/.test(stem) && stem.length >= 6) stem = stem.slice(1);

  const suffixes = ['يات', 'ات', 'يون', 'يين', 'ون', 'ين', 'يه', 'ها', 'هم', 'هن', 'كم', 'نا'];
  for (const suffix of suffixes) {
    if (stem.endsWith(suffix) && stem.length - suffix.length >= 3) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  if (stem.endsWith('ي') && stem.length >= 5) stem = stem.slice(0, -1);
  if (stem.endsWith('ه') && stem.length >= 5) stem = stem.slice(0, -1);
  return stem.length >= 3 ? stem : normalizeSemanticText(value);
};

const buildNgrams = (tokens: string[], minimum = 2, maximum = 5): string[] => {
  const phrases: string[] = [];
  for (let size = minimum; size <= Math.min(maximum, tokens.length); size += 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      phrases.push(tokens.slice(start, start + size).join(' '));
    }
  }
  return phrases;
};

const pageUrlPath = (page: ClientSemanticPageInput): string => {
  const value = page.canonicalUrl || page.finalUrl || page.inputUrl;
  try {
    return decodeURIComponent(new URL(value).pathname).replace(/[-_]+/g, ' ');
  } catch {
    return (page.slug || '').replace(/[-_]+/g, ' ');
  }
};

const buildSourceTexts = (page: ClientSemanticPageInput): SourceText[] => [
  {
    source: 'title',
    value: isGenericClientPageTitle(page.pageTitle) ? '' : page.pageTitle || '',
    weight: 10,
  },
  { source: 'h1', value: page.h1 || '', weight: 9 },
  ...(page.h2 || []).map(value => ({ source: 'h2', value, weight: 7 })),
  ...(page.h3 || []).map(value => ({ source: 'h3', value, weight: 5 })),
  { source: 'description', value: page.metaDescription || '', weight: 4 },
  { source: 'slug', value: pageUrlPath(page), weight: 5 },
  ...(page.extractedTerms || []).map(value => ({ source: 'extracted_term', value, weight: 3 })),
  ...(page.extractedPhrases || []).map(value => ({ source: 'extracted_phrase', value, weight: 4 })),
].filter(source => source.value.trim());

const calculateCompleteness = (
  page: ClientSemanticPageInput,
): { score: number; details: ClientSemanticCompletenessDetails } => {
  const details: ClientSemanticCompletenessDetails = {
    title: Boolean(page.pageTitle?.trim()) && !isGenericClientPageTitle(page.pageTitle),
    description: Boolean(page.metaDescription?.trim()),
    h1: Boolean(page.h1?.trim()),
    h2: Boolean(page.h2?.some(value => value.trim())),
    h3: Boolean(page.h3?.some(value => value.trim())),
    slug: Boolean((page.slug || pageUrlPath(page)).trim()),
    language: Boolean(page.pageLanguage?.trim()),
    canonical: Boolean(page.canonicalUrl?.trim()),
    extractedTerms: Boolean(page.extractedTerms?.length),
    extractedPhrases: Boolean(page.extractedPhrases?.length),
  };
  const weights: Record<keyof ClientSemanticCompletenessDetails, number> = {
    title: 20,
    description: 15,
    h1: 15,
    h2: 15,
    h3: 5,
    slug: 10,
    language: 5,
    canonical: 5,
    extractedTerms: 5,
    extractedPhrases: 5,
  };
  const score = (Object.keys(details) as Array<keyof ClientSemanticCompletenessDetails>)
    .reduce((sum, key) => sum + (details[key] ? weights[key] : 0), 0);
  return { score, details };
};

export const buildClientPageSemanticProfile = (
  page: ClientSemanticPageInput,
  dictionaryEntries: ClientLinkDictionaryEntry[],
  indexedAt = new Date().toISOString(),
): ClientPageSemanticProfile => {
  const dictionaries = normalizeDictionary(dictionaryEntries);
  const excludedPhrases = new Set(
    dictionaries
      .filter(entry => entry.dictionaryType === 'excluded_term')
      .flatMap(entry => entry.terms)
      .map(normalizeSemanticText)
      .filter(Boolean),
  );
  const excludedTokens = new Set(
    [...excludedPhrases].flatMap(value => value.split(' ')).filter(Boolean),
  );
  const sourceTexts = buildSourceTexts(page);
  const termMap = new Map<string, ClientSemanticWeightedTerm>();
  const phraseMap = new Map<string, ClientSemanticPhrase>();
  const pageComparableText = sourceTexts.map(source => normalizeSemanticText(source.value)).join(' ');

  const addTerm = (term: string, weight: number, source: string, frequency = 1): void => {
    if (!term || excludedTokens.has(term) || BASE_STOP_WORDS.has(term)) return;
    const current = termMap.get(term);
    if (current) {
      current.frequency += frequency;
      current.weight = Math.max(current.weight, weight);
      if (!current.sources.includes(source)) current.sources.push(source);
      return;
    }
    termMap.set(term, { term, weight, frequency, sources: [source] });
  };

  const addPhrase = (phrase: string, weight: number, source: string): void => {
    const normalized = normalizeSemanticText(phrase);
    const parts = normalized.split(' ').filter(Boolean);
    if (
      parts.length < 2
      || parts.length > 5
      || excludedPhrases.has(normalized)
      || parts.some(token => excludedTokens.has(token))
    ) return;
    const current = phraseMap.get(normalized);
    if (current) {
      current.weight = Math.max(current.weight, weight);
      if (!current.sources.includes(source)) current.sources.push(source);
      return;
    }
    phraseMap.set(normalized, {
      phrase: normalized,
      weight,
      size: parts.length,
      sources: [source],
    });
  };

  let documentLength = 0;
  for (const sourceText of sourceTexts) {
    const tokens = tokenize(sourceText.value, excludedTokens);
    documentLength += tokens.length;
    tokens.forEach(token => addTerm(token, sourceText.weight, sourceText.source));
    buildNgrams(tokens).forEach(phrase => addPhrase(phrase, sourceText.weight, sourceText.source));
  }

  const dictionaryMatches: ClientSemanticDictionaryMatch[] = [];
  for (const entry of dictionaries.filter(item => item.dictionaryType !== 'excluded_term')) {
    const normalizedTerms = uniqueStrings(entry.terms.map(normalizeSemanticText).filter(Boolean));
    const matchedTerms = normalizedTerms.filter(term => (
      pageComparableText.includes(term)
      || phraseMap.has(term)
      || term.split(' ').some(token => termMap.has(token))
    ));
    const requiredMatches = entry.dictionaryType === 'topic'
      ? Math.max(1, Math.ceil(normalizedTerms.length * 0.25))
      : 1;
    if (matchedTerms.length < requiredMatches) continue;
    dictionaryMatches.push({
      dictionaryId: entry.id,
      type: entry.dictionaryType,
      label: entry.label,
      matchedTerms,
    });
    const source = entry.dictionaryType;
    const termWeight = source === 'synonym' ? 4 : 2;
    const phraseWeight = source === 'synonym' ? 5 : 3;
    for (const value of normalizedTerms) {
      const tokens = tokenize(value, excludedTokens);
      tokens.forEach(token => addTerm(token, termWeight, source));
      if (tokens.length >= 2) addPhrase(tokens.join(' '), phraseWeight, source);
    }
  }

  const stemMap = new Map<string, ClientSemanticStem>();
  for (const term of termMap.values()) {
    if (!isArabicToken(term.term)) continue;
    const stem = lightStemArabicToken(term.term);
    if (!stem || stem === term.term && stem.length < 4) continue;
    const current = stemMap.get(stem);
    if (current) {
      current.weight = Math.max(current.weight, term.weight * 0.72);
      if (!current.terms.includes(term.term)) current.terms.push(term.term);
    } else {
      stemMap.set(stem, {
        stem,
        terms: [term.term],
        weight: Number((term.weight * 0.72).toFixed(2)),
      });
    }
  }

  const completeness = calculateCompleteness(page);
  const pathSegments = uniqueStrings(tokenize(pageUrlPath(page), excludedTokens));
  return {
    pageId: page.id,
    clientId: page.clientId,
    profileVersion: CLIENT_SEMANTIC_PROFILE_VERSION,
    sourceSignature: createClientPageSourceSignature(page),
    dictionarySignature: createClientDictionarySignature(dictionaryEntries),
    pageLanguage: (page.pageLanguage || '').toLocaleLowerCase(),
    pathSegments,
    weightedTerms: [...termMap.values()]
      .map(term => ({ ...term, sources: term.sources.sort() }))
      .sort((left, right) => right.weight - left.weight || right.frequency - left.frequency || left.term.localeCompare(right.term, 'ar'))
      .slice(0, 300),
    phrases: [...phraseMap.values()]
      .map(phrase => ({ ...phrase, sources: phrase.sources.sort() }))
      .sort((left, right) => right.weight - left.weight || right.size - left.size || left.phrase.localeCompare(right.phrase, 'ar'))
      .slice(0, 300),
    lightStems: [...stemMap.values()]
      .map(stem => ({ ...stem, terms: stem.terms.sort() }))
      .sort((left, right) => right.weight - left.weight || left.stem.localeCompare(right.stem, 'ar'))
      .slice(0, 200),
    dictionaryMatches: dictionaryMatches.sort((left, right) => (
      left.type.localeCompare(right.type) || left.label.localeCompare(right.label, 'ar')
    )),
    documentLength,
    completenessScore: completeness.score,
    completenessDetails: completeness.details,
    indexedAt,
  };
};

export const isClientSemanticProfileCurrent = (
  profile: ClientPageSemanticProfile | undefined,
  page: ClientSemanticPageInput,
  dictionaries: ClientLinkDictionaryEntry[],
): boolean => Boolean(
  profile
  && profile.profileVersion === CLIENT_SEMANTIC_PROFILE_VERSION
  && profile.sourceSignature === createClientPageSourceSignature(page)
  && profile.dictionarySignature === createClientDictionarySignature(dictionaries)
);
