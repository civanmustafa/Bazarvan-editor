begin;

create table if not exists public.content_writing_steps (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.content_writing_sessions(id) on delete cascade,
  step_key text not null,
  step_type text not null
    check (step_type in ('outline', 'section', 'introduction', 'conclusion', 'faq', 'final_review')),
  ordinal integer not null check (ordinal between 1 and 200),
  title text not null check (char_length(title) between 1 and 500),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  prompt_text text not null default '',
  output_text text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, step_key),
  unique (session_id, ordinal),
  constraint content_writing_step_key_format check (
    step_key ~ '^[a-z0-9:_-]{2,120}$'
  )
);

create index if not exists content_writing_steps_session_ordinal_idx
  on public.content_writing_steps(session_id, ordinal);
create index if not exists content_writing_steps_session_status_idx
  on public.content_writing_steps(session_id, status, ordinal);

drop trigger if exists set_content_writing_steps_updated_at on public.content_writing_steps;
create trigger set_content_writing_steps_updated_at
before update on public.content_writing_steps
for each row execute function public.set_updated_at();

alter table public.content_writing_steps enable row level security;

drop policy if exists "content_writing_steps_select_owner_or_admin" on public.content_writing_steps;
create policy "content_writing_steps_select_owner_or_admin"
on public.content_writing_steps
for select
to authenticated
using (
  exists (
    select 1
    from public.content_writing_sessions as session
    where session.id = content_writing_steps.session_id
      and (session.created_by = auth.uid() or public.is_admin())
  )
);

revoke all on public.content_writing_steps from public, anon, authenticated;
grant select on public.content_writing_steps to authenticated;
grant all on public.content_writing_steps to service_role;

create or replace function public.ensure_content_writing_step(
  p_session_id uuid,
  p_worker_id text,
  p_step_key text,
  p_step_type text,
  p_ordinal integer,
  p_title text,
  p_metadata jsonb default '{}'::jsonb
)
returns setof public.content_writing_steps
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_step_key is null or p_step_key !~ '^[a-z0-9:_-]{2,120}$' then
    raise exception 'A valid content writing step key is required.' using errcode = '22023';
  end if;
  if p_step_type not in ('outline', 'section', 'introduction', 'conclusion', 'faq', 'final_review') then
    raise exception 'Unsupported content writing step type.' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.content_writing_sessions as session
    where session.id = p_session_id
      and session.status = 'running'
      and session.locked_by = left(coalesce(p_worker_id, ''), 200)
      and session.cancel_requested_at is null
  ) then
    return;
  end if;

  return query
  insert into public.content_writing_steps as step (
    session_id,
    step_key,
    step_type,
    ordinal,
    title,
    metadata
  ) values (
    p_session_id,
    p_step_key,
    p_step_type,
    greatest(1, least(coalesce(p_ordinal, 1), 200)),
    left(coalesce(nullif(btrim(p_title), ''), p_step_key), 500),
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (session_id, step_key) do update
  set step_type = case when step.status = 'completed' then step.step_type else excluded.step_type end,
      ordinal = case when step.status = 'completed' then step.ordinal else excluded.ordinal end,
      title = case when step.status = 'completed' then step.title else excluded.title end,
      metadata = case when step.status = 'completed' then step.metadata else step.metadata || excluded.metadata end
  returning step.*;
end;
$$;

create or replace function public.start_content_writing_step(
  p_session_id uuid,
  p_worker_id text,
  p_step_key text,
  p_prompt_text text
)
returns setof public.content_writing_steps
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.content_writing_steps as step
  set status = 'running',
      prompt_text = coalesce(p_prompt_text, ''),
      output_text = null,
      attempt_count = step.attempt_count + 1,
      last_error_code = null,
      last_error = null,
      started_at = now(),
      completed_at = null
  where step.session_id = p_session_id
    and step.step_key = p_step_key
    and step.status <> 'completed'
    and exists (
      select 1
      from public.content_writing_sessions as session
      where session.id = p_session_id
        and session.status = 'running'
        and session.locked_by = left(coalesce(p_worker_id, ''), 200)
        and session.cancel_requested_at is null
    )
  returning step.*;
end;
$$;

create or replace function public.complete_content_writing_step(
  p_session_id uuid,
  p_worker_id text,
  p_step_key text,
  p_output_text text,
  p_metadata jsonb default '{}'::jsonb
)
returns setof public.content_writing_steps
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(btrim(coalesce(p_output_text, '')), '') is null then
    raise exception 'Content writing step output cannot be empty.' using errcode = '22023';
  end if;

  return query
  update public.content_writing_steps as step
  set status = 'completed',
      output_text = p_output_text,
      metadata = step.metadata || coalesce(p_metadata, '{}'::jsonb),
      last_error_code = null,
      last_error = null,
      completed_at = now()
  where step.session_id = p_session_id
    and step.step_key = p_step_key
    and step.status = 'running'
    and exists (
      select 1
      from public.content_writing_sessions as session
      where session.id = p_session_id
        and session.status = 'running'
        and session.locked_by = left(coalesce(p_worker_id, ''), 200)
        and session.cancel_requested_at is null
    )
  returning step.*;
end;
$$;

create or replace function public.fail_content_writing_step(
  p_session_id uuid,
  p_worker_id text,
  p_step_key text,
  p_error_code text,
  p_error_message text,
  p_output_text text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns setof public.content_writing_steps
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.content_writing_steps as step
  set status = 'failed',
      output_text = nullif(p_output_text, ''),
      metadata = step.metadata || coalesce(p_metadata, '{}'::jsonb),
      last_error_code = left(coalesce(p_error_code, 'content_writing_step_failed'), 120),
      last_error = left(coalesce(p_error_message, ''), 4000),
      completed_at = now()
  where step.session_id = p_session_id
    and step.step_key = p_step_key
    and step.status = 'running'
    and exists (
      select 1
      from public.content_writing_sessions as session
      where session.id = p_session_id
        and session.status = 'running'
        and session.locked_by = left(coalesce(p_worker_id, ''), 200)
    )
  returning step.*;
end;
$$;

create or replace function public.resume_content_writing_session(
  p_session_id uuid,
  p_requested_by uuid
)
returns setof public.content_writing_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.content_writing_sessions%rowtype;
  v_is_admin boolean := false;
begin
  select coalesce(profile.role = 'admin'::public.app_role, false)
  into v_is_admin
  from public.profiles as profile
  where profile.id = p_requested_by
    and profile.is_active is true;

  select * into v_session
  from public.content_writing_sessions
  where id = p_session_id
  for update;

  if not found
     or (v_session.created_by <> p_requested_by and not v_is_admin)
     or v_session.status not in ('failed', 'cancelled') then
    return;
  end if;

  update public.content_writing_steps
  set status = 'pending',
      last_error_code = null,
      last_error = null,
      completed_at = null
  where session_id = v_session.id
    and status in ('running', 'failed');

  return query
  update public.content_writing_sessions as session
  set status = 'queued',
      next_attempt_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      cancel_requested_at = null,
      completed_at = null,
      last_error_code = null,
      last_error = null,
      progress = session.progress || jsonb_build_object(
        'stage', 'queued',
        'message', 'Content writing session queued to resume from its last completed step.',
        'completed', false,
        'resumed', true
      )
  where session.id = v_session.id
  returning session.*;
end;
$$;

revoke all on function public.ensure_content_writing_step(uuid, text, text, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.start_content_writing_step(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.complete_content_writing_step(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fail_content_writing_step(uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.resume_content_writing_session(uuid, uuid) from public, anon, authenticated;

grant execute on function public.ensure_content_writing_step(uuid, text, text, text, integer, text, jsonb) to service_role;
grant execute on function public.start_content_writing_step(uuid, text, text, text) to service_role;
grant execute on function public.complete_content_writing_step(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.fail_content_writing_step(uuid, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.resume_content_writing_session(uuid, uuid) to service_role;

commit;
