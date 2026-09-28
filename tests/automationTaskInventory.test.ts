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
        keywords jsonb not null default '{}'::jsonb
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
      );
      create table public.ai_external_analysis_runs (
        id uuid primary key default gen_random_uuid(), job_id uuid references public.ai_external_analysis_jobs(id),
        run_number integer default 1, error_code text, error_message text
      );
      create table public.content_writing_automation_items (
        id uuid primary key, article_id uuid references public.articles(id), status text,
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
      create function public.automation_failure_is_retryable(text, text)
      returns boolean language sql immutable as $$
        select lower(coalesce($1, '') || ' ' || coalesce($2, '')) ~ '(503|timeout|quota)'
      $$;
      create function public.article_automatic_job_allowed(uuid, text, text default null)
      returns boolean language sql stable as $$ select true $$;
      insert into public.app_settings(key,value)
      values('ai', '{"contentWritingAutomationMaxAttempts":3}');
    `);
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261002000000_visible_automation_task_inventory.sql',
      import.meta.url,
    ), 'utf8'));
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261003000000_automation_inventory_completion_and_auto_recovery.sql',
      import.meta.url,
    ), 'utf8'));

    const articleOne = '10000000-0000-4000-8000-000000000001';
    const articleTwo = '10000000-0000-4000-8000-000000000002';
    const jobOne = '20000000-0000-4000-8000-000000000001';
    await db.query('insert into articles(id,title,created_by) values($1,$2,$3),($4,$5,$6)', [
      articleOne, 'Owner running task', owner, articleTwo, 'Other scheduled task', other,
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
      ($3,'semantic_keywords_lsi','queued',null,null)`, [articleOne, jobOne, articleTwo]);
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
    assert.deepEqual(semanticRows.map((task: any) => task.articleId), [articleOne, articleTwo]);
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
    const recoverableWriting = '30000000-0000-4000-8000-000000000001';
    await db.query(`insert into ai_external_analysis_jobs(
      id,article_id,job_type,status,last_error_code,last_error,completed_at
    ) values($1,$2,'competitor_extraction','failed','provider_503','Temporary provider outage',now())`, [
      recoverableJob, articleOne,
    ]);
    await db.query(`insert into ai_external_analysis_runs(job_id,error_code,error_message)
      values($1,'provider_503','Temporary provider outage')`, [recoverableJob]);
    await db.query(`insert into content_writing_automation_items(
      id,article_id,status,failure_class,last_error_code,last_error,ready_at,eligible_at,completed_at
    ) values($1,$2,'blocked','transient','provider_503','Temporary provider outage',now(),now(),now())`, [
      recoverableWriting, articleOne,
    ]);
    const recovered = (await db.query<any>(
      'select public.auto_requeue_recoverable_automation_failures(50) value',
    )).rows[0].value;
    assert.deepEqual(recovered, { externalAnalysis: 1, contentWriting: 1, total: 2 });
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

    const privileges = (await db.query<any>(`select
      has_function_privilege('anon','public.get_visible_automation_task_inventory(uuid)','execute') anonymous,
      has_function_privilege('authenticated','public.get_visible_automation_task_inventory(uuid)','execute') browser,
      has_function_privilege('service_role','public.get_visible_automation_task_inventory(uuid)','execute') worker`)).rows[0];
    assert.deepEqual(privileges, { anonymous: false, browser: false, worker: true });
  } finally {
    await db.close();
  }
});
