begin;

-- Personal secrets now cover crawler providers as well as AI providers. The
-- table remains server-only; no browser role receives direct access.
alter table public.user_ai_provider_secrets
  drop constraint if exists user_ai_provider_secrets_provider_check;

alter table public.user_ai_provider_secrets
  add constraint user_ai_provider_secrets_provider_check
  check (provider in (
    'gemini_free',
    'gemini_paid',
    'openai_paid',
    'firecrawl',
    'browserless'
  ));

comment on table public.user_ai_provider_secrets is
  'Server-only encrypted API key lists owned by individual Bazarvan users for AI and crawler providers.';

create table if not exists public.provider_global_policies (
  provider text primary key,
  enabled boolean not null default true,
  allow_personal_keys boolean not null default true,
  credential_mode text not null default 'personal_first',
  allow_shared_fallback boolean not null default true,
  allow_provider_fallback boolean not null default true,
  default_model text,
  allowed_models jsonb not null default '[]'::jsonb,
  daily_request_limit integer,
  monthly_request_limit integer,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_global_policies_provider_check
    check (provider in ('gemini_free', 'gemini_paid', 'openai', 'firecrawl', 'browserless')),
  constraint provider_global_policies_credential_mode_check
    check (credential_mode in (
      'personal_first', 'assigned_first', 'assigned_only',
      'personal_only', 'global_only', 'disabled'
    )),
  constraint provider_global_policies_allowed_models_check
    check (jsonb_typeof(allowed_models) = 'array'),
  constraint provider_global_policies_daily_limit_check
    check (daily_request_limit is null or daily_request_limit between 1 and 1000000),
  constraint provider_global_policies_monthly_limit_check
    check (monthly_request_limit is null or monthly_request_limit between 1 and 10000000)
);

insert into public.provider_global_policies (provider)
values
  ('gemini_free'),
  ('gemini_paid'),
  ('openai'),
  ('firecrawl'),
  ('browserless')
on conflict (provider) do nothing;

create table if not exists public.user_provider_policies (
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  enabled_override boolean,
  allow_personal_keys_override boolean,
  credential_mode_override text,
  allow_shared_fallback_override boolean,
  allow_provider_fallback_override boolean,
  default_model_override text,
  allowed_models_override jsonb,
  daily_request_limit_override integer,
  monthly_request_limit_override integer,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  constraint user_provider_policies_provider_check
    check (provider in ('gemini_free', 'gemini_paid', 'openai', 'firecrawl', 'browserless')),
  constraint user_provider_policies_credential_mode_check
    check (
      credential_mode_override is null
      or credential_mode_override in (
        'personal_first', 'assigned_first', 'assigned_only',
        'personal_only', 'global_only', 'disabled'
      )
    ),
  constraint user_provider_policies_allowed_models_check
    check (allowed_models_override is null or jsonb_typeof(allowed_models_override) = 'array'),
  constraint user_provider_policies_daily_limit_check
    check (daily_request_limit_override is null or daily_request_limit_override between 1 and 1000000),
  constraint user_provider_policies_monthly_limit_check
    check (monthly_request_limit_override is null or monthly_request_limit_override between 1 and 10000000)
);

create index if not exists user_provider_policies_user_idx
  on public.user_provider_policies(user_id, provider);

create table if not exists public.provider_shared_credentials (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  label text not null,
  ciphertext text not null,
  initialization_vector text not null,
  authentication_tag text not null,
  encryption_version smallint not null default 1,
  enabled boolean not null default true,
  key_count smallint not null,
  key_suffixes jsonb not null default '[]'::jsonb,
  expires_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_shared_credentials_provider_check
    check (provider in ('gemini_free', 'gemini_paid', 'openai', 'firecrawl', 'browserless')),
  constraint provider_shared_credentials_label_check
    check (char_length(btrim(label)) between 1 and 120),
  constraint provider_shared_credentials_encryption_version_check
    check (encryption_version = 1),
  constraint provider_shared_credentials_key_count_check
    check (key_count between 1 and 20),
  constraint provider_shared_credentials_key_suffixes_check
    check (
      jsonb_typeof(key_suffixes) = 'array'
      and jsonb_array_length(key_suffixes) = key_count
    )
);

create index if not exists provider_shared_credentials_provider_idx
  on public.provider_shared_credentials(provider, enabled, updated_at desc);

create table if not exists public.provider_credential_grants (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.provider_shared_credentials(id) on delete cascade,
  scope text not null,
  user_id uuid references public.profiles(id) on delete cascade,
  priority integer not null default 100,
  enabled boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_credential_grants_scope_check
    check (scope in ('all', 'user')),
  constraint provider_credential_grants_scope_user_check
    check (
      (scope = 'all' and user_id is null)
      or (scope = 'user' and user_id is not null)
    ),
  constraint provider_credential_grants_priority_check
    check (priority between 0 and 10000)
);

create unique index if not exists provider_credential_grants_all_unique_idx
  on public.provider_credential_grants(credential_id)
  where scope = 'all';

create unique index if not exists provider_credential_grants_user_unique_idx
  on public.provider_credential_grants(credential_id, user_id)
  where scope = 'user';

create index if not exists provider_credential_grants_user_idx
  on public.provider_credential_grants(user_id, enabled, priority)
  where scope = 'user';

create table if not exists public.provider_request_usage (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  operation text not null default 'request',
  created_at timestamptz not null default now(),
  unique (request_id, user_id, provider),
  constraint provider_request_usage_provider_check
    check (provider in ('gemini_free', 'gemini_paid', 'openai', 'firecrawl', 'browserless')),
  constraint provider_request_usage_operation_check
    check (char_length(btrim(operation)) between 1 and 120)
);

create index if not exists provider_request_usage_quota_idx
  on public.provider_request_usage(user_id, provider, created_at desc);

create table if not exists public.provider_security_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  target_user_id uuid references public.profiles(id) on delete set null,
  provider text,
  action text not null,
  subject_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint provider_security_audit_provider_check
    check (provider is null or provider in ('gemini_free', 'gemini_paid', 'openai', 'firecrawl', 'browserless')),
  constraint provider_security_audit_action_check
    check (char_length(btrim(action)) between 1 and 120),
  constraint provider_security_audit_metadata_check
    check (jsonb_typeof(metadata) = 'object')
);

create index if not exists provider_security_audit_created_idx
  on public.provider_security_audit_events(created_at desc);

create or replace function public.reserve_provider_request(
  p_request_id uuid,
  p_user_id uuid,
  p_provider text,
  p_operation text default 'request',
  p_daily_limit integer default null,
  p_monthly_limit integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_day_start timestamptz := date_trunc('day', v_now at time zone 'Europe/Istanbul') at time zone 'Europe/Istanbul';
  v_month_start timestamptz := date_trunc('month', v_now at time zone 'Europe/Istanbul') at time zone 'Europe/Istanbul';
  v_daily_used integer := 0;
  v_monthly_used integer := 0;
  v_existing boolean := false;
begin
  if p_provider not in ('gemini_free', 'gemini_paid', 'openai', 'firecrawl', 'browserless') then
    raise exception 'Unsupported provider';
  end if;

  if p_daily_limit is not null and p_daily_limit < 1 then
    raise exception 'Invalid daily provider request limit';
  end if;
  if p_monthly_limit is not null and p_monthly_limit < 1 then
    raise exception 'Invalid monthly provider request limit';
  end if;

  -- Serialize quota checks per user/provider so simultaneous workers cannot
  -- overspend the same remaining request.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_provider, 0));

  select exists(
    select 1
    from public.provider_request_usage
    where request_id = p_request_id
      and user_id = p_user_id
      and provider = p_provider
  ) into v_existing;

  select
    count(*) filter (where created_at >= v_day_start),
    count(*) filter (where created_at >= v_month_start)
  into v_daily_used, v_monthly_used
  from public.provider_request_usage
  where user_id = p_user_id
    and provider = p_provider
    and created_at >= v_month_start;

  if v_existing then
    return jsonb_build_object(
      'allowed', true,
      'duplicate', true,
      'dailyUsed', v_daily_used,
      'monthlyUsed', v_monthly_used,
      'dailyLimit', p_daily_limit,
      'monthlyLimit', p_monthly_limit
    );
  end if;

  if (p_daily_limit is not null and v_daily_used >= p_daily_limit)
     or (p_monthly_limit is not null and v_monthly_used >= p_monthly_limit) then
    return jsonb_build_object(
      'allowed', false,
      'duplicate', false,
      'dailyUsed', v_daily_used,
      'monthlyUsed', v_monthly_used,
      'dailyLimit', p_daily_limit,
      'monthlyLimit', p_monthly_limit
    );
  end if;

  insert into public.provider_request_usage (
    request_id,
    user_id,
    provider,
    operation,
    created_at
  ) values (
    p_request_id,
    p_user_id,
    p_provider,
    left(coalesce(nullif(btrim(p_operation), ''), 'request'), 120),
    v_now
  ) on conflict (request_id, user_id, provider) do nothing;

  return jsonb_build_object(
    'allowed', true,
    'duplicate', false,
    'dailyUsed', v_daily_used + 1,
    'monthlyUsed', v_monthly_used + 1,
    'dailyLimit', p_daily_limit,
    'monthlyLimit', p_monthly_limit
  );
end;
$$;

-- These tables intentionally have no browser policies. All access travels
-- through authenticated server APIs that derive the user id from the token.
alter table public.provider_global_policies enable row level security;
alter table public.user_provider_policies enable row level security;
alter table public.provider_shared_credentials enable row level security;
alter table public.provider_credential_grants enable row level security;
alter table public.provider_request_usage enable row level security;
alter table public.provider_security_audit_events enable row level security;

revoke all on table public.provider_global_policies from public, anon, authenticated;
revoke all on table public.user_provider_policies from public, anon, authenticated;
revoke all on table public.provider_shared_credentials from public, anon, authenticated;
revoke all on table public.provider_credential_grants from public, anon, authenticated;
revoke all on table public.provider_request_usage from public, anon, authenticated;
revoke all on table public.provider_security_audit_events from public, anon, authenticated;

grant select, insert, update, delete on table public.provider_global_policies to service_role;
grant select, insert, update, delete on table public.user_provider_policies to service_role;
grant select, insert, update, delete on table public.provider_shared_credentials to service_role;
grant select, insert, update, delete on table public.provider_credential_grants to service_role;
grant select, insert on table public.provider_request_usage to service_role;
grant select, insert on table public.provider_security_audit_events to service_role;

revoke all on function public.reserve_provider_request(uuid, uuid, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_provider_request(uuid, uuid, text, text, integer, integer)
  to service_role;

-- Expand crawler audit metadata to represent personal and assigned keys.
alter table public.crawler_provider_usage_events
  drop constraint if exists crawler_provider_usage_events_credential_source_check;

alter table public.crawler_provider_usage_events
  add constraint crawler_provider_usage_events_credential_source_check
  check (
    credential_source is null
    or credential_source in (
      'user', 'assigned_user', 'assigned_all', 'admin', 'hostinger'
    )
  );

commit;
