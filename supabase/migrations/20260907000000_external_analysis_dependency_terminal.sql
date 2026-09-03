begin;

-- A terminal prerequisite must not leave its descendants looking runnable.
-- Propagate one edge at a time; the row trigger recursively handles the rest
-- of a sequential engineering batch without a deployment-wide queue scan.
create or replace function public.propagate_external_analysis_dependency_terminal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status is not distinct from new.status
    or new.status not in ('failed', 'blocked', 'cancelled') then
    return new;
  end if;

  update public.ai_external_analysis_jobs as child
  set
    status = case
      when child.status = 'running' then child.status
      when child.cancel_requested_at is not null or new.status = 'cancelled' then 'cancelled'
      else 'blocked'
    end,
    cancel_requested_at = case
      when child.status = 'running' then coalesce(child.cancel_requested_at, now())
      else child.cancel_requested_at
    end,
    next_attempt_at = case when child.status = 'running' then child.next_attempt_at else null end,
    locked_by = case when child.status = 'running' then child.locked_by else null end,
    locked_at = case when child.status = 'running' then child.locked_at else null end,
    lease_expires_at = case when child.status = 'running' then child.lease_expires_at else null end,
    last_error_code = case
      when new.status = 'cancelled' then 'external_analysis_dependency_cancelled'
      else 'external_analysis_dependency_terminal'
    end,
    last_error = left(
      'Required external-analysis job ' || new.id::text || ' ended with status ' || new.status || '.',
      2000
    ),
    completed_at = case when child.status = 'running' then child.completed_at else now() end,
    dead_lettered_at = case
      when child.status = 'running' or child.cancel_requested_at is not null or new.status = 'cancelled'
        then null
      else coalesce(child.dead_lettered_at, now())
    end,
    dead_letter_reason = case
      when child.status = 'running' or child.cancel_requested_at is not null or new.status = 'cancelled'
        then null
      else 'external_analysis_dependency_terminal'
    end,
    progress = coalesce(child.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', case
        when child.status = 'running' then 'cancel_requested'
        when child.cancel_requested_at is not null or new.status = 'cancelled' then 'cancelled'
        else 'blocked'
      end,
      'reason', case
        when new.status = 'cancelled' then 'external_analysis_dependency_cancelled'
        else 'external_analysis_dependency_terminal'
      end,
      'dependencyJobId', new.id,
      'dependencyStatus', new.status,
      'dependencyErrorCode', coalesce(new.last_error_code, new.dead_letter_reason),
      'updatedAt', now()
    ),
    updated_at = now()
  where child.depends_on_job_id = new.id
    and child.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    );

  return new;
end;
$$;

drop trigger if exists propagate_external_analysis_dependency_terminal
  on public.ai_external_analysis_jobs;
create trigger propagate_external_analysis_dependency_terminal
after update of status
on public.ai_external_analysis_jobs
for each row execute function public.propagate_external_analysis_dependency_terminal();

-- Reconcile descendants that were already stranded before the trigger existed.
update public.ai_external_analysis_jobs as child
set
  status = case
    when child.status = 'running' then child.status
    when child.cancel_requested_at is not null or dependency.status = 'cancelled' then 'cancelled'
    else 'blocked'
  end,
  cancel_requested_at = case
    when child.status = 'running' then coalesce(child.cancel_requested_at, now())
    else child.cancel_requested_at
  end,
  next_attempt_at = case when child.status = 'running' then child.next_attempt_at else null end,
  locked_by = case when child.status = 'running' then child.locked_by else null end,
  locked_at = case when child.status = 'running' then child.locked_at else null end,
  lease_expires_at = case when child.status = 'running' then child.lease_expires_at else null end,
  last_error_code = case
    when dependency.status = 'cancelled' then 'external_analysis_dependency_cancelled'
    else 'external_analysis_dependency_terminal'
  end,
  last_error = left(
    'Required external-analysis job ' || dependency.id::text
      || ' ended with status ' || dependency.status || '.',
    2000
  ),
  completed_at = case when child.status = 'running' then child.completed_at else now() end,
  dead_lettered_at = case
    when child.status = 'running'
      or child.cancel_requested_at is not null
      or dependency.status = 'cancelled' then null
    else coalesce(child.dead_lettered_at, now())
  end,
  dead_letter_reason = case
    when child.status = 'running'
      or child.cancel_requested_at is not null
      or dependency.status = 'cancelled' then null
    else 'external_analysis_dependency_terminal'
  end,
  progress = coalesce(child.progress, '{}'::jsonb) || jsonb_build_object(
    'stage', case
      when child.status = 'running' then 'cancel_requested'
      when child.cancel_requested_at is not null or dependency.status = 'cancelled' then 'cancelled'
      else 'blocked'
    end,
    'reason', case
      when dependency.status = 'cancelled' then 'external_analysis_dependency_cancelled'
      else 'external_analysis_dependency_terminal'
    end,
    'dependencyJobId', dependency.id,
    'dependencyStatus', dependency.status,
    'dependencyErrorCode', coalesce(dependency.last_error_code, dependency.dead_letter_reason),
    'updatedAt', now()
  ),
  updated_at = now()
from public.ai_external_analysis_jobs as dependency
where child.depends_on_job_id = dependency.id
  and dependency.status in ('failed', 'blocked', 'cancelled')
  and child.status in (
    'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
  );

revoke all on function public.propagate_external_analysis_dependency_terminal()
  from public, anon, authenticated;
grant execute on function public.propagate_external_analysis_dependency_terminal()
  to service_role;

notify pgrst, 'reload schema';
commit;
