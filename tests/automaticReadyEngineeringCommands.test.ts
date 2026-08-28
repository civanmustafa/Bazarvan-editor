import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const sliceFunction = (source: string, name: string, nextName: string): string => {
  const start = source.indexOf(`create or replace function public.${name}`);
  const end = source.indexOf(`create or replace function public.${nextName}`, start + 1);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return source.slice(start, end);
};

test('ready engineering commands are queued by persisted database state without opening the editor', async () => {
  const [migration, settingsRegistry, settingsPage] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260828020000_automatic_ready_engineering_commands.sql'),
    readWorkspaceFile('constants/settingsRegistry.ts'),
    readWorkspaceFile('components/SettingsPage.tsx'),
  ]);

  assert.match(migration, /'autoRunReadyEngineeringCommands', true/);
  assert.match(settingsRegistry, /autoRunReadyEngineeringCommands: true/);
  assert.match(settingsPage, /تشغيل الأوامر اليدوية الجاهزة تلقائيًا/);
  assert.match(settingsPage, /حتى دون فتح المقالة/);
  assert.match(
    settingsPage,
    /updateSetting\('system', 'autoRunReadyEngineeringCommands'/,
  );

  assert.match(
    migration,
    /create trigger enqueue_external_engineering_jobs\s+after insert or update of external_analysis_ready, external_analysis_readiness_signature\s+on public\.ai_external_analysis_article_state/,
  );
  assert.match(
    migration,
    /execute function public\.enqueue_external_engineering_jobs_from_state\(\)/,
  );

  const articleCoordinator = sliceFunction(
    migration,
    'reconcile_automatic_ready_engineering_commands_for_article',
    'enqueue_external_engineering_jobs_from_state',
  );
  assert.match(
    articleCoordinator,
    /pg_advisory_xact_lock\(hashtextextended\('ready-engineering-command-automation', 0\)\)[\s\S]*v_settings := public\.get_content_research_automation_settings\(\)/,
  );
  assert.match(articleCoordinator, /autoRunReadyEngineeringCommands/);
  assert.match(articleCoordinator, /enqueue_external_engineering_jobs\(p_article_id\)/);
  assert.match(articleCoordinator, /enqueue_external_semantic_analysis_job_controlled\(p_article_id, 'auto'\)/);

  const settingsCoordinator = sliceFunction(
    migration,
    'reconcile_ready_engineering_command_automation',
    'reconcile_ready_engineering_commands_from_settings',
  );
  assert.match(
    settingsCoordinator,
    /pg_advisory_xact_lock\(hashtextextended\('ready-engineering-command-automation', 0\)\)[\s\S]*v_enabled := coalesce/,
  );
  assert.match(settingsCoordinator, /where state\.external_analysis_ready/);
  assert.match(
    settingsCoordinator,
    /reconcile_automatic_ready_engineering_commands_for_article\(v_article_id\)/,
  );
  assert.match(migration, /trigger reconcile_ready_engineering_commands_from_settings/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
});

test('disabling ready-command automation cancels auto work only and manual API requests are promoted atomically', async () => {
  const [migration, api, workerGuard, executor] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260828020000_automatic_ready_engineering_commands.sql'),
    readWorkspaceFile('api/externalAnalysis.ts'),
    readWorkspaceFile('server/contentResearchAutomationGuard.ts'),
    readWorkspaceFile('server/externalEngineeringAnalysisExecutor.ts'),
  ]);

  const cancellation = sliceFunction(
    migration,
    'cancel_automatic_ready_engineering_jobs',
    'enqueue_external_engineering_jobs_controlled',
  );
  assert.match(cancellation, /job\.origin = 'auto'/);
  assert.match(cancellation, /when job\.status = 'running' then 'running' else 'cancelled'/);
  assert.match(cancellation, /cancel_requested_at = coalesce/);
  assert.doesNotMatch(cancellation, /job\.origin = 'manual'/);

  const controlledEnqueue = sliceFunction(
    migration,
    'enqueue_external_engineering_jobs_controlled',
    'set_external_analysis_custom_commands_controlled',
  );
  assert.match(
    controlledEnqueue,
    /pg_advisory_xact_lock\(hashtextextended\('ready-engineering-command-automation', 0\)\)[\s\S]*v_job_ids := public\.enqueue_external_engineering_jobs/,
  );
  assert.match(controlledEnqueue, /v_job_ids := public\.enqueue_external_engineering_jobs/);
  assert.match(controlledEnqueue, /origin = 'manual'/);
  assert.match(controlledEnqueue, /where job\.id = any\(v_job_ids\)/);
  assert.match(
    controlledEnqueue,
    /job\.status in \(\s*'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'\s*\)/,
  );
  assert.match(controlledEnqueue, /completed canonical result[\s\S]*historical origin unchanged/);
  assert.match(controlledEnqueue, /cancel_requested_at = null/);
  assert.match(controlledEnqueue, /update public\.ai_external_analysis_batches as batch/);
  assert.match(controlledEnqueue, /batch\.status in \('queued', 'running', 'retry_scheduled'\)/);
  assert.match(controlledEnqueue, /origin = 'manual'[\s\S]*requested_by = coalesce\(p_requested_by/);
  assert.match(
    migration,
    /set_external_analysis_custom_commands_controlled[\s\S]*pg_advisory_xact_lock\(hashtextextended\('ready-engineering-command-automation', 0\)\)[\s\S]*set_external_analysis_custom_commands/,
  );
  assert.match(
    migration,
    /reset_external_analysis_command_preferences_controlled[\s\S]*pg_advisory_xact_lock\(hashtextextended\('ready-engineering-command-automation', 0\)\)[\s\S]*reset_external_analysis_command_preferences/,
  );
  assert.match(migration, /notify pgrst, 'reload schema';\s*\n\s*commit;/);

  assert.match(api, /set_external_analysis_custom_commands_controlled/);
  assert.match(api, /reset_external_analysis_command_preferences_controlled/);
  assert.ok((api.match(/p_origin:\s*'manual'/g) || []).length >= 4);
  assert.doesNotMatch(
    api.slice(api.indexOf('const enqueueEngineeringJobs'), api.indexOf('const useDefaultEngineeringCommands')),
    /rpc\('enqueue_external_engineering_jobs'/,
  );

  assert.match(workerGuard, /assertAutomaticReadyEngineeringCommandsAllowed/);
  assert.match(workerGuard, /Pick<ExternalAnalysisJob, 'id' \| 'origin'>/);
  assert.match(workerGuard, /\.from\('ai_external_analysis_jobs'\)[\s\S]*\.select\('origin'\)[\s\S]*\.eq\('id', jobId\)[\s\S]*\.maybeSingle\(\)/);
  assert.match(workerGuard, /if \(job\.origin !== 'auto'\) return/);
  assert.match(workerGuard, /if \(currentOrigin === 'manual'\)[\s\S]*job\.origin = 'manual'[\s\S]*return/);
  assert.match(workerGuard, /if \(latestOrigin === 'manual'\)[\s\S]*job\.origin = 'manual'[\s\S]*return/);
  assert.match(workerGuard, /autoRunReadyEngineeringCommands/);
  assert.match(executor, /await assertAutomaticReadyEngineeringCommandsAllowed\(context\.job\)/);
});
