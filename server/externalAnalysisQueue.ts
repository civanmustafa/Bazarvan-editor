import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type ExternalAnalysisJobType = 'semantic_keywords_lsi' | 'engineering_command';

export type ExternalAnalysisJobStatus =
  | 'waiting_for_prerequisites'
  | 'queued'
  | 'running'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'paused';

export type ExternalAnalysisJson = Record<string, unknown>;

export interface ExternalAnalysisJob {
  id: string;
  article_id: string;
  requested_by: string | null;
  job_type: ExternalAnalysisJobType;
  origin: 'auto' | 'manual';
  status: ExternalAnalysisJobStatus;
  idempotency_key: string;
  batch_key: string | null;
  sequence_number: number;
  command_id: string | null;
  command_label: string | null;
  depends_on_job_id: string | null;
  readiness_signature: string | null;
  input_snapshot: ExternalAnalysisJson;
  result: ExternalAnalysisJson | null;
  progress: ExternalAnalysisJson;
  last_error: string | null;
  last_error_code: string | null;
  attempt_count: number;
  retry_count: number;
  next_attempt_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  lease_expires_at: string | null;
  cancel_requested_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ExternalAnalysisHeartbeat = {
  owned: boolean;
  cancelRequested: boolean;
  status: string;
  errorCode: string;
  errorMessage: string;
};

let queueClient: SupabaseClient | null = null;

const getRequiredEnv = (name: string, fallbacks: string[] = []): string => {
  const candidates = [name, ...fallbacks];
  for (const candidate of candidates) {
    const value = process.env[candidate]?.trim();
    if (value) return value;
  }

  throw new Error(`Missing required external analysis worker environment variable: ${name}`);
};

export const getExternalAnalysisSupabaseAdmin = (): SupabaseClient => {
  if (queueClient) return queueClient;

  const supabaseUrl = getRequiredEnv('SUPABASE_URL', ['VITE_SUPABASE_URL']);
  const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

  queueClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        'X-Client-Info': 'bazarvan-external-analysis-worker',
      },
    },
  });

  return queueClient;
};

const callQueueRpc = async <T>(
  functionName: string,
  parameters: ExternalAnalysisJson,
): Promise<T> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(functionName, parameters);
  if (error) {
    const details = [error.message, error.details, error.hint]
      .filter(Boolean)
      .join(' | ');
    throw new Error(`External analysis queue RPC ${functionName} failed: ${details}`);
  }

  return data as T;
};

const firstJob = (value: unknown): ExternalAnalysisJob | null => {
  if (Array.isArray(value)) {
    return (value[0] as ExternalAnalysisJob | undefined) ?? null;
  }

  if (value && typeof value === 'object') {
    return value as ExternalAnalysisJob;
  }

  return null;
};

export const claimNextExternalAnalysisJob = async (options: {
  workerId: string;
  supportedJobTypes: ExternalAnalysisJobType[];
  leaseSeconds: number;
}): Promise<ExternalAnalysisJob | null> => {
  if (options.supportedJobTypes.length === 0) return null;

  const data = await callQueueRpc<unknown>('claim_next_external_analysis_job', {
    p_worker_id: options.workerId,
    p_supported_job_types: options.supportedJobTypes,
    p_lease_seconds: options.leaseSeconds,
  });

  return firstJob(data);
};

export const renewExternalAnalysisJobLease = async (options: {
  jobId: string;
  workerId: string;
  leaseSeconds: number;
}): Promise<boolean> => (
  callQueueRpc<boolean>('renew_external_analysis_job_lease', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_lease_seconds: options.leaseSeconds,
  })
);

export const heartbeatExternalAnalysisJob = async (options: {
  jobId: string;
  workerId: string;
  leaseSeconds: number;
}): Promise<ExternalAnalysisHeartbeat> => {
  const value = await callQueueRpc<unknown>('heartbeat_external_analysis_job', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_lease_seconds: options.leaseSeconds,
  });
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    owned: source.owned === true,
    cancelRequested: source.cancelRequested === true,
    status: typeof source.status === 'string' ? source.status : '',
    errorCode: typeof source.errorCode === 'string' ? source.errorCode : '',
    errorMessage: typeof source.errorMessage === 'string' ? source.errorMessage : '',
  };
};

export const finalizeExternalAnalysisJobCancel = async (options: {
  jobId: string;
  workerId: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<ExternalAnalysisJob> => {
  const data = await callQueueRpc<unknown>('finalize_external_analysis_job_cancel', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_error_code: options.errorCode ?? 'cancelled_by_user',
    p_error_message: options.errorMessage ?? 'The external analysis task was cancelled by the user.',
  });
  const job = firstJob(data);
  if (!job) throw new Error('Cancellation RPC returned no external analysis job.');
  return job;
};

export const scheduleExternalAnalysisJobRetry = async (options: {
  jobId: string;
  workerId: string;
  errorCode: string;
  errorMessage: string;
  retryDelayMinutes: number;
  progress?: ExternalAnalysisJson;
}): Promise<ExternalAnalysisJob> => {
  const data = await callQueueRpc<unknown>('schedule_external_analysis_job_retry', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_error_code: options.errorCode,
    p_error_message: options.errorMessage,
    p_retry_delay_minutes: options.retryDelayMinutes,
    p_progress: options.progress ?? {},
  });
  const job = firstJob(data);
  if (!job) throw new Error('Retry RPC returned no external analysis job.');
  return job;
};

export const completeExternalAnalysisJob = async (options: {
  jobId: string;
  workerId: string;
  result: ExternalAnalysisJson;
  progress?: ExternalAnalysisJson;
}): Promise<ExternalAnalysisJob> => {
  const data = await callQueueRpc<unknown>('complete_external_analysis_job', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_result: options.result,
    p_progress: options.progress ?? {},
  });
  const job = firstJob(data);
  if (!job) throw new Error('Completion RPC returned no external analysis job.');
  return job;
};

export const updateExternalAnalysisJobProgress = async (options: {
  jobId: string;
  workerId: string;
  progress: ExternalAnalysisJson;
  provider?: string;
  model?: string;
  keyAttempts?: ExternalAnalysisJson[];
}): Promise<boolean> => (
  callQueueRpc<boolean>('update_external_analysis_job_progress', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_progress: options.progress,
    p_provider: options.provider ?? null,
    p_model: options.model ?? null,
    p_key_attempts: options.keyAttempts ?? null,
  })
);

export const recoverStaleExternalAnalysisJobs = async (
  retryDelayMinutes: number,
): Promise<number> => {
  const recovered = await callQueueRpc<number>('recover_stale_external_analysis_jobs', {
    p_retry_delay_minutes: retryDelayMinutes,
  });
  return Number.isFinite(Number(recovered)) ? Number(recovered) : 0;
};
