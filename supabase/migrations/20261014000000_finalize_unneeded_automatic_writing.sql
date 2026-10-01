begin;

-- Keep one database-owned definition of whether automatic writing is still
-- useful. This covers TipTap JSON/HTML as well as plain text, article scope,
-- and an already completed writing run.
create or replace function public.automatic_content_writing_requirement(
  p_article_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
begin
  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null then
    return jsonb_build_object('required', false, 'reason', 'article_not_found');
  end if;

  if coalesce(v_article.status, '') not in ('draft', 'content_preparation') then
    return jsonb_build_object('required', false, 'reason', 'article_left_automation_scope');
  end if;

  if public.article_body_has_content(
    v_article.content_json,
    v_article.content_html,
    v_article.plain_text
  ) then
    return jsonb_build_object('required', false, 'reason', 'article_editor_not_empty');
  end if;

  if exists (
    select 1
    from public.content_writing_sessions as session
    where session.article_id = p_article_id
      and session.status = 'completed'
  ) then
    return jsonb_build_object('required', false, 'reason', 'content_writing_already_completed');
  end if;

  return jsonb_build_object('required', true, 'reason', 'automatic_writing_required');
end;
$$;

create or replace function public.guard_content_writing_automation_requirement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requirement jsonb;
  v_reason text;
begin
  if new.status not in ('ready', 'claiming', 'writing', 'blocked', 'cancelled') then
    return new;
  end if;

  v_requirement := public.automatic_content_writing_requirement(new.article_id);
  if coalesce((v_requirement->>'required')::boolean, false) then
    return new;
  end if;

  -- Preserve an explicit manual replacement reason. Every other stale item is
  -- a successful no-op and must not consume retries or pause the focus lane.
  if new.status = 'cancelled'
     and new.last_error_code = 'superseded_by_explicit_manual' then
    return new;
  end if;

  v_reason := coalesce(v_requirement->>'reason', 'automatic_writing_not_required');
  new.status := 'cancelled';
  new.attempt_count := 0;
  new.locked_by := null;
  new.locked_at := null;
  new.lease_expires_at := null;
  new.next_recovery_at := null;
  new.failure_class := null;
  new.completed_at := coalesce(new.completed_at, now());
  new.last_error_code := case
    when v_reason = 'article_left_automation_scope' then 'article_left_automation_scope'
    else 'automatic_writing_not_required'
  end;
  new.last_error := case
    when v_reason = 'article_left_automation_scope'
      then 'The article left draft preparation; automatic writing is no longer required.'
    when v_reason = 'content_writing_already_completed'
      then 'The article already has a completed writing session; automatic writing is no longer required.'
    else 'The article editor already contains content; automatic writing is no longer required.'
  end;
  return new;
end;
$$;

drop trigger if exists guard_content_writing_automation_requirement
  on public.content_writing_automation_items;
create trigger guard_content_writing_automation_requirement
before insert or update on public.content_writing_automation_items
for each row execute function public.guard_content_writing_automation_requirement();

-- Close the scheduler/session insertion race using the same complete rule.
create or replace function public.guard_automatic_content_writing_empty_editor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requirement jsonb;
begin
  if new.execution_mode = 'api'
     and coalesce(new.context_snapshot ->> 'triggerSource', '') = 'automatic_ready' then
    v_requirement := public.automatic_content_writing_requirement(new.article_id);
    if not coalesce((v_requirement->>'required')::boolean, false) then
      raise exception 'Automatic content writing is no longer required for this article.'
        using errcode = '23514',
          detail = coalesce(v_requirement->>'reason', 'automatic_writing_not_required');
    end if;
  end if;
  return new;
end;
$$;

-- Saving content or changing the workflow state closes stale automatic work
-- immediately. A running worker receives a cancellation request and exits at
-- its next checkpoint; queued work is terminal now.
create or replace function public.finalize_unneeded_automatic_writing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requirement jsonb;
  v_reason text;
  v_code text;
  v_message text;
begin
  v_requirement := public.automatic_content_writing_requirement(new.id);
  if coalesce((v_requirement->>'required')::boolean, false) then
    return new;
  end if;

  v_reason := coalesce(v_requirement->>'reason', 'automatic_writing_not_required');
  v_code := case when v_reason = 'article_left_automation_scope'
    then 'article_left_automation_scope' else 'automatic_writing_not_required' end;
  v_message := case
    when v_reason = 'article_left_automation_scope'
      then 'The article left draft preparation; automatic writing is no longer required.'
    when v_reason = 'content_writing_already_completed'
      then 'The article already has a completed writing session; automatic writing is no longer required.'
    else 'The article editor already contains content; automatic writing is no longer required.'
  end;

  update public.content_writing_sessions as session
  set status = case when session.status = 'running' then session.status else 'cancelled' end,
      cancel_requested_at = coalesce(session.cancel_requested_at, now()),
      last_error_code = v_code,
      last_error = v_message,
      completed_at = case when session.status = 'running' then session.completed_at
        else coalesce(session.completed_at, now()) end,
      locked_by = case when session.status = 'running' then session.locked_by else null end,
      locked_at = case when session.status = 'running' then session.locked_at else null end,
      lease_expires_at = case when session.status = 'running' then session.lease_expires_at else null end,
      updated_at = now()
  where session.article_id = new.id
    and session.execution_mode = 'api'
    and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
    and session.status in ('queued', 'running', 'retry_scheduled');

  update public.content_writing_automation_items as item
  set status = 'cancelled',
      attempt_count = 0,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      next_recovery_at = null,
      failure_class = null,
      completed_at = coalesce(item.completed_at, now()),
      last_error_code = v_code,
      last_error = v_message,
      updated_at = now()
  where item.article_id = new.id
    and item.status in ('ready', 'claiming', 'writing', 'blocked');

  if v_reason = 'article_left_automation_scope' then
    update public.ai_external_analysis_jobs as job
    set status = case when job.status = 'running' then job.status else 'cancelled' end,
        cancel_requested_at = coalesce(job.cancel_requested_at, now()),
        last_error_code = v_code,
        last_error = v_message,
        completed_at = case when job.status = 'running' then job.completed_at
          else coalesce(job.completed_at, now()) end,
        locked_by = case when job.status = 'running' then job.locked_by else null end,
        locked_at = case when job.status = 'running' then job.locked_at else null end,
        lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
        updated_at = now()
    where job.article_id = new.id
      and job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and public.automatic_article_focus_controls_job_type(job.job_type)
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');

    delete from public.automatic_article_focus_pauses where article_id = new.id;
    update public.automatic_article_focus
    set article_id = null,
        state = 'idle',
        current_stage = null,
        last_article_id = new.id,
        last_release_reason = 'article_left_automation_scope',
        released_at = now(),
        next_retry_at = null,
        last_error_code = null,
        last_error = null,
        last_progress_at = now(),
        updated_at = now()
    where singleton is true
      and (article_id = new.id or (article_id is null and last_article_id = new.id));
  end if;

  return new;
end;
$$;

drop trigger if exists finalize_unneeded_automatic_writing on public.articles;
create trigger finalize_unneeded_automatic_writing
after update of status, content_json, content_html, plain_text on public.articles
for each row
when (
  old.status is distinct from new.status
  or old.content_json is distinct from new.content_json
  or old.content_html is distinct from new.content_html
  or old.plain_text is distinct from new.plain_text
)
execute function public.finalize_unneeded_automatic_writing();

-- Reconciliation must not reacquire an item while a cancellation is being
-- observed by a running worker.
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
        and coalesce((public.automatic_content_writing_requirement(item.article_id)->>'required')::boolean, false)
      union all
      select session.article_id, 'content_writing', 0,
        coalesce(session.started_at, session.created_at)
      from public.content_writing_sessions as session
      where session.execution_mode = 'api'
        and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
        and session.cancel_requested_at is null
        and session.status in ('queued', 'running', 'retry_scheduled')
        and coalesce((public.automatic_content_writing_requirement(session.article_id)->>'required')::boolean, false)
      union all
      select job.article_id,
        public.automatic_article_focus_stage_for_job_type(job.job_type),
        case job.status when 'running' then 0
          when 'queued' then 1 when 'retry_scheduled' then 1 else 2 end,
        coalesce(job.started_at, job.created_at)
      from public.ai_external_analysis_jobs as job
      join public.articles as article on article.id = job.article_id
      where job.origin = 'auto'
        and job.pipeline_parent_job_id is null
        and job.cancel_requested_at is null
        and article.status in ('draft', 'content_preparation')
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

-- Repair every existing stale row, including articles already in review.
with candidates as (
  select session.id,
    public.automatic_content_writing_requirement(session.article_id) as requirement
  from public.content_writing_sessions as session
  where session.execution_mode = 'api'
    and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
    and session.status in ('queued', 'running', 'retry_scheduled')
)
update public.content_writing_sessions as session
set status = case when session.status = 'running' then session.status else 'cancelled' end,
    cancel_requested_at = coalesce(session.cancel_requested_at, now()),
    last_error_code = case
      when candidates.requirement->>'reason' = 'article_left_automation_scope'
        then 'article_left_automation_scope' else 'automatic_writing_not_required' end,
    last_error = 'Automatic writing is no longer required for this article.',
    completed_at = case when session.status = 'running' then session.completed_at
      else coalesce(session.completed_at, now()) end,
    locked_by = case when session.status = 'running' then session.locked_by else null end,
    locked_at = case when session.status = 'running' then session.locked_at else null end,
    lease_expires_at = case when session.status = 'running' then session.lease_expires_at else null end,
    updated_at = now()
from candidates
where session.id = candidates.id
  and not coalesce((candidates.requirement->>'required')::boolean, false);

with candidates as (
  select item.id,
    public.automatic_content_writing_requirement(item.article_id) as requirement
  from public.content_writing_automation_items as item
  where item.status in ('ready', 'claiming', 'writing', 'blocked', 'cancelled')
    and item.last_error_code is distinct from 'superseded_by_explicit_manual'
)
update public.content_writing_automation_items as item
set status = 'cancelled',
    attempt_count = 0,
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    next_recovery_at = null,
    failure_class = null,
    completed_at = coalesce(item.completed_at, now()),
    last_error_code = case
      when candidates.requirement->>'reason' = 'article_left_automation_scope'
        then 'article_left_automation_scope' else 'automatic_writing_not_required' end,
    last_error = 'Automatic writing is no longer required for this article.',
    updated_at = now()
from candidates
where item.id = candidates.id
  and not coalesce((candidates.requirement->>'required')::boolean, false);

update public.ai_external_analysis_jobs as job
set status = case when job.status = 'running' then job.status else 'cancelled' end,
    cancel_requested_at = coalesce(job.cancel_requested_at, now()),
    last_error_code = 'article_left_automation_scope',
    last_error = 'The article left draft preparation; automatic work is no longer required.',
    completed_at = case when job.status = 'running' then job.completed_at
      else coalesce(job.completed_at, now()) end,
    locked_by = case when job.status = 'running' then job.locked_by else null end,
    locked_at = case when job.status = 'running' then job.locked_at else null end,
    lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
    updated_at = now()
from public.articles as article
where article.id = job.article_id
  and article.status not in ('draft', 'content_preparation')
  and job.origin = 'auto'
  and job.pipeline_parent_job_id is null
  and public.automatic_article_focus_controls_job_type(job.job_type)
  and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');

delete from public.automatic_article_focus_pauses as pause
using public.articles as article
where article.id = pause.article_id
  and article.status not in ('draft', 'content_preparation');

update public.automatic_article_focus as focus
set article_id = null,
    state = 'idle',
    current_stage = null,
    last_article_id = coalesce(focus.article_id, focus.last_article_id),
    last_release_reason = 'article_left_automation_scope',
    released_at = now(),
    next_retry_at = null,
    last_error_code = null,
    last_error = null,
    last_progress_at = now(),
    updated_at = now()
where focus.singleton is true
  and (
    exists (
      select 1 from public.articles as article
      where article.id = focus.article_id
        and article.status not in ('draft', 'content_preparation')
    )
    or (
      focus.article_id is null
      and exists (
        select 1 from public.articles as article
        where article.id = focus.last_article_id
          and article.status not in ('draft', 'content_preparation')
      )
    )
  );

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 11;
$$;

revoke all on function public.automatic_content_writing_requirement(uuid)
  from public, anon, authenticated;
revoke all on function public.guard_content_writing_automation_requirement()
  from public, anon, authenticated;
revoke all on function public.finalize_unneeded_automatic_writing()
  from public, anon, authenticated;
grant execute on function public.automatic_content_writing_requirement(uuid) to service_role;

comment on function public.automatic_content_writing_requirement(uuid) is
  'Canonical decision for whether an article still requires automatic content writing.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 11 with terminal cleanup for automatic writing that is no longer required.';

notify pgrst, 'reload schema';

commit;
