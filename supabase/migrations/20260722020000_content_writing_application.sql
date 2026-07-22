begin;

alter table public.content_writing_sessions
  add column if not exists applied_at timestamptz,
  add column if not exists applied_by uuid references public.profiles(id) on delete set null,
  add column if not exists application_count integer not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'content_writing_sessions_application_count_check'
      and conrelid = 'public.content_writing_sessions'::regclass
  ) then
    alter table public.content_writing_sessions
      add constraint content_writing_sessions_application_count_check
      check (application_count >= 0);
  end if;
end;
$$;

create index if not exists content_writing_sessions_applied_idx
  on public.content_writing_sessions(applied_at desc)
  where applied_at is not null;

comment on column public.content_writing_sessions.applied_at is
  'Most recent time the completed generated result was explicitly inserted and saved in its article.';
comment on column public.content_writing_sessions.applied_by is
  'Authenticated user who most recently inserted the completed result.';
comment on column public.content_writing_sessions.application_count is
  'Number of explicit successful insertions recorded for this completed result.';

create or replace function public.record_content_writing_application(
  p_session_id uuid,
  p_applied_by uuid
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
  select exists (
    select 1
    from public.profiles as profile
    where profile.id = p_applied_by
      and profile.is_active is true
      and profile.role = 'admin'::public.app_role
  ) into v_is_admin;

  select * into v_session
  from public.content_writing_sessions
  where id = p_session_id
  for update;

  if not found
     or v_session.status <> 'completed'
     or nullif(btrim(coalesce(v_session.result_text, '')), '') is null
     or (v_session.created_by <> p_applied_by and not v_is_admin) then
    return;
  end if;

  return query
  update public.content_writing_sessions as session
  set applied_at = now(),
      applied_by = p_applied_by,
      application_count = session.application_count + 1
  where session.id = v_session.id
  returning session.*;
end;
$$;

revoke all on function public.record_content_writing_application(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.record_content_writing_application(uuid, uuid)
  to service_role;

commit;
