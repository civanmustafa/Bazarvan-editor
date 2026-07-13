import './loadEnv';

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  aiExecutionEngine,
  sanitizeAiExecutionResult,
  type AiExecutionProgress,
  type AiExecutionTelemetryContext,
} from './aiExecutionEngine';
import {
  claimNextAiJob,
  completeAiJob,
  failAiJob,
  finalizeAiJobCancel,
  heartbeatAiJob,
  readAiJobRetryMinutes,
  recordAiJobAttempt,
  recoverStaleAiJobs,
  scheduleAiJobRetry,
  updateAiJobProgress,
  type AiJob,
  type AiJobJson,
} from './aiJobService';

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
};

const pollIntervalMs = boundedInteger(process.env.AI_JOB_WORKER_POLL_MS, 1_500, 250, 60_000);
const leaseSeconds = boundedInteger(process.env.AI_JOB_LEASE_SECONDS, 300, 30, 1_800);
const workerConcurrency = boundedInteger(process.env.AI_JOB_WORKER_CONCURRENCY, 2, 1, 5);
const recoveryIntervalMs = 60_000;
const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

class UserCancellationError extends Error {
  constructor() {
    super('AI job cancellation was requested by the user.');
    this.name = 'UserCancellationError';
  }
}

class LostLeaseError extends Error {
  constructor() {
    super('AI job lease is no longer owned by this worker.');
    this.name = 'LostLeaseError';
  }
}

class WorkerShutdownError extends Error {
  constructor() {
    super('AI job worker is shutting down.');
    this.name = 'WorkerShutdownError';
  }
}

let shuttingDown = false;
let lastRecoveryAt = 0;
let lastLoggedError = '';
let lastLoggedErrorAt = 0;
const activeControllers = new Map<string, AbortController>();

const sleep = (milliseconds: number): Promise<void> => (
  new Promise(resolve => setTimeout(resolve, milliseconds))
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)
);

const logThrottledError = (scope: string, error: unknown): void => {
  const message = `${scope}: ${errorMessage(error)}`;
  const now = Date.now();
  if (message === lastLoggedError && now - lastLoggedErrorAt < 60_000) return;
  lastLoggedError = message;
  lastLoggedErrorAt = now;
  console.error(`[ai-job-worker] ${message}`);
};

const asRecord = (value: unknown): AiJobJson => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as AiJobJson
    : {}
);

const startHeartbeat = (
  job: AiJob,
  slotWorkerId: string,
  controller: AbortController,
): (() => void) => {
  const intervalMs = Math.min(3_000, Math.max(1_000, Math.floor((leaseSeconds * 1_000) / 4)));
  let leaseDeadline = Date.now() + (leaseSeconds * 1_000);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const heartbeat = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return;
    try {
      const state = await heartbeatAiJob(job.id, slotWorkerId, leaseSeconds);
      if (state.cancelRequested) {
        controller.abort(new UserCancellationError());
        return;
      }
      if (!state.owned) {
        controller.abort(new LostLeaseError());
        return;
      }
      leaseDeadline = Date.now() + (leaseSeconds * 1_000);
    } catch (error) {
      logThrottledError(`Heartbeat failed for ${job.public_id}`, error);
      if (Date.now() >= leaseDeadline) {
        controller.abort(new LostLeaseError());
        return;
      }
    }

    if (!stopped && !controller.signal.aborted) {
      timer = setTimeout(() => void heartbeat(), intervalMs);
    }
  };

  timer = setTimeout(() => void heartbeat(), intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};

const recoverStaleJobsIfDue = async (): Promise<void> => {
  const now = Date.now();
  if (now - lastRecoveryAt < recoveryIntervalMs) return;
  lastRecoveryAt = now;
  const recovered = await recoverStaleAiJobs(1);
  if (recovered > 0) console.log(`[ai-job-worker] Recovered ${recovered} stale job(s).`);
};

const isTransientStatus = (status: number): boolean => (
  status === 408 || status === 425 || status === 429 || status >= 500
);

const resultError = (body: AiJobJson, status: number): string => (
  typeof body.error === 'string'
    ? body.error.slice(0, 2_000)
    : `AI request failed with HTTP ${status}.`
);

const executeClaimedJob = async (job: AiJob, slotWorkerId: string): Promise<void> => {
  const controller = new AbortController();
  activeControllers.set(slotWorkerId, controller);
  const stopHeartbeat = startHeartbeat(job, slotWorkerId, controller);
  let latestProgress: AiExecutionProgress | AiJobJson = job.progress || {};
  let progressWrites = Promise.resolve();
  let attemptSequence = 0;
  const recordedAttempts = new Set<string>();

  const queueProgressWrite = (progress: AiExecutionProgress): void => {
    latestProgress = progress;
    const signature = [
      progress.stage,
      progress.model,
      progress.currentModelIndex,
      progress.currentKeyIndex,
      progress.keySuffix,
      progress.status,
    ].join(':');
    const shouldRecord = (
      progress.stage === 'failed-key'
      || progress.stage === 'success'
      || progress.stage === 'cancelled'
    ) && !recordedAttempts.has(signature);
    if (shouldRecord) {
      recordedAttempts.add(signature);
      attemptSequence += 1;
    }

    progressWrites = progressWrites
      .catch(error => logThrottledError(`Previous progress write failed for ${job.public_id}`, error))
      .then(async () => {
        await updateAiJobProgress(job.id, slotWorkerId, progress);
        if (!shouldRecord) return;
        await recordAiJobAttempt({
          jobId: job.id,
          executionAttempt: job.attempt_count,
          sequenceNumber: attemptSequence,
          provider: progress.provider,
          model: progress.model,
          keySuffix: progress.keySuffix,
          outcome: progress.stage === 'success'
            ? 'success'
            : progress.stage === 'cancelled'
              ? 'cancelled'
              : 'failed',
          status: progress.status,
          reason: progress.reason,
        });
      });
  };

  try {
    const requestPayload = {
      ...job.request_payload,
      progressId: job.public_id,
    };
    const telemetry: AiExecutionTelemetryContext = {
      ...(job.telemetry as AiExecutionTelemetryContext),
      actorUserId: job.user_id,
      source: job.source,
      articleId: job.article_id || (job.telemetry.articleId as string | undefined),
    };
    const engineResult = await aiExecutionEngine.executeGemini(requestPayload, {
      signal: controller.signal,
      telemetry,
      onProgress: queueProgressWrite,
    });
    await progressWrites.catch(error => {
      logThrottledError(`Final progress write failed for ${job.public_id}`, error);
    });

    const abortReason = controller.signal.reason;
    if (abortReason instanceof LostLeaseError || abortReason instanceof WorkerShutdownError) return;
    if (abortReason instanceof UserCancellationError || engineResult.status === 499) {
      await finalizeAiJobCancel(job.id, slotWorkerId);
      console.log(`[ai-job-worker] Cancelled ${job.public_id}.`);
      return;
    }

    const ownership = await heartbeatAiJob(job.id, slotWorkerId, leaseSeconds);
    if (ownership.cancelRequested) {
      await finalizeAiJobCancel(job.id, slotWorkerId);
      return;
    }
    if (!ownership.owned) return;

    const publicResult = sanitizeAiExecutionResult(engineResult);
    const resultBody = asRecord(publicResult.body);
    if (publicResult.status >= 200 && publicResult.status < 300) {
      const completed = await completeAiJob({
        jobId: job.id,
        workerId: slotWorkerId,
        resultStatus: publicResult.status,
        result: resultBody,
        progress: latestProgress,
      });
      if (completed?.status === 'cancelled') {
        console.log(`[ai-job-worker] Cancelled ${job.public_id} during completion.`);
      } else if (completed) {
        console.log(`[ai-job-worker] Completed ${job.public_id}.`);
      }
      return;
    }

    const message = resultError(resultBody, publicResult.status);
    if (isTransientStatus(publicResult.status)) {
      const retryMinutes = await readAiJobRetryMinutes();
      await scheduleAiJobRetry({
        jobId: job.id,
        workerId: slotWorkerId,
        resultStatus: publicResult.status,
        errorCode: `gemini_http_${publicResult.status}`,
        errorMessage: message,
        retryDelayMinutes: retryMinutes,
        progress: {
          ...asRecord(latestProgress),
          stage: 'retry_scheduled',
          completed: false,
          status: publicResult.status,
          message: `The AI request will retry in ${retryMinutes} minute(s).`,
        },
      });
      console.log(`[ai-job-worker] Scheduled retry for ${job.public_id} in ${retryMinutes} minute(s).`);
      return;
    }

    await failAiJob({
      jobId: job.id,
      workerId: slotWorkerId,
      resultStatus: publicResult.status,
      errorCode: `gemini_http_${publicResult.status}`,
      errorMessage: message,
      result: resultBody,
      progress: latestProgress,
    });
    console.log(`[ai-job-worker] Failed ${job.public_id} with HTTP ${publicResult.status}.`);
  } catch (error) {
    const abortReason = controller.signal.reason;
    if (abortReason instanceof UserCancellationError) {
      try {
        await finalizeAiJobCancel(job.id, slotWorkerId);
      } catch (finalizeError) {
        logThrottledError(`Could not finalize cancellation for ${job.public_id}`, finalizeError);
      }
      return;
    }
    if (abortReason instanceof LostLeaseError || abortReason instanceof WorkerShutdownError) return;

    try {
      const retryMinutes = await readAiJobRetryMinutes();
      await scheduleAiJobRetry({
        jobId: job.id,
        workerId: slotWorkerId,
        resultStatus: 503,
        errorCode: 'ai_job_worker_error',
        errorMessage: errorMessage(error),
        retryDelayMinutes: retryMinutes,
        progress: {
          ...asRecord(latestProgress),
          stage: 'retry_scheduled',
          completed: false,
          status: 503,
          message: `The AI worker will retry in ${retryMinutes} minute(s).`,
        },
      });
    } catch (retryError) {
      logThrottledError(`Could not schedule retry for ${job.public_id}`, retryError);
    }
  } finally {
    stopHeartbeat();
    activeControllers.delete(slotWorkerId);
  }
};

const runWorkerSlot = async (slot: number): Promise<void> => {
  const slotWorkerId = `${workerId}:slot-${slot}`;
  while (!shuttingDown) {
    try {
      await recoverStaleJobsIfDue();
      const job = await claimNextAiJob(slotWorkerId, leaseSeconds);
      if (!job) {
        await sleep(pollIntervalMs);
        continue;
      }
      await executeClaimedJob(job, slotWorkerId);
    } catch (error) {
      logThrottledError(`Worker slot ${slot} failed`, error);
      await sleep(pollIntervalMs);
    }
  }
};

const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ai-job-worker] Received ${signal}; releasing active jobs for lease recovery.`);
  for (const controller of activeControllers.values()) {
    controller.abort(new WorkerShutdownError());
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`[ai-job-worker] Started ${workerConcurrency} slot(s) as ${workerId}.`);
await Promise.all(Array.from({ length: workerConcurrency }, (_, index) => runWorkerSlot(index + 1)));
