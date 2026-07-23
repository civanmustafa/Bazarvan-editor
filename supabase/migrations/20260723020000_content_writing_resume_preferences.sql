begin;

alter table public.content_writing_sessions
  add column if not exists resume_preference_version smallint not null default 1;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'content_writing_sessions_resume_preference_version_check'
      and conrelid = 'public.content_writing_sessions'::regclass
  ) then
    alter table public.content_writing_sessions
      add constraint content_writing_sessions_resume_preference_version_check
      check (resume_preference_version = 1);
  end if;
end;
$$;

create or replace function public.resume_content_writing_session(
  p_session_id uuid,
  p_requested_by uuid,
  p_provider text,
  p_model text,
  p_input_hash text,
  p_allow_model_fallback boolean
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
        session.context_snapshot,
        '{allowModelFallback}',
        to_jsonb(v_provider = 'gemini' and coalesce(p_allow_model_fallback, false)),
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
        'message', 'Content writing session queued to resume with the user-selected provider and model.',
        'completed', false,
        'resumed', true,
        'provider', v_provider,
        'model', v_model,
        'previousProvider', v_session.provider,
        'previousModel', v_session.model,
        'resumeSelectionChanged', (
          v_session.provider <> v_provider
          or v_session.model <> v_model
        )
      )
  where session.id = v_session.id
  returning session.*;
end;
$$;

revoke all on function public.resume_content_writing_session(
  uuid, uuid, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.resume_content_writing_session(
  uuid, uuid, text, text, text, boolean
) to service_role;

comment on function public.resume_content_writing_session(
  uuid, uuid, text, text, text, boolean
) is
  'Resumes unfinished content-writing steps with the user-selected provider and preferred model while preserving completed steps.';

commit;
