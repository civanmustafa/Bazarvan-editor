begin;

-- Keep resolved pauses for diagnosis without allowing an old pause row to
-- block the article forever. This table is server-only and is never exposed
-- directly to browser roles.
create table if not exists public.automatic_article_focus_pause_history (
  id bigint generated always as identity primary key,
  article_id uuid not null references public.articles(id) on delete cascade,
  pause_reason text not null,
  error_code text,
  error_message text,
  blocker_category text not null,
  root_operation_key text,
  resolution_code text not null,
  paused_at timestamptz,
  resolved_at timestamptz not null default now()
);

create index if not exists automatic_article_focus_pause_history_article_idx
  on public.automatic_article_focus_pause_history(article_id, resolved_at desc);

alter table public.automatic_article_focus_pause_history enable row level security;
revoke all on table public.automatic_article_focus_pause_history
  from public, anon, authenticated;
grant select, insert on table public.automatic_article_focus_pause_history
  to service_role;
grant usage, select on sequence public.automatic_article_focus_pause_history_id_seq
  to service_role;

-- Resolve the current meaning of a stored pause from live article data. The
-- stored error remains historical evidence; it is not trusted as proof that
-- the same blocker still exists today.
create or replace function public.automatic_focus_pause_blocker_state(
  p_article_id uuid,
  p_error_code text,
  p_error_message text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_policy jsonb := '{}'::jsonb;
  v_readiness jsonb := '{}'::jsonb;
  v_error text := lower(concat_ws(' ', coalesce(p_error_code, ''), coalesce(p_error_message, '')));
  v_category text := 'permanent';
  v_root_operation text := 'external_analysis';
  v_current boolean := true;
  v_auto_release boolean := false;
  v_resolution text := 'manual_review_required';
  v_semantic_missing boolean := false;
  v_semantic_active boolean := false;
  v_latest_job_type text;
begin
  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null
     or v_article.status not in ('draft', 'content_preparation')
     or public.article_is_globally_trashed(p_article_id) then
    return jsonb_build_object(
      'current', false,
      'category', 'resolved',
      'rootOperationKey', 'article',
      'autoRelease', true,
      'resolutionCode', 'article_left_automation_scope'
    );
  end if;

  v_policy := public.article_automation_policy(p_article_id);
  v_readiness := public.evaluate_content_writing_automation_readiness(p_article_id);

  select job.job_type into v_latest_job_type
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and (
      nullif(btrim(coalesce(p_error_code, '')), '') is null
      or job.last_error_code = p_error_code
      or job.last_error = p_error_message
    )
  order by job.updated_at desc, job.id desc
  limit 1;

  v_root_operation := case v_latest_job_type
    when 'semantic_keywords_lsi' then 'semantic_keywords'
    when 'competitor_discovery' then 'competitor_discovery'
    when 'competitor_extraction' then 'competitor_extraction'
    when 'content_writing_preparation' then 'content_writing'
    when 'full_article_pipeline' then 'content_writing'
    when 'duplicate_cleanup' then 'duplicate_suggestions'
    when 'engineering_command' then 'external_analysis'
    else 'external_analysis'
  end;

  v_semantic_missing :=
    (coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false)
      and not exists (
        select 1 from jsonb_array_elements_text(
          case when jsonb_typeof(v_article.keywords->'secondaries') = 'array'
            then v_article.keywords->'secondaries' else '[]'::jsonb end
        ) as item(value) where nullif(btrim(item.value), '') is not null
      ))
    or (coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false)
      and not exists (
        select 1 from jsonb_array_elements_text(
          case when jsonb_typeof(v_article.keywords->'lsi') = 'array'
            then v_article.keywords->'lsi' else '[]'::jsonb end
        ) as item(value) where nullif(btrim(item.value), '') is not null
      ))
    or (coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false)
      and not public.semantic_keywords_have_google_metadata(v_article.keywords));

  select exists (
    select 1
    from public.ai_external_analysis_jobs as job
    where job.article_id = p_article_id
      and job.job_type = 'semantic_keywords_lsi'
      and job.cancel_requested_at is null
      and job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      )
  ) into v_semantic_active;

  if v_error ~ '(content_research_automation_changed|waiting for every enabled keyword stage)' then
    v_category := 'waiting_prerequisite';
    v_root_operation := 'semantic_keywords';
    v_current := v_semantic_missing or v_semantic_active;
    -- A prerequisite wait must never be a manual-review pause. Releasing the
    -- pause lets the existing coordinator create or resume the missing stage.
    v_auto_release := true;
    v_resolution := case when v_current
      then 'reclassified_as_prerequisite_wait'
      else 'prerequisite_now_satisfied'
    end;
  elsif v_error ~ '(content_writing_no_competitors_found|no suitable competitor|no valid competitor)' then
    v_category := 'permanent';
    v_root_operation := 'competitor_discovery';
    v_current := coalesce((v_readiness->>'usableCompetitorCount')::integer, 0)
      < coalesce((v_readiness->>'minimumCompetitorCount')::integer, 2);
    v_auto_release := not v_current;
    v_resolution := case when v_current
      then 'valid_competitor_required'
      else 'competitor_requirement_now_satisfied'
    end;
  elsif public.automation_failure_is_retryable(p_error_code, p_error_message) then
    v_category := 'transient';
    v_current := true;
    v_auto_release := false;
    v_resolution := 'automatic_recovery_or_manual_resume_required';
  elsif v_error ~ '(prerequisite|missing input|waiting input)' then
    v_category := 'waiting_prerequisite';
    v_current := true;
    v_auto_release := true;
    v_resolution := 'reclassified_as_prerequisite_wait';
  end if;

  return jsonb_build_object(
    'current', v_current,
    'category', v_category,
    'rootOperationKey', v_root_operation,
    'autoRelease', v_auto_release,
    'resolutionCode', v_resolution
  );
end;
$$;

-- Return a claimed job to the prerequisite queue without recording the guard
-- check as an execution attempt. This is deliberately separate from retry and
-- failure RPCs: no provider call has happened yet.
create or replace function public.defer_external_analysis_job_for_prerequisite(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_progress jsonb default '{}'::jsonb
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_running public.ai_external_analysis_jobs%rowtype;
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  select job.* into v_running
  from public.ai_external_analysis_jobs as job
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = btrim(coalesce(p_worker_id, ''))
    and job.cancel_requested_at is null
  for update;

  if v_running.id is null then
    raise exception 'running external analysis job was not found for this worker'
      using errcode = 'P0002';
  end if;

  -- The run represents only the prerequisite guard, not work against Gemini or
  -- another provider. Removing it also prevents a run_number collision after
  -- the attempt counter is refunded.
  delete from public.ai_external_analysis_runs as run
  where run.job_id = v_running.id
    and run.run_number = v_running.attempt_count
    and run.status = 'running';

  update public.ai_external_analysis_jobs as job
  set status = 'waiting_for_prerequisites',
      attempt_count = greatest(0, job.attempt_count - 1),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      next_attempt_at = null,
      started_at = null,
      completed_at = null,
      last_error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
      last_error = left(nullif(btrim(coalesce(p_error_message, '')), ''), 2000),
      progress = (coalesce(job.progress, '{}'::jsonb) - 'reviewRequired')
        || coalesce(p_progress, '{}'::jsonb)
        || jsonb_build_object(
          'stage', 'waiting_for_prerequisites',
          'waitingPrerequisite', true,
          'updatedAt', now()
        ),
      updated_at = now()
  where job.id = v_running.id
  returning * into v_job;

  return v_job;
end;
$$;

-- Wake prerequisite jobs only after their live prerequisite is satisfied. The
-- article-automation-master-engine calls this function; no second coordinator,
-- cron, or timer is introduced.
create or replace function public.resume_satisfied_automatic_prerequisite_jobs(
  p_limit integer default 25
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job record;
  v_state jsonb;
  v_resumed integer := 0;
begin
  for v_job in
    select job.id, job.article_id, job.last_error_code, job.last_error
    from public.ai_external_analysis_jobs as job
    join public.articles as article on article.id = job.article_id
    where job.origin = 'auto'
      and job.status = 'waiting_for_prerequisites'
      and job.cancel_requested_at is null
      and job.last_error_code = 'content_research_automation_changed'
      and article.status in ('draft', 'content_preparation')
      and not public.article_is_globally_trashed(article.id)
    order by job.updated_at, job.id
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    for update of job skip locked
  loop
    v_state := public.automatic_focus_pause_blocker_state(
      v_job.article_id, v_job.last_error_code, v_job.last_error
    );
    if coalesce((v_state->>'current')::boolean, true) then
      continue;
    end if;

    update public.ai_external_analysis_jobs as job
    set status = 'queued',
        next_attempt_at = now(),
        last_error_code = null,
        last_error = null,
        progress = (coalesce(job.progress, '{}'::jsonb)
          - 'blockedBy' - 'waitingPrerequisite' - 'reviewRequired')
          || jsonb_build_object(
            'stage', 'queued',
            'prerequisiteSatisfiedAt', now(),
            'updatedAt', now()
          ),
        updated_at = now()
    where job.id = v_job.id
      and job.status = 'waiting_for_prerequisites';

    if found then
      v_resumed := v_resumed + 1;
    end if;
  end loop;

  if v_resumed > 0 then
    insert into public.worker_queue_signals(queue_name)
    values ('external_analysis')
    on conflict do nothing;
  end if;

  return v_resumed;
end;
$$;

-- Run only inside the already existing automation master. No cron, timer, or
-- second coordinator is introduced.
create or replace function public.release_reclassified_automatic_focus_pauses(
  p_limit integer default 25
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pause record;
  v_state jsonb;
  v_released integer := 0;
begin
  for v_pause in
    select pause.*
    from public.automatic_article_focus_pauses as pause
    join public.articles as article on article.id = pause.article_id
    where pause.reason = 'terminal_stage_failure'
      and article.status in ('draft', 'content_preparation')
      and not public.article_is_globally_trashed(article.id)
    order by pause.paused_at, pause.article_id
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    for update of pause skip locked
  loop
    v_state := public.automatic_focus_pause_blocker_state(
      v_pause.article_id, v_pause.error_code, v_pause.error_message
    );
    if not coalesce((v_state->>'autoRelease')::boolean, false) then
      continue;
    end if;

    insert into public.automatic_article_focus_pause_history(
      article_id, pause_reason, error_code, error_message,
      blocker_category, root_operation_key, resolution_code, paused_at
    ) values (
      v_pause.article_id, v_pause.reason, v_pause.error_code, v_pause.error_message,
      coalesce(v_state->>'category', 'resolved'),
      nullif(v_state->>'rootOperationKey', ''),
      coalesce(v_state->>'resolutionCode', 'current_blocker_resolved'),
      v_pause.paused_at
    );

    delete from public.automatic_article_focus_pauses
    where article_id = v_pause.article_id;
    v_released := v_released + 1;

    update public.automatic_article_focus as focus
    set state = 'idle',
        current_stage = null,
        last_release_reason = coalesce(
          v_state->>'resolutionCode', 'current_blocker_resolved'
        ),
        released_at = now(),
        next_retry_at = null,
        last_error_code = null,
        last_error = null,
        last_progress_at = now(),
        updated_at = now()
    where focus.singleton is true
      and focus.article_id is null
      and focus.last_article_id = v_pause.article_id
      and focus.state = 'needs_attention';
  end loop;

  if v_released > 0 then
    insert into public.worker_queue_signals(queue_name)
    values ('external_analysis'), ('content_writing')
    on conflict do nothing;
    perform public.reconcile_automatic_article_focus();
  end if;

  return v_released;
end;
$$;

do $migration$
declare
  v_definition text;
  v_marker constant text := '  perform public.release_recoverable_automatic_focus_stalls(v_limit);';
begin
  select pg_get_functiondef(
    'public.auto_requeue_recoverable_automation_failures(integer)'::regprocedure
  ) into v_definition;

  if position('resume_satisfied_automatic_prerequisite_jobs' in v_definition) = 0 then
    if position(v_marker in v_definition) = 0 then
      raise exception 'The single automation master changed; refusing an unsafe prerequisite patch.';
    end if;
    v_definition := replace(
      v_definition,
      v_marker,
      '  perform public.resume_satisfied_automatic_prerequisite_jobs(v_limit);'
        || E'\n' || v_marker
    );
  end if;

  if position('release_reclassified_automatic_focus_pauses' in v_definition) = 0 then
    if position(v_marker in v_definition) = 0 then
      raise exception 'The single automation master changed; refusing an unsafe blocker patch.';
    end if;
    v_definition := replace(
      v_definition,
      v_marker,
      '  perform public.release_reclassified_automatic_focus_pauses(v_limit);'
        || E'\n' || v_marker
    );
  end if;

  execute v_definition;
end;
$migration$;

-- Keep the previous implementation for rollback/audit and rebuild the public
-- inventory from the pre-pause v13 source. Only the root operation owns the
-- failure; dependent stages report an upstream wait instead of duplicating it.
alter function public.get_visible_automation_task_inventory(uuid)
  rename to get_visible_automation_task_inventory_v14;

revoke all on function public.get_visible_automation_task_inventory_v14(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory_v14(uuid)
  to service_role;

create or replace function public.get_visible_automation_task_inventory(
  p_requested_by uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with source as (
    select entry.value as task, entry.ordinality
    from jsonb_array_elements(coalesce(
      public.get_visible_automation_task_inventory_v13(p_requested_by),
      '[]'::jsonb
    )) with ordinality as entry(value, ordinality)
  ), evidence as (
    select source.*,
      pause.reason as pause_reason,
      pause.error_code as pause_error_code,
      pause.error_message as pause_error,
      blocker.value as blocker,
      history.error_code as historical_error_code,
      history.error_message as historical_error,
      history.resolved_at as historical_resolved_at,
      case when source.task->>'operationKey' = 'content_writing'
        then public.automatic_content_writing_requirement(
          (source.task->>'articleId')::uuid
        )
        else null::jsonb
      end as writing_requirement
    from source
    left join public.automatic_article_focus_pauses as pause
      on pause.article_id = (source.task->>'articleId')::uuid
    left join lateral (
      select public.automatic_focus_pause_blocker_state(
        pause.article_id, pause.error_code, pause.error_message
      ) as value
    ) as blocker on pause.article_id is not null
    left join lateral (
      select saved.error_code, saved.error_message, saved.resolved_at
      from public.automatic_article_focus_pause_history as saved
      where saved.article_id = (source.task->>'articleId')::uuid
      order by saved.resolved_at desc, saved.id desc
      limit 1
    ) as history on true
  ), classified as (
    select evidence.*,
      coalesce((evidence.blocker->>'current')::boolean, false) as blocker_current,
      coalesce(evidence.blocker->>'category', '') as blocker_category,
      coalesce(evidence.blocker->>'rootOperationKey', '') as root_operation_key,
      case
        when evidence.blocker->>'rootOperationKey' = 'semantic_keywords'
          then evidence.task->>'operationKey' in (
            'alternative_keywords', 'lsi_keywords', 'google_metadata'
          )
        else evidence.task->>'operationKey' = evidence.blocker->>'rootOperationKey'
      end as root_task
    from evidence
  ), normalized as (
    select classified.ordinality,
      (
        case
          when classified.pause_reason is null
            and classified.historical_resolved_at is not null
            and classified.task->>'status' = 'failed'
            and coalesce(
              nullif(classified.task->>'updatedAt', '')::timestamptz
                <= classified.historical_resolved_at,
              true
            )
            and (
              nullif(classified.historical_error, '') is not null
              and (
                classified.task->>'reason' = classified.historical_error
                or position(
                lower(classified.historical_error)
                in lower(coalesce(classified.task->>'reason', ''))
                ) > 0
              )
              or (
                nullif(classified.historical_error_code, '') is not null
                and position(
                lower(classified.historical_error_code)
                in lower(coalesce(classified.task->>'reasonCode', ''))
                ) > 0
              )
            ) then
            classified.task || jsonb_build_object(
              'status', 'unscheduled',
              'scheduled', false,
              'scheduleAt', null,
              'reasonCode', 'historical_blocker_resolved',
              'reason', 'The previous blocker no longer exists; the master engine will reconcile this stage.',
              'manualReview', false,
              'runnable', false
            )
          when classified.pause_reason is not null
            and classified.blocker_category = 'waiting_prerequisite' then
            classified.task || jsonb_build_object(
              'status', 'unscheduled',
              'scheduled', false,
              'scheduleAt', null,
              'reasonCode', case when classified.root_task
                then 'waiting_for_prerequisites' else 'blocked_by_upstream' end,
              'reason', case when classified.root_task
                then 'The prerequisite is not complete yet.'
                else 'This stage is waiting for the upstream blocker.' end,
              'manualReview', false,
              'runnable', false
            )
          when classified.pause_reason is not null
            and not classified.blocker_current then
            classified.task || jsonb_build_object(
              'status', case when classified.task->>'status' = 'failed'
                then 'unscheduled' else classified.task->>'status' end,
              'scheduled', false,
              'scheduleAt', null,
              'reasonCode', 'historical_blocker_resolved',
              'reason', 'The previous blocker no longer exists; the master engine will reconcile this stage.',
              'manualReview', false,
              'runnable', false
            )
          when classified.pause_reason is not null and classified.root_task then
            classified.task || jsonb_build_object(
              'status', 'failed',
              'scheduled', false,
              'scheduleAt', null,
              'reasonCode', case
                when classified.blocker_category = 'transient'
                  and coalesce((classified.task->>'recoveryCount')::integer, 0)
                    >= greatest(1, coalesce((classified.task->>'maxRecoveries')::integer, 3))
                  then 'automatic_recovery_exhausted'
                else case classified.pause_reason
                  when 'focus_stalled' then 'manual_review_focus_stalled'
                  when 'post_write_attention_required' then 'manual_review_post_write_attention'
                  else 'manual_review_terminal_failure'
                end
              end,
              'reason', coalesce(
                nullif(classified.pause_error, ''),
                nullif(classified.pause_error_code, ''),
                classified.pause_reason
              ),
              'manualReview', true,
              'runnable', false
            )
          when classified.pause_reason is not null then
            classified.task || jsonb_build_object(
              'status', 'unscheduled',
              'scheduled', false,
              'scheduleAt', null,
              'reasonCode', 'blocked_by_upstream',
              'reason', 'This stage did not fail; it is waiting for the root operation.',
              'manualReview', false,
              'runnable', false
            )
          when classified.task->>'status' = 'unscheduled'
            and coalesce(classified.task->>'reasonCode', '') in (
              '', 'waiting_for_prerequisites'
            ) then
            classified.task || jsonb_build_object(
              'reasonCode', case
                when coalesce(classified.task->'missingFields', '[]'::jsonb)
                  ? 'company_name' then 'missing_company_name'
                when coalesce(classified.task->'missingFields', '[]'::jsonb)
                  ?| array['editor_text', 'article_editor_text'] then 'missing_editor_text'
                when coalesce(classified.task->'missingFields', '[]'::jsonb)
                  ?| array['goal_context.pageType', 'goal_context.objective',
                    'goal_context.audienceScope', 'goal_context.searchIntent']
                  then 'missing_goal_context'
                when coalesce(classified.task->'missingFields', '[]'::jsonb)
                  ?| array['alternative_keywords', 'lsi_keywords', 'google_metadata']
                  then 'missing_semantic_keywords'
                when coalesce(classified.task->'missingFields', '[]'::jsonb)
                  ?| array['competitors', 'competitor_content_or_url']
                  then 'missing_competitor_source'
                else 'waiting_for_prerequisites'
              end,
              'scheduled', false,
              'scheduleAt', null,
              'runnable', false
            )
          else classified.task
        end
      ) || jsonb_strip_nulls(jsonb_build_object(
        'currentBlocker', case when classified.pause_reason is not null
          then classified.blocker_current else null end,
        'blockerCategory', nullif(classified.blocker_category, ''),
        'rootOperationKey', nullif(classified.root_operation_key, ''),
        'historicalErrorCode', classified.historical_error_code,
        'historicalError', classified.historical_error,
        'historicalResolvedAt', classified.historical_resolved_at
      )) as task
    from classified
    where not (
      classified.task->>'operationKey' = 'content_writing'
      and not coalesce(
        (classified.writing_requirement->>'required')::boolean,
        false
      )
    )
  )
  select coalesce(
    jsonb_agg(normalized.task order by normalized.ordinality),
    '[]'::jsonb
  )
  from normalized;
$$;

-- Migrate currently safe stale pauses immediately. The same bounded function
-- is called by the existing master every minute for future state changes.
select public.resume_satisfied_automatic_prerequisite_jobs(100);
select public.release_reclassified_automatic_focus_pauses(100);

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 15;
$$;

revoke all on function public.automatic_focus_pause_blocker_state(uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.defer_external_analysis_job_for_prerequisite(uuid,text,text,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.resume_satisfied_automatic_prerequisite_jobs(integer)
  from public, anon, authenticated;
revoke all on function public.release_reclassified_automatic_focus_pauses(integer)
  from public, anon, authenticated;
revoke all on function public.get_visible_automation_task_inventory(uuid)
  from public, anon, authenticated;
grant execute on function public.automatic_focus_pause_blocker_state(uuid,text,text)
  to service_role;
grant execute on function public.defer_external_analysis_job_for_prerequisite(uuid,text,text,text,jsonb)
  to service_role;
grant execute on function public.resume_satisfied_automatic_prerequisite_jobs(integer)
  to service_role;
grant execute on function public.release_reclassified_automatic_focus_pauses(integer)
  to service_role;
grant execute on function public.get_visible_automation_task_inventory(uuid)
  to service_role;

comment on table public.automatic_article_focus_pause_history is
  'Server-only audit history of resolved automatic-article pauses; rows never block current automation.';
comment on function public.automatic_focus_pause_blocker_state(uuid,text,text) is
  'Classifies a stored pause against live article evidence and identifies its single root operation.';
comment on function public.defer_external_analysis_job_for_prerequisite(uuid,text,text,text,jsonb) is
  'Refunds the claimed attempt and parks an automatic job whose upstream prerequisite is unfinished.';
comment on function public.resume_satisfied_automatic_prerequisite_jobs(integer) is
  'Requeues parked prerequisite jobs after live article evidence confirms that the prerequisite is complete.';
comment on function public.release_reclassified_automatic_focus_pauses(integer) is
  'Releases prerequisite waits and resolved manual blockers inside the existing single automation master.';
comment on function public.get_visible_automation_task_inventory(uuid) is
  'Returns current blockers once at their root operation, marks dependent work as upstream-waiting, and keeps resolved errors historical.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 15 with current blocker classification and historical pause evidence.';

notify pgrst, 'reload schema';

commit;
