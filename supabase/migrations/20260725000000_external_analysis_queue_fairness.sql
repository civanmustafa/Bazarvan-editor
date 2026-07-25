-- Prevent a future retry for one article from blocking ready work for every other article.

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
    and job.cancel_requested_at is null
    and (
      (
        job.status = 'running'
        and job.lease_expires_at is not null
        and job.lease_expires_at > now()
      )
      or (
        (
          job.status = 'queued'
          or (
            job.status = 'retry_scheduled'
            and coalesce(job.next_attempt_at, now()) <= now()
          )
        )
        and (
          job.depends_on_job_id is null
          or exists (
            select 1
            from public.ai_external_analysis_jobs as dependency
            where dependency.id = job.depends_on_job_id
              and dependency.status = 'completed'
          )
        )
      )
    )
  group by job.article_id
  order by
    bool_or(
      job.status = 'running'
      and job.lease_expires_at is not null
      and job.lease_expires_at > now()
    ) desc,
    bool_or(coalesce(job.progress->>'articleQueueLocked', 'false') = 'true') desc,
    min(
      case
        when job.status = 'queued'
          or (
            job.status = 'retry_scheduled'
            and coalesce(job.next_attempt_at, now()) <= now()
          )
        then coalesce(job.next_attempt_at, job.created_at)
        else job.created_at
      end
    ),
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

revoke all on function public.claim_next_external_analysis_job(text, text[], integer) from public;
grant execute on function public.claim_next_external_analysis_job(text, text[], integer) to service_role;

comment on function public.claim_next_external_analysis_job(text, text[], integer)
is 'Claims ready external analysis work without allowing a future retry or an unmet dependency to block other articles.';
