begin;

alter table public.content_writing_sessions
  add column if not exists quality_policy_version integer not null default 1,
  add column if not exists quality_score integer,
  add column if not exists quality_report jsonb not null default '{}'::jsonb,
  add column if not exists quality_repair_count integer not null default 0,
  add column if not exists quality_override_reason text,
  add column if not exists quality_override_by uuid references public.profiles(id) on delete set null,
  add column if not exists quality_override_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'content_writing_sessions_quality_policy_version_check'
      and conrelid = 'public.content_writing_sessions'::regclass
  ) then
    alter table public.content_writing_sessions
      add constraint content_writing_sessions_quality_policy_version_check
      check (quality_policy_version > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'content_writing_sessions_quality_score_check'
      and conrelid = 'public.content_writing_sessions'::regclass
  ) then
    alter table public.content_writing_sessions
      add constraint content_writing_sessions_quality_score_check
      check (quality_score is null or quality_score between 0 and 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'content_writing_sessions_quality_repair_count_check'
      and conrelid = 'public.content_writing_sessions'::regclass
  ) then
    alter table public.content_writing_sessions
      add constraint content_writing_sessions_quality_repair_count_check
      check (quality_repair_count between 0 and 20);
  end if;
end;
$$;

comment on column public.content_writing_sessions.quality_policy_version is
  'Immutable content quality policy version captured when the session starts.';
comment on column public.content_writing_sessions.quality_score is
  'Most recent deterministic quality score from 0 to 100.';
comment on column public.content_writing_sessions.quality_report is
  'Compact deterministic criteria report for review and audit.';
comment on column public.content_writing_sessions.quality_repair_count is
  'Number of model repair passes used before the final quality decision.';

create or replace function public.sync_content_writing_quality_metadata()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_policy_version text;
  v_score text;
  v_repair_count text;
begin
  v_policy_version := new.context_snapshot->>'qualityPolicyVersion';
  if v_policy_version ~ '^\d+$' then
    new.quality_policy_version := greatest(1, least(v_policy_version::integer, 1000000));
  end if;

  if jsonb_typeof(new.response_metadata->'qualityReport') = 'object' then
    new.quality_report := new.response_metadata->'qualityReport';
    v_score := new.quality_report->>'score';
    v_repair_count := new.quality_report->>'repairPasses';
    if v_score ~ '^\d+$' then
      new.quality_score := greatest(0, least(v_score::integer, 100));
    end if;
    if v_repair_count ~ '^\d+$' then
      new.quality_repair_count := greatest(0, least(v_repair_count::integer, 20));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_content_writing_quality_metadata on public.content_writing_sessions;
create trigger sync_content_writing_quality_metadata
before insert or update of context_snapshot, response_metadata
on public.content_writing_sessions
for each row execute function public.sync_content_writing_quality_metadata();

update public.content_writing_sessions
set context_snapshot = context_snapshot,
    response_metadata = response_metadata;

alter table public.content_writing_steps
  drop constraint if exists content_writing_steps_step_type_check;
alter table public.content_writing_steps
  add constraint content_writing_steps_step_type_check
  check (step_type in ('outline', 'section', 'introduction', 'conclusion', 'faq', 'final_review', 'quality_repair'));

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
  if p_step_type not in ('outline', 'section', 'introduction', 'conclusion', 'faq', 'final_review', 'quality_repair') then
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
    session_id, step_key, step_type, ordinal, title, metadata
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

revoke all on function public.ensure_content_writing_step(uuid, text, text, text, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ensure_content_writing_step(uuid, text, text, text, integer, text, jsonb)
  to service_role;

drop function if exists public.record_content_writing_application(uuid, uuid);
create function public.record_content_writing_application(
  p_session_id uuid,
  p_applied_by uuid,
  p_quality_override_reason text default null
)
returns setof public.content_writing_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.content_writing_sessions%rowtype;
  v_is_admin boolean := false;
  v_quality_passed boolean := true;
  v_override_reason text := nullif(btrim(coalesce(p_quality_override_reason, '')), '');
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

  if v_session.quality_report->>'passed' in ('true', 'false') then
    v_quality_passed := (v_session.quality_report->>'passed')::boolean;
  end if;

  if not v_quality_passed then
    if not v_is_admin or char_length(coalesce(v_override_reason, '')) < 8 then
      return;
    end if;
  elsif v_override_reason is not null and not v_is_admin then
    return;
  end if;

  return query
  update public.content_writing_sessions as session
  set applied_at = now(),
      applied_by = p_applied_by,
      application_count = session.application_count + 1,
      quality_override_reason = case
        when v_override_reason is not null then left(v_override_reason, 500)
        else session.quality_override_reason
      end,
      quality_override_by = case
        when v_override_reason is not null then p_applied_by
        else session.quality_override_by
      end,
      quality_override_at = case
        when v_override_reason is not null then now()
        else session.quality_override_at
      end
  where session.id = v_session.id
  returning session.*;
end;
$$;

revoke all on function public.record_content_writing_application(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_content_writing_application(uuid, uuid, text)
  to service_role;

commit;
