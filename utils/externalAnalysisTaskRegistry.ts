export const EXTERNAL_ANALYSIS_DUPLICATE_ERROR_CODE = 'duplicate_task_suppressed';

const ACTIVE_STATUSES = new Set([
  'waiting_for_prerequisites',
  'queued',
  'running',
  'retry_scheduled',
  'paused',
]);

export type ExternalAnalysisTaskIdentityInput = {
  id: string;
  article_id: string;
  job_type: string;
  command_id?: string | null;
  readiness_signature?: string | null;
};

export type ExternalAnalysisTaskCandidate = ExternalAnalysisTaskIdentityInput & {
  status: string;
  result?: Record<string, unknown> | null;
  last_error_code?: string | null;
  attempt_count?: number;
  completed_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export const getExternalAnalysisTaskIdentity = (
  task: ExternalAnalysisTaskIdentityInput,
): string => {
  if (!['semantic_keywords_lsi', 'engineering_command', 'competitor_discovery'].includes(task.job_type)) {
    return `job:${task.id}`;
  }
  const signature = String(task.readiness_signature || '').trim();
  if (!signature) return `job:${task.id}`;
  if (task.job_type === 'engineering_command') {
    const commandId = String(task.command_id || '').trim();
    if (!commandId) return `job:${task.id}`;
    return `${task.article_id}:engineering_command:${commandId}:${signature}`;
  }
  if (task.job_type === 'competitor_discovery') {
    return `${task.article_id}:competitor_discovery:${signature}`;
  }
  return `${task.article_id}:semantic_keywords_lsi:${signature}`;
};

const taskTimestamp = (task: ExternalAnalysisTaskCandidate): number => {
  const value = task.completed_at || task.updated_at || task.created_at || '';
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const taskPreference = (task: ExternalAnalysisTaskCandidate): number => {
  const resultStatus = String(task.result?.status || '').trim();
  let score = 0;
  if (task.status === 'completed' && resultStatus !== 'superseded') score = 500;
  else if (ACTIVE_STATUSES.has(task.status)) score = 400;
  else if (task.status === 'completed') score = 350;
  else if (task.status === 'failed' || task.status === 'blocked') score = 300;
  else if (task.status === 'cancelled') score = 200;
  if (task.result && Object.keys(task.result).length > 0) score += 20;
  score += Math.min(10, Math.max(0, Number(task.attempt_count) || 0));
  return score;
};

export const deduplicateExternalAnalysisTasks = <T extends ExternalAnalysisTaskCandidate>(
  tasks: T[],
): T[] => {
  const canonicalByIdentity = new Map<string, { task: T; order: number }>();

  tasks.forEach((task, order) => {
    if (task.last_error_code === EXTERNAL_ANALYSIS_DUPLICATE_ERROR_CODE) return;
    const identity = getExternalAnalysisTaskIdentity(task);
    const current = canonicalByIdentity.get(identity);
    if (!current) {
      canonicalByIdentity.set(identity, { task, order });
      return;
    }

    const currentPreference = taskPreference(current.task);
    const candidatePreference = taskPreference(task);
    if (
      candidatePreference > currentPreference
      || (
        candidatePreference === currentPreference
        && taskTimestamp(task) > taskTimestamp(current.task)
      )
    ) {
      canonicalByIdentity.set(identity, { task, order: Math.min(order, current.order) });
    }
  });

  return Array.from(canonicalByIdentity.values())
    .sort((left, right) => left.order - right.order)
    .map(entry => entry.task);
};
