begin;

create table if not exists public.content_writing_sessions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('gemini', 'geminiPaid', 'openai')),
  model text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'retry_scheduled', 'completed', 'failed', 'cancelled')),
  idempotency_key text not null,
  template_registry_version integer not null default 1 check (template_registry_version > 0),
  estimated_input_tokens integer not null default 0 check (estimated_input_tokens >= 0),
  max_input_tokens integer not null check (max_input_tokens > 0),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  context_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(context_snapshot) = 'object'),
  progress jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object'),
  result_text text,
  conversation_id text,
  key_suffix text,
  response_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(response_metadata) = 'object'),
  last_error_code text,
  last_error text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (created_by, idempotency_key),
  constraint content_writing_idempotency_key_format check (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,160}$'
  )
);

create table if not exists public.content_writing_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.content_writing_sessions(id) on delete cascade,
  sequence_number smallint not null check (sequence_number between 1 and 4),
  stage text not null check (stage in ('instructions', 'article_context', 'generation_request', 'assistant_result')),
  role text not null check (role in ('system', 'user', 'assistant')),
  content text not null check (char_length(content) > 0),
  created_at timestamptz not null default now(),
  unique (session_id, sequence_number),
  unique (session_id, stage)
);

create index if not exists content_writing_sessions_claim_idx
  on public.content_writing_sessions(status, next_attempt_at, created_at)
  where status in ('queued', 'retry_scheduled', 'running');
create index if not exists content_writing_sessions_article_created_idx
  on public.content_writing_sessions(article_id, created_at desc);
create index if not exists content_writing_sessions_creator_created_idx
  on public.content_writing_sessions(created_by, created_at desc);
create index if not exists content_writing_messages_session_sequence_idx
  on public.content_writing_messages(session_id, sequence_number);

drop trigger if exists set_content_writing_sessions_updated_at on public.content_writing_sessions;
create trigger set_content_writing_sessions_updated_at
before update on public.content_writing_sessions
for each row execute function public.set_updated_at();

alter table public.content_writing_sessions enable row level security;
alter table public.content_writing_messages enable row level security;

drop policy if exists "content_writing_sessions_select_owner_or_admin" on public.content_writing_sessions;
create policy "content_writing_sessions_select_owner_or_admin"
on public.content_writing_sessions
for select
to authenticated
using (created_by = auth.uid() or public.is_admin());

drop policy if exists "content_writing_messages_select_owner_or_admin" on public.content_writing_messages;
create policy "content_writing_messages_select_owner_or_admin"
on public.content_writing_messages
for select
to authenticated
using (
  exists (
    select 1
    from public.content_writing_sessions as session
    where session.id = content_writing_messages.session_id
      and (session.created_by = auth.uid() or public.is_admin())
  )
);

revoke all on public.content_writing_sessions from public, anon, authenticated;
revoke all on public.content_writing_messages from public, anon, authenticated;
grant select on public.content_writing_sessions to authenticated;
grant select on public.content_writing_messages to authenticated;
grant all on public.content_writing_sessions to service_role;
grant all on public.content_writing_messages to service_role;

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
  v_created boolean := false;
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

  insert into public.content_writing_sessions (
    article_id,
    created_by,
    provider,
    model,
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
  on conflict (created_by, idempotency_key) do nothing
  returning * into v_session;

  if found then
    v_created := true;
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
  else
    select * into v_session
    from public.content_writing_sessions as session
    where session.created_by = p_created_by
      and session.idempotency_key = p_idempotency_key;

    if not found then
      raise exception 'Could not resolve the idempotent content writing session.';
    end if;
    if v_session.article_id <> p_article_id
       or v_session.provider <> p_provider
       or v_session.input_hash <> p_input_hash then
      raise exception 'The idempotency key belongs to a different content writing request.' using errcode = '22023';
    end if;
  end if;

  return jsonb_build_object('created', v_created, 'session', to_jsonb(v_session));
end;
$$;

create or replace function public.claim_next_content_writing_session(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns setof public.content_writing_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select session.id
    from public.content_writing_sessions as session
    where session.cancel_requested_at is null
      and (
        (session.status in ('queued', 'retry_scheduled') and session.next_attempt_at <= now())
        or (session.status = 'running' and session.lease_expires_at < now())
      )
    order by session.next_attempt_at, session.created_at
    for update skip locked
    limit 1
  )
  update public.content_writing_sessions as session
  set status = 'running',
      locked_by = left(coalesce(p_worker_id, ''), 200),
      locked_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 900), 3600))),
      attempt_count = session.attempt_count + 1,
      started_at = coalesce(session.started_at, now()),
      last_error_code = null,
      last_error = null,
      progress = session.progress || jsonb_build_object(
        'stage', 'starting',
        'message', 'Content writing worker started the session.',
        'completed', false
      )
  from candidate
  where session.id = candidate.id
  returning session.*;
end;
$$;

create or replace function public.heartbeat_content_writing_session(
  p_session_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.content_writing_sessions%rowtype;
begin
  select * into v_session
  from public.content_writing_sessions
  where id = p_session_id
  for update;

  if not found then
    return jsonb_build_object('owned', false, 'cancelRequested', false, 'status', 'missing');
  end if;
  if v_session.status <> 'running'
     or v_session.locked_by is distinct from left(coalesce(p_worker_id, ''), 200) then
    return jsonb_build_object(
      'owned', false,
      'cancelRequested', v_session.cancel_requested_at is not null,
      'status', v_session.status
    );
  end if;
  if v_session.cancel_requested_at is null then
    update public.content_writing_sessions
    set lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 900), 3600)))
    where id = p_session_id;
  end if;
  return jsonb_build_object(
    'owned', true,
    'cancelRequested', v_session.cancel_requested_at is not null,
    'status', v_session.status
  );
end;
$$;

create or replace function public.update_content_writing_progress(
  p_session_id uuid,
  p_worker_id text,
  p_progress jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.content_writing_sessions
  set progress = coalesce(p_progress, '{}'::jsonb)
  where id = p_session_id
    and status = 'running'
    and locked_by = left(coalesce(p_worker_id, ''), 200)
    and cancel_requested_at is null;
  return found;
end;
$$;

create or replace function public.complete_content_writing_session(
  p_session_id uuid,
  p_worker_id text,
  p_result_text text,
  p_model text,
  p_conversation_id text,
  p_key_suffix text,
  p_response_metadata jsonb,
  p_progress jsonb
)
returns setof public.content_writing_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.content_writing_sessions%rowtype;
begin
  update public.content_writing_sessions as session
  set status = case when session.cancel_requested_at is null then 'completed' else 'cancelled' end,
      result_text = case when session.cancel_requested_at is null then p_result_text else null end,
      model = left(coalesce(nullif(btrim(p_model), ''), session.model), 160),
      conversation_id = nullif(left(coalesce(p_conversation_id, ''), 500), ''),
      key_suffix = nullif(left(coalesce(p_key_suffix, ''), 20), ''),
      response_metadata = coalesce(p_response_metadata, '{}'::jsonb),
      progress = coalesce(p_progress, session.progress),
      completed_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      next_attempt_at = now()
  where session.id = p_session_id
    and session.status = 'running'
    and session.locked_by = left(coalesce(p_worker_id, ''), 200)
  returning session.* into v_session;

  if not found then
    return;
  end if;

  if v_session.status = 'completed' then
    insert into public.content_writing_messages (
      session_id,
      sequence_number,
      stage,
      role,
      content
    ) values (
      v_session.id,
      4,
      'assistant_result',
      'assistant',
      p_result_text
    )
    on conflict (session_id, sequence_number) do update
      set content = excluded.content;
  end if;

  return next v_session;
end;
$$;

create or replace function public.fail_content_writing_session(
  p_session_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_response_metadata jsonb,
  p_progress jsonb
)
returns setof public.content_writing_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.content_writing_sessions as session
  set status = case when session.cancel_requested_at is null then 'failed' else 'cancelled' end,
      last_error_code = left(coalesce(p_error_code, 'content_writing_failed'), 120),
      last_error = left(coalesce(p_error_message, ''), 4000),
      response_metadata = coalesce(p_response_metadata, '{}'::jsonb),
      progress = coalesce(p_progress, session.progress),
      completed_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      next_attempt_at = now()
  where session.id = p_session_id
    and session.status = 'running'
    and session.locked_by = left(coalesce(p_worker_id, ''), 200)
  returning session.*;
end;
$$;

create or replace function public.request_content_writing_session_cancel(
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

  if not found or (v_session.created_by <> p_requested_by and not v_is_admin) then
    return;
  end if;

  return query
  update public.content_writing_sessions as session
  set status = case
        when session.status in ('queued', 'retry_scheduled') then 'cancelled'
        else session.status
      end,
      cancel_requested_at = coalesce(session.cancel_requested_at, now()),
      completed_at = case
        when session.status in ('queued', 'retry_scheduled') then now()
        else session.completed_at
      end,
      progress = session.progress || jsonb_build_object(
        'stage', 'cancelled',
        'message', 'Content writing cancellation requested.',
        'completed', session.status in ('queued', 'retry_scheduled')
      )
  where session.id = v_session.id
    and session.status not in ('completed', 'failed', 'cancelled')
  returning session.*;
end;
$$;

revoke all on function public.create_content_writing_session(uuid, uuid, text, text, text, integer, integer, integer, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.claim_next_content_writing_session(text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_content_writing_session(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.update_content_writing_progress(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.complete_content_writing_session(uuid, text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_content_writing_session(uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.request_content_writing_session_cancel(uuid, uuid) from public, anon, authenticated;

grant execute on function public.create_content_writing_session(uuid, uuid, text, text, text, integer, integer, integer, text, jsonb, jsonb) to service_role;
grant execute on function public.claim_next_content_writing_session(text, integer) to service_role;
grant execute on function public.heartbeat_content_writing_session(uuid, text, integer) to service_role;
grant execute on function public.update_content_writing_progress(uuid, text, jsonb) to service_role;
grant execute on function public.complete_content_writing_session(uuid, text, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_content_writing_session(uuid, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.request_content_writing_session_cancel(uuid, uuid) to service_role;

commit;
