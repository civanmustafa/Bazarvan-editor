begin;

-- Preserve the original permission-aware inventory as the raw coordinator
-- projection. The public API continues to call the canonical function below,
-- which removes rows whose current saved result proves that the work is done.
do $migration$
begin
  if to_regprocedure('public.get_visible_automation_task_inventory_raw(uuid)') is null then
    alter function public.get_visible_automation_task_inventory(uuid)
      rename to get_visible_automation_task_inventory_raw;
  end if;
end;
$migration$;

revoke all on function public.get_visible_automation_task_inventory_raw(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory_raw(uuid)
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
  with raw_tasks as (
    select
      task,
      task->>'operationKey' as operation_key,
      (task->>'articleId')::uuid as article_id,
      greatest(1, coalesce((task->>'priorityRank')::integer, 1)) as previous_priority
    from jsonb_array_elements(
      coalesce(public.get_visible_automation_task_inventory_raw(p_requested_by), '[]'::jsonb)
    ) as source(task)
  ), task_evidence as (
    select
      raw.*,
      article.keywords,
      external_job.status as external_status,
      coalesce(competitors.total_count, 0) as competitor_total_count,
      coalesce(competitors.ready_count, 0) as competitor_ready_count
    from raw_tasks as raw
    join public.articles as article on article.id = raw.article_id
    left join public.ai_external_analysis_jobs as external_job
      on raw.task->>'sourceType' = 'external_analysis'
      and external_job.id::text = raw.task->>'sourceId'
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
  ), filtered as (
    select evidence.*
    from task_evidence as evidence
    where not (
      coalesce(evidence.external_status, '') = 'completed'
      or (
        coalesce(evidence.external_status, '') not in (
          'waiting_for_prerequisites', 'queued', 'running',
          'retry_scheduled', 'paused'
        )
        and case evidence.operation_key
          when 'alternative_keywords' then exists (
            select 1
            from jsonb_array_elements_text(
              case when jsonb_typeof(evidence.keywords->'secondaries') = 'array'
                then evidence.keywords->'secondaries' else '[]'::jsonb end
            ) as keyword(value)
            where nullif(btrim(keyword.value), '') is not null
          )
          when 'lsi_keywords' then exists (
            select 1
            from jsonb_array_elements_text(
              case when jsonb_typeof(evidence.keywords->'lsi') = 'array'
                then evidence.keywords->'lsi' else '[]'::jsonb end
            ) as keyword(value)
            where nullif(btrim(keyword.value), '') is not null
          )
          when 'google_metadata' then (
            (
              select count(*)
              from jsonb_array_elements_text(
                case when jsonb_typeof(evidence.keywords->'googleTitles') = 'array'
                  then evidence.keywords->'googleTitles' else '[]'::jsonb end
              ) as title(value)
              where nullif(btrim(title.value), '') is not null
            ) >= 2
            and (
              select count(*)
              from jsonb_array_elements(
                case when jsonb_typeof(evidence.keywords->'googleDescriptions') = 'array'
                  then evidence.keywords->'googleDescriptions' else '[]'::jsonb end
              ) as description(value)
              where nullif(btrim(case
                when jsonb_typeof(description.value) = 'object'
                  then description.value->>'text'
                else description.value #>> '{}'
              end), '') is not null
            ) >= 2
          )
          when 'competitor_discovery' then evidence.competitor_total_count > 0
          when 'competitor_extraction' then evidence.competitor_total_count > 0
            and evidence.competitor_ready_count >= evidence.competitor_total_count
          else false
        end
      )
    )
  ), reranked as (
    select
      filtered.task || jsonb_build_object(
        'priorityRank', row_number() over (
          partition by filtered.operation_key
          order by filtered.previous_priority, filtered.article_id
        )
      ) as task,
      filtered.operation_key,
      filtered.previous_priority,
      filtered.article_id
    from filtered
  )
  select coalesce(
    jsonb_agg(task order by operation_key, previous_priority, article_id),
    '[]'::jsonb
  )
  from reranked;
$$;

revoke all on function public.get_visible_automation_task_inventory(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory(uuid)
  to service_role;

comment on function public.get_visible_automation_task_inventory(uuid) is
  'Returns visible unfinished automation tasks after excluding rows already satisfied by current saved article, competitor, or completed-job evidence.';

-- Recover classified transient failures automatically. Permanent failures,
-- cancellations, invalid output, missing inputs and review decisions remain
-- excluded by automation_failure_is_retryable. Three bounded recovery cycles
-- prevent an unavailable provider from creating an unbounded request loop.
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
    where job.status in ('failed', 'blocked')
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
    set
      status = 'retry_scheduled',
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
      and public.automation_failure_is_retryable(item.last_error_code, item.last_error)
      and public.article_automatic_job_allowed(item.article_id, 'content_writing')
    order by coalesce(item.completed_at, item.updated_at), item.id
    limit greatest(0, v_limit - v_external_count)
    for update skip locked
  ), recovered as (
    update public.content_writing_automation_items as item
    set
      status = 'ready',
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
    'total', coalesce(v_external_count, 0) + coalesce(v_writing_count, 0)
  );
end;
$$;

revoke all on function public.auto_requeue_recoverable_automation_failures(integer)
  from public, anon, authenticated;
grant execute on function public.auto_requeue_recoverable_automation_failures(integer)
  to service_role;

comment on function public.auto_requeue_recoverable_automation_failures(integer) is
  'Automatically requeues policy-allowed transient external-analysis and content-writing failures in at most three bounded recovery cycles.';

notify pgrst, 'reload schema';

commit;
