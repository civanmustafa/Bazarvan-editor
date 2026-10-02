import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const articleResolved = '10000000-0000-4000-8000-000000000001';
const articleBlocked = '10000000-0000-4000-8000-000000000002';

test('current blocker migration releases stale prerequisites and reports only one root failure', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.articles (
        id uuid primary key, title text not null, status text not null,
        keywords jsonb not null default '{}'::jsonb, plain_text text,
        created_at timestamptz default now()
      );
      create table public.app_settings (key text primary key, value jsonb not null);
      create table public.article_competitors (
        article_id uuid references public.articles(id), status text, content_text text
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(), article_id uuid references public.articles(id),
        job_type text, origin text default 'auto', last_error_code text, last_error text, status text,
        attempt_count integer default 0, locked_by text, locked_at timestamptz,
        lease_expires_at timestamptz, next_attempt_at timestamptz,
        started_at timestamptz, completed_at timestamptz,
        progress jsonb default '{}'::jsonb,
        cancel_requested_at timestamptz, updated_at timestamptz default now()
      );
      create table public.ai_external_analysis_runs (
        job_id uuid references public.ai_external_analysis_jobs(id) on delete cascade,
        run_number integer, status text, primary key(job_id,run_number)
      );
      create table public.automatic_article_focus_pauses (
        article_id uuid primary key references public.articles(id), reason text,
        error_code text, error_message text, paused_at timestamptz, updated_at timestamptz
      );
      create table public.automatic_article_focus (
        singleton boolean primary key, article_id uuid, last_article_id uuid,
        state text, current_stage text, last_release_reason text, released_at timestamptz,
        next_retry_at timestamptz, last_error_code text, last_error text,
        last_progress_at timestamptz, updated_at timestamptz
      );
      create table public.worker_queue_signals (queue_name text unique);

      create function public.article_is_globally_trashed(uuid)
      returns boolean language sql stable as $$ select false $$;
      create function public.article_editor_has_text(text)
      returns boolean language sql immutable as $$ select nullif(btrim($1), '') is not null $$;
      create function public.article_access_level_for_user(uuid,uuid)
      returns text language sql stable as $$ select 'owner'::text $$;
      create function public.article_automation_policy(uuid)
      returns jsonb language sql stable as $$ select '{
        "autoGenerateAlternativeKeywords":true,
        "autoGenerateLsiKeywords":true,
        "autoGenerateGoogleMetadata":true
      }'::jsonb $$;
      create function public.semantic_keywords_have_google_metadata(jsonb)
      returns boolean language sql stable as $$ select true $$;
      create function public.evaluate_content_writing_automation_readiness(p_article_id uuid)
      returns jsonb language sql stable as $$
        select case when p_article_id = '${articleResolved}'::uuid
          then '{"usableCompetitorCount":2,"minimumCompetitorCount":2}'::jsonb
          else '{"usableCompetitorCount":0,"minimumCompetitorCount":2}'::jsonb end
      $$;
      create function public.automation_failure_is_retryable(text,text)
      returns boolean language sql immutable as $$
        select lower(coalesce($1,'') || ' ' || coalesce($2,'')) ~ '(429|temporar)'
      $$;
      create function public.automatic_content_writing_requirement(uuid)
      returns jsonb language sql stable as $$ select '{"required":true}'::jsonb $$;
      create function public.reconcile_automatic_article_focus()
      returns jsonb language sql as $$ select '{}'::jsonb $$;
      create function public.release_recoverable_automatic_focus_stalls(integer)
      returns integer language sql as $$ select 0 $$;
      create function public.auto_requeue_recoverable_automation_failures(p_limit integer)
      returns jsonb language plpgsql as $$
      declare v_limit integer := p_limit;
      begin
        perform public.release_recoverable_automatic_focus_stalls(v_limit);
        select greatest(1, least(v_limit, 200)) into v_limit;
        return jsonb_build_object('total', 0);
      end;
      $$;
      create function public.get_visible_automation_task_inventory_v13(uuid)
      returns jsonb language sql stable as $$
        select jsonb_build_array(
          jsonb_build_object(
            'taskId','resolved-external','operationKey','external_analysis',
            'articleId','${articleResolved}','articleTitle','Resolved prerequisite',
            'articleStatus','draft','status','failed','scheduled',false,
            'updatedAt','2026-10-01T00:00:00Z','reasonCode','content_research_automation_changed',
            'reason','Automatic retry limit (5) reached. Last error: Automatic competitor work is waiting for every enabled keyword stage.',
            'attemptCount',0,'maxAttempts',1,'recoveryCount',0,'maxRecoveries',3,
            'manualReview',true,'runnable',false,'missingFields','[]'::jsonb
          ),
          jsonb_build_object(
            'taskId','blocked-root','operationKey','competitor_discovery',
            'articleId','${articleBlocked}','articleTitle','No competitors',
            'articleStatus','draft','status','failed','scheduled',false,
            'updatedAt','2026-10-01T00:00:00Z','reasonCode','content_writing_no_competitors_found',
            'reason','No suitable competitor pages were available after automatic discovery.',
            'attemptCount',1,'maxAttempts',6,'recoveryCount',0,'maxRecoveries',3,
            'manualReview',true,'runnable',false,'missingFields','[]'::jsonb
          ),
          jsonb_build_object(
            'taskId','blocked-dependent','operationKey','external_analysis',
            'articleId','${articleBlocked}','articleTitle','No competitors',
            'articleStatus','draft','status','failed','scheduled',false,
            'updatedAt','2026-10-01T00:00:00Z','reasonCode','content_writing_no_competitors_found',
            'reason','No suitable competitor pages were available after automatic discovery.',
            'attemptCount',0,'maxAttempts',1,'recoveryCount',0,'maxRecoveries',3,
            'manualReview',true,'runnable',false,'missingFields','[]'::jsonb
          )
        )
      $$;
      create function public.get_visible_automation_task_inventory(uuid)
      returns jsonb language sql stable as $$
        select public.get_visible_automation_task_inventory_v13($1)
      $$;
      create function public.content_writing_automation_schema_version()
      returns integer language sql immutable as $$ select 14 $$;

      insert into public.articles(id,title,status,keywords) values
        ('${articleResolved}','Resolved prerequisite','draft','{
          "secondaries":["alternative"],"lsi":["semantic"]
        }'::jsonb),
        ('${articleBlocked}','No competitors','draft','{
          "secondaries":["alternative"],"lsi":["semantic"]
        }'::jsonb);
      insert into public.app_settings(key,value) values(
        'ai','{"contentWritingAutomationMinimumCompetitors":2}'::jsonb
      );
      insert into public.automatic_article_focus(singleton,last_article_id,state)
      values(true,'${articleResolved}','needs_attention');
      insert into public.automatic_article_focus_pauses(
        article_id,reason,error_code,error_message,paused_at,updated_at
      ) values
        ('${articleResolved}','terminal_stage_failure','content_research_automation_changed',
          'Automatic competitor work is waiting for every enabled keyword stage.',
          now()-interval '1 day',now()-interval '1 day'),
        ('${articleBlocked}','terminal_stage_failure','content_writing_no_competitors_found',
          'No suitable competitor pages were available after automatic discovery.',
          now()-interval '1 day',now()-interval '1 day');
    `);

    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261018000000_current_blocker_and_historical_error.sql',
      import.meta.url,
    ), 'utf8'));

    const pauses = await db.query<{ article_id: string }>(`
      select article_id::text from public.automatic_article_focus_pauses order by article_id
    `);
    assert.deepEqual(pauses.rows, [{ article_id: articleBlocked }]);

    const history = await db.query<{ article_id: string; resolution_code: string }>(`
      select article_id::text, resolution_code
      from public.automatic_article_focus_pause_history
    `);
    assert.deepEqual(history.rows, [{
      article_id: articleResolved,
      resolution_code: 'prerequisite_now_satisfied',
    }]);

    const inventory = (await db.query<any>(`
      select public.get_visible_automation_task_inventory(
        '00000000-0000-4000-8000-000000000001'::uuid
      ) inventory
    `)).rows[0].inventory;
    const resolved = inventory.find((task: any) => task.taskId === 'resolved-external');
    const root = inventory.find((task: any) => task.taskId === 'blocked-root');
    const dependent = inventory.find((task: any) => task.taskId === 'blocked-dependent');
    assert.equal(resolved.status, 'unscheduled');
    assert.equal(resolved.reasonCode, 'historical_blocker_resolved');
    assert.equal(resolved.manualReview, false);
    assert.equal(root.status, 'failed');
    assert.equal(root.manualReview, true);
    assert.equal(root.rootOperationKey, 'competitor_discovery');
    assert.equal(dependent.status, 'unscheduled');
    assert.equal(dependent.reasonCode, 'blocked_by_upstream');
    assert.equal(dependent.manualReview, false);

    const deferredJobId = '20000000-0000-4000-8000-000000000001';
    await db.exec(`
      insert into public.ai_external_analysis_jobs(
        id,article_id,job_type,origin,status,attempt_count,locked_by,locked_at,
        lease_expires_at,started_at,progress
      ) values (
        '${deferredJobId}','${articleResolved}','competitor_discovery','auto',
        'running',3,'worker-1',now(),now()+interval '5 minutes',now(),'{}'::jsonb
      );
      insert into public.ai_external_analysis_runs(job_id,run_number,status)
      values('${deferredJobId}',3,'running');
      select public.defer_external_analysis_job_for_prerequisite(
        '${deferredJobId}','worker-1','content_research_automation_changed',
        'Automatic competitor work is waiting for every enabled keyword stage.',
        '{"blockedBy":"semantic_keywords"}'::jsonb
      );
    `);
    const deferred = (await db.query<any>(`
      select status,attempt_count,"locked_by",last_error_code
      from public.ai_external_analysis_jobs where id='${deferredJobId}'
    `)).rows[0];
    assert.equal(deferred.status, 'waiting_for_prerequisites');
    assert.equal(deferred.attempt_count, 2);
    assert.equal(deferred.locked_by, null);
    assert.equal((await db.query<{ count: number }>(`
      select count(*)::integer count from public.ai_external_analysis_runs
      where job_id='${deferredJobId}'
    `)).rows[0].count, 0);
    assert.equal((await db.query<{ resumed: number }>(`
      select public.resume_satisfied_automatic_prerequisite_jobs(10) resumed
    `)).rows[0].resumed, 1);
    assert.equal((await db.query<{ status: string }>(`
      select status from public.ai_external_analysis_jobs where id='${deferredJobId}'
    `)).rows[0].status, 'queued');

    const master = (await db.query<{ definition: string }>(`
      select pg_get_functiondef(
        'public.auto_requeue_recoverable_automation_failures(integer)'::regprocedure
      ) definition
    `)).rows[0].definition;
    assert.match(master, /resume_satisfied_automatic_prerequisite_jobs/);
    assert.match(master, /release_reclassified_automatic_focus_pauses/);
    assert.match(master, /release_recoverable_automatic_focus_stalls/);
    assert.equal((await db.query<{ version: number }>(`
      select public.content_writing_automation_schema_version() version
    `)).rows[0].version, 15);

    await db.exec(`
      create or replace function public.get_visible_automation_task_inventory(p_requested_by uuid)
      returns jsonb language sql stable as $$
        select jsonb_build_array(jsonb_build_object(
          'taskId','google-waiting','operationKey','google_metadata',
          'articleId','${articleResolved}','articleTitle','Resolved prerequisite',
          'articleStatus','draft','status','unscheduled','scheduled',false,
          'updatedAt','2026-10-01T00:00:00Z','reasonCode','waiting_for_prerequisites',
          'reason','Waiting for prerequisites','attemptCount',0,'maxAttempts',6,
          'recoveryCount',0,'maxRecoveries',3,'manualReview',false,'runnable',false,
          'missingFields','[]'::jsonb
        ))
      $$;
      update public.automatic_article_focus set
        article_id='${articleBlocked}', state='active', current_stage='duplicate_cleanup';
    `);
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261019000000_detailed_automation_prerequisites.sql',
      import.meta.url,
    ), 'utf8'));

    const detailedInventory = (await db.query<any>(`
      select public.get_visible_automation_task_inventory(
        '00000000-0000-4000-8000-000000000001'::uuid
      ) inventory
    `)).rows[0].inventory;
    const detailed = detailedInventory[0];
    assert.equal(detailed.reasonCode, 'automatic_article_focus');
    assert.equal(detailed.blockedByArticleTitle, 'No competitors');
    assert.equal(detailed.blockedByStage, 'duplicate_cleanup');
    assert.equal(detailed.blockedByState, 'active');
    assert.deepEqual(
      detailed.requirements.map((requirement: any) => ({
        code: requirement.code,
        state: requirement.state,
        current: requirement.current ?? null,
        required: requirement.required ?? null,
      })),
      [
        { code: 'google_titles', state: 'missing', current: 0, required: 2 },
        { code: 'google_descriptions', state: 'missing', current: 0, required: 2 },
        { code: 'automatic_article_focus', state: 'blocked', current: null, required: null },
      ],
    );
    assert.equal((await db.query<{ version: number }>(`
      select public.content_writing_automation_schema_version() version
    `)).rows[0].version, 16);

    await db.exec(`
      create or replace function public.get_visible_automation_task_inventory(p_requested_by uuid)
      returns jsonb language sql stable as $$
        select jsonb_build_array(jsonb_build_object(
          'taskId','external-waiting','operationKey','external_analysis',
          'articleId','${articleResolved}','articleTitle','Resolved prerequisite',
          'articleStatus','draft','status','unscheduled','scheduled',false,
          'updatedAt','2026-10-01T00:00:00Z','reasonCode','waiting_for_prerequisites',
          'reason','Waiting for prerequisites','attemptCount',0,'maxAttempts',1,
          'recoveryCount',0,'maxRecoveries',3,'manualReview',false,'runnable',false,
          'missingFields','[]'::jsonb,'requirements','[]'::jsonb
        ))
      $$;
      update public.automatic_article_focus set
        article_id='${articleResolved}', state='active', current_stage='content_writing';
    `);
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261020000000_detailed_upstream_stage_state.sql',
      import.meta.url,
    ), 'utf8'));

    const upstreamInventory = (await db.query<any>(`
      select public.get_visible_automation_task_inventory(
        '00000000-0000-4000-8000-000000000001'::uuid
      ) inventory
    `)).rows[0].inventory;
    assert.equal(upstreamInventory[0].upstreamStage, 'content_writing');
    assert.equal(upstreamInventory[0].upstreamState, 'active');
    assert.deepEqual(upstreamInventory[0].requirements, [{
      code: 'content_writing',
      state: 'running',
      articleId: articleResolved,
      stage: 'content_writing',
    }]);
    assert.equal((await db.query<{ version: number }>(`
      select public.content_writing_automation_schema_version() version
    `)).rows[0].version, 17);
  } finally {
    await db.close();
  }
});
