export type DuplicateCleanupDashboardJob = {
  status: string;
  created_at: string;
  input_snapshot?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  progress?: Record<string, unknown>;
};

export type DuplicateCleanupDashboardSummary = {
  state: 'not_started' | 'queued' | 'running' | 'partial' | 'completed' | 'failed';
  completedCount: number;
  totalCount: number;
};

export function summarizeDuplicateCleanupJobs(
  jobs: DuplicateCleanupDashboardJob[],
): DuplicateCleanupDashboardSummary {
  const latestByCategory = new Map<number, DuplicateCleanupDashboardJob>();
  for (const job of jobs) {
    const category = Number(job.input_snapshot?.category);
    if (!Number.isInteger(category) || category < 2 || category > 8) continue;
    const current = latestByCategory.get(category);
    if (!current || job.created_at > current.created_at) latestByCategory.set(category, job);
  }

  const latest = [...latestByCategory.values()];
  const totalCount = latest.length;
  const completedCount = latest.filter(job => job.status === 'completed' && job.result?.status !== 'partial').length;
  const hasPartialResult = latest.some(job => {
    if (job.result?.status === 'partial') return true;
    const cleanup = job.progress?.cleanup;
    if (!cleanup || typeof cleanup !== 'object') return false;
    const checkpoint = cleanup as { decisions?: unknown[]; patches?: unknown[] };
    return Boolean(checkpoint.decisions?.length || checkpoint.patches?.length);
  });
  if (!totalCount) return { state: 'not_started', completedCount, totalCount };
  if (completedCount === totalCount) return { state: 'completed', completedCount, totalCount };
  if (latest.some(job => job.status === 'running')) return { state: 'running', completedCount, totalCount };
  if (latest.some(job => ['queued', 'waiting_for_prerequisites', 'retry_scheduled', 'paused'].includes(job.status))) {
    return { state: completedCount || hasPartialResult ? 'partial' : 'queued', completedCount, totalCount };
  }
  return { state: completedCount || hasPartialResult ? 'partial' : 'failed', completedCount, totalCount };
}
