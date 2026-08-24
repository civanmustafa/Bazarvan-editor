-- Keep the comprehensive workflow independent from the manual/automatic
-- competitor-discovery company prerequisite. Those entry points retain their
-- existing readiness rules; this coordinator owns a pipeline-scoped child.

begin;

create or replace function public.enqueue_full_article_pipeline_competitor_discovery(
  p_pipeline_job_id uuid,
  p_requested_by uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_force_refresh boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline public.ai_external_analysis_jobs%rowtype;
  v_article public.articles%rowtype;
  v_job_id uuid;
  v_job_status text;
  v_query_type text;
  v_query_text text;
  v_idempotency_key text;
  v_readiness_signature text;
  v_input_snapshot jsonb;
begin
  select * into v_pipeline
  from public.ai_external_analysis_jobs
  where id = p_pipeline_job_id
  for update;

  if v_pipeline.id is null
     or v_pipeline.job_type <> 'full_article_pipeline'
     or v_pipeline.status <> 'running'
     or v_pipeline.locked_by is distinct from btrim(coalesce(p_worker_id, ''))
     or v_pipeline.lease_generation <> p_lease_generation
     or v_pipeline.cancel_requested_at is not null
     or v_pipeline.lease_expires_at is null
     or v_pipeline.lease_expires_at <= now() then
    raise exception 'Full article pipeline execution is fenced or cancelled.' using errcode = '55000';
  end if;

  if p_requested_by is distinct from v_pipeline.requested_by
     or public.article_access_level_for_user(v_pipeline.article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;

  select * into v_article
  from public.articles
  where id = v_pipeline.article_id;

  if v_article.id is null then
    raise exception 'Article was not found.' using errcode = 'P0002';
  end if;

  v_query_type := case
    when nullif(btrim(coalesce(v_article.keywords->>'primary', '')), '') is not null
      then 'primary_keyword'
    else 'title'
  end;
  v_query_text := case
    when v_query_type = 'primary_keyword' then btrim(v_article.keywords->>'primary')
    else btrim(v_article.title)
  end;

  if nullif(v_query_text, '') is null or lower(v_query_text) in ('(untitled)', 'untitled') then
    raise exception 'Article title or primary keyword is required for competitor discovery.' using errcode = '22023';
  end if;

  v_idempotency_key := 'full-pipeline-discovery:' || v_pipeline.id::text
    || case when coalesce(p_force_refresh, false)
      then ':refresh:' || p_lease_generation::text
      else ''
    end;
  v_readiness_signature := 'full-pipeline:' || md5(jsonb_build_object(
    'pipelineJobId', v_pipeline.id,
    'queryType', v_query_type,
    'queryText', v_query_text,
    'articleTitle', coalesce(v_article.title, ''),
    'primaryKeyword', coalesce(v_article.keywords->>'primary', ''),
    'articleLanguage', case when v_article.article_language = 'en' then 'en' else 'ar' end,
    'pageType', coalesce(v_article.goal_context->>'pageType', ''),
    'searchIntent', coalesce(v_article.goal_context->>'searchIntent', ''),
    'audienceScope', coalesce(v_article.goal_context->>'audienceScope', ''),
    'targetCountry', coalesce(v_article.goal_context->>'targetCountry', ''),
    'refreshGeneration', case when coalesce(p_force_refresh, false) then p_lease_generation else null end
  )::text);
  v_input_snapshot := jsonb_build_object(
    'queryType', v_query_type,
    'queryText', v_query_text,
    'articleTitle', coalesce(v_article.title, ''),
    'primaryKeyword', coalesce(v_article.keywords->>'primary', ''),
    'companyName', coalesce(v_article.keywords->>'company', ''),
    'articleLanguage', case when v_article.article_language = 'en' then 'en' else 'ar' end,
    'pageType', coalesce(v_article.goal_context->>'pageType', ''),
    'searchIntent', coalesce(v_article.goal_context->>'searchIntent', ''),
    'audienceScope', coalesce(v_article.goal_context->>'audienceScope', ''),
    'targetCountry', coalesce(v_article.goal_context->>'targetCountry', ''),
    'readinessSignature', v_readiness_signature,
    'pipelineJobId', v_pipeline.id,
    'pipelineLeaseGeneration', p_lease_generation,
    'pipelineCompetitorRefresh', coalesce(p_force_refresh, false),
    'companyIsOptional', true
  );

  perform pg_advisory_xact_lock(hashtextextended(
    v_pipeline.article_id::text || ':' || v_idempotency_key,
    0
  ));

  select job.id, job.status
  into v_job_id, v_job_status
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_pipeline.article_id
    and job.job_type = 'competitor_discovery'
    and job.idempotency_key = v_idempotency_key
  order by job.created_at desc
  limit 1
  for update;

  if v_job_id is not null and v_job_status in ('failed', 'blocked', 'cancelled') then
    update public.ai_external_analysis_jobs as job
    set requested_by = p_requested_by,
        origin = 'manual',
        status = 'queued',
        readiness_signature = v_readiness_signature,
        input_snapshot = v_input_snapshot,
        result = null,
        progress = jsonb_build_object(
          'stage', 'queued',
          'source', 'full_article_pipeline_optional_discovery',
          'pipelineJobId', v_pipeline.id,
          'updatedAt', now()
        ),
        last_error = null,
        last_error_code = null,
        next_attempt_at = now(),
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        cancel_requested_at = null,
        completed_at = null,
        pipeline_parent_job_id = v_pipeline.id,
        max_attempts = greatest(job.max_attempts, 6),
        updated_at = now()
    where job.id = v_job_id;
    return v_job_id;
  end if;

  if v_job_id is not null then
    return v_job_id;
  end if;

  insert into public.ai_external_analysis_jobs(
    article_id, requested_by, job_type, origin, status, idempotency_key,
    batch_key, sequence_number, readiness_signature, input_snapshot, progress,
    next_attempt_at, pipeline_parent_job_id, max_attempts
  ) values (
    v_pipeline.article_id, p_requested_by, 'competitor_discovery', 'manual', 'queued',
    v_idempotency_key, v_idempotency_key, 0, v_readiness_signature, v_input_snapshot,
    jsonb_build_object(
      'stage', 'queued',
      'source', 'full_article_pipeline_optional_discovery',
      'pipelineJobId', v_pipeline.id,
      'updatedAt', now()
    ),
    now(), v_pipeline.id, 6
  )
  on conflict do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select job.id into v_job_id
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_pipeline.article_id
      and job.job_type = 'competitor_discovery'
      and job.idempotency_key = v_idempotency_key
    order by job.created_at desc
    limit 1;
  end if;

  return v_job_id;
end;
$$;

create or replace function public.full_article_pipeline_schema_version()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 4;
$$;

revoke all on function public.enqueue_full_article_pipeline_competitor_discovery(uuid, uuid, text, bigint, boolean)
  from public, anon, authenticated;
revoke all on function public.full_article_pipeline_schema_version()
  from public, anon, authenticated;
grant execute on function public.enqueue_full_article_pipeline_competitor_discovery(uuid, uuid, text, bigint, boolean)
  to service_role;
grant execute on function public.full_article_pipeline_schema_version()
  to service_role;

comment on function public.enqueue_full_article_pipeline_competitor_discovery(uuid, uuid, text, bigint, boolean)
is 'Creates a pipeline-owned competitor search from title/primary keyword while keeping company optional only for the comprehensive workflow.';
comment on function public.full_article_pipeline_schema_version()
is 'Returns the installed comprehensive article pipeline compatibility version.';

notify pgrst, 'reload schema';

commit;
