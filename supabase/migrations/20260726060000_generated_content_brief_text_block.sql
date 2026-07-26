begin;

-- The content-brief output contract changed from filling GoalContext fields to
-- returning one independent editable text block. Remove only the saved copy of
-- this incompatible prompt so the version-11 runtime default is used. All other
-- administrator prompt customizations remain untouched.
update public.app_settings
set
  value = jsonb_set(
    jsonb_set(
      value,
      '{templates}',
      case
        when jsonb_typeof(value -> 'templates') = 'object'
          then (value -> 'templates') - 'contentWriting.contentBriefGeneration'
        else '{}'::jsonb
      end,
      true
    ),
    '{registryVersion}',
    '11'::jsonb,
    true
  ),
  updated_at = now()
where key = 'prompts'
  and jsonb_typeof(value) = 'object';

commit;
