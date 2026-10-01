import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migrationUrls = [
  '../supabase/migrations/20261014000000_finalize_unneeded_automatic_writing.sql',
  '../supabase/migrations/20261014010000_clear_satisfied_writing_focus_pauses.sql',
].map(path => new URL(path, import.meta.url));

test('database finalizes automatic writing when an article has content or leaves draft scope', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.articles (
        id uuid primary key,
        status text not null default 'draft',
        content_json jsonb not null default '{}'::jsonb,
        content_html text not null default '',
        plain_text text not null default ''
      );
      create table public.content_writing_sessions (
        id uuid primary key default gen_random_uuid(), article_id uuid not null,
        status text not null, execution_mode text not null default 'api',
        context_snapshot jsonb not null default '{}'::jsonb,
        cancel_requested_at timestamptz, completed_at timestamptz,
        locked_by text, locked_at timestamptz, lease_expires_at timestamptz,
        started_at timestamptz, created_at timestamptz default now(),
        last_error_code text, last_error text, updated_at timestamptz default now()
      );
      create table public.content_writing_automation_items (
        id uuid primary key default gen_random_uuid(), article_id uuid not null,
        requested_by uuid, status text not null, attempt_count integer default 0,
        locked_by text, locked_at timestamptz, lease_expires_at timestamptz,
        next_recovery_at timestamptz, failure_class text, completed_at timestamptz,
        last_error_code text, last_error text, started_at timestamptz,
        ready_at timestamptz default now(), updated_at timestamptz default now()
      );
      create table public.ai_external_analysis_jobs (
        id uuid primary key default gen_random_uuid(), article_id uuid not null,
        job_type text not null, origin text not null default 'auto',
        pipeline_parent_job_id uuid, status text not null,
        cancel_requested_at timestamptz, completed_at timestamptz,
        locked_by text, locked_at timestamptz, lease_expires_at timestamptz,
        last_error_code text, last_error text, next_attempt_at timestamptz,
        progress jsonb default '{}'::jsonb, started_at timestamptz,
        created_at timestamptz default now(), updated_at timestamptz default now()
      );
      create table public.automatic_article_focus_pauses (
        article_id uuid primary key, reason text, error_code text, error_message text
      );
      create table public.automatic_article_focus (
        singleton boolean primary key default true, article_id uuid,
        state text default 'idle', current_stage text, last_article_id uuid,
        last_release_reason text, released_at timestamptz, next_retry_at timestamptz,
        last_error_code text, last_error text, last_progress_at timestamptz,
        generation integer default 1, updated_at timestamptz default now()
      );
      insert into public.automatic_article_focus(singleton) values (true);

      create function public.article_body_has_content(jsonb, text, text)
      returns boolean language sql immutable as $$
        select nullif(btrim(coalesce($3, '')), '') is not null
          or nullif(regexp_replace(coalesce($2, ''), '<[^>]*>', '', 'g'), '') is not null
          or coalesce(jsonb_array_length(coalesce($1->'content', '[]'::jsonb)), 0) > 0
      $$;
      create function public.automatic_article_focus_controls_job_type(text)
      returns boolean language sql immutable as $$ select true $$;
      create function public.automatic_article_focus_stage_for_job_type(text)
      returns text language sql immutable as $$ select 'preparation' $$;
      create function public.refresh_automatic_article_focus(uuid)
      returns jsonb language sql as $$ select '{}'::jsonb $$;
      create function public.try_acquire_automatic_article_focus(uuid, text)
      returns boolean language sql as $$ select true $$;
      create function public.get_automatic_article_focus()
      returns jsonb language sql as $$ select '{}'::jsonb $$;
    `);

    for (const migrationUrl of migrationUrls) {
      await db.exec(await readFile(migrationUrl, 'utf8'));
    }

    const draftId = '00000000-0000-4000-8000-000000000101';
    await db.exec(`
      insert into public.articles(id) values ('${draftId}');
      insert into public.content_writing_automation_items(article_id, status, attempt_count)
      values ('${draftId}', 'ready', 2);
      insert into public.automatic_article_focus_pauses(article_id, reason, error_code, error_message)
      values (
        '${draftId}', 'terminal_stage_failure', 'automatic_writing_not_required',
        'The article editor already contains content; automatic writing is no longer required.'
      );
      update public.automatic_article_focus
      set state = 'needs_attention', current_stage = 'duplicate_cleanup',
          last_article_id = '${draftId}', last_error_code = 'automatic_writing_not_required',
          last_error = 'The article editor already contains content; automatic writing is no longer required.';
      update public.articles set content_html = '<p>Saved prose</p>' where id = '${draftId}';
    `);
    const draftItem = await db.query<{ status: string; attempt_count: number; last_error_code: string }>(`
      select status, attempt_count, last_error_code
      from public.content_writing_automation_items where article_id = '${draftId}'
    `);
    assert.deepEqual(draftItem.rows[0], {
      status: 'cancelled',
      attempt_count: 0,
      last_error_code: 'automatic_writing_not_required',
    });
    const focus = await db.query<{ state: string; last_error_code: string | null }>(`
      select state, last_error_code from public.automatic_article_focus where singleton is true
    `);
    assert.deepEqual(focus.rows[0], { state: 'idle', last_error_code: null });
    const pause = await db.query<{ count: number }>(`
      select count(*)::integer as count from public.automatic_article_focus_pauses
      where article_id = '${draftId}'
    `);
    assert.equal(pause.rows[0]?.count, 0);

    const reviewId = '00000000-0000-4000-8000-000000000102';
    await db.exec(`
      insert into public.articles(id, status) values ('${reviewId}', 'in_review');
      insert into public.content_writing_automation_items(article_id, status, attempt_count)
      values ('${reviewId}', 'blocked', 3);
    `);
    const reviewItem = await db.query<{ status: string; attempt_count: number; last_error_code: string }>(`
      select status, attempt_count, last_error_code
      from public.content_writing_automation_items where article_id = '${reviewId}'
    `);
    assert.deepEqual(reviewItem.rows[0], {
      status: 'cancelled',
      attempt_count: 0,
      last_error_code: 'article_left_automation_scope',
    });
  } finally {
    await db.close();
  }
});
