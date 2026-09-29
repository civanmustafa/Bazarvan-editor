begin;

-- A cleanup result is current only when its applied document and every input
-- that affects cleanup still match the saved article. Downstream audits use
-- this predicate instead of trusting a historical "completed" status.
create or replace function public.article_duplicate_cleanup_is_current(
  p_article_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.articles as article
    join public.ai_external_analysis_jobs as job
      on job.article_id = article.id
    where article.id = p_article_id
      and job.job_type = 'duplicate_cleanup'
      and job.status = 'completed'
      and job.input_snapshot->>'version' = '2'
      and coalesce(job.progress #> '{unified,document}', job.input_snapshot->'document')
        = article.content_json
      and job.input_snapshot->'keywords' = article.keywords
      and job.input_snapshot->>'language' = article.article_language
      and job.input_snapshot->>'title' = article.title
  );
$$;

revoke all on function public.article_duplicate_cleanup_is_current(uuid)
  from public, anon, authenticated;
grant execute on function public.article_duplicate_cleanup_is_current(uuid)
  to service_role;

-- Automatic writing must wait for every enabled research prerequisite, not
-- merely for values that happened to be saved while a newer job is running.
create or replace function public.evaluate_content_writing_automation_readiness(
  p_article_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_ai_settings jsonb := '{}'::jsonb;
  v_policy jsonb := '{}'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_database_count integer := 0;
  v_pending_count integer := 0;
  v_usable_count integer := 0;
  v_minimum_competitors integer := 3;
  v_database_fingerprint jsonb := '[]'::jsonb;
  v_semantic_active boolean := false;
  v_discovery_active boolean := false;
  v_extraction_active boolean := false;
  v_processing_complete boolean := true;
  v_signature text;
begin
  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null then
    return jsonb_build_object(
      'ready', false, 'missingFields', jsonb_build_array('article_not_found'),
      'signature', '', 'usableCompetitorCount', 0, 'pendingCompetitorCount', 0,
      'minimumCompetitorCount', 2, 'processingComplete', true,
      'competitorRepository', 'article_competitors'
    );
  end if;

  select coalesce(setting.value, '{}'::jsonb)
  into v_ai_settings
  from public.app_settings as setting
  where setting.key = 'ai';

  v_policy := public.article_automation_policy(v_article.id);
  if coalesce(v_ai_settings->>'contentWritingAutomationMinimumCompetitors', '') ~ '^[0-9]+$' then
    v_minimum_competitors := (v_ai_settings->>'contentWritingAutomationMinimumCompetitors')::integer;
  end if;
  v_minimum_competitors := greatest(2, least(5, v_minimum_competitors));

  select
    count(*) filter (
      where competitor.status = 'completed'
        and nullif(btrim(competitor.content_text), '') is not null
        and btrim(competitor.content_text) not like '[تعذر استخراج محتوى المنافس]%'
    )::integer,
    count(*) filter (
      where competitor.status in ('queued', 'extracting', 'retry_scheduled')
    )::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id', competitor.id,
      'articleId', competitor.article_id,
      'position', competitor.position,
      'status', competitor.status,
      'sourceOrigin', competitor.source_origin,
      'sourceClass', competitor.source_class,
      'contentWeight', competitor.content_weight,
      'wordCount', competitor.word_count,
      'contentHash', md5(coalesce(competitor.content_text, ''))
    ) order by competitor.position), '[]'::jsonb)
  into v_database_count, v_pending_count, v_database_fingerprint
  from public.article_competitors as competitor
  where competitor.article_id = v_article.id;

  select
    coalesce(bool_or(job.job_type = 'semantic_keywords_lsi'), false),
    coalesce(bool_or(job.job_type = 'competitor_discovery'), false),
    coalesce(bool_or(job.job_type = 'competitor_extraction'), false)
  into v_semantic_active, v_discovery_active, v_extraction_active
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.cancel_requested_at is null
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    and job.job_type in ('semantic_keywords_lsi', 'competitor_discovery', 'competitor_extraction');

  v_usable_count := coalesce(v_database_count, 0);
  v_processing_complete := coalesce(v_pending_count, 0) = 0
    and not v_semantic_active and not v_discovery_active and not v_extraction_active;

  if coalesce(v_article.status, '') not in ('content_preparation', 'draft') then
    v_missing := v_missing || jsonb_build_array('draft_status');
  end if;
  if public.article_editor_has_text(v_article.plain_text) then
    v_missing := v_missing || jsonb_build_array('article_editor_empty');
  end if;
  if nullif(btrim(coalesce(v_article.title, '')), '') is null
     or lower(btrim(v_article.title)) in ('(untitled)', 'untitled', 'draft') then
    v_missing := v_missing || jsonb_build_array('article_title');
  end if;
  if nullif(btrim(coalesce(v_article.keywords ->> 'primary', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('primary_keyword');
  end if;
  if jsonb_typeof(v_article.keywords -> 'secondaries') <> 'array'
     or not exists (
       select 1 from jsonb_array_elements_text(v_article.keywords -> 'secondaries') as keyword(value)
       where nullif(btrim(keyword.value), '') is not null
     ) then
    v_missing := v_missing || jsonb_build_array('alternative_keywords');
  end if;
  if jsonb_typeof(v_article.keywords -> 'lsi') <> 'array'
     or not exists (
       select 1 from jsonb_array_elements_text(v_article.keywords -> 'lsi') as keyword(value)
       where nullif(btrim(keyword.value), '') is not null
     ) then
    v_missing := v_missing || jsonb_build_array('lsi_keywords');
  end if;
  if coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false)
     and not public.semantic_keywords_have_google_metadata(v_article.keywords) then
    v_missing := v_missing || jsonb_build_array('google_metadata');
  end if;
  if v_semantic_active then
    v_missing := v_missing || jsonb_build_array('semantic_processing');
  end if;
  if v_discovery_active then
    v_missing := v_missing || jsonb_build_array('competitor_discovery_processing');
  end if;
  if v_extraction_active or coalesce(v_pending_count, 0) > 0 then
    v_missing := v_missing || jsonb_build_array('competitor_extraction_processing');
  end if;
  if nullif(btrim(coalesce(v_article.keywords ->> 'company', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('company_name');
  end if;
  if nullif(btrim(coalesce(v_article.goal_context ->> 'pageType', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('goal_context.pageType');
  end if;
  if nullif(btrim(coalesce(v_article.goal_context ->> 'objective', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('goal_context.objective');
  end if;
  if nullif(btrim(coalesce(v_article.goal_context ->> 'audienceScope', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('goal_context.audienceScope');
  end if;
  if nullif(btrim(coalesce(v_article.goal_context ->> 'searchIntent', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('goal_context.searchIntent');
  end if;
  if v_usable_count < v_minimum_competitors then
    v_missing := v_missing || jsonb_build_array('competitors');
  end if;

  v_signature := md5(jsonb_build_object(
    'status', case when v_article.status in ('content_preparation', 'draft') then 'draft' else v_article.status end,
    'title', coalesce(v_article.title, ''),
    'plainTextHash', md5(coalesce(v_article.plain_text, '')),
    'keywords', coalesce(v_article.keywords, '{}'::jsonb),
    'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
    'minimumCompetitors', v_minimum_competitors,
    'databaseCompetitors', v_database_fingerprint,
    'semanticActive', v_semantic_active,
    'discoveryActive', v_discovery_active,
    'extractionActive', v_extraction_active
  )::text);

  return jsonb_build_object(
    'ready', jsonb_array_length(v_missing) = 0,
    'missingFields', v_missing,
    'signature', v_signature,
    'usableCompetitorCount', v_usable_count,
    'pendingCompetitorCount', coalesce(v_pending_count, 0),
    'minimumCompetitorCount', v_minimum_competitors,
    'processingComplete', v_processing_complete,
    'competitorRepository', 'article_competitors',
    'articleTitle', coalesce(v_article.title, ''),
    'articleStatus', coalesce(v_article.status, ''),
    'articleUpdatedAt', v_article.updated_at
  );
end;
$$;

revoke all on function public.evaluate_content_writing_automation_readiness(uuid)
  from public, anon, authenticated;
grant execute on function public.evaluate_content_writing_automation_readiness(uuid)
  to service_role;

-- Make duplicate cleanup a first-class coordinator stage.
alter table public.article_automation_stage_states
  drop constraint if exists article_automation_stage_states_stage_check;
alter table public.article_automation_stage_states
  add constraint article_automation_stage_states_stage_check check (stage in (
    'semantic_keywords_lsi', 'competitor_discovery', 'competitor_extraction',
    'content_writing_preparation', 'content_writing', 'duplicate_cleanup',
    'engineering_commands'
  ));

create or replace function public.initialize_article_automation_stage_states(p_article_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.article_automation_stage_states(article_id, stage)
  select p_article_id, stage
  from unnest(array[
    'semantic_keywords_lsi', 'competitor_discovery', 'competitor_extraction',
    'content_writing_preparation', 'content_writing', 'duplicate_cleanup',
    'engineering_commands'
  ]) as stage
  on conflict (article_id, stage) do nothing;
$$;

create or replace function public.external_job_coordinator_stage(p_job_type text)
returns text
language sql
immutable
as $$
  select case p_job_type
    when 'semantic_keywords_lsi' then 'semantic_keywords_lsi'
    when 'competitor_discovery' then 'competitor_discovery'
    when 'competitor_extraction' then 'competitor_extraction'
    when 'content_writing_preparation' then 'content_writing_preparation'
    when 'duplicate_cleanup' then 'duplicate_cleanup'
    when 'engineering_command' then 'engineering_commands'
    else null
  end;
$$;

insert into public.article_automation_stage_states(article_id, stage)
select article.id, 'duplicate_cleanup'
from public.articles as article
on conflict (article_id, stage) do nothing;

do $$
declare v_article_id uuid;
begin
  for v_article_id in
    select distinct job.article_id
    from public.ai_external_analysis_jobs as job
    where job.job_type = 'duplicate_cleanup'
  loop
    perform public.sync_external_automation_stage_state(v_article_id, 'duplicate_cleanup');
  end loop;
end;
$$;

-- Automatic engineering commands are read-only audits. Hold them until the
-- latest cleanup has applied to the exact current document. Manual commands
-- remain explicit priority work and are not changed by this guard.
create or replace function public.gate_automatic_engineering_on_current_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.job_type = 'engineering_command'
     and new.origin = 'auto'
     and new.pipeline_parent_job_id is null
     and new.status in ('queued', 'running', 'retry_scheduled', 'paused')
     and not public.article_duplicate_cleanup_is_current(new.article_id) then
    new.status := 'waiting_for_prerequisites';
    new.next_attempt_at := null;
    new.locked_by := null;
    new.locked_at := null;
    new.lease_expires_at := null;
    new.progress := coalesce(new.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'waiting_for_prerequisites',
      'blockedBy', 'duplicate_cleanup',
      'readinessPolicy', 'audits_after_current_cleanup',
      'updatedAt', now()
    );
  end if;
  return new;
end;
$$;

drop trigger if exists gate_automatic_engineering_on_current_cleanup
  on public.ai_external_analysis_jobs;
create trigger gate_automatic_engineering_on_current_cleanup
before insert or update of status, origin, job_type, article_id
on public.ai_external_analysis_jobs
for each row execute function public.gate_automatic_engineering_on_current_cleanup();

-- Replace the automatic reconciliation boundary: semantic inputs first,
-- cleanup second, then every selected audit is independently claimable from
-- the same cleaned content signature. A failed audit cannot block siblings.
create or replace function public.reconcile_automatic_ready_engineering_commands_for_article(
  p_article_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := '{}'::jsonb;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_keywords jsonb := '{}'::jsonb;
  v_has_secondaries boolean := false;
  v_has_lsi boolean := false;
  v_has_google_metadata boolean := false;
  v_job_ids uuid[] := array[]::uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended('ready-engineering-command-automation', 0));
  v_settings := public.article_automation_policy(p_article_id);

  select state.* into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;
  if v_state.article_id is null then return v_job_ids; end if;

  if not v_state.external_analysis_ready then
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
    return v_job_ids;
  end if;
  if not coalesce((v_settings->>'autoRunReadyEngineeringCommands')::boolean, true) then
    perform public.cancel_automatic_ready_engineering_jobs(p_article_id);
    return v_job_ids;
  end if;

  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = p_article_id;
  if not found then return v_job_ids; end if;

  v_has_secondaries := public.external_analysis_has_competitor_value(v_keywords->'secondaries', 100);
  v_has_lsi := public.external_analysis_has_competitor_value(v_keywords->'lsi', 100);
  v_has_google_metadata := public.semantic_keywords_have_google_metadata(v_keywords);

  if (coalesce((v_settings->>'autoGenerateAlternativeKeywords')::boolean, true) and not v_has_secondaries)
     or (coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true) and not v_has_lsi)
     or (coalesce((v_settings->>'autoGenerateGoogleMetadata')::boolean, false) and not v_has_google_metadata) then
    perform public.enqueue_external_semantic_analysis_job_controlled(p_article_id, 'auto');
    return v_job_ids;
  end if;

  if not public.article_duplicate_cleanup_is_current(p_article_id) then
    update public.ai_external_analysis_jobs as job
    set
      status = case when job.status = 'running' then job.status else 'waiting_for_prerequisites' end,
      cancel_requested_at = case when job.status = 'running' then coalesce(job.cancel_requested_at, now())
        else job.cancel_requested_at end,
      next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.status = 'running' then 'cancel_requested' else 'waiting_for_prerequisites' end,
        'blockedBy', 'duplicate_cleanup',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.article_id = p_article_id
      and job.job_type = 'engineering_command'
      and job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');
    return v_job_ids;
  end if;

  if v_has_secondaries and v_has_lsi then
    v_job_ids := public.enqueue_external_engineering_jobs_controlled(p_article_id, null, 'auto');

    update public.ai_external_analysis_jobs as job
    set
      depends_on_job_id = null,
      sequence_number = 0,
      status = case
        when job.status = 'waiting_for_prerequisites' then 'queued'
        when job.status = 'blocked'
          and job.last_error_code in ('external_analysis_dependency_terminal', 'external_analysis_dependency_cancelled')
          and job.attempt_count < job.max_attempts then 'queued'
        else job.status
      end,
      next_attempt_at = case
        when job.status = 'waiting_for_prerequisites'
          or (job.status = 'blocked'
            and job.last_error_code in ('external_analysis_dependency_terminal', 'external_analysis_dependency_cancelled')
            and job.attempt_count < job.max_attempts) then now()
        else job.next_attempt_at
      end,
      completed_at = case
        when job.status = 'blocked'
          and job.last_error_code in ('external_analysis_dependency_terminal', 'external_analysis_dependency_cancelled')
          and job.attempt_count < job.max_attempts then null
        else job.completed_at
      end,
      cancel_requested_at = null,
      last_error_code = case
        when job.last_error_code in ('external_analysis_dependency_terminal', 'external_analysis_dependency_cancelled')
          then null else job.last_error_code end,
      last_error = case
        when job.last_error_code in ('external_analysis_dependency_terminal', 'external_analysis_dependency_cancelled')
          then null else job.last_error end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'articleQueueLocked', true,
        'readinessPriority', 'post_write_finalize',
        'dependencyPolicy', 'independent_after_cleanup',
        'cleanedContentSignature', v_state.external_analysis_readiness_signature,
        'updatedAt', now()
      ),
      updated_at = now()
    where job.article_id = p_article_id
      and job.job_type = 'engineering_command'
      and job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and job.readiness_signature = v_state.external_analysis_readiness_signature
      and job.status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused', 'blocked');
  else
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
  end if;

  return v_job_ids;
end;
$$;

-- Once automatic writing is safely applied, bypass the human-edit quiet
-- delay. The apply RPC already proves the editor is empty and no user is
-- present, so cleanup can become the highest-priority external job at once.
create or replace function public.enqueue_cleanup_after_automatic_writing_apply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_job public.ai_external_analysis_jobs%rowtype;
begin
  if old.applied_at is not null
     or new.applied_at is null
     or new.context_snapshot->>'triggerSource' is distinct from 'automatic_ready' then
    return new;
  end if;

  update public.duplicate_cleanup_schedule as schedule
  set quiet_since = now() - interval '15 minutes', dispatched_signature = null
  where schedule.article_id = new.article_id;

  select * into v_job
  from public.enqueue_unified_duplicate_cleanup(new.article_id, new.created_by, true, null);

  if v_job.id is not null then
    update public.ai_external_analysis_jobs as job
    set
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'articleQueueLocked', true,
        'readinessPriority', 'post_write_finalize',
        'triggerSource', 'automatic_writing_applied',
        'updatedAt', now()
      ),
      next_attempt_at = now(),
      updated_at = now()
    where job.id = v_job.id;
  end if;
  return new;
end;
$$;

drop trigger if exists enqueue_cleanup_after_automatic_writing_apply
  on public.content_writing_sessions;
create trigger enqueue_cleanup_after_automatic_writing_apply
after update of applied_at on public.content_writing_sessions
for each row execute function public.enqueue_cleanup_after_automatic_writing_apply();

create or replace function public.reconcile_audits_after_duplicate_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.job_type = 'duplicate_cleanup'
     and old.status is distinct from new.status
     and new.status = 'completed' then
    perform public.reconcile_automatic_ready_engineering_commands_for_article(new.article_id);
  end if;
  return new;
end;
$$;

drop trigger if exists reconcile_audits_after_duplicate_cleanup
  on public.ai_external_analysis_jobs;
create trigger reconcile_audits_after_duplicate_cleanup
after update of status on public.ai_external_analysis_jobs
for each row execute function public.reconcile_audits_after_duplicate_cleanup();

-- A single read model powers the article-card readiness label. Optional or
-- disabled automation never blocks readiness; selected audits do.
create or replace function public.article_automation_work_readiness(
  p_article_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_policy jsonb := '{}'::jsonb;
  v_external_signature text := '';
  v_required_commands text[] := array[]::text[];
  v_cleanup_current boolean := false;
  v_cleanup_active boolean := false;
  v_cleanup_failed boolean := false;
  v_audit_completed integer := 0;
  v_audit_active integer := 0;
  v_audit_failed integer := 0;
  v_required_count integer := 0;
  v_state text := 'awaiting_writing';
begin
  select article.* into v_article from public.articles as article where article.id = p_article_id;
  if v_article.id is null then
    return jsonb_build_object('articleId', p_article_id, 'state', 'not_found', 'ready', false);
  end if;

  v_policy := public.article_automation_policy(v_article.id);
  select coalesce(state.external_analysis_readiness_signature, '')
  into v_external_signature
  from public.ai_external_analysis_article_state as state
  where state.article_id = v_article.id;

  if coalesce((v_policy->>'autoRunReadyEngineeringCommands')::boolean, false) then
    select coalesce(array_agg(value), array[]::text[])
    into v_required_commands
    from jsonb_array_elements_text(coalesce(v_policy->'externalAnalysisCommandIds', '[]'::jsonb)) as command(value);
  end if;
  v_required_count := coalesce(cardinality(v_required_commands), 0);
  v_cleanup_current := public.article_duplicate_cleanup_is_current(v_article.id);

  select
    coalesce(bool_or(job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      and job.input_snapshot->>'version' = '2'
      and coalesce(job.progress #> '{unified,document}', job.input_snapshot->'document')
        = v_article.content_json), false),
    coalesce(bool_or(job.status in ('failed', 'blocked')
      and job.input_snapshot->>'version' = '2'
      and coalesce(job.progress #> '{unified,document}', job.input_snapshot->'document')
        = v_article.content_json), false)
  into v_cleanup_active, v_cleanup_failed
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id and job.job_type = 'duplicate_cleanup';

  if v_required_count > 0 then
    select
      count(distinct job.command_id) filter (where job.status = 'completed')::integer,
      count(distinct job.command_id) filter (where job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      ))::integer,
      count(distinct job.command_id) filter (where job.status in ('failed', 'blocked'))::integer
    into v_audit_completed, v_audit_active, v_audit_failed
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_article.id
      and job.job_type = 'engineering_command'
      and job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and job.readiness_signature = v_external_signature
      and job.command_id = any(v_required_commands);
  end if;

  if nullif(btrim(coalesce(v_article.plain_text, '')), '') is null then
    v_state := 'awaiting_writing';
  elsif not v_cleanup_current and v_cleanup_active then
    v_state := 'cleaning';
  elsif not v_cleanup_current and v_cleanup_failed then
    v_state := 'needs_attention';
  elsif not v_cleanup_current then
    v_state := 'waiting_cleanup';
  elsif v_required_count = 0 or v_audit_completed >= v_required_count then
    v_state := 'ready';
  elsif v_audit_active > 0 then
    v_state := 'auditing';
  elsif v_audit_failed > 0 then
    v_state := 'partial';
  else
    v_state := 'auditing';
  end if;

  return jsonb_build_object(
    'articleId', v_article.id,
    'state', v_state,
    'ready', v_state = 'ready',
    'cleanupCurrent', v_cleanup_current,
    'cleanupActive', v_cleanup_active,
    'cleanupFailed', v_cleanup_failed,
    'requiredAuditCount', v_required_count,
    'completedAuditCount', coalesce(v_audit_completed, 0),
    'activeAuditCount', coalesce(v_audit_active, 0),
    'failedAuditCount', coalesce(v_audit_failed, 0),
    'contentSignature', v_external_signature,
    'updatedAt', v_article.updated_at
  );
end;
$$;

create or replace function public.get_articles_automation_work_readiness(
  p_article_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(public.article_automation_work_readiness(article_id)), '[]'::jsonb)
  from unnest(coalesce(p_article_ids, array[]::uuid[])) as requested(article_id)
  where exists (select 1 from public.articles as article where article.id = requested.article_id);
$$;

revoke all on function public.article_automation_work_readiness(uuid)
  from public, anon, authenticated;
grant execute on function public.article_automation_work_readiness(uuid)
  to service_role;
revoke all on function public.get_articles_automation_work_readiness(uuid[])
  from public, anon, authenticated;
grant execute on function public.get_articles_automation_work_readiness(uuid[])
  to service_role;

-- Hold already queued automatic audits during the rollout and let the normal
-- cleanup completion trigger requeue them independently.
update public.ai_external_analysis_jobs as job
set
  status = case when job.status = 'running' then job.status else 'waiting_for_prerequisites' end,
  cancel_requested_at = case when job.status = 'running' then coalesce(job.cancel_requested_at, now())
    else job.cancel_requested_at end,
  next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
  progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
    'stage', case when job.status = 'running' then 'cancel_requested' else 'waiting_for_prerequisites' end,
    'blockedBy', 'duplicate_cleanup',
    'readinessPolicy', 'audits_after_current_cleanup',
    'updatedAt', now()
  ),
  updated_at = now()
where job.job_type = 'engineering_command'
  and job.origin = 'auto'
  and job.pipeline_parent_job_id is null
  and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  and not public.article_duplicate_cleanup_is_current(job.article_id);

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 5;
$$;

revoke all on function public.content_writing_automation_schema_version()
  from public, anon, authenticated;
grant execute on function public.content_writing_automation_schema_version()
  to service_role;

comment on function public.article_automation_work_readiness(uuid) is
  'Reports whether the saved article passed current cleanup and every enabled independent post-write audit.';

notify pgrst, 'reload schema';

commit;
