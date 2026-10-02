begin;

-- A stalled focus is a temporary safety pause, not a permanent dead letter.
-- Re-open only articles for which the current database state proves that the
-- single master has useful work to claim. Permanent/terminal pauses remain
-- manual by design.
create or replace function public.release_recoverable_automatic_focus_stalls(
  p_limit integer default 10
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article_ids uuid[] := array[]::uuid[];
  v_released integer := 0;
begin
  select coalesce(array_agg(candidate.article_id), array[]::uuid[])
  into v_article_ids
  from (
    select pause.article_id
    from public.automatic_article_focus_pauses as pause
    join public.articles as article on article.id = pause.article_id
    left join public.ai_external_analysis_article_state as state
      on state.article_id = pause.article_id
    cross join lateral (
      select public.automatic_content_writing_requirement(pause.article_id) as value
    ) as requirement
    cross join lateral (
      select public.evaluate_content_writing_automation_readiness(pause.article_id) as value
    ) as readiness
    where pause.reason = 'focus_stalled'
      and article.status in ('draft', 'content_preparation')
      and not public.article_is_globally_trashed(article.id)
      and (
        (
          public.article_automatic_policy_allows(article.id, 'duplicate_cleanup')
          and public.unified_duplicate_cleanup_auto_ready(article.id)
        )
        or exists (
          select 1
          from public.ai_external_analysis_jobs as job
          where job.article_id = article.id
            and job.origin = 'auto'
            and job.pipeline_parent_job_id is null
            and job.cancel_requested_at is null
            and job.status in (
              'waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused'
            )
            and (
              coalesce((job.progress->>'focusPause')::boolean, false)
              or job.progress->>'blockedBy' = 'automatic_article_focus'
            )
            and public.article_automatic_policy_allows(
              article.id, job.job_type, job.command_id
            )
        )
        or (
          coalesce((requirement.value->>'required')::boolean, false)
          and (
            (
              coalesce((readiness.value->>'ready')::boolean, false)
              and public.article_automatic_policy_allows(article.id, 'content_writing')
            )
            or (
              coalesce(state.semantic_ready, false)
              and public.article_automatic_policy_allows(article.id, 'semantic_keywords_lsi')
            )
            or (
              coalesce(state.competitor_discovery_ready, false)
              and public.article_automatic_policy_allows(article.id, 'competitor_discovery')
            )
          )
        )
      )
    order by pause.paused_at, pause.article_id
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update of pause skip locked
  ) as candidate;

  if coalesce(array_length(v_article_ids, 1), 0) = 0 then
    return 0;
  end if;

  delete from public.automatic_article_focus_pauses as pause
  where pause.article_id = any(v_article_ids)
    and pause.reason = 'focus_stalled';
  get diagnostics v_released = row_count;

  update public.automatic_article_focus as focus
  set state = 'idle',
      current_stage = null,
      last_release_reason = 'recoverable_stall_released',
      released_at = now(),
      next_retry_at = null,
      last_error_code = null,
      last_error = null,
      last_progress_at = now(),
      updated_at = now()
  where focus.singleton is true
    and focus.article_id is null
    and focus.last_article_id = any(v_article_ids)
    and focus.state = 'needs_attention';

  if v_released > 0 then
    insert into public.worker_queue_signals(queue_name)
    values ('external_analysis'), ('content_writing')
    on conflict do nothing;
    perform public.reconcile_automatic_article_focus();
  end if;

  return v_released;
end;
$$;

-- Keep recovery inside the existing advisory-locked
-- article-automation-master-engine. No second timer, worker, or competing
-- scheduler is introduced.
do $migration$
declare
  v_definition text;
  v_marker constant text := '  select greatest(1, least(';
  v_position integer;
begin
  select pg_get_functiondef(
    'public.auto_requeue_recoverable_automation_failures(integer)'::regprocedure
  ) into v_definition;

  if position('release_recoverable_automatic_focus_stalls' in v_definition) = 0 then
    v_position := position(v_marker in v_definition);
    if v_position = 0 then
      raise exception 'The automation master changed; refusing an unsafe stall-recovery patch.';
    end if;
    v_definition := overlay(
      v_definition placing
        '  perform public.release_recoverable_automatic_focus_stalls(v_limit);'
        || E'\n\n' || v_marker
      from v_position for length(v_marker)
    );
    execute v_definition;
  end if;
end;
$migration$;

-- Preserve the complete schema-v13 classifier, then make every dashboard row
-- truthful about pauses and missing prerequisites. This is the public source
-- consumed by the API; the raw inventory remains an internal candidate set.
alter function public.get_visible_automation_task_inventory(uuid)
  rename to get_visible_automation_task_inventory_v13;

revoke all on function public.get_visible_automation_task_inventory_v13(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory_v13(uuid)
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
    select
      source.*,
      pause.reason as pause_reason,
      pause.error_code as pause_error_code,
      pause.error_message as pause_error,
      case when source.task->>'operationKey' = 'content_writing'
        then public.automatic_content_writing_requirement(
          (source.task->>'articleId')::uuid
        )
        else null::jsonb
      end as writing_requirement
    from source
    left join public.automatic_article_focus_pauses as pause
      on pause.article_id = (source.task->>'articleId')::uuid
  ), normalized as (
    select evidence.ordinality,
      case
        when evidence.pause_reason is not null then
          evidence.task || jsonb_build_object(
            'status', 'failed',
            'scheduled', false,
            'scheduleAt', null,
            'reasonCode', case evidence.pause_reason
              when 'focus_stalled' then 'manual_review_focus_stalled'
              when 'terminal_stage_failure' then 'manual_review_terminal_failure'
              when 'post_write_attention_required' then 'manual_review_post_write_attention'
              else 'manual_review_required'
            end,
            'reason', coalesce(
              nullif(evidence.pause_error, ''),
              nullif(evidence.pause_error_code, ''),
              evidence.pause_reason
            ),
            'manualReview', true,
            'runnable', false
          )
        when evidence.task->>'status' = 'unscheduled'
          and coalesce(evidence.task->>'reasonCode', '') in (
            '', 'waiting_for_prerequisites'
          ) then
          evidence.task || jsonb_build_object(
            'reasonCode', case
              when coalesce(evidence.task->'missingFields', '[]'::jsonb)
                ? 'company_name' then 'missing_company_name'
              when coalesce(evidence.task->'missingFields', '[]'::jsonb)
                ?| array['editor_text', 'article_editor_text'] then 'missing_editor_text'
              when coalesce(evidence.task->'missingFields', '[]'::jsonb)
                ?| array['goal_context.pageType', 'goal_context.objective',
                  'goal_context.audienceScope', 'goal_context.searchIntent']
                then 'missing_goal_context'
              when coalesce(evidence.task->'missingFields', '[]'::jsonb)
                ?| array['alternative_keywords', 'lsi_keywords', 'google_metadata']
                then 'missing_semantic_keywords'
              when coalesce(evidence.task->'missingFields', '[]'::jsonb)
                ?| array['competitors', 'competitor_content_or_url']
                then 'missing_competitor_source'
              else 'waiting_for_prerequisites'
            end,
            'scheduled', false,
            'scheduleAt', null,
            'runnable', false
          )
        else evidence.task
      end as task
    from evidence
    where not (
      evidence.task->>'operationKey' = 'content_writing'
      and not coalesce(
        (evidence.writing_requirement->>'required')::boolean,
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

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 14;
$$;

revoke all on function public.release_recoverable_automatic_focus_stalls(integer)
  from public, anon, authenticated;
revoke all on function public.get_visible_automation_task_inventory(uuid)
  from public, anon, authenticated;
grant execute on function public.release_recoverable_automatic_focus_stalls(integer)
  to service_role;
grant execute on function public.get_visible_automation_task_inventory(uuid)
  to service_role;

comment on function public.release_recoverable_automatic_focus_stalls(integer) is
  'Releases only temporary focus_stalled pauses that now have provably runnable work; terminal pauses remain manual.';
comment on function public.get_visible_automation_task_inventory(uuid) is
  'Returns truthful draft automation tasks: paused work needs review, completed writing is absent, and unmet prerequisites never occupy the active waiting lane.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 14 with truthful idle-lane inventory and bounded recovery of runnable focus stalls.';

notify pgrst, 'reload schema';

commit;
