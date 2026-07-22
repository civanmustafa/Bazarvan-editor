begin;

alter table public.content_writing_sessions
  add column if not exists execution_mode text not null default 'api';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'content_writing_sessions_execution_mode_check'
      and conrelid = 'public.content_writing_sessions'::regclass
  ) then
    alter table public.content_writing_sessions
      add constraint content_writing_sessions_execution_mode_check
      check (execution_mode in ('api', 'external'));
  end if;
end;
$$;

create index if not exists content_writing_sessions_mode_created_idx
  on public.content_writing_sessions(execution_mode, created_at desc);

comment on column public.content_writing_sessions.execution_mode is
  'Execution surface: server API worker or a user-operated external AI conversation.';

create or replace function public.record_external_content_writing_result(
  p_article_id uuid,
  p_created_by uuid,
  p_external_provider text,
  p_idempotency_key text,
  p_template_registry_version integer,
  p_estimated_input_tokens integer,
  p_max_input_tokens integer,
  p_input_hash text,
  p_context_snapshot jsonb,
  p_messages jsonb,
  p_result_text text
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
  v_provider text;
  v_model text;
begin
  if p_article_id is null or p_created_by is null then
    raise exception 'Article and creator are required.' using errcode = '22023';
  end if;
  if p_external_provider not in ('chatgpt', 'gemini') then
    raise exception 'Unsupported external content writing provider.' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9:_-]{16,160}$' then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;
  if p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'A valid input hash is required.' using errcode = '22023';
  end if;
  if p_context_snapshot is null or jsonb_typeof(p_context_snapshot) <> 'object' then
    raise exception 'A valid context snapshot is required.' using errcode = '22023';
  end if;
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) <> 3 then
    raise exception 'Exactly three content writing messages are required.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_result_text, '')), '') is null then
    raise exception 'The external writing result cannot be empty.' using errcode = '22023';
  end if;
  if char_length(p_result_text) > 1000000 then
    raise exception 'The external writing result is too large.' using errcode = '22001';
  end if;

  v_provider := case when p_external_provider = 'chatgpt' then 'openai' else 'gemini' end;
  v_model := case when p_external_provider = 'chatgpt' then 'chatgpt-web' else 'gemini-web' end;

  insert into public.content_writing_sessions (
    article_id,
    created_by,
    provider,
    model,
    status,
    execution_mode,
    idempotency_key,
    template_registry_version,
    estimated_input_tokens,
    max_input_tokens,
    input_hash,
    context_snapshot,
    progress,
    result_text,
    response_metadata,
    attempt_count,
    started_at,
    completed_at
  ) values (
    p_article_id,
    p_created_by,
    v_provider,
    v_model,
    'completed',
    'external',
    p_idempotency_key,
    greatest(1, coalesce(p_template_registry_version, 1)),
    greatest(0, coalesce(p_estimated_input_tokens, 0)),
    greatest(1, coalesce(p_max_input_tokens, 1)),
    p_input_hash,
    p_context_snapshot || jsonb_build_object(
      'executionMode', 'external',
      'externalProvider', p_external_provider
    ),
    jsonb_build_object(
      'stage', 'completed',
      'message', 'External content writing result imported.',
      'completed', true
    ),
    p_result_text,
    jsonb_build_object(
      'executionMode', 'external',
      'externalProvider', p_external_provider
    ),
    1,
    now(),
    now()
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
      insert into public.content_writing_messages (
        session_id,
        sequence_number,
        stage,
        role,
        content
      ) values (
        v_session.id,
        v_sequence,
        case v_sequence when 1 then 'instructions' when 2 then 'article_context' else 'generation_request' end,
        case when v_sequence = 1 then 'system' else 'user' end,
        v_content
      );
    end loop;

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
    );
  else
    select * into v_session
    from public.content_writing_sessions as session
    where session.created_by = p_created_by
      and session.idempotency_key = p_idempotency_key;

    if not found then
      raise exception 'Could not resolve the idempotent external content writing session.';
    end if;
    if v_session.article_id <> p_article_id
       or v_session.execution_mode <> 'external'
       or v_session.provider <> v_provider
       or v_session.input_hash <> p_input_hash
       or v_session.result_text is distinct from p_result_text
       or v_session.response_metadata->>'externalProvider' is distinct from p_external_provider then
      raise exception 'The idempotency key belongs to a different external writing result.' using errcode = '22023';
    end if;
  end if;

  return jsonb_build_object('created', v_created, 'session', to_jsonb(v_session));
end;
$$;

revoke all on function public.record_external_content_writing_result(
  uuid, uuid, text, text, integer, integer, integer, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_external_content_writing_result(
  uuid, uuid, text, text, integer, integer, integer, text, jsonb, jsonb, text
) to service_role;

commit;
