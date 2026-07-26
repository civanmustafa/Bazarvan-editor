begin;

-- Automatic retries keep their administrator-defined schedule. This RPC only
-- lets an authorized application request move one scheduled job to "now".
-- The per-competitor map cache is intentionally untouched, so the worker
-- resumes at the first competitor whose validated map is not already stored.
create or replace function public.resume_external_analysis_job_now(
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
begin
  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.id = p_job_id
  for update;

  if v_job.id is null then
    raise exception 'external analysis job % was not found', p_job_id;
  end if;

  if v_job.status in ('completed', 'running', 'queued', 'waiting_for_prerequisites', 'paused') then
    return v_job;
  end if;

  if v_job.status <> 'retry_scheduled' then
    raise exception 'external analysis job % cannot resume from status %', v_job.id, v_job.status;
  end if;

  update public.ai_external_analysis_jobs as job
  set
    requested_by = coalesce(p_requested_by, job.requested_by),
    status = 'queued',
    next_attempt_at = now(),
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    cancel_requested_at = null,
    last_error = null,
    last_error_code = null,
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'queued',
      'source', 'manual_resume',
      'resumedJobId', job.id,
      'resumedAt', now(),
      'updatedAt', now()
    ),
    updated_at = now()
  where job.id = v_job.id
  returning job.* into v_job;

  return v_job;
end;
$$;

revoke all on function public.resume_external_analysis_job_now(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resume_external_analysis_job_now(uuid, uuid) to service_role;

comment on function public.resume_external_analysis_job_now(uuid, uuid) is
  'Moves one retry-scheduled external analysis job to the ready queue without deleting its saved per-competitor progress.';

commit;
