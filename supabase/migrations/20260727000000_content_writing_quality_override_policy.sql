begin;

create or replace function public.record_content_writing_application(
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
  v_override_reason_required boolean := true;
  v_quality_score numeric := null;
  v_quality_minimum numeric := null;
begin
  select exists (
    select 1
    from public.profiles as profile
    where profile.id = p_applied_by
      and profile.is_active is true
      and profile.role = 'admin'::public.app_role
  ) into v_is_admin;

  select case
    when jsonb_typeof(setting.value->'contentWritingQualityOverrideReasonRequired') = 'boolean'
      then (setting.value->>'contentWritingQualityOverrideReasonRequired')::boolean
    else true
  end
  into v_override_reason_required
  from public.app_settings as setting
  where setting.key = 'ai';

  v_override_reason_required := coalesce(v_override_reason_required, true);

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

  if jsonb_typeof(v_session.quality_report->'score') = 'number'
     and jsonb_typeof(v_session.quality_report->'minimumScore') = 'number' then
    v_quality_score := (v_session.quality_report->>'score')::numeric;
    v_quality_minimum := (v_session.quality_report->>'minimumScore')::numeric;
    v_quality_passed := v_quality_score >= v_quality_minimum;
  elsif v_session.quality_report->>'passed' in ('true', 'false') then
    v_quality_passed := (v_session.quality_report->>'passed')::boolean;
  end if;

  if not v_quality_passed
     and v_override_reason_required
     and char_length(coalesce(v_override_reason, '')) < 8 then
    return;
  end if;

  return query
  update public.content_writing_sessions as session
  set applied_at = now(),
      applied_by = p_applied_by,
      application_count = session.application_count + 1,
      quality_override_reason = case
        when not v_quality_passed then left(v_override_reason, 500)
        else session.quality_override_reason
      end,
      quality_override_by = case
        when not v_quality_passed then p_applied_by
        else session.quality_override_by
      end,
      quality_override_at = case
        when not v_quality_passed then now()
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
