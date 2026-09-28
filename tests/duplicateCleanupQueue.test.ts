import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('cleanup queue migration enforces permissions, idempotency and active category uniqueness', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create function public.article_access_level_for_user(uuid, uuid) returns text language sql as 'select case when $2 = ''00000000-0000-4000-8000-000000000002''::uuid then ''write'' else ''none'' end';
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(), article_id uuid, requested_by uuid, job_type text,
        origin text, status text, idempotency_key text, input_snapshot jsonb, command_label text, command_id text,
        created_at timestamptz default clock_timestamp(),
        constraint ai_external_analysis_jobs_job_type_check check (job_type = 'engineering_command'),
        constraint ai_external_analysis_jobs_command_shape_check check (command_id is not null)
      );`);
    await db.exec(await readFile(new URL('../supabase/migrations/20260928000000_external_duplicate_cleanup.sql', import.meta.url), 'utf8'));
    const article = '00000000-0000-4000-8000-000000000001';
    const owner = '00000000-0000-4000-8000-000000000002';
    const enqueue = async (request: string, category = 4, user = owner) => (await db.query<any>(
      'select * from enqueue_duplicate_cleanup($1,$2,$3,$4)', [article, user, request, { version: 1, category }])).rows[0];
    const first = await enqueue('one');
    assert.equal((await enqueue('one')).id, first.id);
    assert.equal((await enqueue('two')).id, first.id);
    assert.notEqual((await enqueue('three', 5)).id, first.id);
    await db.query('update ai_external_analysis_jobs set status = $1 where id = $2', ['completed', first.id]);
    assert.notEqual((await enqueue('new')).id, first.id);
    await assert.rejects(enqueue('bad', 9), /invalid cleanup/i);
    await assert.rejects(enqueue('bad-user', 4, article), /write access/i);
    const privileges = (await db.query<any>(`select has_function_privilege('authenticated','enqueue_duplicate_cleanup(uuid,uuid,text,jsonb)','execute') as browser,
      has_function_privilege('service_role','enqueue_duplicate_cleanup(uuid,uuid,text,jsonb)','execute') as worker`)).rows[0];
    assert.equal(privileges.browser, false); assert.equal(privileges.worker, true);
  } finally { await db.close(); }
});
