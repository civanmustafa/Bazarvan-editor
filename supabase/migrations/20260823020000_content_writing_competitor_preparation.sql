begin;

-- "Write article" may prepare competitor texts before it creates the writing
-- session. The preparation itself is a durable coordinator job so closing the
-- editor does not interrupt discovery or extraction.
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
    'content_writing_preparation',
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
        'content_writing_preparation',
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

create unique index if not exists ai_external_analysis_jobs_one_active_writing_preparation_idx
  on public.ai_external_analysis_jobs(article_id, job_type)
  where job_type = 'content_writing_preparation'
    and status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');

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

-- Finds one otherwise-ready automatic-writing article that still lacks usable
-- competitor prose. It queues preparation only; the normal automatic-writing
-- scheduler creates the writing session after the texts become ready.
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
    on profile.id in (article.assigned_to, article.owner_id, article.created_by)
  where article.id = v_article_id
    and profile.is_active is true
    and public.article_access_level_for_user(article.id, profile.id) in ('write', 'admin')
  order by case profile.id
    when article.assigned_to then 1
    when article.owner_id then 2
    else 3
  end
  limit 1;

  if v_requested_by is null then
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

revoke all on function public.enqueue_content_writing_competitor_preparation(uuid, uuid, text, text, text, text, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.enqueue_next_automatic_writing_competitor_preparation(integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_content_writing_competitor_preparation(uuid, uuid, text, text, text, text, integer, boolean)
  to service_role;
grant execute on function public.enqueue_next_automatic_writing_competitor_preparation(integer)
  to service_role;

comment on function public.enqueue_content_writing_competitor_preparation(uuid, uuid, text, text, text, text, integer, boolean)
is 'Durably discovers and extracts competitor prose before Write article; an explicit request continues into the selected writing model.';

commit;
