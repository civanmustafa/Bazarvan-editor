begin;

insert into public.app_settings (
  key,
  value,
  description,
  is_secret
) values (
  'prompts',
  '{
    "registryVersion": 1,
    "templates": {}
  }'::jsonb,
  'Global administrator-managed engineering prompt registry. Runtime code supplies versioned Arabic defaults for templates that are not overridden here.',
  false
)
on conflict (key) do update
set
  value = jsonb_build_object(
    'registryVersion',
    1,
    'templates',
    case
      when jsonb_typeof(public.app_settings.value -> 'templates') = 'object'
        then public.app_settings.value -> 'templates'
      else '{}'::jsonb
    end
  ),
  description = excluded.description,
  is_secret = false,
  updated_at = now();

commit;
