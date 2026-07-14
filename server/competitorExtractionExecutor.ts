import {
  FirecrawlCompetitorError,
} from './firecrawlCompetitorService';
import { COMPETITOR_EXTRACTION_MAX_ATTEMPTS } from '../constants/competitors';
import { getCompetitorPreview } from './competitorPreviewCache';
import {
  ExternalAnalysisRetryError,
  registerExternalAnalysisJobExecutor,
  type ExternalAnalysisExecutionContext,
} from './externalAnalysisExecutor';
import {
  getExternalAnalysisSupabaseAdmin,
  type ExternalAnalysisJson,
} from './externalAnalysisQueue';

type CompetitorRow = {
  id: string;
  article_id: string;
  position: number;
  canonical_url: string;
  source_url: string;
  title: string;
  status: 'queued' | 'extracting' | 'retry_scheduled' | 'completed' | 'failed' | 'cancelled';
  error_code: string | null;
  error_message: string | null;
};

type CompetitorFailure = {
  position: number;
  code: string;
  message: string;
  retryable: boolean;
  attempt: number;
};

const FIRECRAWL_MODEL = 'v2/scrape';

const getFirecrawlKeySuffix = (): string => (
  String(process.env.FIRECRAWL_API_KEY || '').trim().slice(-6)
);

const readCompetitors = async (articleId: string): Promise<CompetitorRow[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_competitors')
    .select('id,article_id,position,canonical_url,source_url,title,status,error_code,error_message')
    .eq('article_id', articleId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data || []) as CompetitorRow[];
};

const updateCompetitor = async (
  competitorId: string,
  values: Record<string, unknown>,
  allowedStatuses?: CompetitorRow['status'][],
): Promise<void> => {
  let query = getExternalAnalysisSupabaseAdmin()
    .from('article_competitors')
    .update(values)
    .eq('id', competitorId);
  if (allowedStatuses?.length) query = query.in('status', allowedStatuses);
  const { error } = await query;
  if (error) throw error;
};

const syncArticleCompetitors = async (articleId: string): Promise<void> => {
  const { error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'sync_article_competitors_metadata',
    { p_article_id: articleId },
  );
  if (error) throw error;
};

const executeCompetitorExtraction = async (
  context: ExternalAnalysisExecutionContext,
) => {
  const rows = await readCompetitors(context.job.article_id);
  if (rows.length === 0) {
    return {
      result: {
        status: 'completed',
        successfulCount: 0,
        failedCount: 0,
        competitors: [] as ExternalAnalysisJson[],
      },
      progress: { stage: 'completed', current: 0, total: 0 },
    };
  }

  const attempts: ExternalAnalysisJson[] = [];
  const failures: CompetitorFailure[] = [];
  const currentAttempt = Math.max(1, Number(context.job.attempt_count) || 1);
  let successfulCount = rows.filter(row => row.status === 'completed').length;

  for (const row of rows) {
    if (context.signal.aborted) throw context.signal.reason ?? new Error('Competitor extraction was cancelled.');
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') continue;

    await context.reportProgress({
      progress: {
        stage: 'extracting_competitor',
        current: row.position,
        total: rows.length,
        competitorId: row.id,
        title: row.title,
        url: row.canonical_url,
        successfulCount,
        failedCount: failures.length,
      },
      provider: 'firecrawl',
      model: FIRECRAWL_MODEL,
      keyAttempts: attempts,
    });
    await updateCompetitor(row.id, {
      status: 'extracting',
      extraction_provider: 'firecrawl',
      error_code: null,
      error_message: null,
    }, ['queued', 'retry_scheduled', 'extracting']);

    try {
      const content = await getCompetitorPreview({
        url: row.canonical_url || row.source_url,
        signal: context.signal,
      });
      attempts.push({
        requestIndex: row.position,
        outcome: 'success',
        model: FIRECRAWL_MODEL,
        keySuffix: content.providerKeySuffix,
        status: 200,
        reason: content.cacheHit ? 'preview_cache_hit' : '',
        cacheHit: content.cacheHit,
        attempt: context.job.attempt_count,
      });
      await updateCompetitor(row.id, {
        source_url: content.url,
        canonical_url: content.canonicalUrl,
        domain: content.domain,
        title: content.title,
        description: content.description,
        headings: content.headings,
        content_text: content.text,
        word_count: content.wordCount,
        status: 'completed',
        extraction_provider: content.cacheHit ? 'firecrawl_cache' : 'firecrawl',
        error_code: null,
        error_message: null,
        fetched_at: new Date().toISOString(),
      }, ['queued', 'extracting', 'retry_scheduled']);
      successfulCount += 1;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      const normalized = error instanceof FirecrawlCompetitorError
        ? error
        : new FirecrawlCompetitorError({
            message: error instanceof Error ? error.message : 'Unknown competitor extraction error.',
            status: 502,
            code: 'competitor_extraction_failed',
            retryable: true,
          });
      const retryExhausted = normalized.retryable
        && currentAttempt >= COMPETITOR_EXTRACTION_MAX_ATTEMPTS;
      const shouldRetry = normalized.retryable && !retryExhausted;
      const failureCode = retryExhausted
        ? `${normalized.code}_retry_exhausted`
        : normalized.code;
      const failureMessage = retryExhausted
        ? `Stopped after ${COMPETITOR_EXTRACTION_MAX_ATTEMPTS} attempts. ${normalized.message}`
        : normalized.message;
      failures.push({
        position: row.position,
        code: failureCode,
        message: failureMessage,
        retryable: shouldRetry,
        attempt: currentAttempt,
      });
      attempts.push({
        requestIndex: row.position,
        outcome: 'failed',
        model: FIRECRAWL_MODEL,
        keySuffix: getFirecrawlKeySuffix(),
        status: normalized.status,
        reason: failureCode,
        attempt: currentAttempt,
      });
      await updateCompetitor(row.id, {
        status: shouldRetry ? 'retry_scheduled' : 'failed',
        extraction_provider: 'firecrawl',
        error_code: failureCode,
        error_message: failureMessage.slice(0, 2_000),
      }, ['queued', 'extracting', 'retry_scheduled']);
    }

    await context.reportProgress({
      progress: {
        stage: 'competitor_processed',
        current: row.position,
        total: rows.length,
        successfulCount,
        failedCount: failures.length,
      },
      provider: 'firecrawl',
      model: FIRECRAWL_MODEL,
      keyAttempts: attempts,
    });
  }

  // Make every completed source available to the article before a failed URL is retried.
  await syncArticleCompetitors(context.job.article_id);
  const finalRows = await readCompetitors(context.job.article_id);
  successfulCount = finalRows.filter(row => row.status === 'completed').length;
  const persistedFailures: CompetitorFailure[] = finalRows
    .filter(row => row.status === 'failed')
    .map(row => ({
      position: row.position,
      code: row.error_code || 'competitor_extraction_failed',
      message: row.error_message || 'Competitor extraction failed.',
      retryable: false,
      attempt: currentAttempt,
    }));
  const retryableFailures = failures.filter(failure => failure.retryable);
  if (retryableFailures.length > 0) {
    const first = retryableFailures[0];
    throw new ExternalAnalysisRetryError({
      code: first.code,
      message: `${retryableFailures.length} competitor page(s) will be retried: ${first.message}`,
      progress: {
        stage: 'retry_scheduled',
        current: rows.length,
        total: rows.length,
        successfulCount,
        failedCount: persistedFailures.length,
        retryingCount: retryableFailures.length,
        attempt: currentAttempt,
        maxAttempts: COMPETITOR_EXTRACTION_MAX_ATTEMPTS,
        failures: [...persistedFailures, ...retryableFailures],
      },
    });
  }

  return {
    result: {
      status: persistedFailures.length > 0 ? 'partial' : 'completed',
      successfulCount,
      failedCount: persistedFailures.length,
      failures: persistedFailures,
      competitors: finalRows.map(row => ({
        id: row.id,
        position: row.position,
        title: row.title,
        url: row.canonical_url,
        status: row.status,
      })),
    },
    progress: {
      stage: persistedFailures.length > 0 ? 'completed_with_failures' : 'completed',
      current: rows.length,
      total: rows.length,
      successfulCount,
      failedCount: persistedFailures.length,
      maxAttempts: COMPETITOR_EXTRACTION_MAX_ATTEMPTS,
    },
  };
};

registerExternalAnalysisJobExecutor('competitor_extraction', executeCompetitorExtraction);
