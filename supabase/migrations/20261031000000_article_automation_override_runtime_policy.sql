begin;

-- Apply article exceptions atomically while making the effect on already
-- scheduled work explicit. The original saver remains the single policy
-- reconciler; this wrapper adds the operator choice for in-flight work and a
-- machine-readable impact summary for the UI.
create or replace function public.save_article_automation_overrides_v2(
  p_article_id uuid,
  p_updated_by uuid,
  p_disabled_capabilities text[] default array[]::text[],
  p_writing_mode text default 'strict',
  p_excluded_external_command_ids text[] default array[]::text[],
  p_reason text default null,
  p_running_behavior text default 'stop'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_saved jsonb;
  v_policy jsonb;
  v_running_jobs jsonb := '[]'::jsonb;
  v_active_jobs uuid[] := array[]::uuid[];
  v_running_sessions jsonb := '[]'::jsonb;
  v_active_sessions uuid[] := array[]::uuid[];
  v_writing_item jsonb := null;
  v_queued_cancelled integer := 0;
  v_running_stop_requested integer := 0;
  v_running_finish_current integer := 0;
  v_bundled_restart_requested integer := 0;
begin
  if p_running_behavior not in ('stop', 'finish_current') then
    raise exception 'Invalid running task behavior.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', job.id,
    'status', job.status,
    'inputSnapshot', coalesce(job.input_snapshot, '{}'::jsonb)
  )), '[]'::jsonb), coalesce(array_agg(job.id), array[]::uuid[])
  into v_running_jobs, v_active_jobs
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused', 'blocked');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', session.id,
    'status', session.status,
    'contextSnapshot', coalesce(session.context_snapshot, '{}'::jsonb)
  )), '[]'::jsonb), coalesce(array_agg(session.id), array[]::uuid[])
  into v_running_sessions, v_active_sessions
  from public.content_writing_sessions as session
  where session.article_id = p_article_id
    and session.execution_mode = 'api'
    and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
    and session.status in ('queued', 'running', 'retry_scheduled');

  select to_jsonb(item) into v_writing_item
  from public.content_writing_automation_items as item
  where item.article_id = p_article_id
    and item.status in ('ready', 'claiming', 'writing', 'blocked')
  limit 1;

  v_saved := public.save_article_automation_overrides(
    p_article_id,
    p_updated_by,
    p_disabled_capabilities,
    p_writing_mode,
    p_excluded_external_command_ids,
    p_reason
  );
  v_policy := public.article_automation_policy(p_article_id);

  update public.ai_external_analysis_jobs as job
  set last_error = 'أُوقفت المهمة تلقائيًا لأن مرحلتها أصبحت مستثناة من أتمتة المقالة. هذه ليست محاولة فاشلة.',
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'message', 'أُوقفت بسبب استثناء أتمتة المقالة، ولا تُحتسب كفشل.', 'updatedAt', now()
    ), updated_at = now()
  where job.id = any(v_active_jobs)
    and job.last_error_code = 'article_automation_stage_excluded';

  update public.content_writing_sessions as session
  set last_error = 'أُوقفت الكتابة التلقائية لأن هذه المرحلة أصبحت مستثناة للمقالة. هذه ليست محاولة فاشلة.',
    progress = coalesce(session.progress, '{}'::jsonb) || jsonb_build_object(
      'message', 'أُوقفت بسبب استثناء أتمتة المقالة، ولا تُحتسب كفشل.', 'updatedAt', now()
    ), updated_at = now()
  where session.id = any(v_active_sessions)
    and session.last_error_code = 'article_automation_stage_excluded';

  -- The bundled semantic task remains allowed when at least one target is
  -- enabled. If its target set changed while it was running, stop it and reuse
  -- the same durable row with the reduced target set.
  if p_running_behavior = 'stop' then
    with previous as (
      select
        (entry->>'id')::uuid as id,
        coalesce(entry->'inputSnapshot', '{}'::jsonb) as input_snapshot
      from jsonb_array_elements(v_running_jobs) as source(entry)
      where entry->>'status' = 'running'
    )
    update public.ai_external_analysis_jobs as job
    set
      input_snapshot = coalesce(job.input_snapshot, '{}'::jsonb) || jsonb_build_object(
        'needsSecondaries', coalesce((previous.input_snapshot->>'needsSecondaries')::boolean, true)
          and coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false),
        'needsLsi', coalesce((previous.input_snapshot->>'needsLsi')::boolean, true)
          and coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false),
        'needsGoogleMetadata', coalesce((previous.input_snapshot->>'needsGoogleMetadata')::boolean, true)
          and coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false),
        'automationSettings', v_policy
      ),
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      last_error_code = 'article_automation_policy_refresh',
      last_error = 'جارٍ إيقاف المهمة المجمعة وإعادة السجل نفسه بالأجزاء التي ما زالت مسموحة. لا تُعد هذه الحالة فشلًا.',
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'cancellation_requested',
        'reason', 'article_automation_policy_refresh',
        'restartAfterCancellation', true,
        'updatedAt', now()
      ),
      updated_at = now()
    from previous
    where job.id = previous.id
      and job.job_type = 'semantic_keywords_lsi'
      and job.status = 'running'
      and public.article_automatic_policy_allows(job.article_id, job.job_type, job.command_id)
      and (
        (coalesce((previous.input_snapshot->>'needsSecondaries')::boolean, true)
          and not coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false))
        or (coalesce((previous.input_snapshot->>'needsLsi')::boolean, true)
          and not coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false))
        or (coalesce((previous.input_snapshot->>'needsGoogleMetadata')::boolean, true)
          and not coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false))
      );
  else
    -- The base saver may have requested cancellation. Restore only tasks that
    -- were running before this transaction and are affected by the new policy.
    with previous as (
      select
        (entry->>'id')::uuid as id,
        coalesce(entry->'inputSnapshot', '{}'::jsonb) as input_snapshot
      from jsonb_array_elements(v_running_jobs) as source(entry)
      where entry->>'status' = 'running'
    )
    update public.ai_external_analysis_jobs as job
    set
      input_snapshot = previous.input_snapshot || jsonb_build_object(
        'automationOverrideDisposition', 'finish_current',
        'automationOverrideRevision', coalesce((v_saved->>'revision')::bigint, 0)
      ),
      cancel_requested_at = null,
      last_error_code = null,
      last_error = null,
      progress = (coalesce(job.progress, '{}'::jsonb) - 'restartAfterCancellation') || jsonb_build_object(
        'stage', 'running',
        'automationOverrideDisposition', 'finish_current',
        'message', 'ستكتمل هذه المهمة الجارية فقط؛ يسري الاستثناء على ما بعدها.',
        'updatedAt', now()
      ),
      updated_at = now()
    from previous
    where job.id = previous.id
      and job.status = 'running'
      and (
        not public.article_automatic_policy_allows(job.article_id, job.job_type, job.command_id)
        or (job.job_type = 'semantic_keywords_lsi' and (
          (coalesce((previous.input_snapshot->>'needsSecondaries')::boolean, true)
            and not coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false))
          or (coalesce((previous.input_snapshot->>'needsLsi')::boolean, true)
            and not coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false))
          or (coalesce((previous.input_snapshot->>'needsGoogleMetadata')::boolean, true)
            and not coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false))
        ))
      );

    with previous as (
      select
        (entry->>'id')::uuid as id,
        coalesce(entry->'contextSnapshot', '{}'::jsonb) as context_snapshot
      from jsonb_array_elements(v_running_sessions) as source(entry)
      where entry->>'status' = 'running'
    )
    update public.content_writing_sessions as session
    set
      context_snapshot = previous.context_snapshot || jsonb_build_object(
        'automationOverrideDisposition', 'finish_current',
        'automationOverrideRevision', coalesce((v_saved->>'revision')::bigint, 0)
      ),
      cancel_requested_at = null,
      last_error_code = null,
      last_error = null,
      progress = coalesce(session.progress, '{}'::jsonb) || jsonb_build_object(
        'automationOverrideDisposition', 'finish_current',
        'message', 'ستكتمل جلسة الكتابة الجارية فقط؛ يسري الاستثناء على ما بعدها.',
        'updatedAt', now()
      ),
      completed_at = null,
      updated_at = now()
    from previous
    where session.id = previous.id
      and session.status = 'running'
      and not coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false);

    if v_writing_item is not null
       and v_writing_item->>'status' = 'writing'
       and not coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false) then
      update public.content_writing_automation_items as item
      set status = 'writing', completed_at = null,
        locked_by = nullif(v_writing_item->>'locked_by', ''),
        locked_at = nullif(v_writing_item->>'locked_at', '')::timestamptz,
        lease_expires_at = nullif(v_writing_item->>'lease_expires_at', '')::timestamptz,
        last_error_code = null, last_error = null, updated_at = now()
      where item.article_id = p_article_id;
    end if;
  end if;

  select count(*) into v_queued_cancelled
  from (
    select job.id
    from public.ai_external_analysis_jobs as job
    where job.id = any(v_active_jobs)
      and job.status = 'cancelled'
      and job.last_error_code = 'article_automation_stage_excluded'
    union all
    select session.id
    from public.content_writing_sessions as session
    where session.id = any(v_active_sessions)
      and session.status = 'cancelled'
      and session.last_error_code = 'article_automation_stage_excluded'
  ) as cancelled;

  if v_writing_item is not null
     and v_writing_item->>'status' <> 'writing'
     and exists (
       select 1 from public.content_writing_automation_items as item
       where item.article_id = p_article_id
         and item.status = 'cancelled'
         and item.last_error_code = 'article_automation_stage_excluded'
     ) then
    v_queued_cancelled := v_queued_cancelled + 1;
  end if;

  select count(*) filter (where job.cancel_requested_at is not null),
    count(*) filter (where job.input_snapshot->>'automationOverrideDisposition' = 'finish_current'),
    count(*) filter (where job.last_error_code = 'article_automation_policy_refresh')
  into v_running_stop_requested, v_running_finish_current, v_bundled_restart_requested
  from public.ai_external_analysis_jobs as job
  where job.id = any(v_active_jobs) and job.status = 'running';

  select v_running_stop_requested + count(*) filter (where session.cancel_requested_at is not null),
    v_running_finish_current + count(*) filter (
      where session.context_snapshot->>'automationOverrideDisposition' = 'finish_current'
    )
  into v_running_stop_requested, v_running_finish_current
  from public.content_writing_sessions as session
  where session.id = any(v_active_sessions) and session.status = 'running';

  insert into public.worker_queue_signals(queue_name)
  values ('external_analysis'), ('content_writing')
  on conflict do nothing;
  perform public.reconcile_automatic_article_focus();

  return jsonb_build_object(
    'overrides', v_saved,
    'impact', jsonb_build_object(
      'queuedCancelled', v_queued_cancelled,
      'runningCancellationRequested', v_running_stop_requested,
      'runningAllowedToFinish', v_running_finish_current,
      'bundledRestartRequested', v_bundled_restart_requested
    )
  );
end;
$$;

-- A target change in a running bundled semantic task is a policy refresh, not
-- a failed attempt. Reuse its row after the worker confirms cancellation.
create or replace function public.restart_external_analysis_job_after_policy_change(
  p_job_id uuid,
  p_worker_id text
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_job public.ai_external_analysis_jobs%rowtype;
begin
  update public.ai_external_analysis_jobs as job
  set status = 'queued', cancel_requested_at = null,
    locked_by = null, locked_at = null, lease_expires_at = null,
    next_attempt_at = now(), completed_at = null,
    attempt_count = greatest(0, job.attempt_count - 1),
    last_error_code = null, last_error = null,
    progress = (coalesce(job.progress, '{}'::jsonb) - 'restartAfterCancellation') || jsonb_build_object(
      'stage', 'queued',
      'reason', 'article_automation_policy_refreshed',
      'message', 'أُعيدت المهمة نفسها إلى الطابور بالأجزاء المسموحة فقط.',
      'updatedAt', now()
    ),
    updated_at = now()
  where job.id = p_job_id
    and job.job_type = 'semantic_keywords_lsi'
    and job.last_error_code = 'article_automation_policy_refresh'
    and coalesce((job.progress->>'restartAfterCancellation')::boolean, false)
    and public.article_automatic_policy_allows(job.article_id, job.job_type, job.command_id)
    and (
      (job.status = 'running' and job.locked_by = btrim(coalesce(p_worker_id, '')))
      or job.status = 'cancelled'
    )
  returning job.* into v_job;

  if v_job.id is null then
    raise exception 'policy-refresh job was not available for restart' using errcode = 'P0002';
  end if;

  update public.ai_external_analysis_runs as run
  set status = 'cancelled', error_code = 'article_automation_policy_refresh',
    error_message = 'أُوقفت هذه الدورة لتحديث أهداف المهمة المجمعة، وليست محاولة فاشلة.',
    progress = coalesce(run.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'cancelled', 'reason', 'article_automation_policy_refresh', 'updatedAt', now()
    ),
    finished_at = now()
  where run.job_id = p_job_id and run.status = 'running';

  insert into public.worker_queue_signals(queue_name)
  values ('external_analysis') on conflict do nothing;
  return v_job;
end;
$$;

revoke all on function public.save_article_automation_overrides_v2(uuid,uuid,text[],text,text[],text,text)
  from public, anon, authenticated;
grant execute on function public.save_article_automation_overrides_v2(uuid,uuid,text[],text,text[],text,text)
  to service_role;
revoke all on function public.restart_external_analysis_job_after_policy_change(uuid,text)
  from public, anon, authenticated;
grant execute on function public.restart_external_analysis_job_after_policy_change(uuid,text)
  to service_role;

comment on function public.save_article_automation_overrides_v2(uuid,uuid,text[],text,text[],text,text) is
  'Saves article exceptions, atomically updates queued/running work, and returns a truthful impact summary.';
comment on function public.restart_external_analysis_job_after_policy_change(uuid,text) is
  'Reuses a cancelled bundled semantic row after its allowed targets change; the interrupted cycle is not a failed attempt.';

notify pgrst, 'reload schema';

commit;
