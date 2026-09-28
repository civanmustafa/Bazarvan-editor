import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const owner = '00000000-0000-4000-8000-000000000002';
const source = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] };
const result = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] };

test('idle draft scheduling is server-only, length-independent and editor-safe', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create function public.article_access_level_for_user(uuid, uuid) returns text language sql as
        'select case when $2 = ''${owner}''::uuid then ''write'' else ''none'' end';
      create function public.article_automation_policy(uuid) returns jsonb language sql as
        'select ''{"policyVersion":1,"enabled":true}''::jsonb';
      create table public.articles (
        id uuid primary key default gen_random_uuid(), title text default 'Test',
        created_by uuid default '${owner}', owner_id uuid default '${owner}', automation_creator_id uuid default '${owner}',
        status text default 'draft', content_json jsonb, content_html text, plain_text text,
        keywords jsonb default '{"primary":"","company":"","secondaries":[],"lsi":[]}',
        article_language text default 'en', goal_context jsonb default '{}', analysis jsonb, stats jsonb default '{}',
        save_count integer default 0, metadata jsonb default '{}', last_saved_at timestamptz default now()
      );
      create table public.article_versions (
        article_id uuid, version_number integer, created_by uuid, title text, content_json jsonb, content_html text,
        plain_text text, keywords jsonb, goal_context jsonb, analysis jsonb, stats jsonb, note text,
        unique(article_id, version_number)
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(), article_id uuid references articles(id), requested_by uuid, job_type text,
        origin text, status text, idempotency_key text unique, input_snapshot jsonb, command_label text, command_id text,
        created_at timestamptz default clock_timestamp(), updated_at timestamptz default clock_timestamp(),
        progress jsonb default '{}', result jsonb, next_attempt_at timestamptz default now(),
        locked_by text, lease_generation bigint default 0, lease_expires_at timestamptz, cancel_requested_at timestamptz,
        completed_at timestamptz, last_error_code text, last_error text,
        constraint ai_external_analysis_jobs_job_type_check check (job_type = 'engineering_command'),
        constraint ai_external_analysis_jobs_command_shape_check check (command_id is not null)
      );
      create table public.article_editor_presence (presence_id uuid primary key default gen_random_uuid(),
        article_id uuid references articles(id), last_seen_at timestamptz default now());
      create table public.content_writing_sessions (article_id uuid references articles(id), status text);
    `);
    for (const migration of ['20260928000000_external_duplicate_cleanup.sql',
      '20260929000000_unified_duplicate_cleanup.sql', '20261001000000_idle_draft_duplicate_cleanup.sql']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
    }
    const one = async (sql: string, params: any[] = []) => (await db.query<any>(sql, params)).rows[0];
    const article = await one('insert into articles(content_json,plain_text) values($1,$2) returning *', [source, 'Hi']);
    assert.equal(await one("select count(*)::integer n from ai_external_analysis_jobs where job_type='duplicate_cleanup'").then(row => row.n), 0);
    assert.equal((await one('select dispatch_due_unified_duplicate_cleanup() n')).n, 0);
    await db.query("update duplicate_cleanup_schedule set quiet_since=now()-interval '16 minutes' where article_id=$1", [article.id]);
    await db.query("update articles set title='Updated test' where id=$1", [article.id]);
    assert.equal((await one('select dispatch_due_unified_duplicate_cleanup() n')).n, 0);
    await db.query("update duplicate_cleanup_schedule set quiet_since=now()-interval '16 minutes' where article_id=$1", [article.id]);
    await db.query('insert into article_editor_presence(article_id) values($1)', [article.id]);
    assert.equal((await one('select dispatch_due_unified_duplicate_cleanup() n')).n, 0);
    await db.query('delete from article_editor_presence where article_id=$1', [article.id]);
    await db.query("insert into content_writing_sessions(article_id,status) values($1,'running')", [article.id]);
    assert.equal((await one('select dispatch_due_unified_duplicate_cleanup() n')).n, 0);
    await db.query('delete from content_writing_sessions where article_id=$1', [article.id]);
    assert.equal((await one('select dispatch_due_unified_duplicate_cleanup() n')).n, 1);
    const auto = await one("select * from ai_external_analysis_jobs where article_id=$1 and job_type='duplicate_cleanup'", [article.id]);
    assert.equal(auto.origin, 'auto');
    assert.deepEqual(auto.input_snapshot.document, source);
    assert.equal((await one('select dispatch_due_unified_duplicate_cleanup() n')).n, 0);
    await db.query('insert into article_editor_presence(article_id) values($1)', [article.id]);
    await db.query("update ai_external_analysis_jobs set status='running',locked_by='worker',lease_generation=1,lease_expires_at=now()+interval '1 hour' where id=$1", [auto.id]);
    const state = { version: 2, document: result, appliedCount: 1, remaining: {}, phase: 'completed',
      rounds: [] as unknown[], steps: [] as unknown[] };
    const apply = () => one('select apply_unified_duplicate_cleanup($1,$2,$3,$4,$5,$6,$7)',
      [auto.id, 'worker', 1, source, state, '<p>Hello</p>', 'Hello']);
    await assert.rejects(apply(), /no longer ready/);
    await db.query('delete from article_editor_presence where article_id=$1', [article.id]);
    await apply();
    assert.deepEqual((await one('select content_json from articles where id=$1', [article.id])).content_json, result);
    await db.query("update ai_external_analysis_jobs set status='completed' where id=$1", [auto.id]);
    await one('select revert_unified_duplicate_cleanup($1,$2,$3,$4,$5,$6)',
      [auto.id, owner, 'all', source, '<p>Hi</p>', 'Hi']);
    assert.deepEqual((await one('select content_json from articles where id=$1', [article.id])).content_json, source);
    const manual = await one('insert into articles(content_json,plain_text) values($1,$2) returning *', [source, 'Hi']);
    await db.query('insert into article_editor_presence(article_id) values($1)', [manual.id]);
    const manualJob = await one('select * from enqueue_unified_duplicate_cleanup($1,$2,false,$3)',
      [manual.id, owner, 'manual-request']);
    assert.equal(manualJob.origin, 'manual');
    await db.query("update ai_external_analysis_jobs set status='running',locked_by='worker',lease_generation=1,lease_expires_at=now()+interval '1 hour' where id=$1", [manualJob.id]);
    await db.query("update articles set status='in_review' where id=$1", [manual.id]);
    await assert.rejects(one('select apply_unified_duplicate_cleanup($1,$2,$3,$4,$5,$6,$7)',
      [manualJob.id, 'worker', 1, source, state, '<p>Hello</p>', 'Hello']), /Article changed during cleanup/);
    assert.equal((await one('select * from enqueue_unified_duplicate_cleanup($1,$2,false,$3)',
      [manual.id, owner, 'second-request'])), undefined);
    assert.equal((await one('select * from duplicate_cleanup_schedule where article_id=$1', [manual.id])), undefined);

    const promoted = await one('insert into articles(content_json,plain_text) values($1,$2) returning *', [source, 'Hi']);
    await db.query("update duplicate_cleanup_schedule set quiet_since=now()-interval '16 minutes' where article_id=$1", [promoted.id]);
    await one('select dispatch_due_unified_duplicate_cleanup()');
    await db.query('insert into article_editor_presence(article_id) values($1)', [promoted.id]);
    const promotedJob = await one('select * from enqueue_unified_duplicate_cleanup($1,$2,false,$3)',
      [promoted.id, owner, 'start-while-open']);
    assert.equal(promotedJob.origin, 'manual');
    assert.equal(promotedJob.status, 'queued');

    const deferred = await one('insert into articles(content_json,plain_text) values($1,$2) returning *', [source, 'Hi']);
    await db.query("update duplicate_cleanup_schedule set quiet_since=now()-interval '16 minutes' where article_id=$1", [deferred.id]);
    await one('select dispatch_due_unified_duplicate_cleanup()');
    const deferredJob = await one("select id from ai_external_analysis_jobs where article_id=$1 and job_type='duplicate_cleanup'", [deferred.id]);
    await db.query("update ai_external_analysis_jobs set status='blocked',last_error_code='duplicate_cleanup_not_ready' where id=$1", [deferredJob.id]);
    const schedule = await one('select * from duplicate_cleanup_schedule where article_id=$1', [deferred.id]);
    assert.equal(schedule.dispatched_signature, null);
    assert.ok(Date.now() - Date.parse(schedule.quiet_since) < 60_000);
    assert.equal((await one('select dispatch_due_unified_duplicate_cleanup() n')).n, 0);
  } finally { await db.close(); }
});
