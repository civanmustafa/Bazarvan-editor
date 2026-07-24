export type InternalLinkTargetPage = {
  id: string;
  inputUrl: string;
  finalUrl?: string;
  canonicalUrl?: string;
  crawlStatus: string;
  pageTitle?: string;
  metaDescription?: string;
  h1?: string;
  h2?: string[];
  h3?: string[];
  slug?: string;
  pageLanguage?: string;
  robotsIndex?: boolean | null;
  extractedTerms?: string[];
  extractedPhrases?: string[];
  isEnabled?: boolean;
};

export type InternalLinkSuggestionConfidence = 'strong' | 'good' | 'review';

export type InternalLinkSuggestion = {
  pageId: string;
  targetUrl: string;
  targetTitle: string;
  anchorText: string;
  score: number;
  confidence: InternalLinkSuggestionConfidence;
  matchedTerms: string[];
  reasons: string[];
  sourceExcerpt: string;
};

export type InternalLinkingInput = {
  articleTitle: string;
  articleText: string;
  keywords?: string[];
  pages: InternalLinkTargetPage[];
  existingUrls?: string[];
  existingAnchors?: string[];
  dismissedPageIds?: string[];
  maximumSuggestions?: number;
};

type TextSpan = {
  text: string;
  normalized: string;
  tokens: string[];
};

type TargetSignal = {
  value: string;
  normalized: string;
  tokens: string[];
  weight: number;
  source: 'title' | 'heading' | 'description' | 'phrase' | 'term' | 'slug';
};

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const WORD_PATTERN = /[A-Za-z0-9\u0600-\u06FF]+/g;
const MAX_ANCHOR_WORDS = 6;
const MIN_ANCHOR_WORDS = 2;

export const normalizeInternalLinkText = (value: string): string => value
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

const STOP_WORDS = new Set([
  'في', 'من', 'الى', 'إلى', 'عن', 'على', 'علي', 'مع', 'حتى', 'ثم', 'او', 'أو', 'ام', 'أم',
  'بل', 'لا', 'نعم', 'و', 'ف', 'ب', 'ك', 'ل', 'لل', 'هو', 'هي', 'هم', 'هن', 'هذا', 'هذه',
  'ذلك', 'تلك', 'الذي', 'التي', 'الذين', 'كان', 'كانت', 'يكون', 'تكون', 'يتم', 'تم', 'قد',
  'لقد', 'ان', 'إن', 'أن', 'كما', 'كل', 'اي', 'أي', 'غير', 'ما', 'ماذا', 'كيف', 'عند',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by',
  'at', 'as', 'is', 'are', 'was', 'were', 'be', 'this', 'that', 'these', 'those', 'it',
  'its', 'you', 'your', 'we', 'our',
].map(value => normalizeInternalLinkText(value)));

const meaningfulTokens = (value: string): string[] => normalizeInternalLinkText(value)
  .split(' ')
  .filter(token => token.length > 1 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));

export const normalizeInternalLinkUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLocaleLowerCase();
    if (
      (parsed.protocol === 'https:' && parsed.port === '443')
      || (parsed.protocol === 'http:' && parsed.port === '80')
    ) {
      parsed.port = '';
    }
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/[?#].*$/, '').replace(/\/$/, '').toLocaleLowerCase();
  }
};

export const createInternalLinkArticleSignature = (
  articleTitle: string,
  articleText: string,
): string => {
  const value = `${normalizeInternalLinkText(articleTitle)}|${normalizeInternalLinkText(articleText)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `article_${(hash >>> 0).toString(36)}_${value.length.toString(36)}`;
};

const buildTextSpans = (articleText: string): TextSpan[] => {
  const rawSegments = [
    ...articleText.split(/(?:\r?\n)+|(?<=[.!؟?؛;])\s+/u),
  ];
  return rawSegments
    .map(text => text.trim())
    .filter(text => text.length >= 8)
    .map(text => ({
      text,
      normalized: normalizeInternalLinkText(text),
      tokens: meaningfulTokens(text),
    }))
    .filter(span => span.tokens.length >= MIN_ANCHOR_WORDS);
};

const addSignals = (
  target: TargetSignal[],
  values: Array<string | undefined>,
  weight: number,
  source: TargetSignal['source'],
): void => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const tokens = meaningfulTokens(trimmed);
    if (tokens.length === 0) continue;
    target.push({
      value: trimmed,
      normalized: normalizeInternalLinkText(trimmed),
      tokens,
      weight,
      source,
    });
  }
};

const pageSignals = (page: InternalLinkTargetPage): TargetSignal[] => {
  const signals: TargetSignal[] = [];
  addSignals(signals, [page.pageTitle], 5, 'title');
  addSignals(signals, [page.h1], 4.5, 'heading');
  addSignals(signals, page.h2 || [], 3.5, 'heading');
  addSignals(signals, page.h3 || [], 2.5, 'heading');
  addSignals(signals, page.extractedPhrases || [], 3.75, 'phrase');
  addSignals(signals, [page.metaDescription], 2, 'description');
  addSignals(signals, page.extractedTerms || [], 2.25, 'term');
  addSignals(signals, [page.slug?.replace(/[-_]+/g, ' ')], 1.25, 'slug');
  return signals;
};

const resolveTargetUrl = (page: InternalLinkTargetPage): string => (
  page.canonicalUrl?.trim()
  || page.finalUrl?.trim()
  || page.inputUrl.trim()
);

const isEligiblePage = (page: InternalLinkTargetPage): boolean => (
  page.isEnabled !== false
  && page.robotsIndex !== false
  && page.crawlStatus === 'ready'
  && Boolean(resolveTargetUrl(page))
);

const computeDocumentFrequency = (
  pageSignalSets: Array<{ signals: TargetSignal[] }>,
): Map<string, number> => {
  const frequency = new Map<string, number>();
  for (const item of pageSignalSets) {
    const uniqueTokens = new Set(item.signals.flatMap(signal => signal.tokens));
    for (const token of uniqueTokens) {
      frequency.set(token, (frequency.get(token) || 0) + 1);
    }
  }
  return frequency;
};

const tokenIdf = (token: string, documentFrequency: Map<string, number>, total: number): number => (
  Math.log(1 + ((total + 1) / ((documentFrequency.get(token) || 0) + 1))) + 0.35
);

const extractWordMatches = (value: string): Array<{ value: string; start: number; end: number }> => {
  const matches: Array<{ value: string; start: number; end: number }> = [];
  for (const match of value.matchAll(WORD_PATTERN)) {
    const word = match[0];
    const start = match.index || 0;
    matches.push({ value: word, start, end: start + word.length });
  }
  return matches;
};

const chooseAnchor = (
  spans: TextSpan[],
  signals: TargetSignal[],
  documentFrequency: Map<string, number>,
  totalPages: number,
): { text: string; score: number; excerpt: string; exactPhrase: boolean } | null => {
  const tokenWeights = new Map<string, number>();
  const signalPhrases = new Set<string>();
  for (const signal of signals) {
    if (signal.tokens.length >= MIN_ANCHOR_WORDS) signalPhrases.add(signal.normalized);
    for (const token of signal.tokens) {
      tokenWeights.set(token, Math.max(tokenWeights.get(token) || 0, signal.weight));
    }
  }

  let best: { text: string; score: number; excerpt: string; exactPhrase: boolean } | null = null;
  for (const span of spans) {
    const words = extractWordMatches(span.text);
    const upper = Math.min(MAX_ANCHOR_WORDS, words.length);
    for (let size = MIN_ANCHOR_WORDS; size <= upper; size += 1) {
      for (let start = 0; start + size <= words.length; start += 1) {
        const group = words.slice(start, start + size);
        const original = span.text.slice(group[0].start, group[group.length - 1].end).trim();
        const normalized = normalizeInternalLinkText(original);
        const tokens = meaningfulTokens(original);
        if (tokens.length < MIN_ANCHOR_WORDS) continue;
        const weightedTokens = tokens.filter(token => tokenWeights.has(token));
        if (weightedTokens.length < Math.min(2, tokens.length)) continue;

        const exactPhrase = signalPhrases.has(normalized);
        const coverage = weightedTokens.length / tokens.length;
        const weight = weightedTokens.reduce((sum, token) => (
          sum + (tokenWeights.get(token) || 0) * tokenIdf(token, documentFrequency, totalPages)
        ), 0);
        const lengthPreference = size <= 4 ? 1 : 0.82;
        const score = (weight * coverage * lengthPreference) + (exactPhrase ? 14 : 0);
        if (!best || score > best.score || (score === best.score && original.length < best.text.length)) {
          best = {
            text: original,
            score,
            excerpt: span.text.length <= 180
              ? span.text
              : `${span.text.slice(0, 177).trim()}...`,
            exactPhrase,
          };
        }
      }
    }
  }
  return best;
};

const buildSuggestion = (
  page: InternalLinkTargetPage,
  signals: TargetSignal[],
  spans: TextSpan[],
  articleTokenFrequency: Map<string, number>,
  documentFrequency: Map<string, number>,
  totalPages: number,
): InternalLinkSuggestion | null => {
  const matchedTokenWeights = new Map<string, number>();
  const matchedSources = new Set<TargetSignal['source']>();
  let totalSignalWeight = 0;
  for (const signal of signals) {
    totalSignalWeight += signal.weight * Math.max(1, signal.tokens.length);
    for (const token of signal.tokens) {
      if (!articleTokenFrequency.has(token)) continue;
      matchedSources.add(signal.source);
      matchedTokenWeights.set(
        token,
        Math.max(matchedTokenWeights.get(token) || 0, signal.weight),
      );
    }
  }
  if (matchedTokenWeights.size < 2) return null;

  const anchor = chooseAnchor(spans, signals, documentFrequency, totalPages);
  if (!anchor) return null;

  const overlapWeight = [...matchedTokenWeights.entries()].reduce((sum, [token, weight]) => (
    sum
    + weight
    * tokenIdf(token, documentFrequency, totalPages)
    * (1 + Math.log(articleTokenFrequency.get(token) || 1))
  ), 0);
  const normalizedOverlap = Math.min(1, overlapWeight / Math.max(8, totalSignalWeight * 0.32));
  const sourceBonus = (
    (matchedSources.has('title') ? 10 : 0)
    + (matchedSources.has('heading') ? 8 : 0)
    + (matchedSources.has('phrase') ? 6 : 0)
    + (matchedSources.has('description') ? 3 : 0)
  );
  const anchorBonus = Math.min(22, anchor.score * 0.72) + (anchor.exactPhrase ? 8 : 0);
  const score = Math.max(0, Math.min(100, Math.round(
    (normalizedOverlap * 54) + sourceBonus + anchorBonus,
  )));
  if (score < 24) return null;

  const reasons: string[] = [];
  if (matchedSources.has('title')) reasons.push('تطابق مع عنوان الصفحة');
  if (matchedSources.has('heading')) reasons.push('تطابق مع عناوين الصفحة');
  if (anchor.exactPhrase || matchedSources.has('phrase')) reasons.push('عبارة دلالية متطابقة');
  if (matchedSources.has('description')) reasons.push('سياق متوافق مع الوصف');
  if (reasons.length === 0) reasons.push('تقارب موضوعي في الكلمات الأساسية');

  const matchedTerms = [...matchedTokenWeights.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ar'))
    .slice(0, 6)
    .map(([token]) => token);

  return {
    pageId: page.id,
    targetUrl: resolveTargetUrl(page),
    targetTitle: page.pageTitle?.trim() || page.h1?.trim() || resolveTargetUrl(page),
    anchorText: anchor.text,
    score,
    confidence: score >= 75 ? 'strong' : score >= 50 ? 'good' : 'review',
    matchedTerms,
    reasons,
    sourceExcerpt: anchor.excerpt,
  };
};

export const generateInternalLinkSuggestions = (
  input: InternalLinkingInput,
): InternalLinkSuggestion[] => {
  const existingUrls = new Set((input.existingUrls || []).map(normalizeInternalLinkUrl).filter(Boolean));
  const existingAnchors = new Set(
    (input.existingAnchors || []).map(normalizeInternalLinkText).filter(Boolean),
  );
  const dismissedPageIds = new Set(input.dismissedPageIds || []);
  const eligible = input.pages
    .filter(isEligiblePage)
    .filter(page => !dismissedPageIds.has(page.id))
    .filter(page => !existingUrls.has(normalizeInternalLinkUrl(resolveTargetUrl(page))))
    .map(page => ({ page, signals: pageSignals(page) }))
    .filter(item => item.signals.length > 0);

  if (!input.articleText.trim() || eligible.length === 0) return [];

  const spans = buildTextSpans(input.articleText);
  const articleTokens = meaningfulTokens([
    input.articleTitle,
    input.articleText,
    ...(input.keywords || []),
  ].join(' '));
  const articleTokenFrequency = new Map<string, number>();
  for (const token of articleTokens) {
    articleTokenFrequency.set(token, (articleTokenFrequency.get(token) || 0) + 1);
  }
  const documentFrequency = computeDocumentFrequency(eligible);

  const ranked = eligible
    .map(({ page, signals }) => buildSuggestion(
      page,
      signals,
      spans,
      articleTokenFrequency,
      documentFrequency,
      eligible.length,
    ))
    .filter((suggestion): suggestion is InternalLinkSuggestion => Boolean(suggestion))
    .sort((a, b) => (
      b.score - a.score
      || a.targetTitle.localeCompare(b.targetTitle, 'ar')
      || a.pageId.localeCompare(b.pageId)
    ));

  const accepted: InternalLinkSuggestion[] = [];
  const usedAnchors = new Set(existingAnchors);
  for (const suggestion of ranked) {
    const normalizedAnchor = normalizeInternalLinkText(suggestion.anchorText);
    if (!normalizedAnchor || usedAnchors.has(normalizedAnchor)) continue;
    const candidateTokens = new Set(meaningfulTokens(normalizedAnchor));
    if ([...usedAnchors].some(anchor => {
      if (anchor.includes(normalizedAnchor) || normalizedAnchor.includes(anchor)) return true;
      const usedTokens = new Set(meaningfulTokens(anchor));
      const overlap = [...candidateTokens].filter(token => usedTokens.has(token)).length;
      return overlap >= 2 && overlap / Math.min(candidateTokens.size, usedTokens.size) >= 0.5;
    })) continue;
    usedAnchors.add(normalizedAnchor);
    accepted.push(suggestion);
    if (accepted.length >= Math.max(1, Math.min(input.maximumSuggestions || 20, 50))) break;
  }
  return accepted;
};
