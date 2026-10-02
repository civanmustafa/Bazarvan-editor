begin;

-- Preserve the current-blocker inventory and enrich every unfinished task
-- with machine-readable prerequisite evidence. The UI can now say exactly
-- what is missing and distinguish missing data from a busy article focus.
alter function public.get_visible_automation_task_inventory(uuid)
  rename to get_visible_automation_task_inventory_v15;

revoke all on function public.get_visible_automation_task_inventory_v15(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory_v15(uuid)
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
  with configuration as (
    select greatest(2, least(5, case
      when coalesce(setting.value->>'contentWritingAutomationMinimumCompetitors', '') ~ '^\d+$'
        then (setting.value->>'contentWritingAutomationMinimumCompetitors')::integer
      else 3
    end)) as minimum_competitors
    from public.app_settings as setting
    where setting.key = 'ai'
  ), config as (
    select coalesce((select minimum_competitors from configuration), 3) as minimum_competitors
  ), source as (
    select entry.value as task, entry.ordinality
    from jsonb_array_elements(coalesce(
      public.get_visible_automation_task_inventory_v15(p_requested_by),
      '[]'::jsonb
    )) with ordinality as entry(value, ordinality)
  ), evidence as (
    select source.*,
      article.keywords,
      public.article_editor_has_text(article.plain_text) as editor_has_text,
      policy.value as policy,
      coalesce(competitors.total_count, 0) as competitor_total_count,
      coalesce(competitors.ready_count, 0) as competitor_ready_count,
      config.minimum_competitors,
      coalesce(keyword_counts.alternatives, 0) as alternatives_count,
      coalesce(keyword_counts.lsi, 0) as lsi_count,
      coalesce(keyword_counts.google_titles, 0) as google_titles_count,
      coalesce(keyword_counts.google_descriptions, 0) as google_descriptions_count,
      focus.article_id as focus_article_id,
      focus.current_stage as focus_stage,
      focus.state as focus_state,
      case
        when focus.article_id is not null
          and public.article_access_level_for_user(focus.article_id, p_requested_by) <> 'none'
          then focus_article.title
        else null
      end as focus_article_title
    from source
    join public.articles as article
      on article.id = (source.task->>'articleId')::uuid
    cross join config
    cross join lateral (
      select public.article_automation_policy(article.id) as value
    ) as policy
    cross join lateral (
      select
        (select count(*)::integer from jsonb_array_elements_text(
          case when jsonb_typeof(article.keywords->'secondaries') = 'array'
            then article.keywords->'secondaries' else '[]'::jsonb end
        ) as item(value) where nullif(btrim(item.value), '') is not null) as alternatives,
        (select count(*)::integer from jsonb_array_elements_text(
          case when jsonb_typeof(article.keywords->'lsi') = 'array'
            then article.keywords->'lsi' else '[]'::jsonb end
        ) as item(value) where nullif(btrim(item.value), '') is not null) as lsi,
        (select count(*)::integer from jsonb_array_elements_text(
          case when jsonb_typeof(article.keywords->'googleTitles') = 'array'
            then article.keywords->'googleTitles' else '[]'::jsonb end
        ) as item(value) where nullif(btrim(item.value), '') is not null) as google_titles,
        (select count(*)::integer from jsonb_array_elements(
          case when jsonb_typeof(article.keywords->'googleDescriptions') = 'array'
            then article.keywords->'googleDescriptions' else '[]'::jsonb end
        ) as item(value) where nullif(btrim(case
          when jsonb_typeof(item.value) = 'object' then item.value->>'text'
          else item.value #>> '{}'
        end), '') is not null) as google_descriptions
    ) as keyword_counts
    left join lateral (
      select count(*)::integer as total_count,
        count(*) filter (
          where competitor.status = 'completed'
            and nullif(btrim(coalesce(competitor.content_text, '')), '') is not null
        )::integer as ready_count
      from public.article_competitors as competitor
      where competitor.article_id = article.id
    ) as competitors on true
    left join public.automatic_article_focus as focus
      on focus.singleton is true
    left join public.articles as focus_article
      on focus_article.id = focus.article_id
  ), requirements as (
    select evidence.*,
      coalesce(base_requirements.value, '[]'::jsonb)
      || case evidence.task->>'operationKey'
        when 'alternative_keywords' then jsonb_build_array(jsonb_build_object(
          'code', 'alternative_keywords',
          'state', case when evidence.alternatives_count > 0 then 'complete' else 'missing' end,
          'current', evidence.alternatives_count, 'required', 1
        ))
        when 'lsi_keywords' then jsonb_build_array(jsonb_build_object(
          'code', 'lsi_keywords',
          'state', case when evidence.lsi_count > 0 then 'complete' else 'missing' end,
          'current', evidence.lsi_count, 'required', 1
        ))
        when 'google_metadata' then jsonb_build_array(
          jsonb_build_object(
            'code', 'google_titles',
            'state', case when evidence.google_titles_count >= 2 then 'complete' else 'missing' end,
            'current', evidence.google_titles_count, 'required', 2
          ),
          jsonb_build_object(
            'code', 'google_descriptions',
            'state', case when evidence.google_descriptions_count >= 2 then 'complete' else 'missing' end,
            'current', evidence.google_descriptions_count, 'required', 2
          )
        )
        when 'competitor_discovery' then jsonb_build_array(
          jsonb_build_object(
            'code', 'primary_keyword',
            'state', case when nullif(btrim(coalesce(evidence.keywords->>'primary', '')), '') is not null
              then 'complete' else 'missing' end,
            'current', case when nullif(btrim(coalesce(evidence.keywords->>'primary', '')), '') is not null
              then 1 else 0 end, 'required', 1
          ),
          jsonb_build_object(
            'code', 'alternative_keywords',
            'state', case
              when not coalesce((evidence.policy->>'autoGenerateAlternativeKeywords')::boolean, false)
                or evidence.alternatives_count > 0 then 'complete' else 'missing' end,
            'current', evidence.alternatives_count, 'required', case
              when coalesce((evidence.policy->>'autoGenerateAlternativeKeywords')::boolean, false)
                then 1 else 0 end
          ),
          jsonb_build_object(
            'code', 'lsi_keywords',
            'state', case
              when not coalesce((evidence.policy->>'autoGenerateLsiKeywords')::boolean, false)
                or evidence.lsi_count > 0 then 'complete' else 'missing' end,
            'current', evidence.lsi_count, 'required', case
              when coalesce((evidence.policy->>'autoGenerateLsiKeywords')::boolean, false)
                then 1 else 0 end
          ),
          jsonb_build_object(
            'code', 'google_metadata',
            'state', case
              when not coalesce((evidence.policy->>'autoGenerateGoogleMetadata')::boolean, false)
                or (evidence.google_titles_count >= 2 and evidence.google_descriptions_count >= 2)
                then 'complete' else 'missing' end,
            'current', least(evidence.google_titles_count, evidence.google_descriptions_count),
            'required', case when coalesce(
              (evidence.policy->>'autoGenerateGoogleMetadata')::boolean, false
            ) then 2 else 0 end
          )
        )
        when 'competitor_extraction' then jsonb_build_array(
          jsonb_build_object(
            'code', 'competitor_urls',
            'state', case when evidence.competitor_total_count >= evidence.minimum_competitors
              then 'complete' else 'missing' end,
            'current', evidence.competitor_total_count,
            'required', evidence.minimum_competitors
          ),
          jsonb_build_object(
            'code', 'competitor_texts',
            'state', case when evidence.competitor_ready_count >= evidence.minimum_competitors
              then 'complete' else 'missing' end,
            'current', evidence.competitor_ready_count,
            'required', evidence.minimum_competitors
          )
        )
        when 'content_writing' then jsonb_build_array(
          jsonb_build_object(
            'code', 'competitor_texts',
            'state', case when evidence.competitor_ready_count >= evidence.minimum_competitors
              then 'complete' else 'missing' end,
            'current', evidence.competitor_ready_count,
            'required', evidence.minimum_competitors
          )
        )
        when 'duplicate_suggestions' then jsonb_build_array(jsonb_build_object(
          'code', 'editor_text',
          'state', case when evidence.editor_has_text then 'complete' else 'missing' end,
          'current', case when evidence.editor_has_text then 1 else 0 end,
          'required', 1
        ))
        else '[]'::jsonb
      end
      || case
        when evidence.focus_article_id is not null
          and evidence.focus_article_id <> (evidence.task->>'articleId')::uuid
          and evidence.focus_state in ('active', 'waiting_retry', 'needs_attention')
        then jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'code', 'automatic_article_focus',
          'state', 'blocked',
          'articleId', evidence.focus_article_id,
          'articleTitle', evidence.focus_article_title,
          'stage', evidence.focus_stage
        )))
        else '[]'::jsonb
      end as requirement_details,
      evidence.focus_article_id is not null
        and evidence.focus_article_id <> (evidence.task->>'articleId')::uuid
        and evidence.focus_state in ('active', 'waiting_retry', 'needs_attention')
        as blocked_by_focus
    from evidence
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'code', missing.value,
        'state', 'missing'
      )) as value
      from jsonb_array_elements_text(coalesce(
        evidence.task->'missingFields', '[]'::jsonb
      )) as missing(value)
    ) as base_requirements on true
  ), projected as (
    select requirements.ordinality,
      requirements.task || jsonb_strip_nulls(jsonb_build_object(
        'requirements', requirements.requirement_details,
        'reasonCode', case
          when requirements.blocked_by_focus
            and requirements.task->>'status' = 'unscheduled'
            then 'automatic_article_focus'
          else requirements.task->>'reasonCode'
        end,
        'blockedByArticleId', case when requirements.blocked_by_focus
          then requirements.focus_article_id else null end,
        'blockedByArticleTitle', case when requirements.blocked_by_focus
          then requirements.focus_article_title else null end,
        'blockedByStage', case when requirements.blocked_by_focus
          then requirements.focus_stage else null end,
        'blockedByState', case when requirements.blocked_by_focus
          then requirements.focus_state else null end
      )) as task
    from requirements
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
  select 16;
$$;

revoke all on function public.get_visible_automation_task_inventory(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory(uuid)
  to service_role;

comment on function public.get_visible_automation_task_inventory(uuid) is
  'Returns unfinished draft automation tasks with exact prerequisite counts and the distinct article-focus blocker.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 16 with detailed automation prerequisites.';

notify pgrst, 'reload schema';

commit;
