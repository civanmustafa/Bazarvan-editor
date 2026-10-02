import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const readMigration = () => readFile(
  new URL('../supabase/migrations/20261022000000_truthful_post_write_focus.sql', import.meta.url),
  'utf8',
);

test('post-write focus uses the live cleanup task and retires stale preparation', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.articles (
        id uuid primary key,
        title text not null default '',
        status text not null default 'draft',
        metadata jsonb not null default '{}',
        content_json jsonb,
        content_html text,
        plain_text text,
        updated_at timestamptz not null default now()
      );
      create table public.automatic_article_focus (
        singleton boolean primary key default true,
        article_id uuid,
        state text not null default 'idle',
        current_stage text,
        acquired_at timestamptz,
        last_progress_at timestamptz,
        next_retry_at timestamptz,
        last_error_code text,
        last_error text,
        generation integer not null default 0,
        last_article_id uuid,
        last_release_reason text,
        released_at timestamptz,
        updated_at timestamptz not null default now()
      );
      create table public.automatic_article_focus_pauses (
        article_id uuid primary key
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(),
        article_id uuid not null,
        job_type text not null,
        origin text not null default 'auto',
        status text not null,
        pipeline_parent_job_id uuid,
        progress jsonb not null default '{}',
        attempt_count integer not null default 0,
        max_attempts integer not null default 6,
        provider_attempt_count integer not null default 0,
        provider_attempt_limit integer not null default 6,
        recovery_cycle_count integer not null default 0,
        recovery_cycle_limit integer not null default 3,
        next_attempt_at timestamptz,
        cancel_requested_at timestamptz,
        completed_at timestamptz,
        locked_by text,
        locked_at timestamptz,
        lease_expires_at timestamptz,
        last_error_code text,
        last_error text,
        updated_at timestamptz not null default now()
      );
      create table public.content_writing_automation_items (
        id uuid primary key default gen_random_uuid(),
        article_id uuid not null,
        status text not null,
        attempt_count integer not null default 0,
        max_attempts integer not null default 6,
        recovery_count integer not null default 0,
        updated_at timestamptz not null default now()
      );
      create table public.content_writing_sessions (
        id uuid primary key default gen_random_uuid(),
        article_id uuid not null,
        execution_mode text not null default 'api',
        status text not null,
        context_snapshot jsonb not null default '{}',
        cancel_requested_at timestamptz,
        applied_at timestamptz,
        quality_score numeric,
        quality_report jsonb,
        quality_override_at timestamptz,
        updated_at timestamptz not null default now()
      );
      create function public.article_automation_work_readiness(p_article_id uuid)
      returns jsonb language sql stable as $$
        select jsonb_build_object(
          'state', article.metadata->>'workState',
          'cleanupActive', true,
          'cleanupFailed', false,
          'requiredAuditCount', 3,
          'completedAuditCount', 0,
          'activeAuditCount', 0,
          'failedAuditCount', 0
        ) from public.articles as article where article.id = p_article_id
      $$;
      create function public.automatic_article_focus_stage_for_job_type(p_job_type text)
      returns text language sql immutable as $$
        select case p_job_type
          when 'content_writing_preparation' then 'competitor_preparation'
          when 'duplicate_cleanup' then 'duplicate_cleanup'
          else p_job_type end
      $$;
      create function public.automatic_article_focus_controls_job_type(text)
      returns boolean language sql immutable as $$ select true $$;
      create function public.external_analysis_uses_gemini_budget(text)
      returns boolean language sql immutable as $$ select true $$;
      create function public.automatic_content_writing_requirement(p_article_id uuid)
      returns jsonb language sql stable as $$
        select jsonb_build_object('required', coalesce(length(article.plain_text), 0) = 0)
        from public.articles as article where article.id = p_article_id
      $$;
      create function public.refresh_automatic_article_focus(
        uuid,
        text default null,
        text default null,
        text default null,
        text default null,
        timestamptz default null
      )
      returns jsonb language sql as $$ select '{}'::jsonb $$;

      insert into public.articles(id,title,plain_text,metadata)
      values(
        '10000000-0000-4000-8000-000000000001',
        'Post-write article',
        'saved content',
        '{"workState":"cleaning"}'
      );
      insert into public.automatic_article_focus(
        singleton,article_id,state,current_stage,acquired_at,last_progress_at
      ) values(
        true,
        '10000000-0000-4000-8000-000000000001',
        'active',
        'competitor_discovery',
        now(),
        now()
      );
      insert into public.ai_external_analysis_jobs(article_id,job_type,status,attempt_count)
      values
        ('10000000-0000-4000-8000-000000000001','content_writing_preparation','blocked',5),
        ('10000000-0000-4000-8000-000000000001','duplicate_cleanup','running',1);
      insert into public.content_writing_sessions(
        article_id,status,applied_at,quality_score,quality_report,quality_override_at
      ) values(
        '10000000-0000-4000-8000-000000000001',
        'completed',
        now(),
        78,
        '{"minimumScore":80,"passed":false}',
        now()
      );
    `);

    await db.exec(await readMigration());

    const stale = (await db.query<{ status: string; last_error_code: string }>(`
      select status,last_error_code from public.ai_external_analysis_jobs
      where job_type = 'content_writing_preparation'
    `)).rows[0];
    assert.equal(stale.status, 'cancelled');
    assert.equal(stale.last_error_code, 'automatic_writing_not_required');

    const focus = (await db.query<any>('select public.get_automatic_article_focus() value')).rows[0].value;
    assert.equal(focus.currentStage, 'duplicate_cleanup');
    assert.equal(focus.cleanupActive, true);
    assert.equal(focus.requiredAuditCount, 3);
    assert.equal(focus.completedAuditCount, 0);
    assert.equal(focus.qualityScore, 78);
    assert.equal(focus.qualityMinimumScore, 80);
    assert.equal(focus.qualityPassed, false);
    assert.equal(focus.qualityOverridden, true);
  } finally {
    await db.close();
  }
});
