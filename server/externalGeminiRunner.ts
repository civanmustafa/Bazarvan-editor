import {
  executeGeminiRequest,
  type GeminiExecutionProgress,
} from '../api/gemini';
import {
  ExternalAnalysisRetryError,
  type ExternalAnalysisExecutionContext,
} from './externalAnalysisExecutor';
import type { ExternalAnalysisJson } from './externalAnalysisQueue';

export type ExternalGeminiCallResult = {
  ok: boolean;
  status: number;
  text: string;
  error: string;
  provider: string;
  model: string;
  keySuffix: string;
  attempts: ExternalAnalysisJson[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const compactJson = (value: Record<string, unknown>): ExternalAnalysisJson => (
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
);

const toVisibleGeminiProgress = (
  progress: GeminiExecutionProgress,
): ExternalAnalysisJson => compactJson({
  stage: `gemini_${progress.stage || 'running'}`,
  gemini: compactJson({
    stage: progress.stage,
    provider: progress.provider,
    model: progress.model,
    requestedModel: progress.requestedModel,
    currentModelIndex: progress.currentModelIndex,
    modelCount: progress.modelCount,
    currentKeyIndex: progress.currentKeyIndex,
    keyCount: progress.keyCount,
    attemptedKeyCount: progress.attemptedKeyCount,
    totalAttemptCount: progress.totalAttemptCount,
    keySuffix: progress.keySuffix,
    status: progress.status,
    reason: progress.reason,
    message: progress.message,
    completed: progress.completed,
    updatedAt: progress.updatedAt,
  }),
});

const createProgressForwarder = (context: ExternalAnalysisExecutionContext) => {
  let latest: GeminiExecutionProgress | null = null;
  let running: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (latest) {
      const current = latest;
      latest = null;
      try {
        await context.reportProgress({
          progress: toVisibleGeminiProgress(current),
          provider: current.provider,
          model: current.model,
        });
      } catch (error) {
        console.warn('[external-analysis] Could not persist intermediate Gemini progress', {
          jobId: context.job.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const start = (): void => {
    if (running) return;
    running = drain().finally(() => {
      running = null;
      if (latest) start();
    });
  };

  return {
    push(progress: GeminiExecutionProgress) {
      latest = progress;
      start();
    },
    async flush() {
      while (running || latest) {
        start();
        if (running) await running;
      }
    },
  };
};

const sanitizeGeminiAttempts = (
  body: Record<string, unknown>,
  requestIndex: number,
  succeeded: boolean,
): ExternalAnalysisJson[] => {
  const failed = Array.isArray(body.attempts)
    ? body.attempts.filter(isRecord).map((attempt): ExternalAnalysisJson => compactJson({
        requestIndex,
        outcome: 'failed',
        model: toTrimmedString(attempt.model),
        keySuffix: toTrimmedString(attempt.keySuffix),
        status: typeof attempt.status === 'number' ? attempt.status : undefined,
        reason: toTrimmedString(attempt.reason) || 'unknown',
        attempt: typeof attempt.attempt === 'number' ? attempt.attempt : 1,
      }))
    : [];

  if (succeeded) {
    failed.push(compactJson({
      requestIndex,
      outcome: 'success',
      model: toTrimmedString(body.model),
      keySuffix: toTrimmedString(body.keySuffix),
      status: 200,
      reason: 'success',
      attempt: 1,
    }));
  }

  return failed;
};

export const runExternalGeminiCall = async (options: {
  context: ExternalAnalysisExecutionContext;
  prompt: string;
  model: string;
  allowModelFallback: boolean;
  requestIndex: number;
  useUrlContext?: boolean;
}): Promise<ExternalGeminiCallResult> => {
  const progressId = `external-${options.context.job.id}-${options.context.job.attempt_count}-${options.requestIndex}`;
  const progressForwarder = createProgressForwarder(options.context);
  const result = await executeGeminiRequest({
    prompt: options.prompt,
    provider: 'gemini',
    model: options.model,
    allowModelFallback: options.allowModelFallback,
    useUrlContext: options.useUrlContext === true,
    progressId,
  }, {
    signal: options.context.signal,
    onProgress: progress => progressForwarder.push(progress),
  });
  await progressForwarder.flush();

  const body = isRecord(result.body) ? result.body : {};
  const text = toTrimmedString(body.text);
  const ok = result.status >= 200 && result.status < 300 && Boolean(text);
  return {
    ok,
    status: result.status,
    text,
    error: toTrimmedString(body.error) || `Gemini request failed with status ${result.status}.`,
    provider: toTrimmedString(body.provider) || 'gemini',
    model: toTrimmedString(body.model) || options.model,
    keySuffix: toTrimmedString(body.keySuffix),
    attempts: sanitizeGeminiAttempts(body, options.requestIndex, ok),
  };
};

export const reportExternalGeminiCall = async (
  context: ExternalAnalysisExecutionContext,
  call: ExternalGeminiCallResult,
  attempts: ExternalAnalysisJson[],
): Promise<void> => {
  const persisted = await context.reportProgress({
    progress: {
      stage: call.ok ? 'gemini_response_received' : 'gemini_failed',
      gemini: {
        provider: call.provider,
        model: call.model,
        keySuffix: call.keySuffix,
        status: call.status,
        requestCount: new Set(attempts.map(attempt => attempt.requestIndex)).size,
      },
    },
    provider: call.provider,
    model: call.model,
    keyAttempts: attempts,
  });
  if (!persisted) {
    throw new ExternalAnalysisRetryError({
      code: 'external_analysis_job_lease_lost',
      message: 'The external analysis job lease was lost while recording Gemini progress.',
    });
  }
};
