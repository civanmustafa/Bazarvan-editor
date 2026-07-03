-- Phase 4/5: online system settings, activity events, and session records.

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  description text,
  is_secret boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  user_agent text,
  path text,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.app_activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  session_id uuid references public.app_sessions(id) on delete set null,
  event_type text not null,
  entity_type text,
  entity_id text,
  path text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists app_sessions_user_id_idx on public.app_sessions(user_id);
create index if not exists app_sessions_last_seen_idx on public.app_sessions(last_seen_at desc);
create index if not exists app_activity_events_user_id_idx on public.app_activity_events(user_id);
create index if not exists app_activity_events_session_id_idx on public.app_activity_events(session_id);
create index if not exists app_activity_events_created_at_idx on public.app_activity_events(created_at desc);
create index if not exists app_activity_events_event_type_idx on public.app_activity_events(event_type);
create index if not exists app_activity_events_entity_idx on public.app_activity_events(entity_type, entity_id);

drop trigger if exists set_app_settings_updated_at on public.app_settings;
create trigger set_app_settings_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

alter table public.app_settings enable row level security;
alter table public.app_sessions enable row level security;
alter table public.app_activity_events enable row level security;

drop policy if exists "app_settings_admin_select" on public.app_settings;
create policy "app_settings_admin_select"
on public.app_settings
for select
to authenticated
using (public.is_admin() and is_secret is not true);

drop policy if exists "app_settings_admin_insert" on public.app_settings;
create policy "app_settings_admin_insert"
on public.app_settings
for insert
to authenticated
with check (public.is_admin() and is_secret is not true);

drop policy if exists "app_settings_admin_update" on public.app_settings;
create policy "app_settings_admin_update"
on public.app_settings
for update
to authenticated
using (public.is_admin() and is_secret is not true)
with check (public.is_admin() and is_secret is not true);

drop policy if exists "app_sessions_select_self_or_admin" on public.app_sessions;
create policy "app_sessions_select_self_or_admin"
on public.app_sessions
for select
to authenticated
using (public.is_admin() or user_id = auth.uid());

drop policy if exists "app_sessions_insert_self" on public.app_sessions;
create policy "app_sessions_insert_self"
on public.app_sessions
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "app_sessions_update_self_or_admin" on public.app_sessions;
create policy "app_sessions_update_self_or_admin"
on public.app_sessions
for update
to authenticated
using (public.is_admin() or user_id = auth.uid())
with check (public.is_admin() or user_id = auth.uid());

drop policy if exists "app_activity_events_select_self_or_admin" on public.app_activity_events;
create policy "app_activity_events_select_self_or_admin"
on public.app_activity_events
for select
to authenticated
using (public.is_admin() or user_id = auth.uid());

drop policy if exists "app_activity_events_insert_self" on public.app_activity_events;
create policy "app_activity_events_insert_self"
on public.app_activity_events
for insert
to authenticated
with check (user_id = auth.uid());

revoke all on public.app_settings from anon;
revoke all on public.app_sessions from anon;
revoke all on public.app_activity_events from anon;

grant select, insert, update on public.app_settings to authenticated;
grant select, insert, update on public.app_sessions to authenticated;
grant select, insert on public.app_activity_events to authenticated;

insert into public.app_settings (key, value, description, is_secret)
values
  (
    'ai',
    '{
      "geminiFreeEnabled": true,
      "geminiProEnabled": true,
      "openAiEnabled": false,
      "defaultProvider": "gemini",
      "defaultGeminiModel": "gemini-2.5-flash",
      "defaultGeminiPaidModel": "gemini-2.5-pro",
      "defaultOpenAiModel": "gpt-4.1-mini"
    }'::jsonb,
    'Non-secret AI defaults. Secret API keys remain server environment variables.',
    false
  ),
  (
    'n8n',
    '{
      "enabled": true,
      "defaultVisibility": "public",
      "defaultAccessRole": "editor",
      "autoRunAssignedAutomation": true
    }'::jsonb,
    'Non-secret n8n behavior defaults.',
    false
  ),
  (
    'articles',
    '{
      "defaultStatus": "draft",
      "defaultVisibility": "public",
      "defaultLanguage": "ar",
      "trashRetentionDays": 30
    }'::jsonb,
    'Default article values and trash retention.',
    false
  ),
  (
    'roles',
    '{
      "adminCanSeeAll": true,
      "usersCanClaimPublicArticles": true,
      "usersCanSeeOnlyAssignedAfterClaim": true
    }'::jsonb,
    'Role behavior flags surfaced in settings.',
    false
  ),
  (
    'system',
    '{
      "timezone": "Europe/Istanbul",
      "publicEditorUrl": "",
      "dailyReportEnabled": true,
      "activityTrackingEnabled": true
    }'::jsonb,
    'System-wide non-secret settings.',
    false
  )
on conflict (key) do nothing;

comment on table public.app_settings is 'Admin-editable non-secret application settings. Secret keys stay on the server.';
comment on table public.app_sessions is 'Open browser/app sessions for direct admin inspection.';
comment on table public.app_activity_events is 'Auditable user and system activity for admin reports.';
