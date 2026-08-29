begin;

-- One server-only vault now owns every provider API credential. The former
-- tables are deliberately retained during this compatibility release; their
-- encrypted rows are copied without decrypting or deleting any data.
create table if not exists public.provider_credentials_vault (
  id uuid primary key default gen_random_uuid(),
  vault_key text not null unique,
  credential_type text not null,
  provider text not null,
  purpose text not null default 'default',
  owner_user_id uuid references public.profiles(id) on delete cascade,
  label text not null,
  ciphertext text not null,
  initialization_vector text not null,
  authentication_tag text not null,
  encryption_version smallint not null default 1,
  encryption_context text not null,
  encryption_key_source text not null default 'vault',
  payload_format text not null default 'json_list',
  enabled boolean not null default true,
  key_count smallint not null,
  key_suffixes jsonb not null default '[]'::jsonb,
  expires_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  legacy_source_table text,
  legacy_source_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_credentials_vault_key_check
    check (char_length(btrim(vault_key)) between 1 and 240),
  constraint provider_credentials_vault_type_check
    check (credential_type in ('personal', 'shared')),
  constraint provider_credentials_vault_provider_check
    check (provider in ('gemini_free', 'gemini_paid', 'openai', 'firecrawl', 'browserless')),
  constraint provider_credentials_vault_purpose_check
    check (purpose in ('default', 'content_writing_resume')),
  constraint provider_credentials_vault_owner_check
    check (
      (credential_type = 'personal' and owner_user_id is not null)
      or (credential_type = 'shared' and owner_user_id is null)
    ),
  constraint provider_credentials_vault_label_check
    check (char_length(btrim(label)) between 1 and 160),
  constraint provider_credentials_vault_encryption_version_check
    check (encryption_version = 1),
  constraint provider_credentials_vault_key_source_check
    check (encryption_key_source in (
      'vault',
      'legacy_ai_settings',
      'legacy_crawler_settings',
      'legacy_provider_access'
    )),
  constraint provider_credentials_vault_payload_format_check
    check (payload_format in ('json_list', 'single')),
  constraint provider_credentials_vault_key_count_check
    check (key_count between 1 and 20),
  constraint provider_credentials_vault_key_suffixes_check
    check (
      jsonb_typeof(key_suffixes) = 'array'
      and jsonb_array_length(key_suffixes) = key_count
    )
);

create index if not exists provider_credentials_vault_shared_idx
  on public.provider_credentials_vault(provider, enabled, updated_at desc)
  where credential_type = 'shared';

create index if not exists provider_credentials_vault_personal_idx
  on public.provider_credentials_vault(owner_user_id, provider, enabled)
  where credential_type = 'personal';

comment on table public.provider_credentials_vault is
  'Canonical server-only AES-256-GCM vault for administrator-assigned and user-owned provider API keys.';
comment on column public.provider_credentials_vault.encryption_context is
  'Authenticated-data context retained during non-destructive migration so legacy ciphertext remains decryptable.';
comment on column public.provider_credentials_vault.encryption_key_source is
  'Compatibility marker for the former master-key namespace; every newly saved value uses vault.';

-- Existing centrally assigned credentials retain their UUIDs, so every grant
-- continues to point at the same logical secret after the foreign key moves.
insert into public.provider_credentials_vault (
  id,
  vault_key,
  credential_type,
  provider,
  purpose,
  owner_user_id,
  label,
  ciphertext,
  initialization_vector,
  authentication_tag,
  encryption_version,
  encryption_context,
  encryption_key_source,
  payload_format,
  enabled,
  key_count,
  key_suffixes,
  expires_at,
  created_by,
  updated_by,
  legacy_source_table,
  legacy_source_key,
  created_at,
  updated_at
)
select
  credential.id,
  'shared:' || credential.id::text,
  'shared',
  credential.provider,
  'default',
  null,
  credential.label,
  credential.ciphertext,
  credential.initialization_vector,
  credential.authentication_tag,
  credential.encryption_version,
  'bazarvan:provider_shared_credentials:' || credential.id::text || ':' || credential.provider || ':v1',
  'legacy_provider_access',
  'json_list',
  credential.enabled,
  credential.key_count,
  credential.key_suffixes,
  credential.expires_at,
  credential.created_by,
  credential.updated_by,
  'provider_shared_credentials',
  credential.id::text,
  credential.created_at,
  credential.updated_at
from public.provider_shared_credentials credential
on conflict (vault_key) do nothing;

-- Personal keys remain owned by exactly one account. openai_paid is the former
-- storage label for the canonical openai provider.
insert into public.provider_credentials_vault (
  vault_key,
  credential_type,
  provider,
  purpose,
  owner_user_id,
  label,
  ciphertext,
  initialization_vector,
  authentication_tag,
  encryption_version,
  encryption_context,
  encryption_key_source,
  payload_format,
  enabled,
  key_count,
  key_suffixes,
  created_by,
  updated_by,
  legacy_source_table,
  legacy_source_key,
  created_at,
  updated_at
)
select
  'personal:' || secret.user_id::text || ':' ||
    case when secret.provider = 'openai_paid' then 'openai' else secret.provider end,
  'personal',
  case when secret.provider = 'openai_paid' then 'openai' else secret.provider end,
  'default',
  secret.user_id,
  'Personal ' || secret.provider,
  secret.ciphertext,
  secret.initialization_vector,
  secret.authentication_tag,
  secret.encryption_version,
  'bazarvan:user_ai_provider_secrets:' || secret.user_id::text || ':' || secret.provider || ':v1',
  'legacy_ai_settings',
  'json_list',
  secret.enabled,
  secret.key_count,
  secret.key_suffixes,
  secret.user_id,
  secret.user_id,
  'user_ai_provider_secrets',
  secret.user_id::text || ':' || secret.provider,
  secret.created_at,
  secret.updated_at
from public.user_ai_provider_secrets secret
on conflict (vault_key) do nothing;

-- Former standalone administrator AI secrets become ordinary shared
-- credentials and receive an explicit all-users grant. Administrators can
-- later replace that grant with one or more user-specific grants in the
-- existing provider-access panel.
insert into public.provider_credentials_vault (
  vault_key,
  credential_type,
  provider,
  purpose,
  owner_user_id,
  label,
  ciphertext,
  initialization_vector,
  authentication_tag,
  encryption_version,
  encryption_context,
  encryption_key_source,
  payload_format,
  enabled,
  key_count,
  key_suffixes,
  created_by,
  updated_by,
  legacy_source_table,
  legacy_source_key,
  created_at,
  updated_at
)
select
  'legacy-admin-ai:' || secret.provider,
  'shared',
  case
    when secret.provider in ('gemini_latest', 'content_writing_resume_gemini_paid') then 'gemini_paid'
    when secret.provider = 'content_writing_resume_gemini' then 'gemini_free'
    else 'openai'
  end,
  case when secret.provider like 'content_writing_resume_%'
    then 'content_writing_resume'
    else 'default'
  end,
  null,
  case
    when secret.provider = 'openai_latest' then 'Legacy administrator OpenAI'
    when secret.provider = 'gemini_latest' then 'Legacy administrator Gemini paid'
    else 'Legacy content-writing resume ' || secret.provider
  end,
  secret.ciphertext,
  secret.initialization_vector,
  secret.authentication_tag,
  secret.encryption_version,
  'bazarvan:ai_provider_secrets:' || secret.provider || ':v1',
  'legacy_ai_settings',
  'single',
  secret.enabled,
  1,
  jsonb_build_array(secret.key_suffix),
  secret.updated_by,
  secret.updated_by,
  'ai_provider_secrets',
  secret.provider,
  secret.created_at,
  secret.updated_at
from public.ai_provider_secrets secret
on conflict (vault_key) do nothing;

-- Former crawler administrator secrets are handled exactly like the AI
-- administrator credentials: shared vault row plus explicit all-users grant.
insert into public.provider_credentials_vault (
  vault_key,
  credential_type,
  provider,
  purpose,
  owner_user_id,
  label,
  ciphertext,
  initialization_vector,
  authentication_tag,
  encryption_version,
  encryption_context,
  encryption_key_source,
  payload_format,
  enabled,
  key_count,
  key_suffixes,
  created_by,
  updated_by,
  legacy_source_table,
  legacy_source_key,
  created_at,
  updated_at
)
select
  'legacy-admin-crawler:' || secret.provider,
  'shared',
  secret.provider,
  'default',
  null,
  'Legacy administrator ' || secret.provider,
  secret.ciphertext,
  secret.initialization_vector,
  secret.authentication_tag,
  secret.encryption_version,
  'bazarvan:crawler_provider_secrets:' || secret.provider || ':v1',
  'legacy_crawler_settings',
  'single',
  secret.enabled,
  1,
  jsonb_build_array(secret.key_suffix),
  secret.updated_by,
  secret.updated_by,
  'crawler_provider_secrets',
  secret.provider,
  secret.created_at,
  secret.updated_at
from public.crawler_provider_secrets secret
on conflict (vault_key) do nothing;

-- Grants now target the canonical vault. No grant is deleted and existing
-- shared credential IDs were preserved above.
alter table public.provider_credential_grants
  drop constraint if exists provider_credential_grants_credential_id_fkey;

alter table public.provider_credential_grants
  add constraint provider_credential_grants_credential_id_fkey
  foreign key (credential_id)
  references public.provider_credentials_vault(id)
  on delete cascade;

insert into public.provider_credential_grants (
  credential_id,
  scope,
  user_id,
  priority,
  enabled,
  created_by,
  created_at,
  updated_at
)
select
  credential.id,
  'all',
  null,
  100,
  true,
  credential.updated_by,
  credential.created_at,
  credential.updated_at
from public.provider_credentials_vault credential
where credential.credential_type = 'shared'
  and credential.legacy_source_table in ('ai_provider_secrets', 'crawler_provider_secrets')
on conflict do nothing;

alter table public.provider_credentials_vault enable row level security;
revoke all on table public.provider_credentials_vault from public, anon, authenticated;
grant select, insert, update, delete on table public.provider_credentials_vault to service_role;

commit;
