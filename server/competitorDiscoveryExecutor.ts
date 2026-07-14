import {
  COMPETITOR_SEARCH_CANDIDATE_LIMIT,
  COMPETITOR_SEARCH_RESULT_LIMIT,
  MAX_ARTICLE_COMPETITORS,
} from '../constants/competitors.ts';
import {
  analyzeAndSelectCompetitors,
  extractCompetitorOwnDomains,
  resolveCompetitorCountryCode,
} from './competitorSelectionEngine.ts';
import {
  FirecrawlCompetitorError,
  searchCompetitorWeb,
} from './firecrawlCompetitorService.ts';
import {
  ExternalAnalysisRetryError,
  registerExternalAnalysisJobExecutor,
  type ExternalAnalysisExecutionContext,
} from './externalAnalysisExecutor.ts';

const FIRECRAWL_SEARCH_MODEL = 'v2/search';

const textValue = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const executeCompetitorDiscovery = async (
  context: ExternalAnalysisExecutionContext,
) => {
  const input = context.job.input_snapshot || {};
  const query = textValue(input.queryText);
  const queryType = input.queryType === 'primary_keyword' ? 'primary_keyword' : 'title';
  const articleLanguage = input.articleLanguage === 'en' ? 'en' : 'ar';
  const companyName = textValue(input.companyName);
  const targetCountry = textValue(input.targetCountry);

  if (!query) {
    return {
      result: {
        status: 'needs_input',
        reviewStatus: 'unavailable',
        results: [] as ReturnType<typeof analyzeAndSelectCompetitors>['results'],
        selection: null as ReturnType<typeof analyzeAndSelectCompetitors>['summary'] | null,
        query,
        queryType,
      },
      progress: { stage: 'needs_input', current: 0, total: 0 },
    };
  }

  await context.reportProgress({
    progress: {
      stage: 'searching_competitors',
      query,
      queryType,
      current: 0,
      total: COMPETITOR_SEARCH_CANDIDATE_LIMIT,
    },
    provider: 'firecrawl',
    model: FIRECRAWL_SEARCH_MODEL,
  });

  try {
    const candidates = await searchCompetitorWeb({
      query,
      limit: COMPETITOR_SEARCH_CANDIDATE_LIMIT,
      country: resolveCompetitorCountryCode(targetCountry),
      location: targetCountry,
      excludeDomains: extractCompetitorOwnDomains(companyName),
      signal: context.signal,
    });
    const selection = analyzeAndSelectCompetitors({
      context: {
        query,
        queryType,
        articleTitle: textValue(input.articleTitle),
        primaryKeyword: textValue(input.primaryKeyword),
        language: articleLanguage,
        pageType: textValue(input.pageType),
        searchIntent: textValue(input.searchIntent),
        audienceScope: textValue(input.audienceScope),
        targetCountry,
        companyName,
        ownDomains: extractCompetitorOwnDomains(companyName),
      },
      candidates,
      maxResults: COMPETITOR_SEARCH_RESULT_LIMIT,
      maxSelected: MAX_ARTICLE_COMPETITORS,
    });
    const reviewStatus = selection.results.length > 0 ? 'awaiting_review' : 'no_results';

    await context.reportProgress({
      progress: {
        stage: reviewStatus,
        current: selection.results.length,
        total: candidates.length,
        autoSelectedCount: selection.summary.autoSelectedCount,
      },
      provider: 'firecrawl',
      model: FIRECRAWL_SEARCH_MODEL,
    });

    return {
      result: {
        status: reviewStatus,
        reviewStatus,
        query,
        queryType,
        results: selection.results,
        selection: selection.summary,
        discoveredAt: new Date().toISOString(),
      },
      progress: {
        stage: reviewStatus,
        current: selection.results.length,
        total: candidates.length,
        autoSelectedCount: selection.summary.autoSelectedCount,
      },
    };
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason ?? error;
    const normalized = error instanceof FirecrawlCompetitorError
      ? error
      : new FirecrawlCompetitorError({
          message: error instanceof Error ? error.message : 'Competitor discovery failed.',
          status: 502,
          code: 'competitor_discovery_failed',
          retryable: true,
        });
    if (!normalized.retryable) {
      return {
        result: {
          status: 'unavailable',
          reviewStatus: 'unavailable',
          query,
          queryType,
          results: [] as ReturnType<typeof analyzeAndSelectCompetitors>['results'],
          selection: null as ReturnType<typeof analyzeAndSelectCompetitors>['summary'] | null,
          errorCode: normalized.code,
          errorMessage: normalized.message,
        },
        progress: {
          stage: 'unavailable',
          errorCode: normalized.code,
        },
      };
    }
    throw new ExternalAnalysisRetryError({
      code: normalized.code,
      message: normalized.message,
      progress: {
        stage: 'retry_scheduled',
        query,
        queryType,
        provider: 'firecrawl',
      },
    });
  }
};

registerExternalAnalysisJobExecutor('competitor_discovery', executeCompetitorDiscovery);
