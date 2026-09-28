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

test('automatic writing retries resume the same safe session before claiming a replacement', async () => {
  const [migration, scheduler, presentation] = await Promise.all([
    readFile(path.join(root, 'supabase', 'migrations', '20260930000000_automatic_content_writing_session_resume.sql'), 'utf8'),
    readFile(path.join(root, 'server', 'contentWritingAutomation.ts'), 'utf8'),
    readFile(path.join(root, 'components', 'ContentWritingAutomationArticleStatus.tsx'), 'utf8'),
  ]);

  assert.match(migration, /resume_next_automatic_content_writing_session/);
  assert.match(migration, /step\.status in \('running', 'failed'\)/);
  assert.match(migration, /automationReadinessSignature/);
  assert.match(migration, /v_readiness[\s\S]*readiness_signature/);
  assert.doesNotMatch(migration, /session_sequence\s*=\s*[^,;]+\+/);
  assert.ok(
    scheduler.indexOf('resumeDueAutomaticContentWritingSession()')
      < scheduler.indexOf('claimNextItem(workerId, settings)'),
  );
  assert.match(presentation, /جار استئناف الكتابة تلقائيًا/);
  assert.match(presentation, /لم تتجاوز سياسة الجودة\./);
});

test('automatic writing resume preserves completed steps and rejects changed inputs', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.content_writing_automation_state (
        singleton boolean primary key,
        next_allowed_at timestamptz,
        last_item_id uuid,
        last_session_id uuid,
        last_article_id uuid,
        last_outcome text,
        updated_at timestamptz default now()
      );
      create table public.content_writing_sessions (
        id uuid primary key,
        article_id uuid not null,
        created_by uuid not null,
        provider text not null,
        model text not null default '',
        status text not null,
        execution_mode text not null default 'api',
        idempotency_key text not null,
        context_snapshot jsonb not null default '{}'::jsonb,
        progress jsonb not null default '{}'::jsonb,
        response_metadata jsonb not null default '{}'::jsonb,
        last_error_code text,
        last_error text,
        next_attempt_at timestamptz default now(),
        locked_by text,
        locked_at timestamptz,
        lease_expires_at timestamptz,
        cancel_requested_at timestamptz,
        completed_at timestamptz
      );
      create table public.content_writing_automation_items (
        id uuid primary key,
        article_id uuid not null,
        requested_by uuid not null,
        status text not null,
        readiness_signature text not null,
        provider text not null,
        model text not null default '',
        content_writing_session_id uuid,
        run_generation integer not null,
        session_sequence integer not null,
        attempt_count integer not null,
        max_attempts integer not null,
        ready_at timestamptz not null,
        eligible_at timestamptz not null,
        locked_by text,
        locked_at timestamptz,
        lease_expires_at timestamptz,
        last_error_code text,
        last_error text,
        completed_at timestamptz
      );
      create table public.content_writing_steps (
        id uuid primary key,
        session_id uuid not null,
        step_key text not null,
        status text not null,
        output_text text,
        last_error_code text,
        last_error text,
        completed_at timestamptz
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key,
        job_type text not null,
        status text not null,
        next_attempt_at timestamptz
      );
      create table public.resume_readiness_control (
        signature text not null,
        ready boolean not null
      );
      insert into public.resume_readiness_control values ('stable-signature', true);
      create function public.article_automatic_job_allowed(uuid, text, text default null)
      returns boolean language sql stable as $$ select true $$;
      create function public.evaluate_content_writing_automation_readiness(uuid)
      returns jsonb language sql stable as $$
        select jsonb_build_object('ready', ready, 'signature', signature)
        from public.resume_readiness_control limit 1
      $$;

      insert into public.content_writing_automation_state(singleton, next_allowed_at)
      values (true, now() - interval '1 minute');
      insert into public.content_writing_sessions(
        id, article_id, created_by, provider, status, idempotency_key,
        context_snapshot, last_error_code, last_error, completed_at
      ) values (
        '00000000-0000-4000-8000-000000000010',
        '00000000-0000-4000-8000-000000000020',
        '00000000-0000-4000-8000-000000000030',
        'gemini', 'failed',
        'auto-ready:00000000-0000-4000-8000-000000000040:1:1',
        jsonb_build_object(
          'triggerSource', 'automatic_ready',
          'automationItemId', '00000000-0000-4000-8000-000000000040',
          'automationRunGeneration', 1,
          'automationSessionSequence', 1,
          'automationReadinessSignature', 'stable-signature'
        ),
        'content_writing_step_output_invalid', 'Invalid JSON', now()
      );
      insert into public.content_writing_automation_items(
        id, article_id, requested_by, status, readiness_signature, provider,
        content_writing_session_id, run_generation, session_sequence,
        attempt_count, max_attempts, ready_at, eligible_at,
        last_error_code, last_error
      ) values (
        '00000000-0000-4000-8000-000000000040',
        '00000000-0000-4000-8000-000000000020',
        '00000000-0000-4000-8000-000000000030',
        'ready', 'stable-signature', 'gemini',
        '00000000-0000-4000-8000-000000000010', 1, 1,
        1, 3, now() - interval '10 minutes', now() - interval '1 minute',
        'content_writing_step_output_invalid', 'Invalid JSON'
      );
      insert into public.content_writing_steps(
        id, session_id, step_key, status, output_text, last_error_code, last_error, completed_at
      ) values
        ('00000000-0000-4000-8000-000000000050', '00000000-0000-4000-8000-000000000010',
          'outline', 'completed', 'saved outline', null, null, now()),
        ('00000000-0000-4000-8000-000000000060', '00000000-0000-4000-8000-000000000010',
          'competitor_index', 'failed', 'malformed raw output', 'content_writing_step_output_invalid', 'Invalid JSON', now());
    `);

    const migration = await readFile(
      path.join(root, 'supabase', 'migrations', '20260930000000_automatic_content_writing_session_resume.sql'),
      'utf8',
    );
    await db.exec(migration);

    const resumed = await db.query<{ session_id: string | null }>(`
      select public.resume_next_automatic_content_writing_session()::text as session_id
    `);
    assert.equal(resumed.rows[0].session_id, '00000000-0000-4000-8000-000000000010');

    const session = await db.query<{
      status: string;
      automatic_resume: string;
      previous_error: string;
    }>(`
      select status,
        progress ->> 'automaticResume' as automatic_resume,
        response_metadata #>> '{automaticResume,previousErrorCode}' as previous_error
      from public.content_writing_sessions
      where id = '00000000-0000-4000-8000-000000000010'
    `);
    assert.deepEqual(session.rows[0], {
      status: 'retry_scheduled',
      automatic_resume: 'true',
      previous_error: 'content_writing_step_output_invalid',
    });

    const item = await db.query<{ status: string; attempt_count: number; session_sequence: number }>(`
      select status, attempt_count, session_sequence
      from public.content_writing_automation_items
      where id = '00000000-0000-4000-8000-000000000040'
    `);
    assert.deepEqual(item.rows[0], { status: 'writing', attempt_count: 2, session_sequence: 1 });

    const steps = await db.query<{ step_key: string; status: string; output_text: string }>(`
      select step_key, status, output_text
      from public.content_writing_steps order by step_key
    `);
    assert.deepEqual(steps.rows, [
      { step_key: 'competitor_index', status: 'pending', output_text: 'malformed raw output' },
      { step_key: 'outline', status: 'completed', output_text: 'saved outline' },
    ]);

    await db.exec(`
      update public.resume_readiness_control set signature = 'changed-signature';
      update public.content_writing_sessions
      set status = 'failed', last_error_code = 'content_writing_step_output_invalid',
          last_error = 'Invalid JSON', completed_at = now()
      where id = '00000000-0000-4000-8000-000000000010';
      update public.content_writing_automation_items
      set status = 'ready', eligible_at = now() - interval '1 minute'
      where id = '00000000-0000-4000-8000-000000000040';
    `);
    const changedInput = await db.query<{ session_id: string | null }>(`
      select public.resume_next_automatic_content_writing_session()::text as session_id
    `);
    assert.equal(changedInput.rows[0].session_id, null);
  } finally {
    await db.close();
  }
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

test('workers automatically requeue only bounded recoverable failures without an administrator click', async () => {
  const [migration, worker, queue] = await Promise.all([
    readFile(path.join(root, 'supabase', 'migrations', '20261003000000_automation_inventory_completion_and_auto_recovery.sql'), 'utf8'),
    readFile(path.join(root, 'server', 'externalAnalysisWorker.ts'), 'utf8'),
    readFile(path.join(root, 'server', 'externalAnalysisQueue.ts'), 'utf8'),
  ]);

  assert.match(migration, /auto_requeue_recoverable_automation_failures/);
  assert.match(migration, /automation_failure_is_retryable/);
  assert.match(migration, /automaticRecoveryCount'[\s\S]*< 3/);
  assert.match(migration, /item\.failure_class = 'transient'[\s\S]*item\.recovery_count < 3/);
  assert.match(migration, /job_type <> 'full_article_pipeline'/);
  assert.match(migration, /revoke all on function public\.auto_requeue_recoverable_automation_failures[\s\S]*anon, authenticated/);
  assert.match(migration, /grant execute on function public\.auto_requeue_recoverable_automation_failures[\s\S]*service_role/);
  assert.match(queue, /autoRequeueRecoverableAutomationFailures/);
  assert.match(worker, /await autoRequeueRecoverableAutomationFailures\(50\)/);
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
