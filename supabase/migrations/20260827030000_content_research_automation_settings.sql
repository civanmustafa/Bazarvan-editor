begin;

-- Keep the current automatic behavior after deployment while giving the
-- administrator an independent switch for every research stage.
insert into public.app_settings (key, value, description, is_secret)
values (
  'system',
  jsonb_build_object(
    'autoGenerateAlternativeKeywords', true,
    'autoGenerateLsiKeywords', true,
    'autoDiscoverCompetitors', true
  ),
  'General application and content-research automation settings.',
  false
)
on conflict (key) do update
set value = jsonb_build_object(
      'autoGenerateAlternativeKeywords', true,
      'autoGenerateLsiKeywords', true,
      'autoDiscoverCompetitors', true
    ) || coalesce(public.app_settings.value, '{}'::jsonb),
    updated_at = now();

create or replace function public.get_content_research_automation_settings()
returns jsonb
language sql
volatile
security definer
set search_path = public
as $$
  with stored as (
    select coalesce((
      select setting.value
      from public.app_settings as setting
      where setting.key = 'system'
        and not setting.is_secret
      limit 1
    ), '{}'::jsonb) as value
  )
  select jsonb_build_object(
    'autoGenerateAlternativeKeywords', case
      when jsonb_typeof(stored.value->'autoGenerateAlternativeKeywords') = 'boolean'
        then (stored.value->>'autoGenerateAlternativeKeywords')::boolean
      else true
    end,
    'autoGenerateLsiKeywords', case
      when jsonb_typeof(stored.value->'autoGenerateLsiKeywords') = 'boolean'
        then (stored.value->>'autoGenerateLsiKeywords')::boolean
      else true
    end,
    'autoDiscoverCompetitors', case
      when jsonb_typeof(stored.value->'autoDiscoverCompetitors') = 'boolean'
        then (stored.value->>'autoDiscoverCompetitors')::boolean
      else true
    end
  )
  from stored;
$$;

-- The canonical one-argument function remains available for legacy callers.
-- Automatic triggers and the manual API use this coordinator so their intent
-- is explicit and a partially completed semantic task can be resumed safely.
create or replace function public.enqueue_external_semantic_analysis_job_controlled(
  p_article_id uuid,
  p_origin text default 'auto'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_article public.articles%rowtype;
  v_settings jsonb := public.get_content_research_automation_settings();
  v_manual boolean := lower(btrim(coalesce(p_origin, 'auto'))) = 'manual';
  v_has_secondaries boolean := false;
  v_has_lsi boolean := false;
  v_needs_secondaries boolean := false;
  v_needs_lsi boolean := false;
  v_job_id uuid;
  v_job_status text;
  v_job_origin text;
  v_input_snapshot jsonb := '{}'::jsonb;
  v_terminal boolean := false;
begin
  select article.*
  into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null then return null; end if;

  v_has_secondaries := public.external_analysis_has_competitor_value(
    v_article.keywords->'secondaries',
    100
  );
  v_has_lsi := public.external_analysis_has_competitor_value(
    v_article.keywords->'lsi',
    100
  );
  v_needs_secondaries := not v_has_secondaries and (
    v_manual
    or coalesce((v_settings->>'autoGenerateAlternativeKeywords')::boolean, true)
  );
  v_needs_lsi := not v_has_lsi and (
    v_manual
    or coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true)
  );

  if not v_needs_secondaries and not v_needs_lsi then return null; end if;

  v_job_id := public.enqueue_external_semantic_analysis_job(v_article.id);
  if v_job_id is null then return null; end if;

  select job.status, job.origin, coalesce(job.input_snapshot, '{}'::jsonb)
  into v_job_status, v_job_origin, v_input_snapshot
  from public.ai_external_analysis_jobs as job
  where job.id = v_job_id
  for update;

  if not found then return null; end if;

  -- Never narrow a live manual request because an automatic reconciliation ran.
  if not v_manual
    and v_job_origin = 'manual'
    and v_job_status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    ) then
    return v_job_id;
  end if;

  v_input_snapshot := v_input_snapshot || jsonb_build_object(
    'needsSecondaries', v_needs_secondaries,
    'needsLsi', v_needs_lsi,
    'automationSettings', v_settings,
    'controlledOrigin', case when v_manual then 'manual' else 'auto' end
  );
  v_terminal := v_job_status in ('completed', 'failed', 'blocked', 'cancelled');

  update public.ai_external_analysis_jobs as job
  set
    requested_by = coalesce(
      v_article.assigned_to,
      v_article.owner_id,
      v_article.created_by,
      job.requested_by
    ),
    origin = case when v_manual then 'manual' else 'auto' end,
    status = case when v_terminal then 'queued' else job.status end,
    input_snapshot = v_input_snapshot,
    result = case when v_terminal then null else job.result end,
    progress = case
      when v_terminal then jsonb_build_object(
        'stage', 'queued',
        'source', case when v_manual then 'manual_request' else 'automation_reconcile' end,
        'needsSecondaries', v_needs_secondaries,
        'needsLsi', v_needs_lsi,
        'updatedAt', now()
      )
      else coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'needsSecondaries', v_needs_secondaries,
        'needsLsi', v_needs_lsi,
        'updatedAt', now()
      )
    end,
    last_error = case when v_terminal then null else job.last_error end,
    last_error_code = case when v_terminal then null else job.last_error_code end,
    max_attempts = case
      when v_terminal then greatest(job.max_attempts, least(job.attempt_count + 2, 50))
      else job.max_attempts
    end,
    next_attempt_at = case when v_terminal then now() else job.next_attempt_at end,
    locked_by = case when v_terminal then null else job.locked_by end,
    locked_at = case when v_terminal then null else job.locked_at end,
    lease_expires_at = case when v_terminal then null else job.lease_expires_at end,
    cancel_requested_at = null,
    completed_at = case when v_terminal then null else job.completed_at end,
    dead_lettered_at = case when v_terminal then null else job.dead_lettered_at end,
    dead_letter_reason = case when v_terminal then null else job.dead_letter_reason end,
    updated_at = now()
  where job.id = v_job_id;

  return v_job_id;
end;
$$;

-- Resolve a duplicate-suppressed row to its canonical task and promote that
-- exact row while it is locked. This prevents an automatic worker from
-- claiming the canonical task between a manual retry request and promotion.
create or replace function public.promote_external_analysis_job_manual(
  p_job_id uuid,
  p_requested_by uuid
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.id = p_job_id
  for update;

  if v_job.id is null then
    raise exception 'external analysis job % was not found', p_job_id;
  end if;

  if v_job.last_error_code = 'duplicate_task_suppressed'
    and nullif(v_job.readiness_signature, '') is not null then
    select job.*
    into v_job
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_job.article_id
      and job.job_type = v_job.job_type
      and coalesce(job.command_id, '') = coalesce(v_job.command_id, '')
      and job.readiness_signature = v_job.readiness_signature
      and job.last_error_code is distinct from 'duplicate_task_suppressed'
    order by
      case
        when job.status = 'completed' then 0
        when job.status in (
          'running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused'
        ) then 1
        else 2
      end,
      coalesce(job.completed_at, job.updated_at, job.created_at) desc
    limit 1
    for update;
  end if;

  if v_job.id is null then
    raise exception 'canonical external analysis job was not found';
  end if;

  -- A completed canonical task is reused as-is; there is nothing to execute
  -- and therefore no automatic worker to bypass.
  if v_job.status = 'completed' then return v_job; end if;

  update public.ai_external_analysis_jobs as job
  set
    origin = 'manual',
    requested_by = coalesce(p_requested_by, job.requested_by),
    cancel_requested_at = null,
    updated_at = now()
  where job.id = v_job.id
  returning job.* into v_job;

  return v_job;
end;
$$;

create or replace function public.enqueue_external_semantic_analysis_job_from_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.semantic_ready then
    perform public.enqueue_external_semantic_analysis_job_controlled(
      new.article_id,
      'auto'
    );
  end if;
  return new;
end;
$$;

-- The legacy engineering coordinator always creates a semantic prerequisite.
-- Automatic state changes must therefore wait here until both lists truly
-- exist; an explicitly requested engineering run still uses the legacy RPC.
create or replace function public.enqueue_external_engineering_jobs_from_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings jsonb := public.get_content_research_automation_settings();
  v_keywords jsonb := '{}'::jsonb;
  v_has_secondaries boolean := false;
  v_has_lsi boolean := false;
begin
  if not new.external_analysis_ready then
    perform public.cancel_stale_external_engineering_jobs(new.article_id, null, true);
    return new;
  end if;

  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = new.article_id;
  if not found then return new; end if;

  v_has_secondaries := public.external_analysis_has_competitor_value(
    v_keywords->'secondaries',
    100
  );
  v_has_lsi := public.external_analysis_has_competitor_value(v_keywords->'lsi', 100);

  if (
    coalesce((v_settings->>'autoGenerateAlternativeKeywords')::boolean, true)
    and not v_has_secondaries
  ) or (
    coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true)
    and not v_has_lsi
  ) then
    perform public.enqueue_external_semantic_analysis_job_controlled(new.article_id, 'auto');
    return new;
  end if;

  if v_has_secondaries and v_has_lsi then
    perform public.enqueue_external_engineering_jobs(new.article_id);
  else
    -- A disabled and absent keyword list is intentionally skipped for
    -- competitors, but engineering commands that consume target keywords wait.
    perform public.cancel_stale_external_engineering_jobs(new.article_id, null, true);
  end if;
  return new;
end;
$$;

-- LSI does not affect competitor scoring, but its empty/non-empty transition is
-- part of orchestration identity so the automatic coordinator wakes exactly
-- when the enabled LSI stage finishes.
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
set search_path = public
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_primary_keyword text := btrim(coalesce(p_keywords->>'primary', ''));
  v_company_name text := btrim(coalesce(p_keywords->>'company', ''));
  v_alternative_keywords jsonb := '[]'::jsonb;
  v_has_lsi boolean := public.external_analysis_has_competitor_value(
    p_keywords->'lsi',
    100
  );
  v_query_type text := case when v_primary_keyword <> '' then 'primary_keyword' else 'title' end;
  v_query_text text := case when v_primary_keyword <> '' then v_primary_keyword else v_title end;
  v_missing_fields jsonb := '[]'::jsonb;
  v_signature text;
  v_signature_status text := case
    when public.article_status_supports_external_analysis(p_status) then 'draft'
    else coalesce(p_status, '')
  end;
begin
  if jsonb_typeof(p_keywords->'secondaries') = 'array' then
    select coalesce(jsonb_agg(keyword.value order by keyword.ordinality), '[]'::jsonb)
    into v_alternative_keywords
    from jsonb_array_elements_text(p_keywords->'secondaries') with ordinality as keyword(value, ordinality)
    where nullif(btrim(keyword.value), '') is not null;
  end if;

  if not public.article_status_supports_external_analysis(p_status) then
    v_missing_fields := v_missing_fields || jsonb_build_array('draft_status');
  end if;
  if v_query_text = '' or lower(v_query_text) in ('(untitled)', 'untitled') then
    v_missing_fields := v_missing_fields || jsonb_build_array('article_title_or_primary_keyword');
  end if;
  if v_company_name = '' then
    v_missing_fields := v_missing_fields || jsonb_build_array('company_name');
  end if;

  v_signature := md5(jsonb_build_object(
    'status', v_signature_status,
    'queryType', v_query_type,
    'queryText', v_query_text,
    'articleTitle', v_title,
    'primaryKeyword', v_primary_keyword,
    'alternativeKeywords', v_alternative_keywords,
    'lsiReady', v_has_lsi,
    'companyName', v_company_name,
    'articleLanguage', case when p_article_language = 'en' then 'en' else 'ar' end,
    'pageType', coalesce(p_goal_context->>'pageType', ''),
    'searchIntent', coalesce(p_goal_context->>'searchIntent', ''),
    'audienceScope', coalesce(p_goal_context->>'audienceScope', ''),
    'targetCountry', coalesce(p_goal_context->>'targetCountry', '')
  )::text);

  return jsonb_build_object(
    'ready', jsonb_array_length(v_missing_fields) = 0,
    'missingFields', v_missing_fields,
    'signature', v_signature,
    'queryType', v_query_type,
    'queryText', v_query_text,
    'alternativeKeywords', v_alternative_keywords,
    'lsiReady', v_has_lsi
  );
end;
$$;

create or replace function public.enqueue_competitor_discovery_job_controlled(
  p_article_id uuid,
  p_requested_by uuid default null,
  p_origin text default 'auto'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keywords jsonb := '{}'::jsonb;
  v_settings jsonb := public.get_content_research_automation_settings();
  v_manual boolean := lower(btrim(coalesce(p_origin, 'auto'))) = 'manual';
  v_has_secondaries boolean := false;
  v_has_lsi boolean := false;
  v_job_id uuid;
  v_current_signature text;
begin
  if v_manual then
    v_job_id := public.enqueue_competitor_discovery_job(
      p_article_id,
      p_requested_by,
      'manual'
    );
    if v_job_id is not null then
      update public.ai_external_analysis_jobs as job
      set
        requested_by = coalesce(p_requested_by, job.requested_by),
        origin = 'manual',
        cancel_requested_at = null,
        updated_at = now()
      where job.id = v_job_id;
    end if;
    return v_job_id;
  end if;

  if not coalesce((v_settings->>'autoDiscoverCompetitors')::boolean, true) then
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

  if exists (
    select 1
    from public.ai_external_analysis_jobs as semantic_job
    where semantic_job.article_id = p_article_id
      and semantic_job.job_type = 'semantic_keywords_lsi'
      and semantic_job.cancel_requested_at is null
      and semantic_job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      )
  ) then
    return null;
  end if;

  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = p_article_id;

  if not found then return null; end if;

  v_has_secondaries := public.external_analysis_has_competitor_value(
    v_keywords->'secondaries',
    100
  );
  v_has_lsi := public.external_analysis_has_competitor_value(
    v_keywords->'lsi',
    100
  );

  if coalesce((v_settings->>'autoGenerateAlternativeKeywords')::boolean, true)
    and not v_has_secondaries then
    return null;
  end if;
  if coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true)
    and not v_has_lsi then
    return null;
  end if;

  v_job_id := public.enqueue_competitor_discovery_job(
    p_article_id,
    p_requested_by,
    'auto'
  );
  if v_job_id is not null then
    update public.ai_external_analysis_jobs as job
    set cancel_requested_at = null, updated_at = now()
    where job.id = v_job_id
      and job.origin = 'auto';
  end if;
  return v_job_id;
end;
$$;

-- Firecrawl extraction is manual by default in the legacy RPC. This wrapper
-- marks only content-writing automation children as automatic and rechecks the
-- same switch and semantic gate immediately before any scrape is queued.
create or replace function public.enqueue_competitor_extraction_job_controlled(
  p_article_id uuid,
  p_requested_by uuid,
  p_query_type text,
  p_query_text text,
  p_sources jsonb,
  p_origin text default 'auto'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings jsonb := public.get_content_research_automation_settings();
  v_manual boolean := lower(btrim(coalesce(p_origin, 'auto'))) = 'manual';
  v_keywords jsonb := '{}'::jsonb;
  v_result jsonb;
  v_job_id uuid;
begin
  if v_manual then
    return public.enqueue_competitor_extraction_job(
      p_article_id,
      p_requested_by,
      p_query_type,
      p_query_text,
      p_sources
    );
  end if;

  if not coalesce((v_settings->>'autoDiscoverCompetitors')::boolean, true) then
    return null;
  end if;
  if exists (
    select 1
    from public.ai_external_analysis_jobs as semantic_job
    where semantic_job.article_id = p_article_id
      and semantic_job.job_type = 'semantic_keywords_lsi'
      and semantic_job.cancel_requested_at is null
      and semantic_job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      )
  ) then
    return null;
  end if;

  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = p_article_id;
  if not found then return null; end if;

  if coalesce((v_settings->>'autoGenerateAlternativeKeywords')::boolean, true)
    and not public.external_analysis_has_competitor_value(v_keywords->'secondaries', 100) then
    return null;
  end if;
  if coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true)
    and not public.external_analysis_has_competitor_value(v_keywords->'lsi', 100) then
    return null;
  end if;

  v_result := public.enqueue_competitor_extraction_job(
    p_article_id,
    p_requested_by,
    p_query_type,
    p_query_text,
    p_sources
  );
  begin
    v_job_id := nullif(v_result #>> '{job,id}', '')::uuid;
  exception when invalid_text_representation then
    v_job_id := null;
  end;
  if v_job_id is not null then
    update public.ai_external_analysis_jobs as job
    set origin = 'auto', updated_at = now()
    where job.id = v_job_id;
    v_result := jsonb_set(v_result, '{job,origin}', to_jsonb('auto'::text), true);
  end if;
  return v_result;
end;
$$;

-- A completed semantic pass can legitimately populate only one requested list.
-- Reconcile once more before opening the competitor gate; the controlled
-- semantic enqueue reuses the same exactly-once row for a completion pass.
create or replace function public.enqueue_semantic_followup_after_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.job_type = 'semantic_keywords_lsi'
    and new.status = 'completed'
    and new.status is distinct from old.status
    and new.pipeline_parent_job_id is null then
    perform public.enqueue_external_semantic_analysis_job_controlled(
      new.article_id,
      case when new.origin = 'manual' then 'manual' else 'auto' end
    );
    perform public.enqueue_competitor_discovery_job_controlled(
      new.article_id,
      new.requested_by,
      'auto'
    );
  elsif new.status = 'cancelled'
    and new.status is distinct from old.status
    and new.origin = 'auto'
    and new.pipeline_parent_job_id is null
    and new.last_error_code in (
      'semantic_automation_disabled',
      'content_research_automation_changed',
      'competitor_automation_disabled'
    ) then
    -- If an administrator re-enabled a switch while a worker was finalizing
    -- cancellation, re-evaluate once against the current settings. Disabled
    -- stages remain terminal; enabled stages safely reuse their canonical row.
    if new.job_type = 'semantic_keywords_lsi' then
      perform public.enqueue_external_semantic_analysis_job_controlled(
        new.article_id,
        'auto'
      );
    elsif new.job_type = 'competitor_discovery' then
      perform public.enqueue_competitor_discovery_job_controlled(
        new.article_id,
        new.requested_by,
        'auto'
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enqueue_semantic_followup_after_completion
  on public.ai_external_analysis_jobs;
create trigger enqueue_semantic_followup_after_completion
after update of status on public.ai_external_analysis_jobs
for each row
execute function public.enqueue_semantic_followup_after_completion();

create or replace function public.enqueue_competitor_discovery_from_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
    and new.competitor_discovery_ready is not distinct from old.competitor_discovery_ready
    and new.competitor_discovery_signature is not distinct from old.competitor_discovery_signature then
    return new;
  end if;

  if new.competitor_discovery_ready then
    perform public.enqueue_competitor_discovery_job_controlled(
      new.article_id,
      null,
      'auto'
    );
  else
    perform public.cancel_stale_competitor_discovery_jobs(new.article_id, null);
  end if;
  return new;
end;
$$;

create or replace function public.reconcile_content_research_automation()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings jsonb := public.get_content_research_automation_settings();
  v_auto_secondaries boolean := coalesce(
    (v_settings->>'autoGenerateAlternativeKeywords')::boolean,
    true
  );
  v_auto_lsi boolean := coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true);
  v_auto_competitors boolean := coalesce((v_settings->>'autoDiscoverCompetitors')::boolean, true);
  v_article_id uuid;
begin
  -- Stop automatic competitor work that is no longer allowed or whose enabled
  -- precursor lists are not ready. Running workers receive a cancellation flag;
  -- queued work becomes terminal immediately and can be reused later.
  update public.ai_external_analysis_jobs as job
  set
    status = case when job.status = 'running' then 'running' else 'cancelled' end,
    cancel_requested_at = coalesce(job.cancel_requested_at, now()),
    next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
    locked_by = case when job.status = 'running' then job.locked_by else null end,
    locked_at = case when job.status = 'running' then job.locked_at else null end,
    lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
    completed_at = case when job.status = 'running' then job.completed_at else coalesce(job.completed_at, now()) end,
    last_error_code = 'content_research_automation_changed',
    last_error = 'Automatic competitor discovery was disabled or is waiting for enabled keyword stages.',
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', case when job.status = 'running' then 'cancellation_requested' else 'cancelled' end,
      'reason', 'content_research_automation_changed',
      'updatedAt', now()
    ),
    updated_at = now()
  from public.articles as article
  where article.id = job.article_id
    and job.origin = 'auto'
    and job.job_type in ('competitor_discovery', 'competitor_extraction')
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    )
    and (
      not v_auto_competitors
      or (
        v_auto_secondaries
        and not public.external_analysis_has_competitor_value(
          article.keywords->'secondaries',
          100
        )
      )
      or (
        v_auto_lsi
        and not public.external_analysis_has_competitor_value(article.keywords->'lsi', 100)
      )
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
      completed_at = case when job.status = 'running' then job.completed_at else coalesce(job.completed_at, now()) end,
      last_error_code = 'competitor_automation_disabled',
      last_error = 'Automatic competitor preparation was disabled.',
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.status = 'running' then 'cancellation_requested' else 'cancelled' end,
        'reason', 'competitor_automation_disabled',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.origin = 'auto'
      and job.job_type = 'content_writing_preparation'
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
    completed_at = case when job.status = 'running' then job.completed_at else coalesce(job.completed_at, now()) end,
    last_error_code = 'semantic_automation_disabled',
    last_error = 'No enabled automatic semantic target remains for this article.',
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', case when job.status = 'running' then 'cancellation_requested' else 'cancelled' end,
      'reason', 'semantic_automation_disabled',
      'updatedAt', now()
    ),
    updated_at = now()
  from public.articles as article
  where article.id = job.article_id
    and job.origin = 'auto'
    and job.job_type = 'semantic_keywords_lsi'
    and job.pipeline_parent_job_id is null
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    )
    and not (
      v_auto_secondaries
      and not public.external_analysis_has_competitor_value(article.keywords->'secondaries', 100)
      or v_auto_lsi
      and not public.external_analysis_has_competitor_value(article.keywords->'lsi', 100)
    );

  if v_auto_secondaries or v_auto_lsi then
    for v_article_id in
      select state.article_id
      from public.ai_external_analysis_article_state as state
      where state.semantic_ready
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
      where state.competitor_discovery_ready
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

create or replace function public.reconcile_content_research_automation_from_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.key <> 'system' then return new; end if;
  if tg_op = 'INSERT' then
    perform public.reconcile_content_research_automation();
  elsif new.value->'autoGenerateAlternativeKeywords'
      is distinct from old.value->'autoGenerateAlternativeKeywords'
    or new.value->'autoGenerateLsiKeywords'
      is distinct from old.value->'autoGenerateLsiKeywords'
    or new.value->'autoDiscoverCompetitors'
      is distinct from old.value->'autoDiscoverCompetitors' then
    perform public.reconcile_content_research_automation();
  end if;
  return new;
end;
$$;

drop trigger if exists reconcile_content_research_automation_from_settings
  on public.app_settings;
create trigger reconcile_content_research_automation_from_settings
after insert or update of value on public.app_settings
for each row
when (new.key = 'system')
execute function public.reconcile_content_research_automation_from_settings();

revoke all on function public.get_content_research_automation_settings()
  from public, anon, authenticated;
revoke all on function public.enqueue_external_semantic_analysis_job_controlled(uuid, text)
  from public, anon, authenticated;
revoke all on function public.promote_external_analysis_job_manual(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.enqueue_external_semantic_analysis_job_from_state()
  from public, anon, authenticated;
revoke all on function public.enqueue_external_engineering_jobs_from_state()
  from public, anon, authenticated;
revoke all on function public.enqueue_semantic_followup_after_completion()
  from public, anon, authenticated;
revoke all on function public.enqueue_competitor_discovery_job_controlled(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_competitor_extraction_job_controlled(uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_competitor_discovery_from_state()
  from public, anon, authenticated;
revoke all on function public.reconcile_content_research_automation()
  from public, anon, authenticated;
revoke all on function public.reconcile_content_research_automation_from_settings()
  from public, anon, authenticated;

grant execute on function public.get_content_research_automation_settings()
  to service_role;
grant execute on function public.enqueue_external_semantic_analysis_job_controlled(uuid, text)
  to service_role;
grant execute on function public.promote_external_analysis_job_manual(uuid, uuid)
  to service_role;
grant execute on function public.enqueue_competitor_discovery_job_controlled(uuid, uuid, text)
  to service_role;
grant execute on function public.enqueue_competitor_extraction_job_controlled(uuid, uuid, text, text, jsonb, text)
  to service_role;
grant execute on function public.reconcile_content_research_automation()
  to service_role;

comment on function public.enqueue_external_semantic_analysis_job_controlled(uuid, text)
  is 'Coordinates manual or settings-aware automatic semantic generation and resumes a missing target after partial completion.';
comment on function public.promote_external_analysis_job_manual(uuid, uuid)
  is 'Atomically resolves a duplicate task to its canonical row and marks a non-completed retry as manual.';
comment on function public.enqueue_competitor_discovery_job_controlled(uuid, uuid, text)
  is 'Keeps manual competitor search available while automatic discovery waits for every enabled keyword stage.';
comment on function public.enqueue_competitor_extraction_job_controlled(uuid, uuid, text, text, jsonb, text)
  is 'Keeps manual Firecrawl extraction available while settings-aware automatic extraction remains gated.';
comment on function public.reconcile_content_research_automation()
  is 'Applies content-research automation switches immediately to ready articles and active automatic jobs.';

-- Bring active work under the new ordering immediately when this migration is
-- installed, including tasks queued by the older eager competitor trigger.
select public.reconcile_content_research_automation();

commit;
