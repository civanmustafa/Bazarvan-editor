import './loadEnv';

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ClientPageCrawlerError,
} from './clientPageCrawler';
import { crawlClientPageWithProvider } from './clientPageCrawlerProviders';
import { recordCrawlerProviderUsageEvent } from './crawlerProviderUsage';
import {
  claimNextClientPageCrawlJob,
  completeClientPageCrawlJob,
  failClientPageCrawlJob,
  getClientPageCrawlInput,
  heartbeatClientPageCrawlJob,
  recoverStaleClientPageCrawlJobs,
  type ClientPageCrawlJob,
} from './clientPageCrawlQueue';
import { indexCompletedClientPage } from './clientSemanticIndexStore';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import { AdaptiveQueueWorker } from './adaptiveQueueWorker';
import { subscribeToWorkerQueueWakeSignal } from './workerQueueWakeSignal';

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
};

const pollIntervalMs = boundedInteger(process.env.CLIENT_PAGE_CRAWLER_POLL_MS, 2_500, 500, 60_000);
const maximumIdlePollIntervalMs = boundedInteger(
  process.env.CLIENT_PAGE_CRAWLER_IDLE_MAX_MS,
  30_000,
  pollIntervalMs,
  60_000,
);
const leaseSeconds = boundedInteger(process.env.CLIENT_PAGE_CRAWLER_LEASE_SECONDS, 180, 60, 1_800);
const workerConcurrency = boundedInteger(process.env.CLIENT_PAGE_CRAWLER_CONCURRENCY, 2, 1, 5);
const crawlTimeoutMs = boundedInteger(process.env.CLIENT_PAGE_CRAWLER_TIMEOUT_MS, 45_000, 5_000, 120_000);
const maximumBytes = boundedInteger(process.env.CLIENT_PAGE_CRAWLER_MAX_BYTES, 2_500_000, 100_000, 5_000_000);
const retryBaseSeconds = boundedInteger(process.env.CLIENT_PAGE_CRAWLER_RETRY_SECONDS, 60, 15, 86_400);
const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

class ClientPageCrawlLostLeaseError extends Error {
  constructor() {
    super('The Client Center crawler lost its job lease.');
    this.name = 'ClientPageCrawlLostLeaseError';
  }
}

class ClientPageCrawlShutdownError extends Error {
  constructor() {
    super('The Client Center crawler is shutting down.');
    this.name = 'ClientPageCrawlShutdownError';
  }
}

let shuttingDown = false;
let lastRecoveryAt = 0;
let lastLoggedError = '';
let lastLoggedErrorAt = 0;
const activeControllers = new Map<string, AbortController>();

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)
);

const logThrottledError = (scope: string, error: unknown): void => {
  const message = `${scope}: ${errorMessage(error)}`;
  const now = Date.now();
  if (message === lastLoggedError && now - lastLoggedErrorAt < 60_000) return;
  lastLoggedError = message;
  lastLoggedErrorAt = now;
  console.error(`[client-page-crawler] ${message}`);
};

const startHeartbeat = (
  job: ClientPageCrawlJob,
  slotWorkerId: string,
  controller: AbortController,
): (() => void) => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const intervalMs = Math.max(5_000, Math.min(30_000, Math.floor((leaseSeconds * 1_000) / 3)));

  const heartbeat = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return;
    try {
      const owned = await heartbeatClientPageCrawlJob({
        jobId: job.id,
        workerId: slotWorkerId,
        leaseSeconds,
      });
      if (!owned) {
        controller.abort(new ClientPageCrawlLostLeaseError());
        return;
      }
    } catch (error) {
      logThrottledError(`Heartbeat failed for ${job.id}`, error);
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

const executeClaimedJob = async (
  job: ClientPageCrawlJob,
  slotWorkerId: string,
): Promise<void> => {
  const controller = new AbortController();
  activeControllers.set(slotWorkerId, controller);
  const stopHeartbeat = startHeartbeat(job, slotWorkerId, controller);

  try {
    const input = await getClientPageCrawlInput(job);
    if (!input.page.is_enabled) {
      throw new ClientPageCrawlerError({
        code: 'client_page_disabled',
        message: 'The client page was disabled before its crawl started.',
        status: 409,
      });
    }
    if (input.domains.length === 0) {
      throw new ClientPageCrawlerError({
        code: 'client_page_domain_missing',
        message: 'The client has no active domain registered for this page.',
        status: 409,
      });
    }

    const providerResult = await crawlClientPageWithProvider({
      provider: input.provider,
      url: input.page.input_url,
      domains: input.domains.map(domain => ({
        hostname: domain.hostname,
        includeSubdomains: domain.include_subdomains,
      })),
      signal: controller.signal,
      timeoutMs: crawlTimeoutMs,
      maximumBytes,
      onAttempt: async attempt => {
        await recordCrawlerProviderUsageEvent({
          crawlJobId: job.id,
          crawlRunId: job.crawl_run_id,
          clientId: job.client_id,
          pageId: job.page_id,
          requestedBy: job.requested_by,
          jobAttempt: job.attempt_count,
          attempt,
        });
      },
    });
    const result = providerResult.page;
    const persistedPage = { ...result };
    delete persistedPage.contentExcerpt;

    if (controller.signal.reason instanceof ClientPageCrawlLostLeaseError) return;
    const completed = await completeClientPageCrawlJob({
      jobId: job.id,
      workerId: slotWorkerId,
      page: persistedPage,
      resultSummary: {
        extraction: providerResult.provider === 'local'
          ? 'deterministic_html'
          : 'rendered_html',
        provider: providerResult.provider,
        credentialSource: providerResult.credentialSource,
        fallbackReason: providerResult.fallbackReason,
        finalUrl: result.finalUrl,
        httpStatus: result.httpStatus,
        wordCount: result.wordCount,
        redirectCount: result.redirectCount,
        crawlDurationMs: result.crawlDurationMs,
        robotsFollow: result.robotsFollow,
        internalLinks: result.internalLinks,
      },
    });
    if (completed) {
      stopHeartbeat();
      try {
        await indexCompletedClientPage({
          pageId: input.page.id,
          clientId: input.page.client_id,
          inputUrl: input.page.input_url,
          requestedBy: job.requested_by,
          result,
          signal: controller.signal,
        });
      } catch (indexError) {
        logThrottledError(`Semantic indexing failed for ${input.page.id}`, indexError);
      }
      console.log(
        `[client-page-crawler] Completed ${job.id} for ${input.page.input_url};`
        + ` provider=${providerResult.provider}`
        + ` internalLinks=${result.internalLinks.length}.`,
      );
    }
  } catch (error) {
    const abortReason = controller.signal.reason;
    if (
      abortReason instanceof ClientPageCrawlLostLeaseError
      || abortReason instanceof ClientPageCrawlShutdownError
    ) return;

    const crawlerError = error instanceof ClientPageCrawlerError ? error : null;
    const retryable = crawlerError?.retryable ?? true;
    const errorCode = crawlerError?.code || 'client_page_crawl_worker_error';
    const retryDelaySeconds = Math.min(
      86_400,
      retryBaseSeconds * Math.max(1, 2 ** Math.max(0, job.attempt_count - 1)),
    );
    try {
      const failed = await failClientPageCrawlJob({
        jobId: job.id,
        workerId: slotWorkerId,
        errorCode,
        errorMessage: errorMessage(error),
        retryable,
        retryDelaySeconds,
      });
      console.log(`[client-page-crawler] ${failed.status} ${job.id}: ${errorCode}.`);
    } catch (failureError) {
      logThrottledError(`Could not persist failure for ${job.id}`, failureError);
    }
  } finally {
    stopHeartbeat();
    activeControllers.delete(slotWorkerId);
  }
};

const recoverStaleJobsIfDue = async (): Promise<void> => {
  const now = Date.now();
  if (now - lastRecoveryAt < 60_000) return;
  lastRecoveryAt = now;
  try {
    const recovered = await recoverStaleClientPageCrawlJobs(retryBaseSeconds);
    if (recovered > 0) console.log(`[client-page-crawler] Recovered ${recovered} stale job(s).`);
  } catch (error) {
    logThrottledError('Could not recover stale jobs', error);
  }
};

const queueWorker = new AdaptiveQueueWorker<ClientPageCrawlJob>({
  workerName: 'client-page-crawler',
  workerId,
  concurrency: workerConcurrency,
  minimumIdleDelayMs: pollIntervalMs,
  maximumIdleDelayMs: maximumIdlePollIntervalMs,
  isShuttingDown: () => shuttingDown,
  beforeClaim: recoverStaleJobsIfDue,
  claim: slotWorkerId => claimNextClientPageCrawlJob({
    workerId: slotWorkerId,
    leaseSeconds,
  }),
  execute: executeClaimedJob,
  onError: logThrottledError,
});

const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  queueWorker.stop();
  console.log(`[client-page-crawler] Received ${signal}; active jobs will be recovered after lease expiry.`);
  for (const controller of activeControllers.values()) {
    controller.abort(new ClientPageCrawlShutdownError());
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(
  `[client-page-crawler] Started ${workerConcurrency} slot(s) as ${workerId};`
  + ` idlePoll=${pollIntervalMs}-${maximumIdlePollIntervalMs}ms`
  + ` timeout=${crawlTimeoutMs}ms maxBytes=${maximumBytes}.`,
);
const unsubscribeWakeSignal = subscribeToWorkerQueueWakeSignal({
  client: getExternalAnalysisSupabaseAdmin(),
  queueName: 'client_page_crawl',
  subscriberId: workerId,
  onWake: queueWorker.wake,
  onStatus: status => {
    if (status === 'SUBSCRIBED') {
      console.log('[client-page-crawler] Realtime queue wake signal subscribed.');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      logThrottledError('Realtime queue wake signal unavailable; adaptive polling remains active', status);
    }
  },
});
try {
  await queueWorker.run();
} finally {
  unsubscribeWakeSignal();
}
