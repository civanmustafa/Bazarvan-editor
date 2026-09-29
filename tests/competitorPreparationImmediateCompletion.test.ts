import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migrationPath = 'supabase/migrations/20261008000000_complete_satisfied_competitor_preparation.sql';
const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('competitor repository changes immediately retire stale automatic preparation', async () => {
  const migration = await readWorkspaceFile(migrationPath);
  assert.match(migration, /after insert or delete or update of article_id, status, content_text/);
  assert.match(migration, /completionReason', 'competitor_requirements_satisfied'/);
  assert.match(migration, /job\.origin = 'auto'/);
  assert.doesNotMatch(migration, /job\.status in \([^)]*'running'/);

  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.articles (id uuid primary key);
      create table public.article_competitors (
        id uuid primary key default gen_random_uuid(),
        article_id uuid not null references public.articles(id) on delete cascade,
        status text not null default 'queued',
        content_text text not null default ''
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(),
        article_id uuid not null references public.articles(id) on delete cascade,
        job_type text not null,
        origin text not null,
        status text not null,
        pipeline_parent_job_id uuid,
        readiness_signature text,
        result jsonb,
        progress jsonb not null default '{}',
        next_attempt_at timestamptz,
        locked_by text,
        locked_at timestamptz,
        lease_expires_at timestamptz,
        cancel_requested_at timestamptz,
        last_error_code text,
        last_error text,
        dead_lettered_at timestamptz,
        dead_letter_reason text,
        completed_at timestamptz,
        updated_at timestamptz not null default now()
      );
      create function public.evaluate_content_writing_automation_readiness(p_article_id uuid)
      returns jsonb language sql stable as $$
        select jsonb_build_object(
          'signature', md5(count(*)::text),
          'usableCompetitorCount', count(*) filter (
            where status = 'completed' and nullif(btrim(content_text), '') is not null
          ),
          'minimumCompetitorCount', 2
        )
        from public.article_competitors where article_id = p_article_id
      $$;
    `);
    await db.exec(await readWorkspaceFile(migrationPath));

    const articleId = '10000000-0000-4000-8000-000000000001';
    await db.query('insert into articles(id) values($1)', [articleId]);
    await db.query(`insert into ai_external_analysis_jobs(
      article_id,job_type,origin,status,next_attempt_at,last_error_code,last_error,progress
    ) values
      ($1,'content_writing_preparation','auto','retry_scheduled',now()+interval '7 minutes',
        'content_writing_competitor_texts_missing','Only one competitor','{"blockedBy":"old"}'),
      ($1,'content_writing_preparation','manual','retry_scheduled',now()+interval '7 minutes',
        'content_writing_competitor_texts_missing','Only one competitor','{}'),
      ($1,'content_writing_preparation','auto','running',null,null,null,'{}')`, [articleId]);

    await db.query(`insert into article_competitors(article_id,status,content_text)
      values($1,'completed','first usable text')`, [articleId]);
    let automatic = (await db.query<any>(`select status from ai_external_analysis_jobs
      where article_id=$1 and origin='auto' and status='retry_scheduled'`, [articleId])).rows[0];
    assert.equal(automatic.status, 'retry_scheduled');

    await db.query(`insert into article_competitors(article_id,status,content_text)
      values($1,'completed','second usable text')`, [articleId]);
    automatic = (await db.query<any>(`select status,next_attempt_at,last_error_code,last_error,
      result,progress,completed_at from ai_external_analysis_jobs
      where article_id=$1 and origin='auto' and status <> 'running'`, [articleId])).rows[0];
    assert.equal(automatic.status, 'completed');
    assert.equal(automatic.next_attempt_at, null);
    assert.equal(automatic.last_error_code, null);
    assert.equal(automatic.last_error, null);
    assert.ok(automatic.completed_at);
    assert.equal(automatic.result.completionReason, 'competitor_requirements_satisfied');
    assert.equal(automatic.result.usableCompetitorCount, 2);
    assert.equal(automatic.progress.stage, 'competitors_ready');
    assert.equal(automatic.progress.blockedBy, undefined);

    const untouched = (await db.query<any>(`select origin,status from ai_external_analysis_jobs
      where article_id=$1 and status <> 'completed' order by origin`, [articleId])).rows;
    assert.deepEqual(untouched, [
      { origin: 'auto', status: 'running' },
      { origin: 'manual', status: 'retry_scheduled' },
    ]);
    const version = (await db.query<any>('select content_writing_automation_schema_version() value'))
      .rows[0].value;
    assert.equal(version, 7);
  } finally {
    await db.close();
  }
});
