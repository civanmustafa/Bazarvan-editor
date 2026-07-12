-- Independent external-analysis batches and a persistent Gemini key coordinator.
-- Raw API keys remain in server environment variables; only fingerprints are stored here.

update public.app_settings
set value = jsonb_set(
  coalesce(value, '{}'::jsonb),
  '{externalAnalysisCommandExecutionMode}',
  case
    when value->>'externalAnalysisCommandExecutionMode' in ('independent_batch', 'sequential')
      then value->'externalAnalysisCommandExecutionMode'
    else '"independent_batch"'::jsonb
  end,
  true
)
where key = 'ai';

create or replace function public.get_external_analysis_command_execution_mode()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when setting.value->>'externalAnalysisCommandExecutionMode' = 'sequential'
      then 'sequential'
    else 'independent_batch'
  end
  from public.app_settings as setting
  where setting.key = 'ai'
    and setting.is_secret is not true
  limit 1;
$$;

create table if not exists public.ai_external_analysis_batches (
  batch_key text primary key,
  article_id uuid not null references public.articles(id) on delete cascade,
  requested_by uuid references public.profiles(id) on delete set null,
  origin text not null check (origin in ('auto', 'manual')),
  execution_mode text not null check (execution_mode in ('independent_batch', 'sequential')),
  status text not null default 'queued' check (
    status in ('queued', 'running', 'retry_scheduled', 'partial', 'completed', 'failed', 'cancelled')
  ),
  total_commands integer not null default 0 check (total_commands >= 0),
  completed_commands integer not null default 0 check (completed_commands >= 0),
  active_commands integer not null default 0 check (active_commands >= 0),
  retrying_commands integer not null default 0 check (retrying_commands >= 0),
  failed_commands integer not null default 0 check (failed_commands >= 0),
  cancelled_commands integer not null default 0 check (cancelled_commands >= 0),
  readiness_signature text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_external_analysis_batches_article_idx
  on public.ai_external_analysis_batches(article_id, created_at desc);
create index if not exists ai_external_analysis_batches_status_idx
  on public.ai_external_analysis_batches(status, created_at)
  where status in ('queued', 'running', 'retry_scheduled');

create or replace function public.refresh_external_analysis_batch(
  p_batch_key text
)
returns public.ai_external_analysis_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.ai_external_analysis_batches%rowtype;
  v_total integer := 0;
  v_completed integer := 0;
  v_active integer := 0;
  v_retrying integer := 0;
  v_failed integer := 0;
  v_cancelled integer := 0;
  v_started_at timestamptz;
  v_completed_at timestamptz;
  v_status text := 'queued';
begin
  if nullif(btrim(coalesce(p_batch_key, '')), '') is null then
    return null;
  end if;

  select
    count(*)::integer,
    count(*) filter (where job.status = 'completed')::integer,
    count(*) filter (where job.status in ('waiting_for_prerequisites', 'queued', 'running', 'paused'))::integer,
    count(*) filter (where job.status = 'retry_scheduled')::integer,
    count(*) filter (where job.status in ('failed', 'blocked'))::integer,
    count(*) filter (where job.status = 'cancelled')::integer,
    min(job.started_at),
    max(job.completed_at)
  into
    v_total,
    v_completed,
    v_active,
    v_retrying,
    v_failed,
    v_cancelled,
    v_started_at,
    v_completed_at
  from public.ai_external_analysis_jobs as job
  where job.batch_key = p_batch_key
    and job.job_type = 'engineering_command';

  v_status := case
    when v_total > 0 and v_completed = v_total then 'completed'
    when v_active > 0 and exists (
      select 1
      from public.ai_external_analysis_jobs as job
      where job.batch_key = p_batch_key
        and job.job_type = 'engineering_command'
        and job.status = 'running'
    ) then 'running'
    when v_retrying > 0 then 'retry_scheduled'
    when v_active > 0 then 'queued'
    when v_completed > 0 then 'partial'
    when v_failed > 0 then 'failed'
    when v_cancelled = v_total and v_total > 0 then 'cancelled'
    else 'queued'
  end;

  update public.ai_external_analysis_batches as batch
  set
    status = v_status,
    total_commands = v_total,
    completed_commands = v_completed,
    active_commands = v_active,
    retrying_commands = v_retrying,
    failed_commands = v_failed,
    cancelled_commands = v_cancelled,
    started_at = coalesce(batch.started_at, v_started_at),
    completed_at = case
      when v_status in ('completed', 'partial', 'failed', 'cancelled')
        then coalesce(v_completed_at, now())
      else null
    end,
    updated_at = now()
  where batch.batch_key = p_batch_key
  returning batch.* into v_batch;

  return v_batch;
end;
$$;

create or replace function public.apply_external_analysis_execution_mode_to_batch(
  p_batch_key text
)
returns public.ai_external_analysis_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.ai_external_analysis_batches%rowtype;
  v_mode text;
  v_root_dependency uuid;
begin
  if nullif(btrim(coalesce(p_batch_key, '')), '') is null then
    return null;
  end if;

  select batch.*
  into v_batch
  from public.ai_external_analysis_batches as batch
  where batch.batch_key = p_batch_key;

  v_mode := coalesce(
    v_batch.execution_mode,
    public.get_external_analysis_command_execution_mode(),
    'independent_batch'
  );

  insert into public.ai_external_analysis_batches (
    batch_key,
    article_id,
    requested_by,
    origin,
    execution_mode,
    total_commands,
    readiness_signature,
    created_at,
    updated_at
  )
  select
    p_batch_key,
    min(job.article_id::text)::uuid,
    (array_agg(job.requested_by order by job.sequence_number) filter (where job.requested_by is not null))[1],
    (array_agg(job.origin order by job.sequence_number))[1],
    v_mode,
    count(*)::integer,
    (array_agg(job.readiness_signature order by job.sequence_number) filter (where job.readiness_signature is not null))[1],
    min(job.created_at),
    now()
  from public.ai_external_analysis_jobs as job
  where job.batch_key = p_batch_key
    and job.job_type = 'engineering_command'
  having count(*) > 0
  on conflict (batch_key) do update
  set
    total_commands = excluded.total_commands,
    updated_at = now();

  select job.depends_on_job_id
  into v_root_dependency
  from public.ai_external_analysis_jobs as job
  where job.batch_key = p_batch_key
    and job.job_type = 'engineering_command'
  order by job.sequence_number, job.created_at
  limit 1;

  if v_mode = 'independent_batch' then
    update public.ai_external_analysis_jobs as job
    set
      depends_on_job_id = v_root_dependency,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'executionMode', 'independent_batch',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.batch_key = p_batch_key
      and job.job_type = 'engineering_command'
      and job.status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused');
  else
    with ordered as (
      select
        job.id,
        job.sequence_number,
        lag(job.id) over (order by job.sequence_number, job.created_at) as previous_job_id
      from public.ai_external_analysis_jobs as job
      where job.batch_key = p_batch_key
        and job.job_type = 'engineering_command'
    )
    update public.ai_external_analysis_jobs as job
    set
      depends_on_job_id = case
        when ordered.previous_job_id is null then v_root_dependency
        else ordered.previous_job_id
      end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'executionMode', 'sequential',
        'updatedAt', now()
      ),
      updated_at = now()
    from ordered
    where job.id = ordered.id
      and job.status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused');
  end if;

  return public.refresh_external_analysis_batch(p_batch_key);
end;
$$;

do $$
begin
  if to_regprocedure('public.enqueue_external_engineering_jobs_sequential_base(uuid)') is null then
    alter function public.enqueue_external_engineering_jobs(uuid)
      rename to enqueue_external_engineering_jobs_sequential_base;
  end if;
end;
$$;

create or replace function public.enqueue_external_engineering_jobs(
  p_article_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_ids uuid[] := array[]::uuid[];
  v_batch_key text;
begin
  v_job_ids := public.enqueue_external_engineering_jobs_sequential_base(p_article_id);

  for v_batch_key in
    select distinct job.batch_key
    from public.ai_external_analysis_jobs as job
    where job.id = any(v_job_ids)
      and job.batch_key is not null
  loop
    perform public.apply_external_analysis_execution_mode_to_batch(v_batch_key);
  end loop;

  return v_job_ids;
end;
$$;

create or replace function public.refresh_external_analysis_batch_from_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_key text;
begin
  v_batch_key := case when tg_op = 'DELETE' then old.batch_key else new.batch_key end;
  if v_batch_key is not null then
    perform public.refresh_external_analysis_batch(v_batch_key);
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists refresh_external_analysis_batch_from_job on public.ai_external_analysis_jobs;
create trigger refresh_external_analysis_batch_from_job
after update of status, result, progress, cancel_requested_at or delete
on public.ai_external_analysis_jobs
for each row execute function public.refresh_external_analysis_batch_from_job();

create table if not exists public.ai_gemini_key_pool (
  provider text not null check (provider in ('gemini', 'geminiPaid')),
  key_fingerprint text not null,
  key_suffix text not null default '',
  env_position integer not null default 0 check (env_position >= 0),
  is_active boolean not null default true,
  is_disabled boolean not null default false,
  disabled_reason text,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  selection_count bigint not null default 0 check (selection_count >= 0),
  success_count bigint not null default 0 check (success_count >= 0),
  failure_count bigint not null default 0 check (failure_count >= 0),
  last_selected_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_status integer,
  last_reason text,
  last_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, key_fingerprint)
);

create table if not exists public.ai_gemini_key_model_state (
  provider text not null,
  key_fingerprint text not null,
  model text not null,
  selection_count bigint not null default 0 check (selection_count >= 0),
  success_count bigint not null default 0 check (success_count >= 0),
  failure_count bigint not null default 0 check (failure_count >= 0),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  cooldown_until timestamptz,
  last_selected_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_status integer,
  last_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, key_fingerprint, model),
  foreign key (provider, key_fingerprint)
    references public.ai_gemini_key_pool(provider, key_fingerprint)
    on delete cascade
);

create index if not exists ai_gemini_key_pool_available_idx
  on public.ai_gemini_key_pool(provider, is_active, is_disabled, selection_count, last_selected_at);
create index if not exists ai_gemini_key_model_cooldown_idx
  on public.ai_gemini_key_model_state(provider, model, cooldown_until);

create or replace function public.sync_gemini_api_key_pool(
  p_provider text,
  p_keys jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  if p_provider not in ('gemini', 'geminiPaid') then
    raise exception 'unsupported Gemini provider %', p_provider using errcode = '22023';
  end if;
  if jsonb_typeof(p_keys) <> 'array' then
    raise exception 'p_keys must be a JSON array' using errcode = '22023';
  end if;

  with incoming as (
    select distinct on (nullif(btrim(item.value->>'fingerprint'), ''))
      nullif(btrim(item.value->>'fingerprint'), '') as fingerprint,
      right(coalesce(item.value->>'suffix', ''), 8) as suffix,
      greatest(coalesce((item.value->>'position')::integer, item.ordinality::integer - 1), 0) as position
    from jsonb_array_elements(p_keys) with ordinality as item(value, ordinality)
    where nullif(btrim(item.value->>'fingerprint'), '') is not null
    order by nullif(btrim(item.value->>'fingerprint'), ''), item.ordinality
  ), deactivated as (
    update public.ai_gemini_key_pool as pool
    set
      is_active = false,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
    where pool.provider = p_provider
      and not exists (
        select 1 from incoming where incoming.fingerprint = pool.key_fingerprint
      )
    returning pool.key_fingerprint
  ), upserted as (
    insert into public.ai_gemini_key_pool (
      provider,
      key_fingerprint,
      key_suffix,
      env_position,
      is_active,
      updated_at
    )
    select
      p_provider,
      incoming.fingerprint,
      incoming.suffix,
      incoming.position,
      true,
      now()
    from incoming
    on conflict (provider, key_fingerprint) do update
    set
      key_suffix = excluded.key_suffix,
      env_position = excluded.env_position,
      is_active = true,
      updated_at = now()
    returning key_fingerprint
  )
  select count(*)::integer into v_count from upserted;

  return coalesce(v_count, 0);
end;
$$;

create or replace function public.claim_gemini_api_key(
  p_provider text,
  p_model text,
  p_candidate_fingerprints text[],
  p_excluded_fingerprints text[],
  p_lease_owner text,
  p_lease_seconds integer default 180
)
returns table (
  key_fingerprint text,
  key_suffix text,
  lease_token uuid,
  lease_expires_at timestamptz,
  selection_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fingerprint text;
  v_suffix text;
  v_token uuid := gen_random_uuid();
  v_expires_at timestamptz := now() + make_interval(
    secs => greatest(30, least(coalesce(p_lease_seconds, 180), 600))
  );
  v_selection_count bigint;
begin
  if p_provider not in ('gemini', 'geminiPaid')
    or nullif(btrim(coalesce(p_model, '')), '') is null
    or nullif(btrim(coalesce(p_lease_owner, '')), '') is null
    or coalesce(cardinality(p_candidate_fingerprints), 0) = 0 then
    return;
  end if;

  select pool.key_fingerprint, pool.key_suffix
  into v_fingerprint, v_suffix
  from public.ai_gemini_key_pool as pool
  left join public.ai_gemini_key_model_state as model_state
    on model_state.provider = pool.provider
    and model_state.key_fingerprint = pool.key_fingerprint
    and model_state.model = p_model
  where pool.provider = p_provider
    and pool.key_fingerprint = any(p_candidate_fingerprints)
    and not (pool.key_fingerprint = any(coalesce(p_excluded_fingerprints, array[]::text[])))
    and pool.is_active
    and not pool.is_disabled
    and (pool.lease_expires_at is null or pool.lease_expires_at <= now())
    and (model_state.cooldown_until is null or model_state.cooldown_until <= now())
  order by
    pool.selection_count,
    coalesce(model_state.selection_count, 0),
    pool.last_selected_at nulls first,
    model_state.last_selected_at nulls first,
    pool.env_position,
    pool.key_fingerprint
  for update of pool skip locked
  limit 1;

  if v_fingerprint is null then
    return;
  end if;

  update public.ai_gemini_key_pool as pool
  set
    lease_owner = btrim(p_lease_owner),
    lease_token = v_token,
    lease_expires_at = v_expires_at,
    selection_count = pool.selection_count + 1,
    last_selected_at = now(),
    last_model = p_model,
    updated_at = now()
  where pool.provider = p_provider
    and pool.key_fingerprint = v_fingerprint
  returning pool.selection_count into v_selection_count;

  insert into public.ai_gemini_key_model_state (
    provider,
    key_fingerprint,
    model,
    selection_count,
    last_selected_at,
    updated_at
  ) values (
    p_provider,
    v_fingerprint,
    p_model,
    1,
    now(),
    now()
  )
  on conflict on constraint ai_gemini_key_model_state_pkey do update
  set
    selection_count = ai_gemini_key_model_state.selection_count + 1,
    last_selected_at = now(),
    updated_at = now();

  return query select
    v_fingerprint,
    v_suffix,
    v_token,
    v_expires_at,
    v_selection_count;
end;
$$;

create or replace function public.report_gemini_api_key_result(
  p_provider text,
  p_model text,
  p_key_fingerprint text,
  p_lease_owner text,
  p_lease_token uuid,
  p_outcome text,
  p_status integer default null,
  p_reason text default null,
  p_cooldown_seconds integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affected integer := 0;
  v_success boolean := p_outcome = 'success';
  v_failure boolean := p_outcome = 'failed';
  v_auth_failure boolean := v_failure and p_reason = 'auth';
  v_cooldown_until timestamptz := case
    when v_failure and coalesce(p_cooldown_seconds, 0) > 0
      then now() + make_interval(secs => greatest(1, least(p_cooldown_seconds, 86400)))
    else null
  end;
begin
  update public.ai_gemini_key_pool as pool
  set
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    success_count = pool.success_count + case when v_success then 1 else 0 end,
    failure_count = pool.failure_count + case when v_failure then 1 else 0 end,
    last_success_at = case when v_success then now() else pool.last_success_at end,
    last_failure_at = case when v_failure then now() else pool.last_failure_at end,
    last_status = coalesce(p_status, pool.last_status),
    last_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), pool.last_reason),
    last_model = coalesce(nullif(btrim(coalesce(p_model, '')), ''), pool.last_model),
    is_disabled = pool.is_disabled or v_auth_failure,
    disabled_reason = case when v_auth_failure then 'auth' else pool.disabled_reason end,
    updated_at = now()
  where pool.provider = p_provider
    and pool.key_fingerprint = p_key_fingerprint
    and pool.lease_owner = p_lease_owner
    and pool.lease_token = p_lease_token;

  get diagnostics v_affected = row_count;
  if v_affected = 0 then
    return false;
  end if;

  insert into public.ai_gemini_key_model_state (
    provider,
    key_fingerprint,
    model,
    success_count,
    failure_count,
    consecutive_failures,
    cooldown_until,
    last_success_at,
    last_failure_at,
    last_status,
    last_reason,
    updated_at
  ) values (
    p_provider,
    p_key_fingerprint,
    p_model,
    case when v_success then 1 else 0 end,
    case when v_failure then 1 else 0 end,
    case when v_failure then 1 else 0 end,
    v_cooldown_until,
    case when v_success then now() else null end,
    case when v_failure then now() else null end,
    p_status,
    p_reason,
    now()
  )
  on conflict (provider, key_fingerprint, model) do update
  set
    success_count = ai_gemini_key_model_state.success_count + case when v_success then 1 else 0 end,
    failure_count = ai_gemini_key_model_state.failure_count + case when v_failure then 1 else 0 end,
    consecutive_failures = case
      when v_success then 0
      when v_failure then ai_gemini_key_model_state.consecutive_failures + 1
      else ai_gemini_key_model_state.consecutive_failures
    end,
    cooldown_until = case
      when v_success then null
      when v_cooldown_until is not null then greatest(
        coalesce(ai_gemini_key_model_state.cooldown_until, v_cooldown_until),
        v_cooldown_until
      )
      else ai_gemini_key_model_state.cooldown_until
    end,
    last_success_at = case when v_success then now() else ai_gemini_key_model_state.last_success_at end,
    last_failure_at = case when v_failure then now() else ai_gemini_key_model_state.last_failure_at end,
    last_status = coalesce(p_status, ai_gemini_key_model_state.last_status),
    last_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), ai_gemini_key_model_state.last_reason),
    updated_at = now();

  return true;
end;
$$;

alter table public.ai_external_analysis_batches enable row level security;
alter table public.ai_gemini_key_pool enable row level security;
alter table public.ai_gemini_key_model_state enable row level security;

drop policy if exists "ai_external_analysis_batches_select_visible" on public.ai_external_analysis_batches;
create policy "ai_external_analysis_batches_select_visible"
on public.ai_external_analysis_batches
for select
to authenticated
using (public.can_read_article(article_id));

drop policy if exists "ai_gemini_key_pool_admin_select" on public.ai_gemini_key_pool;
create policy "ai_gemini_key_pool_admin_select"
on public.ai_gemini_key_pool
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'admin'
      and profiles.is_active is not false
  )
);

drop policy if exists "ai_gemini_key_model_state_admin_select" on public.ai_gemini_key_model_state;
create policy "ai_gemini_key_model_state_admin_select"
on public.ai_gemini_key_model_state
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'admin'
      and profiles.is_active is not false
  )
);

revoke all on public.ai_external_analysis_batches from anon;
revoke all on public.ai_gemini_key_pool from anon;
revoke all on public.ai_gemini_key_model_state from anon;
revoke insert, update, delete on public.ai_external_analysis_batches from authenticated;
revoke insert, update, delete on public.ai_gemini_key_pool from authenticated;
revoke insert, update, delete on public.ai_gemini_key_model_state from authenticated;
grant select on public.ai_external_analysis_batches to authenticated;
grant select on public.ai_gemini_key_pool to authenticated;
grant select on public.ai_gemini_key_model_state to authenticated;

revoke all on function public.get_external_analysis_command_execution_mode() from public;
revoke all on function public.refresh_external_analysis_batch(text) from public;
revoke all on function public.apply_external_analysis_execution_mode_to_batch(text) from public;
revoke all on function public.enqueue_external_engineering_jobs_sequential_base(uuid) from public;
revoke all on function public.enqueue_external_engineering_jobs(uuid) from public;
revoke all on function public.refresh_external_analysis_batch_from_job() from public;
revoke all on function public.sync_gemini_api_key_pool(text, jsonb) from public;
revoke all on function public.claim_gemini_api_key(text, text, text[], text[], text, integer) from public;
revoke all on function public.report_gemini_api_key_result(text, text, text, text, uuid, text, integer, text, integer) from public;

grant execute on function public.get_external_analysis_command_execution_mode() to service_role;
grant execute on function public.refresh_external_analysis_batch(text) to service_role;
grant execute on function public.apply_external_analysis_execution_mode_to_batch(text) to service_role;
grant execute on function public.enqueue_external_engineering_jobs(uuid) to service_role;
grant execute on function public.sync_gemini_api_key_pool(text, jsonb) to service_role;
grant execute on function public.claim_gemini_api_key(text, text, text[], text[], text, integer) to service_role;
grant execute on function public.report_gemini_api_key_result(text, text, text, text, uuid, text, integer, text, integer) to service_role;

comment on table public.ai_external_analysis_batches is 'One article-level external-analysis batch with independently persisted command jobs.';
comment on table public.ai_gemini_key_pool is 'Persistent fair-use and lease state for server-side Gemini keys; raw keys are never stored.';
comment on function public.claim_gemini_api_key(text, text, text[], text[], text, integer) is 'Atomically leases the least-used eligible Gemini key across all server processes.';
