begin;

create index if not exists ai_external_analysis_jobs_dependency_idx
  on public.ai_external_analysis_jobs(depends_on_job_id)
  where depends_on_job_id is not null;

-- The parent-status trigger handles a dependency that becomes terminal after
-- its children exist. This complementary child-side guard handles the inverse:
-- a child inserted, rewired, or requeued after its dependency is already
-- terminal must never look schedulable.
create or replace function public.enforce_external_analysis_dependency_on_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dependency public.ai_external_analysis_jobs%rowtype;
begin
  if new.depends_on_job_id is null
     or new.status not in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused') then
    return new;
  end if;

  select dependency.* into v_dependency
  from public.ai_external_analysis_jobs as dependency
  where dependency.id = new.depends_on_job_id;

  if v_dependency.id is null
     or v_dependency.status not in ('failed', 'blocked', 'cancelled') then
    return new;
  end if;

  if new.status = 'running' then
    new.cancel_requested_at := coalesce(new.cancel_requested_at, now());
  else
    new.status := case when v_dependency.status = 'cancelled' then 'cancelled' else 'blocked' end;
    new.next_attempt_at := null;
    new.locked_by := null;
    new.locked_at := null;
    new.lease_expires_at := null;
    new.completed_at := now();
  end if;

  new.last_error_code := case
    when v_dependency.status = 'cancelled' then 'external_analysis_dependency_cancelled'
    else 'external_analysis_dependency_terminal'
  end;
  new.last_error := format(
    'Dependency %s reached terminal status %s before this job could run.',
    v_dependency.id,
    v_dependency.status
  );
  new.progress := coalesce(new.progress, '{}'::jsonb) || jsonb_build_object(
    'stage', case when new.status = 'running' then 'cancelling' else new.status end,
    'dependencyJobId', v_dependency.id,
    'dependencyStatus', v_dependency.status,
    'dependencyErrorCode', coalesce(v_dependency.last_error_code, v_dependency.dead_letter_reason),
    'updatedAt', now()
  );
  return new;
end;
$$;

drop trigger if exists enforce_external_analysis_dependency_on_child
  on public.ai_external_analysis_jobs;
create trigger enforce_external_analysis_dependency_on_child
before insert or update of status, depends_on_job_id
on public.ai_external_analysis_jobs
for each row execute function public.enforce_external_analysis_dependency_on_child();

-- Repair children that predate this guard. The existing parent-side trigger
-- cannot see them because the parent status is no longer transitioning.
update public.ai_external_analysis_jobs as child
set
  status = case
    when child.status = 'running' then child.status
    when dependency.status = 'cancelled' then 'cancelled'
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
  completed_at = case when child.status = 'running' then child.completed_at else now() end,
  last_error_code = case
    when dependency.status = 'cancelled' then 'external_analysis_dependency_cancelled'
    else 'external_analysis_dependency_terminal'
  end,
  last_error = format(
    'Dependency %s reached terminal status %s before this job could run.',
    dependency.id,
    dependency.status
  ),
  progress = coalesce(child.progress, '{}'::jsonb) || jsonb_build_object(
    'stage', case
      when child.status = 'running' then 'cancelling'
      when dependency.status = 'cancelled' then 'cancelled'
      else 'blocked'
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
  and child.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');

revoke all on function public.enforce_external_analysis_dependency_on_child()
  from public, anon, authenticated;
grant execute on function public.enforce_external_analysis_dependency_on_child()
  to service_role;

notify pgrst, 'reload schema';
commit;
