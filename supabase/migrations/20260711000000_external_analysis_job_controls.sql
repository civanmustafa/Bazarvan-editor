-- External analysis phase 7: durable cancellation and worker lifecycle controls.

create or replace function public.request_external_analysis_job_cancel(
  p_job_id uuid,
  p_requested_by uuid default null
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.ai_external_analysis_jobs%rowtype;
  v_affected_count integer := 0;
begin
  if p_job_id is null then
    raise exception 'job id is required' using errcode = '22023';
  end if;

  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.id = p_job_id;

  if v_job.id is null then
    raise exception 'external analysis job was not found' using errcode = 'P0002';
  end if;

  with recursive affected_jobs as (
    select job.id
    from public.ai_external_analysis_jobs as job
    where job.id = p_job_id

    union all

    select child.id
    from public.ai_external_analysis_jobs as child
    join affected_jobs as parent on parent.id = child.depends_on_job_id
    where child.article_id = v_job.article_id
      and child.status in (
      'waiting_for_prerequisites',
      'queued',
      'running',
      'retry_scheduled',
      'paused'
    )
  ), updated_jobs as (
    update public.ai_external_analysis_jobs as job
    set
      status = case when job.status = 'running' then 'running' else 'cancelled' end,
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
      locked_by = case when job.status = 'running' then job.locked_by else null end,
      locked_at = case when job.status = 'running' then job.locked_at else null end,
      lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
      last_error_code = 'cancelled_by_user',
      last_error = 'The external analysis task was cancelled by the user.',
      completed_at = case when job.status = 'running' then job.completed_at else now() end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.status = 'running' then 'cancel_requested' else 'cancelled' end,
        'reason', 'cancelled_by_user',
        'cancelledBy', p_requested_by,
        'updatedAt', now()
      ),
      updated_at = now()
    from affected_jobs
    where job.id = affected_jobs.id
      and job.status in (
        'waiting_for_prerequisites',
        'queued',
        'running',
        'retry_scheduled',
        'paused'
      )
    returning job.id, job.status
  ), closed_runs as (
    update public.ai_external_analysis_runs as run
    set
      status = 'cancelled',
      error_code = 'cancelled_by_user',
      error_message = 'The external analysis task was cancelled by the user.',
      progress = coalesce(run.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'cancelled',
        'reason', 'cancelled_by_user',
        'updatedAt', now()
      ),
      finished_at = now()
    from updated_jobs
    where run.job_id = updated_jobs.id
      and updated_jobs.status = 'cancelled'
      and run.status = 'running'
    returning run.id
  )
  select
    (select count(*) from updated_jobs)::integer
      + ((select count(*) from closed_runs)::integer * 0)
  into v_affected_count;

  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.id = p_job_id;

  return v_job;
end;
$$;

create or replace function public.heartbeat_external_analysis_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 1800));
  v_status text;
  v_locked_by text;
  v_cancel_requested_at timestamptz;
  v_error_code text;
  v_error_message text;
begin
  select job.status, job.locked_by, job.cancel_requested_at, job.last_error_code, job.last_error
  into v_status, v_locked_by, v_cancel_requested_at, v_error_code, v_error_message
  from public.ai_external_analysis_jobs as job
  where job.id = p_job_id;

  if v_status is null
    or v_status <> 'running'
    or v_locked_by is distinct from btrim(coalesce(p_worker_id, '')) then
    return jsonb_build_object(
      'owned', false,
      'cancelRequested', false,
      'status', coalesce(v_status, 'missing')
    );
  end if;

  if v_cancel_requested_at is not null then
    return jsonb_build_object(
      'owned', true,
      'cancelRequested', true,
      'status', v_status,
      'errorCode', coalesce(v_error_code, 'cancelled_by_user'),
      'errorMessage', coalesce(v_error_message, 'The external analysis task was cancelled by the user.')
    );
  end if;

  update public.ai_external_analysis_jobs as job
  set
    locked_at = now(),
    lease_expires_at = now() + make_interval(secs => v_lease_seconds),
    updated_at = now()
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = btrim(coalesce(p_worker_id, ''))
    and job.cancel_requested_at is null;

  return jsonb_build_object(
    'owned', found,
    'cancelRequested', false,
    'status', case when found then 'running' else 'lease_lost' end
  );
end;
$$;

create or replace function public.finalize_external_analysis_job_cancel(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text default 'cancelled_by_user',
  p_error_message text default 'The external analysis task was cancelled by the user.'
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  update public.ai_external_analysis_jobs as job
  set
    status = 'cancelled',
    cancel_requested_at = coalesce(job.cancel_requested_at, now()),
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    next_attempt_at = null,
    last_error_code = coalesce(nullif(btrim(coalesce(p_error_code, '')), ''), 'cancelled_by_user'),
    last_error = coalesce(
      nullif(btrim(coalesce(p_error_message, '')), ''),
      'The external analysis task was cancelled by the user.'
    ),
    completed_at = now(),
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'cancelled',
      'reason', coalesce(nullif(btrim(coalesce(p_error_code, '')), ''), 'cancelled_by_user'),
      'updatedAt', now()
    ),
    updated_at = now()
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = btrim(coalesce(p_worker_id, ''))
  returning job.* into v_job;

  if not found then
    select job.*
    into v_job
    from public.ai_external_analysis_jobs as job
    where job.id = p_job_id
      and job.status = 'cancelled';
  end if;

  if v_job.id is null then
    raise exception 'running external analysis job was not found for this worker' using errcode = 'P0002';
  end if;

  update public.ai_external_analysis_runs as run
  set
    status = 'cancelled',
    error_code = v_job.last_error_code,
    error_message = v_job.last_error,
    progress = coalesce(run.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'cancelled',
      'reason', v_job.last_error_code,
      'updatedAt', now()
    ),
    finished_at = now()
  where run.job_id = v_job.id
    and run.status = 'running';

  return v_job;
end;
$$;

create or replace function public.complete_external_analysis_job(
  p_job_id uuid,
  p_worker_id text,
  p_result jsonb default '{}'::jsonb,
  p_progress jsonb default '{}'::jsonb
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  update public.ai_external_analysis_jobs as job
  set
    status = case when job.cancel_requested_at is null then 'completed' else 'cancelled' end,
    result = case when job.cancel_requested_at is null then coalesce(p_result, '{}'::jsonb) else job.result end,
    progress = coalesce(job.progress, '{}'::jsonb)
      || case when job.cancel_requested_at is null then coalesce(p_progress, '{}'::jsonb) else '{}'::jsonb end
      || jsonb_build_object(
        'stage', case when job.cancel_requested_at is null then 'completed' else 'cancelled' end,
        'updatedAt', now()
      ),
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    next_attempt_at = null,
    last_error = case
      when job.cancel_requested_at is null then null
      else coalesce(job.last_error, 'The external analysis task was cancelled by the user.')
    end,
    last_error_code = case
      when job.cancel_requested_at is null then null
      else coalesce(job.last_error_code, 'cancelled_by_user')
    end,
    completed_at = now(),
    updated_at = now()
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = btrim(coalesce(p_worker_id, ''))
  returning job.* into v_job;

  if not found then
    raise exception 'running external analysis job was not found for this worker' using errcode = 'P0002';
  end if;

  update public.ai_external_analysis_runs as run
  set
    status = case when v_job.status = 'cancelled' then 'cancelled' else 'completed' end,
    progress = coalesce(run.progress, '{}'::jsonb)
      || case when v_job.status = 'completed' then coalesce(p_progress, '{}'::jsonb) else '{}'::jsonb end
      || jsonb_build_object('stage', v_job.status, 'updatedAt', now()),
    error_code = case when v_job.status = 'cancelled' then v_job.last_error_code else null end,
    error_message = case when v_job.status = 'cancelled' then v_job.last_error else null end,
    finished_at = now()
  where run.job_id = v_job.id
    and run.run_number = v_job.attempt_count
    and run.status = 'running';

  return v_job;
end;
$$;

create or replace function public.schedule_external_analysis_job_retry(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_retry_delay_minutes integer default 30,
  p_progress jsonb default '{}'::jsonb
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_retry_minutes integer := greatest(1, least(coalesce(p_retry_delay_minutes, 30), 1440));
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  update public.ai_external_analysis_jobs as job
  set
    status = case when job.cancel_requested_at is null then 'retry_scheduled' else 'cancelled' end,
    retry_count = job.retry_count + case when job.cancel_requested_at is null then 1 else 0 end,
    next_attempt_at = case
      when job.cancel_requested_at is null then now() + make_interval(mins => v_retry_minutes)
      else null
    end,
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    last_error_code = case
      when job.cancel_requested_at is null then nullif(btrim(coalesce(p_error_code, '')), '')
      else coalesce(job.last_error_code, 'cancelled_by_user')
    end,
    last_error = case
      when job.cancel_requested_at is null then nullif(btrim(coalesce(p_error_message, '')), '')
      else coalesce(job.last_error, 'The external analysis task was cancelled by the user.')
    end,
    completed_at = case when job.cancel_requested_at is null then job.completed_at else now() end,
    progress = coalesce(job.progress, '{}'::jsonb)
      || coalesce(p_progress, '{}'::jsonb)
      || jsonb_build_object(
        'stage', case when job.cancel_requested_at is null then 'retry_scheduled' else 'cancelled' end,
        'nextAttemptAt', case
          when job.cancel_requested_at is null then to_jsonb(now() + make_interval(mins => v_retry_minutes))
          else null
        end,
        'updatedAt', now()
      ),
    updated_at = now()
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = btrim(coalesce(p_worker_id, ''))
  returning job.* into v_job;

  if not found then
    raise exception 'running external analysis job was not found for this worker' using errcode = 'P0002';
  end if;

  update public.ai_external_analysis_runs as run
  set
    status = v_job.status,
    error_code = v_job.last_error_code,
    error_message = v_job.last_error,
    progress = coalesce(run.progress, '{}'::jsonb)
      || coalesce(p_progress, '{}'::jsonb)
      || jsonb_build_object('stage', v_job.status, 'updatedAt', now()),
    finished_at = now()
  where run.job_id = v_job.id
    and run.status = 'running';

  return v_job;
end;
$$;

create or replace function public.cancel_stale_external_engineering_jobs(
  p_article_id uuid,
  p_current_signature text default null,
  p_cancel_all boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affected_count integer := 0;
begin
  with affected as (
    update public.ai_external_analysis_jobs as job
    set
      status = case when job.status = 'running' then 'running' else 'cancelled' end,
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      locked_by = case when job.status = 'running' then job.locked_by else null end,
      locked_at = case when job.status = 'running' then job.locked_at else null end,
      lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
      next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
      last_error_code = 'external_readiness_changed',
      last_error = 'The external analysis inputs changed before this command completed.',
      completed_at = case when job.status = 'running' then job.completed_at else now() end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.status = 'running' then 'cancel_requested' else 'cancelled' end,
        'reason', 'external_readiness_changed',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.article_id = p_article_id
      and job.job_type = 'engineering_command'
      and job.origin = 'auto'
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      and (
        coalesce(p_cancel_all, false)
        or job.readiness_signature is distinct from nullif(coalesce(p_current_signature, ''), '')
      )
    returning job.id, job.status
  ), closed_runs as (
    update public.ai_external_analysis_runs as run
    set
      status = 'cancelled',
      error_code = 'external_readiness_changed',
      error_message = 'The external analysis inputs changed before this command completed.',
      progress = coalesce(run.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'cancelled',
        'reason', 'external_readiness_changed',
        'updatedAt', now()
      ),
      finished_at = now()
    from affected
    where run.job_id = affected.id
      and affected.status = 'cancelled'
      and run.status = 'running'
    returning run.id
  )
  select count(*)::integer
  into v_affected_count
  from affected;

  return coalesce(v_affected_count, 0);
end;
$$;

revoke all on function public.request_external_analysis_job_cancel(uuid, uuid) from public;
revoke all on function public.heartbeat_external_analysis_job(uuid, text, integer) from public;
revoke all on function public.finalize_external_analysis_job_cancel(uuid, text, text, text) from public;
revoke all on function public.complete_external_analysis_job(uuid, text, jsonb, jsonb) from public;
revoke all on function public.schedule_external_analysis_job_retry(uuid, text, text, text, integer, jsonb) from public;
revoke all on function public.cancel_stale_external_engineering_jobs(uuid, text, boolean) from public;

grant execute on function public.request_external_analysis_job_cancel(uuid, uuid) to service_role;
grant execute on function public.heartbeat_external_analysis_job(uuid, text, integer) to service_role;
grant execute on function public.finalize_external_analysis_job_cancel(uuid, text, text, text) to service_role;
grant execute on function public.complete_external_analysis_job(uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.schedule_external_analysis_job_retry(uuid, text, text, text, integer, jsonb) to service_role;
grant execute on function public.cancel_stale_external_engineering_jobs(uuid, text, boolean) to service_role;

comment on function public.request_external_analysis_job_cancel(uuid, uuid) is 'Requests cancellation for a job and cancels queued dependent jobs.';
comment on function public.heartbeat_external_analysis_job(uuid, text, integer) is 'Renews a worker lease and reports whether cancellation was requested.';
comment on function public.finalize_external_analysis_job_cancel(uuid, text, text, text) is 'Moves a worker-owned running job to the cancelled terminal state.';
