begin;

-- Respect the exact competitor count selected by the user. The previous
-- coordinator silently raised 1 or 2 to 3 before persisting the job snapshot,
-- which also made dashboard cards report 3.
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
  v_competitor_count integer := greatest(2, least(coalesce(p_competitor_count, 5), 5));
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
is 'Queues the durable reviewed workflow while preserving the exact requested competitor count from 2 through 5.';

-- An explicit user resume is priority work. An automatic resume is still an
-- automatic queue item and must not repeatedly overtake other articles.
create or replace function public.content_writing_queue_priority(p_context jsonb, p_progress jsonb)
returns integer
language sql immutable parallel safe
set search_path = public, pg_temp
as $$
  select case
    when coalesce(nullif(p_context->>'triggerSource', ''), 'manual') = 'manual' then 1
    when p_progress->>'resumed' = 'true'
      and coalesce(p_progress->>'automaticResume', 'false') <> 'true' then 1
    else 0
  end;
$$;

-- A queue attempt covers the full set of immediately eligible Gemini keys and
-- fallback models inside the AI engine. Once that attempt returns a failure,
-- release the article turn so another article can run during the retry delay.
create or replace function public.rotate_external_analysis_article_after_retry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.ai_external_analysis_jobs as sibling
  set
    progress = coalesce(sibling.progress, '{}'::jsonb)
      || jsonb_build_object(
        'articleQueueLocked', false,
        'articleQueueReleasedAt', now(),
        'articleQueueReleaseReason', coalesce(new.last_error_code, 'external_analysis_retry'),
        'queuePolicy', 'round_robin_after_attempt',
        'updatedAt', now()
      ),
    updated_at = now()
  where sibling.article_id = new.article_id
    and sibling.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    and sibling.cancel_requested_at is null
    and coalesce(sibling.progress->>'articleQueueLocked', 'false') = 'true';
  return new;
end;
$$;

drop trigger if exists rotate_external_analysis_article_after_retry
  on public.ai_external_analysis_jobs;
create trigger rotate_external_analysis_article_after_retry
after update of status on public.ai_external_analysis_jobs
for each row
when (old.status = 'running' and new.status = 'retry_scheduled')
execute function public.rotate_external_analysis_article_after_retry();

revoke all on function public.rotate_external_analysis_article_after_retry()
  from public, anon, authenticated;

-- Before resuming a failed automatic-writing session, give every otherwise
-- eligible article with fewer consumed attempts one turn. The short deferral
-- makes the existing atomic claim RPC skip the retry without discarding the
-- failed session or any completed writing steps.
create or replace function public.defer_due_automatic_content_writing_retry_for_fairness()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ai jsonb := '{}'::jsonb;
  v_candidate public.content_writing_automation_items%rowtype;
  v_min_competitors integer := 3;
  v_require_processing_complete boolean := true;
begin
  perform pg_advisory_xact_lock(hashtextextended('content-writing-automation-claim', 0));

  select coalesce(setting.value, '{}'::jsonb)
  into v_ai
  from public.app_settings as setting
  where setting.key = 'ai';

  if coalesce(v_ai->>'contentWritingAutomationMinimumCompetitors', '') ~ '^\d+$' then
    v_min_competitors := greatest(
      2,
      least((v_ai->>'contentWritingAutomationMinimumCompetitors')::integer, 5)
    );
  end if;
  if lower(coalesce(v_ai->>'contentWritingAutomationRequireCompetitorTerminalState', 'true')) = 'false' then
    v_require_processing_complete := false;
  end if;

  select item.*
  into v_candidate
  from public.content_writing_automation_items as item
  join public.content_writing_sessions as session
    on session.id = item.content_writing_session_id
  where item.status = 'ready'
    and item.eligible_at <= now()
    and item.attempt_count < item.max_attempts
    and session.status = 'failed'
    and session.execution_mode = 'api'
    and session.cancel_requested_at is null
    and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
    and lower(coalesce(session.last_error_code, '')) !~
      '(cancel|prerequisite|quality|policy|identity|article_changed|editor_not_empty|manual_attention)'
  order by item.attempt_count, item.eligible_at, item.ready_at, item.id
  limit 1;

  if v_candidate.id is null then return false; end if;

  if not exists (
    select 1
    from public.articles as article
    left join public.content_writing_automation_items as existing
      on existing.article_id = article.id
    cross join lateral (
      select public.evaluate_content_writing_automation_readiness(article.id) as value
    ) as readiness
    where article.id <> v_candidate.article_id
      and article.status in ('content_preparation', 'draft')
      and public.article_automatic_job_allowed(article.id, 'content_writing')
      and coalesce((readiness.value->>'ready')::boolean, false) is true
      and coalesce((readiness.value->>'usableCompetitorCount')::integer, 0) >= v_min_competitors
      and (
        v_require_processing_complete is false
        or coalesce((readiness.value->>'processingComplete')::boolean, false) is true
      )
      and coalesce(existing.attempt_count, 0) < v_candidate.attempt_count
      and (
        existing.id is null
        or (
          existing.status = 'ready'
          and existing.eligible_at <= now()
          and existing.attempt_count < existing.max_attempts
        )
      )
      and (
        existing.id is not null
        or not exists (
          select 1
          from public.content_writing_sessions as completed_session
          where completed_session.article_id = article.id
            and completed_session.status = 'completed'
        )
      )
      and not exists (
        select 1
        from public.ai_external_analysis_jobs as pipeline
        where pipeline.article_id = article.id
          and pipeline.job_type = 'full_article_pipeline'
          and pipeline.status in (
            'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
          )
      )
  ) then
    return false;
  end if;

  update public.content_writing_automation_items as item
  set
    eligible_at = now() + interval '5 seconds',
    updated_at = now()
  where item.id = v_candidate.id
    and item.status = 'ready'
    and item.eligible_at <= now()
    and item.attempt_count = v_candidate.attempt_count;

  return found;
end;
$$;

revoke all on function public.defer_due_automatic_content_writing_retry_for_fairness()
  from public, anon, authenticated;
grant execute on function public.defer_due_automatic_content_writing_retry_for_fairness()
  to service_role;

comment on function public.defer_due_automatic_content_writing_retry_for_fairness()
is 'Defers one due automatic-writing retry when another eligible article has consumed fewer attempts.';

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 4;
$$;

create or replace function public.full_article_pipeline_schema_version()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 6;
$$;

revoke all on function public.content_writing_automation_schema_version()
  from public, anon, authenticated;
grant execute on function public.content_writing_automation_schema_version()
  to service_role;
revoke all on function public.full_article_pipeline_schema_version()
  from public, anon, authenticated;
grant execute on function public.full_article_pipeline_schema_version()
  to service_role;

notify pgrst, 'reload schema';

commit;
