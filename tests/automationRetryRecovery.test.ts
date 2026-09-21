import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
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

test('terminal dependency guard covers children created or requeued after the parent stopped', async () => {
  const migration = await readFile(
    path.join(root, 'supabase', 'migrations', '20260922010000_enforce_external_dependency_on_child.sql'),
    'utf8',
  );

  assert.match(migration, /before insert or update of status, depends_on_job_id/);
  assert.match(migration, /create index if not exists ai_external_analysis_jobs_dependency_idx/);
  assert.match(migration, /v_dependency\.status not in \('failed', 'blocked', 'cancelled'\)/);
  assert.match(migration, /external_analysis_dependency_terminal/);
  assert.match(migration, /from public\.ai_external_analysis_jobs as dependency[\s\S]*child\.depends_on_job_id = dependency\.id/);
  assert.match(migration, /revoke all on function public\.enforce_external_analysis_dependency_on_child\(\)/);
});

test('terminal dependency child guard executes in PostgreSQL and repairs old rows', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(),
        depends_on_job_id uuid references public.ai_external_analysis_jobs(id),
        status text not null,
        cancel_requested_at timestamptz,
        next_attempt_at timestamptz,
        locked_by text,
        locked_at timestamptz,
        lease_expires_at timestamptz,
        completed_at timestamptz,
        last_error_code text,
        last_error text,
        dead_letter_reason text,
        progress jsonb not null default '{}'::jsonb,
        updated_at timestamptz not null default now()
      );
      insert into public.ai_external_analysis_jobs(id, status, last_error_code)
      values ('00000000-0000-4000-8000-000000000001', 'blocked', 'upstream_failed');
      insert into public.ai_external_analysis_jobs(id, depends_on_job_id, status)
      values (
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000001',
        'waiting_for_prerequisites'
      );
    `);
    const migration = await readFile(
      path.join(root, 'supabase', 'migrations', '20260922010000_enforce_external_dependency_on_child.sql'),
      'utf8',
    );
    await db.exec(migration);
    const repaired = await db.query<{ status: string; last_error_code: string }>(`
      select status, last_error_code from public.ai_external_analysis_jobs
      where id = '00000000-0000-4000-8000-000000000002'
    `);
    assert.deepEqual(repaired.rows[0], {
      status: 'blocked',
      last_error_code: 'external_analysis_dependency_terminal',
    });

    await db.exec(`
      insert into public.ai_external_analysis_jobs(id, depends_on_job_id, status)
      values (
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000001',
        'queued'
      );
    `);
    const guarded = await db.query<{ status: string; last_error_code: string }>(`
      select status, last_error_code from public.ai_external_analysis_jobs
      where id = '00000000-0000-4000-8000-000000000003'
    `);
    assert.deepEqual(guarded.rows[0], {
      status: 'blocked',
      last_error_code: 'external_analysis_dependency_terminal',
    });
  } finally {
    await db.close();
  }
});
