begin;

create table if not exists public.user_ai_provider_secrets (
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  ciphertext text not null,
  initialization_vector text not null,
  authentication_tag text not null,
  encryption_version smallint not null default 1,
  enabled boolean not null default true,
  key_count smallint not null,
  key_suffixes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  constraint user_ai_provider_secrets_provider_check
    check (provider in ('gemini_free', 'gemini_paid', 'openai_paid')),
  constraint user_ai_provider_secrets_encryption_version_check
    check (encryption_version = 1),
  constraint user_ai_provider_secrets_key_count_check
    check (key_count between 1 and 20),
  constraint user_ai_provider_secrets_key_suffixes_check
    check (
      jsonb_typeof(key_suffixes) = 'array'
      and jsonb_array_length(key_suffixes) = key_count
    )
);

comment on table public.user_ai_provider_secrets is
  'Server-only encrypted API key lists owned by individual Bazarvan users.';
comment on column public.user_ai_provider_secrets.ciphertext is
  'AES-256-GCM ciphertext. Plain API keys are never exposed to browser database roles.';
comment on column public.user_ai_provider_secrets.key_suffixes is
  'Non-secret final four characters returned to the owner after keys are stored.';

alter table public.user_ai_provider_secrets enable row level security;

-- Deliberately keep this table inaccessible to browsers. The authenticated API
-- uses the service role, derives user_id from the verified token, and never
-- accepts a user_id supplied by the browser.
revoke all on table public.user_ai_provider_secrets from public;
revoke all on table public.user_ai_provider_secrets from anon;
revoke all on table public.user_ai_provider_secrets from authenticated;
grant select, insert, update, delete on table public.user_ai_provider_secrets to service_role;

commit;
