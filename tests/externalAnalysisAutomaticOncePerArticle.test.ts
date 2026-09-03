import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const sliceFunction = (source: string, name: string, nextMarker: string): string => {
  const start = source.indexOf(`create or replace function public.${name}`);
  const end = source.indexOf(nextMarker, start + 1);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${nextMarker} must follow ${name}`);
  return source.slice(start, end);
};

test('automatic semantic and competitor stages are lifetime-guarded while manual requests bypass the guard', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260829000000_external_analysis_auto_once_per_article.sql',
  );

  assert.match(
    migration,
    /alter function public\.enqueue_external_semantic_analysis_job_controlled\(uuid, text\)[\s\S]*rename to enqueue_external_semantic_analysis_job_by_signature/,
  );
  assert.match(
    migration,
    /alter function public\.enqueue_competitor_discovery_job_controlled\(uuid, uuid, text\)[\s\S]*rename to enqueue_competitor_discovery_job_by_signature/,
  );

  const semantic = sliceFunction(
    migration,
    'enqueue_external_semantic_analysis_job_controlled',
    'create or replace function public.enqueue_competitor_discovery_job_controlled',
  );
  assert.match(semantic, /if not v_manual then/);
  assert.match(semantic, /external-analysis-auto-once:[\s\S]*semantic_keywords_lsi/);
  assert.match(semantic, /find_external_analysis_stage_job/);
  assert.match(semantic, /semanticTargetAttempt,secondaries/);
  assert.match(semantic, /semanticTargetAttempt,lsi/);
  assert.match(semantic, /'needsSecondaries', v_execute_secondaries/);
  assert.match(semantic, /'needsLsi', v_execute_lsi/);
  assert.match(semantic, /else job\.attempt_count \+ 1/);
  assert.match(semantic, /enqueue_external_semantic_analysis_job_by_signature/);

  const competitor = sliceFunction(
    migration,
    'enqueue_competitor_discovery_job_controlled',
    'create or replace function public.enqueue_semantic_followup_after_completion',
  );
  assert.match(competitor, /if not v_manual then/);
  assert.match(competitor, /external-analysis-auto-once:[\s\S]*competitor_discovery/);
  assert.match(competitor, /find_external_analysis_stage_job/);
  assert.match(competitor, /enqueue_competitor_discovery_job_by_signature/);
  assert.match(competitor, /else greatest\(1, job\.attempt_count\)/);
});

test('automatic engineering commands are filtered by article and command across every signature and status', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260829000000_external_analysis_auto_once_per_article.sql',
  );
  const engineeringBase = sliceFunction(
    migration,
    'enqueue_external_engineering_jobs_sequential_base',
    'create or replace function public.enqueue_external_engineering_jobs_sequential_base(\n  p_article_id uuid\n)',
  );

  assert.match(engineeringBase, /p_article_id uuid,\s*p_origin text/);
  assert.match(engineeringBase, /v_origin not in \('auto', 'manual'\)/);
  assert.match(engineeringBase, /if v_origin = 'auto' then/);
  const previousAttemptFilter = engineeringBase.slice(
    engineeringBase.indexOf('where not exists ('),
    engineeringBase.indexOf('else\n    v_command_ids := v_all_command_ids'),
  );
  assert.match(previousAttemptFilter, /previous\.article_id = p_article_id/);
  assert.match(previousAttemptFilter, /previous\.job_type = 'engineering_command'/);
  assert.match(previousAttemptFilter, /previous\.command_id = selected\.command_id/);
  assert.match(previousAttemptFilter, /last_error_code is distinct from 'duplicate_task_suppressed'/);
  assert.match(previousAttemptFilter, /previous\.attempt_count > 0/);
  assert.match(previousAttemptFilter, /previous\.started_at is not null/);
  assert.match(previousAttemptFilter, /previous\.result is not null/);
  assert.doesNotMatch(previousAttemptFilter, /readiness_signature/);
  assert.match(engineeringBase, /else\s*v_command_ids := v_all_command_ids/);
  assert.match(engineeringBase, /'engineering_command',\s*v_origin,/);
  assert.match(engineeringBase, /else greatest\(1, job\.attempt_count\)/);
  assert.match(engineeringBase, /external_analysis_effective_command_ids = to_jsonb\(v_all_command_ids\)/);

  const controlled = sliceFunction(
    migration,
    'enqueue_external_engineering_jobs_controlled',
    'create or replace function public.reset_external_analysis_command_preferences_controlled',
  );
  assert.match(controlled, /enqueue_external_engineering_jobs\(p_article_id, v_origin\)/);
  assert.match(controlled, /if v_origin = 'manual'/);
  assert.match(controlled, /origin = 'manual'/);

  const reset = sliceFunction(
    migration,
    'reset_external_analysis_command_preferences_controlled',
    'create or replace function public.reconcile_automatic_ready_engineering_commands_for_article',
  );
  assert.doesNotMatch(reset, /reset_external_analysis_command_preferences\(/);
  assert.match(reset, /enqueue_external_engineering_jobs_controlled\([\s\S]*v_origin/);
});

test('migration stamps actual semantic runs and treats retries as explicit manual work', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260829000000_external_analysis_auto_once_per_article.sql',
  );

  const runStamp = sliceFunction(
    migration,
    'stamp_external_semantic_run_targets',
    'drop trigger if exists stamp_external_semantic_run_targets',
  );
  assert.match(runStamp, /semanticTargetAttempt/);
  assert.match(migration, /before insert on public\.ai_external_analysis_runs/);
  assert.match(
    migration,
    /update public\.ai_external_analysis_runs as run[\s\S]*'secondaries', true,[\s\S]*'lsi', true/,
  );

  const followup = sliceFunction(
    migration,
    'enqueue_semantic_followup_after_completion',
    'create or replace function public.enqueue_external_engineering_jobs_sequential_base',
  );
  assert.match(
    followup,
    /enqueue_external_semantic_analysis_job_controlled\([\s\S]*new\.article_id,[\s\S]*'auto'/,
  );
  assert.doesNotMatch(followup, /new\.origin = 'manual'/);

  const retry = sliceFunction(
    migration,
    'retry_external_analysis_job',
    'create or replace function public.resume_external_analysis_job_now',
  );
  const resume = sliceFunction(
    migration,
    'resume_external_analysis_job_now',
    'revoke all on function public.find_external_analysis_stage_job',
  );
  for (const manualAction of [retry, resume]) {
    assert.match(manualAction, /origin = 'manual'/);
    assert.match(manualAction, /max_attempts = greatest\(job\.max_attempts, job\.attempt_count \+ 1\)/);
    assert.match(manualAction, /update public\.ai_external_analysis_batches as batch/);
  }

  assert.match(migration, /notify pgrst, 'reload schema';\s*\n\s*commit;/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
});

test('unified semantic migration tracks Google metadata and gates engineering work', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260829080000_unified_semantic_google_metadata.sql',
  );

  const semantic = sliceFunction(
    migration,
    'enqueue_external_semantic_analysis_job_controlled',
    'alter function public.enqueue_external_engineering_jobs_sequential_base',
  );
  assert.match(semantic, /manual_regenerate/);
  assert.match(semantic, /forceRegenerateSemantic/);
  assert.match(semantic, /needsGoogleMetadata/);
  assert.match(semantic, /semanticTargetAttempt,googleMetadata/);
  assert.match(semantic, /automaticOnceTargets/);
  assert.match(semantic, /googleMetadata/);

  const engineering = sliceFunction(
    migration,
    'enqueue_external_engineering_jobs_sequential_base',
    'revoke all on function public.semantic_keywords_have_google_metadata',
  );
  assert.match(engineering, /semantic_keywords_have_google_metadata/);
  assert.match(engineering, /unified_semantic_google_metadata_required/);
  assert.match(engineering, /depends_on_job_id = v_semantic_job_id/);
  assert.match(migration, /drop trigger if exists enqueue_article_meta_description_from_article/);
  assert.match(migration, /ready_status_meta_description_retired/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
});

test('unified semantic targets are reconciled for ready articles without opening the editor', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260830000000_reconcile_unified_semantic_automation.sql',
  );

  assert.match(migration, /^begin;/);
  assert.match(migration, /select public\.reconcile_content_research_automation\(\);/);
  assert.match(migration, /select public\.reconcile_ready_engineering_command_automation\(\);/);
  assert.match(migration, /article UPDATE/);
  assert.match(migration, /editor's first save after opening it/);
  assert.match(migration, /commit;\s*$/);
});

test('schedulable external-analysis jobs cannot retain terminal dead-letter state', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260906000000_external_analysis_requeue_invariant.sql',
  );

  const normalizer = sliceFunction(
    migration,
    'normalize_external_analysis_requeue_state',
    'drop trigger if exists normalize_external_analysis_requeue_state',
  );
  assert.match(normalizer, /new\.status in \([\s\S]*'waiting_for_prerequisites'[\s\S]*'queued'[\s\S]*'retry_scheduled'/);
  assert.match(normalizer, /new\.dead_lettered_at := null/);
  assert.match(normalizer, /new\.dead_letter_reason := null/);
  assert.match(normalizer, /old\.status in \('completed', 'failed', 'blocked', 'cancelled'\)/);
  assert.match(normalizer, /new\.max_attempts := greatest\(new\.max_attempts, new\.attempt_count \+ 1\)/);

  assert.match(migration, /before insert or update\s+on public\.ai_external_analysis_jobs/);
  assert.match(migration, /where job\.status in \([\s\S]*and job\.dead_lettered_at is not null/);
  assert.match(migration, /live_descendant_waiting_on_exhausted_dependency/);
  assert.match(migration, /dependency\.last_error_code\)[\s\S]*external_analysis_attempt_budget_exhausted/);
  assert.match(migration, /child\.depends_on_job_id = dependency\.id/);
  assert.match(migration, /ai_external_analysis_jobs_schedulable_not_dead/);
  assert.match(migration, /validate constraint ai_external_analysis_jobs_schedulable_not_dead/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
  assert.match(migration.trim(), /commit;$/);
});

test('requeue migration repairs live jobs and exhausted dependencies without reviving cancellation requests', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.ai_external_analysis_jobs (
        id uuid primary key,
        article_id uuid not null,
        job_type text not null,
        command_id text,
        origin text not null,
        pipeline_parent_job_id uuid,
        depends_on_job_id uuid references public.ai_external_analysis_jobs(id),
        status text not null,
        result jsonb,
        progress jsonb not null default '{}'::jsonb,
        last_error text,
        last_error_code text,
        attempt_count integer not null default 0,
        max_attempts integer not null default 1,
        next_attempt_at timestamptz,
        locked_by text,
        locked_at timestamptz,
        lease_expires_at timestamptz,
        cancel_requested_at timestamptz,
        completed_at timestamptz,
        dead_lettered_at timestamptz,
        dead_letter_reason text,
        updated_at timestamptz not null default now()
      );
      create function public.article_automatic_job_allowed(uuid, text, text)
      returns boolean language sql immutable as 'select true';

      insert into public.ai_external_analysis_jobs (
        id, article_id, job_type, origin, status, attempt_count, max_attempts,
        next_attempt_at, completed_at, dead_lettered_at, dead_letter_reason
      ) values
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000010',
          'semantic_keywords_lsi', 'manual', 'queued', 1, 1, now(), now(), now(),
          'external_analysis_attempt_budget_exhausted'),
        ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000020',
          'engineering_command', 'auto', 'blocked', 1, 1, null, now(), now(),
          'external_analysis_attempt_budget_exhausted'),
        ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000030',
          'semantic_keywords_lsi', 'manual', 'queued', 1, 1, now(), now(), now(),
          'external_analysis_attempt_budget_exhausted');
      update public.ai_external_analysis_jobs
      set cancel_requested_at = now()
      where id = '00000000-0000-4000-8000-000000000004';
      insert into public.ai_external_analysis_jobs (
        id, article_id, job_type, origin, status, depends_on_job_id
      ) values (
        '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000020',
        'engineering_command', 'auto', 'waiting_for_prerequisites',
        '00000000-0000-4000-8000-000000000002'
      );
    `);

    await db.exec(await readWorkspaceFile(
      'supabase/migrations/20260906000000_external_analysis_requeue_invariant.sql',
    ));

    const rows = await db.query<{
      id: string;
      status: string;
      attempt_count: number;
      max_attempts: number;
      dead_lettered_at: string | null;
      cancel_requested_at: string | null;
    }>('select id, status, attempt_count, max_attempts, dead_lettered_at, cancel_requested_at from public.ai_external_analysis_jobs order by id');
    const byId = new Map(rows.rows.map(row => [row.id, row]));
    assert.equal(byId.get('00000000-0000-4000-8000-000000000001')?.dead_lettered_at, null);
    assert.equal(byId.get('00000000-0000-4000-8000-000000000001')?.max_attempts, 2);
    assert.equal(byId.get('00000000-0000-4000-8000-000000000002')?.status, 'queued');
    assert.equal(byId.get('00000000-0000-4000-8000-000000000002')?.dead_lettered_at, null);
    assert.equal(byId.get('00000000-0000-4000-8000-000000000002')?.max_attempts, 2);
    assert.ok(byId.get('00000000-0000-4000-8000-000000000004')?.cancel_requested_at);
    assert.equal(byId.get('00000000-0000-4000-8000-000000000004')?.max_attempts, 1);

    await db.exec(`
      update public.ai_external_analysis_jobs
      set status = 'blocked', dead_lettered_at = now(),
        dead_letter_reason = 'external_analysis_attempt_budget_exhausted', max_attempts = 1
      where id = '00000000-0000-4000-8000-000000000001';
      update public.ai_external_analysis_jobs set status = 'queued'
      where id = '00000000-0000-4000-8000-000000000001';
    `);
    const normalized = (await db.query<{
      status: string; max_attempts: number; dead_lettered_at: string | null;
    }>(`select status, max_attempts, dead_lettered_at from public.ai_external_analysis_jobs
      where id = '00000000-0000-4000-8000-000000000001'`)).rows[0];
    assert.equal(normalized.status, 'queued');
    assert.equal(normalized.dead_lettered_at, null);
    assert.equal(normalized.max_attempts, 2);
  } finally {
    await db.close();
  }
});

test('only a started prior attempt blocks the same automatic command, regardless of outcome or origin', () => {
  const previous: Array<{
    commandId: string;
    status: string;
    origin: string;
    attemptCount: number;
    startedAt: string | null;
    result: unknown;
  }> = [
    {
      commandId: 'competitorContentComparison', status: 'cancelled', origin: 'auto',
      attemptCount: 0, startedAt: null, result: null,
    },
    {
      commandId: 'repetitionAndFillerAudit', status: 'failed', origin: 'manual',
      attemptCount: 1, startedAt: '2026-08-29T10:00:00.000Z', result: null,
    },
  ];
  const selected = [
    'competitorContentComparison',
    'repetitionAndFillerAudit',
    'fullArticleAudit',
  ];
  const automatic = selected.filter(
    commandId => !previous.some(job => (
      job.commandId === commandId
      && (job.attemptCount > 0 || job.startedAt !== null || job.result !== null)
    )),
  );

  assert.deepEqual(automatic, ['competitorContentComparison', 'fullArticleAudit']);
});

test('semantic automation attempts newly enabled targets without rerunning an attempted target', () => {
  const selectTargets = (
    needs: { secondaries: boolean; lsi: boolean; googleMetadata: boolean },
    attempted: { secondaries: boolean; lsi: boolean; googleMetadata: boolean },
  ) => ({
    secondaries: needs.secondaries && !attempted.secondaries,
    lsi: needs.lsi && !attempted.lsi,
    googleMetadata: needs.googleMetadata && !attempted.googleMetadata,
  });

  assert.deepEqual(
    selectTargets(
      { secondaries: true, lsi: true, googleMetadata: true },
      { secondaries: true, lsi: false, googleMetadata: false },
    ),
    { secondaries: false, lsi: true, googleMetadata: true },
  );
  assert.deepEqual(
    selectTargets(
      { secondaries: true, lsi: true, googleMetadata: true },
      { secondaries: true, lsi: true, googleMetadata: true },
    ),
    { secondaries: false, lsi: false, googleMetadata: false },
  );
});
