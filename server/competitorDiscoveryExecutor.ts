import {
  COMPETITOR_SEARCH_CANDIDATE_LIMIT,
  COMPETITOR_SEARCH_RESULT_LIMIT,
  MAX_ARTICLE_COMPETITORS,
} from '../constants/competitors.ts';
import {
  extractCompetitorOwnDomains,
  resolveCompetitorCountryCode,
  type CompetitorSelectionResult,
} from './competitorSelectionEngine.ts';
import { FirecrawlCompetitorError } from './firecrawlCompetitorService.ts';
import { discoverAndSelectCompetitors } from './competitorDiscoveryService.ts';
import {
  ExternalAnalysisRetryError,
  registerExternalAnalysisJobExecutor,
  type ExternalAnalysisExecutionContext,
} from './externalAnalysisExecutor.ts';
import {
  getExternalAnalysisSupabaseAdmin,
} from './externalAnalysisQueue.ts';
import { loadArticleClientOwnDomains } from './clientCompetitorExclusions.ts';
import { assertAutomaticCompetitorResearchAllowed } from './contentResearchAutomationGuard.ts';

/**
 * Architecture boundary:
 * Firecrawl Search discovers candidate URLs, then the deterministic selection engine
 * filters and ranks them. This discovery path does not call Gemini or OpenAI.
 */
const FIRECRAWL_SEARCH_MODEL = 'v2/search';

const textValue = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const textList = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(textValue).filter(Boolean).slice(0, 12)
    : []
);

const readArticleAlternativeKeywords = async (articleId: string): Promise<string[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('articles')
    .select('keywords')
    .eq('id', articleId)
    .single();
  if (error) throw error;
  const keywords = data?.keywords && typeof data.keywords === 'object' && !Array.isArray(data.keywords)
    ? data.keywords as Record<string, unknown>
    : {};
  return textList(keywords.secondaries);
};

const executeCompetitorDiscovery = async (
  context: ExternalAnalysisExecutionContext,
) => {
  await assertAutomaticCompetitorResearchAllowed(context.job);
  const input = context.job.input_snapshot || {};
  const query = textValue(input.queryText);
  const queryType = input.queryType === 'primary_keyword' ? 'primary_keyword' : 'title';
  const articleLanguage = input.articleLanguage === 'en' ? 'en' : 'ar';
  const companyName = textValue(input.companyName);
  const targetCountry = textValue(input.targetCountry);
  const alternativeKeywords = textList(input.alternativeKeywords);
  const persistedAlternativeKeywords = await readArticleAlternativeKeywords(context.job.article_id);
  const resolvedAlternativeKeywords = alternativeKeywords.length > 0
    ? alternativeKeywords
    : persistedAlternativeKeywords;

  if (!query) {
    return {
      result: {
        status: 'needs_input',
        reviewStatus: 'unavailable',
        results: [] as CompetitorSelectionResult['results'],
        selection: null as CompetitorSelectionResult['summary'] | null,
        query,
        queryType,
      },
      progress: { stage: 'needs_input', current: 0, total: 0 },
    };
  }
  const ownDomains = extractCompetitorOwnDomains(
    companyName,
    ...(await loadArticleClientOwnDomains(
      getExternalAnalysisSupabaseAdmin(),
      context.job.article_id,
      companyName,
    )),
  );

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
    const selection = await discoverAndSelectCompetitors({
      context: {
        query,
        queryType,
        articleTitle: textValue(input.articleTitle),
        primaryKeyword: textValue(input.primaryKeyword),
        alternativeKeywords: resolvedAlternativeKeywords,
        language: articleLanguage,
        pageType: textValue(input.pageType),
        searchIntent: textValue(input.searchIntent),
        audienceScope: textValue(input.audienceScope),
        targetCountry,
        companyName,
        ownDomains,
      },
      country: resolveCompetitorCountryCode(targetCountry),
      location: targetCountry,
      excludeDomains: ownDomains,
      signal: context.signal,
      userId: context.job.requested_by,
      maxResults: COMPETITOR_SEARCH_RESULT_LIMIT,
      maxSelected: MAX_ARTICLE_COMPETITORS,
      onProgress: async progress => {
        await context.reportProgress({
          progress: {
            ...progress,
            queryType,
            alternativeKeywordCount: resolvedAlternativeKeywords.length,
          },
          provider: progress.stage === 'qualifying_competitor_content' ? 'programmatic' : 'firecrawl',
          model: progress.stage === 'qualifying_competitor_content'
            ? 'deterministic-keyword-targeting'
            : FIRECRAWL_SEARCH_MODEL,
        });
      },
    });
    const reviewStatus = selection.results.length > 0 ? 'awaiting_review' : 'no_results';

    await context.reportProgress({
      progress: {
        stage: reviewStatus,
        current: selection.results.length,
        total: selection.summary.candidateCount,
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
        total: selection.summary.candidateCount,
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
          results: [] as CompetitorSelectionResult['results'],
          selection: null as CompetitorSelectionResult['summary'] | null,
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
