-- Global retry timing and strict article-by-article external analysis scheduling.

insert into public.app_settings (key, value, description, is_secret)
values (
  'ai',
  '{"externalAnalysisRetryMinutes": 30}'::jsonb,
  'Non-secret AI defaults. Secret API keys remain server environment variables.',
  false
)
on conflict (key) do nothing;

update public.app_settings
set value = jsonb_set(
  coalesce(value, '{}'::jsonb),
  '{externalAnalysisRetryMinutes}',
  to_jsonb(case
    when coalesce(value->>'externalAnalysisRetryMinutes', '') ~ '^\d+$'
      then greatest(5, least((value->>'externalAnalysisRetryMinutes')::integer, 1440))
    else 30
  end),
  true
)
where key = 'ai';

create or replace function public.get_external_analysis_retry_minutes(
  p_fallback integer default 30
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_value text;
begin
  select setting.value->>'externalAnalysisRetryMinutes'
  into v_value
  from public.app_settings as setting
  where setting.key = 'ai'
    and setting.is_secret is not true
  limit 1;

  if coalesce(v_value, '') ~ '^\d+$' then
    return greatest(5, least(v_value::integer, 1440));
  end if;

  return greatest(5, least(coalesce(p_fallback, 30), 1440));
end;
$$;

create or replace function public.reschedule_external_analysis_retries(
  p_retry_minutes integer default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_retry_minutes integer := greatest(5, least(
    coalesce(p_retry_minutes, public.get_external_analysis_retry_minutes(30)),
    1440
  ));
  v_updated integer := 0;
begin
  update public.ai_external_analysis_jobs as job
  set
    next_attempt_at = greatest(
      now(),
      coalesce(
        case
          when nullif(job.progress->>'retryScheduledAt', '') is not null
            then (job.progress->>'retryScheduledAt')::timestamptz
          else null
        end,
        job.updated_at,
        now()
      ) + make_interval(mins => v_retry_minutes)
    ),
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'retry_scheduled',
      'nextAttemptAt', greatest(
        now(),
        coalesce(
          case
            when nullif(job.progress->>'retryScheduledAt', '') is not null
              then (job.progress->>'retryScheduledAt')::timestamptz
            else null
          end,
          job.updated_at,
          now()
        ) + make_interval(mins => v_retry_minutes)
      ),
      'retryDelayMinutes', v_retry_minutes,
      'updatedAt', now()
    ),
    updated_at = now()
  where job.status = 'retry_scheduled'
    and job.cancel_requested_at is null;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

create or replace function public.apply_external_analysis_retry_setting()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_value text := case when tg_op = 'UPDATE' then old.value->>'externalAnalysisRetryMinutes' else null end;
  v_new_value text := new.value->>'externalAnalysisRetryMinutes';
begin
  if tg_op = 'INSERT' or v_old_value is distinct from v_new_value then
    perform public.reschedule_external_analysis_retries(
      public.get_external_analysis_retry_minutes(30)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists apply_external_analysis_retry_setting on public.app_settings;
create trigger apply_external_analysis_retry_setting
after insert or update of value
on public.app_settings
for each row
when (new.key = 'ai')
execute function public.apply_external_analysis_retry_setting();

select public.reschedule_external_analysis_retries(
  public.get_external_analysis_retry_minutes(30)
);

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
  v_article_id uuid;
  v_job_id uuid;
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  if nullif(btrim(coalesce(p_worker_id, '')), '') is null then
    raise exception 'worker id is required' using errcode = '22023';
  end if;

  if coalesce(cardinality(p_supported_job_types), 0) = 0 then
    return;
  end if;

  select job.article_id
  into v_article_id
  from public.ai_external_analysis_jobs as job
  where job.job_type = any(p_supported_job_types)
    and job.status in ('queued', 'running', 'retry_scheduled')
    and job.cancel_requested_at is null
  group by job.article_id
  order by
    bool_or(job.status = 'running') desc,
    bool_or(coalesce(job.progress->>'articleQueueLocked', 'false') = 'true') desc,
    min(job.created_at),
    job.article_id
  limit 1;

  if v_article_id is null then
    return;
  end if;

  update public.ai_external_analysis_jobs as job
  set
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'articleQueueLocked', true,
      'articleQueueLockedAt', coalesce(job.progress->'articleQueueLockedAt', to_jsonb(now())),
      'updatedAt', now()
    ),
    updated_at = now()
  where job.article_id = v_article_id
    and job.job_type = any(p_supported_job_types)
    and job.status in ('queued', 'running', 'retry_scheduled')
    and job.cancel_requested_at is null
    and coalesce(job.progress->>'articleQueueLocked', 'false') <> 'true';

  select job.id
  into v_job_id
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article_id
    and job.job_type = any(p_supported_job_types)
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
    job.sequence_number,
    coalesce(job.next_attempt_at, job.created_at),
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
      'articleQueueLocked', true,
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
  v_retry_minutes integer := public.get_external_analysis_retry_minutes(p_retry_delay_minutes);
  v_retry_scheduled_at timestamptz := now();
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  update public.ai_external_analysis_jobs as job
  set
    status = case when job.cancel_requested_at is null then 'retry_scheduled' else 'cancelled' end,
    retry_count = job.retry_count + case when job.cancel_requested_at is null then 1 else 0 end,
    next_attempt_at = case
      when job.cancel_requested_at is null then v_retry_scheduled_at + make_interval(mins => v_retry_minutes)
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
        'retryScheduledAt', case when job.cancel_requested_at is null then v_retry_scheduled_at else null end,
        'nextAttemptAt', case
          when job.cancel_requested_at is null then v_retry_scheduled_at + make_interval(mins => v_retry_minutes)
          else null
        end,
        'retryDelayMinutes', case when job.cancel_requested_at is null then v_retry_minutes else null end,
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

create or replace function public.recover_stale_external_analysis_jobs(
  p_retry_delay_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_retry_minutes integer := public.get_external_analysis_retry_minutes(p_retry_delay_minutes);
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
        'retryScheduledAt', case when job.cancel_requested_at is not null then null else now() end,
        'nextAttemptAt', case
          when job.cancel_requested_at is not null then null
          else to_jsonb(now() + make_interval(mins => v_retry_minutes))
        end,
        'retryDelayMinutes', case when job.cancel_requested_at is not null then null else v_retry_minutes end,
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

revoke all on function public.get_external_analysis_retry_minutes(integer) from public;
revoke all on function public.reschedule_external_analysis_retries(integer) from public;
revoke all on function public.apply_external_analysis_retry_setting() from public;
revoke all on function public.claim_next_external_analysis_job(text, text[], integer) from public;
revoke all on function public.schedule_external_analysis_job_retry(uuid, text, text, text, integer, jsonb) from public;
revoke all on function public.recover_stale_external_analysis_jobs(integer) from public;

grant execute on function public.get_external_analysis_retry_minutes(integer) to service_role;
grant execute on function public.reschedule_external_analysis_retries(integer) to service_role;
grant execute on function public.claim_next_external_analysis_job(text, text[], integer) to service_role;
grant execute on function public.schedule_external_analysis_job_retry(uuid, text, text, text, integer, jsonb) to service_role;
grant execute on function public.recover_stale_external_analysis_jobs(integer) to service_role;

comment on function public.get_external_analysis_retry_minutes(integer) is 'Reads the global external analysis retry interval from app_settings.ai.';
comment on function public.claim_next_external_analysis_job(text, text[], integer) is 'Claims work for one article at a time and keeps the global queue locked to that article until its active jobs finish.';
