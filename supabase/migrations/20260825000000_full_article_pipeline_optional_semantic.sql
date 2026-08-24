-- Generate semantic keyword lists for the comprehensive workflow without
-- weakening the company/goal prerequisites of manual and automatic entry points.

begin;

create or replace function public.enqueue_full_article_pipeline_semantic(
  p_pipeline_job_id uuid,
  p_requested_by uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_completion_pass integer default 1
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline public.ai_external_analysis_jobs%rowtype;
  v_article public.articles%rowtype;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_has_secondaries boolean := false;
  v_has_lsi boolean := false;
  v_pass integer := greatest(1, least(coalesce(p_completion_pass, 1), 3));
  v_source_signature text;
  v_job_signature text;
  v_idempotency_key text;
  v_input_snapshot jsonb;
  v_job_id uuid;
  v_job_status text;
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
  if nullif(btrim(coalesce(v_article.title, '')), '') is null
     or lower(btrim(v_article.title)) in ('(untitled)', 'untitled') then
    raise exception 'Article title is required for semantic keyword generation.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(v_article.keywords->>'primary', '')), '') is null then
    raise exception 'Primary keyword is required for semantic keyword generation.' using errcode = '22023';
  end if;

  select * into v_state
  from public.ai_external_analysis_article_state
  where article_id = v_article.id;

  if v_state.article_id is null or nullif(v_state.semantic_readiness_signature, '') is null then
    raise exception 'Semantic readiness signature is unavailable.' using errcode = '55000';
  end if;

  v_has_secondaries := public.external_analysis_has_competitor_value(
    v_article.keywords->'secondaries',
    100
  );
  v_has_lsi := public.external_analysis_has_competitor_value(
    v_article.keywords->'lsi',
    100
  );
  if v_has_secondaries and v_has_lsi then
    return null;
  end if;

  v_source_signature := v_state.semantic_readiness_signature;
  v_job_signature := 'full-pipeline:' || v_source_signature || ':pass:' || v_pass::text;
  v_idempotency_key := 'full-pipeline-semantic:' || v_pipeline.id::text || ':pass:' || v_pass::text;
  v_input_snapshot := jsonb_build_object(
    'title', v_article.title,
    'plainText', v_article.plain_text,
    'keywords', coalesce(v_article.keywords, '{}'::jsonb),
    'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
    'articleLanguage', v_article.article_language,
    'articleUpdatedAt', v_article.updated_at,
    'readinessSignature', v_job_signature,
    'sourceReadinessSignature', v_source_signature,
    'needsSecondaries', not v_has_secondaries,
    'needsLsi', not v_has_lsi,
    'pipelineJobId', v_pipeline.id,
    'pipelineLeaseGeneration', p_lease_generation,
    'pipelineSemanticGeneration', true,
    'companyIsOptional', true,
    'goalContextIsOptional', true,
    'completionPass', v_pass
  );

  perform pg_advisory_xact_lock(hashtextextended(
    v_article.id::text || ':' || v_idempotency_key,
    0
  ));

  select job.id, job.status
  into v_job_id, v_job_status
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.job_type = 'semantic_keywords_lsi'
    and job.idempotency_key = v_idempotency_key
  order by job.created_at desc
  limit 1
  for update;

  if v_job_id is not null and v_job_status in ('failed', 'blocked', 'cancelled') then
    update public.ai_external_analysis_jobs as job
    set requested_by = p_requested_by,
        origin = 'manual',
        status = 'queued',
        readiness_signature = v_job_signature,
        input_snapshot = v_input_snapshot,
        result = null,
        progress = jsonb_build_object(
          'stage', 'queued',
          'source', 'full_article_pipeline_optional_semantic',
          'pipelineJobId', v_pipeline.id,
          'completionPass', v_pass,
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
    v_article.id, p_requested_by, 'semantic_keywords_lsi', 'manual', 'queued',
    v_idempotency_key, v_idempotency_key, 0, v_job_signature, v_input_snapshot,
    jsonb_build_object(
      'stage', 'queued',
      'source', 'full_article_pipeline_optional_semantic',
      'pipelineJobId', v_pipeline.id,
      'completionPass', v_pass,
      'updatedAt', now()
    ),
    now(), v_pipeline.id, 6
  )
  on conflict do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select job.id into v_job_id
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_article.id
      and job.job_type = 'semantic_keywords_lsi'
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
  select 5;
$$;

revoke all on function public.enqueue_full_article_pipeline_semantic(uuid, uuid, text, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.full_article_pipeline_schema_version()
  from public, anon, authenticated;
grant execute on function public.enqueue_full_article_pipeline_semantic(uuid, uuid, text, bigint, integer)
  to service_role;
grant execute on function public.full_article_pipeline_schema_version()
  to service_role;

comment on function public.enqueue_full_article_pipeline_semantic(uuid, uuid, text, bigint, integer)
is 'Creates a fenced pipeline-owned semantic generation pass while keeping company and manual goal context optional only for the comprehensive workflow.';
comment on function public.full_article_pipeline_schema_version()
is 'Returns the installed comprehensive article pipeline compatibility version.';

notify pgrst, 'reload schema';

commit;
