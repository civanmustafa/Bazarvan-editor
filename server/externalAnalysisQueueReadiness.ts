import { COMPETITOR_QUEUE_STALL_MS } from '../constants/competitors.ts';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';
import { isFirecrawlConfigured } from './firecrawlCompetitorService.ts';

type ExternalAnalysisWorkerGroupId =
  | 'competitor'
  | 'ai'
  | 'fullArticlePipeline'
  | 'contentWritingPreparation';

const EXTERNAL_ANALYSIS_WORKER_GROUPS: Record<ExternalAnalysisWorkerGroupId, readonly string[]> = {
  competitor: ['competitor_discovery', 'competitor_extraction'],
  ai: [
    'semantic_keywords_lsi',
    'content_brief_generation',
    'meta_description_generation',
    'engineering_command',
  ],
  fullArticlePipeline: ['full_article_pipeline'],
  contentWritingPreparation: ['content_writing_preparation'],
};
const EXTERNAL_ANALYSIS_WORKER_GROUP_IDS = Object.keys(
  EXTERNAL_ANALYSIS_WORKER_GROUPS,
) as ExternalAnalysisWorkerGroupId[];
const MONITORED_EXTERNAL_ANALYSIS_JOB_TYPES = EXTERNAL_ANALYSIS_WORKER_GROUP_IDS
  .flatMap(groupId => [...EXTERNAL_ANALYSIS_WORKER_GROUPS[groupId]]);

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
    noStalledAiJobs: boolean;
    noStalledFullArticlePipelineJobs: boolean;
    noStalledContentWritingPreparationJobs: boolean;
  };
  workerGroups: Record<ExternalAnalysisWorkerGroupId, {
    ok: boolean;
    queuedCount: number;
    runningCount: number;
    stalledQueuedCount: number;
    expiredRunningCount: number;
  }>;
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

const createEmptyWorkerGroups = (): ExternalAnalysisQueueReadinessResult['workerGroups'] => ({
  competitor: {
    ok: false,
    queuedCount: 0,
    runningCount: 0,
    stalledQueuedCount: 0,
    expiredRunningCount: 0,
  },
  ai: {
    ok: false,
    queuedCount: 0,
    runningCount: 0,
    stalledQueuedCount: 0,
    expiredRunningCount: 0,
  },
  fullArticlePipeline: {
    ok: false,
    queuedCount: 0,
    runningCount: 0,
    stalledQueuedCount: 0,
    expiredRunningCount: 0,
  },
  contentWritingPreparation: {
    ok: false,
    queuedCount: 0,
    runningCount: 0,
    stalledQueuedCount: 0,
    expiredRunningCount: 0,
  },
});

const summarizeWorkerGroup = (
  rows: QueueJobRow[],
  jobTypes: readonly string[],
  now: number,
): ExternalAnalysisQueueReadinessResult['workerGroups'][ExternalAnalysisWorkerGroupId] => {
  const groupRows = rows.filter(row => jobTypes.includes(row.job_type || ''));
  const queuedRows = groupRows.filter(row => row.status === 'queued');
  const runningRows = groupRows.filter(row => row.status === 'running');
  const expiredRunningCount = runningRows.filter(row => {
    const leaseExpiresAt = timestamp(row.lease_expires_at);
    return !leaseExpiresAt || leaseExpiresAt <= now;
  }).length;
  const hasHealthyRunningJob = runningRows.length > expiredRunningCount;
  const stalledQueuedCount = hasHealthyRunningJob
    ? 0
    : queuedRows.filter(row => {
        const createdAt = timestamp(row.created_at);
        return createdAt > 0 && now - createdAt >= COMPETITOR_QUEUE_STALL_MS;
      }).length;

  return {
    ok: stalledQueuedCount === 0 && expiredRunningCount === 0,
    queuedCount: queuedRows.length,
    runningCount: runningRows.length,
    stalledQueuedCount,
    expiredRunningCount,
  };
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
    ?? await isFirecrawlConfigured().catch(() => false);
  const checks: ExternalAnalysisQueueReadinessResult['checks'] = {
    queueTable: false,
    firecrawlConfigured,
    noStalledCompetitorJobs: true,
    noStalledAiJobs: true,
    noStalledFullArticlePipelineJobs: true,
    noStalledContentWritingPreparationJobs: true,
  };
  const workerGroups = createEmptyWorkerGroups();
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
        .in('job_type', MONITORED_EXTERNAL_ANALYSIS_JOB_TYPES)
        .in('status', ['queued', 'running'])
        .order('created_at', { ascending: true })
        .limit(250),
      Math.max(500, Math.min(options.timeoutMs || 5_000, 15_000)),
    );
    if (result.error) {
      const code = result.error.code || 'unknown';
      const message = result.error.message || 'Unknown Supabase error.';
      throw new Error(`${code}: ${message}`);
    }
    checks.queueTable = true;
    const rows = result.data || [];
    EXTERNAL_ANALYSIS_WORKER_GROUP_IDS.forEach(groupId => {
      workerGroups[groupId] = summarizeWorkerGroup(
        rows,
        EXTERNAL_ANALYSIS_WORKER_GROUPS[groupId],
        now,
      );
    });
    queuedCount = EXTERNAL_ANALYSIS_WORKER_GROUP_IDS.reduce(
      (total, groupId) => total + workerGroups[groupId].queuedCount,
      0,
    );
    runningCount = EXTERNAL_ANALYSIS_WORKER_GROUP_IDS.reduce(
      (total, groupId) => total + workerGroups[groupId].runningCount,
      0,
    );
    stalledQueuedCount = EXTERNAL_ANALYSIS_WORKER_GROUP_IDS.reduce(
      (total, groupId) => total + workerGroups[groupId].stalledQueuedCount,
      0,
    );
    expiredRunningCount = EXTERNAL_ANALYSIS_WORKER_GROUP_IDS.reduce(
      (total, groupId) => total + workerGroups[groupId].expiredRunningCount,
      0,
    );
    checks.noStalledCompetitorJobs = workerGroups.competitor.ok;
    checks.noStalledAiJobs = workerGroups.ai.ok;
    checks.noStalledFullArticlePipelineJobs = workerGroups.fullArticlePipeline.ok;
    checks.noStalledContentWritingPreparationJobs = workerGroups.contentWritingPreparation.ok;
    const stalledGroupDetails = EXTERNAL_ANALYSIS_WORKER_GROUP_IDS.flatMap(groupId => {
      const group = workerGroups[groupId];
      if (group.ok) return [];
      return [`${groupId} worker queue stalled: queued=${group.stalledQueuedCount}, expired=${group.expiredRunningCount}`];
    });
    detail = stalledGroupDetails.join('; ');
  } catch (error) {
    checks.queueTable = false;
    checks.noStalledCompetitorJobs = false;
    checks.noStalledAiJobs = false;
    checks.noStalledFullArticlePipelineJobs = false;
    checks.noStalledContentWritingPreparationJobs = false;
    detail = error instanceof Error ? error.message : String(error);
  }

  if (!firecrawlConfigured) {
    detail = detail || 'No Firecrawl key is authorized in the encrypted dashboard vault for the external-analysis worker.';
  }
  const ok = Object.values(checks).every(Boolean);
  const result: ExternalAnalysisQueueReadinessResult = {
    ok,
    checkedAt: new Date(now).toISOString(),
    stallAfterSeconds: Math.round(COMPETITOR_QUEUE_STALL_MS / 1_000),
    checks,
    workerGroups,
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
  workerGroups: result.workerGroups,
  queuedCount: result.queuedCount,
  runningCount: result.runningCount,
  stalledQueuedCount: result.stalledQueuedCount,
  expiredRunningCount: result.expiredRunningCount,
  ...(result.code ? { code: result.code } : {}),
});

export const __resetExternalAnalysisQueueReadinessForTests = (): void => {
  cachedReadiness = null;
};
