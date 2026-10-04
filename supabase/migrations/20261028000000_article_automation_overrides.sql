begin;

create table if not exists public.article_automation_overrides (
  article_id uuid primary key references public.articles(id) on delete cascade,
  disabled_capabilities text[] not null default array[]::text[],
  writing_mode text not null default 'strict',
  excluded_external_command_ids text[] not null default array[]::text[],
  reason text,
  revision bigint not null default 1,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint article_automation_overrides_writing_mode_check
    check (writing_mode in ('strict', 'available_inputs', 'manual_only')),
  constraint article_automation_overrides_reason_length_check
    check (char_length(coalesce(reason, '')) <= 1000),
  constraint article_automation_overrides_capabilities_check
    check (disabled_capabilities <@ array[
      'autoGenerateAlternativeKeywords',
      'autoGenerateLsiKeywords',
      'autoGenerateGoogleMetadata',
      'autoDiscoverCompetitors',
      'autoExtractCompetitorContent',
      'autoRunReadyEngineeringCommands',
      'contentWritingAutomationEnabled',
      'autoApplyStrongInternalLinkSuggestions'
    ]::text[])
);

alter table public.article_automation_overrides enable row level security;
revoke all on public.article_automation_overrides from public, anon, authenticated;
grant all on public.article_automation_overrides to service_role;

drop trigger if exists set_article_automation_overrides_updated_at
  on public.article_automation_overrides;
create trigger set_article_automation_overrides_updated_at
before update on public.article_automation_overrides
for each row execute function public.set_updated_at();

-- Per-article settings are restrictive overlays. They can never enable a
-- capability disabled by the administrator or the original creator.
create or replace function public.article_automation_policy(p_article_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_limits jsonb := public.article_automation_admin_limits();
  v_personal jsonb;
  v_result jsonb;
  v_key text;
  v_enabled boolean;
  v_override public.article_automation_overrides%rowtype;
  v_command_ids jsonb := '[]'::jsonb;
  v_competitor_comparison_id constant text := 'smartAnalysis.competitorContentComparison';
begin
  select * into v_article from public.articles where id = p_article_id;
  if not found then raise exception 'Article was not found.' using errcode = 'P0002'; end if;

  if v_article.automation_policy_version = 0 then
    v_result := v_limits || jsonb_build_object(
      'policyVersion', 0,
      'scope', 'legacy',
      'creatorUserId', v_article.created_by,
      'externalAnalysisCommandIds', to_jsonb(public.get_external_analysis_default_command_ids()),
      'autoGenerateGoogleMetadata',
        (v_limits->>'autoGenerateAlternativeKeywords')::boolean
        or (v_limits->>'autoGenerateLsiKeywords')::boolean
    );
  else
    select preferences into v_personal
    from public.user_automation_settings
    where user_id = v_article.automation_creator_id;
    v_personal := coalesce(
      v_personal,
      public.normalize_user_automation_preferences('{"enabled":false}'::jsonb)
    );
    v_enabled := (v_personal->>'enabled')::boolean and exists (
      select 1 from public.profiles
      where id = v_article.automation_creator_id and is_active is true
    );
    v_result := v_personal || jsonb_build_object('enabled', v_enabled);
    for v_key in select jsonb_object_keys(v_limits) loop
      if v_key not in ('schemaVersion', 'enabled', 'externalAnalysisCommandIds') then
        v_result := jsonb_set(v_result, array[v_key], to_jsonb(
          v_enabled
          and coalesce((v_limits->>v_key)::boolean, false)
          and coalesce((v_personal->>v_key)::boolean, false)
        ));
      end if;
    end loop;
    v_result := v_result || jsonb_build_object(
      'policyVersion', 1,
      'scope', 'creator',
      'creatorUserId', v_article.automation_creator_id
    );
  end if;

  select * into v_override
  from public.article_automation_overrides
  where article_id = p_article_id;

  if not found then
    return v_result || jsonb_build_object(
      'articleOverrideVersion', 0,
      'articleWritingMode', 'strict',
      'disabledCapabilities', '[]'::jsonb,
      'excludedExternalCommandIds', '[]'::jsonb
    );
  end if;

  foreach v_key in array v_override.disabled_capabilities loop
    v_result := jsonb_set(v_result, array[v_key], 'false'::jsonb, true);
  end loop;

  if v_override.writing_mode = 'manual_only' then
    v_result := jsonb_set(v_result, '{contentWritingAutomationEnabled}', 'false'::jsonb, true);
  end if;

  select coalesce(jsonb_agg(command_id order by ordinal), '[]'::jsonb)
  into v_command_ids
  from jsonb_array_elements_text(
    coalesce(v_result->'externalAnalysisCommandIds', '[]'::jsonb)
  ) with ordinality as command(command_id, ordinal)
  where not (command_id = any(coalesce(v_override.excluded_external_command_ids, array[]::text[])))
    and not (
      v_override.writing_mode = 'available_inputs'
      and command_id = v_competitor_comparison_id
    );

  v_result := jsonb_set(v_result, '{externalAnalysisCommandIds}', v_command_ids, true);
  if jsonb_array_length(v_command_ids) = 0 then
    v_result := jsonb_set(v_result, '{autoRunReadyEngineeringCommands}', 'false'::jsonb, true);
  end if;

  return v_result || jsonb_build_object(
    'articleOverrideVersion', 1,
    'articleWritingMode', v_override.writing_mode,
    'disabledCapabilities', to_jsonb(v_override.disabled_capabilities),
    'excludedExternalCommandIds', to_jsonb(v_override.excluded_external_command_ids),
    'articleOverrideReason', coalesce(v_override.reason, ''),
    'articleOverrideRevision', v_override.revision,
    'articleOverrideUpdatedAt', v_override.updated_at
  );
end;
$$;

create or replace function public.article_automatic_policy_allows(
  p_article_id uuid,
  p_job_type text,
  p_command_id text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_policy jsonb;
begin
  if p_article_id is null
     or not exists (select 1 from public.articles where id = p_article_id)
     or public.article_is_globally_trashed(p_article_id) then
    return false;
  end if;

  v_policy := public.article_automation_policy(p_article_id);
  if coalesce((v_policy->>'policyVersion')::integer, 0) = 0
     and coalesce((v_policy->>'articleOverrideVersion')::integer, 0) = 0 then
    return true;
  end if;
  if not coalesce((v_policy->>'enabled')::boolean, false) then return false; end if;
  return case p_job_type
    when 'semantic_keywords_lsi' then coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false)
      or coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false)
      or coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false)
    when 'competitor_discovery' then coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
    when 'competitor_extraction' then coalesce((v_policy->>'autoExtractCompetitorContent')::boolean, false)
    when 'engineering_command' then coalesce((v_policy->>'autoRunReadyEngineeringCommands')::boolean, false)
      and coalesce(v_policy->'externalAnalysisCommandIds', '[]'::jsonb) ? coalesce(p_command_id, '')
    when 'content_writing_preparation' then coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false)
      and coalesce(v_policy->>'articleWritingMode', 'strict') = 'strict'
      and coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
      and coalesce((v_policy->>'autoExtractCompetitorContent')::boolean, false)
    when 'content_writing' then coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false)
    when 'duplicate_cleanup' then true
    else false
  end;
end;
$$;

create or replace function public.automatic_content_writing_requirement(p_article_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_policy jsonb := '{}'::jsonb;
begin
  select article.* into v_article from public.articles as article where article.id = p_article_id;
  if v_article.id is null then
    return jsonb_build_object('required', false, 'reason', 'article_not_found');
  end if;
  if nullif(btrim(v_article.metadata #>> '{trash,deletedAt}'), '') is not null then
    return jsonb_build_object('required', false, 'reason', 'article_trashed');
  end if;
  if coalesce(v_article.status, '') not in ('draft', 'content_preparation') then
    return jsonb_build_object('required', false, 'reason', 'article_left_automation_scope');
  end if;
  v_policy := public.article_automation_policy(p_article_id);
  if not coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false) then
    return jsonb_build_object(
      'required', false,
      'reason', 'article_writing_automation_disabled',
      'writingMode', coalesce(v_policy->>'articleWritingMode', 'strict')
    );
  end if;
  if public.article_body_has_content(v_article.content_json, v_article.content_html, v_article.plain_text) then
    return jsonb_build_object('required', false, 'reason', 'article_editor_not_empty');
  end if;
  if exists (
    select 1 from public.content_writing_sessions as session
    where session.article_id = p_article_id and session.status = 'completed'
  ) then
    return jsonb_build_object('required', false, 'reason', 'content_writing_already_completed');
  end if;
  return jsonb_build_object(
    'required', true,
    'reason', 'automatic_writing_required',
    'writingMode', coalesce(v_policy->>'articleWritingMode', 'strict')
  );
end;
$$;

-- Keep the canonical readiness calculation but remove only competitor-related
-- blockers in the explicit "available inputs" writing mode.
do $readiness_patch$
declare
  v_definition text;
  v_policy_anchor constant text := $$  v_policy := public.article_automation_policy(v_article.id);$$;
  v_policy_replacement constant text := $$  v_policy := public.article_automation_policy(v_article.id);
  v_writing_mode := coalesce(v_policy->>'articleWritingMode', 'strict');$$;
  v_processing_anchor constant text := $$  v_processing_complete := coalesce(v_pending_count, 0) = 0
    and not v_semantic_active and not v_discovery_active and not v_extraction_active;$$;
  v_processing_replacement constant text := $$  v_processing_complete := v_writing_mode = 'available_inputs' or (
    coalesce(v_pending_count, 0) = 0
    and not v_semantic_active and not v_discovery_active and not v_extraction_active
  );$$;
  v_discovery_anchor constant text := $$  if v_discovery_active then
    v_missing := v_missing || jsonb_build_array('competitor_discovery_processing');
  end if;
  if v_extraction_active or coalesce(v_pending_count, 0) > 0 then
    v_missing := v_missing || jsonb_build_array('competitor_extraction_processing');
  end if;$$;
  v_discovery_replacement constant text := $$  if v_writing_mode <> 'available_inputs' and v_discovery_active then
    v_missing := v_missing || jsonb_build_array('competitor_discovery_processing');
  end if;
  if v_writing_mode <> 'available_inputs'
     and (v_extraction_active or coalesce(v_pending_count, 0) > 0) then
    v_missing := v_missing || jsonb_build_array('competitor_extraction_processing');
  end if;$$;
  v_competitor_anchor constant text := $$  if v_usable_count < v_minimum_competitors then
    v_missing := v_missing || jsonb_build_array('competitors');
  end if;$$;
  v_competitor_replacement constant text := $$  if v_writing_mode <> 'available_inputs'
     and v_usable_count < v_minimum_competitors then
    v_missing := v_missing || jsonb_build_array('competitors');
  end if;$$;
  v_return_anchor constant text := $$    'ready', jsonb_array_length(v_missing) = 0,$$;
  v_return_replacement constant text := $$    'ready', jsonb_array_length(v_missing) = 0,
    'writingMode', v_writing_mode,$$;
begin
  select pg_get_functiondef(
    'public.evaluate_content_writing_automation_readiness(uuid)'::regprocedure
  ) into v_definition;
  if strpos(v_definition, 'v_writing_mode text') = 0 then
    v_definition := replace(
      v_definition,
      $$  v_policy jsonb := '{}'::jsonb;$$,
      $$  v_policy jsonb := '{}'::jsonb;
  v_writing_mode text := 'strict';$$
    );
    if strpos(v_definition, v_policy_anchor) = 0
       or strpos(v_definition, v_processing_anchor) = 0
       or strpos(v_definition, v_discovery_anchor) = 0
       or strpos(v_definition, v_competitor_anchor) = 0
       or strpos(v_definition, v_return_anchor) = 0 then
      raise exception 'Content-writing readiness changed; refusing unsafe override patch.';
    end if;
    v_definition := replace(v_definition, v_policy_anchor, v_policy_replacement);
    v_definition := replace(v_definition, v_processing_anchor, v_processing_replacement);
    v_definition := replace(v_definition, v_discovery_anchor, v_discovery_replacement);
    v_definition := replace(v_definition, v_competitor_anchor, v_competitor_replacement);
    v_definition := replace(v_definition, v_return_anchor, v_return_replacement);
    execute v_definition;
  end if;
end;
$readiness_patch$;

create or replace function public.list_content_writing_automation_candidates(
  p_requested_by uuid,
  p_limit integer default 10,
  p_min_competitor_count integer default 1,
  p_require_processing_complete boolean default true
)
returns table (
  article_id uuid,
  article_title text,
  article_status text,
  article_updated_at timestamptz,
  readiness jsonb,
  item_id uuid,
  item_status text,
  eligible_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select article.id, article.title, article.status, article.updated_at,
    evaluated.value, existing.id, existing.status, existing.eligible_at
  from public.articles as article
  left join public.content_writing_automation_items as existing
    on existing.article_id = article.id
  cross join lateral (
    select public.evaluate_content_writing_automation_readiness(article.id) as value
  ) as evaluated
  where public.article_access_level_for_user(article.id, p_requested_by) <> 'none'
    and article.status in ('content_preparation', 'draft')
    and nullif(btrim(article.metadata #>> '{trash,deletedAt}'), '') is null
    and public.article_automatic_policy_allows(article.id, 'content_writing')
    and coalesce((evaluated.value->>'ready')::boolean, false) is true
    and (
      evaluated.value->>'writingMode' = 'available_inputs'
      or coalesce((evaluated.value->>'usableCompetitorCount')::integer, 0)
        >= greatest(1, least(coalesce(p_min_competitor_count, 1), 5))
    )
    and (
      evaluated.value->>'writingMode' = 'available_inputs'
      or p_require_processing_complete is not true
      or coalesce((evaluated.value->>'processingComplete')::boolean, false) is true
    )
    and (existing.id is null or existing.status = 'ready')
    and (
      existing.id is not null
      or not exists (
        select 1 from public.content_writing_sessions as completed_session
        where completed_session.article_id = article.id and completed_session.status = 'completed'
      )
    )
    and not exists (
      select 1 from public.ai_external_analysis_jobs as article_pipeline
      where article_pipeline.article_id = article.id
        and article_pipeline.job_type = 'full_article_pipeline'
        and article_pipeline.status in (
          'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
        )
    )
  order by coalesce(existing.ready_at, article.updated_at, article.created_at), article.id
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

-- The durable claimer has a second competitor-count guard. Bypass only that
-- guard when the article explicitly opted into available-input writing.
do $claim_patch$
declare
  v_definition text;
  v_anchor constant text := $$    and coalesce((readiness.value ->> 'usableCompetitorCount')::integer, 0) >= v_min_competitors$$;
  v_replacement constant text := $$    and (
      readiness.value->>'writingMode' = 'available_inputs'
      or coalesce((readiness.value ->> 'usableCompetitorCount')::integer, 0) >= v_min_competitors
    )$$;
begin
  select pg_get_functiondef(
    'public.claim_next_content_writing_automation_item(text,text,text,integer,boolean,integer,integer)'::regprocedure
  ) into v_definition;
  if strpos(v_definition, v_replacement) = 0 then
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'Automatic writing claimer changed; refusing unsafe override patch.';
    end if;
    execute replace(v_definition, v_anchor, v_replacement);
  end if;
end;
$claim_patch$;

create or replace function public.save_article_automation_overrides(
  p_article_id uuid,
  p_updated_by uuid,
  p_disabled_capabilities text[] default array[]::text[],
  p_writing_mode text default 'strict',
  p_excluded_external_command_ids text[] default array[]::text[],
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_disabled text[] := coalesce(p_disabled_capabilities, array[]::text[]);
  v_excluded text[] := coalesce(p_excluded_external_command_ids, array[]::text[]);
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  v_policy jsonb;
  v_row public.article_automation_overrides%rowtype;
begin
  if p_article_id is null or not exists (select 1 from public.articles where id = p_article_id) then
    raise exception 'Article was not found.' using errcode = 'P0002';
  end if;
  if p_writing_mode not in ('strict', 'available_inputs', 'manual_only') then
    raise exception 'Invalid article writing mode.' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_disabled) as capability(value)
    where value not in (
      'autoGenerateAlternativeKeywords', 'autoGenerateLsiKeywords',
      'autoGenerateGoogleMetadata', 'autoDiscoverCompetitors',
      'autoExtractCompetitorContent', 'autoRunReadyEngineeringCommands',
      'contentWritingAutomationEnabled', 'autoApplyStrongInternalLinkSuggestions'
    )
  ) then
    raise exception 'Invalid article automation capability.' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct value order by value), array[]::text[])
  into v_disabled from unnest(v_disabled) as item(value);
  select coalesce(array_agg(distinct btrim(value) order by btrim(value)), array[]::text[])
  into v_excluded from unnest(v_excluded) as item(value) where nullif(btrim(value), '') is not null;

  if cardinality(v_disabled) = 0 and p_writing_mode = 'strict'
     and cardinality(v_excluded) = 0 and v_reason is null then
    delete from public.article_automation_overrides where article_id = p_article_id;
  else
    insert into public.article_automation_overrides (
      article_id, disabled_capabilities, writing_mode,
      excluded_external_command_ids, reason, updated_by
    ) values (
      p_article_id, v_disabled, p_writing_mode, v_excluded, v_reason, p_updated_by
    )
    on conflict (article_id) do update set
      disabled_capabilities = excluded.disabled_capabilities,
      writing_mode = excluded.writing_mode,
      excluded_external_command_ids = excluded.excluded_external_command_ids,
      reason = excluded.reason,
      updated_by = excluded.updated_by,
      revision = public.article_automation_overrides.revision + 1,
      updated_at = now();
  end if;

  v_policy := public.article_automation_policy(p_article_id);

  -- Removing an exception must make never-started work schedulable again. The
  -- same durable row is reused, so no duplicate task or second engine appears.
  update public.ai_external_analysis_jobs as job
  set
    status = 'queued',
    cancel_requested_at = null,
    next_attempt_at = now(),
    completed_at = null,
    dead_lettered_at = null,
    last_error_code = null,
    last_error = null,
    input_snapshot = case when job.job_type = 'semantic_keywords_lsi'
      then coalesce(job.input_snapshot, '{}'::jsonb) || jsonb_build_object(
        'needsSecondaries', coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false),
        'needsLsi', coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false),
        'needsGoogleMetadata', coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false),
        'automationSettings', v_policy
      ) else job.input_snapshot end,
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'queued',
      'resumedReason', 'article_automation_exception_removed',
      'updatedAt', now()
    ),
    updated_at = now()
  where job.article_id = p_article_id
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.status = 'cancelled'
    and job.last_error_code = 'article_automation_stage_excluded'
    and job.attempt_count = 0
    and coalesce(job.provider_attempt_count, 0) = 0
    and job.result is null
    and public.article_automatic_policy_allows(p_article_id, job.job_type, job.command_id);

  if coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false) then
    update public.content_writing_automation_items as item
    set status = 'ready', attempt_count = 0, eligible_at = now(), completed_at = null,
      locked_by = null, locked_at = null, lease_expires_at = null,
      next_recovery_at = null, failure_class = null,
      last_error_code = null, last_error = null, updated_at = now()
    where item.article_id = p_article_id
      and item.status = 'cancelled'
      and item.last_error_code = 'article_automation_stage_excluded';
  end if;

  update public.ai_external_analysis_jobs as job
  set
    input_snapshot = case when job.job_type = 'semantic_keywords_lsi'
      then coalesce(job.input_snapshot, '{}'::jsonb) || jsonb_build_object(
        'needsSecondaries', coalesce((job.input_snapshot->>'needsSecondaries')::boolean, true)
          and coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false),
        'needsLsi', coalesce((job.input_snapshot->>'needsLsi')::boolean, true)
          and coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false),
        'needsGoogleMetadata', coalesce((job.input_snapshot->>'needsGoogleMetadata')::boolean, true)
          and coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false),
        'automationSettings', v_policy
      ) else job.input_snapshot end,
    status = case when job.status = 'running' then 'running' else 'cancelled' end,
    cancel_requested_at = coalesce(job.cancel_requested_at, now()),
    next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
    locked_by = case when job.status = 'running' then job.locked_by else null end,
    locked_at = case when job.status = 'running' then job.locked_at else null end,
    lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
    completed_at = case when job.status = 'running' then job.completed_at else coalesce(job.completed_at, now()) end,
    last_error_code = 'article_automation_stage_excluded',
    last_error = 'This automatic stage was excluded for the article.',
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', case when job.status = 'running' then 'cancellation_requested' else 'cancelled' end,
      'reason', 'article_automation_stage_excluded',
      'updatedAt', now()
    ),
    updated_at = now()
  where job.article_id = p_article_id
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused', 'blocked')
    and not public.article_automatic_policy_allows(p_article_id, job.job_type, job.command_id);

  if not coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false) then
    update public.content_writing_sessions as session
    set
      status = case when session.status = 'running' then session.status else 'cancelled' end,
      cancel_requested_at = coalesce(session.cancel_requested_at, now()),
      completed_at = case when session.status = 'running' then session.completed_at else coalesce(session.completed_at, now()) end,
      last_error_code = 'article_automation_stage_excluded',
      last_error = 'Automatic content writing was excluded for the article.',
      updated_at = now()
    where session.article_id = p_article_id
      and session.execution_mode = 'api'
      and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
      and session.status in ('queued', 'running', 'retry_scheduled');

    update public.content_writing_automation_items as item
    set status = 'cancelled', attempt_count = 0,
      locked_by = null, locked_at = null, lease_expires_at = null,
      next_recovery_at = null, failure_class = null,
      completed_at = coalesce(item.completed_at, now()),
      last_error_code = 'article_automation_stage_excluded',
      last_error = 'Automatic content writing was excluded for the article.',
      updated_at = now()
    where item.article_id = p_article_id
      and item.status in ('ready', 'claiming', 'writing', 'blocked');
  end if;

  insert into public.worker_queue_signals(queue_name)
  values ('external_analysis'), ('content_writing')
  on conflict do nothing;

  perform public.reconcile_content_research_automation();
  perform public.reconcile_automatic_competitor_extraction();
  perform public.reconcile_automatic_article_focus();

  select * into v_row from public.article_automation_overrides where article_id = p_article_id;
  if v_row.article_id is null then
    return jsonb_build_object(
      'schemaVersion', 1, 'disabledCapabilities', '[]'::jsonb,
      'writingMode', 'strict', 'excludedExternalCommandIds', '[]'::jsonb,
      'reason', '', 'revision', 0, 'updatedAt', null, 'updatedBy', null
    );
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'disabledCapabilities', to_jsonb(v_row.disabled_capabilities),
    'writingMode', v_row.writing_mode,
    'excludedExternalCommandIds', to_jsonb(v_row.excluded_external_command_ids),
    'reason', coalesce(v_row.reason, ''),
    'revision', v_row.revision,
    'updatedAt', v_row.updated_at,
    'updatedBy', v_row.updated_by
  );
end;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$ select 23; $$;

revoke all on function public.save_article_automation_overrides(uuid,uuid,text[],text,text[],text)
  from public, anon, authenticated;
grant execute on function public.save_article_automation_overrides(uuid,uuid,text[],text,text[],text)
  to service_role;
revoke all on function public.article_automation_policy(uuid) from public, anon, authenticated;
grant execute on function public.article_automation_policy(uuid) to service_role;

comment on table public.article_automation_overrides is
  'Restrictive, non-default per-article exceptions layered over administrator and creator automation settings.';
comment on function public.save_article_automation_overrides(uuid,uuid,text[],text,text[],text) is
  'Atomically saves article exceptions, cancels newly excluded automatic work, and reconciles the single coordinator.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 23 with restrictive per-article automation overrides and available-input writing.';

notify pgrst, 'reload schema';

commit;
