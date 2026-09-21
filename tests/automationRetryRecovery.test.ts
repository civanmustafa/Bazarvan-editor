import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('automation recovery migration distinguishes transient failures and bounds delayed recovery', async () => {
  const migration = await readFile(
    path.join(root, 'supabase', 'migrations', '20260921000000_automation_retry_recovery.sql'),
    'utf8',
  );

  assert.match(migration, /automation_failure_is_retryable/);
  assert.match(migration, /no valid competitor[\s\S]*then false/i);
  assert.match(migration, /quota\|rate\.\?limit[\s\S]*then true/i);
  assert.match(migration, /recovery_count < 3/);
  assert.match(migration, /interval '1 hour'[\s\S]*interval '6 hours'[\s\S]*interval '24 hours'/);
  assert.match(migration, /job_type <> 'full_article_pipeline'/);
});

test('automation recovery migration restores readiness and prevents preparation starvation', async () => {
  const migration = await readFile(
    path.join(root, 'supabase', 'migrations', '20260921000000_automation_retry_recovery.sql'),
    'utf8',
  );

  assert.match(migration, /where not exists \([\s\S]*ai_external_analysis_article_state/);
  assert.match(migration, /prevent_duplicate_automatic_writing_preparation/);
  assert.match(migration, /previous\.status = 'cancelled'[\s\S]*previous\.attempt_count > 0/);
  assert.match(migration, /terminal_preparation[\s\S]*readiness_signature = md5/);
  assert.match(migration, /competitor_discovery_ready is true/);
  assert.match(migration, /ensure_automatic_external_analysis_retry_budget/);
  assert.match(migration, /greatest\(coalesce\(new\.max_attempts, 1\)[\s\S]*6\)/);
});

test('recoverable admin action remains server-only and excludes permanent failures', async () => {
  const migration = await readFile(
    path.join(root, 'supabase', 'migrations', '20260921000000_automation_retry_recovery.sql'),
    'utf8',
  );
  const api = await readFile(path.join(root, 'api', 'contentWritingAutomation.ts'), 'utf8');

  assert.match(migration, /requeue_recoverable_automation_failures/);
  assert.match(migration, /profile\.role = 'admin'/);
  assert.match(migration, /revoke all on function public\.requeue_recoverable_automation_failures[\s\S]*anon, authenticated/);
  assert.match(migration, /grant execute on function public\.requeue_recoverable_automation_failures[\s\S]*service_role/);
  assert.match(api, /action === 'retry_recoverable'[\s\S]*principal\.role !== 'admin'/);
});

test('durable master coordinator tracks independent stages and is reconciled by the worker', async () => {
  const [migration, worker, queue] = await Promise.all([
    readFile(path.join(root, 'supabase', 'migrations', '20260922000000_durable_automation_coordinator_and_competitor_tiers.sql'), 'utf8'),
    readFile(path.join(root, 'server', 'externalAnalysisWorker.ts'), 'utf8'),
    readFile(path.join(root, 'server', 'externalAnalysisQueue.ts'), 'utf8'),
  ]);

  assert.match(migration, /create table if not exists public\.article_automation_stage_states/);
  assert.match(migration, /semantic_keywords_lsi'[\s\S]*competitor_discovery'[\s\S]*competitor_extraction'[\s\S]*content_writing'/);
  assert.match(migration, /attempt_count[\s\S]*retry_count[\s\S]*max_attempts[\s\S]*next_attempt_at/);
  assert.match(migration, /create or replace function public\.reconcile_article_automation_coordinator/);
  assert.match(migration, /enqueue_external_semantic_analysis_job_controlled/);
  assert.match(migration, /enqueue_automatic_competitor_extraction_for_discovery/);
  assert.match(migration, /enqueue_next_automatic_writing_competitor_preparation/);
  assert.match(queue, /reconcileArticleAutomationCoordinator/);
  assert.match(worker, /await reconcileArticleAutomationCoordinator\(\)/);
});
