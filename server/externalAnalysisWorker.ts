import './loadEnv';
import './externalSemanticAnalysisExecutor';

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  claimNextExternalAnalysisJob,
  completeExternalAnalysisJob,
  recoverStaleExternalAnalysisJobs,
  renewExternalAnalysisJobLease,
  scheduleExternalAnalysisJobRetry,
  updateExternalAnalysisJobProgress,
  type ExternalAnalysisJob,
} from './externalAnalysisQueue';
import {
  ExternalAnalysisRetryError,
  getExternalAnalysisJobExecutor,
  getSupportedExternalAnalysisJobTypes,
} from './externalAnalysisExecutor';

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
const recoveryIntervalMs = 60_000;
const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

let shuttingDown = false;
let activeController: AbortController | null = null;
let lastRecoveryAt = 0;
let idleNoticeShown = false;
let lastLoggedError = '';
let lastLoggedErrorAt = 0;

const sleep = (milliseconds: number): Promise<void> => (
  new Promise((resolve) => setTimeout(resolve, milliseconds))
);

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

  const recovered = await recoverStaleExternalAnalysisJobs(retryDelayMinutes);
  if (recovered > 0) {
    console.log(`[external-analysis-worker] Recovered ${recovered} stale job(s).`);
  }
};

const startLeaseHeartbeat = (
  job: ExternalAnalysisJob,
  controller: AbortController,
): (() => void) => {
  const heartbeatIntervalMs = Math.max(10_000, Math.floor((leaseSeconds * 1_000) / 3));
  let leaseDeadline = Date.now() + (leaseSeconds * 1_000);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const heartbeat = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return;

    try {
      const renewed = await renewExternalAnalysisJobLease({
        jobId: job.id,
        workerId,
        leaseSeconds,
      });
      if (!renewed) {
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

const executeClaimedJob = async (job: ExternalAnalysisJob): Promise<void> => {
  const executor = getExternalAnalysisJobExecutor(job.job_type);
  const controller = new AbortController();
  activeController = controller;
  const stopHeartbeat = startLeaseHeartbeat(job, controller);

  try {
    if (!executor) {
      throw new ExternalAnalysisRetryError({
        code: 'executor_unavailable',
        message: `No executor is registered for ${job.job_type}.`,
      });
    }

    const execution = await executor({
      job,
      workerId,
      signal: controller.signal,
      renewLease: () => renewExternalAnalysisJobLease({
        jobId: job.id,
        workerId,
        leaseSeconds,
      }),
      reportProgress: update => updateExternalAnalysisJobProgress({
        jobId: job.id,
        workerId,
        ...update,
      }),
    });

    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new Error('External analysis execution was aborted.');
    }

    await completeExternalAnalysisJob({
      jobId: job.id,
      workerId,
      result: execution.result,
      progress: execution.progress,
    });
    console.log(`[external-analysis-worker] Completed job ${job.id} (${job.job_type}).`);
  } catch (error) {
    const retry = retryDetails(error);
    try {
      const scheduled = await scheduleExternalAnalysisJobRetry({
        jobId: job.id,
        workerId,
        errorCode: retry.code,
        errorMessage: retry.message,
        retryDelayMinutes: retry.delayMinutes,
        progress: retry.progress,
      });
      console.warn(
        `[external-analysis-worker] Job ${job.id} will retry at ${scheduled.next_attempt_at}.`,
      );
    } catch (scheduleError) {
      logThrottledError(`Could not schedule retry for job ${job.id}`, scheduleError);
    }
  } finally {
    stopHeartbeat();
    if (activeController === controller) activeController = null;
  }
};

const runWorker = async (): Promise<void> => {
  console.log(
    `[external-analysis-worker] Started ${workerId}; poll=${pollIntervalMs}ms, lease=${leaseSeconds}s, retry=${retryDelayMinutes}m.`,
  );

  while (!shuttingDown) {
    try {
      await recoverStaleJobsIfDue();

      const supportedJobTypes = getSupportedExternalAnalysisJobTypes();
      if (supportedJobTypes.length === 0) {
        if (!idleNoticeShown) {
          console.log('[external-analysis-worker] No executors registered; queue claiming is idle.');
          idleNoticeShown = true;
        }
        await sleep(pollIntervalMs);
        continue;
      }

      idleNoticeShown = false;
      const job = await claimNextExternalAnalysisJob({
        workerId,
        supportedJobTypes,
        leaseSeconds,
      });

      if (!job) {
        await sleep(pollIntervalMs);
        continue;
      }

      await executeClaimedJob(job);
    } catch (error) {
      logThrottledError('Worker loop failed', error);
      await sleep(pollIntervalMs);
    }
  }

  console.log('[external-analysis-worker] Stopped.');
};

const requestShutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[external-analysis-worker] Received ${signal}; stopping.`);
  activeController?.abort(new Error(`Worker stopped by ${signal}.`));
};

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

void runWorker().catch((error) => {
  console.error(`[external-analysis-worker] Fatal error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
