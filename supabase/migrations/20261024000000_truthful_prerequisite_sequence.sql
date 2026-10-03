begin;

-- A worker can claim competitor discovery and then cancel it at its first
-- policy checkpoint before contacting any provider. Such administrative
-- cancellations are not the one automatic discovery execution promised by the
-- lifetime guard. Re-open the same signature once its prerequisites become
-- valid, while retaining the guard for completed, failed, blocked, or genuinely
-- attempted discovery work.
create or replace function public.enqueue_competitor_discovery_job_controlled(
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
  v_existing_job_id uuid;
  v_job_id uuid;
  v_current_signature text;
  v_recoverable_cancel boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'external-analysis-auto-once:' || p_article_id::text || ':competitor_discovery',
    0
  ));

  perform job.id
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'competitor_discovery'
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by job.id
  for update;

  select nullif(state.competitor_discovery_signature, '')
  into v_current_signature
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

  if not v_manual then
    select job.id
    into v_existing_job_id
    from public.ai_external_analysis_jobs as job
    where job.article_id = p_article_id
      and job.job_type = 'competitor_discovery'
      and job.last_error_code is distinct from 'duplicate_task_suppressed'
      and (
        job.attempt_count > 0
        or job.started_at is not null
        or job.result is not null
      )
      and not (
        job.status = 'cancelled'
        and job.last_error_code in (
          'content_research_automation_changed',
          'creator_automation_disabled',
          'competitor_discovery_input_changed'
        )
        and job.result is null
      )
    order by job.created_at, job.id
    limit 1;

    if v_existing_job_id is not null then
      return v_existing_job_id;
    end if;

    select exists (
      select 1
      from public.ai_external_analysis_jobs as job
      where job.article_id = p_article_id
        and job.job_type = 'competitor_discovery'
        and job.readiness_signature = v_current_signature
        and job.status = 'cancelled'
        and job.last_error_code in (
          'content_research_automation_changed',
          'creator_automation_disabled',
          'competitor_discovery_input_changed'
        )
        and job.result is null
    ) into v_recoverable_cancel;
  end if;

  v_job_id := public.enqueue_competitor_discovery_job_by_signature(
    p_article_id,
    p_requested_by,
    case when v_manual then 'manual' else 'auto' end
  );

  if v_job_id is not null then
    update public.ai_external_analysis_jobs as job
    set
      max_attempts = case
        when v_manual then greatest(job.max_attempts, job.attempt_count + 1)
        when v_recoverable_cancel then job.attempt_count + 1
        else greatest(1, job.attempt_count)
      end,
      started_at = case when v_recoverable_cancel then null else job.started_at end,
      progress = case when v_recoverable_cancel
        then coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'queued',
          'automaticPrerequisiteResume', true,
          'resumedReason', 'administrative_cancellation_did_not_execute_provider',
          'updatedAt', now()
        )
        else job.progress
      end,
      updated_at = now()
    where job.id = v_job_id
      and (v_manual or job.origin = 'auto');
  end if;

  return v_job_id;
end;
$$;

-- The post-writing card must not call a stage "auditing" when no audit job
-- exists. Surface the real prerequisite, its scheduler state, and real timing
-- evidence from the active task instead.
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
  v_external_ready boolean := false;
  v_external_missing jsonb := '[]'::jsonb;
  v_discovery_ready boolean := false;
  v_required_commands text[] := array[]::text[];
  v_cleanup_current boolean := false;
  v_cleanup_active boolean := false;
  v_cleanup_failed boolean := false;
  v_audit_completed integer := 0;
  v_audit_active integer := 0;
  v_audit_failed integer := 0;
  v_required_count integer := 0;
  v_active_job_type text;
  v_active_job_status text;
  v_active_job_started_at timestamptz;
  v_active_job_next_attempt_at timestamptz;
  v_next_required_stage text;
  v_state text := 'awaiting_writing';
begin
  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id;
  if v_article.id is null then
    return jsonb_build_object('articleId', p_article_id, 'state', 'not_found', 'ready', false);
  end if;

  v_policy := public.article_automation_policy(v_article.id);
  select
    coalesce(state.external_analysis_readiness_signature, ''),
    coalesce(state.external_analysis_ready, false),
    coalesce(state.external_analysis_missing_fields, '[]'::jsonb),
    coalesce(state.competitor_discovery_ready, false)
  into v_external_signature, v_external_ready, v_external_missing, v_discovery_ready
  from public.ai_external_analysis_article_state as state
  where state.article_id = v_article.id;

  if coalesce((v_policy->>'autoRunReadyEngineeringCommands')::boolean, false) then
    select coalesce(array_agg(value), array[]::text[])
    into v_required_commands
    from jsonb_array_elements_text(
      coalesce(v_policy->'externalAnalysisCommandIds', '[]'::jsonb)
    ) as command(value);
  end if;
  v_required_count := coalesce(cardinality(v_required_commands), 0);
  v_cleanup_current := public.article_duplicate_cleanup_is_current(v_article.id);

  select
    coalesce(bool_or(job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    ) and job.input_snapshot->>'version' = '2'
      and coalesce(job.progress #> '{unified,document}', job.input_snapshot->'document')
        = v_article.content_json), false),
    coalesce(bool_or(job.status in ('failed', 'blocked')
      and job.input_snapshot->>'version' = '2'
      and coalesce(job.progress #> '{unified,document}', job.input_snapshot->'document')
        = v_article.content_json), false)
  into v_cleanup_active, v_cleanup_failed
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.job_type = 'duplicate_cleanup';

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

  select
    job.job_type,
    job.status,
    job.started_at,
    job.next_attempt_at
  into
    v_active_job_type,
    v_active_job_status,
    v_active_job_started_at,
    v_active_job_next_attempt_at
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.cancel_requested_at is null
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    )
    and job.job_type in (
      'semantic_keywords_lsi', 'competitor_discovery', 'competitor_extraction',
      'duplicate_cleanup', 'engineering_command'
    )
  order by case job.status
      when 'running' then 0
      when 'queued' then 1
      when 'retry_scheduled' then 2
      when 'waiting_for_prerequisites' then 3
      else 4
    end,
    job.updated_at desc,
    job.id
  limit 1;

  v_next_required_stage := case v_active_job_type
    when 'semantic_keywords_lsi' then 'semantic_keywords'
    when 'competitor_discovery' then 'competitor_discovery'
    when 'competitor_extraction' then 'competitor_extraction'
    when 'duplicate_cleanup' then 'duplicate_cleanup'
    when 'engineering_command' then 'external_audits'
    else null
  end;

  if v_next_required_stage is null and not v_external_ready then
    if v_external_missing ? 'competitor_content_or_url'
       and coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
       and v_discovery_ready then
      v_next_required_stage := 'competitor_discovery';
    elsif v_external_missing ? 'competitor_content_or_url'
       and coalesce((v_policy->>'autoExtractCompetitorContent')::boolean, false) then
      v_next_required_stage := 'competitor_extraction';
    elsif v_external_missing ?| array[
      'primary_keyword', 'company_name', 'goal_context', 'article_title'
    ] then
      v_next_required_stage := 'semantic_keywords';
    else
      v_next_required_stage := 'manual_prerequisites';
    end if;
  elsif v_next_required_stage is null and v_required_count > v_audit_completed then
    v_next_required_stage := 'external_audits';
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
  elsif not v_external_ready then
    v_state := 'waiting_prerequisites';
  elsif v_audit_active > 0 then
    v_state := 'auditing';
  elsif v_audit_failed > 0 then
    v_state := 'partial';
  else
    v_state := 'waiting_audits';
  end if;

  return jsonb_build_object(
    'articleId', v_article.id,
    'state', v_state,
    'ready', v_state = 'ready',
    'cleanupCurrent', v_cleanup_current,
    'cleanupActive', v_cleanup_active,
    'cleanupFailed', v_cleanup_failed,
    'externalInputsReady', v_external_ready,
    'missingPrerequisites', v_external_missing,
    'nextRequiredStage', v_next_required_stage,
    'stageScheduled', v_active_job_status is not null,
    'activeStageStatus', v_active_job_status,
    'activeStageStartedAt', v_active_job_started_at,
    'stageNextAttemptAt', v_active_job_next_attempt_at,
    'requiredAuditCount', v_required_count,
    'completedAuditCount', coalesce(v_audit_completed, 0),
    'activeAuditCount', coalesce(v_audit_active, 0),
    'failedAuditCount', coalesce(v_audit_failed, 0),
    'contentSignature', v_external_signature,
    'updatedAt', v_article.updated_at
  );
end;
$$;

-- Prefer the actual active job. Readiness can explain what is missing, but it
-- must never masquerade as a running audit stage.
create or replace function public.automatic_article_active_stage(p_article_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_work jsonb := '{}'::jsonb;
  v_external_stage text;
  v_writing_active boolean := false;
begin
  if p_article_id is null then return null; end if;

  v_work := coalesce(public.article_automation_work_readiness(p_article_id), '{}'::jsonb);

  select public.automatic_article_focus_stage_for_job_type(job.job_type)
  into v_external_stage
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.cancel_requested_at is null
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    and public.automatic_article_focus_controls_job_type(job.job_type)
  order by case job.status
      when 'running' then 0
      when 'queued' then 1
      when 'retry_scheduled' then 2
      when 'waiting_for_prerequisites' then 3
      else 4
    end,
    job.updated_at desc,
    job.id
  limit 1;

  select
    exists (
      select 1 from public.content_writing_sessions as session
      where session.article_id = p_article_id
        and session.execution_mode = 'api'
        and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
        and session.cancel_requested_at is null
        and session.status in ('queued', 'running', 'retry_scheduled')
    ) or exists (
      select 1 from public.content_writing_automation_items as item
      where item.article_id = p_article_id
        and item.status in ('ready', 'claiming', 'writing')
    )
  into v_writing_active;

  if v_writing_active then return 'content_writing'; end if;
  if v_work->>'state' in ('waiting_cleanup', 'cleaning') then return 'duplicate_cleanup'; end if;
  if v_external_stage is not null then return v_external_stage; end if;
  if v_work->>'state' in ('auditing', 'partial', 'waiting_audits') then return 'external_audits'; end if;
  if v_work->>'state' = 'ready' then return 'ready'; end if;
  return coalesce(nullif(v_work->>'nextRequiredStage', ''), 'preparation');
end;
$$;

-- Extend the existing focus payload without duplicating queue logic.
do $focus_payload$
declare
  v_definition text;
  v_anchor constant text := $$    'workState', nullif(v_work->>'state', ''),$$;
  v_replacement constant text := $$    'workState', nullif(v_work->>'state', ''),
    'externalInputsReady', coalesce((v_work->>'externalInputsReady')::boolean, false),
    'missingPrerequisites', coalesce(v_work->'missingPrerequisites', '[]'::jsonb),
    'nextRequiredStage', nullif(v_work->>'nextRequiredStage', ''),
    'stageScheduled', coalesce((v_work->>'stageScheduled')::boolean, false),
    'activeStageStatus', nullif(v_work->>'activeStageStatus', ''),
    'activeStageStartedAt', nullif(v_work->>'activeStageStartedAt', '')::timestamptz,
    'stageNextAttemptAt', nullif(v_work->>'stageNextAttemptAt', '')::timestamptz,$$;
begin
  select pg_get_functiondef('public.get_automatic_article_focus()'::regprocedure)
  into v_definition;
  if strpos(v_definition, '''missingPrerequisites''') = 0 then
    if strpos(v_definition, v_anchor) = 0 then
      raise exception 'The automatic focus payload changed; refusing an unsafe patch.';
    end if;
    execute replace(v_definition, v_anchor, v_replacement);
  end if;
end;
$focus_payload$;

-- A focused article with no real task must not occupy the single lane for
-- hours. Release it immediately with a precise reason; the inventory already
-- exposes the missing prerequisite fields for manual correction.
do $focus_release$
declare
  v_definition text;
  v_anchor constant text := $$  elsif (v_terminal_event or v_item_terminal) and not v_any_active then
    v_release_reason := 'terminal_stage_failure';$$;
  v_replacement constant text := $$  elsif (v_terminal_event or v_item_terminal) and not v_any_active then
    v_release_reason := 'terminal_stage_failure';
  elsif v_work->>'state' in ('waiting_prerequisites', 'waiting_audits')
     and not v_any_active then
    v_release_reason := 'post_write_prerequisite_unscheduled';$$;
  v_message_anchor constant text :=
    $$coalesce(p_error_message, 'Automatic article processing requires manual review.')$$;
  v_message_replacement constant text := $$coalesce(
        p_error_message,
        case when v_release_reason = 'post_write_prerequisite_unscheduled'
          then 'No automatic prerequisite task could be scheduled. Review the missing requirements in the automation queue.'
          else 'Automatic article processing requires manual review.'
        end
      )$$;
  v_update_anchor constant text := $$last_error = coalesce(p_error_message, last_error),$$;
  v_update_replacement constant text := $$last_error = coalesce(
          p_error_message,
          case when v_release_reason = 'post_write_prerequisite_unscheduled'
            then 'No automatic prerequisite task could be scheduled. Review the missing requirements in the automation queue.'
            else last_error
          end
        ),$$;
begin
  select pg_get_functiondef(
    'public.refresh_automatic_article_focus(uuid,text,text,text,text,timestamptz)'::regprocedure
  ) into v_definition;

  if strpos(v_definition, 'post_write_prerequisite_unscheduled') = 0 then
    if strpos(v_definition, v_anchor) = 0
       or strpos(v_definition, v_message_anchor) = 0
       or strpos(v_definition, v_update_anchor) = 0 then
      raise exception 'The automatic focus refresh function changed; refusing an unsafe patch.';
    end if;
    v_definition := replace(v_definition, v_anchor, v_replacement);
    v_definition := replace(v_definition, v_message_anchor, v_message_replacement);
    v_definition := replace(v_definition, v_update_anchor, v_update_replacement);
    execute v_definition;
  end if;
end;
$focus_release$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 19;
$$;

-- Reconcile every article through the existing single coordinator. This
-- repairs administrative cancellations without adding another scheduler,
-- timer, or worker engine.
select public.reconcile_content_research_automation();
select public.reconcile_automatic_competitor_extraction();
select public.reconcile_automatic_article_focus();

revoke all on function public.enqueue_competitor_discovery_job_controlled(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.enqueue_competitor_discovery_job_controlled(uuid,uuid,text)
  to service_role;
revoke all on function public.article_automation_work_readiness(uuid)
  from public, anon, authenticated;
grant execute on function public.article_automation_work_readiness(uuid)
  to service_role;
revoke all on function public.automatic_article_active_stage(uuid)
  from public, anon, authenticated;
grant execute on function public.automatic_article_active_stage(uuid)
  to service_role;

comment on function public.enqueue_competitor_discovery_job_controlled(uuid,uuid,text) is
  'Runs automatic competitor discovery once after real execution; administrative pre-provider cancellation remains recoverable.';
comment on function public.article_automation_work_readiness(uuid) is
  'Returns truthful post-writing readiness, missing external prerequisites, scheduling state, and active-stage timing.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 19 with recoverable competitor sequencing and truthful prerequisite focus state.';

notify pgrst, 'reload schema';

commit;
