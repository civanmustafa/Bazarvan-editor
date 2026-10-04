import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { selectExpectedNextAutomaticArticle } from '../utils/automaticArticleQueue.ts';
import type { AutomationTaskInventoryItem } from '../utils/contentWritingAutomation.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const migrationPath = 'supabase/migrations/20261007000000_finish_focused_article_first.sql';

const queueTask = (
  articleId: string,
  overrides: Partial<AutomationTaskInventoryItem> = {},
): AutomationTaskInventoryItem => ({
  taskId: `task-${articleId}`,
  operationKey: 'content_writing',
  articleId,
  articleTitle: `Article ${articleId}`,
  status: 'ready',
  scheduled: false,
  scheduleAt: null,
  startedAt: null,
  readyAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  sourceType: 'writing_candidate',
  sourceId: null,
  priorityRank: 1,
  reasonCode: null,
  reason: null,
  attemptCount: 0,
  maxAttempts: 6,
  missingFields: [],
  usableCompetitorCount: 3,
  minimumCompetitorCount: 3,
  recoveryCount: 0,
  maxRecoveries: 3,
  manualReview: false,
  runnable: true,
  ...overrides,
});

test('next automatic article excludes the focused and manually reviewed articles', () => {
  const selected = selectExpectedNextAutomaticArticle([
    queueTask('current', { status: 'running', startedAt: '2026-10-01T09:00:00.000Z' }),
    queueTask('manual-review', { manualReview: true, readyAt: '2026-10-01T08:00:00.000Z' }),
    queueTask('later', { readyAt: '2026-10-01T11:00:00.000Z' }),
    queueTask('next', { readyAt: '2026-10-01T10:30:00.000Z' }),
  ], 'current');

  assert.equal(selected?.articleId, 'next');
});

test('finish-first migration contains one shared automatic article lane', async () => {
  const [migration, api, client, panel, writingWorker, masterWorker] = await Promise.all([
    readWorkspaceFile(migrationPath),
    readWorkspaceFile('api/contentWritingAutomation.ts'),
    readWorkspaceFile('utils/contentWritingAutomation.ts'),
    readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx'),
    readWorkspaceFile('server/contentWritingAutomation.ts'),
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
  ]);

  assert.match(migration, /create table if not exists public\.automatic_article_focus/);
  assert.match(migration, /queuePolicy', 'finish_focused_article_first'/);
  assert.match(migration, /create or replace function public\.reconcile_automatic_article_focus/);
  assert.match(migration, /create or replace function public\.skip_automatic_article_focus/);
  assert.match(migration, /create or replace function public\.resume_automatic_article_focus/);
  assert.match(migration, /create or replace function public\.defer_due_automatic_content_writing_retry_for_fairness\(\)[\s\S]*select false;/);
  assert.match(api, /get_automatic_article_focus/);
  assert.match(api, /skip_automatic_article_focus/);
  assert.match(client, /AutomaticArticleFocus/);
  assert.match(panel, /أولوية إنهاء المقالة الحالية/);
  assert.match(panel, /مسار الأتمتة متاح/);
  assert.match(panel, /آخر مقالة تحتاج مراجعة/);
  assert.match(panel, /data-released-focus-review/);
  assert.match(panel, /reviewMissingPrerequisites/);
  assert.match(panel, /reviewMissingPrerequisites\?\.length/);
  assert.match(panel, /codes \|\| \[\]/);
  assert.match(client, /reviewMissingPrerequisites: stringList\(focus\.reviewMissingPrerequisites\)/);
  assert.match(client, /laneAvailable: focus\.laneAvailable === true/);
  assert.match(panel, /المقالة التالية المتوقعة/);
  assert.match(panel, /موعد التشغيل القادم/);
  assert.match(panel, /data-automatic-next-start/);
  assert.doesNotMatch(writingWorker, /reconcile_automatic_article_focus/);
  assert.match(masterWorker, /reconcileArticleAutomationCoordinator/);
  assert.match(masterWorker, /EXTERNAL_ANALYSIS_AUTOMATION_MASTER/);
});

test('finish-first focus serializes articles, survives retry, and supports manual review', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.profiles (
        id uuid primary key, is_active boolean not null default true
      );
      create table public.articles (
        id uuid primary key, status text not null default 'draft', title text not null default '',
        metadata jsonb not null default '{}', created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table public.app_settings (key text primary key, value jsonb not null default '{}');
      create table public.ai_external_analysis_article_state (
        article_id uuid primary key references public.articles(id) on delete cascade
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(),
        article_id uuid not null references public.articles(id) on delete cascade,
        requested_by uuid references public.profiles(id) on delete set null,
        job_type text not null, origin text not null default 'auto', status text not null,
        command_id text, input_snapshot jsonb not null default '{}',
        progress jsonb not null default '{}', pipeline_parent_job_id uuid,
        attempt_count integer not null default 0, retry_count integer not null default 0,
        max_attempts integer not null default 6, next_attempt_at timestamptz,
        locked_by text, locked_at timestamptz, lease_expires_at timestamptz,
        cancel_requested_at timestamptz, started_at timestamptz, completed_at timestamptz,
        dead_lettered_at timestamptz, dead_letter_reason text, lease_generation bigint not null default 0,
        last_error_code text, last_error text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      create table public.content_writing_automation_items (
        id uuid primary key default gen_random_uuid(),
        article_id uuid not null unique references public.articles(id) on delete cascade,
        requested_by uuid not null references public.profiles(id),
        status text not null default 'ready', attempt_count integer not null default 0,
        max_attempts integer not null default 6, ready_at timestamptz not null default now(),
        eligible_at timestamptz not null default now(), started_at timestamptz,
        locked_by text, locked_at timestamptz, lease_expires_at timestamptz,
        completed_at timestamptz, failure_class text, next_recovery_at timestamptz,
        last_error_code text, last_error text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      create table public.content_writing_sessions (
        id uuid primary key default gen_random_uuid(), article_id uuid not null references public.articles(id),
        created_by uuid not null references public.profiles(id), execution_mode text not null default 'api',
        status text not null default 'queued', context_snapshot jsonb not null default '{}',
        next_attempt_at timestamptz, cancel_requested_at timestamptz,
        started_at timestamptz, completed_at timestamptz, applied_at timestamptz,
        last_error_code text, last_error text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      create table public.article_automation_coordinator_runtime (
        singleton boolean primary key default true check (singleton),
        last_started_at timestamptz, last_completed_at timestamptz,
        last_result jsonb not null default '{}'
      );
      insert into public.article_automation_coordinator_runtime(singleton) values(true);

      create function public.article_automation_policy(uuid) returns jsonb
      language sql stable as $$
        select '{"policyVersion":0}'::jsonb
      $$;
      create function public.article_automation_work_readiness(p_article_id uuid) returns jsonb
      language sql stable as $$
        select jsonb_build_object(
          'state', coalesce(article.metadata->>'workState', 'preparing'),
          'ready', coalesce(article.metadata->>'workState', '') = 'ready'
        ) from public.articles as article where article.id = p_article_id
      $$;
      create function public.initialize_article_automation_stage_states(uuid) returns void
      language sql as $$ select $$;
      create function public.enqueue_external_semantic_analysis_job_controlled(
        p_article_id uuid, p_origin text
      ) returns uuid language plpgsql as $$
      declare v_id uuid;
      begin
        if public.article_automatic_job_allowed(p_article_id, 'semantic_keywords_lsi')
           and not exists (
             select 1 from public.ai_external_analysis_jobs
             where article_id = p_article_id and job_type = 'semantic_keywords_lsi'
               and status in ('waiting_for_prerequisites','queued','running','retry_scheduled','paused')
           ) then
          insert into public.ai_external_analysis_jobs(article_id,job_type,origin,status,next_attempt_at)
          values(p_article_id,'semantic_keywords_lsi',p_origin,'queued',now()) returning id into v_id;
        end if;
        return v_id;
      end $$;
      create function public.enqueue_competitor_discovery_job_controlled(uuid,uuid,text) returns uuid
      language sql as $$ select null::uuid $$;
      create function public.enqueue_automatic_competitor_extraction_for_discovery(uuid) returns uuid
      language sql as $$ select null::uuid $$;
      create function public.reconcile_automatic_ready_engineering_commands_for_article(uuid) returns uuid[]
      language sql as $$ select array[]::uuid[] $$;
      create function public.enqueue_next_automatic_writing_competitor_preparation(integer)
      returns setof public.ai_external_analysis_jobs language sql as $$
        select * from public.ai_external_analysis_jobs where false
      $$;
      create function public.defer_due_automatic_content_writing_retry_for_fairness() returns boolean
      language sql as $$ select true $$;
      create function public.rotate_external_analysis_article_after_retry() returns trigger
      language plpgsql as $$ begin return new; end $$;
      create trigger rotate_external_analysis_article_after_retry
      after update of status on public.ai_external_analysis_jobs for each row
      when (old.status = 'running' and new.status = 'retry_scheduled')
      execute function public.rotate_external_analysis_article_after_retry();
      create function public.guard_creator_automatic_external_job() returns trigger
      language plpgsql as $$ begin return new; end $$;
      create trigger zz_guard_creator_automatic_external_job
      before insert or update on public.ai_external_analysis_jobs for each row
      execute function public.guard_creator_automatic_external_job();
      create function public.article_automatic_job_allowed(uuid,text,text default null) returns boolean
      language sql stable as $$ select true $$;
    `);

    await db.exec(await readWorkspaceFile(migrationPath));

    const userId = '20000000-0000-4000-8000-000000000001';
    const firstArticleId = '10000000-0000-4000-8000-000000000001';
    const secondArticleId = '10000000-0000-4000-8000-000000000002';
    await db.query('insert into profiles(id) values($1)', [userId]);
    await db.query(`insert into articles(id,title,created_at) values
      ($1,'First article',now()-interval '2 hours'),($2,'Second article',now()-interval '1 hour')`, [
      firstArticleId, secondArticleId,
    ]);
    await db.query('insert into ai_external_analysis_article_state(article_id) values($1),($2)', [
      firstArticleId, secondArticleId,
    ]);

    await db.query('select reconcile_article_automation_coordinator(100)');
    let focus = (await db.query<any>('select get_automatic_article_focus() value')).rows[0].value;
    assert.equal(focus.articleId, firstArticleId);
    assert.equal(focus.currentStage, 'semantic_keywords');

    const parked = (await db.query<any>(`insert into ai_external_analysis_jobs(
      article_id,job_type,origin,status,next_attempt_at
    ) values($1,'semantic_keywords_lsi','auto','queued',now()) returning status,progress`, [
      secondArticleId,
    ])).rows[0];
    assert.equal(parked.status, 'waiting_for_prerequisites');
    assert.equal(parked.progress.blockedBy, 'automatic_article_focus');

    const manual = (await db.query<any>(`insert into ai_external_analysis_jobs(
      article_id,job_type,origin,status,next_attempt_at
    ) values($1,'semantic_keywords_lsi','manual','queued',now()) returning status`, [
      secondArticleId,
    ])).rows[0];
    assert.equal(manual.status, 'queued');

    await db.query(`update ai_external_analysis_jobs set status='running',attempt_count=1
      where article_id=$1 and origin='auto'`, [firstArticleId]);
    await db.query(`update ai_external_analysis_jobs set status='retry_scheduled',
      next_attempt_at=now()+interval '5 minutes',last_error_code='provider_temporarily_unavailable'
      where article_id=$1 and origin='auto'`, [firstArticleId]);
    focus = (await db.query<any>('select get_automatic_article_focus() value')).rows[0].value;
    assert.equal(focus.articleId, firstArticleId);
    assert.equal(focus.state, 'waiting_retry');
    const retained = (await db.query<any>(`select progress from ai_external_analysis_jobs
      where article_id=$1 and origin='auto'`, [firstArticleId])).rows[0].progress;
    assert.equal(retained.articleQueueLocked, true);
    assert.equal(retained.queuePolicy, 'finish_focused_article_first');

    await db.query(`update articles set metadata='{"workState":"ready"}' where id=$1`, [firstArticleId]);
    await db.query(`update ai_external_analysis_jobs set status='completed',completed_at=now()
      where article_id=$1 and origin='auto'`, [firstArticleId]);
    focus = (await db.query<any>('select reconcile_automatic_article_focus() value')).rows[0].value;
    assert.equal(focus.articleId, secondArticleId);
    const resumedJob = (await db.query<any>(`select status,progress from ai_external_analysis_jobs
      where article_id=$1 and origin='auto'`, [secondArticleId])).rows[0];
    assert.equal(resumedJob.status, 'queued');
    assert.equal(resumedJob.progress.articleQueueLocked, true);

    await db.query(`insert into content_writing_sessions(
      article_id,created_by,execution_mode,status,context_snapshot
    ) values($1,$2,'api','queued','{"triggerSource":"automatic_ready"}')`, [
      secondArticleId, userId,
    ]);

    focus = (await db.query<any>('select skip_automatic_article_focus($1,$2) value', [
      userId, 'requires_manual_review',
    ])).rows[0].value;
    assert.equal(focus.articleId, null);
    assert.equal(focus.canResume, true);
    assert.equal(focus.lastReleaseReason, 'administrator_skipped_focus');
    const cancelledSession = (await db.query<any>(`select status from content_writing_sessions
      where article_id=$1`, [secondArticleId])).rows[0];
    assert.equal(cancelledSession.status, 'cancelled');

    focus = (await db.query<any>('select resume_automatic_article_focus($1,$2) value', [
      userId, secondArticleId,
    ])).rows[0].value;
    assert.equal(focus.articleId, secondArticleId);
    assert.equal(focus.currentStage, 'preparation');
  } finally {
    await db.close();
  }
});
