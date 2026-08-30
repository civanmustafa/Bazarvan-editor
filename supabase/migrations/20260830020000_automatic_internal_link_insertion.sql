-- Automatic, high-confidence internal-link insertion in the editor.
-- Apply after 20260830010000_reconcile_automatic_competitor_extraction.sql.
--
-- The editor reads this non-secret switch through a narrow authenticated API.
-- app_settings itself remains administrator-only, so this migration does not
-- broaden RLS or expose any other system setting to ordinary users.

insert into public.app_settings (
  key,
  value,
  description,
  is_secret
)
values (
  'system',
  jsonb_build_object('autoApplyStrongInternalLinkSuggestions', true),
  'Administrator-owned non-secret system and editor automation settings.',
  false
)
on conflict (key) do update
set
  value = coalesce(public.app_settings.value, '{}'::jsonb)
    || jsonb_build_object(
      'autoApplyStrongInternalLinkSuggestions',
      case
        when jsonb_typeof(
          coalesce(public.app_settings.value, '{}'::jsonb)
            -> 'autoApplyStrongInternalLinkSuggestions'
        ) = 'boolean'
          then (
            public.app_settings.value
              ->> 'autoApplyStrongInternalLinkSuggestions'
          )::boolean
        else true
      end
    ),
  description = coalesce(
    nullif(btrim(public.app_settings.description), ''),
    excluded.description
  ),
  is_secret = false;

-- The setting is deliberately enabled for existing installations when the
-- field did not exist. A previously stored explicit false value is preserved,
-- making the migration idempotent and respecting an administrator's choice.
-- Runtime safety remains independent from this flag: automatic insertion also
-- requires an absolute allowed target, a known current-page URL, score >= 90,
-- score margin >= 12, an explicit semantic signal, sufficient page data, and
-- one unique unlinked occurrence in the exact paragraph selected by the engine.

comment on table public.app_settings is
  'Administrator-editable non-secret application settings. Narrow runtime APIs expose only explicitly approved non-secret feature flags.';
