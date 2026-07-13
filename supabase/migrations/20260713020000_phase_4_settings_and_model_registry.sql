-- Phase 4: durable per-user preferences and a versioned online settings registry.

create table if not exists public.user_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_preferences_preferences_object_check
    check (jsonb_typeof(preferences) = 'object'),
  constraint user_preferences_schema_version_check
    check (schema_version > 0)
);

drop trigger if exists set_user_preferences_updated_at on public.user_preferences;
create trigger set_user_preferences_updated_at
before update on public.user_preferences
for each row execute function public.set_updated_at();

alter table public.user_preferences enable row level security;

drop policy if exists "user_preferences_select_self" on public.user_preferences;
create policy "user_preferences_select_self"
on public.user_preferences
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "user_preferences_insert_self" on public.user_preferences;
create policy "user_preferences_insert_self"
on public.user_preferences
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "user_preferences_update_self" on public.user_preferences;
create policy "user_preferences_update_self"
on public.user_preferences
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "user_preferences_delete_self" on public.user_preferences;
create policy "user_preferences_delete_self"
on public.user_preferences
for delete
to authenticated
using (user_id = auth.uid());

revoke all on public.user_preferences from anon;
grant select, insert, update, delete on public.user_preferences to authenticated;

create or replace function public.merge_current_user_preferences(p_patch jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_preferences jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Preference patch must be a JSON object.' using errcode = '22023';
  end if;

  insert into public.user_preferences (
    user_id,
    preferences,
    schema_version
  ) values (
    v_user_id,
    jsonb_strip_nulls(p_patch),
    1
  )
  on conflict (user_id) do update
  set
    preferences = jsonb_strip_nulls(
      coalesce(public.user_preferences.preferences, '{}'::jsonb)
      || excluded.preferences
    ),
    schema_version = greatest(public.user_preferences.schema_version, excluded.schema_version),
    updated_at = now()
  returning preferences into v_preferences;

  return v_preferences;
end;
$$;

revoke all on function public.merge_current_user_preferences(jsonb) from public;
grant execute on function public.merge_current_user_preferences(jsonb) to authenticated;

insert into public.app_settings (key, value, description, is_secret)
values (
  'ai',
  '{
    "settingsRegistryVersion": 1,
    "geminiFreeEnabled": true,
    "geminiProEnabled": true,
    "openAiEnabled": false,
    "defaultProvider": "gemini",
    "defaultGeminiModel": "gemini-3.5-flash",
    "geminiFreeModelFallbackEnabled": true,
    "externalAnalysisRetryMinutes": 30,
    "externalAnalysisCommandExecutionMode": "independent_batch",
    "defaultGeminiPaidModel": "gemini-2.5-pro",
    "defaultOpenAiModel": "gpt-4.1-mini"
  }'::jsonb,
  'Versioned non-secret AI system settings. Model definitions are owned by the shared application registry.',
  false
)
on conflict (key) do update
set
  value = excluded.value
    || coalesce(public.app_settings.value, '{}'::jsonb)
    || jsonb_build_object('settingsRegistryVersion', 1),
  description = excluded.description,
  is_secret = false,
  updated_at = now();

comment on table public.user_preferences is
  'Durable cross-device user preferences. Browser storage is only a migration and startup cache.';

comment on function public.merge_current_user_preferences(jsonb) is
  'Atomically merges normalized top-level preference sections for the authenticated user.';
