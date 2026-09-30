begin;

-- Worker claims are an implementation detail: one claim can stop before any
-- provider request, can be cancelled, or can fan out over several API keys.
-- Keep a separate, bounded article-execution budget for Gemini work and a
-- separate automatic-recovery budget.  The legacy attempt_count remains only
-- the monotonic run number used by ai_external_analysis_runs.
alter table public.ai_external_analysis_jobs
  add column if not exists provider_attempt_count integer not null default 0,
  add column if not exists provider_attempt_limit integer not null default 6,
  add column if not exists recovery_cycle_count integer not null default 0,
  add column if not exists recovery_cycle_limit integer not null default 3;

alter table public.ai_external_analysis_jobs
  drop constraint if exists ai_external_analysis_jobs_provider_attempt_count_check,
  drop constraint if exists ai_external_analysis_jobs_provider_attempt_limit_check,
  drop constraint if exists ai_external_analysis_jobs_recovery_cycle_count_check,
  drop constraint if exists ai_external_analysis_jobs_recovery_cycle_limit_check;

alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_provider_attempt_count_check
    check (provider_attempt_count between 0 and 6),
  add constraint ai_external_analysis_jobs_provider_attempt_limit_check
    check (provider_attempt_limit = 6),
  add constraint ai_external_analysis_jobs_recovery_cycle_count_check
    check (recovery_cycle_count between 0 and 3),
  add constraint ai_external_analysis_jobs_recovery_cycle_limit_check
    check (recovery_cycle_limit = 3);

create or replace function public.external_analysis_uses_gemini_budget(
  p_job_type text
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_job_type, '') = any(array[
    'semantic_keywords_lsi',
    'content_brief_generation',
    'meta_description_generation',
    'full_article_pipeline',
    'content_writing_preparation',
    'engineering_command',
    'duplicate_cleanup'
  ]::text[]);
$$;

create or replace function public.external_analysis_run_spent_provider_attempt(
  p_progress jsonb,
  p_error_code text
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  with evidence as (
    select
      coalesce((p_progress->>'providerAttemptObserved')::boolean, false) as observed,
      coalesce((p_progress->>'providerBudgetVersion')::integer, 0) as budget_version,
      case
        when coalesce(p_progress #>> '{gemini,totalAttemptCount}', '') ~ '^\d+$'
          then (p_progress #>> '{gemini,totalAttemptCount}')::integer
        else 0
      end as request_count,
      lower(coalesce(p_progress #>> '{gemini,status}', '')) as provider_status,
      lower(coalesce(p_error_code, '')) as error_code
  )
  select (case when budget_version >= 1 then observed else request_count > 0 end)
    and provider_status <> '499'
    and error_code !~ '(499|cancel|worker_shutdown|ownership_lost)'
  from evidence;
$$;

-- Backfill the durable counters from run evidence.  A run counts once when it
-- reached Gemini at least once; the number of keys/models tried inside that run
-- does not inflate the six article-level executions.
with counts as (
  select job.id,
    least(6, count(*) filter (
      where public.external_analysis_run_spent_provider_attempt(run.progress, run.error_code)
    ))::integer as provider_count
  from public.ai_external_analysis_jobs as job
  left join public.ai_external_analysis_runs as run on run.job_id = job.id
  where public.external_analysis_uses_gemini_budget(job.job_type)
  group by job.id
)
update public.ai_external_analysis_jobs as job
set provider_attempt_count = counts.provider_count,
    provider_attempt_limit = 6,
    recovery_cycle_count = least(3, case
      when coalesce(job.progress->>'automaticRecoveryCount', '') ~ '^\d+$'
        then greatest(0, (job.progress->>'automaticRecoveryCount')::integer)
      else 0
    end),
    recovery_cycle_limit = 3,
    -- Terminal history no longer advertises a fictitious 12/18/24/30 ceiling.
    -- Active rows retain only the next worker-run slot they require.
    max_attempts = case
      when job.status in ('queued', 'running', 'retry_scheduled')
        and counts.provider_count < 6 then greatest(1, job.attempt_count + 1)
      else 6
    end,
    updated_at = now()
from counts
where job.id = counts.id;

create or replace function public.guard_external_analysis_attempt_budgets()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested_recovery integer := 0;
begin
  if not public.external_analysis_uses_gemini_budget(new.job_type) then
    return new;
  end if;

  new.provider_attempt_limit := 6;
  new.recovery_cycle_limit := 3;
  new.provider_attempt_count := least(6, greatest(0, coalesce(new.provider_attempt_count, 0)));

  if coalesce(new.progress->>'automaticRecoveryCount', '') ~ '^\d+$' then
    v_requested_recovery := (new.progress->>'automaticRecoveryCount')::integer;
  end if;
  if tg_op = 'UPDATE'
    and old.status in ('failed', 'blocked')
    and new.status = 'retry_scheduled' then
    v_requested_recovery := greatest(v_requested_recovery, old.recovery_cycle_count + 1);
  end if;
  new.recovery_cycle_count := least(3, greatest(
    coalesce(new.recovery_cycle_count, 0),
    v_requested_recovery
  ));
  new.progress := coalesce(new.progress, '{}'::jsonb) || jsonb_build_object(
    'providerBudgetVersion', 1,
    'automaticRecoveryCount', new.recovery_cycle_count,
    'providerAttemptCount', new.provider_attempt_count,
    'providerAttemptLimit', 6
  );

  -- The legacy maximum is only a claim/run-number fence.  A retry opens one
  -- worker slot; it is never expanded by another six attempts.
  if new.status = 'retry_scheduled' and new.provider_attempt_count < 6 then
    new.max_attempts := greatest(1, new.attempt_count + 1);
  elsif tg_op = 'INSERT' or new.status not in ('queued', 'running', 'retry_scheduled') then
    new.max_attempts := 6;
  end if;

  if new.status in ('queued', 'retry_scheduled')
    and new.provider_attempt_count >= 6 then
    new.status := 'blocked';
    new.next_attempt_at := null;
    new.locked_by := null;
    new.locked_at := null;
    new.lease_expires_at := null;
    new.completed_at := coalesce(new.completed_at, now());
    new.dead_lettered_at := coalesce(new.dead_lettered_at, now());
    new.dead_letter_reason := 'external_analysis_provider_attempt_limit_reached';
    new.last_error_code := 'external_analysis_provider_attempt_limit_reached';
    new.last_error := 'The six actual Gemini execution attempts were exhausted.';
    new.progress := new.progress || jsonb_build_object(
      'stage', 'dead_lettered',
      'reason', 'external_analysis_provider_attempt_limit_reached',
      'updatedAt', now()
    );
  end if;

  return new;
end;
$$;

drop trigger if exists guard_external_analysis_attempt_budgets
  on public.ai_external_analysis_jobs;
create trigger guard_external_analysis_attempt_budgets
before insert or update
on public.ai_external_analysis_jobs
for each row execute function public.guard_external_analysis_attempt_budgets();

-- Mark provider evidence on the current run only. The job-level progress does
-- not receive providerAttemptObserved, so a future claim cannot inherit a
-- previous run's Gemini evidence.
create or replace function public.update_external_analysis_job_progress(
  p_job_id uuid,
  p_worker_id text,
  p_progress jsonb default '{}'::jsonb,
  p_provider text default null,
  p_model text default null,
  p_key_attempts jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt_count integer;
  v_run_progress jsonb := coalesce(p_progress, '{}'::jsonb);
  v_observed boolean := false;
begin
  if p_key_attempts is not null and jsonb_typeof(p_key_attempts) <> 'array' then
    raise exception 'key attempts must be a JSON array' using errcode = '22023';
  end if;

  v_observed := case
    when coalesce(v_run_progress #>> '{gemini,totalAttemptCount}', '') ~ '^\d+$'
      then (v_run_progress #>> '{gemini,totalAttemptCount}')::integer > 0
    else false
  end or coalesce(jsonb_array_length(case
    when jsonb_typeof(p_key_attempts) = 'array' then p_key_attempts
    else '[]'::jsonb
  end), 0) > 0;

  update public.ai_external_analysis_jobs as job
  set progress = coalesce(job.progress, '{}'::jsonb)
        || coalesce(p_progress, '{}'::jsonb)
        || jsonb_build_object('providerBudgetVersion', 1, 'updatedAt', now()),
      updated_at = now()
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = btrim(coalesce(p_worker_id, ''))
  returning job.attempt_count into v_attempt_count;

  if not found then return false; end if;

  if v_observed then
    v_run_progress := v_run_progress || jsonb_build_object(
      'providerBudgetVersion', 1,
      'providerAttemptObserved', true
    );
  end if;

  update public.ai_external_analysis_runs as run
  set provider = coalesce(nullif(btrim(coalesce(p_provider, '')), ''), run.provider),
      model = coalesce(nullif(btrim(coalesce(p_model, '')), ''), run.model),
      progress = coalesce(run.progress, '{}'::jsonb)
        || jsonb_build_object('providerBudgetVersion', 1)
        || v_run_progress,
      key_attempts = case when p_key_attempts is null then run.key_attempts else p_key_attempts end
  where run.job_id = p_job_id
    and run.run_number = v_attempt_count
    and run.status = 'running';

  return true;
end;
$$;

create or replace function public.sync_external_analysis_provider_attempt_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  select least(6, count(*) filter (
    where public.external_analysis_run_spent_provider_attempt(run.progress, run.error_code)
  ))::integer
  into v_count
  from public.ai_external_analysis_runs as run
  where run.job_id = new.job_id;

  update public.ai_external_analysis_jobs as job
  set provider_attempt_count = coalesce(v_count, 0),
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'providerBudgetVersion', 1,
        'providerAttemptCount', coalesce(v_count, 0),
        'providerAttemptLimit', 6,
        'updatedAt', now()
      ),
      updated_at = now()
  where job.id = new.job_id
    and public.external_analysis_uses_gemini_budget(job.job_type);

  return new;
end;
$$;

drop trigger if exists sync_external_analysis_provider_attempt_count
  on public.ai_external_analysis_runs;
create trigger sync_external_analysis_provider_attempt_count
after insert or update of progress, status, error_code
on public.ai_external_analysis_runs
for each row execute function public.sync_external_analysis_provider_attempt_count();

-- Reconcile already-active rows after the historical backfill.  Completed work
-- remains completed; only an active exhausted job is moved to manual review.
update public.ai_external_analysis_jobs as job
set status = 'blocked',
    next_attempt_at = null,
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    completed_at = coalesce(job.completed_at, now()),
    dead_lettered_at = coalesce(job.dead_lettered_at, now()),
    dead_letter_reason = 'external_analysis_provider_attempt_limit_reached',
    last_error_code = 'external_analysis_provider_attempt_limit_reached',
    last_error = 'The six actual Gemini execution attempts were exhausted.',
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'dead_lettered',
      'reason', 'external_analysis_provider_attempt_limit_reached',
      'providerAttemptCount', 6,
      'providerAttemptLimit', 6,
      'updatedAt', now()
    ),
    updated_at = now()
where public.external_analysis_uses_gemini_budget(job.job_type)
  and job.provider_attempt_count >= job.provider_attempt_limit
  and job.status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused');

-- Preserve the full current inventory classifier, then replace only the
-- misleading worker-run counter for external Gemini tasks.
alter function public.get_visible_automation_task_inventory(uuid)
  rename to get_visible_automation_task_inventory_v9;

revoke all on function public.get_visible_automation_task_inventory_v9(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automation_task_inventory_v9(uuid)
  to service_role;

create or replace function public.get_visible_automation_task_inventory(
  p_requested_by uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with source as (
    select entry.value as task, entry.ordinality
    from jsonb_array_elements(coalesce(
      public.get_visible_automation_task_inventory_v9(p_requested_by),
      '[]'::jsonb
    )) with ordinality as entry(value, ordinality)
  ), normalized as (
    select source.ordinality,
      case
        when source.task->>'sourceType' = 'external_analysis'
          and public.external_analysis_uses_gemini_budget(job.job_type) then
          source.task || jsonb_build_object(
            'attemptCount', coalesce(job.provider_attempt_count, 0),
            'maxAttempts', coalesce(job.provider_attempt_limit, 6),
            'attemptMetric', 'gemini_execution',
            'recoveryCount', coalesce(job.recovery_cycle_count, 0),
            'maxRecoveries', coalesce(job.recovery_cycle_limit, 3)
          )
        else source.task || jsonb_build_object(
          'attemptMetric', case
            when source.task->>'operationKey' = 'content_writing'
              then 'writing_execution'
            else 'worker_execution'
          end
        )
      end as task
    from source
    left join public.ai_external_analysis_jobs as job
      on source.task->>'sourceType' = 'external_analysis'
      and job.id::text = source.task->>'sourceId'
  )
  select coalesce(jsonb_agg(normalized.task order by normalized.ordinality), '[]'::jsonb)
  from normalized;
$$;

create or replace function public.get_automatic_article_focus()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_focus public.automatic_article_focus%rowtype;
  v_title text := '';
  v_last_title text := '';
  v_attempt_count integer := 0;
  v_max_attempts integer := 0;
  v_attempt_metric text := 'worker_execution';
  v_recovery_count integer := 0;
  v_max_recoveries integer := 3;
begin
  select focus.* into v_focus
  from public.automatic_article_focus as focus
  where focus.singleton is true;

  if v_focus.article_id is not null then
    select coalesce(article.title, '') into v_title
    from public.articles as article where article.id = v_focus.article_id;

    select
      case when public.external_analysis_uses_gemini_budget(job.job_type)
        then job.provider_attempt_count else job.attempt_count end,
      case when public.external_analysis_uses_gemini_budget(job.job_type)
        then job.provider_attempt_limit else job.max_attempts end,
      case when public.external_analysis_uses_gemini_budget(job.job_type)
        then 'gemini_execution' else 'worker_execution' end,
      job.recovery_cycle_count,
      job.recovery_cycle_limit
    into v_attempt_count, v_max_attempts, v_attempt_metric,
      v_recovery_count, v_max_recoveries
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_focus.article_id
      and job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and public.automatic_article_focus_controls_job_type(job.job_type)
    order by
      (public.automatic_article_focus_stage_for_job_type(job.job_type)
        = v_focus.current_stage) desc,
      case job.status when 'running' then 0 when 'retry_scheduled' then 1
        when 'queued' then 2 when 'blocked' then 3 else 4 end,
      job.updated_at desc, job.id
    limit 1;

    if not found then
      select item.attempt_count, item.max_attempts, 'writing_execution',
        item.recovery_count, 3
      into v_attempt_count, v_max_attempts, v_attempt_metric,
        v_recovery_count, v_max_recoveries
      from public.content_writing_automation_items as item
      where item.article_id = v_focus.article_id
      order by item.updated_at desc, item.id
      limit 1;
    end if;
  end if;

  if v_focus.last_article_id is not null then
    select coalesce(article.title, '') into v_last_title
    from public.articles as article where article.id = v_focus.last_article_id;
  end if;

  return jsonb_build_object(
    'articleId', v_focus.article_id,
    'articleTitle', v_title,
    'state', v_focus.state,
    'currentStage', v_focus.current_stage,
    'acquiredAt', v_focus.acquired_at,
    'lastProgressAt', v_focus.last_progress_at,
    'nextRetryAt', v_focus.next_retry_at,
    'attemptCount', coalesce(v_attempt_count, 0),
    'maxAttempts', coalesce(v_max_attempts, 0),
    'attemptMetric', v_attempt_metric,
    'recoveryCount', coalesce(v_recovery_count, 0),
    'maxRecoveries', coalesce(v_max_recoveries, 3),
    'lastErrorCode', v_focus.last_error_code,
    'lastError', v_focus.last_error,
    'generation', v_focus.generation,
    'lastArticleId', v_focus.last_article_id,
    'lastArticleTitle', v_last_title,
    'lastReleaseReason', v_focus.last_release_reason,
    'releasedAt', v_focus.released_at,
    'canResume', v_focus.article_id is null and v_focus.last_article_id is not null
      and exists (
        select 1 from public.automatic_article_focus_pauses as pause
        where pause.article_id = v_focus.last_article_id
      )
  );
end;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 10;
$$;

revoke all on function public.external_analysis_uses_gemini_budget(text)
  from public, anon, authenticated;
revoke all on function public.external_analysis_run_spent_provider_attempt(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.get_visible_automation_task_inventory(uuid)
  from public, anon, authenticated;
revoke all on function public.get_automatic_article_focus()
  from public, anon, authenticated;

grant execute on function public.external_analysis_uses_gemini_budget(text) to service_role;
grant execute on function public.external_analysis_run_spent_provider_attempt(jsonb, text) to service_role;
grant execute on function public.get_visible_automation_task_inventory(uuid) to service_role;
grant execute on function public.get_automatic_article_focus() to service_role;

comment on column public.ai_external_analysis_jobs.provider_attempt_count is
  'Actual Gemini execution cycles that reached the provider; cancellations and zero-request quota checks do not count.';
comment on column public.ai_external_analysis_jobs.recovery_cycle_count is
  'Bounded automatic recovery cycles, independent from the six provider executions.';
comment on function public.get_visible_automation_task_inventory(uuid) is
  'Returns schema-v10 task inventory with truthful Gemini executions and independent recovery cycles.';

notify pgrst, 'reload schema';

commit;
