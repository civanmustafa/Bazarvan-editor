import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readWorkspaceFile = (relativePath: string) => readFile(path.join(root, relativePath), 'utf8');

test('temporary focus stalls recover inside the existing single master only', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261017000000_truthful_idle_lane_and_stall_recovery.sql',
  );

  assert.match(migration, /create or replace function public\.release_recoverable_automatic_focus_stalls/);
  assert.match(migration, /pause\.reason = 'focus_stalled'/);
  assert.match(migration, /unified_duplicate_cleanup_auto_ready/);
  assert.match(migration, /automatic_content_writing_requirement/);
  assert.match(migration, /article_automatic_policy_allows/);
  assert.match(migration, /auto_requeue_recoverable_automation_failures/);
  assert.match(migration, /article-automation-master-engine/);
  assert.doesNotMatch(migration, /cron\.schedule|pg_cron|create extension/);
  assert.match(migration, /select 14/);
});

test('scheduled post-write prerequisites release their obsolete review pause', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261030000000_release_scheduled_post_write_focus.sql',
  );

  assert.match(migration, /post_write_prerequisite_unscheduled/);
  assert.match(migration, /blockedBy' = 'automatic_article_focus'/);
  assert.match(migration, /article_automatic_policy_allows/);
  assert.match(migration, /release_recoverable_automatic_focus_stalls\(50\)/);
  assert.match(migration, /select 25;/);
  assert.doesNotMatch(migration, /terminal_stage_failure/);
  assert.doesNotMatch(migration, /cron\.schedule|pg_cron|create extension/);
});

test('post-write focus recovery executes only with a scheduled focus-blocked job', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261030000000_release_scheduled_post_write_focus.sql',
  );
  const db = new PGlite();
  const articleId = '63000000-0000-4000-8000-000000000001';
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.articles (
        id uuid primary key,
        status text not null
      );
      create table public.automatic_article_focus_pauses (
        article_id uuid primary key,
        reason text not null,
        error_code text,
        error_message text,
        paused_by uuid,
        paused_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table public.ai_external_analysis_article_state (
        article_id uuid primary key,
        semantic_ready boolean not null default false,
        competitor_discovery_ready boolean not null default false
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(),
        article_id uuid not null,
        origin text not null,
        pipeline_parent_job_id uuid,
        cancel_requested_at timestamptz,
        status text not null,
        progress jsonb not null default '{}'::jsonb,
        job_type text not null,
        command_id text
      );
      create table public.automatic_article_focus (
        singleton boolean primary key,
        article_id uuid,
        last_article_id uuid,
        state text,
        current_stage text,
        last_release_reason text,
        released_at timestamptz,
        next_retry_at timestamptz,
        last_error_code text,
        last_error text,
        last_progress_at timestamptz,
        updated_at timestamptz not null default now()
      );
      create table public.worker_queue_signals (queue_name text primary key);
      create function public.automatic_content_writing_requirement(uuid)
        returns jsonb language sql immutable as $$select '{"required":false}'::jsonb$$;
      create function public.evaluate_content_writing_automation_readiness(uuid)
        returns jsonb language sql immutable as $$select '{"ready":false}'::jsonb$$;
      create function public.article_is_globally_trashed(uuid)
        returns boolean language sql immutable as $$select false$$;
      create function public.article_automatic_policy_allows(uuid,text,text default null)
        returns boolean language sql immutable as $$select true$$;
      create function public.unified_duplicate_cleanup_auto_ready(uuid)
        returns boolean language sql immutable as $$select false$$;
      create function public.reconcile_automatic_article_focus()
        returns jsonb language sql as $$select '{}'::jsonb$$;
      create function public.content_writing_automation_schema_version()
        returns integer language sql immutable as $$select 24$$;

      insert into public.articles(id,status)
      values ('${articleId}','draft');
      insert into public.automatic_article_focus_pauses(article_id,reason,error_message)
      values ('${articleId}','post_write_prerequisite_unscheduled','old missing prerequisite');
      insert into public.ai_external_analysis_article_state(article_id)
      values ('${articleId}');
      insert into public.ai_external_analysis_jobs(
        article_id,origin,status,progress,job_type
      ) values (
        '${articleId}','auto','waiting_for_prerequisites',
        '{"blockedBy":"automatic_article_focus"}'::jsonb,'competitor_extraction'
      );
      insert into public.automatic_article_focus(
        singleton,last_article_id,state
      ) values (true,'${articleId}','needs_attention');
    `);

    await db.exec(migration);

    const repaired = (await db.query<{
      pause_count: number;
      focus_state: string;
      version: number;
    }>(`
      select
        (select count(*)::integer from public.automatic_article_focus_pauses) as pause_count,
        (select state from public.automatic_article_focus where singleton) as focus_state,
        public.content_writing_automation_schema_version() as version
    `)).rows[0];
    assert.equal(repaired.pause_count, 0);
    assert.equal(repaired.focus_state, 'idle');
    assert.equal(repaired.version, 25);
  } finally {
    await db.close();
  }
});

test('the public inventory treats pauses and missing prerequisites truthfully', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261017000000_truthful_idle_lane_and_stall_recovery.sql',
  );
  const dashboardQueue = await readWorkspaceFile('utils/dashboardAutomationQueue.ts');
  const panel = await readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx');

  assert.match(migration, /rename to get_visible_automation_task_inventory_v13/);
  assert.match(migration, /'status', 'failed'/);
  assert.match(migration, /manual_review_focus_stalled/);
  assert.match(migration, /manual_review_terminal_failure/);
  assert.match(migration, /missing_company_name/);
  assert.match(migration, /missing_editor_text/);
  assert.match(migration, /missing_competitor_source/);
  assert.match(migration, /writing_requirement->>'required'/);
  assert.match(dashboardQueue, /const waitingCount = scheduledCount \+ readyCount;/);
  assert.doesNotMatch(dashboardQueue, /scheduledCount \+ readyCount \+ unscheduledCount/);
  assert.match(dashboardQueue, /\['ready', 'completed'\]\.includes\(computedStatus\)/);
  assert.match(panel, /غير مستوفٍ للشروط/);
});

test('current blockers are separated from historical errors and shown once at their root stage', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261018000000_current_blocker_and_historical_error.sql',
  );
  const panel = await readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx');
  const taskNormalizer = await readWorkspaceFile('utils/contentWritingAutomation.ts');
  const guard = await readWorkspaceFile('server/contentResearchAutomationGuard.ts');
  const worker = await readWorkspaceFile('server/externalAnalysisWorker.ts');

  assert.match(migration, /automatic_article_focus_pause_history/);
  assert.match(migration, /automatic_focus_pause_blocker_state/);
  assert.match(migration, /content_research_automation_changed/);
  assert.match(migration, /reclassified_as_prerequisite_wait/);
  assert.match(migration, /competitor_requirement_now_satisfied/);
  assert.match(migration, /release_reclassified_automatic_focus_pauses/);
  assert.match(migration, /defer_external_analysis_job_for_prerequisite/);
  assert.match(migration, /attempt_count = greatest\(0, job\.attempt_count - 1\)/);
  assert.match(migration, /resume_satisfied_automatic_prerequisite_jobs/);
  assert.match(migration, /article-automation-master-engine/);
  assert.doesNotMatch(migration, /cron\.schedule|pg_cron|create extension/);
  assert.match(migration, /blocked_by_upstream/);
  assert.match(migration, /historical_blocker_resolved/);
  assert.match(migration, /'currentBlocker'/);
  assert.match(migration, /'rootOperationKey'/);
  assert.match(migration, /select 15/);
  assert.match(taskNormalizer, /historicalResolvedAt/);
  assert.match(panel, /خطأ تاريخي تمت معالجته/);
  assert.match(panel, /هذه المرحلة لم تفشل/);
  assert.match(panel, /لا تُعد محاولة تنفيذ/);
  assert.match(guard, /ExternalAnalysisPrerequisiteError/);
  assert.match(worker, /deferExternalAnalysisJobForPrerequisite/);
});

test('unfinished task cards name exact requirements and the article holding lane priority', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261019000000_detailed_automation_prerequisites.sql',
  );
  const panel = await readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx');
  const taskNormalizer = await readWorkspaceFile('utils/contentWritingAutomation.ts');

  assert.match(migration, /rename to get_visible_automation_task_inventory_v15/);
  assert.match(migration, /'code', 'google_titles'/);
  assert.match(migration, /'code', 'google_descriptions'/);
  assert.match(migration, /'code', 'automatic_article_focus'/);
  assert.match(migration, /'blockedByArticleTitle'/);
  assert.match(migration, /select 16/);
  assert.match(panel, /المتطلبات أو النتائج الناقصة/);
  assert.match(panel, /سبب عدم البدء الآن/);
  assert.match(panel, /ستُعاد جدولة هذه المهمة تلقائيًا بعد تحرر المسار/);
  assert.match(taskNormalizer, /AutomationTaskRequirement/);
  assert.match(taskNormalizer, /blockedByArticleTitle/);
  assert.match(taskNormalizer, /blockedByState/);
});

test('same-article prerequisite waits expose the running or scheduled upstream stage', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261020000000_detailed_upstream_stage_state.sql',
  );
  const panel = await readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx');
  const taskNormalizer = await readWorkspaceFile('utils/contentWritingAutomation.ts');

  assert.match(migration, /rename to get_visible_automation_task_inventory_v16/);
  assert.match(migration, /'upstreamStage'/);
  assert.match(migration, /when 'active' then 'running'/);
  assert.match(migration, /when 'waiting_retry' then 'scheduled'/);
  assert.match(migration, /select 17/);
  assert.match(panel, /المرحلة السابقة الجارية الآن/);
  assert.match(panel, /المرحلة السابقة بانتظار إعادة محاولة مجدولة/);
  assert.match(panel, /المرحلة السابقة متوقفة وتحتاج مراجعة/);
  assert.match(taskNormalizer, /upstreamStage/);
  assert.match(taskNormalizer, /upstreamState/);
});

test('competitor discovery is independent from Gemini and starts from its own exact inputs', async () => {
  const [migration, panel] = await Promise.all([
    readWorkspaceFile(
      'supabase/migrations/20261026000000_independent_competitor_discovery.sql',
    ),
    readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx'),
  ]);

  assert.match(migration, /create or replace function public\.evaluate_competitor_discovery_readiness/);
  assert.match(migration, /coalesce\(p_status, ''\) <> 'draft'/);
  assert.match(migration, /jsonb_build_array\('article_title'\)/);
  assert.match(migration, /jsonb_build_array\('primary_keyword'\)/);
  assert.match(migration, /jsonb_build_array\('goal_context'\)/);
  assert.match(migration, /jsonb_build_array\('company_name'\)/);
  assert.match(migration, /'executionPath', 'programmatic_competitor_research'/);

  const enqueueStart = migration.indexOf(
    'create or replace function public.enqueue_competitor_discovery_job_by_signature',
  );
  const enqueueEnd = migration.indexOf(
    'create or replace function public.automatic_article_focus_controls_job_type',
    enqueueStart,
  );
  const enqueue = migration.slice(enqueueStart, enqueueEnd);
  assert.ok(enqueueStart >= 0 && enqueueEnd > enqueueStart);
  assert.match(enqueue, /autoDiscoverCompetitors/);
  assert.match(enqueue, /enqueue_competitor_discovery_job\(/);
  assert.doesNotMatch(enqueue, /semantic_keywords_lsi/);
  assert.doesNotMatch(enqueue, /secondaries/);
  assert.doesNotMatch(enqueue, /\bgoogleTitles\b|\bgoogleDescriptions\b/);

  const focusStart = migration.indexOf(
    'create or replace function public.automatic_article_focus_controls_job_type',
  );
  const focusEnd = migration.indexOf(
    'create or replace function public.reconcile_legacy_content_research_automation',
    focusStart,
  );
  const focus = migration.slice(focusStart, focusEnd);
  assert.doesNotMatch(focus, /'competitor_discovery'/);
  assert.match(focus, /'semantic_keywords_lsi'/);
  assert.match(migration, /rename to get_visible_automation_task_inventory_v20/);
  assert.match(migration, /'independentFromAiFocus', true/);
  assert.match(migration, /select public\.reconcile_content_research_automation\(\);/);
  assert.doesNotMatch(migration, /cron\.schedule|pg_cron|create extension/);
  assert.match(migration, /select 21;/);
  assert.match(migration.trim(), /commit;$/);
  assert.match(panel, /draft_status: \['حالة المقالة: مسودة'/);
  assert.match(panel, /article_title: \['عنوان المقالة'/);
});

test('independent competitor discovery migration executes and evaluates only its five inputs', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261026000000_independent_competitor_discovery.sql',
  );
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.articles (
        id uuid primary key,
        status text not null default 'draft',
        title text not null default '',
        keywords jsonb not null default '{}'::jsonb,
        goal_context jsonb not null default '{}'::jsonb,
        article_language text not null default 'ar',
        automation_policy_version integer not null default 1,
        updated_at timestamptz not null default now()
      );
      create table public.ai_external_analysis_article_state (
        article_id uuid primary key,
        competitor_discovery_ready boolean not null default false,
        competitor_discovery_missing_fields jsonb not null default '[]'::jsonb,
        competitor_discovery_signature text not null default '',
        last_article_updated_at timestamptz,
        last_evaluated_at timestamptz,
        updated_at timestamptz not null default now()
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(),
        article_id uuid not null,
        requested_by uuid,
        job_type text not null,
        origin text not null default 'auto',
        status text not null default 'queued',
        pipeline_parent_job_id uuid,
        readiness_signature text,
        input_snapshot jsonb not null default '{}'::jsonb,
        result jsonb,
        progress jsonb not null default '{}'::jsonb,
        last_error text,
        last_error_code text,
        attempt_count integer not null default 0,
        next_attempt_at timestamptz,
        locked_by text,
        locked_at timestamptz,
        lease_expires_at timestamptz,
        cancel_requested_at timestamptz,
        completed_at timestamptz,
        updated_at timestamptz not null default now()
      );
      create function public.article_automation_policy(uuid) returns jsonb
        language sql immutable as $$select '{"enabled":true,"autoDiscoverCompetitors":true}'::jsonb$$;
      create function public.article_automatic_policy_allows(uuid,text,text default null)
        returns boolean language sql immutable as $$select true$$;
      create function public.cancel_stale_competitor_discovery_jobs(uuid,text)
        returns integer language sql as $$select 0$$;
      create function public.enqueue_competitor_discovery_job(uuid,uuid,text)
        returns uuid language sql as $$select null::uuid$$;
      create function public.get_content_research_automation_settings()
        returns jsonb language sql immutable as $$select '{"autoGenerateAlternativeKeywords":true,"autoGenerateLsiKeywords":true,"autoDiscoverCompetitors":true}'::jsonb$$;
      create function public.external_analysis_has_competitor_value(jsonb,integer)
        returns boolean language sql immutable as $$select false$$;
      create function public.semantic_keywords_have_google_metadata(jsonb)
        returns boolean language sql immutable as $$select false$$;
      create function public.enqueue_external_semantic_analysis_job_controlled(uuid,text)
        returns uuid language sql as $$select null::uuid$$;
      create function public.enqueue_competitor_discovery_job_controlled(uuid,uuid,text)
        returns uuid language sql as $$select null::uuid$$;
      create function public.reconcile_content_research_automation()
        returns void language sql as $$select$$;
      create function public.get_visible_automation_task_inventory(uuid)
        returns jsonb language sql stable as $$select '[]'::jsonb$$;
      create function public.content_writing_automation_schema_version()
        returns integer language sql immutable as $$select 20$$;
    `);

    await db.exec(migration);

    const ready = (await db.query<{ readiness: Record<string, unknown> }>(`
      select public.evaluate_competitor_discovery_readiness(
        'draft',
        'عنوان مكتمل',
        '{"primary":"كلمة أساسية","company":"شركة"}'::jsonb,
        '{"pageType":"article","objective":"educate"}'::jsonb,
        'ar'
      ) as readiness
    `)).rows[0].readiness;
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.missingFields, []);
    assert.equal(ready.executionPath, 'programmatic_competitor_research');

    const missingCompany = (await db.query<{ readiness: Record<string, unknown> }>(`
      select public.evaluate_competitor_discovery_readiness(
        'draft',
        'عنوان مكتمل',
        '{"primary":"كلمة أساسية","secondaries":[],"lsi":[]}'::jsonb,
        '{"pageType":"article","objective":"educate"}'::jsonb,
        'ar'
      ) as readiness
    `)).rows[0].readiness;
    assert.equal(missingCompany.ready, false);
    assert.deepEqual(missingCompany.missingFields, ['company_name']);

    const focus = (await db.query<{ controls_discovery: boolean; controls_ai: boolean }>(`
      select
        public.automatic_article_focus_controls_job_type('competitor_discovery')
          as controls_discovery,
        public.automatic_article_focus_controls_job_type('semantic_keywords_lsi')
          as controls_ai
    `)).rows[0];
    assert.equal(focus.controls_discovery, false);
    assert.equal(focus.controls_ai, true);
  } finally {
    await db.close();
  }
});

test('independent discovery runtime migration requeues only obsolete semantic waits', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261029000000_independent_competitor_discovery_runtime.sql',
  );
  const db = new PGlite();
  const articleId = '61000000-0000-4000-8000-000000000001';
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.ai_external_analysis_article_state (
        article_id uuid primary key,
        competitor_discovery_ready boolean not null default false,
        competitor_discovery_signature text not null default ''
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(),
        article_id uuid not null,
        requested_by uuid,
        job_type text not null,
        origin text not null default 'auto',
        status text not null default 'queued',
        pipeline_parent_job_id uuid,
        readiness_signature text,
        result jsonb,
        progress jsonb not null default '{}'::jsonb,
        last_error text,
        last_error_code text,
        next_attempt_at timestamptz,
        locked_by text,
        locked_at timestamptz,
        lease_expires_at timestamptz,
        cancel_requested_at timestamptz,
        started_at timestamptz,
        completed_at timestamptz,
        updated_at timestamptz not null default now()
      );
      create function public.article_automation_policy(uuid) returns jsonb
        language sql immutable as $$select '{"enabled":true,"autoDiscoverCompetitors":true}'::jsonb$$;
      create function public.article_automatic_policy_allows(uuid,text,text default null)
        returns boolean language sql immutable as $$select true$$;
      create function public.cancel_stale_competitor_discovery_jobs(uuid,text)
        returns integer language sql as $$select 0$$;
      create function public.enqueue_competitor_discovery_job(uuid,uuid,text)
        returns uuid language sql as $$select null::uuid$$;
      create function public.content_writing_automation_schema_version()
        returns integer language sql immutable as $$select 23$$;

      insert into public.ai_external_analysis_article_state(
        article_id,competitor_discovery_ready,competitor_discovery_signature
      ) values ('${articleId}',true,'ready-signature');
      insert into public.ai_external_analysis_jobs(
        article_id,job_type,origin,status,readiness_signature,last_error_code,last_error,progress
      ) values (
        '${articleId}','competitor_discovery','auto','waiting_for_prerequisites',
        'ready-signature','content_research_automation_changed','obsolete guard',
        '{"stage":"waiting_for_prerequisites","blockedBy":"semantic_keywords","waitingPrerequisite":true}'::jsonb
      );
    `);

    await db.exec(migration);

    const repaired = (await db.query<{
      status: string;
      last_error_code: string | null;
      progress: Record<string, unknown>;
      version: number;
    }>(`
      select job.status,job.last_error_code,job.progress,
        public.content_writing_automation_schema_version() as version
      from public.ai_external_analysis_jobs as job
      where job.article_id='${articleId}'
    `)).rows[0];
    assert.equal(repaired.status, 'queued');
    assert.equal(repaired.last_error_code, null);
    assert.equal(repaired.progress.blockedBy, undefined);
    assert.equal(repaired.progress.independentFromSemanticGeneration, true);
    assert.equal(repaired.version, 24);
  } finally {
    await db.close();
  }
});

test('post-write focus ignores historical jobs and cleans obsolete preparation work', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261022000000_truthful_post_write_focus.sql',
  );
  const api = await readWorkspaceFile('api/contentWritingAutomation.ts');
  const panel = await readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx');
  const taskNormalizer = await readWorkspaceFile('utils/contentWritingAutomation.ts');

  assert.match(migration, /automatic_article_active_stage/);
  assert.match(migration, /job\.status in \('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'\)/);
  assert.match(migration, /job\.cancel_requested_at is null/);
  assert.match(migration, /cancel_obsolete_content_writing_preparations/);
  assert.match(migration, /job\.job_type = 'content_writing_preparation'/);
  assert.match(migration, /'blocked'/);
  assert.match(migration, /'qualityOverridden'/);
  assert.match(migration, /select 18/);
  assert.match(api, /qualityOverridden/);
  assert.match(taskNormalizer, /requiredAuditCount/);
  assert.match(panel, /إصلاح التكرارات جارٍ الآن/);
  assert.match(panel, /النتيجة لم تجتز السياسة الأصلية/);
  assert.match(panel, /data-automatic-focus-stage-detail/);
});
