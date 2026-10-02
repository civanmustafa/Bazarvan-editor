begin;

-- The focus card must describe work that is active now. Historical blocked or
-- completed jobs remain useful audit records, but must never choose the stage
-- shown to operators.
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
  if p_article_id is null then
    return null;
  end if;

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
      select 1
      from public.content_writing_sessions as session
      where session.article_id = p_article_id
        and session.execution_mode = 'api'
        and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
        and session.cancel_requested_at is null
        and session.status in ('queued', 'running', 'retry_scheduled')
    )
    or exists (
      select 1
      from public.content_writing_automation_items as item
      where item.article_id = p_article_id
        and item.status in ('ready', 'claiming', 'writing')
    )
  into v_writing_active;

  if v_writing_active then
    return 'content_writing';
  end if;
  if v_work->>'state' in ('waiting_cleanup', 'cleaning') then
    return 'duplicate_cleanup';
  end if;
  if v_work->>'state' in ('auditing', 'partial') then
    return 'external_audits';
  end if;
  if v_external_stage is not null then
    return v_external_stage;
  end if;
  if v_work->>'state' = 'ready' then
    return 'ready';
  end if;
  return 'preparation';
end;
$$;

-- Content already present in the editor makes old preparation jobs obsolete.
-- Cancel them without deleting their history. Running workers only receive a
-- cancellation request and stop safely at their next checkpoint.
create or replace function public.cancel_obsolete_content_writing_preparations(
  p_article_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requirement jsonb := '{}'::jsonb;
  v_affected integer := 0;
begin
  if p_article_id is null then
    return 0;
  end if;

  v_requirement := coalesce(public.automatic_content_writing_requirement(p_article_id), '{}'::jsonb);
  if coalesce((v_requirement->>'required')::boolean, false) then
    return 0;
  end if;

  update public.ai_external_analysis_jobs as job
  set status = case when job.status = 'running' then job.status else 'cancelled' end,
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      last_error_code = 'automatic_writing_not_required',
      last_error = 'The article editor already contains content; content-writing preparation is obsolete.',
      completed_at = case when job.status = 'running' then job.completed_at
        else coalesce(job.completed_at, now()) end,
      locked_by = case when job.status = 'running' then job.locked_by else null end,
      locked_at = case when job.status = 'running' then job.locked_at else null end,
      lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
      updated_at = now()
  where job.article_id = p_article_id
    and job.job_type = 'content_writing_preparation'
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused', 'blocked'
    );

  get diagnostics v_affected = row_count;
  return v_affected;
end;
$$;

create or replace function public.finalize_obsolete_content_writing_preparations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.cancel_obsolete_content_writing_preparations(new.id);
  return new;
end;
$$;

drop trigger if exists finalize_obsolete_content_writing_preparations on public.articles;
create trigger finalize_obsolete_content_writing_preparations
after update of status, content_json, content_html, plain_text on public.articles
for each row
when (
  old.status is distinct from new.status
  or old.content_json is distinct from new.content_json
  or old.content_html is distinct from new.content_html
  or old.plain_text is distinct from new.plain_text
)
execute function public.finalize_obsolete_content_writing_preparations();

create or replace function public.get_automatic_article_focus()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_focus public.automatic_article_focus%rowtype;
  v_title text := '';
  v_last_title text := '';
  v_display_stage text;
  v_work jsonb := '{}'::jsonb;
  v_attempt_count integer := 0;
  v_max_attempts integer := 0;
  v_attempt_metric text := 'worker_execution';
  v_recovery_count integer := 0;
  v_max_recoveries integer := 3;
  v_quality_score numeric;
  v_quality_minimum_score numeric;
  v_quality_passed boolean;
  v_quality_overridden boolean := false;
begin
  select focus.* into v_focus
  from public.automatic_article_focus as focus
  where focus.singleton is true;

  if v_focus.article_id is not null then
    select coalesce(article.title, '') into v_title
    from public.articles as article where article.id = v_focus.article_id;

    v_display_stage := public.automatic_article_active_stage(v_focus.article_id);
    v_work := coalesce(public.article_automation_work_readiness(v_focus.article_id), '{}'::jsonb);

    select
      case when public.external_analysis_uses_gemini_budget(job.job_type)
        then job.provider_attempt_count else job.attempt_count end,
      case when public.external_analysis_uses_gemini_budget(job.job_type)
        then job.provider_attempt_limit else job.max_attempts end,
      case when public.external_analysis_uses_gemini_budget(job.job_type)
        then 'gemini_execution' else 'worker_execution' end,
      job.recovery_cycle_count,
      job.recovery_cycle_limit
    into v_attempt_count, v_max_attempts, v_attempt_metric,
      v_recovery_count, v_max_recoveries
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_focus.article_id
      and job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and job.cancel_requested_at is null
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      and public.automatic_article_focus_controls_job_type(job.job_type)
    order by
      (public.automatic_article_focus_stage_for_job_type(job.job_type) = v_display_stage) desc,
      case job.status when 'running' then 0 when 'queued' then 1
        when 'retry_scheduled' then 2 when 'waiting_for_prerequisites' then 3 else 4 end,
      job.updated_at desc,
      job.id
    limit 1;

    if not found then
      select item.attempt_count, item.max_attempts, 'writing_execution',
        item.recovery_count, 3
      into v_attempt_count, v_max_attempts, v_attempt_metric,
        v_recovery_count, v_max_recoveries
      from public.content_writing_automation_items as item
      where item.article_id = v_focus.article_id
        and item.status in ('ready', 'claiming', 'writing')
      order by item.updated_at desc, item.id
      limit 1;
    end if;

    select
      session.quality_score,
      case when jsonb_typeof(session.quality_report->'minimumScore') = 'number'
        then (session.quality_report->>'minimumScore')::numeric else null end,
      case when lower(coalesce(session.quality_report->>'passed', '')) in ('true', 'false')
        then (session.quality_report->>'passed')::boolean else null end,
      session.quality_override_at is not null
    into v_quality_score, v_quality_minimum_score, v_quality_passed, v_quality_overridden
    from public.content_writing_sessions as session
    where session.article_id = v_focus.article_id
      and session.applied_at is not null
    order by session.applied_at desc, session.updated_at desc, session.id
    limit 1;
  else
    v_display_stage := v_focus.current_stage;
  end if;

  if v_focus.last_article_id is not null then
    select coalesce(article.title, '') into v_last_title
    from public.articles as article where article.id = v_focus.last_article_id;
  end if;

  return jsonb_build_object(
    'articleId', v_focus.article_id,
    'articleTitle', v_title,
    'state', v_focus.state,
    'currentStage', v_display_stage,
    'workState', nullif(v_work->>'state', ''),
    'cleanupActive', coalesce((v_work->>'cleanupActive')::boolean, false),
    'cleanupFailed', coalesce((v_work->>'cleanupFailed')::boolean, false),
    'requiredAuditCount', coalesce((v_work->>'requiredAuditCount')::integer, 0),
    'completedAuditCount', coalesce((v_work->>'completedAuditCount')::integer, 0),
    'activeAuditCount', coalesce((v_work->>'activeAuditCount')::integer, 0),
    'failedAuditCount', coalesce((v_work->>'failedAuditCount')::integer, 0),
    'qualityScore', v_quality_score,
    'qualityMinimumScore', v_quality_minimum_score,
    'qualityPassed', v_quality_passed,
    'qualityOverridden', coalesce(v_quality_overridden, false),
    'acquiredAt', v_focus.acquired_at,
    'lastProgressAt', v_focus.last_progress_at,
    'nextRetryAt', v_focus.next_retry_at,
    'attemptCount', coalesce(v_attempt_count, 0),
    'maxAttempts', coalesce(v_max_attempts, 0),
    'attemptMetric', v_attempt_metric,
    'recoveryCount', coalesce(v_recovery_count, 0),
    'maxRecoveries', coalesce(v_max_recoveries, 3),
    'lastErrorCode', v_focus.last_error_code,
    'lastError', v_focus.last_error,
    'generation', v_focus.generation,
    'lastArticleId', v_focus.last_article_id,
    'lastArticleTitle', v_last_title,
    'lastReleaseReason', v_focus.last_release_reason,
    'releasedAt', v_focus.released_at,
    'canResume', v_focus.article_id is null and v_focus.last_article_id is not null
      and exists (
        select 1 from public.automatic_article_focus_pauses as pause
        where pause.article_id = v_focus.last_article_id
      )
  );
end;
$$;

-- Repair rows created before this invariant existed, then refresh the one
-- shared lane so its persisted state also catches up immediately.
do $$
declare
  v_article record;
  v_focused_article_id uuid;
begin
  for v_article in
    select distinct job.article_id
    from public.ai_external_analysis_jobs as job
    where job.job_type = 'content_writing_preparation'
      and job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused', 'blocked'
      )
  loop
    perform public.cancel_obsolete_content_writing_preparations(v_article.article_id);
  end loop;

  select focus.article_id into v_focused_article_id
  from public.automatic_article_focus as focus
  where focus.singleton is true;
  if v_focused_article_id is not null then
    perform public.refresh_automatic_article_focus(v_focused_article_id);
  end if;
end;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 18;
$$;

revoke all on function public.automatic_article_active_stage(uuid)
  from public, anon, authenticated;
revoke all on function public.cancel_obsolete_content_writing_preparations(uuid)
  from public, anon, authenticated;
revoke all on function public.finalize_obsolete_content_writing_preparations()
  from public, anon, authenticated;
grant execute on function public.automatic_article_active_stage(uuid) to service_role;
grant execute on function public.cancel_obsolete_content_writing_preparations(uuid) to service_role;

comment on function public.automatic_article_active_stage(uuid) is
  'Returns the live automatic stage only; historical terminal jobs never choose the focus-card stage.';
comment on function public.cancel_obsolete_content_writing_preparations(uuid) is
  'Cancels stale automatic preparation jobs after the article no longer requires automatic writing.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 18 with truthful post-write focus and obsolete preparation cleanup.';

notify pgrst, 'reload schema';

commit;
