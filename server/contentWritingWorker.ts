import './loadEnv';

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  type ContentWritingExecutionResult,
} from './contentWritingEngine';
import { executeStructuredContentWritingWorkflow } from './contentWritingWorkflow';
import {
  claimNextContentWritingSession,
  completeContentWritingSession,
  failContentWritingSession,
  getContentWritingMessages,
  heartbeatContentWritingSession,
  updateContentWritingProgress,
  type ContentWritingSession,
} from './contentWritingSessionService';

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
};

const pollIntervalMs = boundedInteger(process.env.CONTENT_WRITING_WORKER_POLL_MS, 1_500, 250, 60_000);
const leaseSeconds = boundedInteger(process.env.CONTENT_WRITING_SESSION_LEASE_SECONDS, 1_800, 60, 3_600);
const workerConcurrency = boundedInteger(process.env.CONTENT_WRITING_WORKER_CONCURRENCY, 1, 1, 3);
const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

class ContentWritingCancellationError extends Error {
  constructor() {
    super('Content writing cancellation was requested.');
    this.name = 'ContentWritingCancellationError';
  }
}

class ContentWritingLostLeaseError extends Error {
  constructor() {
    super('Content writing session lease was lost.');
    this.name = 'ContentWritingLostLeaseError';
  }
}

class ContentWritingWorkerShutdownError extends Error {
  constructor() {
    super('Content writing worker is shutting down.');
    this.name = 'ContentWritingWorkerShutdownError';
  }
}

let shuttingDown = false;
let lastLoggedError = '';
let lastLoggedErrorAt = 0;
const activeControllers = new Map<string, AbortController>();

const sleep = (milliseconds: number): Promise<void> => (
  new Promise(resolve => setTimeout(resolve, milliseconds))
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000)
);

const logThrottledError = (scope: string, error: unknown): void => {
  const message = `${scope}: ${errorMessage(error)}`;
  const now = Date.now();
  if (message === lastLoggedError && now - lastLoggedErrorAt < 60_000) return;
  lastLoggedError = message;
  lastLoggedErrorAt = now;
  console.error(`[content-writing-worker] ${message}`);
};

const startHeartbeat = (
  session: ContentWritingSession,
  slotWorkerId: string,
  controller: AbortController,
): (() => void) => {
  const intervalMs = Math.min(10_000, Math.max(2_000, Math.floor((leaseSeconds * 1_000) / 4)));
  let leaseDeadline = Date.now() + (leaseSeconds * 1_000);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const heartbeat = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return;
    try {
      const state = await heartbeatContentWritingSession({
        sessionId: session.id,
        workerId: slotWorkerId,
        leaseSeconds,
      });
      if (state.cancelRequested) {
        controller.abort(new ContentWritingCancellationError());
        return;
      }
      if (!state.owned) {
        controller.abort(new ContentWritingLostLeaseError());
        return;
      }
      leaseDeadline = Date.now() + (leaseSeconds * 1_000);
    } catch (error) {
      logThrottledError(`Heartbeat failed for ${session.id}`, error);
      if (Date.now() >= leaseDeadline) {
        controller.abort(new ContentWritingLostLeaseError());
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

const getFailureProgress = (result: ContentWritingExecutionResult): Record<string, unknown> => ({
  stage: 'failed',
  provider: result.metadata.provider,
  model: result.model,
  status: result.status,
  message: result.errorMessage || 'Content writing failed.',
  completed: true,
});

const executeClaimedSession = async (
  session: ContentWritingSession,
  slotWorkerId: string,
): Promise<void> => {
  const controller = new AbortController();
  activeControllers.set(slotWorkerId, controller);
  const stopHeartbeat = startHeartbeat(session, slotWorkerId, controller);
  let latestProgress: Record<string, unknown> = session.progress || {};
  let progressWrites = Promise.resolve();

  const queueProgressWrite = (progress: Record<string, unknown>): void => {
    latestProgress = progress;
    progressWrites = progressWrites
      .catch(error => logThrottledError(`Previous progress write failed for ${session.id}`, error))
      .then(async () => {
        await updateContentWritingProgress({
          sessionId: session.id,
          workerId: slotWorkerId,
          progress,
        });
      });
  };

  try {
    queueProgressWrite({
      stage: 'preparing_workflow',
      provider: session.provider,
      model: session.model,
      message: 'Loading the persistent conversation and completed writing steps.',
      completed: false,
    });
    const messages = await getContentWritingMessages(session.id);
    const result = await executeStructuredContentWritingWorkflow({
      session,
      messages,
      workerId: slotWorkerId,
      signal: controller.signal,
      onProgress: queueProgressWrite,
    });
    await progressWrites.catch(error => logThrottledError(`Final progress write failed for ${session.id}`, error));

    const abortReason = controller.signal.reason;
    if (abortReason instanceof ContentWritingLostLeaseError || abortReason instanceof ContentWritingWorkerShutdownError) return;
    const ownership = await heartbeatContentWritingSession({
      sessionId: session.id,
      workerId: slotWorkerId,
      leaseSeconds,
    });
    if (!ownership.owned) return;
    if (ownership.cancelRequested || abortReason instanceof ContentWritingCancellationError || result.status === 499) {
      await failContentWritingSession({
        sessionId: session.id,
        workerId: slotWorkerId,
        errorCode: 'content_writing_cancelled',
        errorMessage: 'Content writing was cancelled by the user.',
        responseMetadata: result.metadata,
        progress: { stage: 'cancelled', message: 'Content writing was cancelled.', completed: true },
      });
      return;
    }

    if (result.ok) {
      const qualityReport = result.metadata.qualityReport && typeof result.metadata.qualityReport === 'object'
        ? result.metadata.qualityReport as Record<string, unknown>
        : null;
      const progress = {
        ...latestProgress,
        stage: 'completed',
        provider: session.provider,
        model: result.model,
        status: result.status,
        message: 'Structured content writing and final review completed successfully.',
        completed: true,
        ...(qualityReport ? {
          qualityScore: Number(qualityReport.score) || 0,
          qualityMinimumScore: Number(qualityReport.minimumScore) || 0,
          qualityGatePassed: qualityReport.passed === true,
          qualityPolicyVersion: Number(qualityReport.policyVersion) || 1,
          qualityRepairPasses: Number(qualityReport.repairPasses) || 0,
        } : {}),
      };
      const completed = await completeContentWritingSession({
        sessionId: session.id,
        workerId: slotWorkerId,
        resultText: result.text,
        model: result.model,
        conversationId: result.conversationId,
        keySuffix: result.keySuffix,
        responseMetadata: result.metadata,
        progress,
      });
      if (completed) console.log(`[content-writing-worker] Completed ${session.id}.`);
      return;
    }

    const progress = getFailureProgress(result);
    await failContentWritingSession({
      sessionId: session.id,
      workerId: slotWorkerId,
      errorCode: result.errorCode || 'content_writing_failed',
      errorMessage: result.errorMessage || 'Content writing failed.',
      responseMetadata: result.metadata,
      progress,
    });
    console.log(`[content-writing-worker] Failed ${session.id} with HTTP ${result.status}.`);
  } catch (error) {
    const abortReason = controller.signal.reason;
    if (abortReason instanceof ContentWritingLostLeaseError || abortReason instanceof ContentWritingWorkerShutdownError) return;
    try {
      await failContentWritingSession({
        sessionId: session.id,
        workerId: slotWorkerId,
        errorCode: abortReason instanceof ContentWritingCancellationError
          ? 'content_writing_cancelled'
          : 'content_writing_worker_error',
        errorMessage: abortReason instanceof ContentWritingCancellationError
          ? 'Content writing was cancelled by the user.'
          : errorMessage(error),
        progress: {
          ...latestProgress,
          stage: abortReason instanceof ContentWritingCancellationError ? 'cancelled' : 'failed',
          message: abortReason instanceof ContentWritingCancellationError
            ? 'Content writing was cancelled.'
            : errorMessage(error),
          completed: true,
        },
      });
    } catch (failureError) {
      logThrottledError(`Could not fail session ${session.id}`, failureError);
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
      const session = await claimNextContentWritingSession({ workerId: slotWorkerId, leaseSeconds });
      if (!session) {
        await sleep(pollIntervalMs);
        continue;
      }
      await executeClaimedSession(session, slotWorkerId);
    } catch (error) {
      logThrottledError(`Worker slot ${slot} failed`, error);
      await sleep(pollIntervalMs);
    }
  }
};

const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[content-writing-worker] Received ${signal}; active sessions will be recovered after lease expiry.`);
  for (const controller of activeControllers.values()) {
    controller.abort(new ContentWritingWorkerShutdownError());
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`[content-writing-worker] Started ${workerConcurrency} slot(s) as ${workerId}.`);
await Promise.all(Array.from({ length: workerConcurrency }, (_, index) => runWorkerSlot(index + 1)));
