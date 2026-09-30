begin;

-- Preserve the full readiness-aware inventory classifier from schema v8 as an
-- internal source, then normalize terminal writing rows that are intentionally
-- not runnable. In particular, a request superseded by explicit manual writing
-- must never be described as an eligible automatic task.
alter function public.get_visible_automation_task_inventory(uuid)
  rename to get_visible_automation_task_inventory_v8;

revoke all on function public.get_visible_automation_task_inventory_v8(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory_v8(uuid)
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
    from jsonb_array_elements(
      coalesce(
        public.get_visible_automation_task_inventory_v8(p_requested_by),
        '[]'::jsonb
      )
    ) with ordinality as entry(value, ordinality)
  ), evidence as (
    select
      source.*,
      latest.status as writing_status,
      latest.last_error_code as writing_error_code,
      latest.last_error as writing_error
    from source
    left join lateral (
      select item.status, item.last_error_code, item.last_error
      from public.content_writing_automation_items as item
      where source.task->>'operationKey' = 'content_writing'
        and item.article_id = (source.task->>'articleId')::uuid
      order by item.updated_at desc, item.id
      limit 1
    ) as latest on true
  ), normalized as (
    select
      evidence.ordinality,
      case
        when evidence.task->>'operationKey' = 'content_writing'
          and evidence.writing_status = 'cancelled' then
            evidence.task || jsonb_build_object(
              'status', 'unscheduled',
              'scheduled', false,
              'scheduleAt', null,
              'reasonCode', case
                when evidence.writing_error_code = 'superseded_by_explicit_manual'
                  then 'superseded_by_manual_request'
                else 'task_cancelled'
              end,
              'reason', coalesce(
                nullif(evidence.writing_error, ''),
                'Automatic writing was cancelled.'
              ),
              'manualReview', false,
              'runnable', false
            )
        when evidence.task->>'operationKey' = 'content_writing'
          and evidence.writing_status = 'failed' then
            evidence.task || jsonb_build_object(
              'status', 'failed',
              'scheduled', false,
              'scheduleAt', null,
              'reasonCode', 'task_failed',
              'reason', coalesce(
                nullif(evidence.writing_error, ''),
                nullif(evidence.task->>'reason', ''),
                'The last automatic writing task failed.'
              ),
              'manualReview', true,
              'runnable', false
            )
        else evidence.task
      end as task
    from evidence
    where not (
      evidence.task->>'operationKey' = 'content_writing'
      and evidence.writing_status = 'completed'
    )
  )
  select coalesce(jsonb_agg(normalized.task order by normalized.ordinality), '[]'::jsonb)
  from normalized;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 9;
$$;

revoke all on function public.get_visible_automation_task_inventory(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory(uuid)
  to service_role;

comment on function public.get_visible_automation_task_inventory(uuid) is
  'Returns schema-v8 readiness inventory with terminal writing states normalized so cancelled manual supersession is never reported as runnable or eligible.';

notify pgrst, 'reload schema';

commit;
