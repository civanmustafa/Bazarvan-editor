-- Full-article pipeline safety: durable parent/child ownership, fenced writes,
-- review blocking, bounded retries, and optimistic article application.

begin;

alter table public.ai_external_analysis_jobs
  add column if not exists pipeline_parent_job_id uuid
    references public.ai_external_analysis_jobs(id) on delete set null,
  add column if not exists lease_generation bigint not null default 0,
  add column if not exists max_attempts integer not null default 6,
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists dead_letter_reason text;

alter table public.content_writing_sessions
  add column if not exists pipeline_parent_job_id uuid
    references public.ai_external_analysis_jobs(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_external_analysis_jobs'::regclass
      and conname = 'ai_external_analysis_jobs_max_attempts_check'
  ) then
    alter table public.ai_external_analysis_jobs
      add constraint ai_external_analysis_jobs_max_attempts_check
      check (max_attempts between 1 and 50);
  end if;
end;
$$;

create index if not exists ai_external_analysis_jobs_pipeline_parent_idx
  on public.ai_external_analysis_jobs(pipeline_parent_job_id, created_at);
create index if not exists content_writing_sessions_pipeline_parent_idx
  on public.content_writing_sessions(pipeline_parent_job_id, created_at);
create index if not exists ai_external_analysis_jobs_dead_letter_idx
  on public.ai_external_analysis_jobs(dead_lettered_at desc)
  where dead_lettered_at is not null;

create or replace function public.full_article_pipeline_content_hash(
  p_content_json jsonb,
  p_content_html text,
  p_plain_text text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select md5(concat_ws(
    chr(31),
    coalesce(p_content_json, '{}'::jsonb)::text,
    coalesce(p_content_html, ''),
    coalesce(p_plain_text, '')
  ));
$$;

-- Backfill safety baselines for a pipeline that was already active when this
-- migration was installed. This lets the stopped production workflow resume
-- without weakening the compare-and-swap guard.
update public.ai_external_analysis_jobs as pipeline
set input_snapshot = coalesce(pipeline.input_snapshot, '{}'::jsonb) || jsonb_build_object(
  'baselineSaveCount', article.save_count,
  'baselineContentHash', public.full_article_pipeline_content_hash(
    article.content_json,
    article.content_html,
    article.plain_text
  ),
  'baselineCapturedAt', now(),
  'qualityGatePolicy', 'review_required'
)
from public.articles as article
where pipeline.article_id = article.id
  and pipeline.job_type = 'full_article_pipeline'
  -- Every pre-safety pipeline that could still be resumed needs a server-owned
  -- baseline, including failed/blocked/cancelled rows. Completed rows are final.
  and pipeline.status <> 'completed'
  and (
    not (coalesce(pipeline.input_snapshot, '{}'::jsonb) ? 'baselineSaveCount')
    or nullif(pipeline.input_snapshot->>'baselineContentHash', '') is null
  );

update public.ai_external_analysis_jobs as child
set pipeline_parent_job_id = (child.input_snapshot->>'pipelineJobId')::uuid
where child.pipeline_parent_job_id is null
  and nullif(child.input_snapshot->>'pipelineJobId', '') is not null
  and child.input_snapshot->>'pipelineJobId'
    ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  and exists (
    select 1
    from public.ai_external_analysis_jobs as parent
    where parent.id = (child.input_snapshot->>'pipelineJobId')::uuid
      and parent.job_type = 'full_article_pipeline'
      and parent.article_id = child.article_id
  );

create or replace function public.claim_next_external_analysis_job(
  p_worker_id text,
  p_supported_job_types text[],
  p_lease_seconds integer default 300
)
returns setof public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 1800));
  v_article_id uuid;
  v_job_id uuid;
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  if nullif(btrim(coalesce(p_worker_id, '')), '') is null then
    raise exception 'worker id is required' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_supported_job_types), 0) = 0 then return; end if;

  -- A due job that has exhausted its durable attempt budget is dead-lettered
  -- before selection, so it cannot churn forever after worker restarts.
  with exhausted as (
    update public.ai_external_analysis_jobs as job
    set status = 'blocked',
        next_attempt_at = null,
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        dead_lettered_at = coalesce(job.dead_lettered_at, now()),
        dead_letter_reason = coalesce(job.dead_letter_reason, 'external_analysis_attempt_budget_exhausted'),
        last_error_code = 'external_analysis_attempt_budget_exhausted',
        last_error = 'The durable execution attempt budget was exhausted.',
        completed_at = coalesce(job.completed_at, now()),
        progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'dead_lettered',
          'reason', 'external_analysis_attempt_budget_exhausted',
          'updatedAt', now()
        ),
        updated_at = now()
    where job.job_type = any(p_supported_job_types)
      and job.status in ('queued', 'retry_scheduled')
      and job.attempt_count >= job.max_attempts
    returning job.id
  )
  update public.ai_external_analysis_runs as run
  set status = 'blocked',
      error_code = 'external_analysis_attempt_budget_exhausted',
      error_message = 'The durable execution attempt budget was exhausted.',
      finished_at = coalesce(run.finished_at, now())
  from exhausted
  where run.job_id = exhausted.id
    and run.status = 'running';

  -- Keep the claim-time dead-letter transition equivalent to the worker RPC:
  -- a terminal parent must never leave a queued/running child or writing session
  -- alive. Running descendants retain their running status only long enough to
  -- observe cancel_requested_at and relinquish their own fenced lease.
  update public.ai_external_analysis_jobs as child
  set status = case when child.status = 'running' then child.status else 'cancelled' end,
      cancel_requested_at = coalesce(child.cancel_requested_at, now()),
      next_attempt_at = case when child.status = 'running' then child.next_attempt_at else null end,
      last_error_code = 'parent_pipeline_dead_lettered',
      last_error = 'The parent pipeline exhausted its retry budget.',
      completed_at = case when child.status = 'running' then child.completed_at else now() end,
      progress = coalesce(child.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when child.status = 'running' then 'cancel_requested' else 'cancelled' end,
        'reason', 'parent_pipeline_dead_lettered',
        'updatedAt', now()
      ),
      updated_at = now()
  from public.ai_external_analysis_jobs as parent
  where child.pipeline_parent_job_id = parent.id
    and parent.job_type = 'full_article_pipeline'
    and parent.dead_lettered_at is not null
    and child.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');

  update public.content_writing_sessions as session
  set status = case when session.status = 'running' then session.status else 'cancelled' end,
      cancel_requested_at = coalesce(session.cancel_requested_at, now()),
      next_attempt_at = case when session.status = 'running' then session.next_attempt_at else null end,
      last_error_code = 'parent_pipeline_dead_lettered',
      last_error = 'The parent pipeline exhausted its retry budget.',
      completed_at = case when session.status = 'running' then session.completed_at else now() end,
      updated_at = now()
  from public.ai_external_analysis_jobs as parent
  where session.pipeline_parent_job_id = parent.id
    and parent.job_type = 'full_article_pipeline'
    and parent.dead_lettered_at is not null
    and session.status in ('queued', 'running', 'retry_scheduled');

  select job.article_id
  into v_article_id
  from public.ai_external_analysis_jobs as job
  where job.job_type = any(p_supported_job_types)
    and job.cancel_requested_at is null
    and job.dead_lettered_at is null
    and job.attempt_count < job.max_attempts
    and (
      (job.status = 'running' and job.lease_expires_at is not null and job.lease_expires_at > now())
      or (
        (job.status = 'queued' or (
          job.status = 'retry_scheduled' and coalesce(job.next_attempt_at, now()) <= now()
        ))
        and (
          job.depends_on_job_id is null
          or exists (
            select 1
            from public.ai_external_analysis_jobs as dependency
            where dependency.id = job.depends_on_job_id
              and (
                dependency.status = 'completed'
                or (
                  job.pipeline_parent_job_id = dependency.id
                  and job.job_type = 'engineering_command'
                  and job.input_snapshot ? 'pipelineDraft'
                  and dependency.job_type = 'full_article_pipeline'
                  and dependency.status = 'running'
                  and dependency.cancel_requested_at is null
                  and dependency.lease_expires_at > now()
                  and coalesce((job.input_snapshot->>'pipelineLeaseGeneration')::bigint, -1)
                    = dependency.lease_generation
                )
              )
          )
        )
      )
    )
  group by job.article_id
  order by
    bool_or(job.status = 'running' and job.lease_expires_at > now()) desc,
    bool_or(coalesce(job.progress->>'articleQueueLocked', 'false') = 'true') desc,
    min(case
      when job.status in ('queued', 'retry_scheduled') then coalesce(job.next_attempt_at, job.created_at)
      else job.created_at
    end),
    job.article_id
  limit 1;

  if v_article_id is null then return; end if;

  update public.ai_external_analysis_jobs as job
  set progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'articleQueueLocked', true,
        'articleQueueLockedAt', coalesce(job.progress->'articleQueueLockedAt', to_jsonb(now())),
        'updatedAt', now()
      ),
      updated_at = now()
  where job.article_id = v_article_id
    and job.job_type = any(p_supported_job_types)
    and job.status in ('queued', 'running', 'retry_scheduled')
    and job.cancel_requested_at is null
    and coalesce(job.progress->>'articleQueueLocked', 'false') <> 'true';

  select job.id
  into v_job_id
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article_id
    and job.job_type = any(p_supported_job_types)
    and (job.status = 'queued' or (
      job.status = 'retry_scheduled' and coalesce(job.next_attempt_at, now()) <= now()
    ))
    and job.cancel_requested_at is null
    and job.dead_lettered_at is null
    and job.attempt_count < job.max_attempts
    and (
      job.depends_on_job_id is null
      or exists (
        select 1
        from public.ai_external_analysis_jobs as dependency
        where dependency.id = job.depends_on_job_id
          and (
            dependency.status = 'completed'
            or (
              job.pipeline_parent_job_id = dependency.id
              and job.job_type = 'engineering_command'
              and job.input_snapshot ? 'pipelineDraft'
              and dependency.job_type = 'full_article_pipeline'
              and dependency.status = 'running'
              and dependency.cancel_requested_at is null
              and dependency.lease_expires_at > now()
              and coalesce((job.input_snapshot->>'pipelineLeaseGeneration')::bigint, -1)
                = dependency.lease_generation
            )
          )
      )
    )
  order by job.sequence_number, coalesce(job.next_attempt_at, job.created_at), job.created_at
  limit 1
  for update skip locked;

  if v_job_id is null then return; end if;

  update public.ai_external_analysis_jobs as job
  set status = 'running',
      attempt_count = job.attempt_count + 1,
      lease_generation = job.lease_generation + 1,
      next_attempt_at = null,
      locked_by = btrim(p_worker_id),
      locked_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      started_at = coalesce(job.started_at, now()),
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'running',
        'workerId', btrim(p_worker_id),
        'articleQueueLocked', true,
        'updatedAt', now()
      ),
      updated_at = now()
  where job.id = v_job_id
  returning job.* into v_job;

  insert into public.ai_external_analysis_runs(job_id, run_number, status, progress)
  values (v_job.id, v_job.attempt_count, 'running', v_job.progress)
  on conflict (job_id, run_number) do update
  set status = 'running', progress = excluded.progress, error_code = null,
      error_message = null, finished_at = null;

  return next v_job;
end;
$$;

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
  -- The writing quality contract needs at least three qualified competitors;
  -- normalise older/UI requests below that threshold instead of scheduling a
  -- pipeline that can only fail its own readiness gate.
  v_competitor_count integer := greatest(3, least(coalesce(p_competitor_count, 5), 5));
  v_idempotency_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_baseline_hash text;
begin
  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id
  for update;
  if v_article.id is null then raise exception 'Article was not found.' using errcode = 'P0002'; end if;
  if public.article_access_level_for_user(p_article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if v_provider not in ('gemini', 'geminiPaid', 'openai') then
    raise exception 'A valid content-writing provider is required.' using errcode = '22023';
  end if;
  if v_model is null then raise exception 'A content-writing model is required.' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(v_article.keywords->>'primary', '')), '') is null then
    raise exception 'The primary keyword is required.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(v_article.keywords->>'company', '')), '') is null then
    raise exception 'The company/client name is required.' using errcode = '22023';
  end if;

  select job.* into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'full_article_pipeline'
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  order by job.created_at desc limit 1;
  if v_job.id is not null then return v_job; end if;

  v_idempotency_key := coalesce(v_idempotency_key, 'full-article-pipeline:' || gen_random_uuid()::text);
  v_baseline_hash := public.full_article_pipeline_content_hash(
    v_article.content_json, v_article.content_html, v_article.plain_text
  );

  insert into public.ai_external_analysis_jobs(
    article_id, requested_by, job_type, origin, status, idempotency_key,
    batch_key, sequence_number, readiness_signature, input_snapshot, progress,
    next_attempt_at, max_attempts
  ) values (
    p_article_id, p_requested_by, 'full_article_pipeline', 'manual', 'queued',
    left(v_idempotency_key, 240), left(v_idempotency_key, 240), 0,
    md5(concat_ws(':', p_article_id::text, v_baseline_hash, v_provider, v_model, v_competitor_count::text)),
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
      'requestedAt', now()
    ),
    jsonb_build_object(
      'stage', 'queued', 'stageIndex', 0, 'stageCount', 7,
      'qualityGatePolicy', 'review_required', 'updatedAt', now()
    ),
    now(), 6
  ) returning * into v_job;
  return v_job;
end;
$$;

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
  v_template public.ai_external_analysis_jobs%rowtype;
  v_template_id uuid;
  v_job_id uuid;
  v_refresh_key text;
begin
  select * into v_pipeline
  from public.ai_external_analysis_jobs
  where id = p_pipeline_job_id
  for update;
  if v_pipeline.id is null or v_pipeline.job_type <> 'full_article_pipeline'
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

  -- Let the canonical discovery function validate readiness and build the
  -- current query snapshot. A forced retry clones that snapshot under a
  -- pipeline-generation idempotency key so a completed stale search is never
  -- returned as if it were a fresh replacement search.
  v_template_id := public.enqueue_competitor_discovery_job(
    v_pipeline.article_id,
    p_requested_by,
    'manual'
  );
  if v_template_id is null then return null; end if;
  if not coalesce(p_force_refresh, false) then return v_template_id; end if;

  select * into v_template
  from public.ai_external_analysis_jobs
  where id = v_template_id
    and article_id = v_pipeline.article_id
    and job_type = 'competitor_discovery';
  if v_template.id is null then
    raise exception 'Competitor discovery template was not found.' using errcode = 'P0002';
  end if;

  v_refresh_key := 'full-pipeline-discovery:'
    || v_pipeline.id::text || ':' || p_lease_generation::text;
  select job.id into v_job_id
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_pipeline.article_id
    and job.idempotency_key = v_refresh_key
  order by job.created_at desc
  limit 1;
  if v_job_id is not null then return v_job_id; end if;

  insert into public.ai_external_analysis_jobs(
    article_id, requested_by, job_type, origin, status, idempotency_key,
    batch_key, sequence_number, readiness_signature, input_snapshot, progress,
    next_attempt_at, pipeline_parent_job_id, max_attempts
  ) values (
    v_pipeline.article_id, p_requested_by, 'competitor_discovery', 'manual', 'queued',
    v_refresh_key, v_refresh_key, 0,
    coalesce(v_template.readiness_signature, 'competitor-discovery')
      || ':pipeline-refresh:' || md5(v_refresh_key),
    coalesce(v_template.input_snapshot, '{}'::jsonb) || jsonb_build_object(
      'pipelineJobId', v_pipeline.id,
      'pipelineLeaseGeneration', p_lease_generation,
      'pipelineCompetitorRefresh', true
    ),
    jsonb_build_object(
      'stage', 'queued', 'source', 'full_article_pipeline_refresh',
      'pipelineJobId', v_pipeline.id, 'updatedAt', now()
    ),
    now(), v_pipeline.id, greatest(v_template.max_attempts, 6)
  )
  on conflict do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select job.id into v_job_id
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_pipeline.article_id
      and job.idempotency_key = v_refresh_key
    order by job.created_at desc
    limit 1;
  end if;
  return v_job_id;
end;
$$;

create or replace function public.attach_full_article_pipeline_external_child(
  p_pipeline_job_id uuid,
  p_child_job_id uuid,
  p_child_kind text,
  p_worker_id text,
  p_lease_generation bigint
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline public.ai_external_analysis_jobs%rowtype;
  v_child public.ai_external_analysis_jobs%rowtype;
  v_progress_key text;
begin
  if p_child_kind not in ('semantic', 'brief', 'discovery', 'extraction', 'analysis') then
    raise exception 'Unsupported pipeline child kind.' using errcode = '22023';
  end if;
  select * into v_pipeline from public.ai_external_analysis_jobs
  where id = p_pipeline_job_id for update;
  select * into v_child from public.ai_external_analysis_jobs
  where id = p_child_job_id for update;
  if v_pipeline.id is null or v_pipeline.job_type <> 'full_article_pipeline'
     or v_pipeline.status <> 'running'
     or v_pipeline.locked_by is distinct from btrim(coalesce(p_worker_id, ''))
     or v_pipeline.lease_generation <> p_lease_generation
     or v_pipeline.cancel_requested_at is not null
     or v_pipeline.lease_expires_at is null
     or v_pipeline.lease_expires_at <= now() then
    return false;
  end if;
  if v_child.id is null or v_child.article_id <> v_pipeline.article_id then
    raise exception 'Pipeline child does not belong to the pipeline article.' using errcode = '22023';
  end if;
  update public.ai_external_analysis_jobs
  set pipeline_parent_job_id = v_pipeline.id,
      updated_at = now()
  where id = v_child.id;
  v_progress_key := p_child_kind || 'JobId';
  update public.ai_external_analysis_jobs
  set progress = coalesce(progress, '{}'::jsonb)
      || jsonb_build_object(v_progress_key, v_child.id, 'activeChildKind', p_child_kind, 'updatedAt', now()),
      updated_at = now()
  where id = v_pipeline.id;
  return true;
end;
$$;

create or replace function public.attach_full_article_pipeline_writing_session(
  p_pipeline_job_id uuid,
  p_session_id uuid,
  p_worker_id text,
  p_lease_generation bigint
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline public.ai_external_analysis_jobs%rowtype;
  v_session public.content_writing_sessions%rowtype;
begin
  select * into v_pipeline from public.ai_external_analysis_jobs
  where id = p_pipeline_job_id for update;
  select * into v_session from public.content_writing_sessions
  where id = p_session_id for update;
  if v_pipeline.id is null or v_pipeline.job_type <> 'full_article_pipeline'
     or v_pipeline.status <> 'running'
     or v_pipeline.locked_by is distinct from btrim(coalesce(p_worker_id, ''))
     or v_pipeline.lease_generation <> p_lease_generation
     or v_pipeline.cancel_requested_at is not null
     or v_pipeline.lease_expires_at is null
     or v_pipeline.lease_expires_at <= now() then
    return false;
  end if;
  if v_session.id is null or v_session.article_id <> v_pipeline.article_id then
    raise exception 'Writing session does not belong to the pipeline article.' using errcode = '22023';
  end if;
  update public.content_writing_sessions
  set pipeline_parent_job_id = v_pipeline.id,
      context_snapshot = coalesce(context_snapshot, '{}'::jsonb)
        || jsonb_build_object('fullArticlePipelineJobId', v_pipeline.id),
      updated_at = now()
  where id = v_session.id;
  update public.ai_external_analysis_jobs
  set progress = coalesce(progress, '{}'::jsonb) || jsonb_build_object(
        'contentWritingSessionId', v_session.id,
        'activeChildKind', 'content_writing',
        'updatedAt', now()
      ),
      updated_at = now()
  where id = v_pipeline.id;
  return true;
end;
$$;

create or replace function public.enqueue_full_article_pipeline_draft_analysis(
  p_pipeline_job_id uuid,
  p_requested_by uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_plain_text text,
  p_content_html text
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline public.ai_external_analysis_jobs%rowtype;
  v_article public.articles%rowtype;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_command_id text := 'smartAnalysis.competitorContentComparison';
  v_signature text;
  v_key text;
  v_draft_hash text;
begin
  select * into v_pipeline from public.ai_external_analysis_jobs
  where id = p_pipeline_job_id for update;
  if v_pipeline.id is null or v_pipeline.job_type <> 'full_article_pipeline'
     or v_pipeline.status <> 'running'
     or v_pipeline.locked_by is distinct from btrim(coalesce(p_worker_id, ''))
     or v_pipeline.lease_generation <> p_lease_generation
     or v_pipeline.cancel_requested_at is not null
     or v_pipeline.lease_expires_at is null
     or v_pipeline.lease_expires_at <= now() then
    raise exception 'Full article pipeline execution is no longer owned.' using errcode = '55000';
  end if;
  if public.article_access_level_for_user(v_pipeline.article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_plain_text, '')), '') is null then
    raise exception 'Generated draft text is required for analysis.' using errcode = '22023';
  end if;
  select * into v_article from public.articles where id = v_pipeline.article_id;
  v_draft_hash := md5(concat_ws(chr(31), coalesce(p_content_html, ''), p_plain_text));
  v_signature := 'pipeline-draft:' || v_draft_hash;
  v_key := 'full-pipeline-draft-analysis:' || v_pipeline.id::text || ':' || v_draft_hash;

  select * into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_pipeline.article_id
    and job.job_type = 'engineering_command'
    and job.command_id = v_command_id
    and job.readiness_signature = v_signature
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by case when job.status = 'completed' and job.result->>'status' = 'completed' then 0 else 1 end,
           job.created_at desc
  limit 1
  for update;

  if v_job.id is not null
     and v_job.status = 'completed'
     and v_job.result->>'status' = 'completed'
     and (nullif(v_job.result->>'analysisMarkdown', '') is not null
       or jsonb_array_length(coalesce(v_job.result->'patches', '[]'::jsonb)) > 0) then
    update public.ai_external_analysis_jobs
    set pipeline_parent_job_id = v_pipeline.id,
        depends_on_job_id = v_pipeline.id,
        updated_at = now()
    where id = v_job.id
    returning * into v_job;
    return v_job;
  end if;

  if v_job.id is not null and v_job.status = 'running'
     and coalesce((v_job.input_snapshot->>'pipelineLeaseGeneration')::bigint, -1) <> p_lease_generation then
    update public.ai_external_analysis_jobs
    set readiness_signature = v_signature || ':superseded:' || id::text,
        cancel_requested_at = coalesce(cancel_requested_at, now()),
        last_error_code = 'pipeline_parent_execution_superseded',
        last_error = 'The owning pipeline execution generation changed.',
        updated_at = now()
    where id = v_job.id;
    v_job.id := null;
  end if;

  if v_job.id is not null then
    update public.ai_external_analysis_jobs as job
    set requested_by = p_requested_by,
        origin = 'manual',
        status = case when job.status = 'running' then job.status else 'queued' end,
        pipeline_parent_job_id = v_pipeline.id,
        depends_on_job_id = v_pipeline.id,
        result = case when job.status = 'running' then job.result else null end,
        input_snapshot = jsonb_build_object(
          'title', v_article.title,
          'plainText', p_plain_text,
          'keywords', coalesce(v_article.keywords, '{}'::jsonb),
          'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
          'articleLanguage', v_article.article_language,
          'competitors', coalesce(v_article.metadata->'attachments'->'competitors', '{}'::jsonb),
          'pipelineJobId', v_pipeline.id,
          'pipelineLeaseGeneration', p_lease_generation,
          'pipelineDraft', jsonb_build_object(
            'plainText', p_plain_text,
            'contentHtml', coalesce(p_content_html, ''),
            'draftHash', v_draft_hash
          ),
          'commandSequence', 1,
          'commandTotal', 1,
          'commandId', v_command_id
        ),
        progress = case when job.status = 'running' then job.progress else jsonb_build_object(
          'stage', 'queued', 'source', 'full_article_pipeline_draft',
          'pipelineJobId', v_pipeline.id, 'updatedAt', now()
        ) end,
        last_error = case when job.status = 'running' then job.last_error else null end,
        last_error_code = case when job.status = 'running' then job.last_error_code else null end,
        next_attempt_at = case when job.status = 'running' then job.next_attempt_at else now() end,
        locked_by = case when job.status = 'running' then job.locked_by else null end,
        locked_at = case when job.status = 'running' then job.locked_at else null end,
        lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
        cancel_requested_at = case when job.status = 'running' then job.cancel_requested_at else null end,
        completed_at = case when job.status = 'running' then job.completed_at else null end,
        dead_lettered_at = case when job.status = 'running' then job.dead_lettered_at else null end,
        dead_letter_reason = case when job.status = 'running' then job.dead_letter_reason else null end,
        updated_at = now()
    where job.id = v_job.id
    returning job.* into v_job;
    return v_job;
  end if;

  insert into public.ai_external_analysis_jobs(
    article_id, requested_by, job_type, origin, status, idempotency_key,
    batch_key, sequence_number, command_id, command_label, depends_on_job_id,
    pipeline_parent_job_id, readiness_signature, input_snapshot, progress,
    next_attempt_at, max_attempts
  ) values (
    v_pipeline.article_id, p_requested_by, 'engineering_command', 'manual', 'queued',
    left(v_key, 240), 'full-pipeline-analysis:' || v_pipeline.id::text, 1,
    v_command_id, 'تحليل ومراجعة المسودة الشاملة', v_pipeline.id, v_pipeline.id,
    v_signature,
    jsonb_build_object(
      'title', v_article.title,
      'plainText', p_plain_text,
      'keywords', coalesce(v_article.keywords, '{}'::jsonb),
      'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
      'articleLanguage', v_article.article_language,
      'competitors', coalesce(v_article.metadata->'attachments'->'competitors', '{}'::jsonb),
      'pipelineJobId', v_pipeline.id,
      'pipelineLeaseGeneration', p_lease_generation,
      'pipelineDraft', jsonb_build_object(
        'plainText', p_plain_text,
        'contentHtml', coalesce(p_content_html, ''),
        'draftHash', v_draft_hash
      ),
      'commandSequence', 1, 'commandTotal', 1, 'commandId', v_command_id
    ),
    jsonb_build_object(
      'stage', 'queued', 'source', 'full_article_pipeline_draft',
      'pipelineJobId', v_pipeline.id, 'updatedAt', now()
    ),
    now(), 4
  ) returning * into v_job;
  return v_job;
end;
$$;

create or replace function public.persist_full_article_pipeline_draft_review(
  p_pipeline_job_id uuid,
  p_session_id uuid,
  p_analysis_job_id uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_markdown text,
  p_quality_report jsonb,
  p_review_metadata jsonb default '{}'::jsonb,
  p_content_json jsonb default null,
  p_content_html text default null,
  p_plain_text text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline public.ai_external_analysis_jobs%rowtype;
  v_session public.content_writing_sessions%rowtype;
  v_analysis public.ai_external_analysis_jobs%rowtype;
begin
  select * into v_pipeline from public.ai_external_analysis_jobs where id = p_pipeline_job_id for update;
  select * into v_session from public.content_writing_sessions where id = p_session_id for update;
  select * into v_analysis from public.ai_external_analysis_jobs where id = p_analysis_job_id;
  if v_pipeline.id is null or v_pipeline.job_type <> 'full_article_pipeline'
     or v_pipeline.status <> 'running'
     or v_pipeline.locked_by is distinct from btrim(coalesce(p_worker_id, ''))
     or v_pipeline.lease_generation <> p_lease_generation
     or v_pipeline.cancel_requested_at is not null
     or v_pipeline.lease_expires_at is null
     or v_pipeline.lease_expires_at <= now() then
    return false;
  end if;
  if v_session.id is null or v_session.article_id <> v_pipeline.article_id
     or v_session.pipeline_parent_job_id is distinct from v_pipeline.id
     or v_session.status <> 'completed' then
    raise exception 'Completed pipeline writing session was not found.' using errcode = '22023';
  end if;
  if v_analysis.id is null
     or v_analysis.pipeline_parent_job_id is distinct from v_pipeline.id
     or v_analysis.depends_on_job_id is distinct from v_pipeline.id
     or v_analysis.status <> 'completed'
     or v_analysis.result->>'status' is distinct from 'completed' then
    raise exception 'Completed pipeline draft analysis was not found.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_quality_report, '{}'::jsonb)) <> 'object' then
    raise exception 'Quality report must be a JSON object.' using errcode = '22023';
  end if;
  update public.content_writing_sessions as session
  set result_text = p_markdown,
      quality_report = p_quality_report,
      quality_score = case when jsonb_typeof(p_quality_report->'score') = 'number'
        then (p_quality_report->>'score')::numeric else session.quality_score end,
      response_metadata = coalesce(session.response_metadata, '{}'::jsonb) || jsonb_build_object(
        'fullArticlePipelineReview', coalesce(p_review_metadata, '{}'::jsonb)
          || jsonb_build_object(
            'pipelineJobId', v_pipeline.id,
            'analysisJobId', v_analysis.id,
            'reviewDraftHash', md5(coalesce(p_markdown, '')),
            'applicationContentHash', case
              when p_content_json is not null
                and jsonb_typeof(p_content_json) = 'object'
                and nullif(btrim(coalesce(p_plain_text, '')), '') is not null
              then public.full_article_pipeline_content_hash(
                p_content_json, p_content_html, p_plain_text
              )
              else null
            end,
            'reviewedAt', now()
          ),
        'qualityReport', p_quality_report
      ),
      progress = coalesce(session.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when p_quality_report->>'passed' = 'true' then 'review_passed' else 'review_required' end,
        'pipelineAnalysisJobId', v_analysis.id,
        'updatedAt', now()
      ),
      updated_at = now()
  where session.id = v_session.id;
  return true;
end;
$$;

-- Remove the legacy four-argument auto-apply entry point. Keeping it as an
-- overload would leave a service-role bypass around the new quality/CAS fence.
drop function if exists public.apply_full_article_pipeline_content(uuid, uuid, text, text);

create or replace function public.apply_full_article_pipeline_content(
  p_pipeline_job_id uuid,
  p_session_id uuid,
  p_analysis_job_id uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_baseline_save_count integer,
  p_baseline_content_hash text,
  p_reviewed_markdown text,
  p_content_json jsonb,
  p_content_html text,
  p_plain_text text,
  p_quality_report jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline public.ai_external_analysis_jobs%rowtype;
  v_session public.content_writing_sessions%rowtype;
  v_analysis public.ai_external_analysis_jobs%rowtype;
  v_article public.articles%rowtype;
  v_version integer;
  v_word_count integer;
  v_stats jsonb;
  v_metadata jsonb;
  v_current_hash text;
  v_baseline_save_count integer;
  v_baseline_content_hash text;
begin
  select * into v_pipeline from public.ai_external_analysis_jobs
  where id = p_pipeline_job_id for update;
  if v_pipeline.id is null or v_pipeline.job_type <> 'full_article_pipeline' then
    raise exception 'Full article pipeline was not found.' using errcode = 'P0002';
  end if;
  if v_pipeline.status <> 'running'
     or v_pipeline.locked_by is distinct from btrim(coalesce(p_worker_id, ''))
     or v_pipeline.lease_generation <> p_lease_generation
     or v_pipeline.cancel_requested_at is not null
     or v_pipeline.lease_expires_at is null
     or v_pipeline.lease_expires_at <= now() then
    raise exception 'Full article pipeline execution is fenced or cancelled.' using errcode = '55000';
  end if;
  if public.article_access_level_for_user(v_pipeline.article_id, v_pipeline.requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  v_baseline_save_count := case
    when coalesce(v_pipeline.input_snapshot->>'baselineSaveCount', '') ~ '^\d+$'
      then (v_pipeline.input_snapshot->>'baselineSaveCount')::integer
    else null
  end;
  v_baseline_content_hash := nullif(v_pipeline.input_snapshot->>'baselineContentHash', '');
  if v_baseline_save_count is null or v_baseline_content_hash is null
     or p_baseline_save_count is distinct from v_baseline_save_count
     or nullif(p_baseline_content_hash, '') is distinct from v_baseline_content_hash then
    raise exception 'The supplied baseline does not match the server-captured pipeline baseline.' using errcode = '22023';
  end if;
  select * into v_session from public.content_writing_sessions
  where id = p_session_id and article_id = v_pipeline.article_id for update;
  if v_session.id is null or v_session.status <> 'completed'
     or v_session.pipeline_parent_job_id is distinct from v_pipeline.id
     or nullif(btrim(coalesce(v_session.result_text, '')), '') is null then
    raise exception 'A completed content-writing result is required.' using errcode = '22023';
  end if;
  select * into v_analysis from public.ai_external_analysis_jobs
  where id = p_analysis_job_id for update;
  if v_analysis.id is null
     or v_analysis.pipeline_parent_job_id is distinct from v_pipeline.id
     or v_analysis.depends_on_job_id is distinct from v_pipeline.id
     or v_analysis.status <> 'completed'
     or v_analysis.result->>'status' is distinct from 'completed'
     or (nullif(v_analysis.result->>'analysisMarkdown', '') is null
       and jsonb_array_length(coalesce(v_analysis.result->'patches', '[]'::jsonb)) = 0) then
    raise exception 'A usable, non-superseded draft analysis is required.' using errcode = '22023';
  end if;
  if coalesce((p_quality_report->>'passed')::boolean, false) is not true
     or coalesce((p_quality_report->>'blockingFailureCount')::integer, 0) > 0 then
    raise exception 'The reviewed draft did not pass the quality gate.' using errcode = '22023';
  end if;
  if v_session.quality_report is distinct from p_quality_report
     or v_session.result_text is distinct from p_reviewed_markdown
     or v_session.response_metadata->'fullArticlePipelineReview'->>'pipelineJobId'
       is distinct from v_pipeline.id::text
     or v_session.response_metadata->'fullArticlePipelineReview'->>'analysisJobId'
       is distinct from v_analysis.id::text
     or v_session.response_metadata->'fullArticlePipelineReview'->>'reviewDraftHash'
       is distinct from md5(coalesce(p_reviewed_markdown, ''))
     or nullif(v_session.response_metadata->'fullArticlePipelineReview'->>'applicationContentHash', '')
       is distinct from public.full_article_pipeline_content_hash(
         p_content_json, p_content_html, p_plain_text
       ) then
    raise exception 'The application artifacts do not match the persisted reviewed draft.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_plain_text, '')), '') is null then
    raise exception 'Generated article text cannot be empty.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_content_json, '{}'::jsonb)) <> 'object'
     or p_content_json->>'type' is distinct from 'doc'
     or jsonb_typeof(p_content_json->'content') is distinct from 'array' then
    raise exception 'A valid TipTap JSON document is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_pipeline.article_id::text || ':full-article-pipeline-apply', 0));
  select * into v_article from public.articles where id = v_pipeline.article_id for update;
  if v_session.applied_at is not null
     and coalesce(v_article.metadata->'fullArticlePipeline'->>'jobId', '') = v_pipeline.id::text then
    return jsonb_build_object(
      'articleId', v_article.id, 'versionNumber', v_article.save_count,
      'alreadyApplied', true, 'appliedAt', v_session.applied_at
    );
  end if;
  v_current_hash := public.full_article_pipeline_content_hash(
    v_article.content_json, v_article.content_html, v_article.plain_text
  );
  -- save_count is an audit/version counter and may advance on a protected
  -- autosave that leaves the body byte-for-byte unchanged. The body hash is
  -- the actual compare-and-swap revision under this row lock.
  if v_current_hash is distinct from v_baseline_content_hash then
    raise exception 'Article content changed after the full pipeline baseline was captured.' using errcode = '40001';
  end if;

  select greatest(coalesce(v_article.save_count, 0) + 1,
    coalesce(max(version_number), 0) + 1)
  into v_version from public.article_versions where article_id = v_article.id;
  v_word_count := coalesce(array_length(regexp_split_to_array(btrim(p_plain_text), '\s+'), 1), 0);
  v_stats := coalesce(v_article.stats, '{}'::jsonb) || jsonb_build_object('wordCount', v_word_count);
  v_metadata := coalesce(v_article.metadata, '{}'::jsonb) || jsonb_build_object(
    'fullArticlePipeline', jsonb_build_object(
      'jobId', v_pipeline.id,
      'contentWritingSessionId', v_session.id,
      'analysisJobId', v_analysis.id,
      'qualityGatePolicy', 'review_required',
      'qualityGatePassed', true,
      'qualityScore', p_quality_report->'score',
      'baselineSaveCount', v_baseline_save_count,
      'baselineContentHash', v_baseline_content_hash,
      'appliedAt', now()
    )
  );

  update public.articles
  set content_json = p_content_json,
      content_html = nullif(p_content_html, ''),
      plain_text = p_plain_text,
      analysis = null,
      stats = v_stats,
      metadata = v_metadata,
      save_count = v_version,
      last_saved_at = now()
  where id = v_article.id
    and public.full_article_pipeline_content_hash(content_json, content_html, plain_text)
      = v_baseline_content_hash
  returning * into v_article;
  if v_article.id is null then
    raise exception 'Article content changed while the pipeline result was being applied.' using errcode = '40001';
  end if;

  insert into public.article_versions(
    article_id, version_number, created_by, title, content_json, content_html,
    plain_text, keywords, goal_context, analysis, stats, note
  ) values (
    v_article.id, v_version, v_pipeline.requested_by, v_article.title,
    v_article.content_json, v_article.content_html, v_article.plain_text,
    v_article.keywords, v_article.goal_context, null, v_article.stats,
    'full-article-pipeline-reviewed-apply'
  );

  update public.content_writing_sessions
  set applied_at = now(), applied_by = v_pipeline.requested_by,
      application_count = application_count + 1,
      quality_report = p_quality_report,
      quality_score = case when jsonb_typeof(p_quality_report->'score') = 'number'
        then (p_quality_report->>'score')::numeric else quality_score end,
      updated_at = now()
  where id = v_session.id;

  return jsonb_build_object(
    'articleId', v_article.id, 'versionNumber', v_version,
    'alreadyApplied', false, 'wordCount', v_word_count,
    'qualityGatePassed', true, 'qualityScore', p_quality_report->'score',
    'analysisJobId', v_analysis.id, 'appliedAt', now()
  );
end;
$$;

create or replace function public.block_external_analysis_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_progress jsonb default '{}'::jsonb
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_job public.ai_external_analysis_jobs%rowtype;
begin
  update public.ai_external_analysis_jobs as job
  set status = 'blocked', locked_by = null, locked_at = null, lease_expires_at = null,
      next_attempt_at = null,
      last_error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
      last_error = left(nullif(btrim(coalesce(p_error_message, '')), ''), 2000),
      completed_at = now(),
      progress = coalesce(job.progress, '{}'::jsonb) || coalesce(p_progress, '{}'::jsonb)
        || jsonb_build_object('stage', 'blocked', 'reviewRequired', true, 'updatedAt', now()),
      updated_at = now()
  where job.id = p_job_id and job.status = 'running'
    and job.locked_by = btrim(coalesce(p_worker_id, ''))
    and job.cancel_requested_at is null
  returning * into v_job;
  if v_job.id is null then
    raise exception 'running external analysis job was not found for this worker' using errcode = 'P0002';
  end if;
  update public.ai_external_analysis_runs
  set status = 'blocked', error_code = v_job.last_error_code,
      error_message = v_job.last_error,
      progress = coalesce(progress, '{}'::jsonb) || coalesce(p_progress, '{}'::jsonb),
      finished_at = now()
  where job_id = v_job.id and run_number = v_job.attempt_count and status = 'running';
  return v_job;
end;
$$;

create or replace function public.dead_letter_external_analysis_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_progress jsonb default '{}'::jsonb
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_job public.ai_external_analysis_jobs%rowtype;
begin
  update public.ai_external_analysis_jobs as job
  set status = 'blocked', locked_by = null, locked_at = null, lease_expires_at = null,
      next_attempt_at = null, dead_lettered_at = now(),
      dead_letter_reason = nullif(btrim(coalesce(p_error_code, '')), ''),
      last_error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
      last_error = left(nullif(btrim(coalesce(p_error_message, '')), ''), 2000),
      completed_at = now(),
      progress = coalesce(job.progress, '{}'::jsonb) || coalesce(p_progress, '{}'::jsonb)
        || jsonb_build_object('stage', 'dead_lettered', 'updatedAt', now()),
      updated_at = now()
  where job.id = p_job_id and job.status = 'running'
    and job.locked_by = btrim(coalesce(p_worker_id, ''))
  returning * into v_job;
  if v_job.id is null then
    raise exception 'running external analysis job was not found for this worker' using errcode = 'P0002';
  end if;
  if v_job.job_type = 'full_article_pipeline' then
    update public.ai_external_analysis_jobs as child
    set status = case when child.status = 'running' then child.status else 'cancelled' end,
        cancel_requested_at = coalesce(child.cancel_requested_at, now()),
        next_attempt_at = case when child.status = 'running' then child.next_attempt_at else null end,
        last_error_code = 'parent_pipeline_dead_lettered',
        last_error = 'The parent pipeline exhausted its retry budget.',
        completed_at = case when child.status = 'running' then child.completed_at else now() end,
        updated_at = now()
    where child.pipeline_parent_job_id = v_job.id
      and child.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');
    update public.content_writing_sessions as session
    set status = case when session.status = 'running' then session.status else 'cancelled' end,
        cancel_requested_at = coalesce(session.cancel_requested_at, now()),
        next_attempt_at = case when session.status = 'running' then session.next_attempt_at else null end,
        last_error_code = 'parent_pipeline_dead_lettered',
        last_error = 'The parent pipeline exhausted its retry budget.',
        completed_at = case when session.status = 'running' then session.completed_at else now() end,
        updated_at = now()
    where session.pipeline_parent_job_id = v_job.id
      and session.status in ('queued', 'running', 'retry_scheduled');
  end if;
  update public.ai_external_analysis_runs
  set status = 'blocked', error_code = v_job.last_error_code,
      error_message = v_job.last_error,
      progress = coalesce(progress, '{}'::jsonb) || coalesce(p_progress, '{}'::jsonb),
      finished_at = now()
  where job_id = v_job.id and run_number = v_job.attempt_count and status = 'running';
  return v_job;
end;
$$;

create or replace function public.resume_full_article_pipeline_job(
  p_job_id uuid,
  p_requested_by uuid
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_external_analysis_jobs%rowtype;
  v_resume_code text;
  v_target_id uuid;
  v_content_writing_session_id uuid;
  v_resume_target_id uuid;
begin
  select * into v_job from public.ai_external_analysis_jobs
  where id = p_job_id for update;
  if v_job.id is null or v_job.job_type <> 'full_article_pipeline' then
    raise exception 'Full article pipeline was not found.' using errcode = 'P0002';
  end if;
  if public.article_access_level_for_user(v_job.article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if v_job.status in ('completed', 'running', 'queued', 'waiting_for_prerequisites', 'paused') then return v_job; end if;
  if v_job.last_error_code in (
    'full_pipeline_quality_review_required',
    'full_pipeline_external_review_blocked',
    'full_pipeline_link_preservation_review_required',
    'full_pipeline_article_changed'
  ) then
    raise exception 'This pipeline requires explicit draft review instead of retry.' using errcode = '55000';
  end if;
  if v_job.status not in ('failed', 'blocked', 'cancelled', 'retry_scheduled') then
    raise exception 'Full article pipeline cannot be resumed from status %.', v_job.status using errcode = '22023';
  end if;
  v_resume_code := coalesce(v_job.last_error_code, v_job.progress->>'retryReason', 'manual_resume');
  begin
    v_target_id := nullif(v_job.progress->>'childJobId', '')::uuid;
  exception when invalid_text_representation then v_target_id := null;
  end;
  begin
    v_content_writing_session_id := nullif(
      v_job.progress->>'contentWritingSessionId',
      ''
    )::uuid;
  exception when invalid_text_representation then v_content_writing_session_id := null;
  end;
  select session.id into v_content_writing_session_id
  from public.content_writing_sessions as session
  where session.id = v_content_writing_session_id
    and session.article_id = v_job.article_id
    and session.pipeline_parent_job_id = v_job.id
    and session.status <> 'completed';
  v_resume_target_id := coalesce(v_content_writing_session_id, v_target_id);
  if v_target_id is not null then
    update public.ai_external_analysis_jobs as child
    set status = 'queued', result = null, next_attempt_at = now(),
        locked_by = null, locked_at = null, lease_expires_at = null,
        cancel_requested_at = null, completed_at = null,
        dead_lettered_at = null, dead_letter_reason = null,
        max_attempts = greatest(child.max_attempts, child.attempt_count + 3),
        last_error = null, last_error_code = null,
        progress = coalesce(child.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'queued', 'source', 'full_pipeline_parent_resume',
          'pipelineJobId', v_job.id, 'updatedAt', now()
        ),
        updated_at = now()
    where child.id = v_target_id
      and child.article_id = v_job.article_id
      and child.status in ('failed', 'blocked', 'cancelled', 'retry_scheduled');
  end if;
  update public.ai_external_analysis_jobs as job
  set requested_by = p_requested_by, status = 'queued', result = null,
      next_attempt_at = now(), locked_by = null, locked_at = null,
      lease_expires_at = null, cancel_requested_at = null, completed_at = null,
      dead_lettered_at = null, dead_letter_reason = null,
      max_attempts = greatest(job.max_attempts, job.attempt_count + 3),
      last_error = null, last_error_code = null,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'queued', 'source', 'manual_pipeline_resume',
        'resumeReason', v_resume_code,
        'resumeTargetId', v_resume_target_id,
        'resumeRequestedAt', now(),
        'updatedAt', now()
      ),
      updated_at = now()
  where job.id = v_job.id returning * into v_job;
  return v_job;
end;
$$;

create or replace function public.request_full_article_pipeline_cancel(
  p_job_id uuid,
  p_requested_by uuid
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_external_analysis_jobs%rowtype;
  v_session record;
begin
  select * into v_job from public.ai_external_analysis_jobs
  where id = p_job_id and job_type = 'full_article_pipeline';
  if v_job.id is null then raise exception 'Full article pipeline was not found.' using errcode = 'P0002'; end if;
  if public.article_access_level_for_user(v_job.article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  perform public.request_external_analysis_job_cancel(v_job.id, p_requested_by);
  for v_session in
    select id from public.content_writing_sessions
    where pipeline_parent_job_id = v_job.id
      and status in ('queued', 'running', 'retry_scheduled')
  loop
    perform public.request_content_writing_session_cancel(v_session.id, p_requested_by);
  end loop;
  update public.ai_external_analysis_jobs as child
  set status = case when child.status = 'running' then child.status else 'cancelled' end,
      cancel_requested_at = coalesce(child.cancel_requested_at, now()),
      next_attempt_at = case when child.status = 'running' then child.next_attempt_at else null end,
      last_error_code = 'cancelled_by_user',
      last_error = 'The parent full article pipeline was cancelled.',
      completed_at = case when child.status = 'running' then child.completed_at else now() end,
      progress = coalesce(child.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when child.status = 'running' then 'cancel_requested' else 'cancelled' end,
        'reason', 'parent_pipeline_cancelled', 'updatedAt', now()
      ),
      updated_at = now()
  where child.pipeline_parent_job_id = v_job.id
    and child.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');
  select * into v_job from public.ai_external_analysis_jobs where id = p_job_id;
  return v_job;
end;
$$;

-- Replace the five-argument wrapper from the previous migration. The extra
-- expected timestamp is a server-issued revision token. Auto/lifecycle
-- saves must still target that exact revision after acquiring the row lock.
drop function if exists public.save_article_snapshot_with_content_policy(
  uuid, text, jsonb, text, boolean
);

create or replace function public.save_article_snapshot_with_content_policy(
  p_article_id uuid,
  p_idempotency_key text,
  p_snapshot jsonb,
  p_save_reason text default 'manual',
  p_allow_empty_body boolean default false,
  p_expected_last_saved_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_snapshot jsonb := p_snapshot;
  v_article public.articles%rowtype;
  v_keywords jsonb;
  v_goal_context jsonb;
begin
  if v_snapshot is null or jsonb_typeof(v_snapshot) <> 'object' then
    raise exception 'Article snapshot must be a JSON object.' using errcode = '22023';
  end if;

  -- The lock and merge live in the same transaction as save_article_snapshot.
  -- This closes the API SELECT -> RPC race with semantic/brief worker writes.
  if p_article_id is not null and p_save_reason in ('auto', 'lifecycle') then
    select * into v_article
    from public.articles
    where id = p_article_id
      and public.article_access_level_for_user(id, auth.uid()) in ('write', 'admin')
    for update;
    if v_article.id is not null then
      -- A request can be serialized before a pipeline/manual save acquires the
      -- row lock. Equality with the current server revision closes that race and
      -- also fences old browser bundles that do not send a revision token.
      if p_expected_last_saved_at is null
         or v_article.last_saved_at is distinct from p_expected_last_saved_at then
        return jsonb_build_object(
          'article', to_jsonb(v_article),
          'versionNumber', v_article.save_count,
          'replayed', false,
          'staleBackgroundSave', true,
          'staleReason', 'article_revision_changed_since_editor_load'
        );
      end if;

      v_keywords := case when jsonb_typeof(v_snapshot->'keywords') = 'object'
        then v_snapshot->'keywords' else '{}'::jsonb end;
      if jsonb_array_length(case when jsonb_typeof(v_keywords->'secondaries') = 'array'
          then v_keywords->'secondaries' else '[]'::jsonb end) = 0
         and jsonb_array_length(case when jsonb_typeof(v_article.keywords->'secondaries') = 'array'
          then v_article.keywords->'secondaries' else '[]'::jsonb end) > 0 then
        v_keywords := jsonb_set(v_keywords, '{secondaries}', v_article.keywords->'secondaries', true);
      end if;
      if jsonb_array_length(case when jsonb_typeof(v_keywords->'lsi') = 'array'
          then v_keywords->'lsi' else '[]'::jsonb end) = 0
         and jsonb_array_length(case when jsonb_typeof(v_article.keywords->'lsi') = 'array'
          then v_article.keywords->'lsi' else '[]'::jsonb end) > 0 then
        v_keywords := jsonb_set(v_keywords, '{lsi}', v_article.keywords->'lsi', true);
      end if;
      v_snapshot := jsonb_set(v_snapshot, '{keywords}', v_keywords, true);

      v_goal_context := case when jsonb_typeof(v_snapshot->'goalContext') = 'object'
        then v_snapshot->'goalContext' else '{}'::jsonb end;
      if nullif(btrim(coalesce(v_goal_context->>'generatedBrief', '')), '') is null
         and nullif(btrim(coalesce(v_article.goal_context->>'generatedBrief', '')), '') is not null then
        v_goal_context := jsonb_set(
          v_goal_context,
          '{generatedBrief}',
          to_jsonb(v_article.goal_context->>'generatedBrief'),
          true
        );
      end if;
      v_snapshot := jsonb_set(v_snapshot, '{goalContext}', v_goal_context, true);
    end if;
  end if;

  if coalesce(p_allow_empty_body, false) then
    if p_article_id is null then
      raise exception 'Only an existing article body can be explicitly cleared.' using errcode = '22023';
    end if;
    if public.article_body_has_content(
      v_snapshot->'content', v_snapshot->>'contentHtml', v_snapshot->>'plainText'
    ) then
      raise exception 'An explicit body clear must contain an empty article body.' using errcode = '22023';
    end if;
    perform set_config('app.allow_empty_article_body', 'on', true);
  end if;

  return public.save_article_snapshot(
    p_article_id, p_idempotency_key, v_snapshot, p_save_reason
  );
end;
$$;

revoke all on function public.full_article_pipeline_content_hash(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.claim_next_external_analysis_job(text, text[], integer) from public, anon, authenticated;
revoke all on function public.enqueue_full_article_pipeline(uuid, uuid, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.enqueue_full_article_pipeline_competitor_discovery(uuid, uuid, text, bigint, boolean) from public, anon, authenticated;
revoke all on function public.attach_full_article_pipeline_external_child(uuid, uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.attach_full_article_pipeline_writing_session(uuid, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.enqueue_full_article_pipeline_draft_analysis(uuid, uuid, text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.persist_full_article_pipeline_draft_review(uuid, uuid, uuid, text, bigint, text, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.apply_full_article_pipeline_content(uuid, uuid, uuid, text, bigint, integer, text, text, jsonb, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.block_external_analysis_job(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.dead_letter_external_analysis_job(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.resume_full_article_pipeline_job(uuid, uuid) from public, anon, authenticated;
revoke all on function public.request_full_article_pipeline_cancel(uuid, uuid) from public, anon, authenticated;
revoke all on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean, timestamptz) from public, anon;

grant execute on function public.full_article_pipeline_content_hash(jsonb, text, text) to service_role;
grant execute on function public.claim_next_external_analysis_job(text, text[], integer) to service_role;
grant execute on function public.enqueue_full_article_pipeline(uuid, uuid, text, text, integer, text) to service_role;
grant execute on function public.enqueue_full_article_pipeline_competitor_discovery(uuid, uuid, text, bigint, boolean) to service_role;
grant execute on function public.attach_full_article_pipeline_external_child(uuid, uuid, text, text, bigint) to service_role;
grant execute on function public.attach_full_article_pipeline_writing_session(uuid, uuid, text, bigint) to service_role;
grant execute on function public.enqueue_full_article_pipeline_draft_analysis(uuid, uuid, text, bigint, text, text) to service_role;
grant execute on function public.persist_full_article_pipeline_draft_review(uuid, uuid, uuid, text, bigint, text, jsonb, jsonb, jsonb, text, text) to service_role;
grant execute on function public.apply_full_article_pipeline_content(uuid, uuid, uuid, text, bigint, integer, text, text, jsonb, text, text, jsonb) to service_role;
grant execute on function public.block_external_analysis_job(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.dead_letter_external_analysis_job(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.resume_full_article_pipeline_job(uuid, uuid) to service_role;
grant execute on function public.request_full_article_pipeline_cancel(uuid, uuid) to service_role;
grant execute on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean, timestamptz) to authenticated;

comment on function public.apply_full_article_pipeline_content(uuid, uuid, uuid, text, bigint, integer, text, text, jsonb, text, text, jsonb)
is 'Atomically applies only a reviewed, quality-passing draft while fencing stale workers and comparing the original article baseline.';
comment on function public.resume_full_article_pipeline_job(uuid, uuid)
is 'Resumes a pipeline and its durable failed child without relying on a last_error_code that generic resume clears.';
comment on column public.ai_external_analysis_jobs.lease_generation
is 'Monotonic fencing generation incremented for every worker claim.';
comment on column public.ai_external_analysis_jobs.pipeline_parent_job_id
is 'Durable ownership link from any pipeline child to its full-article parent.';
comment on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean, timestamptz)
is 'Atomically preserves worker-generated fields and fences background snapshots unless they target the exact current server revision; manual saves remain authoritative.';

notify pgrst, 'reload schema';

commit;
