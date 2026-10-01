import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('post-writing orchestration preserves the required dependency graph', async () => {
  const [migration, api, client, automationStages] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20261006000000_article_work_readiness_orchestration.sql'),
    readWorkspaceFile('api/contentWritingAutomation.ts'),
    readWorkspaceFile('utils/contentWritingAutomation.ts'),
    readWorkspaceFile('utils/articleAutomationStages.ts'),
  ]);

  assert.match(migration, /'google_metadata'/);
  assert.match(migration, /'semantic_processing'/);
  assert.match(migration, /'competitor_discovery_processing'/);
  assert.match(migration, /'competitor_extraction_processing'/);
  assert.match(migration, /blockedBy', 'duplicate_cleanup'/);
  assert.match(migration, /dependencyPolicy', 'independent_after_cleanup'/);
  assert.match(migration, /depends_on_job_id = null/);
  assert.match(migration, /readinessPriority', 'post_write_finalize'/);
  assert.match(migration, /enqueue_cleanup_after_automatic_writing_apply/);
  assert.match(api, /get_articles_automation_work_readiness/);
  assert.match(client, /ContentWritingWorkReadinessState/);
  assert.match(automationStages, /أدرج المحتوى تلقائيا · جاهزة للعمل/);
  assert.match(automationStages, /أدرج المحتوى تلقائيا · تنقية المحتوى/);
  assert.match(automationStages, /أدرج المحتوى تلقائيا · تنفيذ التدقيقات الخارجية/);
});

test('orchestration migration executes and gates writing, cleanup, and independent audits', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.articles (
        id uuid primary key, status text default 'draft', title text,
        article_language text default 'ar', plain_text text default '',
        content_json jsonb default '{"type":"doc","content":[]}',
        keywords jsonb default '{}', goal_context jsonb default '{}',
        updated_at timestamptz default now()
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(), article_id uuid,
        requested_by uuid, job_type text, origin text default 'auto', status text,
        input_snapshot jsonb default '{}', progress jsonb default '{}',
        pipeline_parent_job_id uuid, depends_on_job_id uuid, sequence_number integer default 0,
        command_id text, readiness_signature text, next_attempt_at timestamptz,
        locked_by text, locked_at timestamptz, lease_expires_at timestamptz,
        cancel_requested_at timestamptz, attempt_count integer default 0,
        retry_count integer default 0, max_attempts integer default 6,
        completed_at timestamptz, last_error_code text, last_error text,
        created_at timestamptz default now(), updated_at timestamptz default now()
      );
      create table public.article_competitors (
        id uuid primary key default gen_random_uuid(), article_id uuid, position integer,
        status text, content_text text, source_origin text, source_class text,
        content_weight numeric, word_count integer
      );
      create table public.app_settings (key text primary key, value jsonb not null);
      create table public.ai_external_analysis_article_state (
        article_id uuid primary key, external_analysis_ready boolean default false,
        external_analysis_readiness_signature text
      );
      create table public.article_automation_stage_states (
        article_id uuid, stage text check (stage in (
          'semantic_keywords_lsi','competitor_discovery','competitor_extraction',
          'content_writing_preparation','content_writing','engineering_commands'
        )), status text default 'waiting_for_prerequisites', source_type text,
        source_id uuid, readiness_signature text, attempt_count integer default 0,
        retry_count integer default 0, max_attempts integer default 1,
        next_attempt_at timestamptz, last_error_code text, last_error text,
        details jsonb default '{}', last_transition_at timestamptz default now(),
        created_at timestamptz default now(), updated_at timestamptz default now(),
        primary key(article_id,stage)
      );
      create table public.content_writing_sessions (
        id uuid primary key default gen_random_uuid(), article_id uuid, created_by uuid,
        applied_at timestamptz, context_snapshot jsonb default '{}'
      );
      create table public.duplicate_cleanup_schedule (
        article_id uuid primary key, signature text, quiet_since timestamptz,
        dispatched_signature text
      );

      create function public.article_automation_policy(uuid) returns jsonb language sql stable as $$
        select '{"autoGenerateAlternativeKeywords":true,"autoGenerateLsiKeywords":true,
          "autoGenerateGoogleMetadata":true,"autoRunReadyEngineeringCommands":true,
          "externalAnalysisCommandIds":["audit_a","audit_b"]}'::jsonb
      $$;
      create function public.article_editor_has_text(text) returns boolean language sql immutable as $$
        select nullif(btrim(coalesce($1,'')), '') is not null
      $$;
      create function public.semantic_keywords_have_google_metadata(jsonb) returns boolean language sql immutable as $$
        select coalesce(jsonb_array_length(coalesce($1->'googleTitles','[]')),0) >= 2
          and coalesce(jsonb_array_length(coalesce($1->'googleDescriptions','[]')),0) >= 2
      $$;
      create function public.external_analysis_has_competitor_value(jsonb, integer) returns boolean
        language sql immutable as $$ select coalesce(jsonb_array_length(coalesce($1,'[]')),0) > 0 $$;
      create function public.sync_external_automation_stage_state(uuid,text) returns void
        language sql as $$ select $$;
      create function public.cancel_stale_external_engineering_jobs(uuid,text,boolean) returns integer
        language sql as $$ select 0 $$;
      create function public.cancel_automatic_ready_engineering_jobs(uuid) returns integer
        language sql as $$ select 0 $$;
      create function public.enqueue_external_semantic_analysis_job_controlled(uuid,text) returns uuid
        language sql as $$ select null::uuid $$;
      create function public.enqueue_external_engineering_jobs_controlled(uuid,uuid,text) returns uuid[]
        language plpgsql as $$
        declare first_id uuid := gen_random_uuid(); second_id uuid := gen_random_uuid();
        begin
          insert into ai_external_analysis_jobs(
            id,article_id,job_type,origin,status,command_id,readiness_signature,sequence_number
          ) values
            (first_id,$1,'engineering_command','auto','queued','audit_a','sig-clean',1),
            (second_id,$1,'engineering_command','auto','queued','audit_b','sig-clean',2);
          update ai_external_analysis_jobs set depends_on_job_id=first_id where id=second_id;
          return array[first_id,second_id];
        end $$;
      create function public.enqueue_unified_duplicate_cleanup(uuid,uuid,boolean,text)
      returns setof public.ai_external_analysis_jobs language plpgsql as $$
        declare queued public.ai_external_analysis_jobs%rowtype; source public.articles%rowtype;
        begin
          select * into source from articles where id=$1;
          insert into ai_external_analysis_jobs(
            article_id,requested_by,job_type,origin,status,input_snapshot,next_attempt_at
          ) values($1,$2,'duplicate_cleanup',case when $3 then 'auto' else 'manual' end,'queued',
            jsonb_build_object('version',2,'document',source.content_json,'keywords',source.keywords,
              'language',source.article_language,'title',source.title),now()) returning * into queued;
          return next queued;
        end $$;
    `);

    await db.exec(await readWorkspaceFile(
      'supabase/migrations/20261006000000_article_work_readiness_orchestration.sql',
    ));

    const articleId = '10000000-0000-4000-8000-000000000001';
    const userId = '20000000-0000-4000-8000-000000000001';
    const keywords = JSON.stringify({
      primary: 'keyword', company: 'company', secondaries: ['alt'], lsi: ['lsi'],
      googleTitles: ['one', 'two'], googleDescriptions: ['one', 'two'],
    });
    const goal = JSON.stringify({
      pageType: 'article', objective: 'inform', audienceScope: 'all', searchIntent: 'informational',
    });
    await db.query(`insert into articles(id,title,keywords,goal_context) values($1,'Article',$2,$3)`, [
      articleId, keywords, goal,
    ]);
    await db.query(`insert into app_settings(key,value)
      values('ai','{"contentWritingAutomationMinimumCompetitors":"2"}')`);
    await db.query(`insert into ai_external_analysis_article_state values($1,true,'sig-clean')`, [articleId]);
    await db.query(`insert into article_competitors(article_id,position,status,content_text)
      values($1,1,'completed','first'),($1,2,'completed','second')`, [articleId]);
    await db.query(`insert into ai_external_analysis_jobs(article_id,job_type,origin,status)
      values($1,'competitor_discovery','auto','queued')`, [articleId]);

    let readiness = (await db.query<any>(
      'select evaluate_content_writing_automation_readiness($1) value', [articleId],
    )).rows[0].value;
    assert.equal(readiness.ready, false);
    assert.ok(readiness.missingFields.includes('competitor_discovery_processing'));

    await db.query(`update ai_external_analysis_jobs set status='completed'
      where article_id=$1 and job_type='competitor_discovery'`, [articleId]);
    readiness = (await db.query<any>(
      'select evaluate_content_writing_automation_readiness($1) value', [articleId],
    )).rows[0].value;
    assert.equal(readiness.ready, true);

    const gated = (await db.query<any>(`insert into ai_external_analysis_jobs(
      article_id,job_type,origin,status,command_id,readiness_signature
    ) values($1,'engineering_command','auto','queued','audit_a','sig-clean') returning status,progress`, [
      articleId,
    ])).rows[0];
    assert.equal(gated.status, 'waiting_for_prerequisites');
    assert.equal(gated.progress.blockedBy, 'duplicate_cleanup');
    await db.query(`delete from ai_external_analysis_jobs
      where article_id=$1 and job_type='engineering_command'`, [articleId]);

    const document = { type: 'doc', content: [{ type: 'paragraph' }] };
    await db.query(`update articles set plain_text='${'word '.repeat(120)}',content_json=$2 where id=$1`, [
      articleId, JSON.stringify(document),
    ]);
    await db.query(`insert into duplicate_cleanup_schedule(article_id,signature,quiet_since)
      values($1,'current',now())`, [articleId]);
    const sessionId = '30000000-0000-4000-8000-000000000001';
    await db.query(`insert into content_writing_sessions(id,article_id,created_by,context_snapshot)
      values($1,$2,$3,'{"triggerSource":"automatic_ready"}')`, [sessionId, articleId, userId]);
    await db.query(`update content_writing_sessions set applied_at=now() where id=$1`, [sessionId]);
    const cleanup = (await db.query<any>(`select * from ai_external_analysis_jobs
      where article_id=$1 and job_type='duplicate_cleanup' order by created_at desc limit 1`, [articleId])).rows[0];
    assert.equal(cleanup.status, 'queued');
    assert.equal(cleanup.progress.readinessPriority, 'post_write_finalize');
    assert.equal(cleanup.progress.articleQueueLocked, true);

    await db.query(`update ai_external_analysis_jobs set status='completed',
      progress=progress||jsonb_build_object('unified',jsonb_build_object('document',$2::jsonb)) where id=$1`, [
      cleanup.id, JSON.stringify(document),
    ]);
    const audits = await db.query<any>(`select command_id,status,depends_on_job_id,sequence_number
      from ai_external_analysis_jobs where article_id=$1 and job_type='engineering_command'
      and readiness_signature='sig-clean' and command_id in ('audit_a','audit_b') order by command_id`, [articleId]);
    assert.deepEqual(audits.rows.map(row => row.depends_on_job_id), [null, null]);
    assert.deepEqual(audits.rows.map(row => row.sequence_number), [0, 0]);
    assert.ok(audits.rows.every(row => row.status === 'queued'));

    await db.query(`update ai_external_analysis_jobs set status='completed'
      where article_id=$1 and job_type='engineering_command' and command_id in ('audit_a','audit_b')`, [articleId]);
    const work = (await db.query<any>(
      'select article_automation_work_readiness($1) value', [articleId],
    )).rows[0].value;
    assert.equal(work.state, 'ready');
    assert.equal(work.ready, true);
    assert.equal(work.cleanupCurrent, true);
    assert.equal(work.completedAuditCount, 2);
  } finally {
    await db.close();
  }
});
