-- Exposes safe, aggregate Gemini key availability to the service-role coordinator.
-- Raw keys and fingerprints are never returned by this diagnostic function.

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
      coalesce(model_state.cooldown_until, now()) as cooldown_until
    from public.ai_gemini_key_pool as pool
    left join public.ai_gemini_key_model_state as model_state
      on model_state.provider = pool.provider
      and model_state.key_fingerprint = pool.key_fingerprint
      and model_state.model = p_model
    where pool.provider = p_provider
      and pool.key_fingerprint = any(coalesce(p_candidate_fingerprints, array[]::text[]))
  ), classified as (
    select
      candidates.*,
      greatest(candidates.lease_until, candidates.cooldown_until) as ready_at
    from candidates
  )
  select
    count(*)::integer as configured_count,
    count(*) filter (where is_excluded)::integer as excluded_count,
    count(*) filter (where not is_excluded and not is_active)::integer as inactive_count,
    count(*) filter (
      where not is_excluded and is_active and is_disabled
    )::integer as disabled_count,
    count(*) filter (
      where not is_excluded
        and is_active
        and not is_disabled
        and lease_until > now()
    )::integer as leased_count,
    count(*) filter (
      where not is_excluded
        and is_active
        and not is_disabled
        and lease_until <= now()
        and cooldown_until > now()
    )::integer as cooldown_count,
    count(*) filter (
      where not is_excluded
        and is_active
        and not is_disabled
        and lease_until <= now()
        and cooldown_until <= now()
    )::integer as eligible_count,
    min(ready_at) filter (
      where not is_excluded
        and is_active
        and not is_disabled
        and ready_at > now()
    ) as next_eligible_at
  from classified;
$$;

revoke all on function public.inspect_gemini_api_key_availability(text, text, text[], text[]) from public;
revoke all on function public.inspect_gemini_api_key_availability(text, text, text[], text[]) from anon;
revoke all on function public.inspect_gemini_api_key_availability(text, text, text[], text[]) from authenticated;
grant execute on function public.inspect_gemini_api_key_availability(text, text, text[], text[]) to service_role;

comment on function public.inspect_gemini_api_key_availability(text, text, text[], text[]) is
  'Returns aggregate availability and the earliest temporary release time for candidate Gemini keys without exposing key identities.';
