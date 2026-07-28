begin;

-- The full-article coordinator only schedules and observes specialized durable
-- jobs. Firecrawl, Gemini, content writing, and engineering analysis remain in
-- their existing workers and keep their existing retry/cancellation policies.
alter table public.ai_external_analysis_jobs
  drop constraint if exists ai_external_analysis_jobs_job_type_check;
alter table public.ai_external_analysis_jobs
  drop constraint if exists ai_external_analysis_jobs_command_shape_check;

alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_job_type_check
  check (job_type in (
    'semantic_keywords_lsi',
    'content_brief_generation',
    'full_article_pipeline',
    'engineering_command',
    'competitor_discovery',
    'competitor_extraction'
  ));

alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_command_shape_check
  check (
    (
      job_type in (
        'semantic_keywords_lsi',
        'content_brief_generation',
        'full_article_pipeline',
        'competitor_discovery',
        'competitor_extraction'
      )
      and command_id is null
    )
    or (
      job_type = 'engineering_command'
      and nullif(btrim(command_id), '') is not null
    )
  );

create unique index if not exists ai_external_analysis_jobs_one_active_full_pipeline_idx
  on public.ai_external_analysis_jobs(article_id)
  where job_type = 'full_article_pipeline'
    and status in (
      'waiting_for_prerequisites',
      'queued',
      'running',
      'retry_scheduled',
      'paused'
    );

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
  v_competitor_count integer := greatest(1, least(coalesce(p_competitor_count, 5), 5));
  v_idempotency_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
begin
  select article.*
  into v_article
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
  if nullif(btrim(coalesce(v_article.keywords->>'company', '')), '') is null then
    raise exception 'The company/client name is required.' using errcode = '22023';
  end if;

  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'full_article_pipeline'
    and job.status in (
      'waiting_for_prerequisites',
      'queued',
      'running',
      'retry_scheduled',
      'paused'
    )
  order by job.created_at desc
  limit 1;
  if v_job.id is not null then
    return v_job;
  end if;

  if v_idempotency_key is null then
    v_idempotency_key := 'full-article-pipeline:' || gen_random_uuid()::text;
  end if;

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
      coalesce(v_article.updated_at::text, ''),
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
      'qualityGatePolicy', 'insert_regardless',
      'requestedAt', now()
    ),
    jsonb_build_object(
      'stage', 'queued',
      'stageIndex', 0,
      'stageCount', 7,
      'qualityGatePolicy', 'insert_regardless',
      'updatedAt', now()
    ),
    now()
  )
  returning * into v_job;

  return v_job;
end;
$$;

create or replace function public.enqueue_full_article_pipeline_brief(
  p_pipeline_job_id uuid,
  p_requested_by uuid
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline public.ai_external_analysis_jobs%rowtype;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_key text;
begin
  select job.*
  into v_pipeline
  from public.ai_external_analysis_jobs as job
  where job.id = p_pipeline_job_id
    and job.job_type = 'full_article_pipeline';
  if v_pipeline.id is null then
    raise exception 'Full article pipeline was not found.' using errcode = 'P0002';
  end if;
  if public.article_access_level_for_user(v_pipeline.article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;

  v_key := 'full-pipeline-brief:' || v_pipeline.id::text;
  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_pipeline.article_id
    and job.job_type = 'content_brief_generation'
    and job.idempotency_key = v_key
  order by job.created_at desc
  limit 1
  for update;

  if v_job.id is not null and v_job.status in ('failed', 'blocked', 'cancelled') then
    update public.ai_external_analysis_jobs as job
    set
      requested_by = p_requested_by,
      status = 'queued',
      result = null,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'queued',
        'source', 'full_pipeline_retry',
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
      updated_at = now()
    where job.id = v_job.id
    returning job.* into v_job;
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
      progress,
      next_attempt_at
    ) values (
      v_pipeline.article_id,
      p_requested_by,
      'content_brief_generation',
      'manual',
      'queued',
      v_key,
      v_pipeline.batch_key,
      2,
      v_pipeline.id::text,
      jsonb_build_object(
        'pipelineJobId', v_pipeline.id,
        'articleTitle', coalesce(v_pipeline.input_snapshot->>'articleTitle', '')
      ),
      jsonb_build_object(
        'stage', 'queued',
        'pipelineJobId', v_pipeline.id,
        'updatedAt', now()
      ),
      now()
    )
    returning * into v_job;
  end if;

  return v_job;
end;
$$;

create or replace function public.enqueue_full_article_pipeline_competitor_analysis(
  p_pipeline_job_id uuid,
  p_requested_by uuid
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline public.ai_external_analysis_jobs%rowtype;
  v_article public.articles%rowtype;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_command_id text := 'smartAnalysis.competitorContentComparison';
  v_command_label text := 'تحليل المنافسين الشامل';
  v_key text;
begin
  select job.*
  into v_pipeline
  from public.ai_external_analysis_jobs as job
  where job.id = p_pipeline_job_id
    and job.job_type = 'full_article_pipeline';
  if v_pipeline.id is null then
    raise exception 'Full article pipeline was not found.' using errcode = 'P0002';
  end if;
  if public.article_access_level_for_user(v_pipeline.article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;

  select article.* into v_article
  from public.articles as article
  where article.id = v_pipeline.article_id;
  select state.* into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = v_pipeline.article_id;
  if v_article.id is null or v_state.article_id is null or not v_state.external_analysis_ready then
    raise exception 'Comprehensive competitor analysis prerequisites are incomplete.'
      using errcode = '22023';
  end if;

  v_key := 'engineering:' || v_command_id || ':' || v_state.external_analysis_readiness_signature;
  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.job_type = 'engineering_command'
    and job.command_id = v_command_id
    and job.readiness_signature = v_state.external_analysis_readiness_signature
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by
    case when job.status = 'completed' then 0
      when job.status in ('running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused') then 1
      else 2 end,
    job.created_at desc
  limit 1
  for update;

  if v_job.id is not null and v_job.status in ('failed', 'blocked', 'cancelled') then
    update public.ai_external_analysis_jobs as job
    set
      requested_by = p_requested_by,
      origin = 'manual',
      status = 'queued',
      batch_key = 'full-pipeline-analysis:' || v_pipeline.id::text,
      sequence_number = 1,
      command_label = v_command_label,
      depends_on_job_id = null,
      result = null,
      progress = jsonb_build_object(
        'stage', 'queued',
        'source', 'full_article_pipeline',
        'pipelineJobId', v_pipeline.id,
        'commandSequence', 1,
        'commandTotal', 1,
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
      updated_at = now()
    where job.id = v_job.id
    returning job.* into v_job;
  elsif v_job.id is not null and v_job.status in ('waiting_for_prerequisites', 'paused') then
    update public.ai_external_analysis_jobs as job
    set
      requested_by = p_requested_by,
      origin = 'manual',
      status = 'queued',
      batch_key = 'full-pipeline-analysis:' || v_pipeline.id::text,
      sequence_number = 1,
      command_label = v_command_label,
      depends_on_job_id = null,
      next_attempt_at = now(),
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'queued',
        'source', 'full_article_pipeline',
        'pipelineJobId', v_pipeline.id,
        'commandSequence', 1,
        'commandTotal', 1,
        'updatedAt', now()
      ),
      updated_at = now()
    where job.id = v_job.id
    returning job.* into v_job;
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
      command_id,
      command_label,
      depends_on_job_id,
      readiness_signature,
      input_snapshot,
      progress,
      next_attempt_at
    ) values (
      v_article.id,
      p_requested_by,
      'engineering_command',
      'manual',
      'queued',
      v_key,
      'full-pipeline-analysis:' || v_pipeline.id::text,
      1,
      v_command_id,
      v_command_label,
      null,
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
        'selectionMode', 'full_article_pipeline',
        'selectionSignature', v_pipeline.id::text,
        'commandSequence', 1,
        'commandTotal', 1,
        'commandId', v_command_id,
        'pipelineJobId', v_pipeline.id
      ),
      jsonb_build_object(
        'stage', 'queued',
        'source', 'full_article_pipeline',
        'pipelineJobId', v_pipeline.id,
        'commandSequence', 1,
        'commandTotal', 1,
        'updatedAt', now()
      ),
      now()
    )
    on conflict do nothing
    returning * into v_job;
  end if;

  if v_job.id is null then
    select job.*
    into v_job
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_article.id
      and job.job_type = 'engineering_command'
      and job.command_id = v_command_id
      and job.readiness_signature = v_state.external_analysis_readiness_signature
      and job.last_error_code is distinct from 'duplicate_task_suppressed'
    order by job.created_at
    limit 1;
  end if;

  return v_job;
end;
$$;

create or replace function public.apply_full_article_pipeline_content(
  p_pipeline_job_id uuid,
  p_session_id uuid,
  p_content_html text,
  p_plain_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline public.ai_external_analysis_jobs%rowtype;
  v_session public.content_writing_sessions%rowtype;
  v_article public.articles%rowtype;
  v_version integer;
  v_word_count integer;
  v_stats jsonb;
  v_metadata jsonb;
begin
  select job.*
  into v_pipeline
  from public.ai_external_analysis_jobs as job
  where job.id = p_pipeline_job_id
    and job.job_type = 'full_article_pipeline';
  if v_pipeline.id is null then
    raise exception 'Full article pipeline was not found.' using errcode = 'P0002';
  end if;

  select session.*
  into v_session
  from public.content_writing_sessions as session
  where session.id = p_session_id
    and session.article_id = v_pipeline.article_id
    and session.status = 'completed';
  if v_session.id is null or nullif(btrim(coalesce(v_session.result_text, '')), '') is null then
    raise exception 'A completed content-writing result is required.' using errcode = '22023';
  end if;
  if public.article_access_level_for_user(v_pipeline.article_id, v_pipeline.requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_plain_text, '')), '') is null then
    raise exception 'Generated article text cannot be empty.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_pipeline.article_id::text || ':full-article-pipeline-apply',
    0
  ));
  select article.*
  into v_article
  from public.articles as article
  where article.id = v_pipeline.article_id
  for update;

  if v_session.applied_at is not null
    or coalesce(v_article.metadata->'fullArticlePipeline'->>'jobId', '') = v_pipeline.id::text then
    return jsonb_build_object(
      'articleId', v_article.id,
      'versionNumber', v_article.save_count,
      'alreadyApplied', true,
      'appliedAt', v_session.applied_at
    );
  end if;

  select greatest(
    coalesce(v_article.save_count, 0) + 1,
    coalesce(max(article_version.version_number), 0) + 1
  )
  into v_version
  from public.article_versions as article_version
  where article_version.article_id = v_article.id;

  v_word_count := coalesce(array_length(
    regexp_split_to_array(btrim(coalesce(p_plain_text, '')), '\s+'),
    1
  ), 0);
  v_stats := coalesce(v_article.stats, '{}'::jsonb)
    || jsonb_build_object('wordCount', v_word_count);
  v_metadata := coalesce(v_article.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'fullArticlePipeline',
      jsonb_build_object(
        'jobId', v_pipeline.id,
        'contentWritingSessionId', v_session.id,
        'insertedRegardlessOfQualityGate', true,
        'qualityGatePassed', coalesce(v_session.quality_report->>'passed', 'false') = 'true',
        'qualityScore', v_session.quality_score,
        'appliedAt', now()
      )
    );

  update public.articles as article
  set
    content_json = '{}'::jsonb,
    content_html = nullif(p_content_html, ''),
    plain_text = p_plain_text,
    analysis = null,
    stats = v_stats,
    metadata = v_metadata,
    save_count = v_version,
    last_saved_at = now()
  where article.id = v_article.id
  returning article.* into v_article;

  insert into public.article_versions (
    article_id,
    version_number,
    created_by,
    title,
    content_json,
    content_html,
    plain_text,
    keywords,
    goal_context,
    analysis,
    stats,
    note
  ) values (
    v_article.id,
    v_version,
    v_pipeline.requested_by,
    v_article.title,
    v_article.content_json,
    v_article.content_html,
    v_article.plain_text,
    v_article.keywords,
    v_article.goal_context,
    null,
    v_article.stats,
    'full-article-pipeline-auto-apply'
  );

  return jsonb_build_object(
    'articleId', v_article.id,
    'versionNumber', v_version,
    'alreadyApplied', false,
    'wordCount', v_word_count,
    'qualityGatePassed', coalesce(v_session.quality_report->>'passed', 'false') = 'true',
    'qualityScore', v_session.quality_score,
    'appliedAt', now()
  );
end;
$$;

revoke all on function public.enqueue_full_article_pipeline(uuid, uuid, text, text, integer, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_full_article_pipeline_brief(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.enqueue_full_article_pipeline_competitor_analysis(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.apply_full_article_pipeline_content(uuid, uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.enqueue_full_article_pipeline(uuid, uuid, text, text, integer, text)
  to service_role;
grant execute on function public.enqueue_full_article_pipeline_brief(uuid, uuid)
  to service_role;
grant execute on function public.enqueue_full_article_pipeline_competitor_analysis(uuid, uuid)
  to service_role;
grant execute on function public.apply_full_article_pipeline_content(uuid, uuid, text, text)
  to service_role;

comment on function public.enqueue_full_article_pipeline(uuid, uuid, text, text, integer, text)
is 'Queues one durable seven-stage full-article workflow. Its generated article is inserted even when the content-writing quality gate does not pass.';
comment on function public.apply_full_article_pipeline_content(uuid, uuid, text, text)
is 'Atomically applies the completed writing result and creates an article version before the comprehensive competitor analysis stage.';

commit;
