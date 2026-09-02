begin;

-- Legacy sessions without an origin were created by the manual writing API.
-- Explicit resumes retain their original automation metadata but are manual work.
create or replace function public.content_writing_queue_priority(p_context jsonb, p_progress jsonb)
returns integer
language sql immutable parallel safe
set search_path = public, pg_temp
as $$
  select case when coalesce(nullif(p_context->>'triggerSource', ''), 'manual') = 'manual'
    or p_progress->>'resumed' = 'true' then 1 else 0 end;
$$;

create index if not exists content_writing_sessions_priority_claim_idx
  on public.content_writing_sessions (
    public.content_writing_queue_priority(context_snapshot, progress) desc,
    next_attempt_at, created_at, id
  ) where status in ('queued', 'retry_scheduled', 'running') and cancel_requested_at is null;

create or replace function public.claim_next_content_writing_session(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns setof public.content_writing_sessions
language plpgsql security definer
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
    order by public.content_writing_queue_priority(session.context_snapshot, session.progress) desc,
      session.next_attempt_at, session.created_at, session.id
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
        'stage', 'starting', 'message', 'Content writing worker started the session.', 'completed', false
      )
  from candidate
  where session.id = candidate.id
  returning session.*;
end;
$$;

-- Only the authenticated API can query this diagnostic. Return no identity,
-- article title, provider, or content belonging to other queued sessions.
create or replace function public.get_content_writing_queue_state(p_session_ids uuid[], p_requested_by uuid)
returns table (session_id uuid, queue_state jsonb)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if p_requested_by is null or coalesce(cardinality(p_session_ids), 0) > 50 then
    raise exception 'A requester and at most 50 session IDs are required.' using errcode = '22023';
  end if;
  return query
  select session.id, jsonb_build_object(
    'priority', case when public.content_writing_queue_priority(session.context_snapshot, session.progress) = 1
      then 'manual' else 'standard' end,
    'nextAttemptAt', session.next_attempt_at,
    'observedAt', now(),
    'reason', case
      when session.cancel_requested_at is not null then 'cancelling'
      when session.status = 'running' then 'running'
      when session.next_attempt_at > now() then 'retry_delay'
      when exists (
        select 1 from public.content_writing_sessions active
        where active.status = 'running' and active.lease_expires_at >= now()
      ) then 'worker_busy'
      when exists (
        select 1 from public.content_writing_sessions ahead
        where ahead.id <> session.id and ahead.cancel_requested_at is null
          and ((ahead.status in ('queued', 'retry_scheduled') and ahead.next_attempt_at <= now())
            or (ahead.status = 'running' and ahead.lease_expires_at < now()))
          and (
            -public.content_writing_queue_priority(ahead.context_snapshot, ahead.progress),
            ahead.next_attempt_at, ahead.created_at, ahead.id
          ) < (
            -public.content_writing_queue_priority(session.context_snapshot, session.progress),
            session.next_attempt_at, session.created_at, session.id
          )
      ) then 'earlier_requests'
      else 'awaiting_worker'
    end
  )
  from public.content_writing_sessions session
  where session.id = any(p_session_ids)
    and session.status in ('queued', 'retry_scheduled', 'running')
    and coalesce(public.article_access_level_for_user(session.article_id, p_requested_by), 'none')
      in ('read', 'write', 'admin');
end;
$$;

revoke all on function public.content_writing_queue_priority(jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.get_content_writing_queue_state(uuid[],uuid) from public, anon, authenticated;
revoke all on function public.claim_next_content_writing_session(text,integer) from public, anon, authenticated;
grant execute on function public.content_writing_queue_priority(jsonb,jsonb) to service_role;
grant execute on function public.get_content_writing_queue_state(uuid[],uuid) to service_role;
grant execute on function public.claim_next_content_writing_session(text,integer) to service_role;

notify pgrst, 'reload schema';
commit;
