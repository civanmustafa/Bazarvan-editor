begin;

-- Competitor discovery is a programmatic Firecrawl/search path. It must not
-- wait for Gemini-generated alternatives, LSI terms, or Google metadata.
-- Its complete input contract is deliberately small and explicit:
-- draft + title + primary keyword + company + page goal context.
create or replace function public.evaluate_competitor_discovery_readiness(
  p_status text,
  p_title text,
  p_keywords jsonb,
  p_goal_context jsonb,
  p_article_language text
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_primary_keyword text := btrim(coalesce(p_keywords->>'primary', ''));
  v_company_name text := btrim(coalesce(p_keywords->>'company', ''));
  v_has_goal_context boolean :=
    nullif(btrim(coalesce(p_goal_context->>'pageType', '')), '') is not null
    and nullif(btrim(coalesce(p_goal_context->>'objective', '')), '') is not null;
  v_missing_fields jsonb := '[]'::jsonb;
  v_signature text;
begin
  if coalesce(p_status, '') <> 'draft' then
    v_missing_fields := v_missing_fields || jsonb_build_array('draft_status');
  end if;
  if v_title = '' or lower(v_title) in ('(untitled)', 'untitled') then
    v_missing_fields := v_missing_fields || jsonb_build_array('article_title');
  end if;
  if v_primary_keyword = '' then
    v_missing_fields := v_missing_fields || jsonb_build_array('primary_keyword');
  end if;
  if not v_has_goal_context then
    v_missing_fields := v_missing_fields || jsonb_build_array('goal_context');
  end if;
  if v_company_name = '' then
    v_missing_fields := v_missing_fields || jsonb_build_array('company_name');
  end if;

  v_signature := md5(jsonb_build_object(
    'status', coalesce(p_status, ''),
    'queryType', 'primary_keyword',
    'queryText', v_primary_keyword,
    'articleTitle', v_title,
    'primaryKeyword', v_primary_keyword,
    'companyName', v_company_name,
    'articleLanguage', case when p_article_language = 'en' then 'en' else 'ar' end,
    'pageType', coalesce(p_goal_context->>'pageType', ''),
    'objective', coalesce(p_goal_context->>'objective', ''),
    'searchIntent', coalesce(p_goal_context->>'searchIntent', ''),
    'audienceScope', coalesce(p_goal_context->>'audienceScope', ''),
    'targetCountry', coalesce(p_goal_context->>'targetCountry', '')
  )::text);

  return jsonb_build_object(
    'ready', jsonb_array_length(v_missing_fields) = 0,
    'missingFields', v_missing_fields,
    'signature', v_signature,
    'queryType', 'primary_keyword',
    'queryText', v_primary_keyword,
    'executionPath', 'programmatic_competitor_research'
  );
end;
$$;

-- The existing automatic coordinator remains the only scheduler. This wrapper
-- now admits discovery solely from its own readiness contract and policy; it
-- never inspects semantic jobs or AI-generated keyword lists.
create or replace function public.enqueue_competitor_discovery_job_by_signature(
  p_article_id uuid,
  p_requested_by uuid default null,
  p_origin text default 'auto'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_manual boolean := lower(btrim(coalesce(p_origin, 'auto'))) = 'manual';
  v_policy jsonb := public.article_automation_policy(p_article_id);
  v_current_signature text;
  v_job_id uuid;
begin
  if not v_manual
     and (
       not coalesce((v_policy->>'enabled')::boolean, false)
       or not coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
     ) then
    return null;
  end if;

  select nullif(state.competitor_discovery_signature, '')
  into v_current_signature
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id
    and state.competitor_discovery_ready;

  if v_current_signature is null then
    perform public.cancel_stale_competitor_discovery_jobs(p_article_id, null);
    return null;
  end if;

  perform public.cancel_stale_competitor_discovery_jobs(
    p_article_id,
    v_current_signature
  );

  v_job_id := public.enqueue_competitor_discovery_job(
    p_article_id,
    p_requested_by,
    case when v_manual then 'manual' else 'auto' end
  );

  if v_job_id is not null then
    update public.ai_external_analysis_jobs as job
    set
      requested_by = coalesce(p_requested_by, job.requested_by),
      origin = case when v_manual then 'manual' else 'auto' end,
      cancel_requested_at = null,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'executionPath', 'programmatic_competitor_research',
        'providerClass', 'search_not_generative_ai',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.id = v_job_id;
  end if;

  return v_job_id;
end;
$$;

-- The finish-first lane is reserved for stages that consume generative-AI or
-- post-writing work. Discovery remains in the same queue and coordinator, but
-- it can be claimed while the AI lane is cooling down or awaiting review.
create or replace function public.automatic_article_focus_controls_job_type(
  p_job_type text
)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(p_job_type, '') in (
    'semantic_keywords_lsi',
    'competitor_extraction',
    'content_writing_preparation',
    'content_writing',
    'duplicate_cleanup',
    'engineering_command'
  );
$$;

-- Legacy articles still use the same master coordinator. Only the obsolete
-- dependency on alternatives/LSI is removed from its cancellation rules.
create or replace function public.reconcile_legacy_content_research_automation()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := public.get_content_research_automation_settings();
  v_auto_secondaries boolean := coalesce(
    (v_settings->>'autoGenerateAlternativeKeywords')::boolean,
    true
  );
  v_auto_lsi boolean := coalesce(
    (v_settings->>'autoGenerateLsiKeywords')::boolean,
    true
  );
  v_auto_competitors boolean := coalesce(
    (v_settings->>'autoDiscoverCompetitors')::boolean,
    true
  );
  v_article_id uuid;
begin
  update public.ai_external_analysis_jobs as job
  set
    status = case when job.status = 'running' then 'running' else 'cancelled' end,
    cancel_requested_at = coalesce(job.cancel_requested_at, now()),
    next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
    locked_by = case when job.status = 'running' then job.locked_by else null end,
    locked_at = case when job.status = 'running' then job.locked_at else null end,
    lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
    completed_at = case when job.status = 'running'
      then job.completed_at else coalesce(job.completed_at, now()) end,
    last_error_code = case when v_auto_competitors
      then 'competitor_discovery_input_changed'
      else 'competitor_automation_disabled' end,
    last_error = case when v_auto_competitors
      then 'Automatic competitor discovery is waiting for its own article inputs.'
      else 'Automatic competitor discovery was disabled.' end,
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', case when job.status = 'running'
        then 'cancellation_requested' else 'cancelled' end,
      'reason', case when v_auto_competitors
        then 'competitor_discovery_input_changed'
        else 'competitor_automation_disabled' end,
      'updatedAt', now()
    ),
    updated_at = now()
  from public.articles as article
  left join public.ai_external_analysis_article_state as state
    on state.article_id = article.id
  where article.id = job.article_id
    and article.automation_policy_version = 0
    and job.origin = 'auto'
    and job.job_type = 'competitor_discovery'
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    )
    and (
      not v_auto_competitors
      or not coalesce(state.competitor_discovery_ready, false)
    );

  if not v_auto_competitors then
    update public.ai_external_analysis_jobs as job
    set
      status = case when job.status = 'running' then 'running' else 'cancelled' end,
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
      locked_by = case when job.status = 'running' then job.locked_by else null end,
      locked_at = case when job.status = 'running' then job.locked_at else null end,
      lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
      completed_at = case when job.status = 'running'
        then job.completed_at else coalesce(job.completed_at, now()) end,
      last_error_code = 'competitor_automation_disabled',
      last_error = 'Automatic competitor preparation was disabled.',
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.status = 'running'
          then 'cancellation_requested' else 'cancelled' end,
        'reason', 'competitor_automation_disabled',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.origin = 'auto'
      and exists (
        select 1 from public.articles as article
        where article.id = job.article_id
          and article.automation_policy_version = 0
      )
      and job.job_type in ('competitor_extraction', 'content_writing_preparation')
      and job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      );
  end if;

  update public.ai_external_analysis_jobs as job
  set
    status = case when job.status = 'running' then 'running' else 'cancelled' end,
    cancel_requested_at = coalesce(job.cancel_requested_at, now()),
    next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
    locked_by = case when job.status = 'running' then job.locked_by else null end,
    locked_at = case when job.status = 'running' then job.locked_at else null end,
    lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
    completed_at = case when job.status = 'running'
      then job.completed_at else coalesce(job.completed_at, now()) end,
    last_error_code = 'semantic_automation_disabled',
    last_error = 'No enabled automatic semantic target remains for this article.',
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', case when job.status = 'running'
        then 'cancellation_requested' else 'cancelled' end,
      'reason', 'semantic_automation_disabled',
      'updatedAt', now()
    ),
    updated_at = now()
  from public.articles as article
  where article.id = job.article_id
    and article.automation_policy_version = 0
    and job.origin = 'auto'
    and job.job_type = 'semantic_keywords_lsi'
    and job.pipeline_parent_job_id is null
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    )
    and not (
      (
        v_auto_secondaries
        and not public.external_analysis_has_competitor_value(
          article.keywords->'secondaries',
          100
        )
      )
      or (
        v_auto_lsi
        and not public.external_analysis_has_competitor_value(
          article.keywords->'lsi',
          100
        )
      )
      or (
        (v_auto_secondaries or v_auto_lsi)
        and not public.semantic_keywords_have_google_metadata(
          coalesce(article.keywords, '{}'::jsonb)
        )
      )
    );

  if v_auto_secondaries or v_auto_lsi then
    for v_article_id in
      select state.article_id
      from public.ai_external_analysis_article_state as state
      join public.articles as article
        on article.id = state.article_id
       and article.automation_policy_version = 0
      where state.semantic_ready
      order by state.article_id
    loop
      perform public.enqueue_external_semantic_analysis_job_controlled(
        v_article_id,
        'auto'
      );
    end loop;
  end if;

  if v_auto_competitors then
    for v_article_id in
      select state.article_id
      from public.ai_external_analysis_article_state as state
      join public.articles as article
        on article.id = state.article_id
       and article.automation_policy_version = 0
      where state.competitor_discovery_ready
      order by state.article_id
    loop
      perform public.enqueue_competitor_discovery_job_controlled(
        v_article_id,
        null,
        'auto'
      );
    end loop;
  end if;
end;
$$;

-- Re-evaluate every saved article against the independent contract. Existing
-- article triggers use this same function for immediate scheduling on edits.
insert into public.ai_external_analysis_article_state (
  article_id,
  competitor_discovery_ready,
  competitor_discovery_missing_fields,
  competitor_discovery_signature,
  last_article_updated_at,
  last_evaluated_at
)
select
  article.id,
  coalesce((readiness.value->>'ready')::boolean, false),
  coalesce(readiness.value->'missingFields', '[]'::jsonb),
  coalesce(readiness.value->>'signature', ''),
  article.updated_at,
  now()
from public.articles as article
cross join lateral (
  select public.evaluate_competitor_discovery_readiness(
    article.status,
    article.title,
    article.keywords,
    article.goal_context,
    article.article_language
  ) as value
) as readiness
on conflict (article_id) do update
set
  competitor_discovery_ready = excluded.competitor_discovery_ready,
  competitor_discovery_missing_fields = excluded.competitor_discovery_missing_fields,
  competitor_discovery_signature = excluded.competitor_discovery_signature,
  last_article_updated_at = excluded.last_article_updated_at,
  last_evaluated_at = excluded.last_evaluated_at,
  updated_at = now();

-- A discovery row previously parked only by the AI focus can now run. This is
-- a state correction, not a second scheduler or a duplicate job creation.
update public.ai_external_analysis_jobs as job
set
  status = 'queued',
  next_attempt_at = now(),
  cancel_requested_at = null,
  last_error_code = null,
  last_error = null,
  progress = coalesce(job.progress, '{}'::jsonb)
    - 'blockedBy'
    - 'focusPause'
    || jsonb_build_object(
      'stage', 'queued',
      'executionPath', 'programmatic_competitor_research',
      'providerClass', 'search_not_generative_ai',
      'independentFromAiFocus', true,
      'updatedAt', now()
    ),
  updated_at = now()
from public.ai_external_analysis_article_state as state,
     public.articles as article
where state.article_id = job.article_id
  and article.id = job.article_id
  and state.competitor_discovery_ready
  and job.job_type = 'competitor_discovery'
  and job.origin = 'auto'
  and job.pipeline_parent_job_id is null
  and job.status = 'waiting_for_prerequisites'
  and job.attempt_count = 0
  and job.result is null
  and public.article_automatic_policy_allows(
    article.id,
    'competitor_discovery'
  )
  and (
    article.automation_policy_version = 1
    or coalesce((
      public.get_content_research_automation_settings()
        ->>'autoDiscoverCompetitors'
    )::boolean, true)
  );

-- Replace the obsolete alternatives/LSI/Google list in the task dialog with
-- the five real discovery inputs. Cross-article AI focus blockers are removed
-- because this path is independently claimable.
alter function public.get_visible_automation_task_inventory(uuid)
  rename to get_visible_automation_task_inventory_v20;

revoke all on function public.get_visible_automation_task_inventory_v20(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory_v20(uuid)
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
      public.get_visible_automation_task_inventory_v20(p_requested_by),
      '[]'::jsonb
    )) with ordinality as entry(value, ordinality)
  ), evidence as (
    select source.*,
      article.status,
      article.title,
      article.keywords,
      article.goal_context,
      coalesce(state.competitor_discovery_ready, false) as discovery_ready,
      coalesce(
        state.competitor_discovery_missing_fields,
        '[]'::jsonb
      ) as discovery_missing
    from source
    join public.articles as article
      on article.id = (source.task->>'articleId')::uuid
    left join public.ai_external_analysis_article_state as state
      on state.article_id = article.id
  ), projected as (
    select evidence.ordinality,
      case when evidence.task->>'operationKey' = 'competitor_discovery' then
        (
          evidence.task
          - 'blockedByArticleId'
          - 'blockedByArticleTitle'
          - 'blockedByStage'
          - 'blockedByState'
          - 'upstreamStage'
          - 'upstreamState'
        ) || jsonb_build_object(
          'missingFields', evidence.discovery_missing,
          'requirements', jsonb_build_array(
            jsonb_build_object(
              'code', 'draft_status',
              'state', case when evidence.status = 'draft'
                then 'complete' else 'missing' end,
              'current', case when evidence.status = 'draft' then 1 else 0 end,
              'required', 1
            ),
            jsonb_build_object(
              'code', 'article_title',
              'state', case when nullif(btrim(coalesce(evidence.title, '')), '') is not null
                  and lower(btrim(evidence.title)) not in ('(untitled)', 'untitled')
                then 'complete' else 'missing' end,
              'current', case when nullif(btrim(coalesce(evidence.title, '')), '') is not null
                  and lower(btrim(evidence.title)) not in ('(untitled)', 'untitled')
                then 1 else 0 end,
              'required', 1
            ),
            jsonb_build_object(
              'code', 'primary_keyword',
              'state', case when nullif(btrim(coalesce(
                evidence.keywords->>'primary', ''
              )), '') is not null then 'complete' else 'missing' end,
              'current', case when nullif(btrim(coalesce(
                evidence.keywords->>'primary', ''
              )), '') is not null then 1 else 0 end,
              'required', 1
            ),
            jsonb_build_object(
              'code', 'goal_context',
              'state', case when
                nullif(btrim(coalesce(evidence.goal_context->>'pageType', '')), '') is not null
                and nullif(btrim(coalesce(evidence.goal_context->>'objective', '')), '') is not null
                then 'complete' else 'missing' end,
              'current', case when
                nullif(btrim(coalesce(evidence.goal_context->>'pageType', '')), '') is not null
                and nullif(btrim(coalesce(evidence.goal_context->>'objective', '')), '') is not null
                then 1 else 0 end,
              'required', 1
            ),
            jsonb_build_object(
              'code', 'company_name',
              'state', case when nullif(btrim(coalesce(
                evidence.keywords->>'company', ''
              )), '') is not null then 'complete' else 'missing' end,
              'current', case when nullif(btrim(coalesce(
                evidence.keywords->>'company', ''
              )), '') is not null then 1 else 0 end,
              'required', 1
            )
          ),
          'reasonCode', case when evidence.discovery_ready
            then evidence.task->>'reasonCode'
            else 'waiting_for_prerequisites' end,
          'executionPath', 'programmatic_competitor_research',
          'independentFromAiFocus', true
        )
      else evidence.task end as task
    from evidence
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
  select 21;
$$;

-- Run the existing master once so already-ready drafts are reserved now.
select public.reconcile_content_research_automation();

revoke all on function public.evaluate_competitor_discovery_readiness(text,text,jsonb,jsonb,text)
  from public, anon, authenticated;
revoke all on function public.enqueue_competitor_discovery_job_by_signature(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.enqueue_competitor_discovery_job_by_signature(uuid,uuid,text)
  to service_role;
revoke all on function public.automatic_article_focus_controls_job_type(text)
  from public, anon, authenticated;
grant execute on function public.automatic_article_focus_controls_job_type(text)
  to service_role;
revoke all on function public.reconcile_legacy_content_research_automation()
  from public, anon, authenticated;
grant execute on function public.reconcile_legacy_content_research_automation()
  to service_role;
revoke all on function public.get_visible_automation_task_inventory(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory(uuid)
  to service_role;

comment on function public.evaluate_competitor_discovery_readiness(text,text,jsonb,jsonb,text) is
  'Evaluates the independent non-generative competitor-search contract: draft, title, primary keyword, company, and goal context.';
comment on function public.enqueue_competitor_discovery_job_by_signature(uuid,uuid,text) is
  'Queues programmatic competitor discovery without waiting for Gemini, alternatives, LSI, or Google metadata.';
comment on function public.automatic_article_focus_controls_job_type(text) is
  'Identifies generative/post-writing stages controlled by the finish-first lane; programmatic competitor discovery is independent.';
comment on function public.get_visible_automation_task_inventory(uuid) is
  'Returns draft automation tasks with the exact independent competitor-discovery requirements.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 21 with independent programmatic competitor discovery.';

notify pgrst, 'reload schema';

commit;
