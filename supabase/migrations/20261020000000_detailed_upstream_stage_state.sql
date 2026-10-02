begin;

-- Preserve the exact prerequisite inventory and add the state of an upstream
-- stage when the same focused article is still progressing through its lane.
alter function public.get_visible_automation_task_inventory(uuid)
  rename to get_visible_automation_task_inventory_v16;

revoke all on function public.get_visible_automation_task_inventory_v16(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory_v16(uuid)
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
      public.get_visible_automation_task_inventory_v16(p_requested_by),
      '[]'::jsonb
    )) with ordinality as entry(value, ordinality)
  ), focused as (
    select source.*,
      focus.article_id as focus_article_id,
      focus.current_stage as focus_stage,
      focus.state as focus_state,
      focus.article_id = (source.task->>'articleId')::uuid
        and focus.state in ('active', 'waiting_retry', 'needs_attention')
        and source.task->>'status' = 'unscheduled'
        and coalesce(source.task->>'reasonCode', '') in (
          'waiting_for_prerequisites', 'blocked_by_upstream'
        )
        and not (
          focus.current_stage = source.task->>'operationKey'
          or focus.current_stage = 'semantic_keywords'
            and source.task->>'operationKey' in (
              'alternative_keywords', 'lsi_keywords', 'google_metadata'
            )
          or focus.current_stage = 'competitor_preparation'
            and source.task->>'operationKey' = 'competitor_extraction'
          or focus.current_stage = 'duplicate_cleanup'
            and source.task->>'operationKey' = 'duplicate_suggestions'
          or focus.current_stage = 'external_audits'
            and source.task->>'operationKey' = 'external_analysis'
        ) as waiting_for_same_article_stage
    from source
    left join public.automatic_article_focus as focus
      on focus.singleton is true
  ), projected as (
    select focused.ordinality,
      case when focused.waiting_for_same_article_stage then
        focused.task || jsonb_build_object(
          'requirements', coalesce(focused.task->'requirements', '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object(
              'code', focused.focus_stage,
              'state', case focused.focus_state
                when 'active' then 'running'
                when 'waiting_retry' then 'scheduled'
                else 'blocked'
              end,
              'articleId', focused.focus_article_id,
              'stage', focused.focus_stage
            )),
          'upstreamStage', focused.focus_stage,
          'upstreamState', focused.focus_state
        )
      else focused.task end as task
    from focused
  )
  select coalesce(
    jsonb_agg(projected.task order by projected.ordinality),
    '[]'::jsonb
  )
  from projected;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 17;
$$;

revoke all on function public.get_visible_automation_task_inventory(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory(uuid)
  to service_role;

comment on function public.get_visible_automation_task_inventory(uuid) is
  'Returns unfinished draft tasks with exact missing requirements, cross-article focus blockers, and same-article upstream stage state.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 17 with detailed same-article upstream stage state.';

notify pgrst, 'reload schema';

commit;
