import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const owner = '00000000-0000-4000-8000-000000000002';
const outsider = '00000000-0000-4000-8000-000000000003';
const document = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const before = document('In general this article contains useful technical information.');
const after = document('This article contains useful technical information.');
const text = 'This article contains useful technical information.';

test('unified cleanup database transactions, permissions, automation and undo', async t => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create function public.article_access_level_for_user(uuid, uuid) returns text language sql as
        'select case when $2 = ''${owner}''::uuid then ''write'' else ''none'' end';
      create table test_policy(enabled boolean); insert into test_policy values (true);
      create function public.article_automation_policy(uuid) returns jsonb language sql as
        'select jsonb_build_object(''policyVersion'', 1, ''enabled'', enabled) from test_policy';
      create table public.articles (
        id uuid primary key default gen_random_uuid(), title text default 'Test article',
        created_by uuid default '${owner}', owner_id uuid default '${owner}', automation_creator_id uuid default '${owner}',
        deleted_at timestamptz, status text default 'draft', content_json jsonb, content_html text, plain_text text,
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
        locked_by text, lease_generation bigint default 0, lease_expires_at timestamptz, cancel_requested_at timestamptz, last_error_code text,
        constraint ai_external_analysis_jobs_job_type_check check (job_type = 'engineering_command'),
        constraint ai_external_analysis_jobs_command_shape_check check (command_id is not null)
      );`);
    await db.exec(await readFile(new URL('../supabase/migrations/20260928000000_external_duplicate_cleanup.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20260929000000_unified_duplicate_cleanup.sql', import.meta.url), 'utf8'));
    const one = async (sql: string, params: any[] = []) => (await db.query<any>(sql, params)).rows[0];
    const create = async () => {
      const article = await one('insert into articles(content_json,plain_text) values($1,$2) returning *', [before, 'In general this article contains useful technical information.']);
      const job = await one('select * from ai_external_analysis_jobs where article_id=$1', [article.id]);
      return { article, job };
    };
    const start = (id: string) => db.query(`update ai_external_analysis_jobs set status='running', locked_by='worker', lease_generation=1,
      lease_expires_at=now()+interval '1 hour' where id=$1`, [id]);
    const state = { version: 2, document: after, appliedCount: 1, remaining: { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 },
      phase: 'completed', round: 0, rounds: [{ document: before, appliedCount: 0, excess: 4 }], steps: [{ round: 0 }], errors: [] as string[] };
    const apply = (id: string, generation = 1, source = before) => one('select apply_unified_duplicate_cleanup($1,$2,$3,$4,$5,$6,$7)',
      [id, 'worker', generation, source, state, `<p>${text}</p>`, text]);

    await t.test('auto enqueue uses saved input, debounces, serializes manual categories, and respects creator policy', async () => {
      const { article, job } = await create();
      assert.equal(job.input_snapshot.version, 2); assert.equal(job.origin, 'auto');
      assert.deepEqual(job.input_snapshot.document, before);
      assert.ok(Date.parse(job.next_attempt_at) > Date.parse(job.created_at) + 28000);
      assert.equal((await one('select * from enqueue_unified_duplicate_cleanup($1,$2,true)', [article.id, owner])).id, job.id);
      assert.equal((await one('select * from enqueue_duplicate_cleanup($1,$2,$3,$4)', [article.id, owner, 'legacy', { version: 1, category: 4 }])).id, job.id);
      await assert.rejects(one('select * from enqueue_unified_duplicate_cleanup($1,$2,true)', [article.id, outsider]), /write access/);
      await db.exec('update test_policy set enabled=false');
      const disabled = await create(); assert.equal(disabled.job, undefined);
      await db.exec('update test_policy set enabled=true');
      const permissions = await one(`select
        has_function_privilege('authenticated','apply_unified_duplicate_cleanup(uuid,text,bigint,jsonb,jsonb,text,text)','execute') browser,
        has_function_privilege('service_role','apply_unified_duplicate_cleanup(uuid,text,bigint,jsonb,jsonb,text,text)','execute') worker,
        has_function_privilege('anon','enqueue_unified_duplicate_cleanup(uuid,uuid,boolean,text)','execute') anonymous`);
      assert.equal(permissions.browser, false); assert.equal(permissions.worker, true); assert.equal(permissions.anonymous, false);
    });
    await t.test('atomic apply backs up both versions, fences retries, and does not enqueue itself', async () => {
      const { article, job } = await create(); await start(job.id);
      await apply(job.id);
      const saved = await one('select * from articles where id=$1', [article.id]);
      assert.deepEqual(saved.content_json, after); assert.equal(saved.plain_text, text); assert.equal(saved.save_count, 2);
      assert.deepEqual((await one('select progress from ai_external_analysis_jobs where id=$1', [job.id])).progress.unified, state);
      assert.equal((await one('select count(*)::integer n from article_versions where article_id=$1', [article.id])).n, 2);
      assert.equal((await one('select count(*)::integer n from ai_external_analysis_jobs where article_id=$1', [article.id])).n, 1);
      await assert.rejects(apply(job.id), /Article changed/);
      await db.query("update ai_external_analysis_jobs set status='completed' where id=$1", [job.id]);
      assert.equal((await one('select * from enqueue_unified_duplicate_cleanup($1,$2,true)', [article.id, owner])).id, job.id);
      await one('select revert_unified_duplicate_cleanup($1,$2,$3,$4,$5,$6)', [job.id, owner, 'all', before, '<p>Before</p>', 'Original article before cleanup.']);
      assert.deepEqual((await one('select content_json from articles where id=$1', [article.id])).content_json, before);
      const reverted = (await one('select progress from ai_external_analysis_jobs where id=$1', [job.id])).progress.unified;
      assert.equal(reverted.phase, 'reverted'); assert.equal(reverted.appliedCount, 0); assert.deepEqual(reverted.steps, []);
      assert.equal((await one('select * from enqueue_unified_duplicate_cleanup($1,$2,true)', [article.id, owner])).id, job.id);
    });
    await t.test('stale lease, cancellation, disabled policy and changed article never apply', async () => {
      const { article, job } = await create(); await start(job.id);
      await assert.rejects(apply(job.id, 0), /fenced/);
      await db.query('update ai_external_analysis_jobs set cancel_requested_at=now() where id=$1', [job.id]);
      await assert.rejects(apply(job.id), /cancelled/);
      await db.query('update ai_external_analysis_jobs set cancel_requested_at=null where id=$1', [job.id]);
      await db.exec('update test_policy set enabled=false');
      await assert.rejects(apply(job.id), /disabled/);
      await db.exec('update test_policy set enabled=true');
      const fresh = document('The author changed the article before any cleanup applied.');
      await db.query('update articles set content_json=$2 where id=$1', [article.id, fresh]);
      await assert.rejects(apply(job.id), /Article changed/);
      assert.deepEqual((await one('select content_json from articles where id=$1', [article.id])).content_json, fresh);
      await db.query("update ai_external_analysis_jobs set status='blocked',last_error_code='duplicate_cleanup_article_changed' where id=$1", [job.id]);
      const next = await one("select * from ai_external_analysis_jobs where article_id=$1 and status='queued'", [article.id]);
      assert.ok(next); assert.notEqual(next.id, job.id); assert.deepEqual(next.input_snapshot.document, fresh);
    });
    await t.test('undo last round preserves earlier results and refuses author changes', async () => {
      const { article, job } = await create(); await start(job.id); await apply(job.id);
      const final = document('The article contains useful technical information.');
      const twoRounds = { ...state, document: final, appliedCount: 2, round: 1,
        rounds: [...state.rounds, { document: after, appliedCount: 1, excess: 1 }], steps: [{ round: 0 }, { round: 1 }] };
      await one('select apply_unified_duplicate_cleanup($1,$2,$3,$4,$5,$6,$7)', [job.id, 'worker', 1, after, twoRounds, '<p>Final</p>', 'Final article with useful information.']);
      await assert.rejects(one('select revert_unified_duplicate_cleanup($1,$2,$3,$4,$5,$6)', [job.id, owner, 'round', after, '<p>After</p>', text]), /Stop cleanup/);
      await db.query("update ai_external_analysis_jobs set status='completed' where id=$1", [job.id]);
      await assert.rejects(one('select revert_unified_duplicate_cleanup($1,$2,$3,$4,$5,$6)', [job.id, outsider, 'round', after, '<p>After</p>', text]), /write access/);
      await one('select revert_unified_duplicate_cleanup($1,$2,$3,$4,$5,$6)', [job.id, owner, 'round', after, '<p>After</p>', text]);
      const remaining = (await one('select progress from ai_external_analysis_jobs where id=$1', [job.id])).progress.unified;
      assert.equal(remaining.appliedCount, 1); assert.equal(remaining.rounds.length, 1); assert.equal(remaining.steps.length, 1);
      await db.query('update articles set content_json=$2 where id=$1', [article.id, document('New writing should not be replaced by an old revision.')]);
      await assert.rejects(one('select revert_unified_duplicate_cleanup($1,$2,$3,$4,$5,$6)', [job.id, owner, 'all', before, '<p>Before</p>', text]), /Article changed/);
    });
    await t.test('terminal legacy jobs release automatic cleanup without blocking revoked users', async () => {
      await db.exec('update test_policy set enabled=false');
      const { article } = await create();
      await db.exec('update test_policy set enabled=true');
      const legacy = await one('select * from enqueue_duplicate_cleanup($1,$2,$3,$4)',
        [article.id, owner, 'legacy-only', { version: 1, category: 4, document: before }]);
      await db.query("update ai_external_analysis_jobs set status='completed' where id=$1", [legacy.id]);
      const unified = await one("select * from ai_external_analysis_jobs where article_id=$1 and input_snapshot->>'version'='2'", [article.id]);
      assert.ok(unified); assert.deepEqual(unified.input_snapshot.document, before);
      await db.query('update ai_external_analysis_jobs set requested_by=$2 where id=$1', [unified.id, outsider]);
      await db.query("update ai_external_analysis_jobs set status='blocked' where id=$1", [unified.id]);
      assert.equal((await one('select status from ai_external_analysis_jobs where id=$1', [unified.id])).status, 'blocked');
    });
  } finally { await db.close(); }
});
