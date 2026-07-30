import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

export type ClientPageCrawlJob = {
  id: string;
  client_id: string;
  page_id: string;
  requested_by: string | null;
  request_reason: 'initial' | 'manual_refresh' | 'scheduled_refresh';
  status: 'queued' | 'running' | 'retry_scheduled' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  attempt_count: number;
  max_attempts: number;
  idempotency_key: string;
  next_attempt_at: string;
  locked_by: string | null;
  lease_expires_at: string | null;
  error_code: string | null;
  error_message: string | null;
  crawl_run_id: string | null;
  crawl_depth: number;
  created_at: string;
  updated_at: string;
};

export type ClientPageForCrawl = {
  id: string;
  client_id: string;
  input_url: string;
  is_enabled: boolean;
};

export type ClientDomainForCrawl = {
  hostname: string;
  include_subdomains: boolean;
};

const firstRow = <T>(value: unknown): T | null => {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  if (value && typeof value === 'object') return value as T;
  return null;
};

const callRpc = async <T>(
  functionName: string,
  parameters: Record<string, unknown>,
): Promise<T> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(functionName, parameters);
  if (error) {
    const detail = [error.message, error.details, error.hint].filter(Boolean).join(' | ');
    throw new Error(`Client page crawl RPC ${functionName} failed: ${detail}`);
  }
  return data as T;
};

export const claimNextClientPageCrawlJob = async (options: {
  workerId: string;
  leaseSeconds: number;
}): Promise<ClientPageCrawlJob | null> => {
  const value = await callRpc<unknown>('claim_next_client_page_crawl_job', {
    p_worker_id: options.workerId,
    p_lease_seconds: options.leaseSeconds,
  });
  return firstRow<ClientPageCrawlJob>(value);
};

export const heartbeatClientPageCrawlJob = async (options: {
  jobId: string;
  workerId: string;
  leaseSeconds: number;
}): Promise<boolean> => {
  const value = await callRpc<unknown>('heartbeat_client_page_crawl_job', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_lease_seconds: options.leaseSeconds,
  });
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return source.owned === true;
};

export const getClientPageCrawlInput = async (job: ClientPageCrawlJob): Promise<{
  page: ClientPageForCrawl;
  domains: ClientDomainForCrawl[];
  provider: string;
}> => {
  const supabase = getExternalAnalysisSupabaseAdmin();
  const [pageResult, domainResult, runResult] = await Promise.all([
    supabase.from('client_pages')
      .select('id,client_id,input_url,is_enabled')
      .eq('id', job.page_id)
      .eq('client_id', job.client_id)
      .maybeSingle(),
    supabase.from('client_domains')
      .select('hostname,include_subdomains')
      .eq('client_id', job.client_id)
      .eq('is_active', true),
    job.crawl_run_id
      ? supabase.from('client_site_crawl_runs')
        .select('provider')
        .eq('id', job.crawl_run_id)
        .eq('client_id', job.client_id)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (pageResult.error) throw pageResult.error;
  if (domainResult.error) throw domainResult.error;
  if (runResult.error) throw runResult.error;
  if (!pageResult.data) throw new Error('The page registered for this crawl job no longer exists.');
  return {
    page: pageResult.data as ClientPageForCrawl,
    domains: (domainResult.data || []) as ClientDomainForCrawl[],
    provider: typeof runResult.data?.provider === 'string'
      ? runResult.data.provider
      : 'local',
  };
};

export const completeClientPageCrawlJob = async (options: {
  jobId: string;
  workerId: string;
  page: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
}): Promise<boolean> => (
  callRpc<boolean>('complete_client_page_crawl_job', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_page: options.page,
    p_result_summary: options.resultSummary || {},
  })
);

export const failClientPageCrawlJob = async (options: {
  jobId: string;
  workerId: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  retryDelaySeconds: number;
}): Promise<ClientPageCrawlJob> => (
  callRpc<ClientPageCrawlJob>('fail_client_page_crawl_job', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_error_code: options.errorCode,
    p_error_message: options.errorMessage,
    p_retryable: options.retryable,
    p_retry_delay_seconds: options.retryDelaySeconds,
  })
);

export const recoverStaleClientPageCrawlJobs = async (
  retryDelaySeconds: number,
): Promise<number> => {
  const value = await callRpc<number>('recover_stale_client_page_crawl_jobs', {
    p_retry_delay_seconds: retryDelaySeconds,
  });
  return Number.isFinite(Number(value)) ? Number(value) : 0;
};
