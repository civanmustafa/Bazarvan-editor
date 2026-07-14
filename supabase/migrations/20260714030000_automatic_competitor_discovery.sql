begin;

alter table public.ai_external_analysis_article_state
  add column if not exists competitor_discovery_ready boolean not null default false,
  add column if not exists competitor_discovery_missing_fields jsonb not null default '[]'::jsonb,
  add column if not exists competitor_discovery_signature text not null default '',
  add column if not exists competitor_discovery_last_enqueued_signature text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ai_external_analysis_article_state'::regclass
      and conname = 'ai_external_analysis_article_state_competitor_missing_check'
  ) then
    alter table public.ai_external_analysis_article_state
      add constraint ai_external_analysis_article_state_competitor_missing_check
      check (jsonb_typeof(competitor_discovery_missing_fields) = 'array');
  end if;
end;
$$;

alter table public.article_competitors
  add column if not exists discovery_signature text not null default '';

create or replace function public.assign_competitor_discovery_signature()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(btrim(coalesce(new.discovery_signature, '')), '') is null then
    select state.competitor_discovery_signature
    into new.discovery_signature
    from public.ai_external_analysis_article_state as state
    where state.article_id = new.article_id;
    new.discovery_signature := coalesce(new.discovery_signature, '');
  end if;
  return new;
end;
$$;

drop trigger if exists assign_competitor_discovery_signature on public.article_competitors;
create trigger assign_competitor_discovery_signature
before insert on public.article_competitors
for each row execute function public.assign_competitor_discovery_signature();

create index if not exists article_competitors_discovery_signature_idx
  on public.article_competitors(article_id, discovery_signature, status, position);

alter table public.ai_external_analysis_jobs
  drop constraint if exists ai_external_analysis_jobs_job_type_check;
alter table public.ai_external_analysis_jobs
  drop constraint if exists ai_external_analysis_jobs_command_shape_check;

alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_job_type_check
  check (job_type in (
    'semantic_keywords_lsi',
    'engineering_command',
    'competitor_discovery',
    'competitor_extraction'
  ));

alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_command_shape_check
  check (
    (
      job_type in ('semantic_keywords_lsi', 'competitor_discovery', 'competitor_extraction')
      and command_id is null
    )
    or (
      job_type = 'engineering_command'
      and nullif(btrim(command_id), '') is not null
    )
  );

create unique index if not exists ai_external_analysis_jobs_competitor_discovery_once_idx
  on public.ai_external_analysis_jobs(article_id, job_type, readiness_signature)
  where job_type = 'competitor_discovery'
    and nullif(readiness_signature, '') is not null
    and last_error_code is distinct from 'duplicate_task_suppressed';

create or replace function public.evaluate_competitor_discovery_readiness(
  p_status text,
  p_title text,
  p_keywords jsonb,
  p_goal_context jsonb,
  p_article_language text
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_primary_keyword text := btrim(coalesce(p_keywords->>'primary', ''));
  v_company_name text := btrim(coalesce(p_keywords->>'company', ''));
  v_query_type text := case when v_primary_keyword <> '' then 'primary_keyword' else 'title' end;
  v_query_text text := case when v_primary_keyword <> '' then v_primary_keyword else v_title end;
  v_missing_fields jsonb := '[]'::jsonb;
  v_signature text;
begin
  if coalesce(p_status, '') <> 'draft' then
    v_missing_fields := v_missing_fields || jsonb_build_array('draft_status');
  end if;
  if v_query_text = '' or lower(v_query_text) in ('(untitled)', 'untitled') then
    v_missing_fields := v_missing_fields || jsonb_build_array('article_title_or_primary_keyword');
  end if;
  if v_company_name = '' then
    v_missing_fields := v_missing_fields || jsonb_build_array('company_name');
  end if;

  v_signature := md5(jsonb_build_object(
    'status', coalesce(p_status, ''),
    'queryType', v_query_type,
    'queryText', v_query_text,
    'articleTitle', v_title,
    'primaryKeyword', v_primary_keyword,
    'companyName', v_company_name,
    'articleLanguage', case when p_article_language = 'en' then 'en' else 'ar' end,
    'pageType', coalesce(p_goal_context->>'pageType', ''),
    'searchIntent', coalesce(p_goal_context->>'searchIntent', ''),
    'audienceScope', coalesce(p_goal_context->>'audienceScope', ''),
    'targetCountry', coalesce(p_goal_context->>'targetCountry', '')
  )::text);

  return jsonb_build_object(
    'ready', jsonb_array_length(v_missing_fields) = 0,
    'missingFields', v_missing_fields,
    'signature', v_signature,
    'queryType', v_query_type,
    'queryText', v_query_text
  );
end;
$$;

create or replace function public.sync_competitor_discovery_article_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_readiness jsonb;
begin
  v_readiness := public.evaluate_competitor_discovery_readiness(
    new.status,
    new.title,
    new.keywords,
    new.goal_context,
    new.article_language
  );

  insert into public.ai_external_analysis_article_state (
    article_id,
    competitor_discovery_ready,
    competitor_discovery_missing_fields,
    competitor_discovery_signature,
    last_article_updated_at,
    last_evaluated_at
  ) values (
    new.id,
    coalesce((v_readiness->>'ready')::boolean, false),
    coalesce(v_readiness->'missingFields', '[]'::jsonb),
    coalesce(v_readiness->>'signature', ''),
    new.updated_at,
    now()
  )
  on conflict (article_id) do update
  set
    competitor_discovery_ready = excluded.competitor_discovery_ready,
    competitor_discovery_missing_fields = excluded.competitor_discovery_missing_fields,
    competitor_discovery_signature = excluded.competitor_discovery_signature,
    last_article_updated_at = excluded.last_article_updated_at,
    last_evaluated_at = excluded.last_evaluated_at,
    updated_at = now();

  return new;
end;
$$;

insert into public.ai_external_analysis_article_state (
  article_id,
  competitor_discovery_ready,
  competitor_discovery_missing_fields,
  competitor_discovery_signature,
  last_article_updated_at,
  last_evaluated_at
)
select
  article.id,
  coalesce((readiness.value->>'ready')::boolean, false),
  coalesce(readiness.value->'missingFields', '[]'::jsonb),
  coalesce(readiness.value->>'signature', ''),
  article.updated_at,
  now()
from public.articles as article
cross join lateral (
  select public.evaluate_competitor_discovery_readiness(
    article.status,
    article.title,
    article.keywords,
    article.goal_context,
    article.article_language
  ) as value
) as readiness
on conflict (article_id) do update
set
  competitor_discovery_ready = excluded.competitor_discovery_ready,
  competitor_discovery_missing_fields = excluded.competitor_discovery_missing_fields,
  competitor_discovery_signature = excluded.competitor_discovery_signature,
  last_article_updated_at = excluded.last_article_updated_at,
  last_evaluated_at = excluded.last_evaluated_at,
  updated_at = now();

create or replace function public.cancel_stale_competitor_discovery_jobs(
  p_article_id uuid,
  p_current_signature text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  with affected as (
    update public.ai_external_analysis_jobs as job
    set
      status = case when job.status = 'running' then 'running' else 'cancelled' end,
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
      locked_by = case when job.status = 'running' then job.locked_by else null end,
      locked_at = case when job.status = 'running' then job.locked_at else null end,
      lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
      last_error_code = case
        when job.job_type = 'competitor_extraction' then 'competitor_extraction_input_changed'
        else 'competitor_discovery_input_changed'
      end,
      last_error = case
        when job.job_type = 'competitor_extraction'
          then 'Competitor inputs changed before extraction completed.'
        else 'Competitor discovery inputs changed before this task completed.'
      end,
      completed_at = case when job.status = 'running' then job.completed_at else coalesce(job.completed_at, now()) end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.status = 'running' then 'cancellation_requested' else 'cancelled' end,
        'reason', 'competitor_discovery_input_changed',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.article_id = p_article_id
      and job.job_type in ('competitor_discovery', 'competitor_extraction')
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      and (
        nullif(coalesce(p_current_signature, ''), '') is null
        or job.readiness_signature is distinct from p_current_signature
      )
    returning job.id
  )
  select count(*)::integer into v_count from affected;

  update public.article_competitors as competitor
  set
    status = 'cancelled',
    error_code = 'competitor_input_changed',
    error_message = 'Competitor search inputs changed before extraction completed.',
    updated_at = now()
  where competitor.article_id = p_article_id
    and competitor.status in ('queued', 'extracting', 'retry_scheduled')
    and (
      nullif(coalesce(p_current_signature, ''), '') is null
      or competitor.discovery_signature is distinct from p_current_signature
    );

  return coalesce(v_count, 0);
end;
$$;

create or replace function public.enqueue_competitor_discovery_job(
  p_article_id uuid,
  p_requested_by uuid default null,
  p_origin text default 'auto'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_article public.articles%rowtype;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_job_id uuid;
  v_job_status text;
  v_query_type text;
  v_query_text text;
  v_idempotency_key text;
begin
  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id;
  if v_article.id is null then return null; end if;

  select state.* into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;
  if v_state.article_id is null
    or not v_state.competitor_discovery_ready
    or nullif(v_state.competitor_discovery_signature, '') is null then
    perform public.cancel_stale_competitor_discovery_jobs(p_article_id, null);
    return null;
  end if;

  perform public.cancel_stale_competitor_discovery_jobs(
    p_article_id,
    v_state.competitor_discovery_signature
  );

  v_query_type := case
    when nullif(btrim(coalesce(v_article.keywords->>'primary', '')), '') is not null
      then 'primary_keyword'
    else 'title'
  end;
  v_query_text := case
    when v_query_type = 'primary_keyword' then btrim(v_article.keywords->>'primary')
    else btrim(v_article.title)
  end;
  v_idempotency_key := 'competitor-discovery:' || v_state.competitor_discovery_signature;

  perform pg_advisory_xact_lock(hashtextextended(
    v_article.id::text || ':' || v_idempotency_key,
    0
  ));

  select job.id, job.status
  into v_job_id, v_job_status
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.job_type = 'competitor_discovery'
    and job.readiness_signature = v_state.competitor_discovery_signature
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by
    case
      when job.status = 'completed' then 0
      when job.status in ('running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused') then 1
      else 2
    end,
    coalesce(job.completed_at, job.updated_at, job.created_at) desc
  limit 1
  for update;

  if v_job_id is not null and v_job_status in ('failed', 'blocked', 'cancelled') then
    update public.ai_external_analysis_jobs as job
    set
      requested_by = coalesce(
        p_requested_by,
        v_article.assigned_to,
        v_article.owner_id,
        v_article.created_by,
        job.requested_by
      ),
      origin = case when p_origin = 'manual' then 'manual' else 'auto' end,
      status = 'queued',
      idempotency_key = v_idempotency_key,
      input_snapshot = jsonb_build_object(
        'queryType', v_query_type,
        'queryText', v_query_text,
        'articleTitle', coalesce(v_article.title, ''),
        'primaryKeyword', coalesce(v_article.keywords->>'primary', ''),
        'companyName', coalesce(v_article.keywords->>'company', ''),
        'articleLanguage', case when v_article.article_language = 'en' then 'en' else 'ar' end,
        'pageType', coalesce(v_article.goal_context->>'pageType', ''),
        'searchIntent', coalesce(v_article.goal_context->>'searchIntent', ''),
        'audienceScope', coalesce(v_article.goal_context->>'audienceScope', ''),
        'targetCountry', coalesce(v_article.goal_context->>'targetCountry', ''),
        'readinessSignature', v_state.competitor_discovery_signature
      ),
      result = null,
      progress = jsonb_build_object('stage', 'queued', 'updatedAt', now()),
      last_error = null,
      last_error_code = null,
      next_attempt_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      cancel_requested_at = null,
      completed_at = null,
      updated_at = now()
    where job.id = v_job_id;
  end if;

  if v_job_id is null then
    insert into public.ai_external_analysis_jobs (
      article_id,
      requested_by,
      job_type,
      origin,
      status,
      idempotency_key,
      batch_key,
      sequence_number,
      readiness_signature,
      input_snapshot,
      progress,
      next_attempt_at
    ) values (
      v_article.id,
      coalesce(p_requested_by, v_article.assigned_to, v_article.owner_id, v_article.created_by),
      'competitor_discovery',
      case when p_origin = 'manual' then 'manual' else 'auto' end,
      'queued',
      v_idempotency_key,
      v_idempotency_key,
      0,
      v_state.competitor_discovery_signature,
      jsonb_build_object(
        'queryType', v_query_type,
        'queryText', v_query_text,
        'articleTitle', coalesce(v_article.title, ''),
        'primaryKeyword', coalesce(v_article.keywords->>'primary', ''),
        'companyName', coalesce(v_article.keywords->>'company', ''),
        'articleLanguage', case when v_article.article_language = 'en' then 'en' else 'ar' end,
        'pageType', coalesce(v_article.goal_context->>'pageType', ''),
        'searchIntent', coalesce(v_article.goal_context->>'searchIntent', ''),
        'audienceScope', coalesce(v_article.goal_context->>'audienceScope', ''),
        'targetCountry', coalesce(v_article.goal_context->>'targetCountry', ''),
        'readinessSignature', v_state.competitor_discovery_signature
      ),
      jsonb_build_object('stage', 'queued', 'updatedAt', now()),
      now()
    )
    on conflict do nothing
    returning id into v_job_id;
  end if;

  if v_job_id is null then
    select job.id into v_job_id
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_article.id
      and job.job_type = 'competitor_discovery'
      and job.readiness_signature = v_state.competitor_discovery_signature
      and job.last_error_code is distinct from 'duplicate_task_suppressed'
    order by job.created_at
    limit 1;
  end if;

  update public.ai_external_analysis_article_state as state
  set
    competitor_discovery_last_enqueued_signature = v_state.competitor_discovery_signature,
    updated_at = now()
  where state.article_id = v_article.id;

  return v_job_id;
end;
$$;

create or replace function public.save_competitor_discovery_result(
  p_article_id uuid,
  p_requested_by uuid,
  p_input_snapshot jsonb,
  p_result jsonb
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.ai_external_analysis_article_state%rowtype;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_idempotency_key text;
begin
  select state.* into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;
  if v_state.article_id is null
    or not v_state.competitor_discovery_ready
    or nullif(v_state.competitor_discovery_signature, '') is null then
    raise exception 'Competitor discovery prerequisites are incomplete.' using errcode = '22023';
  end if;

  v_idempotency_key := 'competitor-discovery:' || v_state.competitor_discovery_signature;
  perform pg_advisory_xact_lock(hashtextextended(
    p_article_id::text || ':' || v_idempotency_key,
    0
  ));

  select job.* into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'competitor_discovery'
    and job.readiness_signature = v_state.competitor_discovery_signature
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by job.created_at
  limit 1
  for update;

  if v_job.id is not null and v_job.status = 'running' then
    return v_job;
  end if;

  if v_job.id is null then
    insert into public.ai_external_analysis_jobs (
      article_id,
      requested_by,
      job_type,
      origin,
      status,
      idempotency_key,
      batch_key,
      sequence_number,
      readiness_signature,
      input_snapshot,
      result,
      progress,
      completed_at
    ) values (
      p_article_id,
      p_requested_by,
      'competitor_discovery',
      'manual',
      'completed',
      v_idempotency_key,
      v_idempotency_key,
      0,
      v_state.competitor_discovery_signature,
      coalesce(p_input_snapshot, '{}'::jsonb),
      coalesce(p_result, '{}'::jsonb) || jsonb_build_object('reviewStatus', 'awaiting_review'),
      jsonb_build_object('stage', 'awaiting_review', 'updatedAt', now()),
      now()
    )
    returning * into v_job;
  else
    update public.ai_external_analysis_jobs as job
    set
      requested_by = coalesce(p_requested_by, job.requested_by),
      origin = 'manual',
      status = 'completed',
      input_snapshot = coalesce(p_input_snapshot, '{}'::jsonb),
      result = coalesce(p_result, '{}'::jsonb) || jsonb_build_object('reviewStatus', 'awaiting_review'),
      progress = jsonb_build_object('stage', 'awaiting_review', 'updatedAt', now()),
      last_error = null,
      last_error_code = null,
      next_attempt_at = null,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      cancel_requested_at = null,
      completed_at = now(),
      updated_at = now()
    where job.id = v_job.id
    returning job.* into v_job;
  end if;

  update public.ai_external_analysis_article_state as state
  set
    competitor_discovery_last_enqueued_signature = v_state.competitor_discovery_signature,
    updated_at = now()
  where state.article_id = p_article_id;

  return v_job;
end;
$$;

create or replace function public.enqueue_competitor_discovery_from_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
    and new.competitor_discovery_ready is not distinct from old.competitor_discovery_ready
    and new.competitor_discovery_signature is not distinct from old.competitor_discovery_signature then
    return new;
  end if;

  if new.competitor_discovery_ready then
    perform public.enqueue_competitor_discovery_job(new.article_id, null, 'auto');
  else
    perform public.cancel_stale_competitor_discovery_jobs(new.article_id, null);
  end if;
  return new;
end;
$$;

drop trigger if exists sync_competitor_discovery_article_state on public.articles;
create trigger sync_competitor_discovery_article_state
after insert or update of status, title, keywords, goal_context, article_language
on public.articles
for each row execute function public.sync_competitor_discovery_article_state();

drop trigger if exists enqueue_competitor_discovery_from_state on public.ai_external_analysis_article_state;
create trigger enqueue_competitor_discovery_from_state
after insert or update of competitor_discovery_ready, competitor_discovery_signature
on public.ai_external_analysis_article_state
for each row execute function public.enqueue_competitor_discovery_from_state();

revoke all on function public.evaluate_competitor_discovery_readiness(text, text, jsonb, jsonb, text) from public;
revoke all on function public.assign_competitor_discovery_signature() from public;
revoke all on function public.sync_competitor_discovery_article_state() from public;
revoke all on function public.cancel_stale_competitor_discovery_jobs(uuid, text) from public;
revoke all on function public.enqueue_competitor_discovery_job(uuid, uuid, text) from public;
revoke all on function public.save_competitor_discovery_result(uuid, uuid, jsonb, jsonb) from public;
revoke all on function public.enqueue_competitor_discovery_from_state() from public;

grant execute on function public.enqueue_competitor_discovery_job(uuid, uuid, text) to service_role;
grant execute on function public.save_competitor_discovery_result(uuid, uuid, jsonb, jsonb) to service_role;

comment on function public.enqueue_competitor_discovery_job(uuid, uuid, text) is
  'Creates or reuses one durable competitor-discovery task for the current article search signature.';
comment on column public.article_competitors.discovery_signature is
  'Links the user-approved competitor set to the article search inputs that produced it.';

commit;
