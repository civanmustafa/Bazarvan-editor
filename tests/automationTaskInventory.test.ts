import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const admin = '00000000-0000-4000-8000-000000000001';
const owner = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';

test('automation task inventory is access-scoped and ranks running work first per type', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.articles (
        id uuid primary key, title text, created_by uuid,
        status text not null default 'draft',
        keywords jsonb not null default '{}'::jsonb,
        plain_text text not null default ''
      );
      create function public.article_access_level_for_user(p_article_id uuid, p_user_id uuid)
      returns text language sql stable as $$
        select case
          when p_user_id = '${admin}'::uuid then 'admin'
          when exists(select 1 from public.articles where id = p_article_id and created_by = p_user_id) then 'write'
          else 'none'
        end
      $$;
      create table public.article_automation_stage_states (
        article_id uuid references public.articles(id), stage text, status text,
        source_type text, source_id uuid, attempt_count integer default 0,
        max_attempts integer default 6, next_attempt_at timestamptz, last_error text,
        details jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now()
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key, article_id uuid references public.articles(id), job_type text,
        status text, input_snapshot jsonb, started_at timestamptz, next_attempt_at timestamptz,
        created_at timestamptz default now(), updated_at timestamptz default now(),
        last_error text, last_error_code text, attempt_count integer default 0,
        retry_count integer default 0, max_attempts integer default 6,
        origin text default 'auto', command_id text, progress jsonb default '{}',
        cancel_requested_at timestamptz, locked_by text, locked_at timestamptz,
        lease_expires_at timestamptz, completed_at timestamptz,
        dead_lettered_at timestamptz, dead_letter_reason text
        ,readiness_signature text, pipeline_parent_job_id uuid
      );
      create table public.ai_external_analysis_runs (
        id uuid primary key default gen_random_uuid(), job_id uuid references public.ai_external_analysis_jobs(id),
        run_number integer default 1, error_code text, error_message text
      );
      create table public.content_writing_automation_items (
        id uuid primary key, article_id uuid references public.articles(id), requested_by uuid, status text,
        readiness_signature text, usable_competitor_count integer default 0,
        pending_competitor_count integer default 0,
        ready_at timestamptz, eligible_at timestamptz, started_at timestamptz,
        next_recovery_at timestamptz, failure_class text, recovery_count integer default 0,
        content_writing_session_id uuid, run_generation integer default 1,
        session_sequence integer default 1, attempt_count integer default 0,
        max_attempts integer default 3, locked_by text, locked_at timestamptz,
        lease_expires_at timestamptz, last_error_code text, last_error text,
        completed_at timestamptz, updated_at timestamptz default now()
      );
      create table public.duplicate_cleanup_schedule (
        article_id uuid primary key references public.articles(id), signature text,
        quiet_since timestamptz default now(), dispatched_signature text
      );
      create table public.article_competitors (
        id uuid primary key default gen_random_uuid(),
        article_id uuid references public.articles(id),
        status text not null,
        content_text text not null default ''
      );
      create table public.app_settings (key text primary key, value jsonb not null);
      create table public.worker_queue_signals (queue_name text);
      create table public.automatic_article_focus_pauses (
        article_id uuid primary key references public.articles(id), reason text,
        error_code text, error_message text
      );
      create function public.automation_failure_is_retryable(text, text)
      returns boolean language sql immutable as $$
        select lower(coalesce($1, '') || ' ' || coalesce($2, '')) ~ '(503|timeout|quota)'
      $$;
      create function public.article_automatic_job_allowed(uuid, text, text default null)
      returns boolean language sql stable as $$ select true $$;
      create function public.article_automatic_policy_allows(uuid, text, text default null)
      returns boolean language sql stable as $$ select true $$;
      create function public.automatic_article_focus_allows(uuid, text)
      returns boolean language sql stable as $$ select true $$;
      create function public.article_editor_has_text(value text)
      returns boolean language sql immutable as $$ select nullif(btrim(coalesce(value, '')), '') is not null $$;
      create function public.evaluate_content_writing_automation_readiness(p_article_id uuid)
      returns jsonb language sql stable as $$
        with evidence as (
          select article.id, public.article_editor_has_text(article.plain_text) editor_has_text,
            count(competitor.id) filter (
              where competitor.status = 'completed'
                and nullif(btrim(competitor.content_text), '') is not null
            )::integer competitors
          from public.articles article
          left join public.article_competitors competitor on competitor.article_id = article.id
          where article.id = p_article_id
          group by article.id, article.plain_text
        )
        select jsonb_build_object(
          'ready', not editor_has_text and competitors >= 2,
          'signature', md5(id::text || ':' || competitors::text || ':' || editor_has_text::text),
          'missingFields', case
            when editor_has_text and competitors < 2 then '["article_editor_empty","competitors"]'::jsonb
            when editor_has_text then '["article_editor_empty"]'::jsonb
            when competitors < 2 then '["competitors"]'::jsonb
            else '[]'::jsonb
          end,
          'usableCompetitorCount', competitors,
          'minimumCompetitorCount', 2,
          'pendingCompetitorCount', 0,
          'processingComplete', true
        ) from evidence
      $$;
      create function public.initialize_article_automation_stage_states(uuid)
      returns void language sql as $$ select $$;
      insert into public.app_settings(key,value)
      values('ai', '{"contentWritingAutomationMaxAttempts":3,"contentWritingAutomationMinimumCompetitors":2}');
    `);
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261002000000_visible_automation_task_inventory.sql',
      import.meta.url,
    ), 'utf8'));
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261003000000_automation_inventory_completion_and_auto_recovery.sql',
      import.meta.url,
    ), 'utf8'));
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261004000000_draft_only_automation_stage_inventory.sql',
      import.meta.url,
    ), 'utf8'));
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261009000000_unify_automation_master_and_truthful_queue_inventory.sql',
      import.meta.url,
    ), 'utf8'));
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261010000000_classify_cancelled_writing_inventory.sql',
      import.meta.url,
    ), 'utf8'));
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261011000000_visible_automatic_recovery_schedule.sql',
      import.meta.url,
    ), 'utf8'));

    const articleOne = '10000000-0000-4000-8000-000000000001';
    const articleTwo = '10000000-0000-4000-8000-000000000002';
    const articleThree = '10000000-0000-4000-8000-000000000003';
    const jobOne = '20000000-0000-4000-8000-000000000001';
    await db.query(`insert into articles(id,title,created_by,status) values
      ($1,$2,$3,'draft'),($4,$5,$6,'in_review'),($7,$8,$9,'draft')`, [
      articleOne, 'Owner running task', owner,
      articleTwo, 'Other review task', other,
      articleThree, 'Other draft task', other,
    ]);
    await db.query(`insert into ai_external_analysis_jobs(
      id,article_id,job_type,status,input_snapshot,started_at
    ) values($1,$2,'semantic_keywords_lsi','running',$3,now()-interval '1 minute')`, [
      jobOne, articleOne, { needsSecondaries: true, needsLsi: true, needsGoogleMetadata: true },
    ]);
    await db.query(`insert into article_automation_stage_states(
      article_id,stage,status,source_type,source_id
    ) values
      ($1,'semantic_keywords_lsi','running','external_analysis',$2),
      ($1,'competitor_discovery','waiting_for_prerequisites',null,null),
      ($3,'semantic_keywords_lsi','queued',null,null),
      ($4,'semantic_keywords_lsi','queued',null,null)`, [articleOne, jobOne, articleTwo, articleThree]);
    await db.query(`insert into duplicate_cleanup_schedule(article_id,signature,quiet_since)
      values($1,'owner-signature',now()-interval '5 minutes')`, [articleOne]);

    const userRows = (await db.query<any>(
      'select public.get_visible_automation_task_inventory($1) inventory', [owner],
    )).rows[0].inventory;
    assert.ok(userRows.length >= 3);
    assert.ok(userRows.every((task: any) => task.articleId === articleOne));
    assert.equal(userRows.find((task: any) => task.operationKey === 'alternative_keywords').status, 'running');
    assert.equal(userRows.find((task: any) => task.operationKey === 'competitor_discovery').status, 'unscheduled');
    assert.equal(userRows.find((task: any) => task.operationKey === 'duplicate_suggestions').status, 'scheduled');

    const adminRows = (await db.query<any>(
      'select public.get_visible_automation_task_inventory($1) inventory', [admin],
    )).rows[0].inventory;
    const semanticRows = adminRows.filter((task: any) => task.operationKey === 'alternative_keywords');
    assert.deepEqual(semanticRows.map((task: any) => task.articleId), [articleOne, articleThree]);
    assert.ok(adminRows.every((task: any) => task.articleStatus === 'draft'));
    assert.deepEqual(semanticRows.map((task: any) => Number(task.priorityRank)), [1, 2]);

    await db.query(`update articles set keywords = $2 where id = $1`, [articleOne, {
      secondaries: ['صيغة بديلة محفوظة'],
      lsi: ['كلمة دلالية محفوظة'],
      googleTitles: ['عنوان أول', 'عنوان ثان'],
      googleDescriptions: [{ text: 'وصف أول' }, { text: 'وصف ثان' }],
    }]);
    await db.query(`update ai_external_analysis_jobs set status = 'completed' where id = $1`, [jobOne]);
    await db.query(`update article_automation_stage_states
      set status = 'waiting_for_prerequisites' where article_id = $1 and stage = 'semantic_keywords_lsi'`, [articleOne]);
    await db.query(`insert into article_competitors(article_id,status,content_text)
      values($1,'completed','محتوى منافس محفوظ')`, [articleOne]);
    await db.query(`insert into article_automation_stage_states(article_id,stage,status)
      values($1,'competitor_extraction','waiting_for_prerequisites')`, [articleOne]);

    const completedRows = (await db.query<any>(
      'select public.get_visible_automation_task_inventory($1) inventory', [owner],
    )).rows[0].inventory;
    assert.equal(completedRows.some((task: any) => task.operationKey === 'alternative_keywords'), false);
    assert.equal(completedRows.some((task: any) => task.operationKey === 'lsi_keywords'), false);
    assert.equal(completedRows.some((task: any) => task.operationKey === 'google_metadata'), false);
    assert.equal(completedRows.some((task: any) => task.operationKey === 'competitor_discovery'), false);
    assert.equal(completedRows.some((task: any) => task.operationKey === 'competitor_extraction'), false);

    const recoverableJob = '20000000-0000-4000-8000-000000000002';
    const futureRecoverableJob = '20000000-0000-4000-8000-000000000003';
    const recoverableWriting = '30000000-0000-4000-8000-000000000001';
    await db.query(`insert into ai_external_analysis_jobs(
      id,article_id,job_type,status,last_error_code,last_error,completed_at
    ) values
      ($1,$2,'competitor_extraction','failed','provider_503','Temporary provider outage',now()-interval '2 hours'),
      ($3,$2,'competitor_discovery','failed','provider_503','Temporary provider outage',now()-interval '30 minutes')`, [
      recoverableJob, articleOne, futureRecoverableJob,
    ]);
    await db.query(`insert into ai_external_analysis_runs(job_id,error_code,error_message)
      values($1,'provider_503','Temporary provider outage'),
        ($2,'provider_503','Temporary provider outage')`, [recoverableJob, futureRecoverableJob]);
    await db.query(`insert into content_writing_automation_items(
      id,article_id,status,failure_class,last_error_code,last_error,ready_at,eligible_at,completed_at
    ) values($1,$2,'blocked','transient','provider_503','Temporary provider outage',now(),now(),now())`, [
      recoverableWriting, articleOne,
    ]);
    await db.query(`update content_writing_automation_items
      set next_recovery_at=now()-interval '1 minute' where id=$1`, [recoverableWriting]);
    const recoverySchedule = (await db.query<any>(
      'select public.get_visible_automatic_recovery_schedule($1) schedule', [owner],
    )).rows[0].schedule;
    assert.equal(recoverySchedule.available, true);
    assert.equal(recoverySchedule.checkIntervalSeconds, 60);
    assert.equal(recoverySchedule.pendingCount, 3);
    assert.equal(recoverySchedule.dueCount, 2);
    assert.ok(Number.isFinite(Date.parse(recoverySchedule.nextRecoveryAt)));
    const recovered = (await db.query<any>(
      'select public.auto_requeue_recoverable_automation_failures(50) value',
    )).rows[0].value;
    assert.deepEqual(recovered, {
      externalAnalysis: 1, contentWriting: 1, total: 2, skipped: false,
    });
    const recoveredJob = (await db.query<any>(
      'select status, progress->>\'automaticRecoveryCount\' recovery_count from ai_external_analysis_jobs where id=$1',
      [recoverableJob],
    )).rows[0];
    assert.deepEqual(recoveredJob, { status: 'retry_scheduled', recovery_count: '1' });
    const recoveredWriting = (await db.query<any>(
      'select status,recovery_count from content_writing_automation_items where id=$1',
      [recoverableWriting],
    )).rows[0];
    assert.deepEqual(recoveredWriting, { status: 'ready', recovery_count: 1 });
    const futureRecoverySchedule = (await db.query<any>(
      'select public.get_visible_automatic_recovery_schedule($1) schedule', [owner],
    )).rows[0].schedule;
    assert.equal(futureRecoverySchedule.pendingCount, 1);
    assert.equal(futureRecoverySchedule.dueCount, 0);
    assert.ok(Date.parse(futureRecoverySchedule.nextRecoveryAt) > Date.now());
    await db.query("update ai_external_analysis_jobs set status='cancelled' where id=$1", [futureRecoverableJob]);
    const emptyRecoverySchedule = (await db.query<any>(
      'select public.get_visible_automatic_recovery_schedule($1) schedule', [owner],
    )).rows[0].schedule;
    assert.equal(emptyRecoverySchedule.pendingCount, 0);
    assert.equal(emptyRecoverySchedule.dueCount, 0);
    assert.equal(emptyRecoverySchedule.nextRecoveryAt, null);

    const supersededArticle = '10000000-0000-4000-8000-000000000004';
    const supersededWriting = '30000000-0000-4000-8000-000000000004';
    await db.query(`insert into articles(id,title,created_by,status)
      values($1,'Superseded manual writing',$2,'draft')`, [supersededArticle, owner]);
    await db.query(`insert into article_competitors(article_id,status,content_text) values
      ($1,'completed','First competitor text'),($1,'completed','Second competitor text')`, [supersededArticle]);
    await db.query(`insert into content_writing_automation_items(
      id,article_id,requested_by,status,last_error_code,last_error,ready_at,eligible_at,completed_at
    ) values($1,$2,$3,'cancelled','superseded_by_explicit_manual',
      'Automatic writing was superseded by an explicit article-writing request.',now(),now(),now())`, [
      supersededWriting, supersededArticle, owner,
    ]);
    await db.query(`insert into article_automation_stage_states(
      article_id,stage,status,source_type,source_id,last_error
    ) values($1,'content_writing_preparation','waiting_for_prerequisites',null,null,
      'Automatic writing was superseded by an explicit article-writing request.')`, [
      supersededArticle,
    ]);
    const supersededTask = (await db.query<any>(
      'select public.get_visible_automation_task_inventory($1) inventory', [owner],
    )).rows[0].inventory.find((task: any) => task.articleId === supersededArticle);
    assert.equal(supersededTask.status, 'unscheduled');
    assert.equal(supersededTask.reasonCode, 'superseded_by_manual_request');
    assert.equal(supersededTask.runnable, false);

    const privileges = (await db.query<any>(`select
      has_function_privilege('anon','public.get_visible_automation_task_inventory(uuid)','execute') anonymous,
      has_function_privilege('authenticated','public.get_visible_automation_task_inventory(uuid)','execute') browser,
      has_function_privilege('service_role','public.get_visible_automation_task_inventory(uuid)','execute') worker`)).rows[0];
    assert.deepEqual(privileges, { anonymous: false, browser: false, worker: true });
    const recoveryPrivileges = (await db.query<any>(`select
      has_function_privilege('anon','public.get_visible_automatic_recovery_schedule(uuid)','execute') anonymous,
      has_function_privilege('authenticated','public.get_visible_automatic_recovery_schedule(uuid)','execute') browser,
      has_function_privilege('service_role','public.get_visible_automatic_recovery_schedule(uuid)','execute') worker`)).rows[0];
    assert.deepEqual(recoveryPrivileges, { anonymous: false, browser: false, worker: true });
  } finally {
    await db.close();
  }
});
