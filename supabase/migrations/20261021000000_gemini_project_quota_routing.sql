begin;

-- Google applies Gemini API quotas per Google project, not per API key. Keep
-- the project identifier optional so all existing credentials remain valid;
-- administrators can add it when a credential group contains keys from one
-- known Google project.
alter table public.provider_credentials_vault
  add column if not exists google_project_id text;

alter table public.provider_credentials_vault
  drop constraint if exists provider_credentials_vault_google_project_id_check;
alter table public.provider_credentials_vault
  add constraint provider_credentials_vault_google_project_id_check
  check (
    google_project_id is null
    or (
      char_length(btrim(google_project_id)) between 2 and 120
      and btrim(google_project_id) ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9]$'
    )
  );

alter table public.ai_gemini_key_pool
  add column if not exists project_id text;

create index if not exists ai_gemini_key_pool_project_idx
  on public.ai_gemini_key_pool(provider, project_id)
  where project_id is not null;

create table if not exists public.ai_gemini_project_model_state (
  provider text not null check (provider in ('gemini', 'geminiPaid')),
  project_id text not null,
  model text not null,
  success_count bigint not null default 0 check (success_count >= 0),
  quota_failure_count bigint not null default 0 check (quota_failure_count >= 0),
  cooldown_until timestamptz,
  last_success_at timestamptz,
  last_quota_failure_at timestamptz,
  last_status integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, project_id, model)
);

create index if not exists ai_gemini_project_model_cooldown_idx
  on public.ai_gemini_project_model_state(provider, model, cooldown_until);

alter table public.ai_gemini_project_model_state enable row level security;

drop policy if exists "ai_gemini_project_model_state_admin_select"
  on public.ai_gemini_project_model_state;
create policy "ai_gemini_project_model_state_admin_select"
on public.ai_gemini_project_model_state
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'admin'
      and profiles.is_active is not false
  )
);

revoke all on public.ai_gemini_project_model_state from anon;
revoke insert, update, delete on public.ai_gemini_project_model_state from authenticated;
grant select on public.ai_gemini_project_model_state to authenticated;

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
      greatest(coalesce((item.value->>'position')::integer, item.ordinality::integer - 1), 0) as position,
      left(nullif(btrim(item.value->>'project_id'), ''), 120) as project_id
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
      project_id,
      is_active,
      updated_at
    )
    select
      p_provider,
      incoming.fingerprint,
      incoming.suffix,
      incoming.position,
      incoming.project_id,
      true,
      now()
    from incoming
    on conflict (provider, key_fingerprint) do update
    set
      key_suffix = excluded.key_suffix,
      env_position = excluded.env_position,
      project_id = excluded.project_id,
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
  left join public.ai_gemini_project_model_state as project_state
    on project_state.provider = pool.provider
    and project_state.project_id = pool.project_id
    and project_state.model = p_model
  where pool.provider = p_provider
    and pool.key_fingerprint = any(p_candidate_fingerprints)
    and not (pool.key_fingerprint = any(coalesce(p_excluded_fingerprints, array[]::text[])))
    and pool.is_active
    and not pool.is_disabled
    and (pool.lease_expires_at is null or pool.lease_expires_at <= now())
    and (model_state.cooldown_until is null or model_state.cooldown_until <= now())
    and (project_state.cooldown_until is null or project_state.cooldown_until <= now())
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
    provider, key_fingerprint, model, selection_count, last_selected_at, updated_at
  ) values (
    p_provider, v_fingerprint, p_model, 1, now(), now()
  )
  on conflict on constraint ai_gemini_key_model_state_pkey do update
  set
    selection_count = ai_gemini_key_model_state.selection_count + 1,
    last_selected_at = now(),
    updated_at = now();

  return query select v_fingerprint, v_suffix, v_token, v_expires_at, v_selection_count;
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
  v_quota_failure boolean := v_failure and (p_reason = 'quota' or p_status = 429);
  v_project_id text;
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
    and pool.lease_token = p_lease_token
  returning pool.project_id into v_project_id;

  get diagnostics v_affected = row_count;
  if v_affected = 0 then
    return false;
  end if;

  insert into public.ai_gemini_key_model_state (
    provider, key_fingerprint, model, success_count, failure_count,
    consecutive_failures, cooldown_until, last_success_at, last_failure_at,
    last_status, last_reason, updated_at
  ) values (
    p_provider, p_key_fingerprint, p_model,
    case when v_success then 1 else 0 end,
    case when v_failure then 1 else 0 end,
    case when v_failure then 1 else 0 end,
    v_cooldown_until,
    case when v_success then now() else null end,
    case when v_failure then now() else null end,
    p_status, p_reason, now()
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

  if nullif(btrim(coalesce(v_project_id, '')), '') is not null
      and (v_success or v_quota_failure) then
    insert into public.ai_gemini_project_model_state (
      provider, project_id, model, success_count, quota_failure_count,
      cooldown_until, last_success_at, last_quota_failure_at, last_status, updated_at
    ) values (
      p_provider, v_project_id, p_model,
      case when v_success then 1 else 0 end,
      case when v_quota_failure then 1 else 0 end,
      case when v_quota_failure then v_cooldown_until else null end,
      case when v_success then now() else null end,
      case when v_quota_failure then now() else null end,
      p_status,
      now()
    )
    on conflict (provider, project_id, model) do update
    set
      success_count = ai_gemini_project_model_state.success_count + case when v_success then 1 else 0 end,
      quota_failure_count = ai_gemini_project_model_state.quota_failure_count + case when v_quota_failure then 1 else 0 end,
      cooldown_until = case
        when v_success then null
        when v_quota_failure then greatest(
          coalesce(ai_gemini_project_model_state.cooldown_until, v_cooldown_until),
          v_cooldown_until
        )
        else ai_gemini_project_model_state.cooldown_until
      end,
      last_success_at = case when v_success then now() else ai_gemini_project_model_state.last_success_at end,
      last_quota_failure_at = case when v_quota_failure then now() else ai_gemini_project_model_state.last_quota_failure_at end,
      last_status = coalesce(p_status, ai_gemini_project_model_state.last_status),
      updated_at = now();
  end if;

  return true;
end;
$$;

create or replace function public.inspect_gemini_api_key_availability(
  p_provider text,
  p_model text,
  p_candidate_fingerprints text[],
  p_excluded_fingerprints text[] default array[]::text[]
)
returns table (
  configured_count integer,
  excluded_count integer,
  inactive_count integer,
  disabled_count integer,
  leased_count integer,
  cooldown_count integer,
  eligible_count integer,
  next_eligible_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select
      pool.key_fingerprint,
      pool.is_active,
      pool.is_disabled,
      pool.key_fingerprint = any(coalesce(p_excluded_fingerprints, array[]::text[])) as is_excluded,
      coalesce(pool.lease_expires_at, now()) as lease_until,
      greatest(
        coalesce(model_state.cooldown_until, now()),
        coalesce(project_state.cooldown_until, now())
      ) as cooldown_until
    from public.ai_gemini_key_pool as pool
    left join public.ai_gemini_key_model_state as model_state
      on model_state.provider = pool.provider
      and model_state.key_fingerprint = pool.key_fingerprint
      and model_state.model = p_model
    left join public.ai_gemini_project_model_state as project_state
      on project_state.provider = pool.provider
      and project_state.project_id = pool.project_id
      and project_state.model = p_model
    where pool.provider = p_provider
      and pool.key_fingerprint = any(coalesce(p_candidate_fingerprints, array[]::text[]))
  ), classified as (
    select candidates.*, greatest(candidates.lease_until, candidates.cooldown_until) as ready_at
    from candidates
  )
  select
    count(*)::integer,
    count(*) filter (where is_excluded)::integer,
    count(*) filter (where not is_excluded and not is_active)::integer,
    count(*) filter (where not is_excluded and is_active and is_disabled)::integer,
    count(*) filter (
      where not is_excluded and is_active and not is_disabled and lease_until > now()
    )::integer,
    count(*) filter (
      where not is_excluded and is_active and not is_disabled
        and lease_until <= now() and cooldown_until > now()
    )::integer,
    count(*) filter (
      where not is_excluded and is_active and not is_disabled
        and lease_until <= now() and cooldown_until <= now()
    )::integer,
    min(ready_at) filter (
      where not is_excluded and is_active and not is_disabled and ready_at > now()
    )
  from classified;
$$;

revoke all on function public.sync_gemini_api_key_pool(text, jsonb) from public;
revoke all on function public.claim_gemini_api_key(text, text, text[], text[], text, integer) from public;
revoke all on function public.report_gemini_api_key_result(text, text, text, text, uuid, text, integer, text, integer) from public;
revoke all on function public.inspect_gemini_api_key_availability(text, text, text[], text[]) from public;
revoke all on function public.inspect_gemini_api_key_availability(text, text, text[], text[]) from anon;
revoke all on function public.inspect_gemini_api_key_availability(text, text, text[], text[]) from authenticated;

grant execute on function public.sync_gemini_api_key_pool(text, jsonb) to service_role;
grant execute on function public.claim_gemini_api_key(text, text, text[], text[], text, integer) to service_role;
grant execute on function public.report_gemini_api_key_result(text, text, text, text, uuid, text, integer, text, integer) to service_role;
grant execute on function public.inspect_gemini_api_key_availability(text, text, text[], text[]) to service_role;

comment on column public.provider_credentials_vault.google_project_id is
  'Optional Google project identifier used to coordinate Gemini quota across keys in the same project.';
comment on table public.ai_gemini_project_model_state is
  'Project/model quota cooldowns prevent redundant key rotation after Gemini returns 429 for a known Google project.';

commit;
