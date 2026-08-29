import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AdaptiveQueueWorker,
  calculateAdaptiveIdleDelay,
  estimateMaximumIdleClaimsPerHour,
} from '../server/adaptiveQueueWorker.ts';
import {
  LeaseHeartbeatController,
  type LeaseHeartbeatScheduler,
} from '../server/leaseHeartbeatController.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('idle delay grows exponentially and remains bounded at thirty seconds', () => {
  const delays = [1, 2, 3, 4, 5, 6, 7].map(consecutiveMisses => (
    calculateAdaptiveIdleDelay({
      minimumIdleDelayMs: 1_500,
      maximumIdleDelayMs: 30_000,
      consecutiveMisses,
      randomValue: 0.5,
    })
  ));

  assert.deepEqual(delays, [1_500, 3_000, 6_000, 12_000, 24_000, 30_000, 30_000]);
  assert.equal(estimateMaximumIdleClaimsPerHour(5, 30_000), 600);
});

test('one coordinator polls an empty queue regardless of execution concurrency', async () => {
  let claimCalls = 0;
  let worker: AdaptiveQueueWorker<{ id: string }>;
  worker = new AdaptiveQueueWorker<{ id: string }>({
    workerName: 'test-worker',
    workerId: 'test',
    concurrency: 5,
    minimumIdleDelayMs: 1,
    maximumIdleDelayMs: 2,
    random: () => 0.5,
    isShuttingDown: () => false,
    claim: async () => {
      claimCalls += 1;
      if (claimCalls === 4) worker.stop();
      return null;
    },
    execute: async (): Promise<void> => undefined,
    onError: (_scope, error) => {
      throw error;
    },
  });

  await worker.run();
  assert.equal(claimCalls, 4);
});

test('the coordinator still fills every execution slot when work exists', async () => {
  const jobs = [{ id: '1' }, { id: '2' }, { id: '3' }];
  let activeExecutions = 0;
  let maximumActiveExecutions = 0;
  let completed = 0;
  let worker: AdaptiveQueueWorker<{ id: string }>;

  worker = new AdaptiveQueueWorker<{ id: string }>({
    workerName: 'parallel-test-worker',
    workerId: 'parallel-test',
    concurrency: 2,
    minimumIdleDelayMs: 1,
    maximumIdleDelayMs: 2,
    random: () => 0.5,
    isShuttingDown: () => false,
    claim: async () => jobs.shift() || null,
    execute: async () => {
      activeExecutions += 1;
      maximumActiveExecutions = Math.max(maximumActiveExecutions, activeExecutions);
      await new Promise(resolve => setTimeout(resolve, 2));
      activeExecutions -= 1;
      completed += 1;
      if (completed === 3) worker.stop();
    },
    onError: (_scope, error) => {
      throw error;
    },
  });

  await worker.run();
  assert.equal(completed, 3);
  assert.equal(maximumActiveExecutions, 2);
});

test('shared lease heartbeat renews serially and fences lost ownership', async () => {
  let now = 1_000;
  let renewalCount = 0;
  let scheduled: { callback: () => void; cancelled: boolean } | null = null;
  const scheduler: LeaseHeartbeatScheduler = {
    now: () => now,
    schedule: callback => {
      scheduled = { callback, cancelled: false };
      return scheduled;
    },
    cancel: handle => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
  };
  const controller = new AbortController();
  const stop = new LeaseHeartbeatController({
    controller,
    leaseDurationMs: 300,
    intervalMs: 100,
    renewLease: async () => ({ owned: ++renewalCount < 2 }),
    resolveAbortReason: state => state.owned ? null : new Error('lost-lease'),
    resolveExpiredLeaseReason: () => new Error('expired-lease'),
    scheduler,
  }).start();

  assert.ok(scheduled);
  scheduled.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renewalCount, 1);
  assert.equal(controller.signal.aborted, false);
  assert.ok(scheduled);

  scheduled.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renewalCount, 2);
  assert.equal(controller.signal.aborted, true);
  assert.equal((controller.signal.reason as Error).message, 'lost-lease');
  stop();
  now += 1;
});

test('shared lease heartbeat stop clears the pending renewal timer', () => {
  let scheduled: { cancelled: boolean } | null = null;
  const stop = new LeaseHeartbeatController({
    controller: new AbortController(),
    leaseDurationMs: 300,
    intervalMs: 100,
    renewLease: async () => true,
    resolveAbortReason: () => null,
    scheduler: {
      now: () => 0,
      schedule: () => {
        scheduled = { cancelled: false };
        return scheduled;
      },
      cancel: handle => {
        (handle as { cancelled: boolean }).cancelled = true;
      },
    },
  }).start();

  assert.ok(scheduled);
  stop();
  assert.equal(scheduled.cancelled, true);
});

test('shared lease heartbeat applies the queue-specific lease-expiry fallback', async () => {
  let now = 0;
  let scheduled: { callback: () => void } | null = null;
  const controller = new AbortController();
  new LeaseHeartbeatController({
    controller,
    leaseDurationMs: 100,
    intervalMs: 50,
    renewLease: async () => {
      throw new Error('database unavailable');
    },
    resolveAbortReason: () => null,
    resolveExpiredLeaseReason: () => new Error('expired-lease'),
    scheduler: {
      now: () => now,
      schedule: callback => {
        scheduled = { callback };
        return scheduled;
      },
      cancel: () => undefined,
    },
  }).start();

  now = 100;
  assert.ok(scheduled);
  scheduled.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.signal.aborted, true);
  assert.equal((controller.signal.reason as Error).message, 'expired-lease');
});

test('all durable workers use adaptive polling and lightweight Realtime wake signals', async () => {
  const [
    externalWorker,
    aiWorker,
    writingWorker,
    crawlerWorker,
    ecosystem,
    migration,
    deploymentEnvironment,
  ] = await Promise.all([
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
    readWorkspaceFile('server/aiJobWorker.ts'),
    readWorkspaceFile('server/contentWritingWorker.ts'),
    readWorkspaceFile('server/clientPageCrawlWorker.ts'),
    readWorkspaceFile('ecosystem.config.cjs'),
    readWorkspaceFile('supabase/migrations/20260728020000_worker_queue_wake_signals.sql'),
    readWorkspaceFile('deploy/env.server.example'),
  ]);

  for (const workerSource of [externalWorker, aiWorker, writingWorker, crawlerWorker]) {
    assert.match(workerSource, /new AdaptiveQueueWorker/);
    assert.match(workerSource, /new LeaseHeartbeatController/);
    assert.match(workerSource, /subscribeToWorkerQueueWakeSignal/);
    assert.doesNotMatch(workerSource, /runWorkerSlot/);
    assert.doesNotMatch(workerSource, /const start(?:Lease)?Heartbeat\s*=/);
  }

  assert.match(externalWorker, /queueName: 'external_analysis'/);
  assert.match(aiWorker, /queueName: 'ai_jobs'/);
  assert.match(writingWorker, /queueName: 'content_writing'/);
  assert.match(crawlerWorker, /queueName: 'client_page_crawl'/);
  assert.equal((ecosystem.match(/^\s*[A-Z_]+IDLE_MAX_MS:/gm) || []).length, 7);
  assert.match(deploymentEnvironment, /AI_JOB_WORKER_IDLE_MAX_MS=30000/);
  assert.match(deploymentEnvironment, /CONTENT_WRITING_WORKER_IDLE_MAX_MS=30000/);

  assert.match(migration, /create table if not exists public\.worker_queue_signals/);
  assert.match(migration, /alter publication supabase_realtime add table public\.worker_queue_signals/);
  assert.doesNotMatch(migration, /add table public\.(ai_jobs|content_writing_sessions|client_page_crawl_jobs|ai_external_analysis_jobs)/);
  for (const queueTable of [
    'ai_jobs',
    'content_writing_sessions',
    'client_page_crawl_jobs',
    'ai_external_analysis_jobs',
  ]) {
    assert.match(migration, new RegExp(`on public\\.${queueTable}`));
  }
});
