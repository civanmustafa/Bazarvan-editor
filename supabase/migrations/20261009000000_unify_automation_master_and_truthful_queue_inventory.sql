begin;

-- The content-writing worker executes already eligible work.  A single
-- external-analysis master owns recovery, prerequisite reconciliation and new
-- automatic task creation.  Keep the database side serialized as a second
-- line of defence if process configuration is ever duplicated.

-- Lease recovery and terminal-failure recovery used to overlap: this function
-- recovered both expired running jobs and delayed failed jobs, while
-- auto_requeue_recoverable_automation_failures() recovered the same failed
-- jobs again.  Keep this function narrowly responsible for abandoned running
-- leases; the master requeue function below is now the sole terminal-recovery
-- engine.
create or replace function public.recover_stale_external_analysis_jobs(
  p_retry_delay_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_retry_minutes integer := public.get_external_analysis_retry_minutes(p_retry_delay_minutes);
  v_stale_count integer := 0;
begin
  with recovered as (
    update public.ai_external_analysis_jobs as job
    set
      status = case when job.cancel_requested_at is not null then 'cancelled' else 'retry_scheduled' end,
      retry_count = job.retry_count + case when job.cancel_requested_at is null then 1 else 0 end,
      next_attempt_at = case
        when job.cancel_requested_at is not null then null
        else now() + make_interval(mins => v_retry_minutes)
      end,
      max_attempts = case
        when job.cancel_requested_at is null then greatest(job.max_attempts, job.attempt_count + 1)
        else job.max_attempts
      end,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      last_error_code = case
        when job.cancel_requested_at is not null then job.last_error_code
        else 'worker_lease_expired'
      end,
      last_error = case
        when job.cancel_requested_at is not null then job.last_error
        else 'The worker lease expired before the job reached a terminal state.'
      end,
      completed_at = case when job.cancel_requested_at is not null then now() else job.completed_at end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.cancel_requested_at is not null then 'cancelled' else 'retry_scheduled' end,
        'retryScheduledAt', case when job.cancel_requested_at is not null then null else now() end,
        'nextAttemptAt', case
          when job.cancel_requested_at is not null then null
          else to_jsonb(now() + make_interval(mins => v_retry_minutes))
        end,
        'retryDelayMinutes', case when job.cancel_requested_at is not null then null else v_retry_minutes end,
        'updatedAt', now()
      ),
      updated_at = now()
    where job.status = 'running'
      and job.lease_expires_at is not null
      and job.lease_expires_at <= now()
    returning job.id, job.status, job.last_error_code, job.last_error
  ), updated_runs as (
    update public.ai_external_analysis_runs as run
    set status = recovered.status,
        error_code = recovered.last_error_code,
        error_message = recovered.last_error,
        finished_at = now()
    from recovered
    where run.job_id = recovered.id
      and run.status = 'running'
    returning run.id
  )
  select count(*)::integer into v_stale_count from recovered;

  return coalesce(v_stale_count, 0);
end;
$$;

create or replace function public.auto_requeue_recoverable_automation_failures(
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_external_count integer := 0;
  v_writing_count integer := 0;
  v_max_attempts integer := 3;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('article-automation-master-engine', 0)) then
    return jsonb_build_object(
      'externalAnalysis', 0,
      'contentWriting', 0,
      'total', 0,
      'skipped', true,
      'reason', 'master_engine_busy'
    );
  end if;

  select greatest(1, least(
    case
      when coalesce(setting.value->>'contentWritingAutomationMaxAttempts', '') ~ '^\d+$'
        then (setting.value->>'contentWritingAutomationMaxAttempts')::integer
      else 3
    end,
    10
  )) into v_max_attempts
  from public.app_settings as setting
  where setting.key = 'ai';
  v_max_attempts := coalesce(v_max_attempts, 3);

  -- Existing editor content satisfies the writing stage.  Do not leave a
  -- stale automatic item that can later overwrite a manually written draft.
  update public.content_writing_automation_items as item
  set status = 'cancelled',
      next_recovery_at = null,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      completed_at = coalesce(item.completed_at, now()),
      failure_class = null,
      last_error_code = 'automatic_writing_not_required',
      last_error = 'The article editor already contains content; automatic writing is no longer required.',
      updated_at = now()
  from public.articles as article
  where article.id = item.article_id
    and article.status in ('draft', 'content_preparation')
    and item.status in ('ready', 'blocked')
    and public.article_editor_has_text(article.plain_text);

  -- A previous claim may have recorded a prerequisite miss.  Normalize it to
  -- a non-consuming ready record so the master can schedule the missing
  -- competitor preparation.  The writing claimant still independently checks
  -- the current readiness and cannot run early.
  with candidates as (
    select item.id, readiness.value,
      greatest(0, coalesce((readiness.value->>'usableCompetitorCount')::integer, 0)) as usable_count,
      greatest(0, coalesce((readiness.value->>'pendingCompetitorCount')::integer, 0)) as pending_count,
      coalesce(readiness.value->'missingFields', '[]'::jsonb) as missing_fields
    from public.content_writing_automation_items as item
    join public.articles as article on article.id = item.article_id
    cross join lateral (
      select public.evaluate_content_writing_automation_readiness(item.article_id) as value
    ) as readiness
    where item.status = 'blocked'
      and item.last_error_code = 'content_writing_prerequisites_missing'
      and article.status in ('draft', 'content_preparation')
      and not public.article_editor_has_text(article.plain_text)
      and public.article_automatic_policy_allows(item.article_id, 'content_writing')
      and (
        coalesce((readiness.value->>'ready')::boolean, false)
        or (
          coalesce(readiness.value->'missingFields', '[]'::jsonb) @> '["competitors"]'::jsonb
          and jsonb_array_length(coalesce(readiness.value->'missingFields', '[]'::jsonb)) = 1
        )
      )
    order by item.updated_at, item.id
    limit v_limit
    for update of item skip locked
  )
  update public.content_writing_automation_items as item
  set status = 'ready',
      readiness_signature = coalesce(nullif(candidates.value->>'signature', ''), item.readiness_signature),
      usable_competitor_count = candidates.usable_count,
      pending_competitor_count = candidates.pending_count,
      attempt_count = 0,
      max_attempts = v_max_attempts,
      ready_at = now(),
      eligible_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      completed_at = null,
      failure_class = null,
      next_recovery_at = null,
      last_error_code = case
        when coalesce((candidates.value->>'ready')::boolean, false) then null
        else 'content_writing_prerequisites_missing'
      end,
      last_error = case
        when coalesce((candidates.value->>'ready')::boolean, false) then null
        else 'Content writing is waiting for the required competitor inputs.'
      end,
      updated_at = now()
  from candidates
  where item.id = candidates.id;

  -- External failures use the documented 1h, 6h and 24h bounded recovery
  -- cadence.  Do not turn a historical failure into an immediate retry loop.
  with candidates as (
    select job.id,
      case
        when coalesce(job.progress->>'automaticRecoveryCount', '') ~ '^\d+$'
          then greatest(0, (job.progress->>'automaticRecoveryCount')::integer)
        else 0
      end as recovery_count
    from public.ai_external_analysis_jobs as job
    left join lateral (
      select run.error_code, run.error_message
      from public.ai_external_analysis_runs as run
      where run.job_id = job.id
      order by run.run_number desc
      limit 1
    ) as latest_run on true
    where job.origin = 'auto'
      and job.status in ('failed', 'blocked')
      and job.cancel_requested_at is null
      and job.job_type <> 'full_article_pipeline'
      and case
        when coalesce(job.progress->>'automaticRecoveryCount', '') ~ '^\d+$'
          then greatest(0, (job.progress->>'automaticRecoveryCount')::integer)
        else 0
      end < 3
      and public.automation_failure_is_retryable(
        coalesce(latest_run.error_code, job.last_error_code),
        coalesce(latest_run.error_message, job.last_error)
      )
      and public.article_automatic_job_allowed(job.article_id, job.job_type, job.command_id)
      and coalesce(job.completed_at, job.updated_at) + case (case
        when coalesce(job.progress->>'automaticRecoveryCount', '') ~ '^\d+$'
          then greatest(0, (job.progress->>'automaticRecoveryCount')::integer)
        else 0
      end)
        when 0 then interval '1 hour'
        when 1 then interval '6 hours'
        else interval '24 hours'
      end <= now()
      and not exists (
        select 1
        from public.ai_external_analysis_jobs as active
        where active.article_id = job.article_id
          and active.job_type = job.job_type
          and active.id <> job.id
          and active.status in (
            'waiting_for_prerequisites', 'queued', 'running',
            'retry_scheduled', 'paused'
          )
      )
    order by coalesce(job.completed_at, job.updated_at), job.id
    limit v_limit
    for update of job skip locked
  ), recovered as (
    update public.ai_external_analysis_jobs as job
    set status = 'retry_scheduled',
        retry_count = 0,
        max_attempts = greatest(job.max_attempts, job.attempt_count + 6),
        next_attempt_at = now(),
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        completed_at = null,
        dead_lettered_at = null,
        dead_letter_reason = null,
        last_error_code = null,
        last_error = null,
        progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'retry_scheduled',
          'source', 'automatic_recoverable_requeue',
          'automaticRecoveryCount', candidates.recovery_count + 1,
          'automaticRecoveryAt', now(),
          'nextAttemptAt', now(),
          'updatedAt', now()
        ),
        updated_at = now()
    from candidates
    where job.id = candidates.id
    returning job.id
  )
  select count(*)::integer into v_external_count from recovered;

  with candidates as (
    select item.id
    from public.content_writing_automation_items as item
    where item.status = 'blocked'
      and item.failure_class = 'transient'
      and item.recovery_count < 3
      and item.next_recovery_at is not null
      and item.next_recovery_at <= now()
      and public.automation_failure_is_retryable(item.last_error_code, item.last_error)
      and public.article_automatic_job_allowed(item.article_id, 'content_writing')
    order by item.next_recovery_at, item.updated_at, item.id
    limit greatest(0, v_limit - v_external_count)
    for update skip locked
  ), recovered as (
    update public.content_writing_automation_items as item
    set status = 'ready',
        content_writing_session_id = null,
        run_generation = item.run_generation + 1,
        session_sequence = 1,
        attempt_count = 0,
        max_attempts = v_max_attempts,
        ready_at = now(),
        eligible_at = now(),
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        last_error_code = null,
        last_error = null,
        started_at = null,
        completed_at = null,
        recovery_count = item.recovery_count + 1,
        failure_class = null,
        next_recovery_at = null,
        updated_at = now()
    from candidates
    where item.id = candidates.id
    returning item.id
  )
  select count(*)::integer into v_writing_count from recovered;

  if v_external_count > 0 then
    insert into public.worker_queue_signals(queue_name) values ('external_analysis');
  end if;
  if v_writing_count > 0 then
    insert into public.worker_queue_signals(queue_name) values ('content_writing');
  end if;

  return jsonb_build_object(
    'externalAnalysis', coalesce(v_external_count, 0),
    'contentWriting', coalesce(v_writing_count, 0),
    'total', coalesce(v_external_count, 0) + coalesce(v_writing_count, 0),
    'skipped', false
  );
end;
$$;

-- Store a due time only while a writing item is genuinely schedulable.  The
-- previous coalesce kept old eligible_at values on terminal rows, which made
-- the dashboard show past dates as active schedules.
create or replace function public.capture_content_writing_automation_stage_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_next_attempt_at timestamptz;
  v_readiness jsonb := '{}'::jsonb;
begin
  perform public.initialize_article_automation_stage_states(new.article_id);
  if new.status = 'ready' then
    v_readiness := public.evaluate_content_writing_automation_readiness(new.article_id);
  end if;

  v_status := case
    when new.status = 'ready'
      and not coalesce((v_readiness->>'ready')::boolean, false)
      then 'waiting_for_prerequisites'
    when new.status = 'ready' then 'queued'
    when new.status in ('claiming', 'writing') then 'running'
    else new.status
  end;
  v_next_attempt_at := case
    when new.status = 'ready'
      and coalesce((v_readiness->>'ready')::boolean, false)
      then new.eligible_at
    when new.status = 'blocked'
      and new.failure_class = 'transient'
      and coalesce(new.recovery_count, 0) < 3
      then new.next_recovery_at
    else null
  end;

  insert into public.article_automation_stage_states(
    article_id, stage, status, source_type, source_id, readiness_signature,
    attempt_count, retry_count, max_attempts, next_attempt_at,
    last_error_code, last_error, details, last_transition_at, updated_at
  ) values (
    new.article_id, 'content_writing', v_status, 'content_writing', new.id,
    new.readiness_signature, coalesce(new.attempt_count, 0), coalesce(new.recovery_count, 0),
    greatest(1, coalesce(new.max_attempts, 1)), v_next_attempt_at,
    new.last_error_code, new.last_error,
    jsonb_build_object(
      'runGeneration', new.run_generation,
      'usableCompetitorCount', new.usable_competitor_count,
      'pendingCompetitorCount', new.pending_competitor_count,
      'readiness', coalesce(v_readiness, '{}'::jsonb)
    ), now(), now()
  )
  on conflict (article_id, stage) do update set
    status = excluded.status,
    source_type = excluded.source_type,
    source_id = excluded.source_id,
    readiness_signature = excluded.readiness_signature,
    attempt_count = excluded.attempt_count,
    retry_count = excluded.retry_count,
    max_attempts = excluded.max_attempts,
    next_attempt_at = excluded.next_attempt_at,
    last_error_code = excluded.last_error_code,
    last_error = excluded.last_error,
    details = excluded.details,
    last_transition_at = case
      when public.article_automation_stage_states.status is distinct from excluded.status
        or public.article_automation_stage_states.source_id is distinct from excluded.source_id
      then now()
      else public.article_automation_stage_states.last_transition_at
    end,
    updated_at = now();
  return new;
end;
$$;

-- Drive the dashboard from the same current readiness, policy, focus and
-- recovery evidence used by the workers.  A historical row is never enough by
-- itself to call an article ready or scheduled.
create or replace function public.get_visible_automation_task_inventory(
  p_requested_by uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with configuration as (
    select greatest(2, least(5, case
      when coalesce(setting.value->>'contentWritingAutomationMinimumCompetitors', '') ~ '^\d+$'
        then (setting.value->>'contentWritingAutomationMinimumCompetitors')::integer
      else 3
    end)) as minimum_competitors
    from public.app_settings as setting
    where setting.key = 'ai'
  ), config as (
    select coalesce((select minimum_competitors from configuration), 3) as minimum_competitors,
      3::integer as maximum_recoveries
  ), raw_tasks as (
    select
      task,
      task->>'operationKey' as operation_key,
      (task->>'articleId')::uuid as article_id,
      greatest(1, coalesce((task->>'priorityRank')::integer, 1)) as previous_priority
    from jsonb_array_elements(
      coalesce(public.get_visible_automation_task_inventory_raw(p_requested_by), '[]'::jsonb)
    ) as source(task)
  ), evidence as (
    select
      raw.*,
      article.status as article_status,
      article.keywords,
      public.article_editor_has_text(article.plain_text) as editor_has_text,
      external_job.status as external_status,
      latest_item.id as writing_item_id,
      latest_item.status as writing_status,
      latest_item.ready_at as writing_ready_at,
      latest_item.eligible_at as writing_eligible_at,
      latest_item.started_at as writing_started_at,
      latest_item.updated_at as writing_updated_at,
      latest_item.attempt_count as writing_attempt_count,
      latest_item.max_attempts as writing_max_attempts,
      latest_item.failure_class as writing_failure_class,
      latest_item.recovery_count as writing_recovery_count,
      latest_item.next_recovery_at as writing_next_recovery_at,
      latest_item.last_error_code as writing_error_code,
      latest_item.last_error as writing_error,
      readiness.value as readiness,
      coalesce(readiness.value->'missingFields', '[]'::jsonb) as missing_fields,
      greatest(0, coalesce((readiness.value->>'usableCompetitorCount')::integer, 0)) as usable_competitor_count,
      greatest(2, least(5, coalesce(
        (readiness.value->>'minimumCompetitorCount')::integer,
        config.minimum_competitors
      ))) as minimum_competitor_count,
      pause.article_id is not null as manually_paused,
      pause.error_code as pause_error_code,
      pause.error_message as pause_error,
      active_preparation.id as active_preparation_id,
      active_preparation.status as active_preparation_status,
      active_preparation.next_attempt_at as active_preparation_next_attempt_at,
      active_preparation.attempt_count as active_preparation_attempt_count,
      active_preparation.max_attempts as active_preparation_max_attempts,
      active_preparation.last_error as active_preparation_error,
      terminal_preparation.id as terminal_preparation_id,
      terminal_preparation.attempt_count as terminal_preparation_attempt_count,
      terminal_preparation.max_attempts as terminal_preparation_max_attempts,
      terminal_preparation.last_error as terminal_preparation_error,
      coalesce(competitors.total_count, 0) as competitor_total_count,
      coalesce(competitors.ready_count, 0) as competitor_ready_count,
      config.maximum_recoveries,
      public.article_automatic_policy_allows(article.id, 'content_writing') as writing_policy_allows,
      public.automatic_article_focus_allows(article.id, 'content_writing') as writing_focus_allows
    from raw_tasks as raw
    join public.articles as article on article.id = raw.article_id
    cross join config
    left join public.ai_external_analysis_jobs as external_job
      on raw.task->>'sourceType' = 'external_analysis'
      and external_job.id::text = raw.task->>'sourceId'
    left join lateral (
      select item.*
      from public.content_writing_automation_items as item
      where item.article_id = raw.article_id
      order by item.updated_at desc, item.id
      limit 1
    ) as latest_item on true
    cross join lateral (
      select public.evaluate_content_writing_automation_readiness(raw.article_id) as value
    ) as readiness
    left join public.automatic_article_focus_pauses as pause
      on pause.article_id = raw.article_id
    left join lateral (
      select job.*
      from public.ai_external_analysis_jobs as job
      where job.article_id = raw.article_id
        and job.job_type = 'content_writing_preparation'
        and job.origin = 'auto'
        and job.pipeline_parent_job_id is null
        and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      order by case job.status when 'running' then 0 else 1 end,
        job.updated_at desc, job.created_at desc
      limit 1
    ) as active_preparation on true
    left join lateral (
      select job.*
      from public.ai_external_analysis_jobs as job
      where job.article_id = raw.article_id
        and job.job_type = 'content_writing_preparation'
        and job.origin = 'auto'
        and job.pipeline_parent_job_id is null
        and (
          job.status in ('completed', 'failed', 'blocked')
          or (job.status = 'cancelled' and (job.attempt_count > 0 or job.started_at is not null))
        )
        and job.last_error_code is distinct from 'duplicate_preparation_suppressed'
        and job.readiness_signature = md5(jsonb_build_object(
          'articleId', raw.article_id,
          'readinessSignature', coalesce(readiness.value->>'signature', ''),
          'minimumCompetitorCount', config.minimum_competitors
        )::text)
      order by job.updated_at desc, job.created_at desc
      limit 1
    ) as terminal_preparation on true
    left join lateral (
      select
        count(*)::integer as total_count,
        count(*) filter (
          where competitor.status = 'completed'
            and nullif(btrim(coalesce(competitor.content_text, '')), '') is not null
        )::integer as ready_count
      from public.article_competitors as competitor
      where competitor.article_id = raw.article_id
    ) as competitors on true
  ), classified as (
    select evidence.*,
      case
        when evidence.operation_key <> 'content_writing' then evidence.task->>'status'
        when evidence.editor_has_text then 'completed'
        when evidence.writing_status in ('claiming', 'writing') then 'running'
        when evidence.manually_paused then 'failed'
        when not evidence.writing_policy_allows then 'failed'
        when not evidence.writing_focus_allows then 'unscheduled'
        when evidence.writing_status = 'blocked'
          and evidence.writing_failure_class = 'transient'
          and coalesce(evidence.writing_recovery_count, 0) < evidence.maximum_recoveries
          then 'scheduled'
        when evidence.writing_status = 'blocked' then 'failed'
        when evidence.active_preparation_status = 'running' then 'running'
        when evidence.active_preparation_id is not null then 'scheduled'
        when evidence.terminal_preparation_id is not null
          and evidence.missing_fields @> '["competitors"]'::jsonb then 'failed'
        when coalesce((evidence.readiness->>'ready')::boolean, false)
          and evidence.writing_status = 'ready'
          and coalesce(evidence.writing_eligible_at, now()) > now() then 'scheduled'
        when coalesce((evidence.readiness->>'ready')::boolean, false)
          and (evidence.writing_item_id is null or evidence.writing_status = 'ready') then 'ready'
        else 'unscheduled'
      end as task_status,
      case
        when evidence.operation_key <> 'content_writing' then case
          when evidence.task->>'status' = 'running' then 'execution_in_progress'
          when evidence.task->>'status' = 'ready' then 'eligible_not_scheduled'
          when evidence.task->>'status' = 'scheduled'
            and nullif(evidence.task->>'scheduleAt', '')::timestamptz <= now()
            then 'waiting_for_queue_turn'
          when evidence.task->>'status' = 'scheduled' then 'retry_scheduled'
          when evidence.task->>'status' = 'failed' then 'task_failed'
          else coalesce(nullif(evidence.task->>'reason', ''), 'waiting_for_prerequisites')
        end
        when evidence.editor_has_text then 'automatic_writing_not_required'
        when evidence.writing_status in ('claiming', 'writing') then 'execution_in_progress'
        when evidence.manually_paused then 'manual_review_required'
        when not evidence.writing_policy_allows then 'automation_disabled'
        when not evidence.writing_focus_allows then 'automatic_article_focus'
        when evidence.writing_status = 'blocked'
          and evidence.writing_failure_class = 'transient'
          and coalesce(evidence.writing_recovery_count, 0) >= evidence.maximum_recoveries
          then 'automatic_recovery_exhausted'
        when evidence.writing_status = 'blocked'
          and evidence.writing_failure_class = 'transient'
          and evidence.writing_next_recovery_at is not null
          and evidence.writing_next_recovery_at > now() then 'retry_scheduled'
        when evidence.writing_status = 'blocked'
          and evidence.writing_failure_class = 'transient' then 'recovery_due'
        when evidence.writing_status = 'blocked' then 'retry_limit_reached'
        when evidence.active_preparation_status = 'running' then 'competitor_preparation_running'
        when evidence.active_preparation_id is not null then 'competitor_preparation_scheduled'
        when evidence.terminal_preparation_id is not null
          and evidence.missing_fields @> '["competitors"]'::jsonb
          then 'competitor_preparation_exhausted'
        when evidence.missing_fields @> '["competitors"]'::jsonb then 'missing_competitors'
        when not coalesce((evidence.readiness->>'ready')::boolean, false)
          then 'waiting_for_prerequisites'
        when evidence.writing_status = 'ready'
          and coalesce(evidence.writing_eligible_at, now()) > now() then 'retry_scheduled'
        else 'eligible_not_scheduled'
      end as reason_code
    from evidence
  ), projected as (
    select classified.*,
      case
        when classified.task_status <> 'scheduled' then null::timestamptz
        when classified.operation_key <> 'content_writing' then case
          when nullif(classified.task->>'scheduleAt', '')::timestamptz > now()
            then nullif(classified.task->>'scheduleAt', '')::timestamptz
          else null
        end
        when classified.writing_status = 'blocked'
          and classified.writing_next_recovery_at > now()
          then classified.writing_next_recovery_at
        when classified.active_preparation_next_attempt_at > now()
          then classified.active_preparation_next_attempt_at
        when classified.writing_eligible_at > now() then classified.writing_eligible_at
        else null
      end as effective_schedule_at,
      case
        when classified.operation_key <> 'content_writing'
          then nullif(classified.task->>'reason', '')
        else coalesce(
          nullif(classified.pause_error, ''),
          nullif(classified.writing_error, ''),
          nullif(classified.active_preparation_error, ''),
          nullif(classified.terminal_preparation_error, ''),
          nullif(classified.task->>'reason', '')
        )
      end as effective_reason,
      case
        when classified.operation_key = 'content_writing'
          and classified.active_preparation_id is not null
          then classified.active_preparation_attempt_count
        when classified.operation_key = 'content_writing'
          and classified.terminal_preparation_id is not null
          and classified.missing_fields @> '["competitors"]'::jsonb
          then classified.terminal_preparation_attempt_count
        when classified.operation_key = 'content_writing'
          then classified.writing_attempt_count
        else coalesce((classified.task->>'attemptCount')::integer, 0)
      end as effective_attempt_count,
      case
        when classified.operation_key = 'content_writing'
          and classified.active_preparation_id is not null
          then classified.active_preparation_max_attempts
        when classified.operation_key = 'content_writing'
          and classified.terminal_preparation_id is not null
          and classified.missing_fields @> '["competitors"]'::jsonb
          then classified.terminal_preparation_max_attempts
        when classified.operation_key = 'content_writing'
          then classified.writing_max_attempts
        else coalesce((classified.task->>'maxAttempts')::integer, 1)
      end as effective_max_attempts
    from classified
  ), filtered as (
    select projected.*
    from projected
    where projected.article_status = 'draft'
      and projected.task_status <> 'completed'
      and not (
        projected.operation_key <> 'content_writing'
        and (
          coalesce(projected.external_status, '') = 'completed'
          or (
            coalesce(projected.external_status, '') not in (
              'waiting_for_prerequisites', 'queued', 'running',
              'retry_scheduled', 'paused'
            )
            and case projected.operation_key
              when 'alternative_keywords' then exists (
                select 1
                from jsonb_array_elements_text(
                  case when jsonb_typeof(projected.keywords->'secondaries') = 'array'
                    then projected.keywords->'secondaries' else '[]'::jsonb end
                ) as keyword(value)
                where nullif(btrim(keyword.value), '') is not null
              )
              when 'lsi_keywords' then exists (
                select 1
                from jsonb_array_elements_text(
                  case when jsonb_typeof(projected.keywords->'lsi') = 'array'
                    then projected.keywords->'lsi' else '[]'::jsonb end
                ) as keyword(value)
                where nullif(btrim(keyword.value), '') is not null
              )
              when 'google_metadata' then (
                (
                  select count(*)
                  from jsonb_array_elements_text(
                    case when jsonb_typeof(projected.keywords->'googleTitles') = 'array'
                      then projected.keywords->'googleTitles' else '[]'::jsonb end
                  ) as title(value)
                  where nullif(btrim(title.value), '') is not null
                ) >= 2
                and (
                  select count(*)
                  from jsonb_array_elements(
                    case when jsonb_typeof(projected.keywords->'googleDescriptions') = 'array'
                      then projected.keywords->'googleDescriptions' else '[]'::jsonb end
                  ) as description(value)
                  where nullif(btrim(case
                    when jsonb_typeof(description.value) = 'object'
                      then description.value->>'text'
                    else description.value #>> '{}'
                  end), '') is not null
                ) >= 2
              )
              when 'competitor_discovery' then projected.competitor_total_count > 0
              when 'competitor_extraction' then projected.competitor_total_count > 0
                and projected.competitor_ready_count >= projected.competitor_total_count
              else false
            end
          )
        )
      )
  ), reranked as (
    select
      filtered.task || jsonb_build_object(
        'articleStatus', filtered.article_status,
        'status', filtered.task_status,
        'scheduled', filtered.task_status = 'scheduled',
        'scheduleAt', filtered.effective_schedule_at,
        'startedAt', case
          when filtered.operation_key = 'content_writing' then filtered.writing_started_at
          else nullif(filtered.task->>'startedAt', '')::timestamptz
        end,
        'readyAt', case
          when filtered.operation_key = 'content_writing'
            then coalesce(filtered.writing_ready_at, nullif(filtered.task->>'readyAt', '')::timestamptz)
          else nullif(filtered.task->>'readyAt', '')::timestamptz
        end,
        'updatedAt', case
          when filtered.operation_key = 'content_writing'
            then coalesce(filtered.writing_updated_at, nullif(filtered.task->>'updatedAt', '')::timestamptz)
          else nullif(filtered.task->>'updatedAt', '')::timestamptz
        end,
        'reasonCode', filtered.reason_code,
        'reason', filtered.effective_reason,
        'attemptCount', greatest(0, coalesce(filtered.effective_attempt_count, 0)),
        'maxAttempts', greatest(1, coalesce(filtered.effective_max_attempts, 1)),
        'missingFields', filtered.missing_fields,
        'usableCompetitorCount', filtered.usable_competitor_count,
        'minimumCompetitorCount', filtered.minimum_competitor_count,
        'recoveryCount', greatest(0, coalesce(filtered.writing_recovery_count, 0)),
        'maxRecoveries', filtered.maximum_recoveries,
        'manualReview', filtered.manually_paused
          or filtered.reason_code in (
            'manual_review_required', 'automatic_recovery_exhausted',
            'retry_limit_reached', 'competitor_preparation_exhausted'
          ),
        'runnable', filtered.task_status = 'ready',
        'priorityRank', row_number() over (
          partition by filtered.operation_key
          order by
            case filtered.task_status
              when 'running' then 0 when 'ready' then 1 when 'scheduled' then 2
              when 'unscheduled' then 3 else 4
            end,
            coalesce(
              filtered.writing_started_at,
              filtered.effective_schedule_at,
              filtered.writing_ready_at,
              nullif(filtered.task->>'readyAt', '')::timestamptz,
              nullif(filtered.task->>'updatedAt', '')::timestamptz
            ),
            filtered.article_id
        )
      ) as task,
      filtered.operation_key,
      filtered.article_id,
      filtered.task_status,
      filtered.effective_schedule_at
    from filtered
  )
  select coalesce(
    jsonb_agg(task order by operation_key,
      case task_status when 'running' then 0 when 'ready' then 1 when 'scheduled' then 2
        when 'unscheduled' then 3 else 4 end,
      effective_schedule_at nulls last, article_id),
    '[]'::jsonb
  )
  from reranked;
$$;

-- Remove stale dates which can no longer cause an automatic recovery.  The
-- stage-state trigger above mirrors these corrections into the dashboard
-- source table.
update public.content_writing_automation_items as item
set next_recovery_at = null,
    updated_at = now()
where item.status = 'blocked'
  and (
    coalesce(item.recovery_count, 0) >= 3
    or exists (
      select 1
      from public.automatic_article_focus_pauses as pause
      where pause.article_id = item.article_id
    )
  )
  and item.next_recovery_at is not null;

-- Reconcile old ready/blocked rows with current editor content immediately;
-- subsequent changes are handled by the single master each minute.
update public.content_writing_automation_items as item
set status = 'cancelled',
    next_recovery_at = null,
    completed_at = coalesce(item.completed_at, now()),
    failure_class = null,
    last_error_code = 'automatic_writing_not_required',
    last_error = 'The article editor already contains content; automatic writing is no longer required.',
    updated_at = now()
from public.articles as article
where article.id = item.article_id
  and article.status in ('draft', 'content_preparation')
  and item.status in ('ready', 'blocked')
  and public.article_editor_has_text(article.plain_text);

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 8;
$$;

revoke all on function public.auto_requeue_recoverable_automation_failures(integer)
  from public, anon, authenticated;
revoke all on function public.get_visible_automation_task_inventory(uuid)
  from public, anon, authenticated;
revoke all on function public.capture_content_writing_automation_stage_state()
  from public, anon, authenticated;
grant execute on function public.auto_requeue_recoverable_automation_failures(integer)
  to service_role;
grant execute on function public.get_visible_automation_task_inventory(uuid)
  to service_role;

comment on function public.get_visible_automation_task_inventory(uuid) is
  'Returns draft automation work classified from current readiness, focus, policy and bounded-recovery evidence, with explicit queue blocker reasons.';
comment on function public.auto_requeue_recoverable_automation_failures(integer) is
  'Single-master bounded recovery and prerequisite reconciliation for automatic article work.';

notify pgrst, 'reload schema';

commit;
