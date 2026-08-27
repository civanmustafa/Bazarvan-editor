import {
  COMPETITOR_ALTERNATIVE_SEARCH_LIMIT,
  COMPETITOR_CONTENT_QUALIFICATION_CANDIDATE_LIMIT,
  COMPETITOR_SEARCH_CANDIDATE_LIMIT,
  COMPETITOR_SEARCH_RESULT_LIMIT,
  MAX_ARTICLE_COMPETITORS,
} from '../constants/competitors.ts';
import {
  analyzeAndSelectCompetitors,
  normalizeCompetitorText,
  type CompetitorSelectionContext,
  type CompetitorSelectionResult,
  type ContentQualifiedCompetitorCandidate,
} from './competitorSelectionEngine.ts';
import { qualifyCompetitorCandidates } from './competitorContentQualification.ts';
import {
  searchCompetitorWeb,
  type CompetitorSearchResult,
} from './firecrawlCompetitorService.ts';

export type CompetitorDiscoveryProgress = {
  stage: 'searching_competitors' | 'qualifying_competitor_content' | 'expanding_competitor_search';
  query: string;
  current: number;
  total: number;
  qualifiedCount?: number;
};

const uniqueTerms = (values: unknown[], primaryKeyword: string): string[] => {
  const primary = normalizeCompetitorText(primaryKeyword);
  const seen = new Set<string>();
  return values.flatMap(value => {
    const term = typeof value === 'string' ? value.trim().slice(0, 300) : '';
    const normalized = normalizeCompetitorText(term);
    if (!normalized || normalized === primary || seen.has(normalized)) return [];
    seen.add(normalized);
    return [term];
  }).slice(0, 12);
};

const mergeCandidates = (
  current: CompetitorSearchResult[],
  incoming: CompetitorSearchResult[],
): CompetitorSearchResult[] => {
  const merged = new Map<string, CompetitorSearchResult>();
  [...current, ...incoming].forEach(candidate => {
    const key = candidate.canonicalUrl || candidate.url;
    const existing = merged.get(key);
    if (!existing || candidate.position < existing.position) merged.set(key, candidate);
  });
  return Array.from(merged.values());
};

const evidenceByUrl = (
  candidates: ContentQualifiedCompetitorCandidate[],
): Map<string, ContentQualifiedCompetitorCandidate['contentQualification']> => (
  new Map(candidates.map(candidate => [
    candidate.canonicalUrl || candidate.url,
    candidate.contentQualification,
  ]))
);

const metadataPool = (
  context: CompetitorSelectionContext,
  candidates: CompetitorSearchResult[],
): CompetitorSearchResult[] => analyzeAndSelectCompetitors({
  context,
  candidates,
  maxResults: COMPETITOR_SEARCH_RESULT_LIMIT,
  maxSelected: MAX_ARTICLE_COMPETITORS,
}).results.slice(0, COMPETITOR_CONTENT_QUALIFICATION_CANDIDATE_LIMIT).map(result => ({
  url: result.url,
  canonicalUrl: result.canonicalUrl,
  domain: result.domain,
  title: result.title,
  description: result.description,
  position: result.position,
}));

export const discoverAndSelectCompetitors = async (options: {
  context: CompetitorSelectionContext;
  country?: string;
  location?: string;
  excludeDomains?: string[];
  signal?: AbortSignal;
  userId?: string | null;
  maxResults?: number;
  maxSelected?: number;
  alternativeSearchLimit?: number;
  onProgress?: (progress: CompetitorDiscoveryProgress) => void | Promise<void>;
}): Promise<CompetitorSelectionResult> => {
  const primaryKeyword = options.context.primaryKeyword?.trim() || options.context.query.trim();
  const alternativeKeywords = uniqueTerms(
    options.context.alternativeKeywords || [],
    primaryKeyword,
  );
  const context: CompetitorSelectionContext = {
    ...options.context,
    primaryKeyword,
    alternativeKeywords,
  };
  const search = async (query: string, stage: CompetitorDiscoveryProgress['stage']): Promise<CompetitorSearchResult[]> => {
    await options.onProgress?.({
      stage,
      query,
      current: 0,
      total: COMPETITOR_SEARCH_CANDIDATE_LIMIT,
    });
    return searchCompetitorWeb({
      query,
      limit: COMPETITOR_SEARCH_CANDIDATE_LIMIT,
      country: options.country,
      location: options.location,
      excludeDomains: options.excludeDomains,
      signal: options.signal,
      userId: options.userId,
    });
  };

  let candidates = await search(context.query, 'searching_competitors');
  let qualifiedCandidates: ContentQualifiedCompetitorCandidate[] = [];
  let finalSelection: CompetitorSelectionResult | null = null;
  const qualifyAndRank = async (): Promise<CompetitorSelectionResult> => {
    const pool = metadataPool(context, candidates);
    const previousEvidence = evidenceByUrl(qualifiedCandidates);
    const alreadyQualified = pool.flatMap(candidate => {
      const qualification = previousEvidence.get(candidate.canonicalUrl || candidate.url);
      return qualification ? [{ ...candidate, contentQualification: qualification }] : [];
    });
    const existingUrls = new Set(alreadyQualified.map(candidate => candidate.canonicalUrl || candidate.url));
    const pending = pool.filter(candidate => !existingUrls.has(candidate.canonicalUrl || candidate.url));
    let newlyQualifiedCount = 0;
    const newlyQualified = await qualifyCompetitorCandidates({
      candidates: pending,
      primaryKeyword,
      alternativeKeywords,
      signal: options.signal,
      maximumCandidates: COMPETITOR_CONTENT_QUALIFICATION_CANDIDATE_LIMIT,
      onProgress: async progress => {
        if (progress.qualification.status === 'qualified') newlyQualifiedCount += 1;
        await options.onProgress?.({
          stage: 'qualifying_competitor_content',
          query: context.query,
          current: alreadyQualified.length + progress.current,
          total: pool.length,
          qualifiedCount: alreadyQualified.filter(item => (
            item.contentQualification?.status === 'qualified'
          )).length + newlyQualifiedCount,
        });
      },
    });
    const byUrl = new Map<string, ContentQualifiedCompetitorCandidate>();
    [...alreadyQualified, ...newlyQualified].forEach(candidate => {
      byUrl.set(candidate.canonicalUrl || candidate.url, candidate);
    });
    qualifiedCandidates = pool.flatMap(candidate => {
      const qualified = byUrl.get(candidate.canonicalUrl || candidate.url);
      return qualified ? [qualified] : [];
    });
    const selection = analyzeAndSelectCompetitors({
      context,
      candidates: qualifiedCandidates,
      maxResults: options.maxResults ?? COMPETITOR_SEARCH_RESULT_LIMIT,
      maxSelected: options.maxSelected ?? MAX_ARTICLE_COMPETITORS,
    });
    selection.summary.candidateCount = candidates.length;
    return selection;
  };

  finalSelection = await qualifyAndRank();
  const alternativeSearchLimit = Math.max(0, Math.min(
    options.alternativeSearchLimit ?? COMPETITOR_ALTERNATIVE_SEARCH_LIMIT,
    COMPETITOR_ALTERNATIVE_SEARCH_LIMIT,
  ));
  const fallbackQueries = alternativeKeywords.slice(0, alternativeSearchLimit);
  for (const alternativeQuery of fallbackQueries) {
    if (finalSelection.summary.autoSelectedCount >= (options.maxSelected ?? MAX_ARTICLE_COMPETITORS)) break;
    try {
      const expanded = await search(alternativeQuery, 'expanding_competitor_search');
      candidates = mergeCandidates(candidates, expanded);
      finalSelection = await qualifyAndRank();
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      // Alternative-query expansion is best effort. The primary-query evidence remains usable.
    }
  }
  return finalSelection;
};
