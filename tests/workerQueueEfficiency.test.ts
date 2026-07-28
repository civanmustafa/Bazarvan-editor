import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AdaptiveQueueWorker,
  calculateAdaptiveIdleDelay,
  estimateMaximumIdleClaimsPerHour,
} from '../server/adaptiveQueueWorker.ts';

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
    assert.match(workerSource, /subscribeToWorkerQueueWakeSignal/);
    assert.doesNotMatch(workerSource, /runWorkerSlot/);
  }

  assert.match(externalWorker, /queueName: 'external_analysis'/);
  assert.match(aiWorker, /queueName: 'ai_jobs'/);
  assert.match(writingWorker, /queueName: 'content_writing'/);
  assert.match(crawlerWorker, /queueName: 'client_page_crawl'/);
  assert.equal((ecosystem.match(/^\s*[A-Z_]+IDLE_MAX_MS:/gm) || []).length, 5);
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
