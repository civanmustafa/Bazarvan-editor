begin;

create table if not exists public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique check (public_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('gemini', 'geminiPaid')),
  model text not null,
  source text not null default 'unknown',
  article_id uuid references public.articles(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'retry_scheduled', 'completed', 'failed', 'cancelled')),
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  telemetry jsonb not null default '{}'::jsonb check (jsonb_typeof(telemetry) = 'object'),
  progress jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object'),
  result_status integer,
  result jsonb,
  last_error text,
  last_error_code text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  retry_count integer not null default 0 check (retry_count >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_job_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_jobs(id) on delete cascade,
  execution_attempt integer not null check (execution_attempt > 0),
  sequence_number integer not null check (sequence_number > 0),
  provider text not null,
  model text not null,
  key_suffix text,
  outcome text not null check (outcome in ('success', 'failed', 'cancelled')),
  status integer,
  reason text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (job_id, execution_attempt, sequence_number)
);

create index if not exists ai_jobs_claim_idx
  on public.ai_jobs(status, next_attempt_at, created_at)
  where status in ('queued', 'retry_scheduled');
create index if not exists ai_jobs_user_created_idx
  on public.ai_jobs(user_id, created_at desc);
create index if not exists ai_jobs_article_created_idx
  on public.ai_jobs(article_id, created_at desc);
create index if not exists ai_jobs_lease_idx
  on public.ai_jobs(status, lease_expires_at)
  where status = 'running';
create index if not exists ai_job_attempts_job_created_idx
  on public.ai_job_attempts(job_id, created_at);

drop trigger if exists set_ai_jobs_updated_at on public.ai_jobs;
create trigger set_ai_jobs_updated_at
before update on public.ai_jobs
for each row execute function public.set_updated_at();

alter table public.ai_jobs enable row level security;
alter table public.ai_job_attempts enable row level security;

drop policy if exists "ai_jobs_select_owner_or_admin" on public.ai_jobs;
create policy "ai_jobs_select_owner_or_admin"
on public.ai_jobs
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "ai_job_attempts_select_owner_or_admin" on public.ai_job_attempts;
create policy "ai_job_attempts_select_owner_or_admin"
on public.ai_job_attempts
for select
to authenticated
using (
  exists (
    select 1
    from public.ai_jobs as job
    where job.id = ai_job_attempts.job_id
      and (job.user_id = auth.uid() or public.is_admin())
  )
);

revoke all on public.ai_jobs from anon;
revoke all on public.ai_job_attempts from anon;
revoke insert, update, delete on public.ai_jobs from authenticated;
revoke insert, update, delete on public.ai_job_attempts from authenticated;
grant select on public.ai_jobs to authenticated;
grant select on public.ai_job_attempts to authenticated;

create or replace function public.claim_next_ai_job(
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns setof public.ai_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select job.id
    from public.ai_jobs as job
    where job.status in ('queued', 'retry_scheduled')
      and job.next_attempt_at <= now()
      and job.cancel_requested_at is null
    order by job.next_attempt_at, job.created_at
    for update skip locked
    limit 1
  )
  update public.ai_jobs as job
  set status = 'running',
      locked_by = left(coalesce(p_worker_id, ''), 200),
      locked_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 300), 1800))),
      attempt_count = job.attempt_count + 1,
      started_at = coalesce(job.started_at, now()),
      last_error = null,
      last_error_code = null
  from candidate
  where job.id = candidate.id
  returning job.*;
end;
$$;

create or replace function public.heartbeat_ai_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_jobs%rowtype;
begin
  select * into v_job from public.ai_jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('owned', false, 'cancelRequested', false, 'status', 'missing');
  end if;
  if v_job.status <> 'running' or v_job.locked_by is distinct from left(coalesce(p_worker_id, ''), 200) then
    return jsonb_build_object(
      'owned', false,
      'cancelRequested', v_job.cancel_requested_at is not null,
      'status', v_job.status
    );
  end if;
  if v_job.cancel_requested_at is null then
    update public.ai_jobs
    set lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 300), 1800)))
    where id = p_job_id;
  end if;
  return jsonb_build_object(
    'owned', true,
    'cancelRequested', v_job.cancel_requested_at is not null,
    'status', v_job.status
  );
end;
$$;

create or replace function public.update_ai_job_progress(
  p_job_id uuid,
  p_worker_id text,
  p_progress jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.ai_jobs
  set progress = coalesce(p_progress, '{}'::jsonb)
  where id = p_job_id
    and status = 'running'
    and locked_by = left(coalesce(p_worker_id, ''), 200)
    and cancel_requested_at is null;
  return found;
end;
$$;

create or replace function public.complete_ai_job(
  p_job_id uuid,
  p_worker_id text,
  p_result_status integer,
  p_result jsonb,
  p_progress jsonb
)
returns setof public.ai_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.ai_jobs as job
  set status = case when job.cancel_requested_at is null then 'completed' else 'cancelled' end,
      result_status = case when job.cancel_requested_at is null then p_result_status else 499 end,
      result = case when job.cancel_requested_at is null then p_result else jsonb_build_object('cancelled', true) end,
      progress = coalesce(p_progress, job.progress),
      completed_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      next_attempt_at = now()
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = left(coalesce(p_worker_id, ''), 200)
  returning job.*;
end;
$$;

create or replace function public.fail_ai_job(
  p_job_id uuid,
  p_worker_id text,
  p_result_status integer,
  p_error_code text,
  p_error_message text,
  p_result jsonb,
  p_progress jsonb
)
returns setof public.ai_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.ai_jobs as job
  set status = case when job.cancel_requested_at is null then 'failed' else 'cancelled' end,
      result_status = case when job.cancel_requested_at is null then p_result_status else 499 end,
      result = coalesce(p_result, jsonb_build_object('error', left(coalesce(p_error_message, ''), 2000))),
      progress = coalesce(p_progress, job.progress),
      last_error_code = left(coalesce(p_error_code, 'ai_job_failed'), 120),
      last_error = left(coalesce(p_error_message, ''), 2000),
      completed_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      next_attempt_at = now()
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = left(coalesce(p_worker_id, ''), 200)
  returning job.*;
end;
$$;

create or replace function public.schedule_ai_job_retry(
  p_job_id uuid,
  p_worker_id text,
  p_result_status integer,
  p_error_code text,
  p_error_message text,
  p_retry_delay_minutes integer,
  p_progress jsonb
)
returns setof public.ai_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.ai_jobs as job
  set status = case when job.cancel_requested_at is null then 'retry_scheduled' else 'cancelled' end,
      result_status = case when job.cancel_requested_at is null then null else 499 end,
      result = case when job.cancel_requested_at is null then null else jsonb_build_object('cancelled', true) end,
      progress = coalesce(p_progress, job.progress),
      last_error_code = left(coalesce(p_error_code, 'ai_job_retry'), 120),
      last_error = left(coalesce(p_error_message, ''), 2000),
      retry_count = job.retry_count + case when job.cancel_requested_at is null then 1 else 0 end,
      next_attempt_at = case
        when job.cancel_requested_at is null
          then now() + make_interval(mins => greatest(1, least(coalesce(p_retry_delay_minutes, 30), 1440)))
        else now()
      end,
      completed_at = case when job.cancel_requested_at is null then null else now() end,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = left(coalesce(p_worker_id, ''), 200)
  returning job.*;
end;
$$;

create or replace function public.request_ai_job_cancel(
  p_public_id text,
  p_user_id uuid
)
returns setof public.ai_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_jobs%rowtype;
begin
  select *
  into v_job
  from public.ai_jobs
  where public_id = p_public_id
    and user_id = p_user_id
  for update;

  if not found then
    return;
  end if;

  if v_job.status in ('queued', 'retry_scheduled') then
    return query
    update public.ai_jobs as job
    set status = 'cancelled',
        cancel_requested_at = coalesce(job.cancel_requested_at, now()),
        result_status = 499,
        result = jsonb_build_object('cancelled', true, 'error', 'AI job cancelled by the user.'),
        progress = job.progress || jsonb_build_object(
          'stage', 'cancelled',
          'completed', true,
          'status', 499,
          'message', 'AI analysis was cancelled by the user.'
        ),
        completed_at = now(),
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        next_attempt_at = now()
    where job.id = v_job.id
    returning job.*;
    return;
  end if;

  if v_job.status = 'running' then
    return query
    update public.ai_jobs as job
    set cancel_requested_at = coalesce(job.cancel_requested_at, now()),
        progress = job.progress || jsonb_build_object(
          'stage', 'cancel_requested',
          'completed', false,
          'message', 'Stopping the active AI request.'
        )
    where job.id = v_job.id
    returning job.*;
    return;
  end if;

  return next v_job;
  return;
end;
$$;

create or replace function public.finalize_ai_job_cancel(
  p_job_id uuid,
  p_worker_id text
)
returns setof public.ai_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.ai_jobs as job
  set status = 'cancelled',
      result_status = 499,
      result = jsonb_build_object('cancelled', true, 'error', 'AI job cancelled by the user.'),
      progress = job.progress || jsonb_build_object(
        'stage', 'cancelled',
        'completed', true,
        'status', 499,
        'message', 'تم إيقاف التحليل يدويًا.'
      ),
      completed_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      next_attempt_at = now()
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = left(coalesce(p_worker_id, ''), 200)
  returning job.*;
end;
$$;

create or replace function public.recover_stale_ai_jobs(
  p_retry_delay_minutes integer default 1
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recovered integer := 0;
  v_cancelled integer := 0;
begin
  update public.ai_jobs
  set status = 'cancelled',
      result_status = 499,
      result = jsonb_build_object('cancelled', true, 'error', 'AI job cancelled while its worker was unavailable.'),
      completed_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null
  where status = 'running'
    and lease_expires_at < now()
    and cancel_requested_at is not null;
  get diagnostics v_cancelled = row_count;

  update public.ai_jobs
  set status = 'retry_scheduled',
      retry_count = retry_count + 1,
      next_attempt_at = now() + make_interval(mins => greatest(1, least(coalesce(p_retry_delay_minutes, 1), 1440))),
      last_error_code = 'stale_worker_recovered',
      last_error = 'The previous worker lease expired; the job was recovered for retry.',
      locked_by = null,
      locked_at = null,
      lease_expires_at = null
  where status = 'running'
    and lease_expires_at < now()
    and cancel_requested_at is null;
  get diagnostics v_recovered = row_count;
  return v_recovered + v_cancelled;
end;
$$;

revoke all on function public.claim_next_ai_job(text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_ai_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.update_ai_job_progress(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.complete_ai_job(uuid, text, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_ai_job(uuid, text, integer, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.schedule_ai_job_retry(uuid, text, integer, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.request_ai_job_cancel(text, uuid) from public, anon, authenticated;
revoke all on function public.finalize_ai_job_cancel(uuid, text) from public, anon, authenticated;
revoke all on function public.recover_stale_ai_jobs(integer) from public, anon, authenticated;

grant execute on function public.claim_next_ai_job(text, integer) to service_role;
grant execute on function public.heartbeat_ai_job(uuid, text, integer) to service_role;
grant execute on function public.update_ai_job_progress(uuid, text, jsonb) to service_role;
grant execute on function public.complete_ai_job(uuid, text, integer, jsonb, jsonb) to service_role;
grant execute on function public.fail_ai_job(uuid, text, integer, text, text, jsonb, jsonb) to service_role;
grant execute on function public.schedule_ai_job_retry(uuid, text, integer, text, text, integer, jsonb) to service_role;
grant execute on function public.request_ai_job_cancel(text, uuid) to service_role;
grant execute on function public.finalize_ai_job_cancel(uuid, text) to service_role;
grant execute on function public.recover_stale_ai_jobs(integer) to service_role;

comment on table public.ai_jobs is
  'Durable interactive AI jobs. API keys are never stored; request payloads are visible only to the owner and admins.';
comment on table public.ai_job_attempts is
  'Per-key/model attempt history for durable AI jobs; stores only safe key suffixes.';

commit;
