import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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

test('only a started prior attempt blocks the same automatic command, regardless of outcome or origin', () => {
  const previous = [
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
    needs: { secondaries: boolean; lsi: boolean },
    attempted: { secondaries: boolean; lsi: boolean },
  ) => ({
    secondaries: needs.secondaries && !attempted.secondaries,
    lsi: needs.lsi && !attempted.lsi,
  });

  assert.deepEqual(
    selectTargets(
      { secondaries: true, lsi: true },
      { secondaries: true, lsi: false },
    ),
    { secondaries: false, lsi: true },
  );
  assert.deepEqual(
    selectTargets(
      { secondaries: true, lsi: true },
      { secondaries: true, lsi: true },
    ),
    { secondaries: false, lsi: false },
  );
});
