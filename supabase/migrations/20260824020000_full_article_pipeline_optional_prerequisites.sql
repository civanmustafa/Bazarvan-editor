begin;

-- The comprehensive workflow generates semantic terms, the brief, and
-- competitor inputs before writing. A company/client is valuable context but
-- is not a valid prerequisite for informational articles. Keep the primary
-- keyword mandatory and let the writing layer explicitly mark the company and
-- manual goal fields as unspecified instead of inventing them.
create or replace function public.enqueue_full_article_pipeline(
  p_article_id uuid,
  p_requested_by uuid,
  p_provider text,
  p_model text,
  p_competitor_count integer default 5,
  p_idempotency_key text default null
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_provider text := nullif(btrim(coalesce(p_provider, '')), '');
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_competitor_count integer := greatest(3, least(coalesce(p_competitor_count, 5), 5));
  v_idempotency_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_baseline_hash text;
begin
  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id
  for update;
  if v_article.id is null then
    raise exception 'Article was not found.' using errcode = 'P0002';
  end if;
  if public.article_access_level_for_user(p_article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if v_provider not in ('gemini', 'geminiPaid', 'openai') then
    raise exception 'A valid content-writing provider is required.' using errcode = '22023';
  end if;
  if v_model is null then
    raise exception 'A content-writing model is required.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(v_article.keywords->>'primary', '')), '') is null then
    raise exception 'The primary keyword is required.' using errcode = '22023';
  end if;

  select job.* into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'full_article_pipeline'
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  order by job.created_at desc
  limit 1;
  if v_job.id is not null then return v_job; end if;

  v_idempotency_key := coalesce(
    v_idempotency_key,
    'full-article-pipeline:' || gen_random_uuid()::text
  );
  v_baseline_hash := public.full_article_pipeline_content_hash(
    v_article.content_json,
    v_article.content_html,
    v_article.plain_text
  );

  insert into public.ai_external_analysis_jobs(
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
    next_attempt_at,
    max_attempts
  ) values (
    p_article_id,
    p_requested_by,
    'full_article_pipeline',
    'manual',
    'queued',
    left(v_idempotency_key, 240),
    left(v_idempotency_key, 240),
    0,
    md5(concat_ws(
      ':',
      p_article_id::text,
      v_baseline_hash,
      v_provider,
      v_model,
      v_competitor_count::text
    )),
    jsonb_build_object(
      'provider', v_provider,
      'model', v_model,
      'competitorCount', v_competitor_count,
      'articleTitle', coalesce(v_article.title, ''),
      'articleLanguage', case when v_article.article_language = 'en' then 'en' else 'ar' end,
      'baselineSaveCount', v_article.save_count,
      'baselineContentHash', v_baseline_hash,
      'baselineCapturedAt', now(),
      'qualityGatePolicy', 'review_required',
      'optionalPrerequisites', jsonb_build_object(
        'company', nullif(btrim(coalesce(v_article.keywords->>'company', '')), '') is null,
        'goalContext',
          nullif(btrim(coalesce(v_article.goal_context->>'pageType', '')), '') is null
          or nullif(btrim(coalesce(v_article.goal_context->>'objective', '')), '') is null
          or nullif(btrim(coalesce(v_article.goal_context->>'audienceScope', '')), '') is null
          or nullif(btrim(coalesce(v_article.goal_context->>'searchIntent', '')), '') is null
      ),
      'requestedAt', now()
    ),
    jsonb_build_object(
      'stage', 'queued',
      'stageIndex', 0,
      'stageCount', 7,
      'qualityGatePolicy', 'review_required',
      'updatedAt', now()
    ),
    now(),
    6
  ) returning * into v_job;

  return v_job;
end;
$$;

revoke all on function public.enqueue_full_article_pipeline(uuid, uuid, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.enqueue_full_article_pipeline(uuid, uuid, text, text, integer, text)
  to service_role;

comment on function public.enqueue_full_article_pipeline(uuid, uuid, text, text, integer, text)
is 'Queues the durable reviewed seven-stage workflow from title, editor text, and primary keyword; company and manual goal choices are optional and never fabricated.';

create or replace function public.full_article_pipeline_schema_version()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 3;
$$;

revoke all on function public.full_article_pipeline_schema_version()
  from public, anon, authenticated;
grant execute on function public.full_article_pipeline_schema_version()
  to service_role;

comment on function public.full_article_pipeline_schema_version()
is 'Returns the deployed full-article pipeline schema contract version for non-mutating readiness checks.';

notify pgrst, 'reload schema';

commit;
