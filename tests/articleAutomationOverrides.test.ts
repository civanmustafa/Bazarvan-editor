import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS,
  COMPETITOR_COMPARISON_COMMAND_ID,
  countArticleAutomationExceptions,
  normalizeArticleAutomationOverrides,
} from '../constants/articleAutomationOverrides.ts';

const readWorkspaceFile = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('article overrides are opt-in, restrictive, deduplicated, and bounded', () => {
  assert.deepEqual(normalizeArticleAutomationOverrides(null), ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS);
  const normalized = normalizeArticleAutomationOverrides({
    disabledCapabilities: [
      'autoDiscoverCompetitors',
      'autoDiscoverCompetitors',
      'not-a-capability',
    ],
    writingMode: 'available_inputs',
    excludedExternalCommandIds: [COMPETITOR_COMPARISON_COMMAND_ID, COMPETITOR_COMPARISON_COMMAND_ID, ''],
    reason: `  ${'x'.repeat(1100)}  `,
  });
  assert.deepEqual(normalized.disabledCapabilities, ['autoDiscoverCompetitors']);
  assert.equal(normalized.writingMode, 'available_inputs');
  assert.deepEqual(normalized.excludedExternalCommandIds, [COMPETITOR_COMPARISON_COMMAND_ID]);
  assert.equal(normalized.reason.length, 1000);
  assert.equal(countArticleAutomationExceptions(normalized), 3);
});

test('migration overlays policy, bypasses only competitor gates, and cancels excluded work neutrally', async () => {
  const [migration, trashGuardMigration] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20261028000000_article_automation_overrides.sql'),
    readWorkspaceFile('supabase/migrations/20261028010000_restore_trashed_article_policy_guard.sql'),
  ]);
  assert.match(migration, /create table if not exists public\.article_automation_overrides/);
  assert.match(migration, /alter table public\.article_automation_overrides enable row level security/);
  assert.match(migration, /articleWritingMode/);
  assert.match(migration, /v_writing_mode = 'available_inputs'/);
  assert.match(migration, /content_writing_preparation[\s\S]*articleWritingMode[\s\S]*strict/);
  assert.match(migration, /article_automation_stage_excluded/);
  assert.match(migration, /create or replace function public\.article_automatic_policy_allows/);
  assert.match(migration, /articleOverrideVersion/);
  assert.match(trashGuardMigration, /public\.article_is_globally_trashed\(p_article_id\)/);
  assert.match(migration, /perform public\.reconcile_automatic_article_focus\(\)/);
  assert.match(migration, /select 23/);
  assert.equal((migration.match(/\$readiness_patch\$/g) || []).length, 2);
  assert.equal((migration.match(/\$claim_patch\$/g) || []).length, 2);
});

test('dashboard and editor expose a per-article modal and API route without changing defaults', async () => {
  const [dashboard, editorHeader, control, api, registry, engine] = await Promise.all([
    readWorkspaceFile('components/Dashboard.tsx'),
    readWorkspaceFile('components/TipsCarousel.tsx'),
    readWorkspaceFile('components/ArticleAutomationOverridesControl.tsx'),
    readWorkspaceFile('api/articleAutomationOverrides.ts'),
    readWorkspaceFile('server/apiRouteRegistry.ts'),
    readWorkspaceFile('server/contentWritingEngine.ts'),
  ]);
  assert.match(dashboard, /ArticleAutomationOverridesControl/);
  assert.match(editorHeader, /data-article-automation-overrides-control="true"/);
  assert.match(editorHeader, /<CircleDot[\s\S]*data-article-access-control="true"[\s\S]*<ShieldCheck/);
  assert.doesNotMatch(editorHeader, />\{uiLanguage === 'ar' \? 'الحالة:'/);
  assert.doesNotMatch(editorHeader, />\{uiLanguage === 'ar' \? 'الصلاحية:'/);
  assert.match(control, /استعادة الوراثة الافتراضية/);
  assert.match(control, /الكتابة بالمدخلات المتاحة/);
  assert.match(control, /كتابة يدوية فقط/);
  assert.match(api, /requireArticleWriteAccess/);
  assert.match(api, /Object\.keys\(body\)\.some/);
  assert.match(registry, /\/api\/articles\/automation-overrides/);
  assert.match(engine, /readinessIssues\.filter\(issue => issue\.code !== 'competitors'\)/);
});

test('runtime override policy cancels queued work, fences running work, and reuses bundled rows', async () => {
  const [migration, control, api, client, worker, policy, reports] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20261031000000_article_automation_override_runtime_policy.sql'),
    readWorkspaceFile('components/ArticleAutomationOverridesControl.tsx'),
    readWorkspaceFile('api/articleAutomationOverrides.ts'),
    readWorkspaceFile('utils/articleAutomationOverrides.ts'),
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
    readWorkspaceFile('server/articleAutomationPolicy.ts'),
    readWorkspaceFile('components/ExternalAnalysisReportsTable.tsx'),
  ]);
  assert.match(migration, /p_running_behavior text default 'stop'/);
  assert.match(migration, /article_automation_policy_refresh/);
  assert.match(migration, /restart_external_analysis_job_after_policy_change/);
  assert.match(migration, /attempt_count = greatest\(0, job\.attempt_count - 1\)/);
  assert.match(migration, /automationOverrideDisposition', 'finish_current'/);
  assert.match(migration, /'impact', jsonb_build_object/);
  assert.match(control, /إيقافها وتطبيق الاستثناء الآن \(موصى به\)/);
  assert.match(control, /إكمال الجاري ثم تطبيق الاستثناء/);
  assert.match(control, /حُفظت الاستثناءات وتحدّث الطابور/);
  assert.match(api, /isArticleAutomationRunningBehavior/);
  assert.match(client, /runningBehavior/);
  assert.match(worker, /restartExternalAnalysisJobAfterPolicyChange/);
  assert.match(policy, /automaticJobMayFinishCurrentRun/);
  assert.doesNotMatch(reports, /\['failed', 'blocked', 'cancelled'\]\.includes\(job\.status\)\.length/);
  assert.match(reports, /موقوفة وليست فشلًا/);
});

test('runtime policy migration requeues one bundled row and preserves finish-current intent', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.ai_external_analysis_jobs (
        id uuid primary key, article_id uuid not null, origin text not null,
        pipeline_parent_job_id uuid, status text not null, input_snapshot jsonb default '{}'::jsonb,
        cancel_requested_at timestamptz, last_error_code text, last_error text,
        progress jsonb default '{}'::jsonb, updated_at timestamptz default now(),
        job_type text not null, command_id text, locked_by text, locked_at timestamptz,
        lease_expires_at timestamptz, next_attempt_at timestamptz, completed_at timestamptz,
        attempt_count integer not null default 0
      );
      create table public.content_writing_sessions (
        id uuid primary key, article_id uuid not null, execution_mode text not null,
        context_snapshot jsonb default '{}'::jsonb, status text not null,
        cancel_requested_at timestamptz, last_error_code text, last_error text,
        progress jsonb default '{}'::jsonb, completed_at timestamptz, updated_at timestamptz default now()
      );
      create table public.content_writing_automation_items (
        article_id uuid primary key, status text not null, completed_at timestamptz,
        locked_by text, locked_at timestamptz, lease_expires_at timestamptz,
        last_error_code text, last_error text, updated_at timestamptz default now()
      );
      create table public.ai_external_analysis_runs (
        job_id uuid not null, status text not null, error_code text, error_message text,
        progress jsonb default '{}'::jsonb, finished_at timestamptz
      );
      create table public.worker_queue_signals (queue_name text primary key);
      create function public.save_article_automation_overrides(uuid,uuid,text[],text,text[],text)
      returns jsonb language sql as $$ select '{"revision":2}'::jsonb $$;
      create function public.article_automation_policy(uuid)
      returns jsonb language sql stable as $$ select '{
        "enabled":true,"autoGenerateAlternativeKeywords":false,
        "autoGenerateLsiKeywords":true,"autoGenerateGoogleMetadata":true,
        "contentWritingAutomationEnabled":false
      }'::jsonb $$;
      create function public.article_automatic_policy_allows(uuid,text,text default null)
      returns boolean language sql stable as $$ select $2 = 'semantic_keywords_lsi' $$;
      create function public.reconcile_automatic_article_focus()
      returns jsonb language sql as $$ select '{}'::jsonb $$;
    `);
    await db.exec(await readWorkspaceFile(
      'supabase/migrations/20261031000000_article_automation_override_runtime_policy.sql',
    ));
    const articleId = '10000000-0000-4000-8000-000000000001';
    const userId = '20000000-0000-4000-8000-000000000002';
    const semanticId = '30000000-0000-4000-8000-000000000003';
    await db.query(`insert into public.ai_external_analysis_jobs(
      id,article_id,origin,status,input_snapshot,job_type,locked_by,attempt_count
    ) values ($1,$2,'auto','running','{"needsSecondaries":true,"needsLsi":true,"needsGoogleMetadata":true}',
      'semantic_keywords_lsi','worker-1',2)`, [semanticId, articleId]);
    const stopped = (await db.query<{ value: Record<string, any> }>(
      `select public.save_article_automation_overrides_v2($1,$2,array['autoGenerateAlternativeKeywords'],
        'strict',array[]::text[],null,'stop') value`,
      [articleId, userId],
    )).rows[0].value;
    assert.equal(stopped.impact.runningCancellationRequested, 1);
    assert.equal(stopped.impact.bundledRestartRequested, 1);
    const restarted = (await db.query<{ status: string; attempt_count: number; secondaries: boolean }>(
      `select status,attempt_count,(input_snapshot->>'needsSecondaries')::boolean secondaries
       from public.restart_external_analysis_job_after_policy_change($1,'worker-1')`,
      [semanticId],
    )).rows[0];
    assert.deepEqual(restarted, { status: 'queued', attempt_count: 1, secondaries: false });

    const engineeringId = '40000000-0000-4000-8000-000000000004';
    await db.query(`insert into public.ai_external_analysis_jobs(
      id,article_id,origin,status,input_snapshot,job_type,command_id,locked_by,attempt_count
    ) values ($1,$2,'auto','running','{}','engineering_command','excluded-command','worker-2',1)`,
    [engineeringId, articleId]);
    const finished = (await db.query<{ value: Record<string, any> }>(
      `select public.save_article_automation_overrides_v2($1,$2,array[]::text[],
        'strict',array['excluded-command'],null,'finish_current') value`,
      [articleId, userId],
    )).rows[0].value;
    assert.equal(finished.impact.runningAllowedToFinish, 1);
    const disposition = (await db.query<{ value: string }>(
      `select input_snapshot->>'automationOverrideDisposition' value
       from public.ai_external_analysis_jobs where id=$1`, [engineeringId],
    )).rows[0].value;
    assert.equal(disposition, 'finish_current');
  } finally {
    await db.close();
  }
});
