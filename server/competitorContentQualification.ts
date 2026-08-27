import {
  COMPETITOR_CONTENT_QUALIFICATION_CANDIDATE_LIMIT,
  COMPETITOR_CONTENT_QUALIFICATION_CONCURRENCY,
  COMPETITOR_CONTENT_QUALIFICATION_TIMEOUT_MS,
} from '../constants/competitors.ts';
import {
  getProgrammaticCompetitorContent,
  ProgrammaticCompetitorExtractionError,
  type ProgrammaticCompetitorContent,
} from './programmaticCompetitorExtractor.ts';
import {
  normalizeCompetitorText,
  type CompetitorContentQualification,
  type ContentQualifiedCompetitorCandidate,
} from './competitorSelectionEngine.ts';
import type { CompetitorSearchResult } from './firecrawlCompetitorService.ts';

const QUALIFICATION_VERSION = 'competitor-keyword-targeting-v1';
const MINIMUM_CONTENT_WORDS = 40;
const INTRODUCTION_WORDS = 300;

type MatchLocation = CompetitorContentQualification['locations'][number];

const uniqueTerms = (values: unknown[], maximum = 12): string[] => {
  const seen = new Set<string>();
  const terms: string[] = [];
  values.forEach(value => {
    const term = typeof value === 'string' ? value.trim().slice(0, 300) : '';
    const normalized = normalizeCompetitorText(term);
    if (!normalized || seen.has(normalized) || terms.length >= maximum) return;
    seen.add(normalized);
    terms.push(term);
  });
  return terms;
};

const normalizedTokens = (value: unknown): string[] => (
  normalizeCompetitorText(value).split(' ').filter(Boolean)
);

const arabicTokenVariants = (value: string): Set<string> => {
  const variants = new Set([value]);
  const queue = [value];
  while (queue.length > 0) {
    const token = queue.shift() || '';
    const additions: string[] = [];
    if (/^[وف][\u0621-\u064a]/.test(token) && token.length >= 5) additions.push(token.slice(1));
    if (/^[بكل][\u0621-\u064a]/.test(token) && token.length >= 5) additions.push(token.slice(1));
    if (token.startsWith('لل') && token.length >= 5) additions.push(`ال${token.slice(2)}`);
    additions.forEach(addition => {
      if (addition.length < 3 || variants.has(addition)) return;
      variants.add(addition);
      queue.push(addition);
    });
  }
  return variants;
};

const tokenMatches = (contentToken: string, keywordToken: string): boolean => (
  contentToken === keywordToken
  || arabicTokenVariants(contentToken).has(keywordToken)
);

const countContiguousMatches = (contentTokens: string[], keywordTokens: string[]): number => {
  if (keywordTokens.length === 0 || contentTokens.length < keywordTokens.length) return 0;
  let matches = 0;
  for (let start = 0; start <= contentTokens.length - keywordTokens.length; start += 1) {
    if (keywordTokens.every((token, offset) => tokenMatches(contentTokens[start + offset], token))) {
      matches += 1;
      start += Math.max(0, keywordTokens.length - 1);
    }
  }
  return matches;
};

const hasOrderedNearMatch = (contentTokens: string[], keywordTokens: string[]): boolean => {
  if (keywordTokens.length < 2 || contentTokens.length < keywordTokens.length) return false;
  const maximumWindow = keywordTokens.length + 2;
  for (let start = 0; start < contentTokens.length; start += 1) {
    if (!tokenMatches(contentTokens[start], keywordTokens[0])) continue;
    let keywordIndex = 1;
    const end = Math.min(contentTokens.length, start + maximumWindow);
    for (let index = start + 1; index < end && keywordIndex < keywordTokens.length; index += 1) {
      if (tokenMatches(contentTokens[index], keywordTokens[keywordIndex])) keywordIndex += 1;
    }
    if (keywordIndex === keywordTokens.length) return true;
  }
  return false;
};

type TermEvidence = {
  term: string;
  primary: boolean;
  exact: boolean;
  ordered: boolean;
  locations: MatchLocation[];
  occurrences: number;
  score: number;
};

const analyzeTerm = (
  content: Pick<ProgrammaticCompetitorContent, 'title' | 'headings' | 'text'>,
  term: string,
  primary: boolean,
): TermEvidence => {
  const keywordTokens = normalizedTokens(term);
  const titleTokens = normalizedTokens(content.title);
  const h1Tokens = normalizedTokens(content.headings.h1.join(' '));
  const headingTokens = normalizedTokens([...content.headings.h2, ...content.headings.h3].join(' '));
  const bodyTokens = normalizedTokens(content.text);
  const introductionTokens = bodyTokens.slice(0, INTRODUCTION_WORDS);
  const titleMatches = countContiguousMatches(titleTokens, keywordTokens);
  const h1Matches = countContiguousMatches(h1Tokens, keywordTokens);
  const headingMatches = countContiguousMatches(headingTokens, keywordTokens);
  const introductionMatches = countContiguousMatches(introductionTokens, keywordTokens);
  const bodyMatches = countContiguousMatches(bodyTokens, keywordTokens);
  const exact = titleMatches + h1Matches + headingMatches + bodyMatches > 0;
  const ordered = !exact && (
    hasOrderedNearMatch(titleTokens, keywordTokens)
    || hasOrderedNearMatch(h1Tokens, keywordTokens)
    || hasOrderedNearMatch(headingTokens, keywordTokens)
    || hasOrderedNearMatch(bodyTokens, keywordTokens)
  );
  const locations: MatchLocation[] = [];
  if (titleMatches > 0) locations.push('title');
  if (h1Matches > 0) locations.push('h1');
  if (headingMatches > 0) locations.push('headings');
  if (introductionMatches > 0) locations.push('introduction');
  if (bodyMatches > 0 || ordered) locations.push('body');
  let score = 0;
  if (titleMatches > 0 || h1Matches > 0) score += 30;
  if (headingMatches > 0) score += 20;
  if (introductionMatches > 0) score += 20;
  if (bodyMatches > 0) score += Math.min(15, bodyMatches * 5);
  if (exact) score += 15;
  else if (ordered) score += 8;
  score = Math.round(Math.min(100, score * (primary ? 1 : 0.86)));
  return {
    term,
    primary,
    exact,
    ordered,
    locations: Array.from(new Set(locations)),
    occurrences: bodyMatches,
    score,
  };
};

export const analyzeCompetitorKeywordTargeting = (options: {
  content: Pick<ProgrammaticCompetitorContent, 'title' | 'headings' | 'text' | 'wordCount' | 'qualityScore' | 'cacheHit'>;
  primaryKeyword: string;
  alternativeKeywords?: string[];
}): CompetitorContentQualification => {
  const primaryKeyword = options.primaryKeyword.trim().slice(0, 300);
  const alternatives = uniqueTerms(options.alternativeKeywords || [])
    .filter(term => normalizeCompetitorText(term) !== normalizeCompetitorText(primaryKeyword));
  if (options.content.wordCount < MINIMUM_CONTENT_WORDS || !options.content.text.trim()) {
    return {
      status: 'unavailable',
      score: 0,
      matchedKeyword: '',
      matchKind: 'none',
      locations: [],
      occurrences: 0,
      wordCount: options.content.wordCount,
      qualityScore: options.content.qualityScore,
      cacheHit: options.content.cacheHit,
      errorCode: 'qualification_content_too_short',
      version: QUALIFICATION_VERSION,
    };
  }
  const terms = [
    ...(primaryKeyword ? [{ term: primaryKeyword, primary: true }] : []),
    ...alternatives.map(term => ({ term, primary: false })),
  ];
  const evidence = terms
    .map(({ term, primary }) => analyzeTerm(options.content, term, primary))
    .filter(item => item.exact || item.ordered)
    .sort((left, right) => (
      Number(right.primary) - Number(left.primary)
      || Number(right.exact) - Number(left.exact)
      || right.score - left.score
    ));
  const best = evidence[0];
  if (!best) {
    return {
      status: 'not_qualified',
      score: 0,
      matchedKeyword: '',
      matchKind: 'none',
      locations: [],
      occurrences: 0,
      wordCount: options.content.wordCount,
      qualityScore: options.content.qualityScore,
      cacheHit: options.content.cacheHit,
      errorCode: 'keyword_not_found_in_content',
      version: QUALIFICATION_VERSION,
    };
  }
  return {
    status: 'qualified',
    score: best.score,
    matchedKeyword: best.term,
    matchKind: best.primary
      ? best.exact ? 'primary' : 'ordered_primary'
      : best.exact ? 'alternative' : 'ordered_alternative',
    locations: best.locations,
    occurrences: best.occurrences,
    wordCount: options.content.wordCount,
    qualityScore: options.content.qualityScore,
    cacheHit: options.content.cacheHit,
    errorCode: '',
    version: QUALIFICATION_VERSION,
  };
};

const unavailableQualification = (
  error: unknown,
): CompetitorContentQualification => ({
  status: 'unavailable',
  score: 0,
  matchedKeyword: '',
  matchKind: 'none',
  locations: [],
  occurrences: 0,
  wordCount: 0,
  qualityScore: 0,
  cacheHit: false,
  errorCode: error instanceof ProgrammaticCompetitorExtractionError
    ? error.code
    : 'content_qualification_failed',
  version: QUALIFICATION_VERSION,
});

export const qualifyCompetitorCandidates = async (options: {
  candidates: CompetitorSearchResult[];
  primaryKeyword: string;
  alternativeKeywords?: string[];
  signal?: AbortSignal;
  maximumCandidates?: number;
  concurrency?: number;
  extractor?: typeof getProgrammaticCompetitorContent;
  onProgress?: (progress: {
    current: number;
    total: number;
    candidate: CompetitorSearchResult;
    qualification: CompetitorContentQualification;
  }) => void | Promise<void>;
}): Promise<ContentQualifiedCompetitorCandidate[]> => {
  const maximum = Math.max(1, Math.min(
    options.maximumCandidates ?? COMPETITOR_CONTENT_QUALIFICATION_CANDIDATE_LIMIT,
    COMPETITOR_CONTENT_QUALIFICATION_CANDIDATE_LIMIT,
  ));
  const candidates = options.candidates.slice(0, maximum);
  const results: ContentQualifiedCompetitorCandidate[] = new Array(candidates.length);
  const extractor = options.extractor || getProgrammaticCompetitorContent;
  const concurrency = Math.max(1, Math.min(
    options.concurrency ?? COMPETITOR_CONTENT_QUALIFICATION_CONCURRENCY,
    COMPETITOR_CONTENT_QUALIFICATION_CONCURRENCY,
    candidates.length || 1,
  ));
  let cursor = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const candidate = candidates[index];
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Competitor qualification was cancelled.');
      try {
        const content = await extractor({
          url: candidate.canonicalUrl || candidate.url,
          signal: options.signal,
          timeoutMs: COMPETITOR_CONTENT_QUALIFICATION_TIMEOUT_MS,
          maximumBytes: 3_000_000,
        });
        results[index] = {
          ...candidate,
          contentQualification: analyzeCompetitorKeywordTargeting({
            content,
            primaryKeyword: options.primaryKeyword,
            alternativeKeywords: options.alternativeKeywords,
          }),
        };
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        results[index] = {
          ...candidate,
          contentQualification: unavailableQualification(error),
        };
      }
      completed += 1;
      await options.onProgress?.({
        current: completed,
        total: candidates.length,
        candidate,
        qualification: results[index].contentQualification!,
      });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
};
