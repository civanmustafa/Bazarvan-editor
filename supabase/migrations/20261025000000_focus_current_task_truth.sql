begin;

-- Preserve the v19 focus payload, then enrich it with the exact state of the
-- task that is active now. This prevents a historical focus error (for example
-- a manual stop) from contradicting a newly queued or retry-scheduled task.
alter function public.get_automatic_article_focus()
  rename to get_automatic_article_focus_v19;

revoke all on function public.get_automatic_article_focus_v19()
  from public, anon, authenticated;
grant execute on function public.get_automatic_article_focus_v19()
  to service_role;

create or replace function public.get_automatic_article_focus()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb := coalesce(public.get_automatic_article_focus_v19(), '{}'::jsonb);
  v_article_id uuid;
  v_signature text := '';
  v_job_status text;
  v_job_error_code text;
  v_job_error text;
  v_running_audits integer := 0;
  v_scheduled_audits integer := 0;
  v_retry_audits integer := 0;
begin
  begin
    v_article_id := nullif(v_payload->>'articleId', '')::uuid;
  exception when invalid_text_representation then
    v_article_id := null;
  end;

  if v_article_id is null then
    return v_payload || jsonb_build_object(
      'runningAuditCount', 0,
      'scheduledAuditCount', 0,
      'retryScheduledAuditCount', 0
    );
  end if;

  select coalesce(state.external_analysis_readiness_signature, '')
  into v_signature
  from public.ai_external_analysis_article_state as state
  where state.article_id = v_article_id;

  select
    count(*) filter (where job.status = 'running')::integer,
    count(*) filter (where job.status in (
      'waiting_for_prerequisites', 'queued', 'paused'
    ))::integer,
    count(*) filter (where job.status = 'retry_scheduled')::integer
  into v_running_audits, v_scheduled_audits, v_retry_audits
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article_id
    and job.job_type = 'engineering_command'
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.cancel_requested_at is null
    and job.readiness_signature = v_signature;

  select job.status, job.last_error_code, job.last_error
  into v_job_status, v_job_error_code, v_job_error
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article_id
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.cancel_requested_at is null
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    )
    and public.automatic_article_focus_controls_job_type(job.job_type)
  order by
    (public.automatic_article_focus_stage_for_job_type(job.job_type)
      = v_payload->>'currentStage') desc,
    case job.status
      when 'running' then 0
      when 'queued' then 1
      when 'retry_scheduled' then 2
      when 'waiting_for_prerequisites' then 3
      else 4
    end,
    job.updated_at desc,
    job.id
  limit 1;

  v_payload := v_payload || jsonb_build_object(
    'runningAuditCount', coalesce(v_running_audits, 0),
    'scheduledAuditCount', coalesce(v_scheduled_audits, 0),
    'retryScheduledAuditCount', coalesce(v_retry_audits, 0)
  );

  -- Historical focus errors must never leak into the current card. When there
  -- is no active task there is no current task error to display.
  v_payload := v_payload || jsonb_build_object(
    'lastErrorCode', v_job_error_code,
    'lastError', v_job_error
  );

  return v_payload;
end;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 20;
$$;

revoke all on function public.get_automatic_article_focus()
  from public, anon, authenticated;
grant execute on function public.get_automatic_article_focus()
  to service_role;

comment on function public.get_automatic_article_focus() is
  'Returns the v19 focus plus current task errors and separate running, queued, and retry-scheduled audit counts.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 20 with current-task focus truth and exact audit scheduling counts.';

notify pgrst, 'reload schema';

commit;
