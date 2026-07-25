import { COMPETITOR_QUEUE_STALL_MS } from '../constants/competitors.ts';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';

const WORKER_COMPETITOR_JOB_TYPES = ['competitor_discovery', 'competitor_extraction'];

type QueueJobRow = {
  job_type?: string | null;
  status?: string | null;
  created_at?: string | null;
  lease_expires_at?: string | null;
};

type ProbeResult = {
  data?: QueueJobRow[] | null;
  error?: {
    code?: string;
    message?: string;
  } | null;
};

export type ExternalAnalysisQueueReadinessClient = {
  from: (table: string) => {
    select: (columns: string) => {
      in: (column: string, values: string[]) => {
        in: (column: string, values: string[]) => {
          order: (column: string, options: { ascending: boolean }) => {
            limit: (count: number) => PromiseLike<ProbeResult>;
          };
        };
      };
    };
  };
};

export type ExternalAnalysisQueueReadinessResult = {
  ok: boolean;
  checkedAt: string;
  stallAfterSeconds: number;
  checks: {
    queueTable: boolean;
    firecrawlConfigured: boolean;
    noStalledCompetitorJobs: boolean;
  };
  queuedCount: number;
  runningCount: number;
  stalledQueuedCount: number;
  expiredRunningCount: number;
  code?: 'external_analysis_worker_unavailable';
  detail?: string;
};

type CachedReadiness = {
  expiresAt: number;
  result: ExternalAnalysisQueueReadinessResult;
};

let cachedReadiness: CachedReadiness | null = null;

const timestamp = (value: unknown): number => {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const withTimeout = async <T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('External analysis queue readiness probe timed out.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const checkExternalAnalysisQueueReadiness = async (options: {
  client?: ExternalAnalysisQueueReadinessClient;
  now?: number;
  timeoutMs?: number;
  force?: boolean;
  firecrawlConfigured?: boolean;
} = {}): Promise<ExternalAnalysisQueueReadinessResult> => {
  const now = options.now ?? Date.now();
  if (!options.force && cachedReadiness && cachedReadiness.expiresAt > now) {
    return cachedReadiness.result;
  }

  const firecrawlConfigured = options.firecrawlConfigured
    ?? Boolean(process.env.FIRECRAWL_API_KEY?.trim());
  const checks: ExternalAnalysisQueueReadinessResult['checks'] = {
    queueTable: false,
    firecrawlConfigured,
    noStalledCompetitorJobs: true,
  };
  let queuedCount = 0;
  let runningCount = 0;
  let stalledQueuedCount = 0;
  let expiredRunningCount = 0;
  let detail = '';

  try {
    const client = options.client
      || getExternalAnalysisSupabaseAdmin() as unknown as ExternalAnalysisQueueReadinessClient;
    const result = await withTimeout(
      client
        .from('ai_external_analysis_jobs')
        .select('job_type,status,created_at,lease_expires_at')
        .in('job_type', WORKER_COMPETITOR_JOB_TYPES)
        .in('status', ['queued', 'running'])
        .order('created_at', { ascending: true })
        .limit(50),
      Math.max(500, Math.min(options.timeoutMs || 5_000, 15_000)),
    );
    if (result.error) {
      const code = result.error.code || 'unknown';
      const message = result.error.message || 'Unknown Supabase error.';
      throw new Error(`${code}: ${message}`);
    }
    checks.queueTable = true;
    const rows = result.data || [];
    const queuedRows = rows.filter(row => row.status === 'queued');
    const runningRows = rows.filter(row => row.status === 'running');
    queuedCount = queuedRows.length;
    runningCount = runningRows.length;
    expiredRunningCount = runningRows.filter(row => {
      const leaseExpiresAt = timestamp(row.lease_expires_at);
      return !leaseExpiresAt || leaseExpiresAt <= now;
    }).length;
    const hasHealthyRunningJob = runningCount > expiredRunningCount;
    stalledQueuedCount = hasHealthyRunningJob
      ? 0
      : queuedRows.filter(row => {
        const createdAt = timestamp(row.created_at);
        return createdAt > 0 && now - createdAt >= COMPETITOR_QUEUE_STALL_MS;
      }).length;
    checks.noStalledCompetitorJobs = stalledQueuedCount === 0 && expiredRunningCount === 0;
    if (!checks.noStalledCompetitorJobs) {
      detail = `competitor worker queue stalled: queued=${stalledQueuedCount}, expired=${expiredRunningCount}`;
    }
  } catch (error) {
    checks.queueTable = false;
    checks.noStalledCompetitorJobs = false;
    detail = error instanceof Error ? error.message : String(error);
  }

  if (!firecrawlConfigured) {
    detail = detail || 'FIRECRAWL_API_KEY is not configured.';
  }
  const ok = Object.values(checks).every(Boolean);
  const result: ExternalAnalysisQueueReadinessResult = {
    ok,
    checkedAt: new Date(now).toISOString(),
    stallAfterSeconds: Math.round(COMPETITOR_QUEUE_STALL_MS / 1_000),
    checks,
    queuedCount,
    runningCount,
    stalledQueuedCount,
    expiredRunningCount,
    ...(!ok ? {
      code: 'external_analysis_worker_unavailable' as const,
      detail: detail.slice(0, 1_000),
    } : {}),
  };
  cachedReadiness = {
    expiresAt: now + (ok ? 10_000 : 5_000),
    result,
  };
  return result;
};

export const toPublicExternalAnalysisQueueReadiness = (
  result: ExternalAnalysisQueueReadinessResult,
): Omit<ExternalAnalysisQueueReadinessResult, 'detail'> => ({
  ok: result.ok,
  checkedAt: result.checkedAt,
  stallAfterSeconds: result.stallAfterSeconds,
  checks: result.checks,
  queuedCount: result.queuedCount,
  runningCount: result.runningCount,
  stalledQueuedCount: result.stalledQueuedCount,
  expiredRunningCount: result.expiredRunningCount,
  ...(result.code ? { code: result.code } : {}),
});

export const __resetExternalAnalysisQueueReadinessForTests = (): void => {
  cachedReadiness = null;
};
