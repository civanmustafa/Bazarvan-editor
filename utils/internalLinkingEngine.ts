import {
  isGenericClientPageTitle,
  lightStemArabicToken,
  type ClientPageSemanticProfile,
} from './clientSemanticIndex.ts';
import {
  calculateInternalLinkSuggestionBudget,
  INTERNAL_LINK_ANCHOR_MAX_WORDS,
  INTERNAL_LINK_ANCHOR_MIN_WORDS,
  normalizeInternalLinkQualityPolicy,
  type InternalLinkQualityPolicyValues,
} from './internalLinkQualityPolicy.ts';

export type InternalLinkTargetPage = {
  id: string;
  clientId?: string;
  inputUrl: string;
  finalUrl?: string;
  canonicalUrl?: string;
  crawlStatus: string;
  httpStatus?: number | null;
  pageTitle?: string;
  metaDescription?: string;
  h1?: string;
  h2?: string[];
  h3?: string[];
  slug?: string;
  pageLanguage?: string;
  robotsIndex?: boolean | null;
  contentHash?: string;
  extractedTerms?: string[];
  extractedPhrases?: string[];
  isEnabled?: boolean;
  semanticProfile?: ClientPageSemanticProfile;
  allowedDomains?: Array<{
    hostname: string;
    includeSubdomains: boolean;
  }>;
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
  paragraphNumber: number;
  alternativeAnchors: string[];
  bm25Score: number;
  completenessScore: number;
  algorithmVersion: 'bm25-quality-v3';
};

export type InternalLinkingInput = {
  articleTitle: string;
  articleText: string;
  articleLanguage?: string;
  keywords?: string[];
  pages: InternalLinkTargetPage[];
  existingUrls?: string[];
  existingAnchors?: string[];
  dismissedPageIds?: string[];
  blockedPageIds?: string[];
  currentArticleUrl?: string;
  maximumSuggestions?: number;
  qualityPolicy?: Partial<InternalLinkQualityPolicyValues> | null;
};

type TextSpan = {
  text: string;
  normalized: string;
  tokens: string[];
  paragraphNumber: number;
  paragraphText: string;
};

type TargetSignal = {
  value: string;
  normalized: string;
  tokens: string[];
  weight: number;
  frequency: number;
  source: 'title' | 'heading' | 'description' | 'phrase' | 'term' | 'slug' | 'synonym' | 'topic' | 'stem';
};

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const WORD_PATTERN = /[A-Za-z0-9\u0600-\u06FF]+/g;
const MAX_ANCHOR_WORDS = INTERNAL_LINK_ANCHOR_MAX_WORDS;
const MIN_ANCHOR_WORDS = INTERNAL_LINK_ANCHOR_MIN_WORDS;

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

export const isGenericInternalLinkPageTitle = (value: string | undefined): boolean => (
  isGenericClientPageTitle(value)
);

const meaningfulTokens = (value: string): string[] => normalizeInternalLinkText(value)
  .split(' ')
  .filter(token => token.length > 1 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));

const isForbiddenAnchor = (value: string, forbiddenAnchors: Set<string>): boolean => {
  const normalized = normalizeInternalLinkText(value);
  if (!normalized) return true;
  const padded = ` ${normalized} `;
  for (const forbidden of forbiddenAnchors) {
    if (padded.includes(` ${forbidden} `)) return true;
  }
  return false;
};

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

export const createInternalLinkInventorySignature = (
  pages: InternalLinkTargetPage[],
  currentArticleUrl = '',
  qualityPolicy?: Partial<InternalLinkQualityPolicyValues> | null,
): string => {
  const normalizedPolicy = normalizeInternalLinkQualityPolicy(qualityPolicy);
  const policySignature = [
    normalizedPolicy.minimumScore,
    normalizedPolicy.maxLinksPer1000Words,
    normalizedPolicy.absoluteMaximumLinks,
    normalizedPolicy.maximumLinksPerTarget,
    normalizedPolicy.minimumMatchedTerms,
    [...normalizedPolicy.forbiddenAnchors].sort().join(','),
  ].join('|');
  const value = `${normalizeInternalLinkUrl(currentArticleUrl)}\n${policySignature}\n${pages
    .map(page => [
      page.id,
      normalizeInternalLinkUrl(resolveInternalLinkTargetUrl(page)),
      page.semanticProfile?.sourceSignature || page.contentHash || '',
      page.semanticProfile?.dictionarySignature || '',
      page.isEnabled === false ? '0' : '1',
      page.crawlStatus,
      page.httpStatus ?? '',
    ].join('|'))
    .sort()
    .join('\n')}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `inventory_${(hash >>> 0).toString(36)}_${value.length.toString(36)}`;
};

const buildTextSpans = (articleText: string): TextSpan[] => {
  const paragraphs = articleText
    .split(/(?:\r?\n)+/)
    .map(text => text.trim())
    .filter(Boolean);
  return paragraphs.flatMap((paragraphText, index) => (
    paragraphText
      .split(/(?<=[.!؟?؛;])\s+/u)
      .map(text => text.trim())
      .filter(text => text.length >= 8)
      .map(text => ({
        text,
        normalized: normalizeInternalLinkText(text),
        tokens: meaningfulTokens(text),
        paragraphNumber: index + 1,
        paragraphText,
      }))
      .filter(span => span.tokens.length >= MIN_ANCHOR_WORDS)
  ));
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
      frequency: 1,
      source,
    });
  }
};

const semanticSource = (
  sources: string[],
): TargetSignal['source'] => {
  if (sources.includes('title')) return 'title';
  if (sources.some(source => source === 'h1' || source === 'h2' || source === 'h3')) return 'heading';
  if (sources.includes('synonym')) return 'synonym';
  if (sources.includes('topic')) return 'topic';
  if (sources.includes('description')) return 'description';
  if (sources.includes('slug')) return 'slug';
  if (sources.some(source => source.includes('phrase'))) return 'phrase';
  return 'term';
};

const pageSignals = (page: InternalLinkTargetPage): TargetSignal[] => {
  if (page.semanticProfile) {
    const indexedSignals: TargetSignal[] = page.semanticProfile.weightedTerms.map(term => ({
      value: term.term,
      normalized: term.term,
      tokens: [term.term],
      weight: term.weight,
      frequency: term.frequency,
      source: semanticSource(term.sources),
    }));
    for (const phrase of page.semanticProfile.phrases) {
      indexedSignals.push({
        value: phrase.phrase,
        normalized: phrase.phrase,
        tokens: meaningfulTokens(phrase.phrase),
        weight: phrase.weight,
        frequency: 1,
        source: semanticSource(phrase.sources),
      });
    }
    for (const stem of page.semanticProfile.lightStems) {
      indexedSignals.push({
        value: stem.terms[0] || stem.stem,
        normalized: stem.stem,
        tokens: [`~${stem.stem}`],
        weight: stem.weight,
        frequency: Math.max(1, stem.terms.length),
        source: 'stem',
      });
    }
    return indexedSignals.filter(signal => signal.tokens.length > 0);
  }

  const signals: TargetSignal[] = [];
  addSignals(signals, [isGenericInternalLinkPageTitle(page.pageTitle) ? undefined : page.pageTitle], 5, 'title');
  addSignals(signals, [page.h1], 4.5, 'heading');
  addSignals(signals, page.h2 || [], 3.5, 'heading');
  addSignals(signals, page.h3 || [], 2.5, 'heading');
  addSignals(signals, page.extractedPhrases || [], 3.75, 'phrase');
  addSignals(signals, [page.metaDescription], 2, 'description');
  addSignals(signals, page.extractedTerms || [], 2.25, 'term');
  addSignals(signals, [page.slug?.replace(/[-_]+/g, ' ')], 1.25, 'slug');
  return signals;
};

const readUrlHostname = (value: string): string => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.hostname.toLocaleLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
};

const isTargetUrlAllowedForPage = (
  value: string,
  page: InternalLinkTargetPage,
): boolean => {
  const hostname = readUrlHostname(value);
  if (!hostname) return false;
  if (page.allowedDomains && page.allowedDomains.length > 0) {
    return page.allowedDomains.some(domain => {
      const allowed = domain.hostname.toLocaleLowerCase().replace(/\.$/, '');
      return hostname === allowed || (domain.includeSubdomains && hostname.endsWith(`.${allowed}`));
    });
  }
  const inputHostname = readUrlHostname(page.inputUrl);
  return Boolean(inputHostname && hostname === inputHostname);
};

export const resolveInternalLinkTargetUrl = (page: InternalLinkTargetPage): string => (
  [
    page.canonicalUrl?.trim(),
    page.finalUrl?.trim(),
    page.inputUrl.trim(),
  ].find(value => Boolean(value && isTargetUrlAllowedForPage(value, page))) || ''
);

export const countExistingInventoryLinks = (
  existingUrls: string[],
  pages: InternalLinkTargetPage[],
): number => {
  const targetUrls = new Set(
    pages.map(page => normalizeInternalLinkUrl(resolveInternalLinkTargetUrl(page))).filter(Boolean),
  );
  return existingUrls
    .map(normalizeInternalLinkUrl)
    .filter(url => url && targetUrls.has(url))
    .length;
};

const isEligiblePage = (page: InternalLinkTargetPage): boolean => (
  page.isEnabled !== false
  && page.robotsIndex !== false
  && page.crawlStatus === 'ready'
  && (
    typeof page.httpStatus !== 'number'
    || (page.httpStatus >= 200 && page.httpStatus < 400)
  )
  && Boolean(resolveInternalLinkTargetUrl(page))
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
  Math.log(1 + ((total - (documentFrequency.get(token) || 0) + 0.5) / ((documentFrequency.get(token) || 0) + 0.5)))
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
  forbiddenAnchors: Set<string>,
): {
  text: string;
  score: number;
  excerpt: string;
  exactPhrase: boolean;
  paragraphNumber: number;
  paragraphText: string;
  alternativeAnchors: string[];
} | null => {
  const tokenWeights = new Map<string, number>();
  const signalPhrases = new Set<string>();
  for (const signal of signals) {
    if (signal.tokens.length >= MIN_ANCHOR_WORDS) signalPhrases.add(signal.normalized);
    for (const token of signal.tokens) {
      tokenWeights.set(token, Math.max(tokenWeights.get(token) || 0, signal.weight));
    }
  }
  const anchorTokenWeight = (token: string): number => (
    tokenWeights.get(token)
    || tokenWeights.get(`~${lightStemArabicToken(token)}`)
    || 0
  );

  const candidates = new Map<string, {
    text: string;
    score: number;
    excerpt: string;
    exactPhrase: boolean;
    paragraphNumber: number;
    paragraphText: string;
  }>();
  for (const span of spans) {
    const words = extractWordMatches(span.text);
    const upper = Math.min(MAX_ANCHOR_WORDS, words.length);
    for (let size = MIN_ANCHOR_WORDS; size <= upper; size += 1) {
      for (let start = 0; start + size <= words.length; start += 1) {
        const group = words.slice(start, start + size);
        const original = span.text.slice(group[0].start, group[group.length - 1].end).trim();
        const normalized = normalizeInternalLinkText(original);
        if (isForbiddenAnchor(original, forbiddenAnchors)) continue;
        const tokens = meaningfulTokens(original);
        if (tokens.length < MIN_ANCHOR_WORDS) continue;
        const weightedTokens = tokens.filter(token => anchorTokenWeight(token) > 0);
        if (weightedTokens.length < Math.min(2, tokens.length)) continue;

        const exactPhrase = signalPhrases.has(normalized);
        const coverage = weightedTokens.length / tokens.length;
        const weight = weightedTokens.reduce((sum, token) => (
          sum + anchorTokenWeight(token) * tokenIdf(
            tokenWeights.has(token) ? token : `~${lightStemArabicToken(token)}`,
            documentFrequency,
            totalPages,
          )
        ), 0);
        const lengthPreference = size === 2 ? 0.9 : 1 + ((size - 2) * 0.04);
        const score = (weight * coverage * lengthPreference) + (exactPhrase ? 14 : 0);
        const candidate = {
          text: original,
          score,
          excerpt: span.paragraphText.length <= 220
            ? span.paragraphText
            : `${span.paragraphText.slice(0, 217).trim()}...`,
          exactPhrase,
          paragraphNumber: span.paragraphNumber,
          paragraphText: span.paragraphText,
        };
        const current = candidates.get(normalized);
        if (!current || candidate.score > current.score) {
          candidates.set(normalized, candidate);
        }
      }
    }
  }
  const ranked = [...candidates.values()].sort((left, right) => (
    right.score - left.score
    || meaningfulTokens(right.text).length - meaningfulTokens(left.text).length
    || right.text.length - left.text.length
    || left.text.localeCompare(right.text, 'ar')
  ));
  const best = ranked[0];
  if (!best) return null;
  return {
    ...best,
    alternativeAnchors: ranked
      .filter(candidate => candidate.paragraphNumber === best.paragraphNumber)
      .slice(0, 5)
      .map(candidate => candidate.text),
  };
};

const buildTokenContext = (value: string): {
  frequency: Map<string, number>;
  stemTerms: Map<string, string>;
} => {
  const frequency = new Map<string, number>();
  const stemTerms = new Map<string, string>();
  for (const token of meaningfulTokens(value)) {
    frequency.set(token, (frequency.get(token) || 0) + 1);
    const stem = lightStemArabicToken(token);
    if (!stem || stem === token) continue;
    const stemToken = `~${stem}`;
    frequency.set(stemToken, (frequency.get(stemToken) || 0) + 1);
    if (!stemTerms.has(stem)) stemTerms.set(stem, token);
  }
  return { frequency, stemTerms };
};

const computeBm25Score = (input: {
  signals: TargetSignal[];
  articleTokenFrequency: Map<string, number>;
  documentFrequency: Map<string, number>;
  totalPages: number;
  documentLength: number;
  averageDocumentLength: number;
}): number => {
  const stats = new Map<string, { frequency: number; weight: number }>();
  for (const signal of input.signals) {
    for (const token of signal.tokens) {
      const current = stats.get(token);
      if (current) {
        current.frequency = Math.max(current.frequency, signal.frequency);
        current.weight = Math.max(current.weight, signal.weight);
      } else {
        stats.set(token, { frequency: signal.frequency, weight: signal.weight });
      }
    }
  }

  const k1 = 1.35;
  const b = 0.72;
  const lengthRatio = input.documentLength / Math.max(1, input.averageDocumentLength);
  let score = 0;
  for (const [token, tokenStats] of stats) {
    const queryFrequency = input.articleTokenFrequency.get(token) || 0;
    if (queryFrequency === 0) continue;
    const denominator = tokenStats.frequency + (k1 * (1 - b + (b * lengthRatio)));
    const normalizedFrequency = (tokenStats.frequency * (k1 + 1)) / Math.max(0.01, denominator);
    const fieldWeight = 0.65 + Math.min(1.35, tokenStats.weight / 7);
    score += tokenIdf(token, input.documentFrequency, input.totalPages)
      * normalizedFrequency
      * fieldWeight
      * (1 + Math.log(queryFrequency));
  }
  return score;
};

const buildSuggestion = (
  page: InternalLinkTargetPage,
  signals: TargetSignal[],
  spans: TextSpan[],
  articleContextFrequency: Map<string, number>,
  documentFrequency: Map<string, number>,
  totalPages: number,
  averageDocumentLength: number,
  qualityPolicy: InternalLinkQualityPolicyValues,
  forbiddenAnchors: Set<string>,
): InternalLinkSuggestion | null => {
  const anchor = chooseAnchor(
    spans,
    signals,
    documentFrequency,
    totalPages,
    forbiddenAnchors,
  );
  if (!anchor) return null;

  const paragraphContext = buildTokenContext(anchor.paragraphText);
  const matchedTokenWeights = new Map<string, number>();
  const matchedSources = new Set<TargetSignal['source']>();
  let totalSignalWeight = 0;
  for (const signal of signals) {
    totalSignalWeight += signal.weight * Math.max(1, signal.tokens.length);
    for (const token of signal.tokens) {
      if (!paragraphContext.frequency.has(token)) continue;
      matchedSources.add(signal.source);
      const visibleToken = token.startsWith('~')
        ? paragraphContext.stemTerms.get(token.slice(1)) || token.slice(1)
        : token;
      matchedTokenWeights.set(
        visibleToken,
        Math.max(matchedTokenWeights.get(visibleToken) || 0, signal.weight),
      );
    }
  }
  if (matchedTokenWeights.size < qualityPolicy.minimumMatchedTerms) return null;

  const documentLength = page.semanticProfile?.documentLength
    || signals.reduce((sum, signal) => sum + signal.frequency, 0);
  const bm25Score = computeBm25Score({
    signals,
    articleTokenFrequency: paragraphContext.frequency,
    documentFrequency,
    totalPages,
    documentLength,
    averageDocumentLength,
  });
  const overlapWeight = [...matchedTokenWeights.values()].reduce((sum, weight) => sum + weight, 0);
  const normalizedOverlap = Math.min(1, overlapWeight / Math.max(8, totalSignalWeight * 0.32));
  const sourceBonus = (
    (matchedSources.has('title') ? 10 : 0)
    + (matchedSources.has('heading') ? 8 : 0)
    + (matchedSources.has('phrase') ? 6 : 0)
    + (matchedSources.has('synonym') ? 6 : 0)
    + (matchedSources.has('topic') ? 4 : 0)
    + (matchedSources.has('stem') ? 3 : 0)
    + (matchedSources.has('description') ? 3 : 0)
  );
  const anchorBonus = Math.min(22, anchor.score * 0.72) + (anchor.exactPhrase ? 8 : 0);
  const normalizedBm25 = 1 - Math.exp(-bm25Score / 8);
  const articleContextMatches = new Set(
    signals.flatMap(signal => signal.tokens).filter(token => articleContextFrequency.has(token)),
  ).size;
  const articleContextBonus = Math.min(4, articleContextMatches * 0.4);
  const completenessScore = page.semanticProfile?.completenessScore ?? 60;
  const completenessFactor = 0.85 + (Math.min(100, completenessScore) / 650);
  const score = Math.max(0, Math.min(100, Math.round((
    (normalizedBm25 * 48)
    + (normalizedOverlap * 18)
    + sourceBonus
    + anchorBonus
    + articleContextBonus
  ) * completenessFactor)));
  const hasStrongRelation = (
    matchedSources.has('title')
    || matchedSources.has('heading')
    || matchedSources.has('phrase')
    || matchedSources.has('synonym')
    || matchedSources.has('topic')
    || (
      matchedTokenWeights.size > qualityPolicy.minimumMatchedTerms
      && bm25Score >= 1.5
    )
  );
  if (!hasStrongRelation || score < qualityPolicy.minimumScore) return null;

  const reasons: string[] = [];
  if (matchedSources.has('title')) reasons.push('تطابق مع عنوان الصفحة');
  if (matchedSources.has('heading')) reasons.push('تطابق مع عناوين الصفحة');
  if (anchor.exactPhrase || matchedSources.has('phrase')) reasons.push('عبارة دلالية متطابقة');
  if (matchedSources.has('description')) reasons.push('سياق متوافق مع الوصف');
  if (matchedSources.has('synonym')) reasons.push('مطابقة عبر قاموس المرادفات');
  if (matchedSources.has('topic')) reasons.push('موضوع مرتبط في قاموس العميل');
  if (matchedSources.has('stem')) reasons.push('تطابق بالجذر العربي الخفيف');
  if (reasons.length === 0) reasons.push('تقارب موضوعي في الكلمات الأساسية');

  const matchedTerms = [...matchedTokenWeights.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ar'))
    .slice(0, 6)
    .map(([token]) => token);

  return {
    pageId: page.id,
    targetUrl: resolveInternalLinkTargetUrl(page),
    targetTitle: (
      isGenericInternalLinkPageTitle(page.pageTitle)
        ? page.h1?.trim() || page.pageTitle?.trim()
        : page.pageTitle?.trim() || page.h1?.trim()
    ) || resolveInternalLinkTargetUrl(page),
    anchorText: anchor.text,
    score,
    confidence: score >= 75 ? 'strong' : score >= 50 ? 'good' : 'review',
    matchedTerms,
    reasons,
    sourceExcerpt: anchor.excerpt,
    paragraphNumber: anchor.paragraphNumber,
    alternativeAnchors: anchor.alternativeAnchors,
    bm25Score: Number(bm25Score.toFixed(2)),
    completenessScore,
    algorithmVersion: 'bm25-quality-v3',
  };
};

const baseLanguage = (value: string | undefined): string => (
  (value || '').trim().toLocaleLowerCase().split('-')[0]
);

export const generateInternalLinkSuggestions = (
  input: InternalLinkingInput,
): InternalLinkSuggestion[] => {
  const qualityPolicy = normalizeInternalLinkQualityPolicy(input.qualityPolicy);
  const forbiddenAnchors = new Set(
    qualityPolicy.forbiddenAnchors.map(normalizeInternalLinkText).filter(Boolean),
  );
  const normalizedExistingUrls = (input.existingUrls || [])
    .map(normalizeInternalLinkUrl)
    .filter(Boolean);
  const existingTargetCounts = new Map<string, number>();
  for (const url of normalizedExistingUrls) {
    existingTargetCounts.set(url, (existingTargetCounts.get(url) || 0) + 1);
  }
  const currentArticleUrl = normalizeInternalLinkUrl(input.currentArticleUrl || '');
  const suggestionBudget = calculateInternalLinkSuggestionBudget(
    input.articleText,
    countExistingInventoryLinks(input.existingUrls || [], input.pages),
    qualityPolicy,
    input.maximumSuggestions,
  );
  const existingAnchors = new Set(
    (input.existingAnchors || []).map(normalizeInternalLinkText).filter(Boolean),
  );
  const dismissedPageIds = new Set(input.dismissedPageIds || []);
  const blockedPageIds = new Set(input.blockedPageIds || []);
  const requestedLanguage = baseLanguage(input.articleLanguage);
  const eligible = input.pages
    .filter(isEligiblePage)
    .filter(page => !blockedPageIds.has(page.id))
    .filter(page => {
      const pageLanguage = baseLanguage(page.semanticProfile?.pageLanguage || page.pageLanguage);
      return !requestedLanguage || !pageLanguage || requestedLanguage === pageLanguage;
    })
    .filter(page => !dismissedPageIds.has(page.id))
    .filter(page => {
      const targetUrl = normalizeInternalLinkUrl(resolveInternalLinkTargetUrl(page));
      if (!targetUrl || targetUrl === currentArticleUrl) return false;
      return (existingTargetCounts.get(targetUrl) || 0) < qualityPolicy.maximumLinksPerTarget;
    })
    .map(page => ({ page, signals: pageSignals(page) }))
    .filter(item => item.signals.length > 0);

  if (!input.articleText.trim() || eligible.length === 0 || suggestionBudget === 0) return [];

  const spans = buildTextSpans(input.articleText);
  const articleContext = buildTokenContext([
    input.articleTitle,
    input.articleText,
    ...(input.keywords || []),
  ].join(' '));
  const documentFrequency = computeDocumentFrequency(eligible);
  const averageDocumentLength = eligible.reduce((sum, item) => (
    sum
    + (item.page.semanticProfile?.documentLength
      || item.signals.reduce((length, signal) => length + signal.frequency, 0))
  ), 0) / Math.max(1, eligible.length);

  const ranked = eligible
    .map(({ page, signals }) => buildSuggestion(
      page,
      signals,
      spans,
      articleContext.frequency,
      documentFrequency,
      eligible.length,
      averageDocumentLength,
      qualityPolicy,
      forbiddenAnchors,
    ))
    .filter((suggestion): suggestion is InternalLinkSuggestion => Boolean(suggestion))
    .sort((a, b) => (
      b.score - a.score
      || meaningfulTokens(b.anchorText).length - meaningfulTokens(a.anchorText).length
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
    if (accepted.length >= suggestionBudget) break;
  }
  return accepted;
};
