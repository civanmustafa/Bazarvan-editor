begin;

-- Resume a due automatic-writing retry inside its original session. The queue
-- keeps the failed session terminal during the configured delay so it does not
-- block unrelated manual or automatic work. Once the delay is due, the worker
-- calls this function before claiming a new automation item.
create or replace function public.resume_next_automatic_content_writing_session()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.content_writing_automation_state%rowtype;
  v_item public.content_writing_automation_items%rowtype;
  v_session public.content_writing_sessions%rowtype;
  v_candidate_item_id uuid;
  v_candidate_session_id uuid;
  v_readiness jsonb;
  v_expected_idempotency_key text;
  v_resume_attempt integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('content-writing-automation-claim', 0));

  select state.*
  into v_state
  from public.content_writing_automation_state as state
  where state.singleton is true
  for update;

  if coalesce(v_state.next_allowed_at, now()) > now() then
    return null;
  end if;

  -- Manual writing and the full-article pipeline retain priority.
  if exists (
    select 1
    from public.content_writing_automation_items as active_item
    where active_item.status in ('claiming', 'writing')
  ) or exists (
    select 1
    from public.content_writing_sessions as active_session
    where active_session.execution_mode = 'api'
      and active_session.status in ('queued', 'running', 'retry_scheduled')
  ) or exists (
    select 1
    from public.ai_external_analysis_jobs as active_pipeline
    where active_pipeline.job_type = 'full_article_pipeline'
      and (
        active_pipeline.status in ('queued', 'running')
        or (
          active_pipeline.status = 'retry_scheduled'
          and coalesce(active_pipeline.next_attempt_at, now()) <= now()
        )
      )
  ) then
    return null;
  end if;

  select item.id, session.id
  into v_candidate_item_id, v_candidate_session_id
  from public.content_writing_automation_items as item
  join public.content_writing_sessions as session
    on session.id = item.content_writing_session_id
  where item.status = 'ready'
    and item.eligible_at <= now()
    and item.attempt_count < item.max_attempts
    and session.status = 'failed'
    and session.execution_mode = 'api'
    and session.cancel_requested_at is null
    and coalesce(session.context_snapshot ->> 'triggerSource', '') = 'automatic_ready'
  order by item.eligible_at, item.ready_at, item.id
  limit 1;

  if v_candidate_session_id is null then
    return null;
  end if;

  -- Match the established session -> item lock order used by attach/reconcile.
  select session.*
  into v_session
  from public.content_writing_sessions as session
  where session.id = v_candidate_session_id
  for update;

  select item.*
  into v_item
  from public.content_writing_automation_items as item
  where item.id = v_candidate_item_id
  for update;

  if v_session.id is null
     or v_item.id is null
     or v_item.status <> 'ready'
     or v_item.eligible_at > now()
     or v_item.attempt_count >= v_item.max_attempts
     or v_item.content_writing_session_id is distinct from v_session.id
     or v_session.status <> 'failed'
     or v_session.execution_mode <> 'api'
     or v_session.cancel_requested_at is not null then
    return null;
  end if;

  v_expected_idempotency_key := concat_ws(
    ':',
    'auto-ready',
    v_item.id::text,
    v_item.run_generation::text,
    v_item.session_sequence::text
  );

  -- A same-session retry is safe only while the durable queue identity and the
  -- frozen input signature still describe exactly the same automatic run.
  if v_session.article_id <> v_item.article_id
     or v_session.created_by <> v_item.requested_by
     or v_session.provider <> v_item.provider
     or v_session.idempotency_key <> v_expected_idempotency_key
     or coalesce(v_session.context_snapshot ->> 'triggerSource', '') <> 'automatic_ready'
     or coalesce(v_session.context_snapshot ->> 'automationItemId', '') <> v_item.id::text
     or coalesce(v_session.context_snapshot ->> 'automationRunGeneration', '') <> v_item.run_generation::text
     or coalesce(v_session.context_snapshot ->> 'automationSessionSequence', '') <> v_item.session_sequence::text
     or coalesce(v_session.context_snapshot ->> 'automationReadinessSignature', '') <> v_item.readiness_signature then
    return null;
  end if;

  -- Cancellations and policy/input failures require a fresh evaluation rather
  -- than reviving frozen prompts. Model/provider/output failures remain safe to
  -- resume from their failed step (including malformed JSON responses).
  if lower(coalesce(v_session.last_error_code, '')) ~
       '(cancel|prerequisite|quality|policy|identity|article_changed|editor_not_empty|manual_attention)'
     or not public.article_automatic_job_allowed(v_item.article_id, 'content_writing') then
    return null;
  end if;

  v_readiness := public.evaluate_content_writing_automation_readiness(v_item.article_id);
  if coalesce((v_readiness ->> 'ready')::boolean, false) is not true
     or coalesce(v_readiness ->> 'signature', '') <> v_item.readiness_signature then
    return null;
  end if;

  v_resume_attempt := v_item.attempt_count + 1;

  -- Preserve completed steps and their outputs. Only interrupted/failed work is
  -- made claimable again, which is the same invariant as explicit user resume.
  update public.content_writing_steps as step
  set
    status = 'pending',
    last_error_code = null,
    last_error = null,
    completed_at = null
  where step.session_id = v_session.id
    and step.status in ('running', 'failed');

  update public.content_writing_automation_items as item
  set
    status = 'writing',
    attempt_count = v_resume_attempt,
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    completed_at = null,
    last_error_code = null,
    last_error = null
  where item.id = v_item.id;

  update public.content_writing_sessions as session
  set
    status = 'retry_scheduled',
    next_attempt_at = now(),
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    cancel_requested_at = null,
    completed_at = null,
    last_error_code = null,
    last_error = null,
    progress = coalesce(session.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'retry_scheduled',
      'message', 'Automatic writing will resume from the failed step.',
      'completed', false,
      'resumed', true,
      'automaticResume', true,
      'automaticResumeAttempt', v_resume_attempt,
      'automaticResumeScheduledAt', now()
    ),
    response_metadata = coalesce(session.response_metadata, '{}'::jsonb) || jsonb_build_object(
      'automaticResume', jsonb_build_object(
        'attempt', v_resume_attempt,
        'scheduledAt', now(),
        'previousErrorCode', v_session.last_error_code,
        'previousError', v_session.last_error
      )
    )
  where session.id = v_session.id;

  return v_session.id;
end;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 3;
$$;

revoke all on function public.resume_next_automatic_content_writing_session()
  from public, anon, authenticated;
grant execute on function public.resume_next_automatic_content_writing_session()
  to service_role;

revoke all on function public.content_writing_automation_schema_version()
  from public, anon, authenticated;
grant execute on function public.content_writing_automation_schema_version()
  to service_role;

comment on function public.resume_next_automatic_content_writing_session() is
  'Resumes one due automatic writing failure in its original session when the frozen inputs and policy are unchanged.';

notify pgrst, 'reload schema';

commit;
