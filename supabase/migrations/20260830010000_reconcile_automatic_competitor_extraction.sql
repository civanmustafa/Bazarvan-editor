begin;

-- Manual searches are intentionally available before the stricter automatic
-- discovery prerequisites are complete. Persist those searches with a stable
-- manual signature so the same completed-discovery trigger can accept the
-- deterministic selection and enqueue extraction. This keeps manual and
-- background discovery on one selection/extraction coordinator.
create or replace function public.save_competitor_discovery_result(
  p_article_id uuid,
  p_requested_by uuid,
  p_input_snapshot jsonb,
  p_result jsonb
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.ai_external_analysis_article_state%rowtype;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_readiness_signature text;
  v_idempotency_key text;
begin
  perform 1
  from public.articles as article
  where article.id = p_article_id;
  if not found then
    raise exception 'Article was not found.' using errcode = 'P0002';
  end if;

  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

  v_readiness_signature := case
    when v_state.article_id is not null
      and v_state.competitor_discovery_ready
      and nullif(v_state.competitor_discovery_signature, '') is not null
      then v_state.competitor_discovery_signature
    else 'manual:' || md5(
      p_article_id::text || ':' || coalesce(p_input_snapshot, '{}'::jsonb)::text
    )
  end;
  v_idempotency_key := 'competitor-discovery:' || v_readiness_signature;

  perform pg_advisory_xact_lock(hashtextextended(
    p_article_id::text || ':' || v_idempotency_key,
    0
  ));

  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'competitor_discovery'
    and job.readiness_signature = v_readiness_signature
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by job.created_at
  limit 1
  for update;

  if v_job.id is not null and v_job.status = 'running' then
    return v_job;
  end if;

  if v_job.id is null then
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
      result,
      progress,
      completed_at
    ) values (
      p_article_id,
      p_requested_by,
      'competitor_discovery',
      'manual',
      'completed',
      v_idempotency_key,
      v_idempotency_key,
      0,
      v_readiness_signature,
      coalesce(p_input_snapshot, '{}'::jsonb),
      coalesce(p_result, '{}'::jsonb) || jsonb_build_object('reviewStatus', 'awaiting_review'),
      jsonb_build_object('stage', 'awaiting_review', 'updatedAt', now()),
      now()
    )
    returning * into v_job;
  else
    update public.ai_external_analysis_jobs as job
    set
      requested_by = coalesce(p_requested_by, job.requested_by),
      origin = 'manual',
      status = 'completed',
      readiness_signature = v_readiness_signature,
      input_snapshot = coalesce(p_input_snapshot, '{}'::jsonb),
      result = coalesce(p_result, '{}'::jsonb) || jsonb_build_object('reviewStatus', 'awaiting_review'),
      progress = jsonb_build_object('stage', 'awaiting_review', 'updatedAt', now()),
      last_error = null,
      last_error_code = null,
      next_attempt_at = null,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      cancel_requested_at = null,
      completed_at = now(),
      updated_at = now()
    where job.id = v_job.id
    returning job.* into v_job;
  end if;

  if v_state.article_id is not null
     and v_state.competitor_discovery_ready
     and v_state.competitor_discovery_signature = v_readiness_signature then
    update public.ai_external_analysis_article_state as state
    set
      competitor_discovery_last_enqueued_signature = v_readiness_signature,
      updated_at = now()
    where state.article_id = p_article_id;
  end if;

  return v_job;
end;
$$;

-- Deployment reconciliation closes the historical gap where completed
-- discoveries existed before the automatic-extraction completion trigger was
-- installed. The per-discovery coordinator is idempotent, so re-running this
-- function reuses the matching extraction task instead of duplicating work.
create or replace function public.reconcile_automatic_competitor_extraction()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_discovery_job_id uuid;
  v_extraction_job_id uuid;
  v_reconciled_count integer := 0;
begin
  if not public.competitor_content_auto_extraction_enabled() then
    return 0;
  end if;

  for v_discovery_job_id in
    select latest.id
    from (
      select distinct on (job.article_id)
        job.article_id,
        job.id,
        job.completed_at,
        job.created_at
      from public.ai_external_analysis_jobs as job
      where job.job_type = 'competitor_discovery'
        and job.status = 'completed'
        and job.pipeline_parent_job_id is null
      order by
        job.article_id,
        job.completed_at desc nulls last,
        job.created_at desc
    ) as latest
    order by latest.article_id
  loop
    v_extraction_job_id := public.enqueue_automatic_competitor_extraction_for_discovery(
      v_discovery_job_id
    );
    if v_extraction_job_id is not null then
      v_reconciled_count := v_reconciled_count + 1;
    end if;
  end loop;

  return v_reconciled_count;
end;
$$;

revoke all on function public.save_competitor_discovery_result(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.reconcile_automatic_competitor_extraction()
  from public, anon, authenticated;
grant execute on function public.save_competitor_discovery_result(uuid, uuid, jsonb, jsonb)
  to service_role;
grant execute on function public.reconcile_automatic_competitor_extraction()
  to service_role;

comment on function public.save_competitor_discovery_result(uuid, uuid, jsonb, jsonb) is
  'Persists manual discovery with either the article readiness signature or a stable manual signature so automatic extraction can use the canonical completion trigger.';
comment on function public.reconcile_automatic_competitor_extraction() is
  'Idempotently queues or reuses extraction for the latest completed competitor discovery of every article.';

-- Reconcile existing completed searches immediately at deployment; future
-- searches continue through the database completion trigger.
select public.reconcile_automatic_competitor_extraction();

notify pgrst, 'reload schema';

commit;
