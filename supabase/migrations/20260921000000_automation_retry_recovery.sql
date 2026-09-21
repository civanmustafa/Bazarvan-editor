begin;

-- Classify only genuinely transient failures for delayed recovery. Missing
-- inputs, policy decisions, invalid output and quality-review outcomes must
-- wait for a state change or an explicit user action instead of looping.
create or replace function public.automation_failure_is_retryable(
  p_error_code text,
  p_error_message text
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  with normalized as (
    select lower(concat_ws(' ', coalesce(p_error_code, ''), coalesce(p_error_message, ''))) as value
  )
  select case
    when value ~ '(prerequisite|missing input|no valid competitor|no suitable competitor|quality.review|required review|unsupported|invalid regular expression|invalid output|identity.mismatch|automation.disabled|cancel|article.changed|manual attention)' then false
    when value ~ '(http[^0-9]*(408|425|429|500|502|503|504)|(^|[^0-9])(408|425|429|500|502|503|504)([^0-9]|$)|quota|rate.?limit|cooldown|temporar|timeout|timed.?out|network|connection|econn|socket|service unavailable|provider unavailable|worker.shutdown|worker.lease.expired|key availability|resource exhausted)' then true
    else false
  end
  from normalized;
$$;

alter table public.content_writing_automation_items
  add column if not exists failure_class text,
  add column if not exists recovery_count integer not null default 0,
  add column if not exists next_recovery_at timestamptz;

alter table public.content_writing_automation_items
  drop constraint if exists content_writing_automation_items_failure_class_check;
alter table public.content_writing_automation_items
  add constraint content_writing_automation_items_failure_class_check
  check (failure_class is null or failure_class in ('transient', 'waiting_input', 'terminal'));

alter table public.content_writing_automation_items
  drop constraint if exists content_writing_automation_items_recovery_count_check;
alter table public.content_writing_automation_items
  add constraint content_writing_automation_items_recovery_count_check
  check (recovery_count >= 0);

create index if not exists content_writing_automation_items_recovery_due_idx
  on public.content_writing_automation_items(next_recovery_at, updated_at)
  where status = 'blocked' and failure_class = 'transient';

create or replace function public.classify_content_writing_automation_failure()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delay interval;
begin
  if new.status = 'blocked' then
    if public.automation_failure_is_retryable(new.last_error_code, new.last_error) then
      new.failure_class := 'transient';
      v_delay := case least(greatest(coalesce(new.recovery_count, 0), 0), 2)
        when 0 then interval '1 hour'
        when 1 then interval '6 hours'
        else interval '24 hours'
      end;
      new.next_recovery_at := coalesce(new.next_recovery_at, now() + v_delay);
    elsif coalesce(new.last_error_code, '') = 'content_writing_prerequisites_missing' then
      new.failure_class := 'waiting_input';
      new.next_recovery_at := null;
    else
      new.failure_class := 'terminal';
      new.next_recovery_at := null;
    end if;
  elsif new.status in ('ready', 'claiming', 'writing', 'completed', 'cancelled') then
    new.failure_class := null;
    new.next_recovery_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists classify_content_writing_automation_failure
  on public.content_writing_automation_items;
create trigger classify_content_writing_automation_failure
before insert or update of status, last_error_code, last_error, recovery_count
on public.content_writing_automation_items
for each row execute function public.classify_content_writing_automation_failure();

-- Existing terminal items gain the same classification without immediately
-- spending provider quota during the migration window.
update public.content_writing_automation_items as item
set
  failure_class = case
    when public.automation_failure_is_retryable(item.last_error_code, item.last_error) then 'transient'
    when coalesce(item.last_error_code, '') = 'content_writing_prerequisites_missing' then 'waiting_input'
    else 'terminal'
  end,
  next_recovery_at = case
    when public.automation_failure_is_retryable(item.last_error_code, item.last_error)
      then now() + interval '15 minutes'
    else null
  end
where item.status = 'blocked';

-- Keep old ready/blocked items aligned with the administrator's current retry
-- budget. This does not consume an attempt or make an unready article claimable.
with configured as (
  select greatest(1, least(
    case
      when coalesce(setting.value->>'contentWritingAutomationMaxAttempts', '') ~ '^\d+$'
        then (setting.value->>'contentWritingAutomationMaxAttempts')::integer
      else 3
    end,
    10
  )) as max_attempts
  from public.app_settings as setting
  where setting.key = 'ai'
)
update public.content_writing_automation_items as item
set max_attempts = greatest(item.max_attempts, configured.max_attempts)
from configured
where item.status in ('ready', 'blocked');

create or replace function public.recover_due_content_writing_automation_items(
  p_max_attempts integer default 3,
  p_limit integer default 5
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  with due as (
    select item.id
    from public.content_writing_automation_items as item
    where item.status = 'blocked'
      and item.failure_class = 'transient'
      and item.recovery_count < 3
      and item.next_recovery_at is not null
      and item.next_recovery_at <= now()
      and public.article_automatic_job_allowed(item.article_id, 'content_writing')
    order by item.next_recovery_at, item.updated_at, item.id
    limit greatest(1, least(coalesce(p_limit, 5), 25))
    for update skip locked
  ), recovered as (
    update public.content_writing_automation_items as item
    set
      status = 'ready',
      content_writing_session_id = null,
      run_generation = item.run_generation + 1,
      session_sequence = 1,
      attempt_count = 0,
      max_attempts = greatest(1, least(coalesce(p_max_attempts, 3), 10)),
      ready_at = now(),
      eligible_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      last_error_code = null,
      last_error = null,
      started_at = null,
      completed_at = null,
      recovery_count = item.recovery_count + 1,
      failure_class = null,
      next_recovery_at = null,
      updated_at = now()
    from due
    where item.id = due.id
    returning item.id
  )
  select count(*)::integer into v_count from recovered;

  if v_count > 0 then
    insert into public.worker_queue_signals(queue_name) values ('content_writing');
  end if;
  return coalesce(v_count, 0);
end;
$$;

-- Automatic jobs get one initial execution plus five ordinary retries. The
-- once-per-article rule still means one durable job, not one network attempt.
create or replace function public.ensure_automatic_external_analysis_retry_budget()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.origin = 'auto'
    and new.cancel_requested_at is null
    and new.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused') then
    new.max_attempts := greatest(coalesce(new.max_attempts, 1), coalesce(new.attempt_count, 0) + 1, 6);
  end if;
  return new;
end;
$$;

drop trigger if exists ensure_automatic_external_analysis_retry_budget
  on public.ai_external_analysis_jobs;
create trigger ensure_automatic_external_analysis_retry_budget
before insert or update of origin, status, attempt_count, max_attempts, cancel_requested_at
on public.ai_external_analysis_jobs
for each row execute function public.ensure_automatic_external_analysis_retry_budget();

-- A terminal automatic preparation with the same deterministic readiness
-- signature is evidence of an already-spent cycle. Suppress duplicate rows;
-- explicit/manual requests remain able to retry after the user reviews them.
create or replace function public.prevent_duplicate_automatic_writing_preparation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.job_type = 'content_writing_preparation'
    and new.origin = 'auto'
    and exists (
      select 1
      from public.ai_external_analysis_jobs as previous
      where previous.article_id = new.article_id
        and previous.job_type = 'content_writing_preparation'
        and previous.origin = 'auto'
        and previous.readiness_signature is not distinct from new.readiness_signature
        and (
          previous.status in ('completed', 'failed', 'blocked')
          or (previous.status = 'cancelled' and (previous.attempt_count > 0 or previous.started_at is not null))
        )
        and previous.last_error_code is distinct from 'duplicate_preparation_suppressed'
    ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_duplicate_automatic_writing_preparation
  on public.ai_external_analysis_jobs;
create trigger prevent_duplicate_automatic_writing_preparation
before insert on public.ai_external_analysis_jobs
for each row execute function public.prevent_duplicate_automatic_writing_preparation();

-- Backfill articles whose readiness row was lost or never created. Restricting
-- this to missing rows avoids deployment-wide state updates and mass requeues.
insert into public.ai_external_analysis_article_state (
  article_id,
  semantic_ready,
  external_analysis_ready,
  semantic_missing_fields,
  external_analysis_missing_fields,
  semantic_readiness_signature,
  external_analysis_readiness_signature,
  competitor_discovery_ready,
  competitor_discovery_missing_fields,
  competitor_discovery_signature,
  last_article_updated_at,
  last_evaluated_at
)
select
  article.id,
  coalesce((external_ready.value #>> '{semantic,ready}')::boolean, false),
  coalesce((external_ready.value #>> '{externalAnalysis,ready}')::boolean, false),
  coalesce(external_ready.value #> '{semantic,missingFields}', '[]'::jsonb),
  coalesce(external_ready.value #> '{externalAnalysis,missingFields}', '[]'::jsonb),
  coalesce(external_ready.value #>> '{semantic,signature}', ''),
  coalesce(external_ready.value #>> '{externalAnalysis,signature}', ''),
  coalesce((competitor_ready.value->>'ready')::boolean, false),
  coalesce(competitor_ready.value->'missingFields', '[]'::jsonb),
  coalesce(competitor_ready.value->>'signature', ''),
  article.updated_at,
  now()
from public.articles as article
cross join lateral (
  select public.evaluate_external_analysis_readiness(
    article.status,
    article.title,
    article.plain_text,
    article.keywords,
    article.goal_context,
    article.metadata
  ) as value
) as external_ready
cross join lateral (
  select public.evaluate_competitor_discovery_readiness(
    article.status,
    article.title,
    article.keywords,
    article.goal_context,
    article.article_language
  ) as value
) as competitor_ready
where not exists (
  select 1 from public.ai_external_analysis_article_state as state
  where state.article_id = article.id
);

-- If a missing state row was the only reason for the last preparation cycle,
-- revive that durable row once now that the state is present. Older duplicate
-- history remains immutable and is not deleted.
with recoverable as (
  select distinct on (job.article_id) job.id
  from public.ai_external_analysis_jobs as job
  join public.ai_external_analysis_article_state as state
    on state.article_id = job.article_id
  where job.job_type = 'content_writing_preparation'
    and job.origin = 'auto'
    and job.status = 'blocked'
    and state.competitor_discovery_ready is true
    and lower(coalesce(job.last_error, '')) like '%competitor discovery prerequisites are incomplete%'
    and public.article_automatic_job_allowed(job.article_id, 'content_writing_preparation')
    and not exists (
      select 1 from public.ai_external_analysis_jobs as active
      where active.article_id = job.article_id
        and active.job_type = 'content_writing_preparation'
        and active.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    )
  order by job.article_id, job.created_at desc
)
update public.ai_external_analysis_jobs as job
set
  status = 'queued',
  retry_count = 0,
  max_attempts = greatest(job.max_attempts, job.attempt_count + 6),
  next_attempt_at = now(),
  locked_by = null,
  locked_at = null,
  lease_expires_at = null,
  cancel_requested_at = null,
  completed_at = null,
  dead_lettered_at = null,
  dead_letter_reason = null,
  last_error_code = null,
  last_error = null,
  progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
    'stage', 'queued',
    'source', 'readiness_state_backfill_recovery',
    'updatedAt', now()
  ),
  updated_at = now()
from recoverable
where job.id = recoverable.id;

-- Fair producer: articles which already exhausted preparation for the same
-- readiness signature are skipped until their inputs change. This prevents
-- one old article from monopolising the single preparation worker.
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
    and public.article_automatic_job_allowed(job.article_id, 'content_writing_preparation')
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  order by job.created_at
  limit 1;
  if v_job.id is not null then return v_job; end if;

  select article.id
  into v_article_id
  from public.articles as article
  join public.ai_external_analysis_article_state as research_state
    on research_state.article_id = article.id
   and research_state.competitor_discovery_ready is true
   and nullif(research_state.competitor_discovery_signature, '') is not null
  left join public.content_writing_automation_items as existing
    on existing.article_id = article.id
  cross join lateral (
    select public.evaluate_content_writing_automation_readiness(article.id) as value
  ) as readiness
  where article.status in ('content_preparation', 'draft')
    and public.article_automatic_job_allowed(article.id, 'content_writing_preparation')
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
    and not exists (
      select 1
      from public.ai_external_analysis_jobs as terminal_preparation
      where terminal_preparation.article_id = article.id
        and terminal_preparation.job_type = 'content_writing_preparation'
        and terminal_preparation.origin = 'auto'
        and (
          terminal_preparation.status in ('completed', 'failed', 'blocked')
          or (
            terminal_preparation.status = 'cancelled'
            and (terminal_preparation.attempt_count > 0 or terminal_preparation.started_at is not null)
          )
        )
        and terminal_preparation.last_error_code is distinct from 'duplicate_preparation_suppressed'
        and terminal_preparation.readiness_signature = md5(jsonb_build_object(
          'articleId', article.id,
          'readinessSignature', coalesce(readiness.value ->> 'signature', ''),
          'minimumCompetitorCount', v_min_competitors
        )::text)
    )
  order by coalesce(existing.eligible_at, existing.ready_at, article.updated_at, article.created_at), article.id
  limit 1
  for update of article skip locked;

  if v_article_id is null then return null; end if;

  select profile.id
  into v_requested_by
  from public.articles as article
  join public.profiles as profile
    on ((article.automation_policy_version = 1 and profile.id = article.automation_creator_id)
      or (article.automation_policy_version = 0 and profile.id in (article.assigned_to, article.owner_id, article.created_by)))
  where article.id = v_article_id
    and profile.is_active is true
    and public.article_access_level_for_user(article.id, profile.id) in ('write', 'admin')
  order by case profile.id
    when article.assigned_to then 1
    when article.owner_id then 2
    else 3
  end
  limit 1;

  if v_requested_by is null and (public.article_automation_policy(v_article_id)->>'policyVersion')::integer = 0 then
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

-- Existing workers already call this recovery RPC every minute. Extend it to
-- revive bounded transient dead letters after 1h, 6h and 24h, while retaining
-- the original stale-lease recovery behaviour.
create or replace function public.recover_stale_external_analysis_jobs(
  p_retry_delay_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_retry_minutes integer := public.get_external_analysis_retry_minutes(p_retry_delay_minutes);
  v_stale_count integer := 0;
  v_delayed_count integer := 0;
begin
  with recovered as (
    update public.ai_external_analysis_jobs as job
    set
      status = case when job.cancel_requested_at is not null then 'cancelled' else 'retry_scheduled' end,
      retry_count = job.retry_count + case when job.cancel_requested_at is null then 1 else 0 end,
      next_attempt_at = case
        when job.cancel_requested_at is not null then null
        else now() + make_interval(mins => v_retry_minutes)
      end,
      max_attempts = case
        when job.cancel_requested_at is null then greatest(job.max_attempts, job.attempt_count + 1)
        else job.max_attempts
      end,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      last_error_code = case when job.cancel_requested_at is not null then job.last_error_code else 'worker_lease_expired' end,
      last_error = case
        when job.cancel_requested_at is not null then job.last_error
        else 'The worker lease expired before the job reached a terminal state.'
      end,
      completed_at = case when job.cancel_requested_at is not null then now() else job.completed_at end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.cancel_requested_at is not null then 'cancelled' else 'retry_scheduled' end,
        'retryScheduledAt', case when job.cancel_requested_at is not null then null else now() end,
        'nextAttemptAt', case
          when job.cancel_requested_at is not null then null
          else to_jsonb(now() + make_interval(mins => v_retry_minutes))
        end,
        'retryDelayMinutes', case when job.cancel_requested_at is not null then null else v_retry_minutes end,
        'updatedAt', now()
      ),
      updated_at = now()
    where job.status = 'running'
      and job.lease_expires_at is not null
      and job.lease_expires_at <= now()
    returning job.id, job.status, job.last_error_code, job.last_error
  ), updated_runs as (
    update public.ai_external_analysis_runs as run
    set status = recovered.status,
        error_code = recovered.last_error_code,
        error_message = recovered.last_error,
        finished_at = now()
    from recovered
    where run.job_id = recovered.id and run.status = 'running'
    returning run.id
  )
  select count(*)::integer into v_stale_count from recovered;

  with due as (
    select job.id,
      case
        when coalesce(job.progress->>'automaticRecoveryCount', '') ~ '^\d+$'
          then greatest(0, (job.progress->>'automaticRecoveryCount')::integer)
        else 0
      end as recovery_count
    from public.ai_external_analysis_jobs as job
    left join lateral (
      select run.error_code, run.error_message
      from public.ai_external_analysis_runs as run
      where run.job_id = job.id
      order by run.run_number desc
      limit 1
    ) as latest_run on true
    where job.origin = 'auto'
      and job.status in ('failed', 'blocked')
      and job.cancel_requested_at is null
      and job.job_type <> 'full_article_pipeline'
      and case
        when coalesce(job.progress->>'automaticRecoveryCount', '') ~ '^\d+$'
          then greatest(0, (job.progress->>'automaticRecoveryCount')::integer)
        else 0
      end < 3
      and public.article_automatic_job_allowed(job.article_id, job.job_type, job.command_id)
      and public.automation_failure_is_retryable(
        coalesce(latest_run.error_code, job.last_error_code),
        coalesce(latest_run.error_message, job.last_error)
      )
      and coalesce(job.completed_at, job.updated_at) + case (case
        when coalesce(job.progress->>'automaticRecoveryCount', '') ~ '^\d+$'
          then greatest(0, (job.progress->>'automaticRecoveryCount')::integer)
        else 0
      end)
        when 0 then interval '1 hour'
        when 1 then interval '6 hours'
        else interval '24 hours'
      end <= now()
      and not exists (
        select 1 from public.ai_external_analysis_jobs as active
        where active.article_id = job.article_id
          and active.job_type = job.job_type
          and active.id <> job.id
          and active.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      )
    order by coalesce(job.completed_at, job.updated_at), job.id
    limit 10
    for update of job skip locked
  ), recovered as (
    update public.ai_external_analysis_jobs as job
    set
      status = 'retry_scheduled',
      retry_count = 0,
      max_attempts = greatest(job.max_attempts, job.attempt_count + 6),
      next_attempt_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      completed_at = null,
      dead_lettered_at = null,
      dead_letter_reason = null,
      last_error_code = null,
      last_error = null,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'retry_scheduled',
        'automaticRecoveryCount', due.recovery_count + 1,
        'automaticRecoveryAt', now(),
        'nextAttemptAt', now(),
        'updatedAt', now()
      ),
      updated_at = now()
    from due
    where job.id = due.id
    returning job.id
  )
  select count(*)::integer into v_delayed_count from recovered;

  return coalesce(v_stale_count, 0) + coalesce(v_delayed_count, 0);
end;
$$;

-- Administrator recovery is explicit and limited to classified transient
-- failures. It cannot revive cancellations, quality-review blocks, missing
-- prerequisites or full-pipeline review states.
create or replace function public.requeue_recoverable_automation_failures(
  p_requested_by uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_external_count integer := 0;
  v_writing_count integer := 0;
  v_max_attempts integer := 3;
begin
  if not exists (
    select 1 from public.profiles as profile
    where profile.id = p_requested_by
      and profile.role = 'admin'::public.app_role
      and profile.is_active is true
  ) then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  select greatest(1, least(
    case
      when coalesce(setting.value->>'contentWritingAutomationMaxAttempts', '') ~ '^\d+$'
        then (setting.value->>'contentWritingAutomationMaxAttempts')::integer
      else 3
    end,
    10
  )) into v_max_attempts
  from public.app_settings as setting
  where setting.key = 'ai';
  v_max_attempts := coalesce(v_max_attempts, 3);

  with candidates as (
    select job.id
    from public.ai_external_analysis_jobs as job
    left join lateral (
      select run.error_code, run.error_message
      from public.ai_external_analysis_runs as run
      where run.job_id = job.id
      order by run.run_number desc
      limit 1
    ) as latest_run on true
    where job.status in ('failed', 'blocked')
      and job.cancel_requested_at is null
      and job.job_type <> 'full_article_pipeline'
      and public.automation_failure_is_retryable(
        coalesce(latest_run.error_code, job.last_error_code),
        coalesce(latest_run.error_message, job.last_error)
      )
      and (job.origin <> 'auto' or public.article_automatic_job_allowed(job.article_id, job.job_type, job.command_id))
      and not exists (
        select 1 from public.ai_external_analysis_jobs as active
        where active.article_id = job.article_id
          and active.job_type = job.job_type
          and active.id <> job.id
          and active.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      )
    order by coalesce(job.completed_at, job.updated_at), job.id
    limit v_limit
    for update of job skip locked
  ), recovered as (
    update public.ai_external_analysis_jobs as job
    set
      status = 'retry_scheduled',
      retry_count = 0,
      max_attempts = greatest(job.max_attempts, job.attempt_count + 6),
      next_attempt_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      cancel_requested_at = null,
      completed_at = null,
      dead_lettered_at = null,
      dead_letter_reason = null,
      last_error_code = null,
      last_error = null,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'retry_scheduled',
        'source', 'administrator_recoverable_requeue',
        'requeuedBy', p_requested_by,
        'requeuedAt', now(),
        'updatedAt', now()
      ),
      updated_at = now()
    from candidates
    where job.id = candidates.id
    returning job.id
  )
  select count(*)::integer into v_external_count from recovered;

  with candidates as (
    select item.id
    from public.content_writing_automation_items as item
    where item.status = 'blocked'
      and public.automation_failure_is_retryable(item.last_error_code, item.last_error)
      and public.article_automatic_job_allowed(item.article_id, 'content_writing')
    order by coalesce(item.completed_at, item.updated_at), item.id
    limit greatest(0, v_limit - v_external_count)
    for update skip locked
  ), recovered as (
    update public.content_writing_automation_items as item
    set
      status = 'ready',
      content_writing_session_id = null,
      run_generation = item.run_generation + 1,
      session_sequence = 1,
      attempt_count = 0,
      max_attempts = v_max_attempts,
      ready_at = now(),
      eligible_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      last_error_code = null,
      last_error = null,
      started_at = null,
      completed_at = null,
      recovery_count = item.recovery_count + 1,
      failure_class = null,
      next_recovery_at = null,
      updated_at = now()
    from candidates
    where item.id = candidates.id
    returning item.id
  )
  select count(*)::integer into v_writing_count from recovered;

  if v_external_count > 0 then
    insert into public.worker_queue_signals(queue_name) values ('external_analysis');
  end if;
  if v_writing_count > 0 then
    insert into public.worker_queue_signals(queue_name) values ('content_writing');
  end if;

  return jsonb_build_object(
    'externalAnalysis', coalesce(v_external_count, 0),
    'contentWriting', coalesce(v_writing_count, 0),
    'total', coalesce(v_external_count, 0) + coalesce(v_writing_count, 0)
  );
end;
$$;

revoke all on function public.automation_failure_is_retryable(text, text)
  from public, anon, authenticated;
revoke all on function public.recover_due_content_writing_automation_items(integer, integer)
  from public, anon, authenticated;
revoke all on function public.requeue_recoverable_automation_failures(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.recover_stale_external_analysis_jobs(integer)
  from public, anon, authenticated;

grant execute on function public.automation_failure_is_retryable(text, text) to service_role;
grant execute on function public.recover_due_content_writing_automation_items(integer, integer) to service_role;
grant execute on function public.requeue_recoverable_automation_failures(uuid, integer) to service_role;
grant execute on function public.recover_stale_external_analysis_jobs(integer) to service_role;

comment on function public.requeue_recoverable_automation_failures(uuid, integer) is
  'Administrator-only bounded requeue for transient automation failures; permanent and input-dependent failures remain terminal.';

notify pgrst, 'reload schema';
commit;
