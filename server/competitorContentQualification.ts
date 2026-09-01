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
  buildCompetitorTargetTerms,
  findCompetitorTargetingEvidence,
  type CompetitorContentQualification,
  type CompetitorTargetingEvidence,
  type ContentQualifiedCompetitorCandidate,
} from './competitorSelectionEngine.ts';
import type { CompetitorSearchResult } from './firecrawlCompetitorService.ts';

const QUALIFICATION_VERSION = 'competitor-multi-evidence-targeting-v2';
const MINIMUM_CONTENT_WORDS = 40;
const INTRODUCTION_WORDS = 300;

type SearchMetadata = Pick<CompetitorSearchResult, 'title' | 'description' | 'url' | 'canonicalUrl'>;

const metadataSources = (searchResult?: SearchMetadata) => searchResult ? [
  { source: 'serp_title' as const, value: searchResult.title },
  { source: 'serp_description' as const, value: searchResult.description },
  { source: 'url' as const, value: searchResult.canonicalUrl || searchResult.url },
] : [];

const contentSources = (
  content: Pick<ProgrammaticCompetitorContent, 'title' | 'headings' | 'text'>,
) => [
  { source: 'page_title' as const, value: content.title },
  { source: 'h1' as const, value: content.headings.h1.join(' ') },
  { source: 'headings' as const, value: [...content.headings.h2, ...content.headings.h3].join(' ') },
  { source: 'introduction' as const, value: content.text.split(/\s+/).slice(0, INTRODUCTION_WORDS).join(' ') },
  { source: 'body' as const, value: content.text },
];

const matchKindForEvidence = (
  evidence?: CompetitorTargetingEvidence,
): CompetitorContentQualification['matchKind'] => {
  if (!evidence) return 'none';
  const ordered = evidence.matchType === 'ordered_near';
  if (evidence.termKind === 'primary') return ordered ? 'ordered_primary' : 'primary';
  if (evidence.termKind === 'alternative') return ordered ? 'ordered_alternative' : 'alternative';
  return ordered ? 'ordered_article_title' : 'article_title';
};

const targetingFields = (evidence: CompetitorTargetingEvidence[]) => {
  const best = evidence[0];
  return {
    score: best?.score || 0,
    matchedKeyword: best?.term || '',
    matchKind: matchKindForEvidence(best),
    locations: Array.from(new Set(evidence.map(item => item.source))),
    occurrences: evidence.length > 0 ? Math.max(...evidence.map(item => item.occurrences)) : 0,
    targetingStatus: best ? 'confirmed' as const : 'not_confirmed' as const,
    evidence,
  };
};

export const analyzeCompetitorKeywordTargeting = (options: {
  content: Pick<ProgrammaticCompetitorContent, 'title' | 'headings' | 'text' | 'wordCount' | 'qualityScore' | 'cacheHit'>;
  primaryKeyword: string;
  alternativeKeywords?: string[];
  articleTitle?: string;
  searchResult?: SearchMetadata;
}): CompetitorContentQualification => {
  const terms = buildCompetitorTargetTerms({
    primaryKeyword: options.primaryKeyword,
    alternativeKeywords: options.alternativeKeywords,
    articleTitle: options.articleTitle,
  });
  const evidence = findCompetitorTargetingEvidence({
    terms,
    sources: [...metadataSources(options.searchResult), ...contentSources(options.content)],
  });
  const targeting = targetingFields(evidence);
  const contentUsable = options.content.wordCount >= MINIMUM_CONTENT_WORDS && Boolean(options.content.text.trim());
  if (!contentUsable) {
    return {
      status: 'unavailable',
      ...targeting,
      wordCount: options.content.wordCount,
      qualityScore: options.content.qualityScore,
      cacheHit: options.content.cacheHit,
      errorCode: 'qualification_content_too_short',
      version: QUALIFICATION_VERSION,
      contentAvailability: 'available',
      contentUsability: 'insufficient',
    };
  }
  if (targeting.targetingStatus !== 'confirmed') {
    return {
      status: 'not_qualified',
      ...targeting,
      wordCount: options.content.wordCount,
      qualityScore: options.content.qualityScore,
      cacheHit: options.content.cacheHit,
      errorCode: terms.length === 0 ? 'target_terms_not_specific' : 'target_phrase_not_found_in_evidence',
      version: QUALIFICATION_VERSION,
      contentAvailability: 'available',
      contentUsability: 'usable',
    };
  }
  return {
    status: 'qualified',
    ...targeting,
    wordCount: options.content.wordCount,
    qualityScore: options.content.qualityScore,
    cacheHit: options.content.cacheHit,
    errorCode: '',
    version: QUALIFICATION_VERSION,
    contentAvailability: 'available',
    contentUsability: 'usable',
  };
};

const unavailableQualification = (options: {
  error: unknown;
  candidate: SearchMetadata;
  primaryKeyword: string;
  alternativeKeywords?: string[];
  articleTitle?: string;
}): CompetitorContentQualification => {
  const evidence = findCompetitorTargetingEvidence({
    terms: buildCompetitorTargetTerms(options),
    sources: metadataSources(options.candidate),
  });
  const targeting = targetingFields(evidence);
  return {
    status: 'unavailable',
    ...targeting,
    // An extraction failure does not disprove targeting. The evidence status is
    // deliberately unknown when Google metadata contains no complete phrase.
    targetingStatus: evidence.length > 0 ? 'confirmed' : 'unknown',
    wordCount: 0,
    qualityScore: 0,
    cacheHit: false,
    errorCode: options.error instanceof ProgrammaticCompetitorExtractionError
      ? options.error.code
      : 'content_qualification_failed',
    version: QUALIFICATION_VERSION,
    contentAvailability: 'unavailable',
    contentUsability: 'not_assessed',
  };
};

export const qualifyCompetitorCandidates = async (options: {
  candidates: CompetitorSearchResult[];
  primaryKeyword: string;
  alternativeKeywords?: string[];
  articleTitle?: string;
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
            articleTitle: options.articleTitle,
            searchResult: candidate,
          }),
        };
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        results[index] = {
          ...candidate,
          contentQualification: unavailableQualification({
            error,
            candidate,
            primaryKeyword: options.primaryKeyword,
            alternativeKeywords: options.alternativeKeywords,
            articleTitle: options.articleTitle,
          }),
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
