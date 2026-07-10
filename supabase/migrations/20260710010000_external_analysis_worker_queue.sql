-- External analysis phase 2: atomic queue claiming, lease renewal, and recovery.

create or replace function public.claim_next_external_analysis_job(
  p_worker_id text,
  p_supported_job_types text[],
  p_lease_seconds integer default 300
)
returns setof public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 1800));
  v_job_id uuid;
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  if nullif(btrim(coalesce(p_worker_id, '')), '') is null then
    raise exception 'worker id is required' using errcode = '22023';
  end if;

  if coalesce(cardinality(p_supported_job_types), 0) = 0 then
    return;
  end if;

  select job.id
  into v_job_id
  from public.ai_external_analysis_jobs as job
  where job.job_type = any(p_supported_job_types)
    and (
      job.status = 'queued'
      or (
        job.status = 'retry_scheduled'
        and coalesce(job.next_attempt_at, now()) <= now()
      )
    )
    and job.cancel_requested_at is null
    and (
      job.depends_on_job_id is null
      or exists (
        select 1
        from public.ai_external_analysis_jobs as dependency
        where dependency.id = job.depends_on_job_id
          and dependency.status = 'completed'
      )
    )
  order by
    coalesce(job.next_attempt_at, job.created_at),
    job.sequence_number,
    job.created_at
  limit 1
  for update skip locked;

  if v_job_id is null then
    return;
  end if;

  update public.ai_external_analysis_jobs as job
  set
    status = 'running',
    attempt_count = job.attempt_count + 1,
    next_attempt_at = null,
    locked_by = btrim(p_worker_id),
    locked_at = now(),
    lease_expires_at = now() + make_interval(secs => v_lease_seconds),
    started_at = coalesce(job.started_at, now()),
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'running',
      'workerId', btrim(p_worker_id),
      'updatedAt', now()
    ),
    updated_at = now()
  where job.id = v_job_id
  returning job.* into v_job;

  insert into public.ai_external_analysis_runs (
    job_id,
    run_number,
    status,
    progress
  ) values (
    v_job.id,
    v_job.attempt_count,
    'running',
    v_job.progress
  )
  on conflict (job_id, run_number) do update
  set
    status = 'running',
    progress = excluded.progress,
    error_code = null,
    error_message = null,
    finished_at = null;

  return next v_job;
end;
$$;

create or replace function public.renew_external_analysis_job_lease(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 1800));
begin
  update public.ai_external_analysis_jobs as job
  set
    locked_at = now(),
    lease_expires_at = now() + make_interval(secs => v_lease_seconds),
    updated_at = now()
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = btrim(coalesce(p_worker_id, ''));

  return found;
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
    status = 'retry_scheduled',
    retry_count = job.retry_count + 1,
    next_attempt_at = now() + make_interval(mins => v_retry_minutes),
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    last_error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
    last_error = nullif(btrim(coalesce(p_error_message, '')), ''),
    progress = coalesce(job.progress, '{}'::jsonb)
      || coalesce(p_progress, '{}'::jsonb)
      || jsonb_build_object(
        'stage', 'retry_scheduled',
        'nextAttemptAt', now() + make_interval(mins => v_retry_minutes),
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
    status = 'retry_scheduled',
    error_code = v_job.last_error_code,
    error_message = v_job.last_error,
    progress = coalesce(run.progress, '{}'::jsonb) || coalesce(p_progress, '{}'::jsonb),
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
    status = 'completed',
    result = coalesce(p_result, '{}'::jsonb),
    progress = coalesce(job.progress, '{}'::jsonb)
      || coalesce(p_progress, '{}'::jsonb)
      || jsonb_build_object(
        'stage', 'completed',
        'updatedAt', now()
      ),
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    last_error = null,
    last_error_code = null,
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
    status = 'completed',
    progress = coalesce(run.progress, '{}'::jsonb) || coalesce(p_progress, '{}'::jsonb),
    error_code = null,
    error_message = null,
    finished_at = now()
  where run.job_id = v_job.id
    and run.run_number = v_job.attempt_count
    and run.status = 'running';

  return v_job;
end;
$$;

create or replace function public.recover_stale_external_analysis_jobs(
  p_retry_delay_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_retry_minutes integer := greatest(1, least(coalesce(p_retry_delay_minutes, 30), 1440));
  v_recovered_count integer := 0;
begin
  with recovered as (
    update public.ai_external_analysis_jobs as job
    set
      status = case
        when job.cancel_requested_at is not null then 'cancelled'
        else 'retry_scheduled'
      end,
      retry_count = job.retry_count + case when job.cancel_requested_at is null then 1 else 0 end,
      next_attempt_at = case
        when job.cancel_requested_at is not null then null
        else now() + make_interval(mins => v_retry_minutes)
      end,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      last_error_code = case
        when job.cancel_requested_at is not null then job.last_error_code
        else 'worker_lease_expired'
      end,
      last_error = case
        when job.cancel_requested_at is not null then job.last_error
        else 'The worker lease expired before the job reached a terminal state.'
      end,
      completed_at = case
        when job.cancel_requested_at is not null then now()
        else job.completed_at
      end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.cancel_requested_at is not null then 'cancelled' else 'retry_scheduled' end,
        'nextAttemptAt', case
          when job.cancel_requested_at is not null then null
          else to_jsonb(now() + make_interval(mins => v_retry_minutes))
        end,
        'updatedAt', now()
      ),
      updated_at = now()
    where job.status = 'running'
      and job.lease_expires_at is not null
      and job.lease_expires_at <= now()
    returning job.id, job.status, job.last_error_code, job.last_error
  ), updated_runs as (
    update public.ai_external_analysis_runs as run
    set
      status = recovered.status,
      error_code = recovered.last_error_code,
      error_message = recovered.last_error,
      finished_at = now()
    from recovered
    where run.job_id = recovered.id
      and run.status = 'running'
    returning run.id
  )
  select count(*)::integer
  into v_recovered_count
  from recovered;

  return coalesce(v_recovered_count, 0);
end;
$$;

revoke all on function public.claim_next_external_analysis_job(text, text[], integer) from public;
revoke all on function public.renew_external_analysis_job_lease(uuid, text, integer) from public;
revoke all on function public.schedule_external_analysis_job_retry(uuid, text, text, text, integer, jsonb) from public;
revoke all on function public.complete_external_analysis_job(uuid, text, jsonb, jsonb) from public;
revoke all on function public.recover_stale_external_analysis_jobs(integer) from public;
grant execute on function public.claim_next_external_analysis_job(text, text[], integer) to service_role;
grant execute on function public.renew_external_analysis_job_lease(uuid, text, integer) to service_role;
grant execute on function public.schedule_external_analysis_job_retry(uuid, text, text, text, integer, jsonb) to service_role;
grant execute on function public.complete_external_analysis_job(uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.recover_stale_external_analysis_jobs(integer) to service_role;

comment on function public.claim_next_external_analysis_job(text, text[], integer) is 'Atomically claims one due external analysis job with SKIP LOCKED.';
comment on function public.renew_external_analysis_job_lease(uuid, text, integer) is 'Extends the lease for a running external analysis job owned by a worker.';
comment on function public.schedule_external_analysis_job_retry(uuid, text, text, text, integer, jsonb) is 'Schedules a transiently failed job for a later retry.';
comment on function public.complete_external_analysis_job(uuid, text, jsonb, jsonb) is 'Completes a running external analysis job owned by a worker.';
comment on function public.recover_stale_external_analysis_jobs(integer) is 'Recovers running jobs whose worker lease expired.';
