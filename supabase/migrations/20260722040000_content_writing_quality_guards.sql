begin;

alter table public.content_writing_sessions
  add column if not exists quality_guard_version smallint not null default 1;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'content_writing_sessions_quality_guard_version_check'
      and conrelid = 'public.content_writing_sessions'::regclass
  ) then
    alter table public.content_writing_sessions
      add constraint content_writing_sessions_quality_guard_version_check
      check (quality_guard_version = 1);
  end if;
end;
$$;

comment on column public.content_writing_sessions.quality_guard_version is
  'Confirms that atomic active-session quality guards are installed.';

-- Preserve the most relevant active session before enforcing the invariant.
with ranked_active_sessions as (
  select
    session.id,
    row_number() over (
      partition by session.article_id, session.created_by, session.provider
      order by
        case session.status
          when 'running' then 0
          when 'queued' then 1
          else 2
        end,
        session.created_at,
        session.id
    ) as active_rank
  from public.content_writing_sessions as session
  where session.execution_mode = 'api'
    and session.status in ('queued', 'running', 'retry_scheduled')
), duplicate_active_sessions as (
  select id
  from ranked_active_sessions
  where active_rank > 1
)
update public.content_writing_sessions as session
set status = 'cancelled',
    cancel_requested_at = coalesce(session.cancel_requested_at, now()),
    completed_at = coalesce(session.completed_at, now()),
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    last_error_code = coalesce(session.last_error_code, 'duplicate_active_session_closed'),
    last_error = coalesce(
      session.last_error,
      'A duplicate active content writing session was closed while enabling quality guards.'
    ),
    progress = session.progress || jsonb_build_object(
      'stage', 'cancelled',
      'message', 'Duplicate active content writing session closed.',
      'completed', true,
      'qualityGuard', true
    )
from duplicate_active_sessions as duplicate
where session.id = duplicate.id;

create unique index if not exists content_writing_sessions_one_active_api_idx
  on public.content_writing_sessions(article_id, created_by, provider)
  where execution_mode = 'api'
    and status in ('queued', 'running', 'retry_scheduled');

create or replace function public.create_content_writing_session(
  p_article_id uuid,
  p_created_by uuid,
  p_provider text,
  p_model text,
  p_idempotency_key text,
  p_template_registry_version integer,
  p_estimated_input_tokens integer,
  p_max_input_tokens integer,
  p_input_hash text,
  p_context_snapshot jsonb,
  p_messages jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.content_writing_sessions%rowtype;
  v_message jsonb;
  v_sequence integer;
  v_content text;
  v_stage text;
  v_role text;
begin
  if p_article_id is null or p_created_by is null then
    raise exception 'Article and creator are required.' using errcode = '22023';
  end if;
  if p_provider not in ('gemini', 'geminiPaid', 'openai') then
    raise exception 'Unsupported content writing provider.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_model, '')), '') is null then
    raise exception 'A model is required.' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9:_-]{16,160}$' then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;
  if p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'A valid input hash is required.' using errcode = '22023';
  end if;
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) <> 3 then
    raise exception 'Exactly three content writing messages are required.' using errcode = '22023';
  end if;

  -- Keep standard idempotency semantics even after the original session is terminal.
  select * into v_session
  from public.content_writing_sessions as session
  where session.created_by = p_created_by
    and session.idempotency_key = p_idempotency_key;

  if found then
    if v_session.article_id <> p_article_id
       or v_session.provider <> p_provider
       or v_session.input_hash <> p_input_hash then
      raise exception 'The idempotency key belongs to a different content writing request.' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'created', false,
      'reusedActive', false,
      'session', to_jsonb(v_session)
    );
  end if;

  -- Serialize starts for one article/user/provider across tabs and server processes.
  perform pg_advisory_xact_lock(
    hashtextextended(concat_ws(':', p_article_id::text, p_created_by::text, p_provider), 0)
  );

  -- A matching idempotent request may have committed while this call waited for the lock.
  select * into v_session
  from public.content_writing_sessions as session
  where session.created_by = p_created_by
    and session.idempotency_key = p_idempotency_key;

  if found then
    if v_session.article_id <> p_article_id
       or v_session.provider <> p_provider
       or v_session.input_hash <> p_input_hash then
      raise exception 'The idempotency key belongs to a different content writing request.' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'created', false,
      'reusedActive', false,
      'session', to_jsonb(v_session)
    );
  end if;

  select * into v_session
  from public.content_writing_sessions as session
  where session.article_id = p_article_id
    and session.created_by = p_created_by
    and session.provider = p_provider
    and session.execution_mode = 'api'
    and session.status in ('queued', 'running', 'retry_scheduled')
  order by
    case session.status when 'running' then 0 when 'queued' then 1 else 2 end,
    session.created_at
  limit 1
  for update;

  if found then
    return jsonb_build_object(
      'created', false,
      'reusedActive', true,
      'session', to_jsonb(v_session)
    );
  end if;

  insert into public.content_writing_sessions (
    article_id,
    created_by,
    provider,
    model,
    execution_mode,
    idempotency_key,
    template_registry_version,
    estimated_input_tokens,
    max_input_tokens,
    input_hash,
    context_snapshot,
    progress
  ) values (
    p_article_id,
    p_created_by,
    p_provider,
    left(btrim(p_model), 160),
    'api',
    p_idempotency_key,
    greatest(1, coalesce(p_template_registry_version, 1)),
    greatest(0, coalesce(p_estimated_input_tokens, 0)),
    greatest(1, coalesce(p_max_input_tokens, 1)),
    p_input_hash,
    coalesce(p_context_snapshot, '{}'::jsonb),
    jsonb_build_object(
      'stage', 'queued',
      'message', 'Content writing session queued.',
      'completed', false
    )
  )
  returning * into v_session;

  for v_message, v_sequence in
    select item.value, item.ordinality::integer
    from jsonb_array_elements(p_messages) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    v_content := coalesce(v_message->>'content', '');
    if nullif(btrim(v_content), '') is null then
      raise exception 'Content writing messages cannot be empty.' using errcode = '22023';
    end if;
    v_stage := case v_sequence
      when 1 then 'instructions'
      when 2 then 'article_context'
      else 'generation_request'
    end;
    v_role := case when v_sequence = 1 then 'system' else 'user' end;
    insert into public.content_writing_messages (
      session_id,
      sequence_number,
      stage,
      role,
      content
    ) values (
      v_session.id,
      v_sequence,
      v_stage,
      v_role,
      v_content
    );
  end loop;

  return jsonb_build_object(
    'created', true,
    'reusedActive', false,
    'session', to_jsonb(v_session)
  );
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
  where id = p_session_id;

  if not found
     or (v_session.created_by <> p_requested_by and not v_is_admin)
     or v_session.execution_mode <> 'api'
     or v_session.status not in ('failed', 'cancelled') then
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(':', v_session.article_id::text, v_session.created_by::text, v_session.provider),
      0
    )
  );

  -- Acquire locks in the same order as session creation: advisory lock, then row lock.
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
      and active_session.provider = v_session.provider
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

revoke all on function public.create_content_writing_session(
  uuid, uuid, text, text, text, integer, integer, integer, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.create_content_writing_session(
  uuid, uuid, text, text, text, integer, integer, integer, text, jsonb, jsonb
) to service_role;

revoke all on function public.resume_content_writing_session(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resume_content_writing_session(uuid, uuid)
  to service_role;

commit;
