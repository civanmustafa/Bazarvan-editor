-- Provider credentials are inert until an administrator grants them explicitly.
--
-- The canonical vault migration copied legacy administrator AI and crawler
-- credentials and created an `all` grant so the deployment would preserve the
-- former behavior. The unified dashboard now makes the grant choice explicit,
-- with "unassigned" as the safe default. Remove only grants that can be proven
-- to have been generated automatically by that migration and never edited
-- afterward. Deliberate grants, user-scoped grants, and grants whose timestamps
-- changed after migration are preserved.

delete from public.provider_credential_grants grant_row
using public.provider_credentials_vault credential
where grant_row.credential_id = credential.id
  and credential.credential_type = 'shared'
  and credential.legacy_source_table in ('ai_provider_secrets', 'crawler_provider_secrets')
  and grant_row.scope = 'all'
  and grant_row.user_id is null
  and grant_row.priority = 100
  and grant_row.enabled = true
  and grant_row.created_by is not distinct from credential.updated_by
  and grant_row.created_at = credential.created_at
  and grant_row.updated_at = credential.updated_at;

comment on table public.provider_credential_grants is
  'Explicit administrator assignments for encrypted shared provider credentials. A vault credential without an enabled grant is intentionally unavailable to every user.';
