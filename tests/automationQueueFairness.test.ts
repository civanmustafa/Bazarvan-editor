import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('pipeline preserves the selected competitor count instead of forcing three', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261005000000_competitor_count_and_queue_fairness.sql',
  );
  assert.match(migration, /v_competitor_count integer := greatest\(2, least\(coalesce\(p_competitor_count, 5\), 5\)\)/);
  assert.match(migration, /'competitorCount', v_competitor_count/);
  assert.doesNotMatch(migration, /v_competitor_count integer := greatest\(3,/);
  const [api, control, executor] = await Promise.all([
    readWorkspaceFile('api/externalAnalysis.ts'),
    readWorkspaceFile('components/FullArticlePipelineControl.tsx'),
    readWorkspaceFile('server/fullArticlePipelineExecutor.ts'),
  ]);
  for (const source of [api, control, executor]) {
    assert.match(source, /CONTENT_WRITING_MIN_CONFIGURABLE_COMPETITOR_COUNT/);
  }
});

test('external failures release the article turn after one queue attempt', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20261005000000_competitor_count_and_queue_fairness.sql',
  );
  assert.match(migration, /old\.status = 'running' and new\.status = 'retry_scheduled'/);
  assert.match(migration, /'articleQueueLocked', false/);
  assert.match(migration, /'queuePolicy', 'round_robin_after_attempt'/);
  assert.match(migration, /sibling\.article_id = new\.article_id/);
});

test('automatic writing defers retries while an article has consumed fewer attempts', async () => {
  const [migration, scheduler] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20261005000000_competitor_count_and_queue_fairness.sql'),
    readWorkspaceFile('server/contentWritingAutomation.ts'),
  ]);
  assert.match(migration, /coalesce\(existing\.attempt_count, 0\) < v_candidate\.attempt_count/);
  assert.match(migration, /eligible_at = now\(\) \+ interval '5 seconds'/);
  assert.match(migration, /p_progress->>'automaticResume'/);
  assert.match(scheduler, /defer_due_automatic_content_writing_retry_for_fairness/);
  assert.match(scheduler, /if \(!retryDeferredForFairness\)/);
});

test('queue fairness migration executes and enforces count and turn rotation in PostgreSQL', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.articles (
        id uuid primary key, title text, article_language text default 'ar',
        keywords jsonb default '{}', goal_context jsonb default '{}',
        content_json jsonb default '{}', content_html text default '', plain_text text default '',
        save_count integer default 0, status text default 'draft',
        created_at timestamptz default now(), updated_at timestamptz default now()
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(), article_id uuid, requested_by uuid,
        job_type text, origin text, status text, idempotency_key text, batch_key text,
        sequence_number integer default 0, readiness_signature text, input_snapshot jsonb default '{}',
        progress jsonb default '{}', next_attempt_at timestamptz, max_attempts integer default 6,
        cancel_requested_at timestamptz, last_error_code text,
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      );
      create table public.content_writing_sessions (
        id uuid primary key default gen_random_uuid(), article_id uuid, status text,
        execution_mode text default 'api', cancel_requested_at timestamptz,
        context_snapshot jsonb default '{}', last_error_code text
      );
      create table public.content_writing_automation_items (
        id uuid primary key default gen_random_uuid(), article_id uuid,
        content_writing_session_id uuid, status text, eligible_at timestamptz,
        attempt_count integer default 0, max_attempts integer default 6,
        ready_at timestamptz default now(), updated_at timestamptz default now()
      );
      create table public.app_settings (key text primary key, value jsonb not null);
      create function public.article_access_level_for_user(uuid, uuid)
      returns text language sql stable as $$ select 'admin'::text $$;
      create function public.full_article_pipeline_content_hash(jsonb, text, text)
      returns text language sql immutable as $$ select md5(coalesce($2, '') || coalesce($3, '')) $$;
      create function public.article_automatic_job_allowed(uuid, text, text default null)
      returns boolean language sql stable as $$ select true $$;
      create function public.evaluate_content_writing_automation_readiness(uuid)
      returns jsonb language sql stable as $$
        select '{"ready":true,"usableCompetitorCount":2,"processingComplete":true}'::jsonb
      $$;
    `);
    await db.exec(await readWorkspaceFile(
      'supabase/migrations/20261005000000_competitor_count_and_queue_fairness.sql',
    ));

    const userId = '00000000-0000-4000-8000-000000000001';
    const firstArticle = '10000000-0000-4000-8000-000000000001';
    const nextArticle = '10000000-0000-4000-8000-000000000002';
    await db.query(`insert into articles(id,title,keywords) values
      ($1,'First','{"primary":"one"}'),($2,'Next','{"primary":"two"}')`, [firstArticle, nextArticle]);
    const pipeline = (await db.query<any>(
      "select * from enqueue_full_article_pipeline($1,$2,'gemini','model',2,'count-two')",
      [firstArticle, userId],
    )).rows[0];
    assert.equal(Number(pipeline.input_snapshot.competitorCount), 2);

    const siblingId = '20000000-0000-4000-8000-000000000001';
    await db.query(`insert into ai_external_analysis_jobs(
      id,article_id,requested_by,job_type,origin,status,idempotency_key,progress
    ) values($1,$2,$3,'engineering_command','auto','queued','sibling',
      '{"articleQueueLocked":true}')`, [siblingId, firstArticle, userId]);
    await db.query("update ai_external_analysis_jobs set status='running', progress='{" + '"articleQueueLocked":true' + "}' where id=$1", [pipeline.id]);
    await db.query("update ai_external_analysis_jobs set status='retry_scheduled' where id=$1", [pipeline.id]);
    const locks = await db.query<any>(
      "select progress->>'articleQueueLocked' locked from ai_external_analysis_jobs where article_id=$1 order by id",
      [firstArticle],
    );
    assert.deepEqual(locks.rows.map(row => row.locked), ['false', 'false']);

    const sessionId = '30000000-0000-4000-8000-000000000001';
    await db.query(`insert into content_writing_sessions(
      id,article_id,status,context_snapshot,last_error_code
    ) values($1,$2,'failed','{"triggerSource":"automatic_ready"}','provider_503')`, [sessionId, firstArticle]);
    await db.query(`insert into content_writing_automation_items(
      article_id,content_writing_session_id,status,eligible_at,attempt_count,max_attempts
    ) values($1,$2,'ready',now()-interval '1 minute',1,6)`, [firstArticle, sessionId]);
    await db.query(`insert into app_settings(key,value) values(
      'ai','{"contentWritingAutomationMinimumCompetitors":2}'
    )`);
    const deferred = (await db.query<any>(
      'select defer_due_automatic_content_writing_retry_for_fairness() value',
    )).rows[0].value;
    assert.equal(deferred, true);
  } finally {
    await db.close();
  }
});
