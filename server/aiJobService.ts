import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeSystemSettingsMap } from '../constants/settingsRegistry';

export type AiJobProvider = 'gemini' | 'geminiPaid';
export type AiJobStatus =
  | 'queued'
  | 'running'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AiJobJson = Record<string, unknown>;

export interface AiJob {
  id: string;
  public_id: string;
  user_id: string;
  provider: AiJobProvider;
  model: string;
  source: string;
  article_id: string | null;
  status: AiJobStatus;
  request_payload: AiJobJson;
  telemetry: AiJobJson;
  progress: AiJobJson;
  result_status: number | null;
  result: AiJobJson | null;
  last_error: string | null;
  last_error_code: string | null;
  attempt_count: number;
  retry_count: number;
  next_attempt_at: string;
  locked_by: string | null;
  locked_at: string | null;
  lease_expires_at: string | null;
  cancel_requested_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AiJobHeartbeat = {
  owned: boolean;
  cancelRequested: boolean;
  status: string;
};

export class AiJobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiJobConflictError';
  }
}

let aiJobClient: SupabaseClient | null = null;

const getRequiredEnvironmentValue = (name: string, fallbacks: string[] = []): string => {
  for (const candidate of [name, ...fallbacks]) {
    const value = process.env[candidate]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required AI job environment variable: ${name}`);
};

export const getAiJobSupabaseAdmin = (): SupabaseClient => {
  if (aiJobClient) return aiJobClient;

  aiJobClient = createClient(
    getRequiredEnvironmentValue('SUPABASE_URL', ['VITE_SUPABASE_URL']),
    getRequiredEnvironmentValue('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          'X-Client-Info': 'bazarvan-ai-job-service',
        },
      },
    },
  );
  return aiJobClient;
};

const errorDetails = (error: { message?: string; details?: string; hint?: string }): string => (
  [error.message, error.details, error.hint].filter(Boolean).join(' | ')
);

const callAiJobRpc = async <T>(functionName: string, parameters: AiJobJson): Promise<T> => {
  const { data, error } = await getAiJobSupabaseAdmin().rpc(functionName, parameters);
  if (error) {
    throw new Error(`AI job RPC ${functionName} failed: ${errorDetails(error)}`);
  }
  return data as T;
};

const firstJob = (value: unknown): AiJob | null => {
  if (Array.isArray(value)) return (value[0] as AiJob | undefined) ?? null;
  return value && typeof value === 'object' ? value as AiJob : null;
};

const isRecord = (value: unknown): value is AiJobJson => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toSafeJsonObject = (value: unknown): AiJobJson => {
  if (!isRecord(value)) return {};
  return JSON.parse(JSON.stringify(value)) as AiJobJson;
};

const normalizeUuid = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null;
};

export const sanitizeAiJobRequestPayload = (value: unknown): AiJobJson => {
  const source = isRecord(value) ? value : {};
  const history = Array.isArray(source.history)
    ? source.history.slice(0, 100).flatMap(item => {
        if (!isRecord(item)) return [];
        const role = item.role === 'model' ? 'model' : item.role === 'user' ? 'user' : '';
        const text = typeof item.text === 'string' ? item.text : '';
        return role && text ? [{ role, text }] : [];
      })
    : [];
  const fallbackModels = Array.isArray(source.fallbackModels)
    ? source.fallbackModels
        .filter((model): model is string => typeof model === 'string')
        .map(model => model.trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];

  return {
    prompt: typeof source.prompt === 'string' ? source.prompt : String(source.prompt ?? ''),
    history,
    model: typeof source.model === 'string' ? source.model.trim() : '',
    provider: source.provider === 'geminiPaid' ? 'geminiPaid' : 'gemini',
    useUrlContext: source.useUrlContext === true,
    allowModelFallback: source.allowModelFallback === true,
    fallbackModels,
    progressId: typeof source.progressId === 'string' ? source.progressId.trim() : '',
  };
};

export const createAiJob = async (options: {
  publicId: string;
  userId: string;
  provider: AiJobProvider;
  model: string;
  source?: string;
  articleId?: string;
  requestPayload: unknown;
  telemetry?: unknown;
  initialProgress?: unknown;
}): Promise<AiJob> => {
  const row = {
    public_id: options.publicId,
    user_id: options.userId,
    provider: options.provider,
    model: options.model.slice(0, 200),
    source: (options.source?.trim() || 'unknown').slice(0, 120),
    article_id: normalizeUuid(options.articleId),
    request_payload: sanitizeAiJobRequestPayload(options.requestPayload),
    telemetry: toSafeJsonObject(options.telemetry),
    progress: toSafeJsonObject(options.initialProgress),
  };
  const client = getAiJobSupabaseAdmin();
  const { data, error } = await client
    .from('ai_jobs')
    .insert(row)
    .select('*')
    .single();

  if (!error && data) return data as AiJob;
  if (error?.code !== '23505') {
    throw new Error(`Could not create AI job: ${error ? errorDetails(error) : 'empty response'}`);
  }

  const existing = await getAiJobByPublicId(options.publicId);
  if (!existing) throw new Error('AI job identifier conflict could not be resolved.');
  if (existing.user_id !== options.userId) {
    throw new AiJobConflictError('AI job identifier is already owned by another user.');
  }
  return existing;
};

export const getAiJobByPublicId = async (publicId: string): Promise<AiJob | null> => {
  const { data, error } = await getAiJobSupabaseAdmin()
    .from('ai_jobs')
    .select('*')
    .eq('public_id', publicId)
    .maybeSingle();
  if (error) throw new Error(`Could not read AI job: ${errorDetails(error)}`);
  return data ? data as AiJob : null;
};

export const getAiJobForOwner = async (publicId: string, userId: string): Promise<AiJob | null> => {
  const { data, error } = await getAiJobSupabaseAdmin()
    .from('ai_jobs')
    .select('*')
    .eq('public_id', publicId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`Could not read owned AI job: ${errorDetails(error)}`);
  return data ? data as AiJob : null;
};

export const requestAiJobCancel = async (publicId: string, userId: string): Promise<AiJob | null> => (
  firstJob(await callAiJobRpc<unknown>('request_ai_job_cancel', {
    p_public_id: publicId,
    p_user_id: userId,
  }))
);

export const claimNextAiJob = async (workerId: string, leaseSeconds: number): Promise<AiJob | null> => (
  firstJob(await callAiJobRpc<unknown>('claim_next_ai_job', {
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  }))
);

export const heartbeatAiJob = async (
  jobId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<AiJobHeartbeat> => {
  const value = await callAiJobRpc<unknown>('heartbeat_ai_job', {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });
  const source = isRecord(value) ? value : {};
  return {
    owned: source.owned === true,
    cancelRequested: source.cancelRequested === true,
    status: typeof source.status === 'string' ? source.status : '',
  };
};

export const updateAiJobProgress = async (
  jobId: string,
  workerId: string,
  progress: unknown,
): Promise<boolean> => (
  callAiJobRpc<boolean>('update_ai_job_progress', {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_progress: toSafeJsonObject(progress),
  })
);

export const completeAiJob = async (options: {
  jobId: string;
  workerId: string;
  resultStatus: number;
  result: unknown;
  progress?: unknown;
}): Promise<AiJob | null> => (
  firstJob(await callAiJobRpc<unknown>('complete_ai_job', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_result_status: options.resultStatus,
    p_result: toSafeJsonObject(options.result),
    p_progress: toSafeJsonObject(options.progress),
  }))
);

export const failAiJob = async (options: {
  jobId: string;
  workerId: string;
  resultStatus: number;
  errorCode: string;
  errorMessage: string;
  result?: unknown;
  progress?: unknown;
}): Promise<AiJob | null> => (
  firstJob(await callAiJobRpc<unknown>('fail_ai_job', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_result_status: options.resultStatus,
    p_error_code: options.errorCode.slice(0, 120),
    p_error_message: options.errorMessage.slice(0, 2_000),
    p_result: toSafeJsonObject(options.result),
    p_progress: toSafeJsonObject(options.progress),
  }))
);

export const scheduleAiJobRetry = async (options: {
  jobId: string;
  workerId: string;
  resultStatus: number;
  errorCode: string;
  errorMessage: string;
  retryDelayMinutes: number;
  progress?: unknown;
}): Promise<AiJob | null> => (
  firstJob(await callAiJobRpc<unknown>('schedule_ai_job_retry', {
    p_job_id: options.jobId,
    p_worker_id: options.workerId,
    p_result_status: options.resultStatus,
    p_error_code: options.errorCode.slice(0, 120),
    p_error_message: options.errorMessage.slice(0, 2_000),
    p_retry_delay_minutes: options.retryDelayMinutes,
    p_progress: toSafeJsonObject(options.progress),
  }))
);

export const finalizeAiJobCancel = async (jobId: string, workerId: string): Promise<AiJob | null> => (
  firstJob(await callAiJobRpc<unknown>('finalize_ai_job_cancel', {
    p_job_id: jobId,
    p_worker_id: workerId,
  }))
);

export const recoverStaleAiJobs = async (retryDelayMinutes: number): Promise<number> => {
  const value = await callAiJobRpc<number>('recover_stale_ai_jobs', {
    p_retry_delay_minutes: retryDelayMinutes,
  });
  return Number.isFinite(Number(value)) ? Number(value) : 0;
};

export const recordAiJobAttempt = async (options: {
  jobId: string;
  executionAttempt: number;
  sequenceNumber: number;
  provider: string;
  model: string;
  keySuffix?: string;
  outcome: 'success' | 'failed' | 'cancelled';
  status?: number;
  reason?: string;
  durationMs?: number;
}): Promise<void> => {
  const suffix = (options.keySuffix || '').replace(/[^A-Za-z0-9_-]/g, '').slice(-16);
  const { error } = await getAiJobSupabaseAdmin()
    .from('ai_job_attempts')
    .upsert({
      job_id: options.jobId,
      execution_attempt: Math.max(1, Math.round(options.executionAttempt)),
      sequence_number: Math.max(1, Math.round(options.sequenceNumber)),
      provider: options.provider.slice(0, 80),
      model: options.model.slice(0, 200),
      key_suffix: suffix || null,
      outcome: options.outcome,
      status: typeof options.status === 'number' ? Math.round(options.status) : null,
      reason: options.reason?.slice(0, 500) || null,
      duration_ms: typeof options.durationMs === 'number' ? Math.max(0, Math.round(options.durationMs)) : null,
      metadata: {},
    }, {
      onConflict: 'job_id,execution_attempt,sequence_number',
      ignoreDuplicates: true,
    });
  if (error) throw new Error(`Could not record AI job attempt: ${errorDetails(error)}`);
};

const parseRetryMinutes = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(5, Math.min(Math.round(parsed), 1_440));
};

export const readAiJobRetryMinutes = async (): Promise<number> => {
  const environmentFallback = parseRetryMinutes(process.env.EXTERNAL_ANALYSIS_RETRY_MINUTES, 30);
  const { data, error } = await getAiJobSupabaseAdmin()
    .from('app_settings')
    .select('value')
    .eq('key', 'ai')
    .maybeSingle();
  if (error) {
    console.warn('[ai-job-service] Could not read retry settings; using environment fallback.', error.message);
    return environmentFallback;
  }
  const value = isRecord(data?.value) ? data.value : {};
  return parseRetryMinutes(
    normalizeSystemSettingsMap({ ai: value }).ai.externalAnalysisRetryMinutes,
    environmentFallback,
  );
};
