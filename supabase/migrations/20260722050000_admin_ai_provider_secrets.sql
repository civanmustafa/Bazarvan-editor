begin;

create table if not exists public.ai_provider_secrets (
  provider text primary key,
  ciphertext text not null,
  initialization_vector text not null,
  authentication_tag text not null,
  encryption_version smallint not null default 1,
  enabled boolean not null default false,
  key_suffix text not null,
  updated_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_provider_secrets_provider_check
    check (provider in ('openai_latest', 'gemini_latest')),
  constraint ai_provider_secrets_encryption_version_check
    check (encryption_version = 1),
  constraint ai_provider_secrets_key_suffix_check
    check (key_suffix ~ '^[^[:space:]]{4}$')
);

comment on table public.ai_provider_secrets is
  'Server-only AES-256-GCM encrypted administrator overrides for paid AI providers.';
comment on column public.ai_provider_secrets.key_suffix is
  'Non-secret final four characters shown to administrators after a key is stored.';

alter table public.ai_provider_secrets enable row level security;

-- Browser roles never read this table, including encrypted values. The server uses
-- SUPABASE_SERVICE_ROLE_KEY and performs its own authenticated administrator check.
revoke all on table public.ai_provider_secrets from public;
revoke all on table public.ai_provider_secrets from anon;
revoke all on table public.ai_provider_secrets from authenticated;
grant select, insert, update, delete on table public.ai_provider_secrets to service_role;

commit;
