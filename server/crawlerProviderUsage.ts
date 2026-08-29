import type {
  ClientSiteCrawlProvider,
  CrawlerExternalProvider,
} from '../constants/crawlerProviders.ts';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';
import type { CrawlerCredentialSource } from './crawlerProviderSecrets.ts';

export type RecordedCrawlerCredentialSource = CrawlerCredentialSource | 'hostinger';

export type CrawlerAttemptProvider = 'local' | CrawlerExternalProvider;
export type CrawlerProviderAttemptStatus = 'completed' | 'failed';

export type CrawlerProviderAttemptTelemetry = {
  requestedProvider: ClientSiteCrawlProvider;
  provider: CrawlerAttemptProvider;
  credentialSource: CrawlerCredentialSource | null;
  keySuffix: string | null;
  status: CrawlerProviderAttemptStatus;
  targetUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  durationMs: number;
  wordCount: number | null;
  internalLinkCount: number | null;
  responseContentType: string | null;
  fallbackReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean | null;
  startedAt: string;
  completedAt: string;
};

type CrawlerProviderUsageEventRow = {
  id: string;
  crawl_job_id: string | null;
  crawl_run_id: string | null;
  client_id: string;
  page_id: string | null;
  requested_by: string | null;
  job_attempt: number;
  requested_provider: ClientSiteCrawlProvider;
  provider: CrawlerAttemptProvider;
  credential_source: RecordedCrawlerCredentialSource | null;
  key_suffix: string | null;
  status: CrawlerProviderAttemptStatus;
  target_url: string;
  final_url: string | null;
  http_status: number | null;
  duration_ms: number;
  word_count: number | null;
  internal_link_count: number | null;
  response_content_type: string | null;
  fallback_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: boolean | null;
  started_at: string;
  completed_at: string;
  created_at: string;
};

export type CrawlerProviderUsageReportEvent = {
  id: string;
  crawlJobId: string | null;
  crawlRunId: string | null;
  clientId: string;
  clientName: string;
  pageId: string | null;
  pageTitle: string;
  requestedBy: string | null;
  requestedByName: string;
  jobAttempt: number;
  requestedProvider: ClientSiteCrawlProvider;
  provider: CrawlerAttemptProvider;
  credentialSource: RecordedCrawlerCredentialSource | null;
  keySuffix: string | null;
  status: CrawlerProviderAttemptStatus;
  targetUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  durationMs: number;
  wordCount: number | null;
  internalLinkCount: number | null;
  responseContentType: string | null;
  fallbackReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean | null;
  startedAt: string;
  completedAt: string;
  createdAt: string;
};

const TABLE_NAME = 'crawler_provider_usage_events';

const isMissingTableError = (
  error: { code?: string } | null | undefined,
): boolean => error?.code === '42P01' || error?.code === 'PGRST205';

const boundedText = (value: unknown, maximum: number): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maximum) : null;
};

export const recordCrawlerProviderUsageEvent = async (options: {
  crawlJobId: string;
  crawlRunId: string | null;
  clientId: string;
  pageId: string;
  requestedBy: string | null;
  jobAttempt: number;
  attempt: CrawlerProviderAttemptTelemetry;
}): Promise<boolean> => {
  const attempt = options.attempt;
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .insert({
      crawl_job_id: options.crawlJobId,
      crawl_run_id: options.crawlRunId,
      client_id: options.clientId,
      page_id: options.pageId,
      requested_by: options.requestedBy,
      job_attempt: Math.max(1, Math.min(1_000, Math.round(options.jobAttempt || 1))),
      requested_provider: attempt.requestedProvider,
      provider: attempt.provider,
      credential_source: attempt.credentialSource,
      key_suffix: boundedText(attempt.keySuffix, 8),
      status: attempt.status,
      target_url: attempt.targetUrl.slice(0, 2_048),
      final_url: boundedText(attempt.finalUrl, 2_048),
      http_status: attempt.httpStatus,
      duration_ms: Math.max(0, Math.min(3_600_000, Math.round(attempt.durationMs || 0))),
      word_count: attempt.wordCount,
      internal_link_count: attempt.internalLinkCount,
      response_content_type: boundedText(attempt.responseContentType, 300),
      fallback_reason: boundedText(attempt.fallbackReason, 160),
      error_code: boundedText(attempt.errorCode, 160),
      error_message: boundedText(attempt.errorMessage, 2_000),
      retryable: attempt.retryable,
      started_at: attempt.startedAt,
      completed_at: attempt.completedAt,
    });
  if (isMissingTableError(error)) return false;
  if (error) {
    throw new Error(
      `Could not record crawler provider usage (${error.code || 'unknown'}).`,
    );
  }
  return true;
};

const uniqueIds = (values: Array<string | null>): string[] => (
  [...new Set(values.filter((value): value is string => Boolean(value)))]
);

const displayProfile = (
  row: { email?: unknown; full_name?: unknown } | undefined,
): string => (
  boundedText(row?.full_name, 300)
  || boundedText(row?.email, 300)
  || ''
);

export const listCrawlerProviderUsageEvents = async (options: {
  from: string;
  to: string;
  limit?: number;
}): Promise<{
  schemaAvailable: boolean;
  events: CrawlerProviderUsageReportEvent[];
}> => {
  const limit = Math.max(1, Math.min(options.limit || 1_000, 2_000));
  const client = getExternalAnalysisSupabaseAdmin();
  const { data, error } = await client
    .from(TABLE_NAME)
    .select('*')
    .gte('created_at', options.from)
    .lte('created_at', options.to)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (isMissingTableError(error)) return { schemaAvailable: false, events: [] };
  if (error) {
    throw new Error(
      `Could not load crawler provider usage (${error.code || 'unknown'}).`,
    );
  }

  const rows = (data || []) as CrawlerProviderUsageEventRow[];
  const clientIds = uniqueIds(rows.map(row => row.client_id));
  const pageIds = uniqueIds(rows.map(row => row.page_id));
  const profileIds = uniqueIds(rows.map(row => row.requested_by));
  const [clientsResult, pagesResult, profilesResult] = await Promise.all([
    clientIds.length > 0
      ? client.from('clients').select('id,name').in('id', clientIds)
      : Promise.resolve({ data: [], error: null }),
    pageIds.length > 0
      ? client.from('client_pages').select('id,page_title,input_url').in('id', pageIds)
      : Promise.resolve({ data: [], error: null }),
    profileIds.length > 0
      ? client.from('profiles').select('id,email,full_name').in('id', profileIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [clientsResult, pagesResult, profilesResult]) {
    if (result.error) {
      throw new Error(
        `Could not enrich crawler provider usage (${result.error.code || 'unknown'}).`,
      );
    }
  }

  const clients = new Map(
    (clientsResult.data || []).map(row => [
      String(row.id),
      boundedText(row.name, 300) || String(row.id),
    ]),
  );
  const pages = new Map(
    (pagesResult.data || []).map(row => [
      String(row.id),
      boundedText(row.page_title, 500)
        || boundedText(row.input_url, 2_048)
        || String(row.id),
    ]),
  );
  const profiles = new Map(
    (profilesResult.data || []).map(row => [
      String(row.id),
      displayProfile(row),
    ]),
  );

  return {
    schemaAvailable: true,
    events: rows.map(row => ({
      id: row.id,
      crawlJobId: row.crawl_job_id,
      crawlRunId: row.crawl_run_id,
      clientId: row.client_id,
      clientName: clients.get(row.client_id) || row.client_id,
      pageId: row.page_id,
      pageTitle: row.page_id ? pages.get(row.page_id) || row.target_url : row.target_url,
      requestedBy: row.requested_by,
      requestedByName: row.requested_by
        ? profiles.get(row.requested_by) || row.requested_by
        : '',
      jobAttempt: row.job_attempt,
      requestedProvider: row.requested_provider,
      provider: row.provider,
      credentialSource: row.credential_source,
      keySuffix: row.key_suffix,
      status: row.status,
      targetUrl: row.target_url,
      finalUrl: row.final_url,
      httpStatus: row.http_status,
      durationMs: row.duration_ms,
      wordCount: row.word_count,
      internalLinkCount: row.internal_link_count,
      responseContentType: row.response_content_type,
      fallbackReason: row.fallback_reason,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      retryable: row.retryable,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    })),
  };
};
