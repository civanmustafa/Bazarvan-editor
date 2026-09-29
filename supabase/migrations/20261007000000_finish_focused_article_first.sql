begin;

-- One durable automatic lane owns an article from its first preparation task
-- until the saved draft is cleaned and every selected audit reaches a terminal
-- result. Manual work and explicit full-pipeline children never use this lane.
create table if not exists public.automatic_article_focus (
  singleton boolean primary key default true check (singleton),
  article_id uuid references public.articles(id) on delete set null,
  state text not null default 'idle' check (state in (
    'idle', 'active', 'waiting_retry', 'needs_attention'
  )),
  current_stage text,
  acquired_at timestamptz,
  last_progress_at timestamptz,
  next_retry_at timestamptz,
  last_error_code text,
  last_error text,
  generation bigint not null default 0,
  last_article_id uuid references public.articles(id) on delete set null,
  last_release_reason text,
  released_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.automatic_article_focus(singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.automatic_article_focus_pauses (
  article_id uuid primary key references public.articles(id) on delete cascade,
  reason text not null,
  error_code text,
  error_message text,
  paused_by uuid references public.profiles(id) on delete set null,
  paused_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.automatic_article_focus enable row level security;
alter table public.automatic_article_focus_pauses enable row level security;
revoke all on table public.automatic_article_focus from public, anon, authenticated;
revoke all on table public.automatic_article_focus_pauses from public, anon, authenticated;
grant all on table public.automatic_article_focus to service_role;
grant all on table public.automatic_article_focus_pauses to service_role;

create or replace function public.automatic_article_focus_controls_job_type(
  p_job_type text
)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(p_job_type, '') in (
    'semantic_keywords_lsi',
    'competitor_discovery',
    'competitor_extraction',
    'content_writing_preparation',
    'content_writing',
    'duplicate_cleanup',
    'engineering_command'
  );
$$;

create or replace function public.automatic_article_focus_stage_for_job_type(
  p_job_type text
)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case p_job_type
    when 'semantic_keywords_lsi' then 'semantic_keywords'
    when 'competitor_discovery' then 'competitor_discovery'
    when 'competitor_extraction' then 'competitor_extraction'
    when 'content_writing_preparation' then 'competitor_preparation'
    when 'content_writing' then 'content_writing'
    when 'duplicate_cleanup' then 'duplicate_cleanup'
    when 'engineering_command' then 'external_audits'
    else coalesce(nullif(btrim(p_job_type), ''), 'preparation')
  end;
$$;

-- Keep creator policy and focus admission separate so the queue guard can
-- distinguish a disabled operation from an operation merely waiting its turn.
create or replace function public.article_automatic_policy_allows(
  p_article_id uuid,
  p_job_type text,
  p_command_id text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_policy jsonb := public.article_automation_policy(p_article_id);
begin
  if coalesce((v_policy->>'policyVersion')::integer, 0) = 0 then
    return true;
  end if;
  if not coalesce((v_policy->>'enabled')::boolean, false) then
    return false;
  end if;
  return case p_job_type
    when 'semantic_keywords_lsi' then coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false)
      or coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false)
      or coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false)
    when 'competitor_discovery' then coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
    when 'competitor_extraction' then coalesce((v_policy->>'autoExtractCompetitorContent')::boolean, false)
    when 'engineering_command' then coalesce((v_policy->>'autoRunReadyEngineeringCommands')::boolean, false)
      and coalesce(v_policy->'externalAnalysisCommandIds', '[]'::jsonb) ? coalesce(p_command_id, '')
    when 'content_writing_preparation' then coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false)
      and coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
      and coalesce((v_policy->>'autoExtractCompetitorContent')::boolean, false)
    when 'content_writing' then coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false)
    when 'duplicate_cleanup' then true
    else false
  end;
end;
$$;

create or replace function public.automatic_article_focus_allows(
  p_article_id uuid,
  p_job_type text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not public.automatic_article_focus_controls_job_type(p_job_type) then true
    when exists (
      select 1 from public.automatic_article_focus_pauses as pause
      where pause.article_id = p_article_id
    ) then false
    else coalesce(
      (select focus.article_id is null or focus.article_id = p_article_id
       from public.automatic_article_focus as focus
       where focus.singleton is true),
      true
    )
  end;
$$;

create or replace function public.article_automatic_job_allowed(
  p_article_id uuid,
  p_job_type text,
  p_command_id text default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.article_automatic_policy_allows(p_article_id, p_job_type, p_command_id)
    and public.automatic_article_focus_allows(p_article_id, p_job_type);
$$;

create or replace function public.try_acquire_automatic_article_focus(
  p_article_id uuid,
  p_stage text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_focus public.automatic_article_focus%rowtype;
begin
  if p_article_id is null or exists (
    select 1 from public.automatic_article_focus_pauses as pause
    where pause.article_id = p_article_id
  ) then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('automatic-article-focus', 0));
  select focus.* into v_focus
  from public.automatic_article_focus as focus
  where focus.singleton is true
  for update;

  if v_focus.article_id is null then
    update public.automatic_article_focus
    set article_id = p_article_id,
        state = 'active',
        current_stage = coalesce(nullif(btrim(p_stage), ''), 'preparation'),
        acquired_at = now(),
        last_progress_at = now(),
        next_retry_at = null,
        last_error_code = null,
        last_error = null,
        generation = generation + 1,
        updated_at = now()
    where singleton is true;
    return true;
  end if;

  if v_focus.article_id = p_article_id then
    update public.automatic_article_focus
    set current_stage = coalesce(nullif(btrim(p_stage), ''), current_stage),
        updated_at = now()
    where singleton is true;
    return true;
  end if;

  return false;
end;
$$;

create or replace function public.get_automatic_article_focus()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_focus public.automatic_article_focus%rowtype;
  v_title text := '';
  v_last_title text := '';
  v_attempt_count integer := 0;
  v_max_attempts integer := 0;
begin
  select focus.* into v_focus
  from public.automatic_article_focus as focus
  where focus.singleton is true;

  if v_focus.article_id is not null then
    select coalesce(article.title, '') into v_title
    from public.articles as article where article.id = v_focus.article_id;

    select coalesce(max(attempts.attempt_count), 0), coalesce(max(attempts.max_attempts), 0)
    into v_attempt_count, v_max_attempts
    from (
      select job.attempt_count, job.max_attempts
      from public.ai_external_analysis_jobs as job
      where job.article_id = v_focus.article_id
        and job.origin = 'auto'
        and job.pipeline_parent_job_id is null
        and public.automatic_article_focus_controls_job_type(job.job_type)
      union all
      select item.attempt_count, item.max_attempts
      from public.content_writing_automation_items as item
      where item.article_id = v_focus.article_id
    ) as attempts;
  end if;

  if v_focus.last_article_id is not null then
    select coalesce(article.title, '') into v_last_title
    from public.articles as article where article.id = v_focus.last_article_id;
  end if;

  return jsonb_build_object(
    'articleId', v_focus.article_id,
    'articleTitle', v_title,
    'state', v_focus.state,
    'currentStage', v_focus.current_stage,
    'acquiredAt', v_focus.acquired_at,
    'lastProgressAt', v_focus.last_progress_at,
    'nextRetryAt', v_focus.next_retry_at,
    'attemptCount', v_attempt_count,
    'maxAttempts', v_max_attempts,
    'lastErrorCode', v_focus.last_error_code,
    'lastError', v_focus.last_error,
    'generation', v_focus.generation,
    'lastArticleId', v_focus.last_article_id,
    'lastArticleTitle', v_last_title,
    'lastReleaseReason', v_focus.last_release_reason,
    'releasedAt', v_focus.released_at,
    'canResume', v_focus.article_id is null and v_focus.last_article_id is not null
      and exists (
        select 1 from public.automatic_article_focus_pauses as pause
        where pause.article_id = v_focus.last_article_id
      )
  );
end;
$$;

create or replace function public.refresh_automatic_article_focus(
  p_article_id uuid,
  p_stage text default null,
  p_status text default null,
  p_error_code text default null,
  p_error_message text default null,
  p_next_retry_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_focus public.automatic_article_focus%rowtype;
  v_article_status text;
  v_policy jsonb := '{}'::jsonb;
  v_work jsonb := '{}'::jsonb;
  v_stage text;
  v_external_active boolean := false;
  v_external_running boolean := false;
  v_session_active boolean := false;
  v_session_running boolean := false;
  v_item_active boolean := false;
  v_item_terminal boolean := false;
  v_next_external_retry timestamptz;
  v_next_session_retry timestamptz;
  v_next_item_retry timestamptz;
  v_next_retry timestamptz;
  v_any_active boolean := false;
  v_any_running boolean := false;
  v_terminal_event boolean := false;
  v_release_reason text;
  v_max_stall_minutes integer := 180;
begin
  perform pg_advisory_xact_lock(hashtextextended('automatic-article-focus', 0));
  select focus.* into v_focus
  from public.automatic_article_focus as focus
  where focus.singleton is true
  for update;

  if v_focus.article_id is null or v_focus.article_id is distinct from p_article_id then
    return public.get_automatic_article_focus();
  end if;

  select article.status into v_article_status
  from public.articles as article where article.id = p_article_id;
  if not found or v_article_status not in ('draft', 'content_preparation') then
    update public.automatic_article_focus
    set article_id = null,
        state = 'idle',
        last_article_id = p_article_id,
        last_release_reason = 'article_left_automation_scope',
        released_at = now(),
        next_retry_at = null,
        updated_at = now()
    where singleton is true;
    return public.get_automatic_article_focus();
  end if;

  select greatest(30, least(1440, case
    when coalesce(setting.value->>'automaticArticleFocusMaxStallMinutes', '') ~ '^[0-9]+$'
      then (setting.value->>'automaticArticleFocusMaxStallMinutes')::integer
    else 180 end))
  into v_max_stall_minutes
  from public.app_settings as setting where setting.key = 'ai';
  v_max_stall_minutes := coalesce(v_max_stall_minutes, 180);

  v_policy := public.article_automation_policy(p_article_id);
  v_work := public.article_automation_work_readiness(p_article_id);

  select
    coalesce(bool_or(job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')), false),
    coalesce(bool_or(job.status = 'running'), false),
    min(job.next_attempt_at) filter (where job.status = 'retry_scheduled'),
    (array_agg(public.automatic_article_focus_stage_for_job_type(job.job_type)
      order by case job.status when 'running' then 0 when 'queued' then 1
        when 'retry_scheduled' then 2 else 3 end, job.updated_at desc))[1]
  into v_external_active, v_external_running, v_next_external_retry, v_stage
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.cancel_requested_at is null
    and public.automatic_article_focus_controls_job_type(job.job_type);

  select
    coalesce(bool_or(session.status in ('queued', 'running', 'retry_scheduled')), false),
    coalesce(bool_or(session.status = 'running'), false),
    min(session.next_attempt_at) filter (where session.status = 'retry_scheduled')
  into v_session_active, v_session_running, v_next_session_retry
  from public.content_writing_sessions as session
  where session.article_id = p_article_id
    and session.execution_mode = 'api'
    and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
    and session.cancel_requested_at is null;

  select
    coalesce(bool_or(item.status in ('claiming', 'writing', 'ready')
      and item.attempt_count > 0 and item.attempt_count < item.max_attempts), false),
    coalesce(bool_or(item.status = 'blocked'
      or (item.status = 'cancelled' and item.attempt_count > 0)), false),
    min(item.eligible_at) filter (where item.status = 'ready' and item.attempt_count > 0)
  into v_item_active, v_item_terminal, v_next_item_retry
  from public.content_writing_automation_items as item
  where item.article_id = p_article_id;

  v_any_active := v_external_active or v_session_active or v_item_active;
  v_any_running := v_external_running or v_session_running;
  select min(value) into v_next_retry
  from unnest(array[p_next_retry_at, v_next_external_retry, v_next_session_retry, v_next_item_retry]) as retry(value)
  where value is not null;

  v_stage := coalesce(nullif(btrim(p_stage), ''), v_stage, v_focus.current_stage, 'preparation');
  if v_session_active or v_item_active then v_stage := 'content_writing'; end if;
  if v_work->>'state' in ('waiting_cleanup', 'cleaning') then v_stage := 'duplicate_cleanup'; end if;
  if v_work->>'state' in ('auditing', 'partial') then v_stage := 'external_audits'; end if;

  if v_work->>'state' = 'ready' then
    update public.automatic_article_focus
    set article_id = null,
        state = 'idle',
        current_stage = 'ready',
        last_article_id = p_article_id,
        last_release_reason = 'article_ready',
        released_at = now(),
        next_retry_at = null,
        last_error_code = null,
        last_error = null,
        last_progress_at = now(),
        updated_at = now()
    where singleton is true;
    delete from public.automatic_article_focus_pauses where article_id = p_article_id;
    return public.get_automatic_article_focus();
  end if;

  v_terminal_event := coalesce(p_status, '') in ('failed', 'blocked', 'cancelled');
  if coalesce((v_policy->>'policyVersion')::integer, 0) = 1
     and not coalesce((v_policy->>'enabled')::boolean, false) then
    v_release_reason := 'automation_policy_disabled';
  elsif v_work->>'state' in ('partial', 'needs_attention') and not v_any_active then
    v_release_reason := 'post_write_attention_required';
  elsif (v_terminal_event or v_item_terminal) and not v_any_active then
    v_release_reason := 'terminal_stage_failure';
  elsif not v_any_running
     and (v_next_retry is null or v_next_retry <= now())
     and coalesce(v_focus.last_progress_at, v_focus.acquired_at, now())
       < now() - make_interval(mins => v_max_stall_minutes) then
    v_release_reason := 'focus_stalled';
  end if;

  if v_release_reason is not null then
    insert into public.automatic_article_focus_pauses(
      article_id, reason, error_code, error_message, paused_at, updated_at
    ) values (
      p_article_id, v_release_reason, p_error_code,
      coalesce(p_error_message, 'Automatic article processing requires manual review.'), now(), now()
    )
    on conflict (article_id) do update set
      reason = excluded.reason,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      paused_at = excluded.paused_at,
      updated_at = now();

    update public.automatic_article_focus
    set article_id = null,
        state = 'needs_attention',
        current_stage = v_stage,
        last_article_id = p_article_id,
        last_release_reason = v_release_reason,
        released_at = now(),
        next_retry_at = null,
        last_error_code = coalesce(p_error_code, last_error_code),
        last_error = coalesce(p_error_message, last_error),
        last_progress_at = now(),
        updated_at = now()
    where singleton is true;
    return public.get_automatic_article_focus();
  end if;

  update public.automatic_article_focus
  set state = case when v_next_retry is not null and v_next_retry > now() and not v_any_running
      then 'waiting_retry' else 'active' end,
      current_stage = v_stage,
      next_retry_at = v_next_retry,
      last_error_code = case when p_error_code is not null then p_error_code else last_error_code end,
      last_error = case when p_error_message is not null then p_error_message else last_error end,
      last_progress_at = case
        when p_status is not null or current_stage is distinct from v_stage then now()
        else last_progress_at end,
      updated_at = now()
  where singleton is true;

  return public.get_automatic_article_focus();
end;
$$;

create or replace function public.reconcile_automatic_article_focus()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_focus public.automatic_article_focus%rowtype;
  v_candidate uuid;
  v_stage text;
begin
  perform pg_advisory_xact_lock(hashtextextended('automatic-article-focus', 0));
  select focus.* into v_focus from public.automatic_article_focus as focus
  where focus.singleton is true for update;

  if v_focus.article_id is not null then
    perform public.refresh_automatic_article_focus(v_focus.article_id);
  end if;

  select focus.* into v_focus from public.automatic_article_focus as focus
  where focus.singleton is true for update;
  if v_focus.article_id is null then
    select candidate.article_id, candidate.stage
    into v_candidate, v_stage
    from (
      select item.article_id, 'content_writing'::text as stage,
        0 as priority, coalesce(item.started_at, item.ready_at, item.updated_at) as started_at
      from public.content_writing_automation_items as item
      where item.status in ('claiming', 'writing')
      union all
      select session.article_id, 'content_writing', 0,
        coalesce(session.started_at, session.created_at)
      from public.content_writing_sessions as session
      where session.execution_mode = 'api'
        and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
        and session.cancel_requested_at is null
        and session.status in ('queued', 'running', 'retry_scheduled')
      union all
      select job.article_id,
        public.automatic_article_focus_stage_for_job_type(job.job_type),
        case job.status when 'running' then 0
          when 'queued' then 1 when 'retry_scheduled' then 1 else 2 end,
        coalesce(job.started_at, job.created_at)
      from public.ai_external_analysis_jobs as job
      where job.origin = 'auto'
        and job.pipeline_parent_job_id is null
        and job.cancel_requested_at is null
        and public.automatic_article_focus_controls_job_type(job.job_type)
        and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    ) as candidate
    where not exists (
      select 1 from public.automatic_article_focus_pauses as pause
      where pause.article_id = candidate.article_id
    )
    order by candidate.priority, candidate.started_at, candidate.article_id
    limit 1;

    if v_candidate is not null then
      perform public.try_acquire_automatic_article_focus(v_candidate, v_stage);
    end if;
  end if;

  select focus.* into v_focus from public.automatic_article_focus as focus
  where focus.singleton is true;
  if v_focus.article_id is not null then
    update public.ai_external_analysis_jobs as job
    set status = 'queued',
        next_attempt_at = now(),
        cancel_requested_at = null,
        progress = coalesce(job.progress, '{}'::jsonb) - 'blockedBy'
          || jsonb_build_object(
            'stage', 'queued',
            'articleQueueLocked', true,
            'focusGeneration', v_focus.generation,
            'queuePolicy', 'finish_focused_article_first',
            'updatedAt', now()
          ),
        updated_at = now()
    where job.article_id = v_focus.article_id
      and job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and job.status = 'waiting_for_prerequisites'
      and job.progress->>'blockedBy' = 'automatic_article_focus';
    perform public.refresh_automatic_article_focus(v_focus.article_id);
  end if;

  return public.get_automatic_article_focus();
end;
$$;

-- The existing policy trigger now parks a valid automatic task behind the
-- focused article instead of incorrectly treating the task as disabled.
create or replace function public.guard_creator_automatic_external_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy jsonb;
  v_policy_allowed boolean;
  v_focus_allowed boolean;
begin
  if new.origin <> 'auto' or new.pipeline_parent_job_id is not null then return new; end if;
  v_policy := public.article_automation_policy(new.article_id);
  if coalesce((v_policy->>'policyVersion')::integer, 0) = 1 then
    new.requested_by := case when exists (
      select 1 from public.profiles where id = (v_policy->>'creatorUserId')::uuid and is_active is true
    ) then (v_policy->>'creatorUserId')::uuid else null end;
  end if;
  if new.status not in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused') then return new; end if;

  v_policy_allowed := public.article_automatic_policy_allows(new.article_id, new.job_type, new.command_id);
  if new.job_type = 'semantic_keywords_lsi' and coalesce((v_policy->>'policyVersion')::integer, 0) = 1 then
    if tg_op = 'UPDATE' and old.status = 'running' then
      v_policy_allowed := v_policy_allowed
        and (not coalesce((new.input_snapshot->>'needsSecondaries')::boolean, false)
          or coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false))
        and (not coalesce((new.input_snapshot->>'needsLsi')::boolean, false)
          or coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false))
        and (not coalesce((new.input_snapshot->>'needsGoogleMetadata')::boolean, false)
          or coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false));
    else
      new.input_snapshot := coalesce(new.input_snapshot, '{}'::jsonb) || jsonb_build_object(
        'needsSecondaries', coalesce((new.input_snapshot->>'needsSecondaries')::boolean, true)
          and coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false),
        'needsLsi', coalesce((new.input_snapshot->>'needsLsi')::boolean, true)
          and coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false),
        'needsGoogleMetadata', coalesce((new.input_snapshot->>'needsGoogleMetadata')::boolean, true)
          and coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false),
        'automationSettings', v_policy
      );
      v_policy_allowed := v_policy_allowed and (
        coalesce((new.input_snapshot->>'needsSecondaries')::boolean, false)
        or coalesce((new.input_snapshot->>'needsLsi')::boolean, false)
        or coalesce((new.input_snapshot->>'needsGoogleMetadata')::boolean, false)
      );
    end if;
  end if;

  if not v_policy_allowed then
    new.cancel_requested_at := coalesce(new.cancel_requested_at, now());
    new.last_error_code := 'creator_automation_disabled';
    new.last_error := 'Automatic work is disabled by the original article creator or administrator.';
    if tg_op <> 'UPDATE' or old.status <> 'running' then
      if tg_op = 'UPDATE' and new.status = 'running' then
        new.attempt_count := old.attempt_count;
        new.started_at := old.started_at;
        new.lease_generation := old.lease_generation;
      end if;
      new.status := 'cancelled';
      new.next_attempt_at := null;
      new.locked_by := null;
      new.locked_at := null;
      new.lease_expires_at := null;
      new.completed_at := coalesce(new.completed_at, now());
    end if;
    return new;
  end if;

  if public.automatic_article_focus_controls_job_type(new.job_type) then
    v_focus_allowed := public.try_acquire_automatic_article_focus(
      new.article_id,
      public.automatic_article_focus_stage_for_job_type(new.job_type)
    );
    if not v_focus_allowed then
      if tg_op = 'UPDATE' and old.status = 'running' then
        new.cancel_requested_at := coalesce(new.cancel_requested_at, now());
        new.progress := coalesce(new.progress, '{}'::jsonb) || jsonb_build_object(
          'focusPause', true,
          'blockedBy', 'automatic_article_focus',
          'updatedAt', now()
        );
      else
        new.status := 'waiting_for_prerequisites';
        new.next_attempt_at := null;
        new.locked_by := null;
        new.locked_at := null;
        new.lease_expires_at := null;
        new.progress := coalesce(new.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'waiting_for_prerequisites',
          'blockedBy', 'automatic_article_focus',
          'queuePolicy', 'finish_focused_article_first',
          'updatedAt', now()
        );
      end if;
    else
      new.progress := coalesce(new.progress, '{}'::jsonb) || jsonb_build_object(
        'articleQueueLocked', true,
        'queuePolicy', 'finish_focused_article_first',
        'updatedAt', now()
      );
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.guard_automatic_content_writing_focus()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('claiming', 'writing')
     and not public.try_acquire_automatic_article_focus(new.article_id, 'content_writing') then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_automatic_content_writing_focus
  on public.content_writing_automation_items;
create trigger guard_automatic_content_writing_focus
before insert or update of status, article_id
on public.content_writing_automation_items
for each row execute function public.guard_automatic_content_writing_focus();

create or replace function public.guard_creator_automatic_writing_session()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_policy jsonb;
begin
  if new.execution_mode <> 'api'
     or coalesce(new.context_snapshot->>'triggerSource', '') <> 'automatic_ready' then
    return new;
  end if;
  -- Completion, cancellation, and failure must remain writable after the lane
  -- was released or paused; only work that can consume a provider call needs
  -- to own the focus.
  if new.status not in ('queued', 'running', 'retry_scheduled') then return new; end if;
  v_policy := public.article_automation_policy(new.article_id);
  if coalesce((v_policy->>'policyVersion')::integer, 0) = 1
     and (not coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false)
       or new.created_by is distinct from (v_policy->>'creatorUserId')::uuid) then
    raise exception 'Automatic writing requires the original creator and their enabled policy.' using errcode = '23514';
  end if;
  if not public.try_acquire_automatic_article_focus(new.article_id, 'content_writing') then
    raise exception 'Another automatic article owns the finish-first queue.' using errcode = '40001';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_creator_automatic_writing_session
  on public.content_writing_sessions;
create trigger guard_creator_automatic_writing_session
before insert or update of status, article_id
on public.content_writing_sessions
for each row execute function public.guard_creator_automatic_writing_session();

create or replace function public.capture_automatic_article_focus_from_external_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.origin = 'auto'
     and new.pipeline_parent_job_id is null
     and public.automatic_article_focus_controls_job_type(new.job_type) then
    perform public.refresh_automatic_article_focus(
      new.article_id,
      public.automatic_article_focus_stage_for_job_type(new.job_type),
      new.status,
      new.last_error_code,
      new.last_error,
      new.next_attempt_at
    );
  end if;
  return new;
end;
$$;

drop trigger if exists zz_capture_automatic_article_focus_from_external_job
  on public.ai_external_analysis_jobs;
create trigger zz_capture_automatic_article_focus_from_external_job
after insert or update of status, next_attempt_at, last_error_code, cancel_requested_at
on public.ai_external_analysis_jobs
for each row execute function public.capture_automatic_article_focus_from_external_job();

create or replace function public.capture_automatic_article_focus_from_writing_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.attempt_count > 0 then
    perform public.refresh_automatic_article_focus(
      new.article_id, 'content_writing', new.status,
      new.last_error_code, new.last_error, new.eligible_at
    );
  end if;
  return new;
end;
$$;

drop trigger if exists zz_capture_automatic_article_focus_from_writing_item
  on public.content_writing_automation_items;
create trigger zz_capture_automatic_article_focus_from_writing_item
after insert or update of status, eligible_at, last_error_code
on public.content_writing_automation_items
for each row execute function public.capture_automatic_article_focus_from_writing_item();

create or replace function public.capture_automatic_article_focus_from_writing_session()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.execution_mode = 'api'
     and coalesce(new.context_snapshot->>'triggerSource', '') = 'automatic_ready' then
    perform public.refresh_automatic_article_focus(
      new.article_id, 'content_writing', new.status,
      new.last_error_code, new.last_error, new.next_attempt_at
    );
  end if;
  return new;
end;
$$;

drop trigger if exists zz_capture_automatic_article_focus_from_writing_session
  on public.content_writing_sessions;
create trigger zz_capture_automatic_article_focus_from_writing_session
after insert or update of status, applied_at, next_attempt_at, last_error_code
on public.content_writing_sessions
for each row execute function public.capture_automatic_article_focus_from_writing_session();

-- A retry retains the cross-stage focus. It no longer rotates the article out
-- after one failed provider call; terminal/dead-letter handling releases it.
create or replace function public.rotate_external_analysis_article_after_retry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_is_focus boolean := false;
begin
  select focus.article_id = new.article_id into v_is_focus
  from public.automatic_article_focus as focus where focus.singleton is true;
  update public.ai_external_analysis_jobs as sibling
  set progress = coalesce(sibling.progress, '{}'::jsonb) || jsonb_build_object(
        'articleQueueLocked', coalesce(v_is_focus, false),
        'articleQueueReleasedAt', case when v_is_focus then null else to_jsonb(now()) end,
        'articleQueueReleaseReason', case when v_is_focus then null
          else coalesce(new.last_error_code, 'external_analysis_retry') end,
        'queuePolicy', case when v_is_focus then 'finish_focused_article_first'
          else 'round_robin_after_attempt' end,
        'updatedAt', now()
      ),
      updated_at = now()
  where sibling.article_id = new.article_id
    and sibling.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    and sibling.cancel_requested_at is null;
  return new;
end;
$$;

-- Retire the old writing-retry rotation. The focused article keeps its turn
-- until ready or explicitly moved to manual attention.
create or replace function public.defer_due_automatic_content_writing_retry_for_fairness()
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select false;
$$;

create or replace function public.skip_automatic_article_focus(
  p_requested_by uuid,
  p_reason text default 'administrator_skipped_focus'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_focus public.automatic_article_focus%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('automatic-article-focus', 0));
  select focus.* into v_focus from public.automatic_article_focus as focus
  where focus.singleton is true for update;
  if v_focus.article_id is null then return public.get_automatic_article_focus(); end if;

  insert into public.automatic_article_focus_pauses(
    article_id, reason, error_code, error_message, paused_by, paused_at, updated_at
  ) values (
    v_focus.article_id, coalesce(nullif(btrim(p_reason), ''), 'administrator_skipped_focus'),
    'automatic_focus_skipped', 'The focused article was moved to manual review by an administrator.',
    p_requested_by, now(), now()
  ) on conflict (article_id) do update set
    reason = excluded.reason,
    error_code = excluded.error_code,
    error_message = excluded.error_message,
    paused_by = excluded.paused_by,
    paused_at = excluded.paused_at,
    updated_at = now();

  update public.automatic_article_focus
  set article_id = null,
      state = 'needs_attention',
      last_article_id = v_focus.article_id,
      last_release_reason = 'administrator_skipped_focus',
      released_at = now(),
      next_retry_at = null,
      last_error_code = 'automatic_focus_skipped',
      last_error = 'The focused article was moved to manual review by an administrator.',
      last_progress_at = now(),
      updated_at = now()
  where singleton is true;

  update public.ai_external_analysis_jobs as job
  set status = case when job.status = 'running' then job.status else 'waiting_for_prerequisites' end,
      cancel_requested_at = case when job.status = 'running' then coalesce(job.cancel_requested_at, now())
        else job.cancel_requested_at end,
      next_attempt_at = null,
      locked_by = case when job.status = 'running' then job.locked_by else null end,
      locked_at = case when job.status = 'running' then job.locked_at else null end,
      lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'focusPause', true,
        'blockedBy', 'manual_review',
        'queuePolicy', 'finish_focused_article_first',
        'updatedAt', now()
      ),
      updated_at = now()
  where job.article_id = v_focus.article_id
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and public.automatic_article_focus_controls_job_type(job.job_type)
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');

  update public.content_writing_sessions as session
  set status = case when session.status = 'running' then session.status else 'cancelled' end,
      cancel_requested_at = coalesce(session.cancel_requested_at, now()),
      next_attempt_at = null,
      last_error_code = 'automatic_focus_skipped',
      last_error = 'The focused article was moved to manual review by an administrator.',
      completed_at = case when session.status = 'running' then session.completed_at else now() end,
      updated_at = now()
  where session.article_id = v_focus.article_id
    and session.execution_mode = 'api'
    and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
    and session.status in ('queued', 'running', 'retry_scheduled');

  update public.content_writing_automation_items as item
  set status = 'ready',
      eligible_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      last_error_code = 'automatic_focus_skipped',
      last_error = 'The focused article was moved to manual review by an administrator.',
      updated_at = now()
  where item.article_id = v_focus.article_id
    and item.status in ('ready', 'claiming', 'writing');

  return public.get_automatic_article_focus();
end;
$$;

create or replace function public.resume_automatic_article_focus(
  p_requested_by uuid,
  p_article_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_focus public.automatic_article_focus%rowtype;
  v_article_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('automatic-article-focus', 0));
  select focus.* into v_focus from public.automatic_article_focus as focus
  where focus.singleton is true for update;
  if v_focus.article_id is not null then
    raise exception 'Another automatic article currently owns the finish-first queue.' using errcode = 'P0001';
  end if;
  v_article_id := coalesce(p_article_id, v_focus.last_article_id);
  if v_article_id is null or not exists (
    select 1 from public.automatic_article_focus_pauses as pause where pause.article_id = v_article_id
  ) then
    raise exception 'No paused automatic article is available to resume.' using errcode = 'P0002';
  end if;

  delete from public.automatic_article_focus_pauses where article_id = v_article_id;
  if not public.try_acquire_automatic_article_focus(v_article_id, 'preparation') then
    raise exception 'The automatic article focus could not be acquired.' using errcode = '40001';
  end if;

  update public.ai_external_analysis_jobs as job
  set status = 'queued',
      max_attempts = greatest(job.max_attempts, job.attempt_count + 1),
      next_attempt_at = now(),
      cancel_requested_at = null,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      completed_at = null,
      dead_lettered_at = null,
      dead_letter_reason = null,
      last_error_code = null,
      last_error = null,
      progress = coalesce(job.progress, '{}'::jsonb) - 'blockedBy' - 'focusPause'
        || jsonb_build_object(
          'stage', 'queued',
          'articleQueueLocked', true,
          'queuePolicy', 'finish_focused_article_first',
          'resumedBy', p_requested_by,
          'updatedAt', now()
        ),
      updated_at = now()
  where job.article_id = v_article_id
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and public.automatic_article_focus_controls_job_type(job.job_type)
    and coalesce((job.progress->>'focusPause')::boolean, false)
    and job.status in ('waiting_for_prerequisites', 'failed', 'blocked', 'cancelled', 'paused');

  update public.content_writing_automation_items as item
  set status = 'ready',
      max_attempts = greatest(item.max_attempts, item.attempt_count + 1),
      eligible_at = now(),
      completed_at = null,
      failure_class = null,
      next_recovery_at = null,
      last_error_code = null,
      last_error = null,
      updated_at = now()
  where item.article_id = v_article_id
    and item.status in ('ready', 'blocked', 'cancelled');

  perform public.refresh_automatic_article_focus(v_article_id, 'preparation', 'resumed');
  return public.get_automatic_article_focus();
end;
$$;

-- Reconcile only the focused article after the first useful enqueue acquires
-- the lane. When idle, oldest drafts are considered first, not newest first.
create or replace function public.reconcile_article_automation_coordinator(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article record;
  v_discovery_id uuid;
  v_processed integer := 0;
  v_error_count integer := 0;
  v_minimum_competitors integer := 3;
  v_preparation_id uuid;
  v_focus jsonb := '{}'::jsonb;
  v_focus_article_id uuid;
begin
  update public.article_automation_coordinator_runtime
  set last_started_at = now()
  where singleton is true
    and (last_started_at is null or last_started_at < now() - interval '30 seconds');
  if not found then
    return jsonb_build_object('skipped', true, 'reason', 'coordinator_recently_ran');
  end if;

  v_focus := public.reconcile_automatic_article_focus();
  begin v_focus_article_id := nullif(v_focus->>'articleId', '')::uuid;
  exception when invalid_text_representation then v_focus_article_id := null; end;

  for v_article in
    select article.id
    from public.articles as article
    join public.ai_external_analysis_article_state as state on state.article_id = article.id
    where article.status in ('draft', 'content_preparation')
      and (v_focus_article_id is null or article.id = v_focus_article_id)
      and not exists (
        select 1 from public.automatic_article_focus_pauses as pause where pause.article_id = article.id
      )
    order by article.created_at, article.id
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  loop
    begin
      perform public.initialize_article_automation_stage_states(v_article.id);
      perform public.enqueue_external_semantic_analysis_job_controlled(v_article.id, 'auto');
      perform public.enqueue_competitor_discovery_job_controlled(v_article.id, null, 'auto');
      select job.id into v_discovery_id
      from public.ai_external_analysis_jobs as job
      where job.article_id = v_article.id
        and job.job_type = 'competitor_discovery'
        and job.status = 'completed'
        and job.pipeline_parent_job_id is null
      order by job.completed_at desc nulls last, job.created_at desc
      limit 1;
      if v_discovery_id is not null
         and public.article_automatic_job_allowed(v_article.id, 'competitor_extraction') then
        perform public.enqueue_automatic_competitor_extraction_for_discovery(v_discovery_id);
      end if;
      perform public.reconcile_automatic_ready_engineering_commands_for_article(v_article.id);
      v_processed := v_processed + 1;
      v_focus := public.get_automatic_article_focus();
      begin v_focus_article_id := nullif(v_focus->>'articleId', '')::uuid;
      exception when invalid_text_representation then v_focus_article_id := null; end;
      if v_focus_article_id is not null then exit; end if;
    exception when others then
      v_error_count := v_error_count + 1;
    end;
  end loop;

  select greatest(2, least(5, case
    when coalesce(setting.value->>'contentWritingAutomationMinimumCompetitors', '') ~ '^[0-9]+$'
      then (setting.value->>'contentWritingAutomationMinimumCompetitors')::integer
    else 3 end))
  into v_minimum_competitors
  from public.app_settings as setting where setting.key = 'ai';
  v_minimum_competitors := coalesce(v_minimum_competitors, 3);
  begin
    select job.id into v_preparation_id
    from public.enqueue_next_automatic_writing_competitor_preparation(v_minimum_competitors) as job;
  exception when others then
    v_error_count := v_error_count + 1;
  end;

  update public.article_automation_coordinator_runtime
  set last_completed_at = now(),
      last_result = jsonb_build_object(
        'processedArticles', v_processed,
        'errorCount', v_error_count,
        'contentPreparationJobId', v_preparation_id,
        'focus', public.get_automatic_article_focus(),
        'completedAt', now()
      )
  where singleton is true;

  return jsonb_build_object(
    'skipped', false,
    'processedArticles', v_processed,
    'errorCount', v_error_count,
    'contentPreparationJobId', v_preparation_id,
    'focus', public.get_automatic_article_focus()
  );
end;
$$;

-- Adopt the oldest already-started automatic article during rollout and park
-- every other pending automatic job without consuming another provider call.
do $$
declare v_article_id uuid; v_stage text;
begin
  select candidate.article_id, candidate.stage
  into v_article_id, v_stage
  from (
    select item.article_id, 'content_writing'::text as stage, 0 as priority,
      coalesce(item.started_at, item.ready_at, item.updated_at) as started_at
    from public.content_writing_automation_items as item
    where item.status in ('claiming', 'writing')
    union all
    select job.article_id, public.automatic_article_focus_stage_for_job_type(job.job_type),
      case job.status when 'running' then 0
        when 'queued' then 1 when 'retry_scheduled' then 1 else 2 end,
      coalesce(job.started_at, job.created_at)
    from public.ai_external_analysis_jobs as job
    where job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and job.cancel_requested_at is null
      and public.automatic_article_focus_controls_job_type(job.job_type)
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  ) as candidate
  order by candidate.priority, candidate.started_at, candidate.article_id
  limit 1;
  if v_article_id is not null then
    perform public.try_acquire_automatic_article_focus(v_article_id, v_stage);
  end if;
end;
$$;

update public.ai_external_analysis_jobs as job
set status = case when job.status = 'running' then job.status else 'waiting_for_prerequisites' end,
    cancel_requested_at = case when job.status = 'running' then coalesce(job.cancel_requested_at, now())
      else job.cancel_requested_at end,
    next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'focusPause', true,
      'blockedBy', 'automatic_article_focus',
      'queuePolicy', 'finish_focused_article_first',
      'updatedAt', now()
    ),
    updated_at = now()
where job.origin = 'auto'
  and job.pipeline_parent_job_id is null
  and public.automatic_article_focus_controls_job_type(job.job_type)
  and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  and job.article_id is distinct from (
    select focus.article_id from public.automatic_article_focus as focus where focus.singleton is true
  );

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 6;
$$;

revoke all on function public.automatic_article_focus_controls_job_type(text) from public, anon, authenticated;
revoke all on function public.automatic_article_focus_stage_for_job_type(text) from public, anon, authenticated;
revoke all on function public.article_automatic_policy_allows(uuid,text,text) from public, anon, authenticated;
revoke all on function public.automatic_article_focus_allows(uuid,text) from public, anon, authenticated;
revoke all on function public.try_acquire_automatic_article_focus(uuid,text) from public, anon, authenticated;
revoke all on function public.get_automatic_article_focus() from public, anon, authenticated;
revoke all on function public.refresh_automatic_article_focus(uuid,text,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.reconcile_automatic_article_focus() from public, anon, authenticated;
revoke all on function public.skip_automatic_article_focus(uuid,text) from public, anon, authenticated;
revoke all on function public.resume_automatic_article_focus(uuid,uuid) from public, anon, authenticated;
grant execute on function public.get_automatic_article_focus() to service_role;
grant execute on function public.reconcile_automatic_article_focus() to service_role;
grant execute on function public.skip_automatic_article_focus(uuid,text) to service_role;
grant execute on function public.resume_automatic_article_focus(uuid,uuid) to service_role;

comment on table public.automatic_article_focus is
  'Singleton finish-first lane for ordinary automatic article preparation, writing, cleanup, and audits.';
comment on table public.automatic_article_focus_pauses is
  'Articles removed from the automatic lane until an administrator explicitly resumes them.';

notify pgrst, 'reload schema';

commit;
