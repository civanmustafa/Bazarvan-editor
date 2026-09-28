begin;

-- One permission-aware inventory backs the dashboard cards.  Keeping the
-- access check inside PostgreSQL prevents the service-role API from ever
-- leaking another user's article tasks while still allowing administrators
-- to see the complete system inventory.
create or replace function public.get_visible_automation_task_inventory(
  p_requested_by uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with visible_articles as (
    select article.id, article.title
    from public.articles as article
    where public.article_access_level_for_user(article.id, p_requested_by) <> 'none'
  ),
  stage_source as (
    select
      stage.article_id,
      article.title as article_title,
      stage.stage,
      stage.status as stage_status,
      stage.source_type,
      stage.source_id,
      stage.attempt_count,
      stage.max_attempts,
      stage.next_attempt_at,
      stage.last_error,
      stage.details,
      stage.created_at,
      stage.updated_at,
      external_job.status as external_status,
      external_job.input_snapshot as external_input,
      external_job.started_at as external_started_at,
      external_job.next_attempt_at as external_next_attempt_at,
      writing_item.status as writing_status,
      writing_item.ready_at as writing_ready_at,
      writing_item.eligible_at as writing_eligible_at,
      writing_item.started_at as writing_started_at,
      writing_item.next_recovery_at as writing_next_recovery_at,
      writing_item.failure_class as writing_failure_class
    from public.article_automation_stage_states as stage
    join visible_articles as article on article.id = stage.article_id
    left join public.ai_external_analysis_jobs as external_job
      on stage.source_type = 'external_analysis' and external_job.id = stage.source_id
    left join lateral (
      select item.*
      from public.content_writing_automation_items as item
      where item.article_id = stage.article_id
      order by item.updated_at desc
      limit 1
    ) as writing_item on stage.stage in ('content_writing_preparation', 'content_writing')
    where stage.status not in ('completed', 'cancelled')
  ),
  expanded_stage as (
    select source.*, expanded.operation_key
    from stage_source as source
    cross join lateral unnest(
      case source.stage
        when 'semantic_keywords_lsi' then array['alternative_keywords', 'lsi_keywords', 'google_metadata']
        when 'competitor_discovery' then array['competitor_discovery']
        when 'competitor_extraction' then array['competitor_extraction']
        when 'content_writing_preparation' then array['content_writing']
        when 'content_writing' then array['content_writing']
        when 'engineering_commands' then array['external_analysis']
        else array[]::text[]
      end
    ) as expanded(operation_key)
    where source.stage <> 'semantic_keywords_lsi'
      or source.external_input is null
      or case expanded.operation_key
        when 'alternative_keywords' then source.external_input->>'needsSecondaries' is distinct from 'false'
        when 'lsi_keywords' then source.external_input->>'needsLsi' is distinct from 'false'
        when 'google_metadata' then source.external_input->>'needsGoogleMetadata' is distinct from 'false'
        else true
      end
  ),
  labeled_stage as (
    select
      operation_key,
      article_id,
      article_title,
      coalesce(source_id::text, article_id::text) as source_id,
      case
        when writing_status in ('claiming', 'writing') then 'running'
        when writing_status = 'ready' and coalesce(writing_eligible_at, now()) > now() then 'scheduled'
        when writing_status = 'ready' then 'ready'
        when writing_status = 'blocked' and writing_failure_class = 'transient'
          and writing_next_recovery_at is not null then 'scheduled'
        when writing_status = 'blocked' then 'failed'
        when stage_status = 'running' or external_status = 'running' then 'running'
        when stage_status in ('queued', 'retry_scheduled', 'paused')
          or external_status in ('queued', 'retry_scheduled', 'paused') then 'scheduled'
        when stage_status in ('failed', 'blocked') or external_status in ('failed', 'blocked') then 'failed'
        else 'unscheduled'
      end as task_status,
      coalesce(writing_eligible_at, writing_next_recovery_at, external_next_attempt_at, next_attempt_at) as schedule_at,
      coalesce(writing_started_at, external_started_at) as started_at,
      coalesce(writing_ready_at, created_at) as ready_at,
      updated_at,
      coalesce(nullif(last_error, ''), nullif(details->>'reason', ''),
        case when stage_status = 'waiting_for_prerequisites'
          then 'waiting_for_prerequisites' else null end) as reason,
      attempt_count,
      max_attempts,
      source_type
    from expanded_stage
  ),
  deduplicated_stage as (
    select distinct on (operation_key, article_id)
      operation_key || ':' || article_id::text as task_id,
      operation_key, article_id, article_title, source_id, task_status,
      schedule_at, started_at, ready_at, updated_at, reason,
      attempt_count, max_attempts, source_type
    from labeled_stage
    order by operation_key, article_id,
      case task_status when 'running' then 0 when 'ready' then 1 when 'scheduled' then 2
        when 'unscheduled' then 3 else 4 end,
      updated_at desc
  ),
  latest_duplicate_job as (
    select distinct on (job.article_id)
      'duplicate_suggestions:' || job.article_id::text as task_id,
      'duplicate_suggestions'::text as operation_key,
      job.article_id,
      article.title as article_title,
      job.id::text as source_id,
      case
        when job.status = 'running' then 'running'
        when job.status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused') then 'scheduled'
        else 'failed'
      end as task_status,
      job.next_attempt_at as schedule_at,
      job.started_at,
      job.created_at as ready_at,
      job.updated_at,
      coalesce(nullif(job.last_error, ''), nullif(job.last_error_code, '')) as reason,
      job.attempt_count,
      job.max_attempts,
      'external_analysis'::text as source_type
    from public.ai_external_analysis_jobs as job
    join visible_articles as article on article.id = job.article_id
    where job.job_type = 'duplicate_cleanup'
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused', 'failed', 'blocked')
    order by job.article_id, job.created_at desc
  ),
  pending_duplicate_schedule as (
    select
      'duplicate_suggestions:' || schedule.article_id::text as task_id,
      'duplicate_suggestions'::text as operation_key,
      schedule.article_id,
      article.title as article_title,
      schedule.article_id::text as source_id,
      'scheduled'::text as task_status,
      schedule.quiet_since + interval '15 minutes' as schedule_at,
      null::timestamptz as started_at,
      schedule.quiet_since as ready_at,
      schedule.quiet_since as updated_at,
      'waiting_for_editor_idle'::text as reason,
      0::integer as attempt_count,
      1::integer as max_attempts,
      'duplicate_schedule'::text as source_type
    from public.duplicate_cleanup_schedule as schedule
    join visible_articles as article on article.id = schedule.article_id
    where schedule.dispatched_signature is distinct from schedule.signature
      and not exists (
        select 1 from latest_duplicate_job as active
        where active.article_id = schedule.article_id
      )
  ),
  task_rows as (
    select * from deduplicated_stage
    union all
    select * from latest_duplicate_job
    union all
    select * from pending_duplicate_schedule
  ),
  prioritized as (
    select task_rows.*,
      row_number() over (
        partition by operation_key
        order by
          case task_status when 'running' then 0 when 'ready' then 1 when 'scheduled' then 2
            when 'unscheduled' then 3 else 4 end,
          coalesce(started_at, schedule_at, ready_at, updated_at),
          article_id
      ) as priority_rank
    from task_rows
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'taskId', task_id,
    'operationKey', operation_key,
    'articleId', article_id,
    'articleTitle', article_title,
    'status', task_status,
    'scheduled', task_status = 'scheduled',
    'scheduleAt', schedule_at,
    'startedAt', started_at,
    'readyAt', ready_at,
    'updatedAt', updated_at,
    'sourceType', source_type,
    'sourceId', source_id,
    'priorityRank', priority_rank,
    'reason', reason,
    'attemptCount', attempt_count,
    'maxAttempts', max_attempts
  ) order by operation_key, priority_rank), '[]'::jsonb)
  from prioritized;
$$;

revoke all on function public.get_visible_automation_task_inventory(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory(uuid)
  to service_role;

comment on function public.get_visible_automation_task_inventory(uuid) is
  'Returns every unfinished automation task visible to the requester; administrators receive all article tasks through the canonical article access policy.';

notify pgrst, 'reload schema';

commit;
