import './loadEnv';
import './externalSemanticAnalysisExecutor';
import './contentBriefGenerationExecutor';
import './fullArticlePipelineExecutor';
import './externalEngineeringAnalysisExecutor';
import './competitorDiscoveryExecutor';
import './competitorExtractionExecutor';

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  cancelExternalEngineeringBundle,
  claimNextExternalAnalysisJob,
  completeExternalAnalysisJob,
  finalizeExternalAnalysisJobCancel,
  heartbeatExternalAnalysisJob,
  getExternalAnalysisSupabaseAdmin,
  recoverStaleExternalAnalysisJobs,
  renewExternalAnalysisJobLease,
  scheduleExternalAnalysisJobRetry,
  updateExternalAnalysisJobProgress,
  type ExternalAnalysisJob,
  type ExternalAnalysisJobType,
} from './externalAnalysisQueue';
import {
  ExternalAnalysisRetryError,
  ExternalAnalysisTerminalError,
  getExternalAnalysisJobExecutor,
  getSupportedExternalAnalysisJobTypes,
} from './externalAnalysisExecutor';
import { AdaptiveQueueWorker } from './adaptiveQueueWorker';
import { subscribeToWorkerQueueWakeSignal } from './workerQueueWakeSignal';
import { readAiJobRetryMinutes } from './aiJobService';

const parseBoundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
};

const pollIntervalMs = parseBoundedInteger(
  process.env.EXTERNAL_ANALYSIS_WORKER_POLL_MS,
  5_000,
  1_000,
  60_000,
);
const maximumIdlePollIntervalMs = parseBoundedInteger(
  process.env.EXTERNAL_ANALYSIS_WORKER_IDLE_MAX_MS,
  30_000,
  pollIntervalMs,
  60_000,
);
const leaseSeconds = parseBoundedInteger(
  process.env.EXTERNAL_ANALYSIS_JOB_LEASE_SECONDS,
  300,
  30,
  1_800,
);
const retryDelayMinutes = parseBoundedInteger(
  process.env.EXTERNAL_ANALYSIS_RETRY_MINUTES,
  30,
  1,
  1_440,
);
const workerConcurrency = parseBoundedInteger(
  process.env.EXTERNAL_ANALYSIS_WORKER_CONCURRENCY,
  5,
  1,
  5,
);
const configuredJobTypes = new Set(
  String(process.env.EXTERNAL_ANALYSIS_WORKER_JOB_TYPES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
);
// PM2 uses this hard boundary to keep Firecrawl competitor jobs isolated from
// semantic/engineering AI jobs even though both processes share the worker binary.
const workerJobTypes: ExternalAnalysisJobType[] = getSupportedExternalAnalysisJobTypes()
  .filter(jobType => configuredJobTypes.size === 0 || configuredJobTypes.has(jobType));
const recoveryIntervalMs = 60_000;
const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

let shuttingDown = false;
const activeControllers = new Map<string, AbortController>();
let lastRecoveryAt = 0;
let idleNoticeShown = false;
let lastLoggedError = '';
let lastLoggedErrorAt = 0;

class ExternalAnalysisCancellationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExternalAnalysisCancellationError';
    this.code = code;
  }
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message.slice(0, 2_000);
  return String(error).slice(0, 2_000);
};

const logThrottledError = (scope: string, error: unknown): void => {
  const message = `${scope}: ${errorMessage(error)}`;
  const now = Date.now();
  if (message === lastLoggedError && now - lastLoggedErrorAt < 60_000) return;

  lastLoggedError = message;
  lastLoggedErrorAt = now;
  console.error(`[external-analysis-worker] ${message}`);
};

const recoverStaleJobsIfDue = async (): Promise<void> => {
  const now = Date.now();
  if (now - lastRecoveryAt < recoveryIntervalMs) return;
  lastRecoveryAt = now;

  const administratorRetryMinutes = await readAiJobRetryMinutes()
    .catch(() => retryDelayMinutes);
  const recovered = await recoverStaleExternalAnalysisJobs(administratorRetryMinutes);
  if (recovered > 0) {
    console.log(`[external-analysis-worker] Recovered ${recovered} stale job(s).`);
  }
};

const startLeaseHeartbeat = (
  job: ExternalAnalysisJob,
  controller: AbortController,
  slotWorkerId: string,
): (() => void) => {
  const heartbeatIntervalMs = Math.min(
    10_000,
    Math.max(3_000, Math.floor((leaseSeconds * 1_000) / 3)),
  );
  let leaseDeadline = Date.now() + (leaseSeconds * 1_000);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const heartbeat = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return;

    try {
      const heartbeatState = await heartbeatExternalAnalysisJob({
        jobId: job.id,
        workerId: slotWorkerId,
        leaseSeconds,
      });
      if (heartbeatState.cancelRequested) {
        controller.abort(new ExternalAnalysisCancellationError(
          heartbeatState.errorCode || 'cancelled_by_user',
          heartbeatState.errorMessage || 'The external analysis task was cancelled.',
        ));
        return;
      }
      if (!heartbeatState.owned) {
        controller.abort(new Error('The worker no longer owns this job lease.'));
        return;
      }
      leaseDeadline = Date.now() + (leaseSeconds * 1_000);
    } catch (error) {
      logThrottledError(`Could not renew lease for job ${job.id}`, error);
      if (Date.now() >= leaseDeadline) {
        controller.abort(new Error('The job lease expired while renewal was unavailable.'));
        return;
      }
    }

    if (!stopped && !controller.signal.aborted) {
      timer = setTimeout(() => void heartbeat(), heartbeatIntervalMs);
    }
  };

  timer = setTimeout(() => void heartbeat(), heartbeatIntervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};

const retryDetails = (error: unknown): {
  code: string;
  message: string;
  delayMinutes: number;
  progress: Record<string, unknown>;
} => {
  if (error instanceof ExternalAnalysisRetryError) {
    return {
      code: error.code,
      message: error.message.slice(0, 2_000),
      delayMinutes: error.retryDelayMinutes ?? retryDelayMinutes,
      progress: error.progress ?? {},
    };
  }

  return {
    code: shuttingDown ? 'worker_shutdown' : 'worker_execution_failed',
    message: errorMessage(error),
    delayMinutes: retryDelayMinutes,
    progress: {},
  };
};

const executeClaimedJob = async (
  job: ExternalAnalysisJob,
  slotWorkerId: string,
): Promise<void> => {
  const executor = getExternalAnalysisJobExecutor(job.job_type);
  const controller = new AbortController();
  activeControllers.set(slotWorkerId, controller);
  const stopHeartbeat = startLeaseHeartbeat(job, controller, slotWorkerId);

  try {
    if (!executor) {
      throw new ExternalAnalysisRetryError({
        code: 'executor_unavailable',
        message: `No executor is registered for ${job.job_type}.`,
      });
    }

    const execution = await executor({
      job,
      workerId: slotWorkerId,
      signal: controller.signal,
      renewLease: () => renewExternalAnalysisJobLease({
        jobId: job.id,
        workerId: slotWorkerId,
        leaseSeconds,
      }),
      reportProgress: update => updateExternalAnalysisJobProgress({
        jobId: job.id,
        workerId: slotWorkerId,
        ...update,
      }),
    });

    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new Error('External analysis execution was aborted.');
    }

    const heartbeatState = await heartbeatExternalAnalysisJob({
      jobId: job.id,
      workerId: slotWorkerId,
      leaseSeconds,
    });
    if (heartbeatState.cancelRequested) {
      throw new ExternalAnalysisCancellationError(
        heartbeatState.errorCode || 'cancelled_by_user',
        heartbeatState.errorMessage || 'The external analysis task was cancelled.',
      );
    }
    if (!heartbeatState.owned) {
      throw new Error('The worker no longer owns this job lease.');
    }

    const completed = await completeExternalAnalysisJob({
      jobId: job.id,
      workerId: slotWorkerId,
      result: execution.result,
      progress: execution.progress,
    });
    if (completed.status === 'cancelled') {
      console.log(`[external-analysis-worker] Cancelled job ${job.id} (${job.job_type}).`);
    } else {
      console.log(`[external-analysis-worker] Completed job ${job.id} (${job.job_type}).`);
    }
  } catch (error) {
    const cancellation = error instanceof ExternalAnalysisCancellationError
      ? error
      : controller.signal.reason instanceof ExternalAnalysisCancellationError
        ? controller.signal.reason
        : null;
    if (cancellation) {
      try {
        await finalizeExternalAnalysisJobCancel({
          jobId: job.id,
          workerId: slotWorkerId,
          errorCode: cancellation.code,
          errorMessage: cancellation.message,
        });
        console.log(`[external-analysis-worker] Cancelled job ${job.id} (${job.job_type}).`);
      } catch (cancelError) {
        logThrottledError(`Could not finalize cancellation for job ${job.id}`, cancelError);
      }
      return;
    }

    if (error instanceof ExternalAnalysisTerminalError) {
      try {
        const cancelledCount = error.cancelEngineeringBundle
          && job.job_type === 'engineering_command'
          ? await cancelExternalEngineeringBundle(job.article_id)
          : 0;
        if (cancelledCount === 0) {
          await finalizeExternalAnalysisJobCancel({
            jobId: job.id,
            workerId: slotWorkerId,
            errorCode: error.code,
            errorMessage: error.message,
          });
        }
        console.log(
          `[external-analysis-worker] Cancelled terminal job ${job.id} (${job.job_type}); reason=${error.code}; related=${cancelledCount}.`,
        );
      } catch (terminalError) {
        logThrottledError(`Could not finalize terminal job ${job.id}`, terminalError);
      }
      return;
    }

    const retry = retryDetails(error);
    try {
      const administratorRetryMinutes = await readAiJobRetryMinutes()
        .catch(() => retry.delayMinutes);
      const scheduled = await scheduleExternalAnalysisJobRetry({
        jobId: job.id,
        workerId: slotWorkerId,
        errorCode: retry.code,
        errorMessage: retry.message,
        retryDelayMinutes: error instanceof ExternalAnalysisRetryError
          && error.retryDelayMinutes !== undefined
          ? retry.delayMinutes
          : administratorRetryMinutes,
        progress: retry.progress,
      });
      if (scheduled.status === 'cancelled') {
        console.log(`[external-analysis-worker] Cancelled job ${job.id} (${job.job_type}).`);
      } else {
        const retryLogMessage = retry.message.replace(/\s+/g, ' ').slice(0, 500);
        console.warn(
          `[external-analysis-worker] Job ${job.id} (${job.job_type}) will retry at ${scheduled.next_attempt_at}; reason=${retry.code}: ${retryLogMessage}`,
        );
      }
    } catch (scheduleError) {
      logThrottledError(`Could not schedule retry for job ${job.id}`, scheduleError);
    }
  } finally {
    stopHeartbeat();
    if (activeControllers.get(slotWorkerId) === controller) {
      activeControllers.delete(slotWorkerId);
    }
  }
};

const queueWorker = new AdaptiveQueueWorker<ExternalAnalysisJob>({
  workerName: 'external-analysis-worker',
  workerId,
  concurrency: workerConcurrency,
  minimumIdleDelayMs: pollIntervalMs,
  maximumIdleDelayMs: maximumIdlePollIntervalMs,
  isShuttingDown: () => shuttingDown,
  beforeClaim: async () => {
    if (workerJobTypes.length > 0) await recoverStaleJobsIfDue();
  },
  claim: async slotWorkerId => {
    if (workerJobTypes.length === 0) {
      if (!idleNoticeShown) {
        console.log('[external-analysis-worker] No allowed executors are configured; queue claiming is idle.');
        idleNoticeShown = true;
      }
      return null;
    }

    idleNoticeShown = false;
    return claimNextExternalAnalysisJob({
      workerId: slotWorkerId,
      supportedJobTypes: workerJobTypes,
      leaseSeconds,
    });
  },
  execute: executeClaimedJob,
  onError: logThrottledError,
});

const runWorker = async (): Promise<void> => {
  console.log(
    `[external-analysis-worker] Started ${workerId}; jobTypes=${workerJobTypes.join(',') || 'none'}; concurrency=${workerConcurrency}, idlePoll=${pollIntervalMs}-${maximumIdlePollIntervalMs}ms, lease=${leaseSeconds}s, retryFallback=${retryDelayMinutes}m (global setting takes precedence).`,
  );

  const unsubscribeWakeSignal: () => void = workerJobTypes.length > 0
    ? subscribeToWorkerQueueWakeSignal({
        client: getExternalAnalysisSupabaseAdmin(),
        queueName: 'external_analysis',
        subscriberId: workerId,
        onWake: queueWorker.wake,
        onStatus: status => {
          if (status === 'SUBSCRIBED') {
            console.log('[external-analysis-worker] Realtime queue wake signal subscribed.');
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            logThrottledError('Realtime queue wake signal unavailable; adaptive polling remains active', status);
          }
        },
      })
    : (): void => undefined;

  try {
    await queueWorker.run();
  } finally {
    unsubscribeWakeSignal();
    console.log('[external-analysis-worker] Stopped.');
  }
};

const requestShutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  queueWorker.stop();
  console.log(`[external-analysis-worker] Received ${signal}; stopping.`);
  activeControllers.forEach(controller => {
    controller.abort(new Error(`Worker stopped by ${signal}.`));
  });
};

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

void runWorker().catch((error) => {
  console.error(`[external-analysis-worker] Fatal error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
