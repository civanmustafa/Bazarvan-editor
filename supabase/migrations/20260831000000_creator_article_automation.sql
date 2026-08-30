begin;

-- Rollout is insert-only: existing articles keep version 0 forever. A later
-- assignment, import/save, profile edit or administrator visit cannot opt them in.
alter table public.articles
  add column automation_policy_version smallint not null default 0
    check (automation_policy_version in (0, 1)),
  add column automation_creator_id uuid;
create index articles_creator_automation_idx
  on public.articles (automation_creator_id, id)
  where automation_policy_version = 1;

create table public.user_automation_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  preferences jsonb not null check (jsonb_typeof(preferences) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_automation_settings enable row level security;
revoke all on public.user_automation_settings from public, anon, authenticated;
grant all on public.user_automation_settings to service_role;

-- Strict normalization also rejects misspelled switches instead of silently
-- leaving a paid automation enabled. Empty command selections are intentional.
create or replace function public.normalize_user_automation_preferences(p_preferences jsonb)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare
  v_result jsonb := '{"schemaVersion":1,"enabled":true,"autoGenerateAlternativeKeywords":true,"autoGenerateLsiKeywords":true,"autoGenerateGoogleMetadata":true,"autoDiscoverCompetitors":true,"autoExtractCompetitorContent":true,"autoRunReadyEngineeringCommands":true,"contentWritingAutomationEnabled":false,"autoApplyStrongInternalLinkSuggestions":true}'::jsonb;
  v_key text;
  v_value jsonb;
  v_ids jsonb;
begin
  if jsonb_typeof(p_preferences) is distinct from 'object' then
    raise exception 'Automation preferences must be an object.' using errcode = '22023';
  end if;
  for v_key, v_value in select * from jsonb_each(p_preferences) loop
    if v_key = 'externalAnalysisCommandIds' then
      if jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) > 100 then
        raise exception 'Invalid automatic command selection.' using errcode = '22023';
      end if;
      if exists (select 1 from jsonb_array_elements(v_value) as chosen(value)
        where jsonb_typeof(chosen.value) <> 'string'
          or not exists (select 1 from public.external_analysis_command_catalog() as command
            where command.command_id = chosen.value #>> '{}')) then
        raise exception 'Unknown automatic command id.' using errcode = '22023';
      end if;
    elsif v_key = 'schemaVersion' then
      if v_value <> '1'::jsonb then
        raise exception 'Unsupported automation preferences version.' using errcode = '22023';
      end if;
    elsif not v_result ? v_key or jsonb_typeof(v_value) <> 'boolean' then
      raise exception 'Invalid automation preference: %', v_key using errcode = '22023';
    end if;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(chosen.id) order by chosen.position), '[]'::jsonb)
  into v_ids
  from (select value #>> '{}' as id, min(ordinality) as position
    from jsonb_array_elements(coalesce(p_preferences->'externalAnalysisCommandIds',
      to_jsonb(public.get_external_analysis_default_command_ids()))) with ordinality
    group by value #>> '{}') as chosen;
  return v_result || p_preferences || jsonb_build_object('externalAnalysisCommandIds', v_ids);
end;
$$;

create or replace function public.article_automation_admin_limits()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare
  v_system jsonb;
  v_ai jsonb;
  v_result jsonb := public.normalize_user_automation_preferences('{}'::jsonb);
  v_key text;
begin
  select coalesce(value, '{}'::jsonb) into v_system from public.app_settings
  where key = 'system' and not is_secret;
  select coalesce(value, '{}'::jsonb) into v_ai from public.app_settings
  where key = 'ai' and not is_secret;
  for v_key in select jsonb_object_keys(v_result) loop
    if v_key not in ('enabled', 'schemaVersion', 'externalAnalysisCommandIds')
      and jsonb_typeof(v_system->v_key) = 'boolean' then
      v_result := jsonb_set(v_result, array[v_key], v_system->v_key);
    end if;
  end loop;
  v_result := jsonb_set(v_result, '{contentWritingAutomationEnabled}', to_jsonb(case
    when jsonb_typeof(v_ai->'contentWritingAutomationEnabled') = 'boolean'
      then (v_ai->>'contentWritingAutomationEnabled')::boolean
    else false end));
  -- Command defaults are not a deny list. Every built-in available command may
  -- be selected by a user, independently of the administrator's default list.
  return v_result || jsonb_build_object('externalAnalysisCommandIds', coalesce((
    select jsonb_agg(command_id order by command_id) from public.external_analysis_command_catalog()
  ), '[]'::jsonb));
end;
$$;

-- Freeze future-user defaults once as a separate administrator-editable value.
-- Existing scheduling triggers compare operational keys, which are unchanged.
update public.app_settings
set value = coalesce(value, '{}'::jsonb) || jsonb_build_object('userAutomationDefaults',
    public.article_automation_admin_limits() || jsonb_build_object(
      'externalAnalysisCommandIds', to_jsonb(public.get_external_analysis_default_command_ids())
    )), updated_at = now()
where key = 'system' and not is_secret
  and jsonb_typeof(value->'userAutomationDefaults') is distinct from 'object';

create or replace function public.user_article_automation_defaults()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare v_defaults jsonb;
begin
  select value->'userAutomationDefaults' into v_defaults from public.app_settings
  where key = 'system' and not is_secret;
  return public.normalize_user_automation_preferences(coalesce(v_defaults, '{}'::jsonb));
end;
$$;

-- Freeze existing users' defaults once. This does not enqueue anything and does
-- not touch article markers or completed jobs. Future global edits remain caps.
insert into public.user_automation_settings(user_id, preferences)
select profile.id, public.article_automation_admin_limits() || jsonb_build_object(
  'externalAnalysisCommandIds', to_jsonb(public.get_external_analysis_default_command_ids())
) from public.profiles as profile
on conflict (user_id) do nothing;

create or replace function public.initialize_profile_automation_preferences()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.user_automation_settings(user_id, preferences)
  values (new.id, public.user_article_automation_defaults()) on conflict (user_id) do nothing;
  return new;
end;
$$;
create trigger initialize_profile_automation_preferences
after insert on public.profiles for each row
execute function public.initialize_profile_automation_preferences();

create or replace function public.stamp_article_creator_automation_policy()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    if (new.created_by is distinct from old.created_by
        and not (new.created_by is null and pg_trigger_depth() > 1
          and not exists (select 1 from public.profiles where id = old.created_by)))
      or new.automation_policy_version is distinct from old.automation_policy_version
      or new.automation_creator_id is distinct from old.automation_creator_id then
      raise exception 'The original article creator and automation policy scope are immutable.' using errcode = '23514';
    end if;
    return new;
  end if;
  if auth.uid() is not null and coalesce(new.source, 'manual') in ('manual', 'import') then
    new.created_by := auth.uid();
  end if;
  new.automation_creator_id := new.created_by;
  new.automation_policy_version := case
    when new.created_by is not null and coalesce(new.source, 'manual') in ('manual', 'import') then 1
    else 0 end;
  return new;
end;
$$;
-- Runs after URL-origin classification, before existing after-insert schedulers.
create trigger zz_stamp_article_creator_automation_policy
before insert or update on public.articles for each row
execute function public.stamp_article_creator_automation_policy();

create or replace function public.article_automation_policy(p_article_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_article public.articles%rowtype;
  v_limits jsonb := public.article_automation_admin_limits();
  v_personal jsonb;
  v_result jsonb;
  v_key text;
  v_enabled boolean;
begin
  select * into v_article from public.articles where id = p_article_id;
  if not found then raise exception 'Article was not found.' using errcode = 'P0002'; end if;
  if v_article.automation_policy_version = 0 then
    -- Legacy Google generation followed the two keyword switches. Preserve that
    -- coupling only for old and integration-created articles.
    return v_limits || jsonb_build_object('policyVersion', 0, 'scope', 'legacy',
      'creatorUserId', v_article.created_by,
      'externalAnalysisCommandIds', to_jsonb(public.get_external_analysis_default_command_ids()),
      'autoGenerateGoogleMetadata', (v_limits->>'autoGenerateAlternativeKeywords')::boolean
        or (v_limits->>'autoGenerateLsiKeywords')::boolean);
  end if;
  select preferences into v_personal from public.user_automation_settings
    where user_id = v_article.automation_creator_id;
  v_personal := coalesce(v_personal, public.normalize_user_automation_preferences('{"enabled":false}'::jsonb));
  v_enabled := (v_personal->>'enabled')::boolean and exists (
    select 1 from public.profiles where id = v_article.automation_creator_id and is_active is true
  );
  v_result := v_personal || jsonb_build_object('enabled', v_enabled);
  for v_key in select jsonb_object_keys(v_limits) loop
    if v_key not in ('schemaVersion', 'enabled', 'externalAnalysisCommandIds') then
      v_result := jsonb_set(v_result, array[v_key], to_jsonb(v_enabled
        and coalesce((v_limits->>v_key)::boolean, false)
        and coalesce((v_personal->>v_key)::boolean, false)));
    end if;
  end loop;
  return v_result || jsonb_build_object('policyVersion', 1, 'scope', 'creator',
    'creatorUserId', v_article.automation_creator_id);
end;
$$;

create or replace function public.get_user_automation_settings(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_preferences jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_user_id and is_active is true) then
    raise exception 'Active user was not found.' using errcode = 'P0002';
  end if;
  insert into public.user_automation_settings(user_id, preferences)
  values (p_user_id, public.user_article_automation_defaults()) on conflict (user_id) do nothing;
  select preferences into v_preferences from public.user_automation_settings where user_id = p_user_id;
  return jsonb_build_object('preferences', v_preferences,
    'defaults', public.user_article_automation_defaults(), 'adminLimits', public.article_automation_admin_limits(),
    'eligibleArticleCount', (select count(*) from public.articles
      where automation_policy_version = 1 and automation_creator_id = p_user_id));
end;
$$;

create or replace function public.article_automatic_job_allowed(
  p_article_id uuid, p_job_type text, p_command_id text default null
)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_policy jsonb := public.article_automation_policy(p_article_id);
begin
  if (v_policy->>'policyVersion')::integer = 0 then return true; end if;
  if not (v_policy->>'enabled')::boolean then return false; end if;
  return case p_job_type
    when 'semantic_keywords_lsi' then (v_policy->>'autoGenerateAlternativeKeywords')::boolean
      or (v_policy->>'autoGenerateLsiKeywords')::boolean or (v_policy->>'autoGenerateGoogleMetadata')::boolean
    when 'competitor_discovery' then (v_policy->>'autoDiscoverCompetitors')::boolean
    when 'competitor_extraction' then (v_policy->>'autoExtractCompetitorContent')::boolean
    when 'engineering_command' then (v_policy->>'autoRunReadyEngineeringCommands')::boolean
      and (v_policy->'externalAnalysisCommandIds') ? p_command_id
    when 'content_writing_preparation' then (v_policy->>'contentWritingAutomationEnabled')::boolean
      and (v_policy->>'autoDiscoverCompetitors')::boolean
      and (v_policy->>'autoExtractCompetitorContent')::boolean
    when 'content_writing' then (v_policy->>'contentWritingAutomationEnabled')::boolean
    else false end;
end;
$$;

-- Queue-level defense catches raw legacy enqueue functions and the claim race.
-- In-flight workers retain leases and receive cancellation; completed results
-- are never cleared. Explicit requests and full-pipeline children are untouched.
create or replace function public.guard_creator_automatic_external_job()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_policy jsonb; v_allowed boolean;
begin
  if new.origin <> 'auto' or new.pipeline_parent_job_id is not null then return new; end if;
  v_policy := public.article_automation_policy(new.article_id);
  if (v_policy->>'policyVersion')::integer = 0 then return new; end if;
  new.requested_by := case when exists (select 1 from public.profiles
    where id = (v_policy->>'creatorUserId')::uuid)
    then (v_policy->>'creatorUserId')::uuid else null end;
  if new.status not in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused') then return new; end if;
  v_allowed := public.article_automatic_job_allowed(new.article_id, new.job_type, new.command_id);
  if new.job_type = 'semantic_keywords_lsi' then
    if tg_op = 'UPDATE' and old.status = 'running' then
      v_allowed := v_allowed
        and (not coalesce((new.input_snapshot->>'needsSecondaries')::boolean, false) or (v_policy->>'autoGenerateAlternativeKeywords')::boolean)
        and (not coalesce((new.input_snapshot->>'needsLsi')::boolean, false) or (v_policy->>'autoGenerateLsiKeywords')::boolean)
        and (not coalesce((new.input_snapshot->>'needsGoogleMetadata')::boolean, false) or (v_policy->>'autoGenerateGoogleMetadata')::boolean);
    else
      new.input_snapshot := coalesce(new.input_snapshot, '{}'::jsonb) || jsonb_build_object(
        'needsSecondaries', coalesce((new.input_snapshot->>'needsSecondaries')::boolean, true) and (v_policy->>'autoGenerateAlternativeKeywords')::boolean,
        'needsLsi', coalesce((new.input_snapshot->>'needsLsi')::boolean, true) and (v_policy->>'autoGenerateLsiKeywords')::boolean,
        'needsGoogleMetadata', coalesce((new.input_snapshot->>'needsGoogleMetadata')::boolean, true) and (v_policy->>'autoGenerateGoogleMetadata')::boolean,
        'automationSettings', v_policy);
      v_allowed := v_allowed and ((new.input_snapshot->>'needsSecondaries')::boolean
        or (new.input_snapshot->>'needsLsi')::boolean or (new.input_snapshot->>'needsGoogleMetadata')::boolean);
    end if;
  end if;
  if not v_allowed then
    new.cancel_requested_at := coalesce(new.cancel_requested_at, now());
    new.last_error_code := 'creator_automation_disabled';
    new.last_error := 'Automatic work is disabled by the original article creator or administrator.';
    if tg_op <> 'UPDATE' or old.status <> 'running' then
      if tg_op = 'UPDATE' and new.status = 'running' then
        -- A cancelled claim is not a paid attempt and must not consume the
        -- once-per-article guard before any worker actually starts.
        new.attempt_count := old.attempt_count;
        new.started_at := old.started_at;
        new.lease_generation := old.lease_generation;
      end if;
      new.status := 'cancelled'; new.next_attempt_at := null;
      new.locked_by := null; new.locked_at := null; new.lease_expires_at := null;
      new.completed_at := coalesce(new.completed_at, now());
    end if;
  end if;
  return new;
end;
$$;
create trigger zz_guard_creator_automatic_external_job
before insert or update on public.ai_external_analysis_jobs for each row
execute function public.guard_creator_automatic_external_job();

create or replace function public.guard_creator_automatic_writing_session()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_policy jsonb;
begin
  if new.execution_mode <> 'api' or coalesce(new.context_snapshot->>'triggerSource', '') <> 'automatic_ready' then return new; end if;
  v_policy := public.article_automation_policy(new.article_id);
  if (v_policy->>'policyVersion')::integer = 1 then
    if not (v_policy->>'contentWritingAutomationEnabled')::boolean
      or new.created_by is distinct from (v_policy->>'creatorUserId')::uuid then
      raise exception 'Automatic writing requires the original creator and their enabled policy.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_creator_automatic_writing_session before insert on public.content_writing_sessions
for each row execute function public.guard_creator_automatic_writing_session();

-- Definitions below replace only existing coordinators. Their lifetime and
-- idempotency guards remain intact; there is no deployment-wide requeue.

create or replace function public.enqueue_external_semantic_analysis_job_controlled(
  p_article_id uuid,
  p_origin text default 'auto'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested_origin text := lower(btrim(coalesce(p_origin, 'auto')));
  v_manual boolean := false;
  v_force_regenerate boolean := false;
  v_settings jsonb := public.article_automation_policy(p_article_id);
  v_article public.articles%rowtype;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_has_secondaries boolean := false;
  v_has_lsi boolean := false;
  v_has_google_metadata boolean := false;
  v_needs_secondaries boolean := false;
  v_needs_lsi boolean := false;
  v_needs_google_metadata boolean := false;
  v_attempted_secondaries boolean := false;
  v_attempted_lsi boolean := false;
  v_attempted_google_metadata boolean := false;
  v_execute_secondaries boolean := false;
  v_execute_lsi boolean := false;
  v_execute_google_metadata boolean := false;
  v_existing_job_id uuid;
  v_existing_status text;
  v_job_id uuid;
  v_idempotency_key text;
begin
  if v_requested_origin not in ('auto', 'manual', 'manual_regenerate', 'regenerate', 'manual_force') then
    v_requested_origin := 'auto';
  end if;
  v_manual := v_requested_origin <> 'auto';
  v_force_regenerate := v_requested_origin in ('manual_regenerate', 'regenerate', 'manual_force');

  perform pg_advisory_xact_lock(hashtextextended(
    'external-analysis-auto-once:' || p_article_id::text || ':semantic_keywords_lsi',
    0
  ));

  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id;
  if v_article.id is null then return null; end if;

  select state.* into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;
  if v_state.article_id is null
    or not v_state.semantic_ready
    or nullif(v_state.semantic_readiness_signature, '') is null then
    return null;
  end if;

  perform job.id
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'semantic_keywords_lsi'
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by job.id
  for update;

  v_has_secondaries := public.external_analysis_has_competitor_value(
    coalesce(v_article.keywords, '{}'::jsonb)->'secondaries', 100
  );
  v_has_lsi := public.external_analysis_has_competitor_value(
    coalesce(v_article.keywords, '{}'::jsonb)->'lsi', 100
  );
  v_has_google_metadata := public.semantic_keywords_have_google_metadata(v_article.keywords);

  v_needs_secondaries := (v_force_regenerate or not v_has_secondaries)
    and (v_manual or coalesce((v_settings->>'autoGenerateAlternativeKeywords')::boolean, true));
  v_needs_lsi := (v_force_regenerate or not v_has_lsi)
    and (v_manual or coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true));
  v_needs_google_metadata := (v_force_regenerate or not v_has_google_metadata)
    and (
      v_manual
      or coalesce((v_settings->>'autoGenerateGoogleMetadata')::boolean, false)
    );

  if not v_needs_secondaries and not v_needs_lsi and not v_needs_google_metadata then
    return null;
  end if;

  if not v_manual then
    select
      coalesce(bool_or(case
        when jsonb_typeof(run.progress #> '{semanticTargetAttempt,secondaries}') = 'boolean'
          then (run.progress #>> '{semanticTargetAttempt,secondaries}')::boolean
        else true
      end), false),
      coalesce(bool_or(case
        when jsonb_typeof(run.progress #> '{semanticTargetAttempt,lsi}') = 'boolean'
          then (run.progress #>> '{semanticTargetAttempt,lsi}')::boolean
        else true
      end), false),
      coalesce(bool_or(case
        when jsonb_typeof(run.progress #> '{semanticTargetAttempt,googleMetadata}') = 'boolean'
          then (run.progress #>> '{semanticTargetAttempt,googleMetadata}')::boolean
        else false
      end), false)
    into v_attempted_secondaries, v_attempted_lsi, v_attempted_google_metadata
    from public.ai_external_analysis_runs as run
    join public.ai_external_analysis_jobs as job on job.id = run.job_id
    where job.article_id = p_article_id
      and job.job_type = 'semantic_keywords_lsi'
      and job.last_error_code is distinct from 'duplicate_task_suppressed';

    v_existing_job_id := public.find_external_analysis_stage_job(
      p_article_id, 'semantic_keywords_lsi', null
    );
    if (not v_needs_secondaries or v_attempted_secondaries)
      and (not v_needs_lsi or v_attempted_lsi)
      and (not v_needs_google_metadata or v_attempted_google_metadata) then
      return v_existing_job_id;
    end if;
  end if;

  v_execute_secondaries := v_needs_secondaries and (v_manual or not v_attempted_secondaries);
  v_execute_lsi := v_needs_lsi and (v_manual or not v_attempted_lsi);
  v_execute_google_metadata := v_needs_google_metadata
    and (v_manual or not v_attempted_google_metadata);

  select job.id, job.status
  into v_existing_job_id, v_existing_status
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'semantic_keywords_lsi'
    and job.readiness_signature = v_state.semantic_readiness_signature
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by coalesce(job.completed_at, job.updated_at, job.created_at) desc
  limit 1
  for update;

  if v_existing_job_id is not null
    and v_existing_status = 'running' then
    return v_existing_job_id;
  end if;
  if not v_manual
    and v_existing_job_id is not null
    and v_existing_status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused') then
    return v_existing_job_id;
  end if;

  v_idempotency_key := 'semantic_keywords_lsi:' || v_state.semantic_readiness_signature;
  if v_existing_job_id is null then
    insert into public.ai_external_analysis_jobs (
      article_id, requested_by, job_type, origin, status, idempotency_key,
      readiness_signature, input_snapshot, progress, next_attempt_at, max_attempts
    ) values (
      p_article_id,
      coalesce(v_article.assigned_to, v_article.owner_id, v_article.created_by),
      'semantic_keywords_lsi',
      case when v_manual then 'manual' else 'auto' end,
      'queued',
      v_idempotency_key,
      v_state.semantic_readiness_signature,
      jsonb_build_object(
        'title', v_article.title,
        'plainText', v_article.plain_text,
        'keywords', coalesce(v_article.keywords, '{}'::jsonb),
        'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
        'articleLanguage', v_article.article_language,
        'articleUpdatedAt', v_article.updated_at,
        'readinessSignature', v_state.semantic_readiness_signature,
        'needsSecondaries', v_execute_secondaries,
        'needsLsi', v_execute_lsi,
        'needsGoogleMetadata', v_execute_google_metadata,
        'automaticOnceTargets', jsonb_build_object(
          'secondaries', v_execute_secondaries,
          'lsi', v_execute_lsi,
          'googleMetadata', v_execute_google_metadata
        ),
        'automationSettings', v_settings,
        'controlledOrigin', case when v_manual then 'manual' else 'auto' end,
        'forceRegenerateSemantic', v_force_regenerate
      ),
      jsonb_build_object(
        'stage', 'queued',
        'needsSecondaries', v_execute_secondaries,
        'needsLsi', v_execute_lsi,
        'needsGoogleMetadata', v_execute_google_metadata,
        'updatedAt', now()
      ),
      now(),
      1
    ) returning id into v_job_id;
  else
    v_job_id := v_existing_job_id;
    update public.ai_external_analysis_jobs as job
    set
      requested_by = coalesce(v_article.assigned_to, v_article.owner_id, v_article.created_by, job.requested_by),
      origin = case when v_manual then 'manual' else job.origin end,
      status = case when job.status in ('completed', 'failed', 'blocked', 'cancelled') then 'queued' else job.status end,
      idempotency_key = v_idempotency_key,
      input_snapshot = jsonb_build_object(
        'title', v_article.title,
        'plainText', v_article.plain_text,
        'keywords', coalesce(v_article.keywords, '{}'::jsonb),
        'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
        'articleLanguage', v_article.article_language,
        'articleUpdatedAt', v_article.updated_at,
        'readinessSignature', v_state.semantic_readiness_signature,
        'needsSecondaries', v_execute_secondaries,
        'needsLsi', v_execute_lsi,
        'needsGoogleMetadata', v_execute_google_metadata,
        'automaticOnceTargets', jsonb_build_object(
          'secondaries', v_execute_secondaries,
          'lsi', v_execute_lsi,
          'googleMetadata', v_execute_google_metadata
        ),
        'automationSettings', v_settings,
        'controlledOrigin', case when v_manual then 'manual' else 'auto' end,
        'forceRegenerateSemantic', v_force_regenerate
      ),
      result = case when job.status in ('completed', 'failed', 'blocked', 'cancelled') then null else job.result end,
      progress = jsonb_build_object(
        'stage', case when job.status in ('completed', 'failed', 'blocked', 'cancelled') then 'queued' else job.status end,
        'needsSecondaries', v_execute_secondaries,
        'needsLsi', v_execute_lsi,
        'needsGoogleMetadata', v_execute_google_metadata,
        'updatedAt', now()
      ),
      last_error = case when job.status in ('completed', 'failed', 'blocked', 'cancelled') then null else job.last_error end,
      last_error_code = case when job.status in ('completed', 'failed', 'blocked', 'cancelled') then null else job.last_error_code end,
      next_attempt_at = case when job.status in ('completed', 'failed', 'blocked', 'cancelled') then now() else job.next_attempt_at end,
      locked_by = case when job.status in ('completed', 'failed', 'blocked', 'cancelled') then null else job.locked_by end,
      locked_at = case when job.status in ('completed', 'failed', 'blocked', 'cancelled') then null else job.locked_at end,
      lease_expires_at = case when job.status in ('completed', 'failed', 'blocked', 'cancelled') then null else job.lease_expires_at end,
      cancel_requested_at = null,
      completed_at = case when job.status in ('completed', 'failed', 'blocked', 'cancelled') then null else job.completed_at end,
      max_attempts = case when v_manual then greatest(job.max_attempts, job.attempt_count + 1) else greatest(1, job.attempt_count) end,
      updated_at = now()
    where job.id = v_job_id;
  end if;

  update public.ai_external_analysis_article_state as state
  set semantic_last_enqueued_signature = v_state.semantic_readiness_signature,
      updated_at = now()
  where state.article_id = p_article_id;

  return v_job_id;
end;
$$;

create or replace function public.enqueue_competitor_discovery_job_by_signature(
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
  v_settings jsonb := public.article_automation_policy(p_article_id);
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
  v_settings jsonb := public.article_automation_policy(p_article_id);
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

  if not coalesce((v_settings->>'autoExtractCompetitorContent')::boolean, false)
     or ((v_settings->>'policyVersion')::integer = 0
       and not coalesce((v_settings->>'autoDiscoverCompetitors')::boolean, true)) then
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

create or replace function public.enqueue_automatic_competitor_extraction_for_discovery(
  p_discovery_job_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_discovery public.ai_external_analysis_jobs%rowtype;
  v_sources jsonb := '[]'::jsonb;
  v_selected_qualifications jsonb := '{}'::jsonb;
  v_selected_urls jsonb := '[]'::jsonb;
  v_source_signature text;
  v_existing_job_id uuid;
  v_result jsonb;
  v_extraction_job_id uuid;
  v_requested_by uuid;
  v_auto_discovery_enabled boolean := true;
  v_policy jsonb;
begin
  if p_discovery_job_id is null
     or not public.competitor_content_auto_extraction_enabled() then
    return null;
  end if;

  select job.*
  into v_discovery
  from public.ai_external_analysis_jobs as job
  where job.id = p_discovery_job_id
    and job.job_type = 'competitor_discovery'
    and job.status = 'completed'
  for update;

  if not found or v_discovery.pipeline_parent_job_id is not null then
    return null;
  end if;

  v_policy := public.article_automation_policy(v_discovery.article_id);
  if not (v_policy->>'autoExtractCompetitorContent')::boolean then return null; end if;

  if v_discovery.origin = 'auto' then
    select coalesce(case
      when jsonb_typeof(setting.value->'autoDiscoverCompetitors') = 'boolean'
        then (setting.value->>'autoDiscoverCompetitors')::boolean
      else true
    end, true)
    into v_auto_discovery_enabled
    from public.app_settings as setting
    where setting.key = 'system'
      and setting.is_secret is false
    limit 1;
    if not coalesce(v_auto_discovery_enabled, true) then return null; end if;
  end if;

  select coalesce(jsonb_agg(candidate.source order by candidate.selection_rank), '[]'::jsonb)
  into v_sources
  from (
    select
      coalesce(nullif(result_row.value->>'selectionRank', '')::integer, result_row.ordinality::integer) as selection_rank,
      jsonb_build_object(
        'url', coalesce(nullif(result_row.value->>'url', ''), result_row.value->>'canonicalUrl'),
        'canonicalUrl', coalesce(nullif(result_row.value->>'canonicalUrl', ''), result_row.value->>'url'),
        'domain', coalesce(result_row.value->>'domain', ''),
        'title', coalesce(result_row.value->>'title', ''),
        'description', coalesce(result_row.value->>'description', ''),
        'searchPosition', coalesce(nullif(result_row.value->>'position', '')::integer, result_row.ordinality::integer),
        'autoSelected', true,
        'contentQualification', case
          when jsonb_typeof(result_row.value->'contentQualification') = 'object'
            then result_row.value->'contentQualification'
          else '{}'::jsonb
        end
      ) as source
    from jsonb_array_elements(
      case
        when jsonb_typeof(v_discovery.result->'results') = 'array'
          then v_discovery.result->'results'
        else '[]'::jsonb
      end
    ) with ordinality as result_row(value, ordinality)
    where coalesce((result_row.value->>'autoSelected')::boolean, false)
      and coalesce((result_row.value->>'eligible')::boolean, true)
      and nullif(coalesce(
        result_row.value->>'canonicalUrl',
        result_row.value->>'url',
        ''
      ), '') is not null
    order by selection_rank
    limit 5
  ) as candidate;

  if jsonb_array_length(v_sources) = 0 then return null; end if;

  select
    coalesce(jsonb_object_agg(
      source.value->>'canonicalUrl',
      jsonb_build_object(
        'autoSelected', true,
        'qualificationRequired', coalesce(source.value #>> '{contentQualification,status}', '') = 'qualified',
        'status', coalesce(source.value #>> '{contentQualification,status}', 'unavailable'),
        'score', coalesce(nullif(source.value #>> '{contentQualification,score}', '')::numeric, 0),
        'matchedKeyword', coalesce(source.value #>> '{contentQualification,matchedKeyword}', ''),
        'matchKind', coalesce(source.value #>> '{contentQualification,matchKind}', '')
      )
    ), '{}'::jsonb),
    coalesce(jsonb_agg(to_jsonb(source.value->>'canonicalUrl')), '[]'::jsonb)
  into v_selected_qualifications, v_selected_urls
  from jsonb_array_elements(v_sources) as source(value);

  v_source_signature := md5(v_sources::text);

  select job.id
  into v_existing_job_id
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_discovery.article_id
    and job.job_type = 'competitor_extraction'
    and job.input_snapshot->>'discoveryJobId' = v_discovery.id::text
    and job.input_snapshot->>'discoveryResultSignature' = v_source_signature
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by job.created_at desc
  limit 1;

  if v_existing_job_id is not null then
    update public.ai_external_analysis_jobs as discovery
    set result = coalesce(discovery.result, '{}'::jsonb) || jsonb_build_object(
          'reviewStatus', 'accepted',
          'selectedUrls', v_selected_urls,
          'autoExtractionJobId', v_existing_job_id,
          'autoExtractionStatus', 'reused'
        ),
        progress = coalesce(discovery.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'extraction_queued',
          'extractionJobId', v_existing_job_id,
          'updatedAt', now()
        ),
        updated_at = now()
    where discovery.id = v_discovery.id;
    return v_existing_job_id;
  end if;

  -- An explicit extraction started during discovery already satisfies the gate;
  -- do not replace its rows or create a competing worker task.
  select job.id
  into v_existing_job_id
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_discovery.article_id
    and job.job_type = 'competitor_extraction'
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    )
    and job.cancel_requested_at is null
  order by job.created_at desc
  limit 1;

  if v_existing_job_id is not null then
    update public.ai_external_analysis_jobs as discovery
    set result = coalesce(discovery.result, '{}'::jsonb) || jsonb_build_object(
          'reviewStatus', 'accepted',
          'selectedUrls', v_selected_urls,
          'autoExtractionJobId', v_existing_job_id,
          'autoExtractionStatus', 'existing_active'
        ),
        progress = coalesce(discovery.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'extraction_queued',
          'extractionJobId', v_existing_job_id,
          'updatedAt', now()
        ),
        updated_at = now()
    where discovery.id = v_discovery.id;
    return v_existing_job_id;
  end if;

  select coalesce(
    case when (v_policy->>'policyVersion')::integer = 1 then (v_policy->>'creatorUserId')::uuid end,
    v_discovery.requested_by,
    article.assigned_to,
    article.owner_id,
    article.created_by
  )
  into v_requested_by
  from public.articles as article
  where article.id = v_discovery.article_id;
  if v_requested_by is null then return null; end if;

  begin
    v_result := public.enqueue_competitor_extraction_job(
      v_discovery.article_id,
      v_requested_by,
      coalesce(nullif(v_discovery.result->>'queryType', ''), 'title'),
      coalesce(v_discovery.result->>'query', ''),
      v_sources
    );
    v_extraction_job_id := nullif(v_result #>> '{job,id}', '')::uuid;
  exception when sqlstate 'P0001' then
    select job.id
    into v_extraction_job_id
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_discovery.article_id
      and job.job_type = 'competitor_extraction'
      and job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      )
    order by job.created_at desc
    limit 1;
  end;

  if v_extraction_job_id is null then return null; end if;

  update public.ai_external_analysis_jobs as extraction
  set origin = case when (v_policy->>'policyVersion')::integer = 1 or v_discovery.origin = 'auto' then 'auto' else 'manual' end,
      readiness_signature = coalesce(v_discovery.readiness_signature, extraction.readiness_signature),
      input_snapshot = coalesce(extraction.input_snapshot, '{}'::jsonb) || jsonb_build_object(
        'discoveryJobId', v_discovery.id,
        'discoverySignature', coalesce(v_discovery.readiness_signature, ''),
        'discoveryResultSignature', v_source_signature,
        'selectedQualifications', v_selected_qualifications,
        'automaticSelectionAccepted', true
      ),
      updated_at = now()
  where extraction.id = v_extraction_job_id;

  update public.article_competitors as competitor
  set discovery_signature = v_discovery.readiness_signature,
      updated_at = now()
  where competitor.article_id = v_discovery.article_id;
  perform public.sync_article_competitors_metadata(v_discovery.article_id);

  update public.ai_external_analysis_jobs as discovery
  set result = coalesce(discovery.result, '{}'::jsonb) || jsonb_build_object(
        'reviewStatus', 'accepted',
        'reviewedBy', v_requested_by,
        'reviewedAt', now(),
        'selectedUrls', v_selected_urls,
        'autoExtractionJobId', v_extraction_job_id,
        'autoExtractionStatus', 'queued'
      ),
      progress = coalesce(discovery.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'extraction_queued',
        'selectedCount', jsonb_array_length(v_sources),
        'extractionJobId', v_extraction_job_id,
        'updatedAt', now()
      ),
      updated_at = now()
  where discovery.id = v_discovery.id;

  return v_extraction_job_id;
end;
$$;

create or replace function public.enqueue_external_engineering_jobs_sequential_base_before_google_metadata(
  p_article_id uuid,
  p_origin text
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_policy jsonb := public.article_automation_policy(p_article_id);
  v_state public.ai_external_analysis_article_state%rowtype;
  v_origin text := lower(btrim(coalesce(p_origin, 'auto')));
  v_semantic_ready boolean := false;
  v_semantic_job_id uuid;
  v_previous_job_id uuid;
  v_job_id uuid;
  v_job_status text;
  v_initial_status text;
  v_dependency_id uuid;
  v_idempotency_key text;
  v_batch_key text;
  v_job_ids uuid[] := array[]::uuid[];
  v_all_command_ids text[] := array[]::text[];
  v_command_ids text[] := array[]::text[];
  v_command_count integer := 0;
  v_selection_mode text := 'default';
  v_selection_signature text;
  v_command record;
begin
  if v_origin not in ('auto', 'manual') then
    raise exception 'unsupported external engineering origin %', p_origin;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'external-engineering-enqueue:' || p_article_id::text,
    0
  ));

  select article.*
  into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null then return v_job_ids; end if;

  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

  if v_state.article_id is null
    or not v_state.external_analysis_ready
    or nullif(v_state.external_analysis_readiness_signature, '') is null then
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
    return v_job_ids;
  end if;

  v_selection_mode := case
    when v_state.engineering_command_mode = 'custom' then 'custom'
    else 'default'
  end;

  if v_origin = 'auto' and (v_policy->>'policyVersion')::integer = 1 then
    if not (v_policy->>'autoRunReadyEngineeringCommands')::boolean then return v_job_ids; end if;
    select coalesce(array_agg(selected.command_id order by selected.position), array[]::text[])
    into v_all_command_ids
    from jsonb_array_elements_text(v_policy->'externalAnalysisCommandIds') with ordinality as selected(command_id, position)
    join public.external_analysis_command_catalog() as catalog on catalog.command_id = selected.command_id;
    v_selection_mode := 'creator';
  elsif v_selection_mode = 'custom' then
    select coalesce(array_agg(item.command_id order by item.first_position), array[]::text[])
    into v_all_command_ids
    from (
      select catalog.command_id, min(selected.position) as first_position
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(v_state.custom_engineering_command_ids) = 'array'
            then v_state.custom_engineering_command_ids
          else '[]'::jsonb
        end
      ) with ordinality as selected(command_id, position)
      join public.external_analysis_command_catalog() as catalog
        on catalog.command_id = nullif(btrim(selected.command_id), '')
      group by catalog.command_id
    ) as item;
  else
    v_all_command_ids := public.get_external_analysis_default_command_ids();
  end if;

  v_selection_signature := md5(
    v_selection_mode || ':' || coalesce(array_to_string(v_all_command_ids, '|'), '')
  );

  perform public.cancel_external_engineering_jobs_not_selected(
    p_article_id,
    v_all_command_ids,
    v_origin = 'manual'
  );
  perform public.cancel_stale_external_engineering_jobs(
    p_article_id,
    v_state.external_analysis_readiness_signature,
    false
  );

  if v_origin = 'auto' then
    select coalesce(array_agg(selected.command_id order by selected.position), array[]::text[])
    into v_command_ids
    from unnest(v_all_command_ids) with ordinality as selected(command_id, position)
    where not exists (
      select 1
      from public.ai_external_analysis_jobs as previous
      where previous.article_id = p_article_id
        and previous.job_type = 'engineering_command'
        and previous.command_id = selected.command_id
        and previous.last_error_code is distinct from 'duplicate_task_suppressed'
        and (
          previous.attempt_count > 0
          or previous.started_at is not null
          or previous.result is not null
        )
    );
  else
    v_command_ids := v_all_command_ids;
  end if;

  v_command_count := cardinality(v_command_ids);
  if v_command_count = 0 then
    update public.ai_external_analysis_article_state as state
    set
      external_analysis_last_enqueued_signature = v_state.external_analysis_readiness_signature,
      external_analysis_last_command_selection_signature = v_selection_signature,
      external_analysis_effective_command_ids = to_jsonb(v_all_command_ids),
      updated_at = now()
    where state.article_id = v_article.id;
    return v_job_ids;
  end if;

  v_semantic_ready := public.external_analysis_has_competitor_value(
    v_article.keywords->'secondaries',
    100
  ) and public.external_analysis_has_competitor_value(
    v_article.keywords->'lsi',
    100
  );

  if not v_semantic_ready then
    v_semantic_job_id := public.enqueue_external_semantic_analysis_job_controlled(
      p_article_id,
      v_origin
    );
  end if;

  v_batch_key := 'external-engineering:'
    || v_article.id::text || ':'
    || v_state.external_analysis_readiness_signature || ':'
    || v_selection_signature;

  for v_command in
    select
      selected.position::integer as sequence_number,
      catalog.command_id,
      catalog.command_label
    from unnest(v_command_ids) with ordinality as selected(command_id, position)
    join public.external_analysis_command_catalog() as catalog
      on catalog.command_id = selected.command_id
    order by selected.position
  loop
    v_job_id := null;
    v_job_status := null;
    v_idempotency_key := 'engineering:'
      || v_command.command_id || ':'
      || v_state.external_analysis_readiness_signature;
    v_dependency_id := case
      when v_command.sequence_number = 1 and v_semantic_ready then null
      when v_command.sequence_number = 1 then v_semantic_job_id
      else v_previous_job_id
    end;
    v_initial_status := case
      when v_command.sequence_number = 1
        and not v_semantic_ready
        and v_semantic_job_id is null then 'waiting_for_prerequisites'
      else 'queued'
    end;

    perform pg_advisory_xact_lock(hashtextextended(
      v_article.id::text || ':' || v_idempotency_key,
      0
    ));

    select job.id, job.status
    into v_job_id, v_job_status
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_article.id
      and job.job_type = 'engineering_command'
      and job.command_id = v_command.command_id
      and job.readiness_signature = v_state.external_analysis_readiness_signature
      and job.last_error_code is distinct from 'duplicate_task_suppressed'
    order by
      case
        when job.status = 'completed' then 0
        when job.status in (
          'running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused'
        ) then 1
        when job.status in ('failed', 'blocked') then 2
        else 3
      end,
      coalesce(job.completed_at, job.updated_at, job.created_at) desc
    limit 1
    for update;

    if v_job_id is not null
      and v_job_status in ('failed', 'blocked', 'cancelled') then
      update public.ai_external_analysis_jobs as job
      set
        requested_by = coalesce(
          case
            when v_selection_mode = 'custom'
              then v_state.engineering_command_selection_updated_by
            else null
          end,
          v_article.assigned_to,
          v_article.owner_id,
          v_article.created_by
        ),
        origin = v_origin,
        status = v_initial_status,
        idempotency_key = v_idempotency_key,
        batch_key = v_batch_key,
        sequence_number = v_command.sequence_number,
        command_label = v_command.command_label,
        depends_on_job_id = v_dependency_id,
        input_snapshot = jsonb_build_object(
          'title', v_article.title,
          'plainText', v_article.plain_text,
          'keywords', coalesce(v_article.keywords, '{}'::jsonb),
          'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
          'articleLanguage', v_article.article_language,
          'competitors', coalesce(v_article.metadata->'attachments'->'competitors', '{}'::jsonb),
          'articleUpdatedAt', v_article.updated_at,
          'readinessSignature', v_state.external_analysis_readiness_signature,
          'selectionMode', v_selection_mode,
          'selectionSignature', v_selection_signature,
          'commandSequence', v_command.sequence_number,
          'commandTotal', v_command_count,
          'commandId', v_command.command_id
        ),
        result = null,
        progress = jsonb_build_object(
          'stage', v_initial_status,
          'source', 'failed_task_retry',
          'selectionMode', v_selection_mode,
          'commandSequence', v_command.sequence_number,
          'commandTotal', v_command_count,
          'updatedAt', now()
        ),
        last_error = null,
        last_error_code = null,
        next_attempt_at = case when v_initial_status = 'queued' then now() else null end,
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        cancel_requested_at = null,
        completed_at = null,
        updated_at = now()
      where job.id = v_job_id;
      v_job_status := v_initial_status;
    end if;

    if v_job_id is null then
      insert into public.ai_external_analysis_jobs (
        article_id,
        requested_by,
        job_type,
        origin,
        status,
        idempotency_key,
        batch_key,
        sequence_number,
        command_id,
        command_label,
        depends_on_job_id,
        readiness_signature,
        input_snapshot,
        progress,
        next_attempt_at
      ) values (
        v_article.id,
        coalesce(
          case
            when v_selection_mode = 'custom'
              then v_state.engineering_command_selection_updated_by
            else null
          end,
          v_article.assigned_to,
          v_article.owner_id,
          v_article.created_by
        ),
        'engineering_command',
        v_origin,
        v_initial_status,
        v_idempotency_key,
        v_batch_key,
        v_command.sequence_number,
        v_command.command_id,
        v_command.command_label,
        v_dependency_id,
        v_state.external_analysis_readiness_signature,
        jsonb_build_object(
          'title', v_article.title,
          'plainText', v_article.plain_text,
          'keywords', coalesce(v_article.keywords, '{}'::jsonb),
          'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
          'articleLanguage', v_article.article_language,
          'competitors', coalesce(v_article.metadata->'attachments'->'competitors', '{}'::jsonb),
          'articleUpdatedAt', v_article.updated_at,
          'readinessSignature', v_state.external_analysis_readiness_signature,
          'selectionMode', v_selection_mode,
          'selectionSignature', v_selection_signature,
          'commandSequence', v_command.sequence_number,
          'commandTotal', v_command_count,
          'commandId', v_command.command_id
        ),
        jsonb_build_object(
          'stage', v_initial_status,
          'selectionMode', v_selection_mode,
          'commandSequence', v_command.sequence_number,
          'commandTotal', v_command_count,
          'updatedAt', now()
        ),
        case when v_initial_status = 'queued' then now() else null end
      )
      on conflict do nothing
      returning id, status into v_job_id, v_job_status;
    end if;

    if v_job_id is null then
      select job.id, job.status
      into v_job_id, v_job_status
      from public.ai_external_analysis_jobs as job
      where job.article_id = v_article.id
        and job.job_type = 'engineering_command'
        and job.command_id = v_command.command_id
        and job.readiness_signature = v_state.external_analysis_readiness_signature
        and job.last_error_code is distinct from 'duplicate_task_suppressed'
      order by job.created_at
      limit 1;
    end if;

    if v_job_id is null then
      raise exception 'could not create or reuse external engineering command %', v_command.command_id;
    end if;

    if v_job_status = 'waiting_for_prerequisites'
      and (
        v_command.sequence_number > 1
        or v_semantic_ready
        or v_semantic_job_id is not null
      ) then
      update public.ai_external_analysis_jobs as job
      set
        status = 'queued',
        depends_on_job_id = v_dependency_id,
        next_attempt_at = now(),
        progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'queued',
          'updatedAt', now()
        ),
        updated_at = now()
      where job.id = v_job_id
        and job.status = 'waiting_for_prerequisites';
      v_job_status := 'queued';
    elsif v_job_status in ('queued', 'paused') then
      update public.ai_external_analysis_jobs as job
      set depends_on_job_id = v_dependency_id, updated_at = now()
      where job.id = v_job_id;
    end if;

    update public.ai_external_analysis_jobs as job
    set
      max_attempts = case
        when v_origin = 'manual' then greatest(job.max_attempts, job.attempt_count + 1)
        else greatest(1, job.attempt_count)
      end,
      updated_at = now()
    where job.id = v_job_id
      and (v_origin = 'manual' or job.origin = 'auto');

    v_job_ids := array_append(v_job_ids, v_job_id);
    v_previous_job_id := v_job_id;
  end loop;

  if cardinality(v_job_ids) = v_command_count then
    update public.ai_external_analysis_article_state as state
    set
      external_analysis_last_enqueued_signature = v_state.external_analysis_readiness_signature,
      external_analysis_last_command_selection_signature = v_selection_signature,
      external_analysis_effective_command_ids = to_jsonb(v_all_command_ids),
      updated_at = now()
    where state.article_id = v_article.id;
  end if;

  return v_job_ids;
end;
$$;

create or replace function public.enqueue_external_engineering_jobs_sequential_base(
  p_article_id uuid,
  p_origin text
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keywords jsonb := '{}'::jsonb;
  v_policy jsonb := public.article_automation_policy(p_article_id);
  v_semantic_job_id uuid;
  v_job_ids uuid[] := array[]::uuid[];
begin
  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = p_article_id;
  if not found then return v_job_ids; end if;

  if public.semantic_keywords_have_google_metadata(v_keywords)
    or (lower(btrim(coalesce(p_origin, 'auto'))) = 'auto'
      and (v_policy->>'policyVersion')::integer = 1
      and not (v_policy->>'autoGenerateGoogleMetadata')::boolean) then
    return public.enqueue_external_engineering_jobs_sequential_base_before_google_metadata(
      p_article_id, p_origin
    );
  end if;

  v_semantic_job_id := public.enqueue_external_semantic_analysis_job_controlled(
    p_article_id,
    case when lower(btrim(coalesce(p_origin, 'auto'))) = 'manual' then 'manual' else 'auto' end
  );
  if v_semantic_job_id is null then
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
    return v_job_ids;
  end if;

  v_job_ids := public.enqueue_external_engineering_jobs_sequential_base_before_google_metadata(
    p_article_id, p_origin
  );
  if cardinality(v_job_ids) > 0 then
    update public.ai_external_analysis_jobs as job
    set
      status = 'waiting_for_prerequisites',
      depends_on_job_id = v_semantic_job_id,
      next_attempt_at = null,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'waiting_for_prerequisites',
        'reason', 'unified_semantic_google_metadata_required',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.id = v_job_ids[1]
      and job.status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused');
  end if;

  return v_job_ids;
end;
$$;

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
  v_job_ids uuid[] := array[]::uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended('ready-engineering-command-automation', 0));
  v_settings := public.article_automation_policy(p_article_id);

  select state.*
  into v_state
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

  update public.ai_external_analysis_jobs as job
  set
    cancel_requested_at = null,
    last_error_code = null,
    last_error = null,
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'running',
      'source', 'ready_engineering_commands_automation_reenabled',
      'updatedAt', now()
    ),
    updated_at = now()
  where job.article_id = p_article_id
    and job.job_type = 'engineering_command'
    and job.origin = 'auto'
    and job.status = 'running'
    and job.last_error_code = 'ready_engineering_commands_automation_disabled';

  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = p_article_id;
  if not found then return v_job_ids; end if;

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
    perform public.enqueue_external_semantic_analysis_job_controlled(p_article_id, 'auto');
    return v_job_ids;
  end if;

  if v_has_secondaries and v_has_lsi then
    v_job_ids := public.enqueue_external_engineering_jobs_controlled(
      p_article_id,
      null,
      'auto'
    );
  else
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
  end if;

  return v_job_ids;
end;
$$;

create or replace function public.claim_next_content_writing_automation_item(
  p_worker_id text,
  p_provider text,
  p_model text default '',
  p_min_competitor_count integer default 1,
  p_require_processing_complete boolean default true,
  p_max_attempts integer default 3,
  p_lease_seconds integer default 300
)
returns public.content_writing_automation_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.content_writing_automation_state%rowtype;
  v_article public.articles%rowtype;
  v_item public.content_writing_automation_items%rowtype;
  v_readiness jsonb;
  v_requested_by uuid;
  v_min_competitors integer := greatest(1, least(coalesce(p_min_competitor_count, 1), 5));
  v_max_attempts integer := greatest(1, least(coalesce(p_max_attempts, 3), 10));
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 300), 1800));
begin
  if nullif(btrim(coalesce(p_worker_id, '')), '') is null then
    raise exception 'Automation worker id is required.' using errcode = '22023';
  end if;
  if p_provider not in ('gemini', 'geminiPaid', 'openai') then
    raise exception 'A valid automation provider is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('content-writing-automation-claim', 0));

  update public.content_writing_automation_items as item
  set
    status = case
      when item.attempt_count >= item.max_attempts then 'blocked'
      else 'ready'
    end,
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    eligible_at = case
      when item.attempt_count >= item.max_attempts then item.eligible_at
      else least(item.eligible_at, now())
    end,
    last_error_code = 'automation_claim_lease_expired',
    last_error = 'The automatic-writing reservation expired before a session was attached.',
    completed_at = case
      when item.attempt_count >= item.max_attempts then now()
      else null
    end
  where item.status = 'claiming'
    and coalesce(item.lease_expires_at, item.locked_at, item.updated_at) <= now();

  select state.*
  into v_state
  from public.content_writing_automation_state as state
  where state.singleton is true
  for update;

  if coalesce(v_state.next_allowed_at, now()) > now() then
    return null;
  end if;

  if exists (
    select 1
    from public.content_writing_automation_items as item
    where item.status in ('claiming', 'writing')
  ) then
    return null;
  end if;

  if exists (
    select 1
    from public.content_writing_sessions as session
    where session.execution_mode = 'api'
      and session.status in ('queued', 'running', 'retry_scheduled')
  ) then
    return null;
  end if;

  if exists (
    select 1
    from public.ai_external_analysis_jobs as job
    where job.job_type = 'full_article_pipeline'
      and (
        job.status in ('queued', 'running')
        or (
          job.status = 'retry_scheduled'
          and coalesce(job.next_attempt_at, now()) <= now()
        )
      )
  ) then
    return null;
  end if;

  select article.*
  into v_article
  from public.articles as article
  left join public.content_writing_automation_items as existing
    on existing.article_id = article.id
  cross join lateral (
    select public.evaluate_content_writing_automation_readiness(article.id) as value
  ) as readiness
  where article.status in ('content_preparation', 'draft')
    and public.article_automatic_job_allowed(article.id, 'content_writing')
    and coalesce((readiness.value ->> 'ready')::boolean, false) is true
    and coalesce((readiness.value ->> 'usableCompetitorCount')::integer, 0) >= v_min_competitors
    and (
      p_require_processing_complete is not true
      or coalesce((readiness.value ->> 'processingComplete')::boolean, false) is true
    )
    and (existing.id is null or (
      existing.status = 'ready'
      and existing.eligible_at <= now()
      and existing.attempt_count < existing.max_attempts
    ))
    and (
      existing.id is not null
      or not exists (
        select 1
        from public.content_writing_sessions as completed_session
        where completed_session.article_id = article.id
          and completed_session.status = 'completed'
      )
    )
    and not exists (
      select 1
      from public.ai_external_analysis_jobs as article_pipeline
      where article_pipeline.article_id = article.id
        and article_pipeline.job_type = 'full_article_pipeline'
        and article_pipeline.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    )
  order by coalesce(existing.ready_at, article.updated_at, article.created_at), article.id
  limit 1
  for update of article skip locked;

  if v_article.id is null then
    return null;
  end if;

  v_readiness := public.evaluate_content_writing_automation_readiness(v_article.id);
  select profile.id
  into v_requested_by
  from public.profiles as profile
  where ((v_article.automation_policy_version = 1 and profile.id = v_article.automation_creator_id)
      or (v_article.automation_policy_version = 0 and profile.id in (v_article.assigned_to, v_article.owner_id, v_article.created_by)))
    and profile.is_active is true
    and public.article_access_level_for_user(v_article.id, profile.id) in ('write', 'admin')
  order by case profile.id
    when v_article.assigned_to then 1
    when v_article.owner_id then 2
    else 3
  end
  limit 1;

  if v_requested_by is null and v_article.automation_policy_version = 0 then
    select profile.id
    into v_requested_by
    from public.profiles as profile
    where profile.role = 'admin'::public.app_role
      and profile.is_active is true
      and public.article_access_level_for_user(v_article.id, profile.id) in ('write', 'admin')
    order by profile.created_at
    limit 1;
  end if;

  if v_requested_by is null then
    return null;
  end if;

  insert into public.content_writing_automation_items (
    article_id,
    requested_by,
    status,
    readiness_signature,
    usable_competitor_count,
    pending_competitor_count,
    provider,
    model,
    session_sequence,
    attempt_count,
    max_attempts,
    ready_at,
    eligible_at,
    locked_by,
    locked_at,
    lease_expires_at,
    started_at,
    last_error_code,
    last_error
  ) values (
    v_article.id,
    v_requested_by,
    'claiming',
    coalesce(v_readiness ->> 'signature', ''),
    coalesce((v_readiness ->> 'usableCompetitorCount')::integer, 0),
    coalesce((v_readiness ->> 'pendingCompetitorCount')::integer, 0),
    p_provider,
    left(btrim(coalesce(p_model, '')), 160),
    1,
    1,
    v_max_attempts,
    now(),
    now(),
    left(btrim(p_worker_id), 200),
    now(),
    now() + make_interval(secs => v_lease_seconds),
    now(),
    null,
    null
  )
  on conflict (article_id) do update
  set
    requested_by = excluded.requested_by,
    status = 'claiming',
    readiness_signature = excluded.readiness_signature,
    usable_competitor_count = excluded.usable_competitor_count,
    pending_competitor_count = excluded.pending_competitor_count,
    provider = excluded.provider,
    model = excluded.model,
    content_writing_session_id = null,
    session_sequence = case
      when public.content_writing_automation_items.content_writing_session_id is not null
        then public.content_writing_automation_items.session_sequence + 1
      else public.content_writing_automation_items.session_sequence
    end,
    attempt_count = public.content_writing_automation_items.attempt_count + 1,
    max_attempts = excluded.max_attempts,
    eligible_at = now(),
    locked_by = excluded.locked_by,
    locked_at = now(),
    lease_expires_at = excluded.lease_expires_at,
    started_at = coalesce(public.content_writing_automation_items.started_at, now()),
    completed_at = null,
    last_error_code = null,
    last_error = null
  where public.content_writing_automation_items.status = 'ready'
    and public.content_writing_automation_items.eligible_at <= now()
    and public.content_writing_automation_items.attempt_count < public.content_writing_automation_items.max_attempts
  returning * into v_item;

  return v_item;
end;
$$;

create or replace function public.enqueue_next_automatic_writing_competitor_preparation(
  p_min_competitor_count integer default 1
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article_id uuid;
  v_requested_by uuid;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_min_competitors integer := greatest(1, least(coalesce(p_min_competitor_count, 1), 5));
begin
  perform pg_advisory_xact_lock(hashtextextended('automatic-writing-competitor-preparation', 0));

  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.job_type = 'content_writing_preparation'
    and job.origin = 'auto'
    and public.article_automatic_job_allowed(job.article_id, 'content_writing_preparation')
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  order by job.created_at
  limit 1;
  if v_job.id is not null then return v_job; end if;

  select article.id
  into v_article_id
  from public.articles as article
  left join public.content_writing_automation_items as existing
    on existing.article_id = article.id
  cross join lateral (
    select public.evaluate_content_writing_automation_readiness(article.id) as value
  ) as readiness
  where article.status in ('content_preparation', 'draft')
    and public.article_automatic_job_allowed(article.id, 'content_writing_preparation')
    and coalesce((readiness.value ->> 'usableCompetitorCount')::integer, 0) < v_min_competitors
    and coalesce(readiness.value -> 'missingFields', '[]'::jsonb) @> '["competitors"]'::jsonb
    and jsonb_array_length(coalesce(readiness.value -> 'missingFields', '[]'::jsonb)) = 1
    and (existing.id is null or (
      existing.status = 'ready'
      and existing.eligible_at <= now()
      and existing.attempt_count < existing.max_attempts
    ))
    and not exists (
      select 1
      from public.content_writing_sessions as session
      where session.article_id = article.id
        and session.status in ('queued', 'running', 'retry_scheduled', 'completed')
    )
    and not exists (
      select 1
      from public.ai_external_analysis_jobs as pipeline
      where pipeline.article_id = article.id
        and pipeline.job_type = 'full_article_pipeline'
        and pipeline.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    )
    and not exists (
      select 1
      from public.ai_external_analysis_jobs as preparation
      where preparation.article_id = article.id
        and preparation.job_type = 'content_writing_preparation'
        and preparation.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    )
  order by coalesce(existing.ready_at, article.updated_at, article.created_at), article.id
  limit 1
  for update of article skip locked;

  if v_article_id is null then return null; end if;

  select profile.id
  into v_requested_by
  from public.articles as article
  join public.profiles as profile
    on ((article.automation_policy_version = 1 and profile.id = article.automation_creator_id)
      or (article.automation_policy_version = 0 and profile.id in (article.assigned_to, article.owner_id, article.created_by)))
  where article.id = v_article_id
    and profile.is_active is true
    and public.article_access_level_for_user(article.id, profile.id) in ('write', 'admin')
  order by case profile.id
    when article.assigned_to then 1
    when article.owner_id then 2
    else 3
  end
  limit 1;

  if v_requested_by is null and (public.article_automation_policy(v_article_id)->>'policyVersion')::integer = 0 then
    select profile.id
    into v_requested_by
    from public.profiles as profile
    where profile.role = 'admin'::public.app_role
      and profile.is_active is true
      and public.article_access_level_for_user(v_article_id, profile.id) in ('write', 'admin')
    order by profile.created_at
    limit 1;
  end if;
  if v_requested_by is null then return null; end if;

  return public.enqueue_content_writing_competitor_preparation(
    v_article_id,
    v_requested_by,
    'auto',
    'gemini',
    '',
    '',
    v_min_competitors,
    false
  );
end;
$$;

create or replace function public.enqueue_content_writing_competitor_preparation(
  p_article_id uuid,
  p_requested_by uuid,
  p_origin text default 'manual',
  p_provider text default 'gemini',
  p_model text default '',
  p_content_writing_idempotency_key text default '',
  p_min_competitor_count integer default 1,
  p_start_writing boolean default true
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_readiness jsonb := '{}'::jsonb;
  v_other_missing jsonb := '[]'::jsonb;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_min_competitors integer := greatest(1, least(coalesce(p_min_competitor_count, 1), 5));
  v_start_writing boolean := coalesce(p_start_writing, true);
  v_origin text := case when p_origin = 'auto' then 'auto' else 'manual' end;
  v_signature text;
begin
  if v_origin = 'auto' and not public.article_automatic_job_allowed(p_article_id, 'content_writing_preparation') then return null; end if;
  if v_origin = 'auto' and (public.article_automation_policy(p_article_id)->>'policyVersion')::integer = 1 then
    p_requested_by := (public.article_automation_policy(p_article_id)->>'creatorUserId')::uuid;
  end if;
  select article.*
  into v_article
  from public.articles as article
  where article.id = p_article_id
  for update;
  if v_article.id is null then
    raise exception 'Article was not found.' using errcode = 'P0002';
  end if;
  if public.article_access_level_for_user(v_article.id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if v_start_writing and p_provider not in ('gemini', 'geminiPaid', 'openai') then
    raise exception 'A valid content-writing provider is required.' using errcode = '22023';
  end if;
  if v_start_writing
     and nullif(btrim(coalesce(p_content_writing_idempotency_key, '')), '') is null then
    raise exception 'A content-writing idempotency key is required.' using errcode = '22023';
  end if;

  v_readiness := public.evaluate_content_writing_automation_readiness(v_article.id);
  select coalesce(jsonb_agg(missing.value), '[]'::jsonb)
  into v_other_missing
  from jsonb_array_elements(coalesce(v_readiness -> 'missingFields', '[]'::jsonb)) as missing(value)
  where missing.value #>> '{}' <> 'competitors';

  if jsonb_array_length(v_other_missing) > 0 then
    raise exception 'Content-writing prerequisites other than competitor texts are incomplete: %', v_other_missing::text
      using errcode = '22023';
  end if;

  -- A racing extraction may have completed between the API readiness check and
  -- this transaction. The caller can immediately create the writing session.
  if coalesce((v_readiness ->> 'usableCompetitorCount')::integer, 0) >= v_min_competitors
     and coalesce((v_readiness ->> 'processingComplete')::boolean, false) is true then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'content-writing-competitor-preparation:' || v_article.id::text,
    0
  ));

  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.job_type = 'content_writing_preparation'
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  order by job.created_at desc
  limit 1
  for update;

  -- A manual click takes ownership of an already-running automatic preparation
  -- and preserves the user's provider/model choice for the eventual session.
  if v_job.id is not null then
    update public.ai_external_analysis_jobs as job
    set
      requested_by = case when v_start_writing then p_requested_by else job.requested_by end,
      origin = case when v_start_writing then 'manual' else job.origin end,
      input_snapshot = coalesce(job.input_snapshot, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
        'minimumCompetitorCount', greatest(
          coalesce((job.input_snapshot ->> 'minimumCompetitorCount')::integer, 1),
          v_min_competitors
        ),
        'startWriting', coalesce((job.input_snapshot ->> 'startWriting')::boolean, false) or v_start_writing,
        'provider', case when v_start_writing then p_provider else job.input_snapshot ->> 'provider' end,
        'model', case when v_start_writing then left(btrim(coalesce(p_model, '')), 256) else job.input_snapshot ->> 'model' end,
        'contentWritingIdempotencyKey', case
          when v_start_writing then left(btrim(p_content_writing_idempotency_key), 160)
          else job.input_snapshot ->> 'contentWritingIdempotencyKey'
        end,
        'requestedBy', case when v_start_writing then p_requested_by::text else job.input_snapshot ->> 'requestedBy' end
      )),
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'manualWritingRequested', v_start_writing or coalesce((job.input_snapshot ->> 'startWriting')::boolean, false),
        'updatedAt', now()
      ),
      updated_at = now()
    where job.id = v_job.id
    returning job.* into v_job;
    return v_job;
  end if;

  v_signature := md5(jsonb_build_object(
    'articleId', v_article.id,
    'readinessSignature', coalesce(v_readiness ->> 'signature', ''),
    'minimumCompetitorCount', v_min_competitors
  )::text);

  insert into public.ai_external_analysis_jobs (
    article_id,
    requested_by,
    job_type,
    origin,
    status,
    idempotency_key,
    batch_key,
    sequence_number,
    readiness_signature,
    input_snapshot,
    progress,
    next_attempt_at
  ) values (
    v_article.id,
    p_requested_by,
    'content_writing_preparation',
    v_origin,
    'queued',
    'content-writing-competitors:' || v_article.id::text || ':' || v_signature,
    'content-writing-competitors:' || v_article.id::text || ':' || v_signature,
    0,
    v_signature,
    jsonb_build_object(
      'minimumCompetitorCount', v_min_competitors,
      'desiredCompetitorCount', 5,
      'startWriting', v_start_writing,
      'provider', case when v_start_writing then p_provider else '' end,
      'model', case when v_start_writing then left(btrim(coalesce(p_model, '')), 256) else '' end,
      'contentWritingIdempotencyKey', case
        when v_start_writing then left(btrim(p_content_writing_idempotency_key), 160)
        else ''
      end,
      'requestedBy', p_requested_by::text,
      'readinessSignature', coalesce(v_readiness ->> 'signature', '')
    ),
    jsonb_build_object(
      'stage', 'queued',
      'stageIndex', 0,
      'stageCount', 3,
      'updatedAt', now()
    ),
    now()
  )
  returning * into v_job;

  return v_job;
end;
$$;

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
    and article.automation_policy_version = 0
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
      and exists (select 1 from public.articles as article where article.id = job.article_id and article.automation_policy_version = 0)
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
        and not public.external_analysis_has_competitor_value(article.keywords->'lsi', 100)
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
      join public.articles as article on article.id = state.article_id and article.automation_policy_version = 0
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
      join public.articles as article on article.id = state.article_id and article.automation_policy_version = 0
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

create or replace function public.reconcile_creator_article_automation(p_user_id uuid default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_article_id uuid; v_discovery_id uuid;
begin
  -- The queue trigger recalculates each job's current policy. Running requests
  -- keep their leases; jobs not yet started are cancelled in this transaction.
  update public.ai_external_analysis_jobs as job set updated_at = now()
  from public.articles as article
  where article.id = job.article_id and article.automation_policy_version = 1
    and (p_user_id is null or article.automation_creator_id = p_user_id)
    and job.origin = 'auto' and job.pipeline_parent_job_id is null
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');

  update public.ai_external_analysis_runs as run
  set status = 'cancelled', error_code = 'creator_automation_disabled',
    error_message = 'Automatic work was disabled by the original creator or administrator.',
    finished_at = coalesce(run.finished_at, now())
  from public.ai_external_analysis_jobs as job, public.articles as article
  where run.job_id = job.id and article.id = job.article_id
    and article.automation_policy_version = 1
    and (p_user_id is null or article.automation_creator_id = p_user_id)
    and job.status = 'cancelled' and job.last_error_code = 'creator_automation_disabled'
    and run.status = 'running';

  -- A running writing step must persist its already-generated output before the
  -- worker checks the new policy at the next stage boundary. Setting its cancel
  -- flag here would make complete_content_writing_step reject that output.
  update public.content_writing_sessions as session
  set status = 'cancelled',
    cancel_requested_at = coalesce(session.cancel_requested_at, now()),
    last_error_code = 'creator_automation_disabled',
    last_error = 'Automatic writing was disabled by the original creator or administrator.',
    completed_at = coalesce(session.completed_at, now()),
    locked_by = null, locked_at = null, lease_expires_at = null
  from public.articles as article
  where article.id = session.article_id and article.automation_policy_version = 1
    and (p_user_id is null or article.automation_creator_id = p_user_id)
    and session.execution_mode = 'api'
    and session.context_snapshot->>'triggerSource' = 'automatic_ready'
    and session.status in ('queued', 'retry_scheduled')
    and not public.article_automatic_job_allowed(article.id, 'content_writing');

  update public.content_writing_automation_items as item
  set status = 'cancelled', locked_by = null, locked_at = null, lease_expires_at = null,
    completed_at = coalesce(item.completed_at, now()),
    last_error_code = 'creator_automation_disabled',
    last_error = 'Automatic writing was disabled by the original creator or administrator.'
  from public.articles as article
  where article.id = item.article_id and article.automation_policy_version = 1
    and (p_user_id is null or article.automation_creator_id = p_user_id)
    and item.status in ('ready', 'claiming') and item.content_writing_session_id is null
    and not public.article_automatic_job_allowed(article.id, 'content_writing');

  -- Never overwrite extraction currently owned by an explicit manual request.
  update public.article_competitors as competitor
  set status = 'cancelled', error_code = 'creator_automation_disabled',
    error_message = 'Automatic extraction was disabled by the original creator or administrator.', updated_at = now()
  from public.articles as article
  where article.id = competitor.article_id and article.automation_policy_version = 1
    and (p_user_id is null or article.automation_creator_id = p_user_id)
    and competitor.status in ('queued', 'retry_scheduled')
    and not public.article_automatic_job_allowed(article.id, 'competitor_extraction')
    and exists (select 1 from public.ai_external_analysis_jobs as job
      where job.article_id = article.id and job.job_type = 'competitor_extraction'
        and job.origin = 'auto' and job.status = 'cancelled'
        and job.last_error_code = 'creator_automation_disabled')
    and not exists (select 1 from public.ai_external_analysis_jobs as job
      where job.article_id = article.id and job.job_type = 'competitor_extraction'
        and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'));

  -- A user edit may schedule only this rollout's articles belonging to that
  -- original creator. Existing once-only guards protect every completed stage.
  for v_article_id in select article.id from public.articles as article
    join public.ai_external_analysis_article_state as state on state.article_id = article.id
    where article.automation_policy_version = 1
      and (p_user_id is null or article.automation_creator_id = p_user_id)
    order by article.id
  loop
    perform public.enqueue_external_semantic_analysis_job_controlled(v_article_id, 'auto');
    perform public.enqueue_competitor_discovery_job_controlled(v_article_id, null, 'auto');
    perform public.reconcile_automatic_ready_engineering_commands_for_article(v_article_id);
  end loop;
  for v_discovery_id in
    select distinct on (job.article_id) job.id
    from public.ai_external_analysis_jobs as job
    join public.articles as article on article.id = job.article_id
    where article.automation_policy_version = 1
      and (p_user_id is null or article.automation_creator_id = p_user_id)
      and job.job_type = 'competitor_discovery' and job.status = 'completed'
      and job.pipeline_parent_job_id is null
      and public.article_automatic_job_allowed(article.id, 'competitor_extraction')
    order by job.article_id, job.completed_at desc nulls last, job.created_at desc
  loop
    perform public.enqueue_automatic_competitor_extraction_for_discovery(v_discovery_id);
  end loop;
end;
$$;

create or replace function public.save_user_automation_settings(p_user_id uuid, p_preferences jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_preferences jsonb := public.normalize_user_automation_preferences(p_preferences);
begin
  if not exists (select 1 from public.profiles where id = p_user_id and is_active is true) then
    raise exception 'Active user was not found.' using errcode = 'P0002';
  end if;
  insert into public.user_automation_settings(user_id, preferences)
  values (p_user_id, v_preferences)
  on conflict (user_id) do update set preferences = excluded.preferences, updated_at = now();
  perform public.reconcile_creator_article_automation(p_user_id);
  return public.get_user_automation_settings(p_user_id);
end;
$$;

create or replace function public.reconcile_content_research_automation()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.reconcile_legacy_content_research_automation();
  perform public.reconcile_creator_article_automation(null);
end;
$$;

create or replace function public.reconcile_creator_automation_from_settings()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text;
begin
  if new.key not in ('system', 'ai') or new.is_secret then return new; end if;
  if new.key = 'ai' then
    if new.value->'contentWritingAutomationEnabled' is distinct from old.value->'contentWritingAutomationEnabled' then
      perform public.reconcile_creator_article_automation(null);
    end if;
    return new;
  end if;
  -- Editing future-user defaults does not mutate existing preferences or queue
  -- articles. Only operational caps have immediate reconciliation semantics.
  foreach v_key in array array['autoGenerateAlternativeKeywords', 'autoGenerateLsiKeywords',
    'autoGenerateGoogleMetadata', 'autoDiscoverCompetitors', 'autoExtractCompetitorContent',
    'autoRunReadyEngineeringCommands', 'contentWritingAutomationEnabled',
    'autoApplyStrongInternalLinkSuggestions'] loop
    if new.value->v_key is distinct from old.value->v_key then
      perform public.reconcile_creator_article_automation(null);
      exit;
    end if;
  end loop;
  return new;
end;
$$;
create trigger reconcile_creator_automation_from_settings after update of value on public.app_settings
for each row execute function public.reconcile_creator_automation_from_settings();

comment on column public.articles.automation_policy_version is
  '0 keeps legacy/integration behavior; 1 uses immutable original creator preferences. Assigned only at INSERT.';
comment on column public.articles.automation_creator_id is
  'Immutable original creator identity. Never resolved from owner_id, assigned_to or job requested_by.';
comment on table public.user_automation_settings is
  'Private per-user automation preferences. API derives the self user id from the authenticated session; only service-role RPC access is granted.';

create or replace function public.claim_next_external_analysis_job(
  p_worker_id text,
  p_supported_job_types text[],
  p_lease_seconds integer default 300
)
returns setof public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 1800));
  v_article_id uuid;
  v_job_id uuid;
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  if nullif(btrim(coalesce(p_worker_id, '')), '') is null then
    raise exception 'worker id is required' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_supported_job_types), 0) = 0 then return; end if;

  -- A due job that has exhausted its durable attempt budget is dead-lettered
  -- before selection, so it cannot churn forever after worker restarts.
  with exhausted as (
    update public.ai_external_analysis_jobs as job
    set status = 'blocked',
        next_attempt_at = null,
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        dead_lettered_at = coalesce(job.dead_lettered_at, now()),
        dead_letter_reason = coalesce(job.dead_letter_reason, 'external_analysis_attempt_budget_exhausted'),
        last_error_code = 'external_analysis_attempt_budget_exhausted',
        last_error = 'The durable execution attempt budget was exhausted.',
        completed_at = coalesce(job.completed_at, now()),
        progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'dead_lettered',
          'reason', 'external_analysis_attempt_budget_exhausted',
          'updatedAt', now()
        ),
        updated_at = now()
    where job.job_type = any(p_supported_job_types)
      and job.status in ('queued', 'retry_scheduled')
      and job.attempt_count >= job.max_attempts
    returning job.id
  )
  update public.ai_external_analysis_runs as run
  set status = 'blocked',
      error_code = 'external_analysis_attempt_budget_exhausted',
      error_message = 'The durable execution attempt budget was exhausted.',
      finished_at = coalesce(run.finished_at, now())
  from exhausted
  where run.job_id = exhausted.id
    and run.status = 'running';

  -- Keep the claim-time dead-letter transition equivalent to the worker RPC:
  -- a terminal parent must never leave a queued/running child or writing session
  -- alive. Running descendants retain their running status only long enough to
  -- observe cancel_requested_at and relinquish their own fenced lease.
  update public.ai_external_analysis_jobs as child
  set status = case when child.status = 'running' then child.status else 'cancelled' end,
      cancel_requested_at = coalesce(child.cancel_requested_at, now()),
      next_attempt_at = case when child.status = 'running' then child.next_attempt_at else null end,
      last_error_code = 'parent_pipeline_dead_lettered',
      last_error = 'The parent pipeline exhausted its retry budget.',
      completed_at = case when child.status = 'running' then child.completed_at else now() end,
      progress = coalesce(child.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when child.status = 'running' then 'cancel_requested' else 'cancelled' end,
        'reason', 'parent_pipeline_dead_lettered',
        'updatedAt', now()
      ),
      updated_at = now()
  from public.ai_external_analysis_jobs as parent
  where child.pipeline_parent_job_id = parent.id
    and parent.job_type = 'full_article_pipeline'
    and parent.dead_lettered_at is not null
    and child.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');

  update public.content_writing_sessions as session
  set status = case when session.status = 'running' then session.status else 'cancelled' end,
      cancel_requested_at = coalesce(session.cancel_requested_at, now()),
      next_attempt_at = case when session.status = 'running' then session.next_attempt_at else null end,
      last_error_code = 'parent_pipeline_dead_lettered',
      last_error = 'The parent pipeline exhausted its retry budget.',
      completed_at = case when session.status = 'running' then session.completed_at else now() end,
      updated_at = now()
  from public.ai_external_analysis_jobs as parent
  where session.pipeline_parent_job_id = parent.id
    and parent.job_type = 'full_article_pipeline'
    and parent.dead_lettered_at is not null
    and session.status in ('queued', 'running', 'retry_scheduled');

  select job.article_id
  into v_article_id
  from public.ai_external_analysis_jobs as job
  where job.job_type = any(p_supported_job_types)
    and job.cancel_requested_at is null
    and (job.origin <> 'auto' or job.pipeline_parent_job_id is not null
      or public.article_automatic_job_allowed(job.article_id, job.job_type, job.command_id))
    and job.dead_lettered_at is null
    and job.attempt_count < job.max_attempts
    and (
      (job.status = 'running' and job.lease_expires_at is not null and job.lease_expires_at > now())
      or (
        (job.status = 'queued' or (
          job.status = 'retry_scheduled' and coalesce(job.next_attempt_at, now()) <= now()
        ))
        and (
          job.depends_on_job_id is null
          or exists (
            select 1
            from public.ai_external_analysis_jobs as dependency
            where dependency.id = job.depends_on_job_id
              and (
                dependency.status = 'completed'
                or (
                  job.pipeline_parent_job_id = dependency.id
                  and job.job_type = 'engineering_command'
                  and job.input_snapshot ? 'pipelineDraft'
                  and dependency.job_type = 'full_article_pipeline'
                  and dependency.status = 'running'
                  and dependency.cancel_requested_at is null
                  and dependency.lease_expires_at > now()
                  and coalesce((job.input_snapshot->>'pipelineLeaseGeneration')::bigint, -1)
                    = dependency.lease_generation
                )
              )
          )
        )
      )
    )
  group by job.article_id
  order by
    bool_or(job.status = 'running' and job.lease_expires_at > now()) desc,
    bool_or(coalesce(job.progress->>'articleQueueLocked', 'false') = 'true') desc,
    min(case
      when job.status in ('queued', 'retry_scheduled') then coalesce(job.next_attempt_at, job.created_at)
      else job.created_at
    end),
    job.article_id
  limit 1;

  if v_article_id is null then return; end if;

  update public.ai_external_analysis_jobs as job
  set progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'articleQueueLocked', true,
        'articleQueueLockedAt', coalesce(job.progress->'articleQueueLockedAt', to_jsonb(now())),
        'updatedAt', now()
      ),
      updated_at = now()
  where job.article_id = v_article_id
    and job.job_type = any(p_supported_job_types)
    and job.status in ('queued', 'running', 'retry_scheduled')
    and job.cancel_requested_at is null
    and (job.origin <> 'auto' or job.pipeline_parent_job_id is not null
      or public.article_automatic_job_allowed(job.article_id, job.job_type, job.command_id))
    and coalesce(job.progress->>'articleQueueLocked', 'false') <> 'true';

  select job.id
  into v_job_id
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article_id
    and job.job_type = any(p_supported_job_types)
    and (job.status = 'queued' or (
      job.status = 'retry_scheduled' and coalesce(job.next_attempt_at, now()) <= now()
    ))
    and job.cancel_requested_at is null
    and (job.origin <> 'auto' or job.pipeline_parent_job_id is not null
      or public.article_automatic_job_allowed(job.article_id, job.job_type, job.command_id))
    and job.dead_lettered_at is null
    and job.attempt_count < job.max_attempts
    and (
      job.depends_on_job_id is null
      or exists (
        select 1
        from public.ai_external_analysis_jobs as dependency
        where dependency.id = job.depends_on_job_id
          and (
            dependency.status = 'completed'
            or (
              job.pipeline_parent_job_id = dependency.id
              and job.job_type = 'engineering_command'
              and job.input_snapshot ? 'pipelineDraft'
              and dependency.job_type = 'full_article_pipeline'
              and dependency.status = 'running'
              and dependency.cancel_requested_at is null
              and dependency.lease_expires_at > now()
              and coalesce((job.input_snapshot->>'pipelineLeaseGeneration')::bigint, -1)
                = dependency.lease_generation
            )
          )
      )
    )
  order by job.sequence_number, coalesce(job.next_attempt_at, job.created_at), job.created_at
  limit 1
  for update skip locked;

  if v_job_id is null then return; end if;

  update public.ai_external_analysis_jobs as job
  set status = 'running',
      attempt_count = job.attempt_count + 1,
      lease_generation = job.lease_generation + 1,
      next_attempt_at = null,
      locked_by = btrim(p_worker_id),
      locked_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      started_at = coalesce(job.started_at, now()),
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'running',
        'workerId', btrim(p_worker_id),
        'articleQueueLocked', true,
        'updatedAt', now()
      ),
      updated_at = now()
  where job.id = v_job_id
  returning job.* into v_job;

  if v_job.status <> 'running' or v_job.cancel_requested_at is not null then return; end if;

  insert into public.ai_external_analysis_runs(job_id, run_number, status, progress)
  values (v_job.id, v_job.attempt_count, 'running', v_job.progress)
  on conflict (job_id, run_number) do update
  set status = 'running', progress = excluded.progress, error_code = null,
      error_message = null, finished_at = null;

  return next v_job;
end;
$$;

-- All new entrypoints are service-only. The application authenticates the
-- requesting user and derives p_user_id itself; no caller-supplied user id or
-- SQL SECURITY DEFINER helper is exposed to browser credentials.
create or replace function public.creator_article_automation_schema_version()
returns integer language sql immutable security definer set search_path = public, pg_temp as $$
  select 1;
$$;

do $$
declare v_function record;
begin
  for v_function in select proc.oid::regprocedure as identity
    from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and proc.proname = any(array[
      'normalize_user_automation_preferences', 'article_automation_admin_limits',
      'creator_article_automation_schema_version',
      'user_article_automation_defaults', 'initialize_profile_automation_preferences',
      'stamp_article_creator_automation_policy', 'article_automation_policy',
      'get_user_automation_settings', 'save_user_automation_settings',
      'article_automatic_job_allowed', 'guard_creator_automatic_external_job',
      'guard_creator_automatic_writing_session', 'reconcile_creator_article_automation',
      'reconcile_legacy_content_research_automation', 'reconcile_content_research_automation',
      'reconcile_creator_automation_from_settings',
      'enqueue_external_semantic_analysis_job_controlled',
      'enqueue_competitor_discovery_job_by_signature', 'enqueue_competitor_extraction_job_controlled',
      'enqueue_automatic_competitor_extraction_for_discovery',
      'enqueue_external_engineering_jobs_sequential_base_before_google_metadata',
      'enqueue_external_engineering_jobs_sequential_base',
      'reconcile_automatic_ready_engineering_commands_for_article',
      'claim_next_content_writing_automation_item',
      'claim_next_external_analysis_job',
      'enqueue_next_automatic_writing_competitor_preparation',
      'enqueue_content_writing_competitor_preparation'
    ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function.identity);
    execute format('grant execute on function %s to service_role', v_function.identity);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;
