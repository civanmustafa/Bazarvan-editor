-- External analysis phase 1: durable job records, article readiness, and RLS.
-- This migration does not run AI work. A later worker will claim queued jobs.

create table if not exists public.ai_external_analysis_article_state (
  article_id uuid primary key references public.articles(id) on delete cascade,
  semantic_ready boolean not null default false,
  external_analysis_ready boolean not null default false,
  semantic_missing_fields jsonb not null default '[]'::jsonb
    check (jsonb_typeof(semantic_missing_fields) = 'array'),
  external_analysis_missing_fields jsonb not null default '[]'::jsonb
    check (jsonb_typeof(external_analysis_missing_fields) = 'array'),
  semantic_readiness_signature text not null default '',
  external_analysis_readiness_signature text not null default '',
  semantic_last_enqueued_signature text,
  external_analysis_last_enqueued_signature text,
  last_article_updated_at timestamptz,
  last_evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_external_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  requested_by uuid references public.profiles(id) on delete set null,
  job_type text not null check (job_type in ('semantic_keywords_lsi', 'engineering_command')),
  origin text not null check (origin in ('auto', 'manual')),
  status text not null default 'waiting_for_prerequisites' check (
    status in (
      'waiting_for_prerequisites',
      'queued',
      'running',
      'retry_scheduled',
      'completed',
      'failed',
      'blocked',
      'cancelled',
      'paused'
    )
  ),
  idempotency_key text not null check (nullif(btrim(idempotency_key), '') is not null),
  batch_key text,
  sequence_number integer not null default 0 check (sequence_number >= 0),
  command_id text,
  command_label text,
  depends_on_job_id uuid references public.ai_external_analysis_jobs(id) on delete set null,
  readiness_signature text,
  input_snapshot jsonb not null default '{}'::jsonb,
  result jsonb,
  progress jsonb not null default '{}'::jsonb,
  last_error text,
  last_error_code text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  retry_count integer not null default 0 check (retry_count >= 0),
  next_attempt_at timestamptz,
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (job_type = 'semantic_keywords_lsi' and command_id is null)
    or (job_type = 'engineering_command' and nullif(btrim(command_id), '') is not null)
  )
);

create table if not exists public.ai_external_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_external_analysis_jobs(id) on delete cascade,
  run_number integer not null check (run_number > 0),
  status text not null check (status in ('running', 'completed', 'retry_scheduled', 'failed', 'blocked', 'cancelled')),
  provider text,
  model text,
  progress jsonb not null default '{}'::jsonb,
  key_attempts jsonb not null default '[]'::jsonb check (jsonb_typeof(key_attempts) = 'array'),
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (job_id, run_number)
);

create index if not exists ai_external_analysis_article_state_ready_idx
  on public.ai_external_analysis_article_state(semantic_ready, external_analysis_ready);
create index if not exists ai_external_analysis_jobs_article_idx
  on public.ai_external_analysis_jobs(article_id, created_at desc);
create index if not exists ai_external_analysis_jobs_due_idx
  on public.ai_external_analysis_jobs(status, next_attempt_at, created_at)
  where status in ('queued', 'retry_scheduled');
create index if not exists ai_external_analysis_jobs_batch_idx
  on public.ai_external_analysis_jobs(article_id, batch_key, sequence_number)
  where batch_key is not null;
create unique index if not exists ai_external_analysis_jobs_active_idempotency_idx
  on public.ai_external_analysis_jobs(article_id, idempotency_key)
  where status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');
create index if not exists ai_external_analysis_runs_job_idx
  on public.ai_external_analysis_runs(job_id, run_number desc);

create or replace function public.external_analysis_has_competitor_value(
  p_values jsonb,
  p_max_items integer default 3
)
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(p_values) = 'array' then p_values
        else '[]'::jsonb
      end
    ) with ordinality as item(value, position)
    where item.position <= greatest(coalesce(p_max_items, 3), 1)
      and nullif(btrim(item.value), '') is not null
  );
$$;

create or replace function public.evaluate_external_analysis_readiness(
  p_status text,
  p_title text,
  p_plain_text text,
  p_keywords jsonb,
  p_goal_context jsonb,
  p_metadata jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_has_draft boolean := coalesce(p_status, '') = 'draft';
  v_has_title boolean := nullif(btrim(coalesce(p_title, '')), '') is not null
    and lower(btrim(coalesce(p_title, ''))) not in ('(untitled)', 'untitled');
  v_has_editor_text boolean := nullif(btrim(coalesce(p_plain_text, '')), '') is not null;
  v_has_primary_keyword boolean := nullif(btrim(coalesce(p_keywords->>'primary', '')), '') is not null;
  v_has_company boolean := nullif(btrim(coalesce(p_keywords->>'company', '')), '') is not null;
  v_has_goal_context boolean := nullif(btrim(coalesce(p_goal_context->>'pageType', '')), '') is not null
    and nullif(btrim(coalesce(p_goal_context->>'objective', '')), '') is not null;
  v_competitors jsonb := coalesce(p_metadata->'attachments'->'competitors', '{}'::jsonb);
  v_has_competitor boolean;
  v_semantic_missing jsonb := '[]'::jsonb;
  v_external_missing jsonb := '[]'::jsonb;
  v_semantic_signature text;
  v_external_signature text;
begin
  v_has_competitor := public.external_analysis_has_competitor_value(v_competitors->'texts', 3)
    or public.external_analysis_has_competitor_value(v_competitors->'urls', 3);

  if not v_has_draft then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('draft_status');
    v_external_missing := v_external_missing || jsonb_build_array('draft_status');
  end if;
  if not v_has_title then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('article_title');
    v_external_missing := v_external_missing || jsonb_build_array('article_title');
  end if;
  if not v_has_editor_text then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('editor_text');
  end if;
  if not v_has_primary_keyword then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('primary_keyword');
    v_external_missing := v_external_missing || jsonb_build_array('primary_keyword');
  end if;
  if not v_has_goal_context then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('goal_context');
    v_external_missing := v_external_missing || jsonb_build_array('goal_context');
  end if;
  if not v_has_company then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('company_name');
    v_external_missing := v_external_missing || jsonb_build_array('company_name');
  end if;
  if not v_has_competitor then
    v_external_missing := v_external_missing || jsonb_build_array('competitor_content_or_url');
  end if;

  v_semantic_signature := md5(jsonb_build_object(
    'status', coalesce(p_status, ''),
    'title', coalesce(p_title, ''),
    'plainText', coalesce(p_plain_text, ''),
    'primaryKeyword', coalesce(p_keywords->>'primary', ''),
    'companyName', coalesce(p_keywords->>'company', ''),
    'goalContext', coalesce(p_goal_context, '{}'::jsonb)
  )::text);
  v_external_signature := md5(jsonb_build_object(
    'status', coalesce(p_status, ''),
    'title', coalesce(p_title, ''),
    'primaryKeyword', coalesce(p_keywords->>'primary', ''),
    'companyName', coalesce(p_keywords->>'company', ''),
    'goalContext', coalesce(p_goal_context, '{}'::jsonb),
    'competitorUrls', coalesce(v_competitors->'urls', '[]'::jsonb),
    'competitorTexts', coalesce(v_competitors->'texts', '[]'::jsonb)
  )::text);

  return jsonb_build_object(
    'semantic', jsonb_build_object(
      'ready', jsonb_array_length(v_semantic_missing) = 0,
      'missingFields', v_semantic_missing,
      'signature', v_semantic_signature
    ),
    'externalAnalysis', jsonb_build_object(
      'ready', jsonb_array_length(v_external_missing) = 0,
      'missingFields', v_external_missing,
      'signature', v_external_signature
    )
  );
end;
$$;

create or replace function public.sync_external_analysis_article_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_readiness jsonb;
begin
  v_readiness := public.evaluate_external_analysis_readiness(
    new.status,
    new.title,
    new.plain_text,
    new.keywords,
    new.goal_context,
    new.metadata
  );

  insert into public.ai_external_analysis_article_state (
    article_id,
    semantic_ready,
    external_analysis_ready,
    semantic_missing_fields,
    external_analysis_missing_fields,
    semantic_readiness_signature,
    external_analysis_readiness_signature,
    last_article_updated_at,
    last_evaluated_at
  )
  values (
    new.id,
    coalesce((v_readiness #>> '{semantic,ready}')::boolean, false),
    coalesce((v_readiness #>> '{externalAnalysis,ready}')::boolean, false),
    coalesce(v_readiness #> '{semantic,missingFields}', '[]'::jsonb),
    coalesce(v_readiness #> '{externalAnalysis,missingFields}', '[]'::jsonb),
    coalesce(v_readiness #>> '{semantic,signature}', ''),
    coalesce(v_readiness #>> '{externalAnalysis,signature}', ''),
    new.updated_at,
    now()
  )
  on conflict (article_id) do update
  set
    semantic_ready = excluded.semantic_ready,
    external_analysis_ready = excluded.external_analysis_ready,
    semantic_missing_fields = excluded.semantic_missing_fields,
    external_analysis_missing_fields = excluded.external_analysis_missing_fields,
    semantic_readiness_signature = excluded.semantic_readiness_signature,
    external_analysis_readiness_signature = excluded.external_analysis_readiness_signature,
    last_article_updated_at = excluded.last_article_updated_at,
    last_evaluated_at = excluded.last_evaluated_at,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists set_ai_external_analysis_article_state_updated_at on public.ai_external_analysis_article_state;
create trigger set_ai_external_analysis_article_state_updated_at
before update on public.ai_external_analysis_article_state
for each row execute function public.set_updated_at();

drop trigger if exists set_ai_external_analysis_jobs_updated_at on public.ai_external_analysis_jobs;
create trigger set_ai_external_analysis_jobs_updated_at
before update on public.ai_external_analysis_jobs
for each row execute function public.set_updated_at();

drop trigger if exists sync_external_analysis_article_state on public.articles;
create trigger sync_external_analysis_article_state
after insert or update of status, title, plain_text, keywords, goal_context, metadata on public.articles
for each row execute function public.sync_external_analysis_article_state();

insert into public.ai_external_analysis_article_state (
  article_id,
  semantic_ready,
  external_analysis_ready,
  semantic_missing_fields,
  external_analysis_missing_fields,
  semantic_readiness_signature,
  external_analysis_readiness_signature,
  last_article_updated_at,
  last_evaluated_at
)
select
  article.id,
  coalesce((readiness.value #>> '{semantic,ready}')::boolean, false),
  coalesce((readiness.value #>> '{externalAnalysis,ready}')::boolean, false),
  coalesce(readiness.value #> '{semantic,missingFields}', '[]'::jsonb),
  coalesce(readiness.value #> '{externalAnalysis,missingFields}', '[]'::jsonb),
  coalesce(readiness.value #>> '{semantic,signature}', ''),
  coalesce(readiness.value #>> '{externalAnalysis,signature}', ''),
  article.updated_at,
  now()
from public.articles as article
cross join lateral (
  select public.evaluate_external_analysis_readiness(
    article.status,
    article.title,
    article.plain_text,
    article.keywords,
    article.goal_context,
    article.metadata
  ) as value
) as readiness
on conflict (article_id) do update
set
  semantic_ready = excluded.semantic_ready,
  external_analysis_ready = excluded.external_analysis_ready,
  semantic_missing_fields = excluded.semantic_missing_fields,
  external_analysis_missing_fields = excluded.external_analysis_missing_fields,
  semantic_readiness_signature = excluded.semantic_readiness_signature,
  external_analysis_readiness_signature = excluded.external_analysis_readiness_signature,
  last_article_updated_at = excluded.last_article_updated_at,
  last_evaluated_at = excluded.last_evaluated_at,
  updated_at = now();

alter table public.ai_external_analysis_article_state enable row level security;
alter table public.ai_external_analysis_jobs enable row level security;
alter table public.ai_external_analysis_runs enable row level security;

drop policy if exists "ai_external_analysis_article_state_select_visible" on public.ai_external_analysis_article_state;
create policy "ai_external_analysis_article_state_select_visible"
on public.ai_external_analysis_article_state
for select
to authenticated
using (public.can_read_article(article_id));

drop policy if exists "ai_external_analysis_jobs_select_visible" on public.ai_external_analysis_jobs;
create policy "ai_external_analysis_jobs_select_visible"
on public.ai_external_analysis_jobs
for select
to authenticated
using (public.can_read_article(article_id));

create or replace function public.can_read_external_analysis_run(target_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.ai_external_analysis_jobs job
    where job.id = target_job_id
      and public.can_read_article(job.article_id)
  );
$$;

drop policy if exists "ai_external_analysis_runs_select_visible" on public.ai_external_analysis_runs;
create policy "ai_external_analysis_runs_select_visible"
on public.ai_external_analysis_runs
for select
to authenticated
using (public.can_read_external_analysis_run(job_id));

revoke all on public.ai_external_analysis_article_state from anon;
revoke all on public.ai_external_analysis_jobs from anon;
revoke all on public.ai_external_analysis_runs from anon;
revoke insert, update, delete on public.ai_external_analysis_article_state from authenticated;
revoke insert, update, delete on public.ai_external_analysis_jobs from authenticated;
revoke insert, update, delete on public.ai_external_analysis_runs from authenticated;
grant select on public.ai_external_analysis_article_state to authenticated;
grant select on public.ai_external_analysis_jobs to authenticated;
grant select on public.ai_external_analysis_runs to authenticated;
revoke all on function public.can_read_external_analysis_run(uuid) from public;
grant execute on function public.can_read_external_analysis_run(uuid) to authenticated;

comment on table public.ai_external_analysis_article_state is 'Readiness and idempotency state for automatic external analysis.';
comment on table public.ai_external_analysis_jobs is 'Durable external analysis tasks. Workers use the service role to claim and update them.';
comment on table public.ai_external_analysis_runs is 'Individual execution attempts for external analysis jobs.';
