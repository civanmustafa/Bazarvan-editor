begin;

create or replace function public.resume_content_writing_session_v2(
  p_session_id uuid,
  p_requested_by uuid,
  p_provider text,
  p_model text,
  p_input_hash text,
  p_allow_model_fallback boolean,
  p_provider_routing jsonb
)
returns setof public.content_writing_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.content_writing_sessions%rowtype;
  v_is_admin boolean := false;
  v_provider text := nullif(btrim(coalesce(p_provider, '')), '');
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_provider_routing jsonb := coalesce(p_provider_routing, '{"mode":"selected_only"}'::jsonb);
begin
  if v_provider is null or v_provider not in ('gemini', 'geminiPaid', 'openai') then
    raise exception 'A valid content writing provider is required.' using errcode = '22023';
  end if;
  if v_model is null then
    raise exception 'A content writing model is required.' using errcode = '22023';
  end if;
  if p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'A valid input hash is required.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_provider_routing) <> 'object' then
    raise exception 'Provider routing must be a JSON object.' using errcode = '22023';
  end if;

  if v_provider <> 'gemini' then
    v_provider_routing := '{"mode":"selected_only"}'::jsonb;
  elsif v_provider_routing ->> 'mode' = 'free_first' then
    if coalesce(v_provider_routing ->> 'paidFallbackProvider', '') not in ('geminiPaid', 'openai')
       or nullif(btrim(coalesce(v_provider_routing ->> 'paidFallbackModel', '')), '') is null then
      raise exception 'Free-first routing requires a valid paid fallback provider and model.' using errcode = '22023';
    end if;
    v_provider_routing := jsonb_build_object(
      'mode', 'free_first',
      'paidFallbackProvider', v_provider_routing ->> 'paidFallbackProvider',
      'paidFallbackModel', left(btrim(v_provider_routing ->> 'paidFallbackModel'), 256)
    );
  elsif v_provider_routing ->> 'mode' = 'selected_only' then
    v_provider_routing := jsonb_build_object(
      'mode', 'selected_only'
    ) || case
      when v_provider_routing ->> 'unavailablePaidFallbackProvider' in ('geminiPaid', 'openai')
        then jsonb_build_object(
          'unavailablePaidFallbackProvider',
          v_provider_routing ->> 'unavailablePaidFallbackProvider'
        )
      else '{}'::jsonb
    end;
  else
    raise exception 'A valid provider routing mode is required.' using errcode = '22023';
  end if;

  select coalesce(profile.role = 'admin'::public.app_role, false)
  into v_is_admin
  from public.profiles as profile
  where profile.id = p_requested_by
    and profile.is_active is true;

  select * into v_session
  from public.content_writing_sessions
  where id = p_session_id;

  if not found
     or (v_session.created_by <> p_requested_by and not v_is_admin)
     or v_session.execution_mode <> 'api'
     or v_session.status not in ('failed', 'cancelled') then
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(':', v_session.article_id::text, v_session.created_by::text, v_provider),
      0
    )
  );

  select * into v_session
  from public.content_writing_sessions
  where id = p_session_id
  for update;

  if not found
     or (v_session.created_by <> p_requested_by and not v_is_admin)
     or v_session.execution_mode <> 'api'
     or v_session.status not in ('failed', 'cancelled') then
    return;
  end if;

  if exists (
    select 1
    from public.content_writing_sessions as active_session
    where active_session.id <> v_session.id
      and active_session.article_id = v_session.article_id
      and active_session.created_by = v_session.created_by
      and active_session.provider = v_provider
      and active_session.execution_mode = 'api'
      and active_session.status in ('queued', 'running', 'retry_scheduled')
  ) then
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
  set provider = v_provider,
      model = v_model,
      input_hash = p_input_hash,
      context_snapshot = jsonb_set(
        jsonb_set(
          session.context_snapshot,
          '{allowModelFallback}',
          to_jsonb(v_provider = 'gemini' and coalesce(p_allow_model_fallback, false)),
          true
        ),
        '{providerRouting}',
        v_provider_routing,
        true
      ),
      resume_preference_version = 1,
      status = 'queued',
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
        'message', 'Content writing session queued to resume with current provider routing preferences.',
        'completed', false,
        'resumed', true,
        'provider', v_provider,
        'model', v_model,
        'providerRouting', v_provider_routing,
        'previousProvider', v_session.provider,
        'previousModel', v_session.model,
        'resumeSelectionChanged', (
          v_session.provider <> v_provider
          or v_session.model <> v_model
          or coalesce(
            v_session.context_snapshot -> 'providerRouting',
            '{"mode":"selected_only"}'::jsonb
          ) <> v_provider_routing
        )
      )
  where session.id = v_session.id
  returning session.*;
end;
$$;

revoke all on function public.resume_content_writing_session_v2(
  uuid, uuid, text, text, text, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.resume_content_writing_session_v2(
  uuid, uuid, text, text, text, boolean, jsonb
) to service_role;

comment on function public.resume_content_writing_session_v2(
  uuid, uuid, text, text, text, boolean, jsonb
) is
  'Resumes unfinished writing with current free-first paid-provider routing while preserving completed steps.';

notify pgrst, 'reload schema';

commit;
