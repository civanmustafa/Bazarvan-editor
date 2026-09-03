begin;

-- A schedulable job must never retain terminal dead-letter metadata. Several
-- controlled enqueue paths correctly moved a terminal row back to the queue,
-- but the stale marker kept the claim RPC from ever selecting that row.
create or replace function public.normalize_external_analysis_requeue_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in (
    'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
  ) then
    new.dead_lettered_at := null;
    new.dead_letter_reason := null;

    if tg_op = 'UPDATE'
      and old.status in ('completed', 'failed', 'blocked', 'cancelled') then
      new.completed_at := null;
      new.locked_by := null;
      new.locked_at := null;
      new.lease_expires_at := null;
      new.max_attempts := greatest(new.max_attempts, new.attempt_count + 1);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists normalize_external_analysis_requeue_state
  on public.ai_external_analysis_jobs;
create trigger normalize_external_analysis_requeue_state
before insert or update
on public.ai_external_analysis_jobs
for each row execute function public.normalize_external_analysis_requeue_state();

-- Repair already-schedulable rows. Cancellation requests remain untouched, so
-- this does not revive anything the user has asked to cancel.
update public.ai_external_analysis_jobs as job
set
  dead_lettered_at = null,
  dead_letter_reason = null,
  max_attempts = case
    when job.cancel_requested_at is null
      and (
        job.origin <> 'auto'
        or job.pipeline_parent_job_id is not null
        or public.article_automatic_job_allowed(job.article_id, job.job_type, job.command_id)
      )
      then greatest(job.max_attempts, job.attempt_count + 1)
    else job.max_attempts
  end,
  next_attempt_at = case
    when job.cancel_requested_at is null
      and job.status in ('queued', 'retry_scheduled')
      and (
        job.origin <> 'auto'
        or job.pipeline_parent_job_id is not null
        or public.article_automatic_job_allowed(job.article_id, job.job_type, job.command_id)
      )
      then now()
    else job.next_attempt_at
  end,
  completed_at = case when job.cancel_requested_at is null then null else job.completed_at end,
  last_error = case
    when job.cancel_requested_at is null
      and job.last_error_code = 'external_analysis_attempt_budget_exhausted' then null
    else job.last_error
  end,
  last_error_code = case
    when job.cancel_requested_at is null
      and job.last_error_code = 'external_analysis_attempt_budget_exhausted' then null
    else job.last_error_code
  end,
  progress = case
    when job.cancel_requested_at is null then coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', job.status,
      'requeueRepair', true,
      'requeueRepairReason', 'stale_dead_letter_marker',
      'updatedAt', now()
    )
    else job.progress
  end,
  updated_at = now()
where job.status in (
    'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
  )
  and job.dead_lettered_at is not null;

-- A live descendant cannot advance while its same-article dependency remains
-- dead-lettered. Retry only attempt-budget failures that are still allowed by
-- the article's automation policy; other terminal failures remain untouched.
update public.ai_external_analysis_jobs as dependency
set
  status = 'queued',
  result = null,
  progress = coalesce(dependency.progress, '{}'::jsonb) || jsonb_build_object(
    'stage', 'queued',
    'requeueRepair', true,
    'requeueRepairReason', 'live_descendant_waiting_on_exhausted_dependency',
    'updatedAt', now()
  ),
  last_error = null,
  last_error_code = null,
  max_attempts = greatest(dependency.max_attempts, dependency.attempt_count + 1),
  next_attempt_at = now(),
  locked_by = null,
  locked_at = null,
  lease_expires_at = null,
  completed_at = null,
  dead_lettered_at = null,
  dead_letter_reason = null,
  updated_at = now()
where dependency.status in ('failed', 'blocked')
  and dependency.cancel_requested_at is null
  and dependency.dead_lettered_at is not null
  and coalesce(dependency.dead_letter_reason, dependency.last_error_code)
    = 'external_analysis_attempt_budget_exhausted'
  and (
    dependency.depends_on_job_id is null
    or exists (
      select 1
      from public.ai_external_analysis_jobs as parent
      where parent.id = dependency.depends_on_job_id
        and parent.status = 'completed'
    )
  )
  and (
    dependency.origin <> 'auto'
    or dependency.pipeline_parent_job_id is not null
    or public.article_automatic_job_allowed(
      dependency.article_id, dependency.job_type, dependency.command_id
    )
  )
  and exists (
    select 1
    from public.ai_external_analysis_jobs as child
    where child.depends_on_job_id = dependency.id
      and child.article_id = dependency.article_id
      and child.cancel_requested_at is null
      and child.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      )
  );

alter table public.ai_external_analysis_jobs
  drop constraint if exists ai_external_analysis_jobs_schedulable_not_dead;
alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_schedulable_not_dead check (
    dead_lettered_at is null
    or status in ('completed', 'failed', 'blocked', 'cancelled')
  ) not valid;
alter table public.ai_external_analysis_jobs
  validate constraint ai_external_analysis_jobs_schedulable_not_dead;

revoke all on function public.normalize_external_analysis_requeue_state()
  from public, anon, authenticated;
grant execute on function public.normalize_external_analysis_requeue_state()
  to service_role;

notify pgrst, 'reload schema';
commit;
