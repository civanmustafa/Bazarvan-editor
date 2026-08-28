begin;

-- Ready engineering commands were already scheduled by a database trigger,
-- independently of the editor UI. Expose that behavior as an administrator
-- switch while preserving the existing enabled-by-default production policy.
insert into public.app_settings (key, value, description, is_secret)
values (
  'system',
  jsonb_build_object('autoRunReadyEngineeringCommands', true),
  'General application and content-research automation settings.',
  false
)
on conflict (key) do update
set
  value = jsonb_build_object('autoRunReadyEngineeringCommands', true)
    || coalesce(public.app_settings.value, '{}'::jsonb),
  updated_at = now();

create or replace function public.get_content_research_automation_settings()
returns jsonb
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  with stored as (
    select coalesce((
      select setting.value
      from public.app_settings as setting
      where setting.key = 'system'
        and not setting.is_secret
      limit 1
    ), '{}'::jsonb) as value
  )
  select jsonb_build_object(
    'autoGenerateAlternativeKeywords', case
      when jsonb_typeof(stored.value->'autoGenerateAlternativeKeywords') = 'boolean'
        then (stored.value->>'autoGenerateAlternativeKeywords')::boolean
      else true
    end,
    'autoGenerateLsiKeywords', case
      when jsonb_typeof(stored.value->'autoGenerateLsiKeywords') = 'boolean'
        then (stored.value->>'autoGenerateLsiKeywords')::boolean
      else true
    end,
    'autoDiscoverCompetitors', case
      when jsonb_typeof(stored.value->'autoDiscoverCompetitors') = 'boolean'
        then (stored.value->>'autoDiscoverCompetitors')::boolean
      else true
    end,
    'autoRunReadyEngineeringCommands', case
      when jsonb_typeof(stored.value->'autoRunReadyEngineeringCommands') = 'boolean'
        then (stored.value->>'autoRunReadyEngineeringCommands')::boolean
      else true
    end
  )
  from stored;
$$;

-- A settings change may stop only automatic work. Explicit manual requests and
-- full-workflow engineering children use origin='manual' and remain untouched.
-- Running work keeps its lease while receiving a cancellation request so the
-- worker can stop and finalize it without a stale writer taking ownership.
create or replace function public.cancel_automatic_ready_engineering_jobs(
  p_article_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cancelled_count integer := 0;
begin
  with affected as (
    update public.ai_external_analysis_jobs as job
    set
      status = case when job.status = 'running' then 'running' else 'cancelled' end,
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
      locked_by = case when job.status = 'running' then job.locked_by else null end,
      locked_at = case when job.status = 'running' then job.locked_at else null end,
      lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
      completed_at = case
        when job.status = 'running' then job.completed_at
        else coalesce(job.completed_at, now())
      end,
      last_error_code = 'ready_engineering_commands_automation_disabled',
      last_error = 'Automatic ready engineering commands are disabled in system settings.',
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.status = 'running' then 'cancellation_requested' else 'cancelled' end,
        'reason', 'ready_engineering_commands_automation_disabled',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.job_type = 'engineering_command'
      and job.origin = 'auto'
      and (p_article_id is null or job.article_id = p_article_id)
      and job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      )
    returning job.id, job.status
  ), closed_runs as (
    update public.ai_external_analysis_runs as run
    set
      status = 'cancelled',
      error_code = 'ready_engineering_commands_automation_disabled',
      error_message = 'Automatic ready engineering commands are disabled in system settings.',
      finished_at = now()
    from affected
    where run.job_id = affected.id
      and affected.status = 'cancelled'
      and run.status = 'running'
    returning run.id
  )
  select count(*)::integer
  into v_cancelled_count
  from affected;

  return coalesce(v_cancelled_count, 0);
end;
$$;

-- The legacy coordinator always writes origin='auto'. Wrap it so an explicit
-- API request can promote the exact reused/created IDs before the transaction
-- commits and before a worker or settings reconciler can observe them.
create or replace function public.enqueue_external_engineering_jobs_controlled(
  p_article_id uuid,
  p_requested_by uuid default null,
  p_origin text default 'auto'
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_ids uuid[] := array[]::uuid[];
  v_manual boolean := lower(btrim(coalesce(p_origin, 'auto'))) = 'manual';
begin
  perform pg_advisory_xact_lock(hashtextextended('ready-engineering-command-automation', 0));
  v_job_ids := public.enqueue_external_engineering_jobs(p_article_id);

  if v_manual and cardinality(v_job_ids) > 0 then
    update public.ai_external_analysis_jobs as job
    set
      origin = 'manual',
      requested_by = coalesce(p_requested_by, job.requested_by),
      cancel_requested_at = null,
      last_error_code = case
        when job.last_error_code = 'ready_engineering_commands_automation_disabled' then null
        else job.last_error_code
      end,
      last_error = case
        when job.last_error_code = 'ready_engineering_commands_automation_disabled' then null
        else job.last_error
      end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'source', 'manual_request',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.id = any(v_job_ids)
      -- A completed canonical result is reused without a new execution. Keep
      -- its historical origin unchanged; only work that can still run is
      -- promoted to the explicit manual request.
      and job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      );

    -- Keep the active batch provenance aligned with the jobs promoted above.
    -- Terminal batches remain immutable historical records.
    update public.ai_external_analysis_batches as batch
    set
      origin = 'manual',
      requested_by = coalesce(p_requested_by, batch.requested_by),
      updated_at = now()
    from (
      select distinct job.batch_key
      from public.ai_external_analysis_jobs as job
      where job.id = any(v_job_ids)
        and job.origin = 'manual'
        and job.batch_key is not null
        and job.status in (
          'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
        )
    ) as promoted
    where batch.batch_key = promoted.batch_key
      and batch.status in ('queued', 'running', 'retry_scheduled');
  end if;

  return v_job_ids;
end;
$$;

create or replace function public.set_external_analysis_custom_commands_controlled(
  p_article_id uuid,
  p_requested_by uuid,
  p_command_ids jsonb,
  p_origin text default 'manual'
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('ready-engineering-command-automation', 0));
  perform public.set_external_analysis_custom_commands(
    p_article_id,
    p_requested_by,
    p_command_ids
  );
  return public.enqueue_external_engineering_jobs_controlled(
    p_article_id,
    p_requested_by,
    p_origin
  );
end;
$$;

create or replace function public.reset_external_analysis_command_preferences_controlled(
  p_article_id uuid,
  p_requested_by uuid,
  p_origin text default 'manual'
)
returns public.ai_external_analysis_article_state
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.ai_external_analysis_article_state%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('ready-engineering-command-automation', 0));
  -- The legacy reset enqueues before returning. Calling it inside this wrapper
  -- keeps those rows uncommitted until the controlled promotion finishes.
  v_state := public.reset_external_analysis_command_preferences(
    p_article_id,
    p_requested_by
  );
  perform public.enqueue_external_engineering_jobs_controlled(
    p_article_id,
    p_requested_by,
    p_origin
  );

  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;
  return v_state;
end;
$$;

-- One reusable server-owned coordinator is called both by article-state
-- changes and by the settings reconciler. No browser visit or editor mount is
-- required for an eligible article to enter the durable worker queue.
create or replace function public.reconcile_automatic_ready_engineering_commands_for_article(
  p_article_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := '{}'::jsonb;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_keywords jsonb := '{}'::jsonb;
  v_has_secondaries boolean := false;
  v_has_lsi boolean := false;
  v_job_ids uuid[] := array[]::uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended('ready-engineering-command-automation', 0));
  v_settings := public.get_content_research_automation_settings();

  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

  if v_state.article_id is null then return v_job_ids; end if;

  if not v_state.external_analysis_ready then
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
    return v_job_ids;
  end if;

  if not coalesce((v_settings->>'autoRunReadyEngineeringCommands')::boolean, true) then
    perform public.cancel_automatic_ready_engineering_jobs(p_article_id);
    return v_job_ids;
  end if;

  -- If the switch was re-enabled before a running worker observed the earlier
  -- cancellation request, allow that still-owned automatic run to continue.
  update public.ai_external_analysis_jobs as job
  set
    cancel_requested_at = null,
    last_error_code = null,
    last_error = null,
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'running',
      'source', 'ready_engineering_commands_automation_reenabled',
      'updatedAt', now()
    ),
    updated_at = now()
  where job.article_id = p_article_id
    and job.job_type = 'engineering_command'
    and job.origin = 'auto'
    and job.status = 'running'
    and job.last_error_code = 'ready_engineering_commands_automation_disabled';

  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = p_article_id;
  if not found then return v_job_ids; end if;

  v_has_secondaries := public.external_analysis_has_competitor_value(
    v_keywords->'secondaries',
    100
  );
  v_has_lsi := public.external_analysis_has_competitor_value(v_keywords->'lsi', 100);

  if (
    coalesce((v_settings->>'autoGenerateAlternativeKeywords')::boolean, true)
    and not v_has_secondaries
  ) or (
    coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true)
    and not v_has_lsi
  ) then
    perform public.enqueue_external_semantic_analysis_job_controlled(p_article_id, 'auto');
    return v_job_ids;
  end if;

  if v_has_secondaries and v_has_lsi then
    v_job_ids := public.enqueue_external_engineering_jobs(p_article_id);
  else
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
  end if;

  return v_job_ids;
end;
$$;

create or replace function public.enqueue_external_engineering_jobs_from_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.reconcile_automatic_ready_engineering_commands_for_article(new.article_id);
  return new;
end;
$$;

-- Recreate the database trigger explicitly so automatic execution stays tied
-- to persisted readiness changes rather than to opening an article in the UI.
drop trigger if exists enqueue_external_engineering_jobs
  on public.ai_external_analysis_article_state;
create trigger enqueue_external_engineering_jobs
after insert or update of external_analysis_ready, external_analysis_readiness_signature
on public.ai_external_analysis_article_state
for each row
execute function public.enqueue_external_engineering_jobs_from_state();

create or replace function public.reconcile_ready_engineering_command_automation()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean := true;
  v_article_id uuid;
  v_reconciled_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('ready-engineering-command-automation', 0));
  v_enabled := coalesce(
    (public.get_content_research_automation_settings()
      ->>'autoRunReadyEngineeringCommands')::boolean,
    true
  );

  if not v_enabled then
    return public.cancel_automatic_ready_engineering_jobs(null);
  end if;

  for v_article_id in
    select state.article_id
    from public.ai_external_analysis_article_state as state
    where state.external_analysis_ready
    order by state.article_id
  loop
    perform public.reconcile_automatic_ready_engineering_commands_for_article(v_article_id);
    v_reconciled_count := v_reconciled_count + 1;
  end loop;

  return v_reconciled_count;
end;
$$;

create or replace function public.reconcile_ready_engineering_commands_from_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.key <> 'system' then return new; end if;

  if tg_op = 'INSERT' then
    perform public.reconcile_ready_engineering_command_automation();
  elsif new.value->'autoRunReadyEngineeringCommands'
      is distinct from old.value->'autoRunReadyEngineeringCommands' then
    perform public.reconcile_ready_engineering_command_automation();
  end if;

  return new;
end;
$$;

drop trigger if exists reconcile_ready_engineering_commands_from_settings
  on public.app_settings;
create trigger reconcile_ready_engineering_commands_from_settings
after insert or update of value on public.app_settings
for each row
when (new.key = 'system')
execute function public.reconcile_ready_engineering_commands_from_settings();

revoke all on function public.get_content_research_automation_settings()
  from public, anon, authenticated;
revoke all on function public.cancel_automatic_ready_engineering_jobs(uuid)
  from public, anon, authenticated;
revoke all on function public.enqueue_external_engineering_jobs_controlled(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.set_external_analysis_custom_commands_controlled(uuid, uuid, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.reset_external_analysis_command_preferences_controlled(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.reconcile_automatic_ready_engineering_commands_for_article(uuid)
  from public, anon, authenticated;
revoke all on function public.enqueue_external_engineering_jobs_from_state()
  from public, anon, authenticated;
revoke all on function public.reconcile_ready_engineering_command_automation()
  from public, anon, authenticated;
revoke all on function public.reconcile_ready_engineering_commands_from_settings()
  from public, anon, authenticated;

grant execute on function public.get_content_research_automation_settings()
  to service_role;
grant execute on function public.cancel_automatic_ready_engineering_jobs(uuid)
  to service_role;
grant execute on function public.enqueue_external_engineering_jobs_controlled(uuid, uuid, text)
  to service_role;
grant execute on function public.set_external_analysis_custom_commands_controlled(uuid, uuid, jsonb, text)
  to service_role;
grant execute on function public.reset_external_analysis_command_preferences_controlled(uuid, uuid, text)
  to service_role;
grant execute on function public.reconcile_automatic_ready_engineering_commands_for_article(uuid)
  to service_role;
grant execute on function public.reconcile_ready_engineering_command_automation()
  to service_role;

comment on function public.reconcile_automatic_ready_engineering_commands_for_article(uuid)
  is 'Queues ready automatic engineering commands from persisted database state without requiring an article UI visit.';
comment on function public.cancel_automatic_ready_engineering_jobs(uuid)
  is 'Cancels or requests cancellation only for origin=auto engineering tasks; explicit manual work is preserved.';

select public.reconcile_ready_engineering_command_automation();

-- The deployment applies migrations through psql while PostgREST remains
-- online, so publish the new controlled RPC signatures immediately on commit.
notify pgrst, 'reload schema';

commit;
