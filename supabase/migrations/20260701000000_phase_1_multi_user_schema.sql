-- Phase 1: Supabase multi-user schema for Bazarvan Editor.
-- Run this file in the Supabase SQL Editor, or with `supabase db push`.

create extension if not exists pgcrypto;

do $$
begin
  create type public.app_role as enum ('admin', 'user');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role public.app_role not null default 'user',
  avatar_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  assigned_to uuid references public.profiles(id) on delete set null,
  source text not null default 'manual' check (source in ('manual', 'n8n', 'import', 'system')),
  visibility text not null default 'private' check (visibility in ('private', 'shared', 'team', 'public')),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'published', 'archived')),
  title text not null default '(untitled)',
  slug text,
  content_json jsonb not null default '{}'::jsonb,
  content_html text,
  plain_text text not null default '',
  keywords jsonb not null default '{"primary":"","secondaries":[],"company":"","lsi":[]}'::jsonb,
  goal_context jsonb not null default '{}'::jsonb,
  article_language text not null default 'ar' check (article_language in ('ar', 'en')),
  analysis jsonb,
  stats jsonb not null default '{
    "wordCount":0,
    "keywordViolations":0,
    "violatingCriteriaCount":0,
    "totalErrorsCount":0,
    "keywordDuplicatesCount":0,
    "totalDuplicates":0,
    "commonDuplicatesCount":0,
    "uniqueWordsPercentage":0
  }'::jsonb,
  time_spent_seconds integer not null default 0 check (time_spent_seconds >= 0),
  save_count integer not null default 0 check (save_count >= 0),
  n8n_workflow_id text,
  n8n_execution_id text,
  external_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_saved_at timestamptz not null default now()
);

create table if not exists public.article_versions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  title text not null default '(untitled)',
  content_json jsonb not null default '{}'::jsonb,
  content_html text,
  plain_text text not null default '',
  keywords jsonb not null default '{}'::jsonb,
  goal_context jsonb not null default '{}'::jsonb,
  analysis jsonb,
  stats jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now(),
  unique (article_id, version_number)
);

create table if not exists public.n8n_ingest_logs (
  id uuid primary key default gen_random_uuid(),
  article_id uuid references public.articles(id) on delete set null,
  workflow_id text,
  execution_id text,
  external_id text,
  status text not null default 'received' check (status in ('received', 'imported', 'rejected', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists articles_owner_id_idx on public.articles(owner_id);
create index if not exists articles_created_by_idx on public.articles(created_by);
create index if not exists articles_assigned_to_idx on public.articles(assigned_to);
create index if not exists articles_visibility_idx on public.articles(visibility);
create index if not exists articles_status_idx on public.articles(status);
create index if not exists articles_source_idx on public.articles(source);
create index if not exists articles_last_saved_at_idx on public.articles(last_saved_at desc);
create index if not exists articles_updated_at_idx on public.articles(updated_at desc);
create index if not exists articles_keywords_gin_idx on public.articles using gin(keywords);
create index if not exists articles_goal_context_gin_idx on public.articles using gin(goal_context);
create index if not exists articles_stats_gin_idx on public.articles using gin(stats);
create unique index if not exists articles_source_external_id_unique_idx
  on public.articles(source, external_id)
  where external_id is not null;
create index if not exists article_versions_article_id_idx on public.article_versions(article_id, version_number desc);
create index if not exists n8n_ingest_logs_status_idx on public.n8n_ingest_logs(status);
create index if not exists n8n_ingest_logs_created_at_idx on public.n8n_ingest_logs(created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    'user'
  )
  on conflict (id) do update
  set
    email = excluded.email,
    full_name = coalesce(public.profiles.full_name, excluded.full_name),
    updated_at = now();

  return new;
end;
$$;

create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
    and p.is_active = true
  limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = 'admin'::public.app_role, false);
$$;

create or replace function public.protect_profile_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and auth.uid() = old.id
     and not public.is_admin()
     and (
       new.role is distinct from old.role
       or new.is_active is distinct from old.is_active
       or new.email is distinct from old.email
     ) then
    raise exception 'Only admins can change profile role, active status, or email.';
  end if;

  return new;
end;
$$;

create or replace function public.prepare_article_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.created_by is null and auth.uid() is not null then
      new.created_by = auth.uid();
    end if;

    if new.owner_id is null and auth.uid() is not null and new.visibility = 'private' then
      new.owner_id = auth.uid();
    end if;

    if new.last_saved_at is null then
      new.last_saved_at = now();
    end if;
  end if;

  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.protect_article_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and auth.uid() is not null
     and not public.is_admin()
     and (
       new.owner_id is distinct from old.owner_id
       or new.created_by is distinct from old.created_by
       or new.assigned_to is distinct from old.assigned_to
       or new.source is distinct from old.source
       or new.visibility is distinct from old.visibility
       or new.external_id is distinct from old.external_id
       or new.n8n_workflow_id is distinct from old.n8n_workflow_id
       or new.n8n_execution_id is distinct from old.n8n_execution_id
     ) then
    raise exception 'Only admins can change article ownership, visibility, source, assignment, or external IDs.';
  end if;

  return new;
end;
$$;

create or replace function public.can_read_article(target_article_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.articles a
    where a.id = target_article_id
      and (
        public.is_admin()
        or a.owner_id = auth.uid()
        or a.created_by = auth.uid()
        or a.assigned_to = auth.uid()
        or a.visibility in ('shared', 'public')
      )
  );
$$;

create or replace function public.can_write_article(target_article_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.articles a
    where a.id = target_article_id
      and (
        public.is_admin()
        or a.owner_id = auth.uid()
        or a.assigned_to = auth.uid()
      )
  );
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists protect_profile_admin_fields on public.profiles;
create trigger protect_profile_admin_fields
before update on public.profiles
for each row execute function public.protect_profile_admin_fields();

drop trigger if exists prepare_article_row on public.articles;
create trigger prepare_article_row
before insert or update on public.articles
for each row execute function public.prepare_article_row();

drop trigger if exists protect_article_admin_fields on public.articles;
create trigger protect_article_admin_fields
before update on public.articles
for each row execute function public.protect_article_admin_fields();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.articles enable row level security;
alter table public.article_versions enable row level security;
alter table public.n8n_ingest_logs enable row level security;

drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "profiles_update_self_or_admin" on public.profiles;
create policy "profiles_update_self_or_admin"
on public.profiles
for update
to authenticated
using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

drop policy if exists "articles_select_visible" on public.articles;
create policy "articles_select_visible"
on public.articles
for select
to authenticated
using (
  public.is_admin()
  or owner_id = auth.uid()
  or created_by = auth.uid()
  or assigned_to = auth.uid()
  or visibility in ('shared', 'public')
);

drop policy if exists "articles_insert_own_private_manual" on public.articles;
create policy "articles_insert_own_private_manual"
on public.articles
for insert
to authenticated
with check (
  public.is_admin()
  or (
    owner_id = auth.uid()
    and created_by = auth.uid()
    and visibility = 'private'
    and source = 'manual'
  )
);

drop policy if exists "articles_update_owner_assignee_or_admin" on public.articles;
create policy "articles_update_owner_assignee_or_admin"
on public.articles
for update
to authenticated
using (public.is_admin() or owner_id = auth.uid() or assigned_to = auth.uid())
with check (public.is_admin() or owner_id = auth.uid() or assigned_to = auth.uid());

drop policy if exists "articles_delete_owner_or_admin" on public.articles;
create policy "articles_delete_owner_or_admin"
on public.articles
for delete
to authenticated
using (public.is_admin() or owner_id = auth.uid());

drop policy if exists "article_versions_select_visible_article" on public.article_versions;
create policy "article_versions_select_visible_article"
on public.article_versions
for select
to authenticated
using (public.can_read_article(article_id));

drop policy if exists "article_versions_insert_writable_article" on public.article_versions;
create policy "article_versions_insert_writable_article"
on public.article_versions
for insert
to authenticated
with check (public.can_write_article(article_id));

drop policy if exists "article_versions_delete_admin" on public.article_versions;
create policy "article_versions_delete_admin"
on public.article_versions
for delete
to authenticated
using (public.is_admin());

drop policy if exists "n8n_ingest_logs_admin_select" on public.n8n_ingest_logs;
create policy "n8n_ingest_logs_admin_select"
on public.n8n_ingest_logs
for select
to authenticated
using (public.is_admin());

drop policy if exists "n8n_ingest_logs_admin_insert" on public.n8n_ingest_logs;
create policy "n8n_ingest_logs_admin_insert"
on public.n8n_ingest_logs
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "n8n_ingest_logs_admin_update" on public.n8n_ingest_logs;
create policy "n8n_ingest_logs_admin_update"
on public.n8n_ingest_logs
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "n8n_ingest_logs_admin_delete" on public.n8n_ingest_logs;
create policy "n8n_ingest_logs_admin_delete"
on public.n8n_ingest_logs
for delete
to authenticated
using (public.is_admin());

revoke all on public.profiles from anon;
revoke all on public.articles from anon;
revoke all on public.article_versions from anon;
revoke all on public.n8n_ingest_logs from anon;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.articles to authenticated;
grant select, insert, delete on public.article_versions to authenticated;
grant select, insert, update, delete on public.n8n_ingest_logs to authenticated;

grant execute on function public.current_user_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.can_read_article(uuid) to authenticated;
grant execute on function public.can_write_article(uuid) to authenticated;

comment on table public.profiles is 'Application profile for each Supabase Auth user. Admins are marked by role.';
comment on table public.articles is 'Central article store for manual editor saves, shared articles, and n8n imports.';
comment on table public.article_versions is 'Optional article snapshots for important saves or review checkpoints.';
comment on table public.n8n_ingest_logs is 'Audit log for articles received from n8n webhooks or imports.';
