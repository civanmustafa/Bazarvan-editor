begin;

alter table public.content_writing_steps
  drop constraint if exists content_writing_steps_step_type_check;
alter table public.content_writing_steps
  add constraint content_writing_steps_step_type_check
  check (
    step_type in (
      'competitor_index',
      'outline',
      'section',
      'introduction',
      'conclusion',
      'faq',
      'coverage_audit',
      'section_repair',
      'final_review',
      'quality_repair'
    )
  );

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
  if p_step_type not in (
    'competitor_index',
    'outline',
    'section',
    'introduction',
    'conclusion',
    'faq',
    'coverage_audit',
    'section_repair',
    'final_review',
    'quality_repair'
  ) then
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

commit;
