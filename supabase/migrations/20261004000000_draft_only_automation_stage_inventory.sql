begin;

-- The dashboard automation-stage inventory is an operational view for work
-- that can still be edited. Keep it strictly scoped to articles whose current
-- status is draft, while preserving the requester access boundary implemented
-- by the raw inventory function.
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
      article.status as article_status,
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
    where evidence.article_status = 'draft'
      and not (
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
        'articleStatus', filtered.article_status,
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
  'Returns visible unfinished automation tasks for draft articles only, excluding work already satisfied by current saved evidence.';

notify pgrst, 'reload schema';

commit;
