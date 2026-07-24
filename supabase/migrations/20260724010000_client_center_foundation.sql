-- Client Center phase 1: shared client, domain, assignment, page, and crawl-job foundation.
-- The public website is the future source of link targets; editor articles are intentionally unrelated.

create extension if not exists pgcrypto;

do $$
begin
  create type public.client_assignment_access as enum ('viewer', 'editor');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.client_page_source as enum ('manual', 'csv', 'sitemap');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.client_page_status as enum (
    'pending',
    'crawling',
    'ready',
    'needs_review',
    'redirected',
    'noindex',
    'deleted',
    'blocked',
    'failed'
  );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.client_crawl_job_status as enum (
    'queued',
    'running',
    'retry_scheduled',
    'completed',
    'failed',
    'cancelled'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 160),
  legal_name text check (legal_name is null or char_length(btrim(legal_name)) between 2 and 240),
  country text check (country is null or char_length(btrim(country)) between 2 and 120),
  default_language text not null default 'ar'
    check (default_language = lower(default_language) and default_language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
  industry text check (industry is null or char_length(btrim(industry)) between 2 and 200),
  company_summary text check (company_summary is null or char_length(company_summary) <= 4000),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_domains (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  hostname text not null
    check (
      hostname = lower(btrim(hostname))
      and char_length(hostname) between 3 and 253
      and hostname !~ '[/\\:@?#[:space:]]'
      and hostname ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
    ),
  is_primary boolean not null default false,
  include_subdomains boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, hostname)
);

create table if not exists public.client_assignments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  access_level public.client_assignment_access not null default 'viewer',
  is_active boolean not null default true,
  assigned_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, user_id)
);

create table if not exists public.client_pages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  source public.client_page_source not null default 'manual',
  input_url text not null
    check (char_length(btrim(input_url)) between 8 and 2048 and input_url ~* '^https?://'),
  final_url text check (final_url is null or (char_length(final_url) between 8 and 2048 and final_url ~* '^https?://')),
  canonical_url text check (canonical_url is null or (char_length(canonical_url) between 8 and 2048 and canonical_url ~* '^https?://')),
  crawl_status public.client_page_status not null default 'pending',
  http_status smallint check (http_status is null or http_status between 100 and 599),
  page_title text check (page_title is null or char_length(page_title) <= 500),
  meta_description text check (meta_description is null or char_length(meta_description) <= 2000),
  h1 text check (h1 is null or char_length(h1) <= 1000),
  h2 jsonb not null default '[]'::jsonb check (jsonb_typeof(h2) = 'array'),
  h3 jsonb not null default '[]'::jsonb check (jsonb_typeof(h3) = 'array'),
  slug text check (slug is null or char_length(slug) <= 1000),
  page_language text
    check (
      page_language is null
      or (
        page_language = lower(page_language)
        and page_language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'
      )
    ),
  robots_index boolean,
  robots_follow boolean,
  content_hash text check (content_hash is null or char_length(content_hash) <= 128),
  extracted_terms jsonb not null default '[]'::jsonb check (jsonb_typeof(extracted_terms) = 'array'),
  extracted_phrases jsonb not null default '[]'::jsonb check (jsonb_typeof(extracted_phrases) = 'array'),
  is_enabled boolean not null default true,
  priority smallint not null default 50 check (priority between 0 and 100),
  last_crawled_at timestamptz,
  last_success_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 120),
  last_error_message text check (last_error_message is null or char_length(last_error_message) <= 2000),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, input_url),
  unique (id, client_id)
);

create table if not exists public.client_page_crawl_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  page_id uuid not null,
  requested_by uuid references public.profiles(id) on delete set null default auth.uid(),
  request_reason text not null default 'initial'
    check (request_reason in ('initial', 'manual_refresh', 'scheduled_refresh')),
  status public.client_crawl_job_status not null default 'queued',
  priority smallint not null default 50 check (priority between 0 and 100),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 20),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 20),
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 8 and 200),
  next_attempt_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  locked_by text check (locked_by is null or char_length(locked_by) <= 200),
  lease_expires_at timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 120),
  error_message text check (error_message is null or char_length(error_message) <= 2000),
  result_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(result_summary) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_page_crawl_jobs_page_client_fk
    foreign key (page_id, client_id)
    references public.client_pages(id, client_id)
    on delete cascade,
  unique (page_id, idempotency_key)
);

create index if not exists clients_active_name_idx
  on public.clients(is_active, lower(name));
create index if not exists client_domains_client_active_idx
  on public.client_domains(client_id, is_active);
create unique index if not exists client_domains_hostname_unique_idx
  on public.client_domains(lower(hostname));
create unique index if not exists client_domains_one_primary_idx
  on public.client_domains(client_id)
  where is_primary = true;
create index if not exists client_assignments_user_active_idx
  on public.client_assignments(user_id, is_active, client_id);
create index if not exists client_assignments_client_active_idx
  on public.client_assignments(client_id, is_active, user_id);
create index if not exists client_pages_client_status_idx
  on public.client_pages(client_id, crawl_status, is_enabled);
create index if not exists client_pages_client_updated_idx
  on public.client_pages(client_id, updated_at desc);
create index if not exists client_pages_canonical_url_idx
  on public.client_pages(client_id, canonical_url)
  where canonical_url is not null;
create index if not exists client_page_crawl_jobs_claim_idx
  on public.client_page_crawl_jobs(status, priority desc, next_attempt_at, created_at)
  where status in ('queued', 'retry_scheduled');
create index if not exists client_page_crawl_jobs_page_idx
  on public.client_page_crawl_jobs(page_id, created_at desc);
create unique index if not exists client_page_crawl_jobs_one_active_idx
  on public.client_page_crawl_jobs(page_id)
  where status in ('queued', 'running', 'retry_scheduled');

create or replace function public.client_access_level_for_user(
  target_client_id uuid,
  target_user_id uuid
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1
      from public.profiles as profile
      where profile.id = target_user_id
        and profile.is_active = true
        and profile.role = 'admin'::public.app_role
    ) then 'admin'
    else (
      select assignment.access_level::text
      from public.client_assignments as assignment
      join public.clients as client
        on client.id = assignment.client_id
       and client.is_active = true
      join public.profiles as profile
        on profile.id = assignment.user_id
       and profile.is_active = true
      where assignment.client_id = target_client_id
        and assignment.user_id = target_user_id
        and assignment.is_active = true
      limit 1
    )
  end;
$$;

create or replace function public.client_access_level(target_client_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.client_access_level_for_user(target_client_id, auth.uid());
$$;

create or replace function public.can_read_client(target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.client_access_level(target_client_id) is not null;
$$;

create or replace function public.can_edit_client(target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.client_access_level(target_client_id) in ('admin', 'editor');
$$;

create or replace function public.prepare_client_page_audit_fields()
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
    if new.updated_by is null and auth.uid() is not null then
      new.updated_by = auth.uid();
    end if;
  elsif auth.uid() is not null then
    if not public.is_admin() and (
      new.client_id is distinct from old.client_id
      or new.created_by is distinct from old.created_by
      or new.source is distinct from old.source
    ) then
      raise exception 'Only admins can move a client page or change its source or creator.';
    end if;
    new.updated_by = auth.uid();
  end if;

  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_clients_updated_at on public.clients;
create trigger set_clients_updated_at
before update on public.clients
for each row execute function public.set_updated_at();

drop trigger if exists set_client_domains_updated_at on public.client_domains;
create trigger set_client_domains_updated_at
before update on public.client_domains
for each row execute function public.set_updated_at();

drop trigger if exists set_client_assignments_updated_at on public.client_assignments;
create trigger set_client_assignments_updated_at
before update on public.client_assignments
for each row execute function public.set_updated_at();

drop trigger if exists prepare_client_page_audit_fields on public.client_pages;
create trigger prepare_client_page_audit_fields
before insert or update on public.client_pages
for each row execute function public.prepare_client_page_audit_fields();

drop trigger if exists set_client_page_crawl_jobs_updated_at on public.client_page_crawl_jobs;
create trigger set_client_page_crawl_jobs_updated_at
before update on public.client_page_crawl_jobs
for each row execute function public.set_updated_at();

alter table public.clients enable row level security;
alter table public.client_domains enable row level security;
alter table public.client_assignments enable row level security;
alter table public.client_pages enable row level security;
alter table public.client_page_crawl_jobs enable row level security;

drop policy if exists "clients_select_assigned_or_admin" on public.clients;
create policy "clients_select_assigned_or_admin"
on public.clients
for select
to authenticated
using (public.can_read_client(id));

drop policy if exists "clients_insert_admin" on public.clients;
create policy "clients_insert_admin"
on public.clients
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "clients_update_admin" on public.clients;
create policy "clients_update_admin"
on public.clients
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "clients_delete_admin" on public.clients;
create policy "clients_delete_admin"
on public.clients
for delete
to authenticated
using (public.is_admin());

drop policy if exists "client_domains_select_assigned_or_admin" on public.client_domains;
create policy "client_domains_select_assigned_or_admin"
on public.client_domains
for select
to authenticated
using (public.can_read_client(client_id));

drop policy if exists "client_domains_insert_admin" on public.client_domains;
create policy "client_domains_insert_admin"
on public.client_domains
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "client_domains_update_admin" on public.client_domains;
create policy "client_domains_update_admin"
on public.client_domains
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "client_domains_delete_admin" on public.client_domains;
create policy "client_domains_delete_admin"
on public.client_domains
for delete
to authenticated
using (public.is_admin());

drop policy if exists "client_assignments_select_self_or_admin" on public.client_assignments;
create policy "client_assignments_select_self_or_admin"
on public.client_assignments
for select
to authenticated
using (public.is_admin() or user_id = auth.uid());

drop policy if exists "client_assignments_insert_admin" on public.client_assignments;
create policy "client_assignments_insert_admin"
on public.client_assignments
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "client_assignments_update_admin" on public.client_assignments;
create policy "client_assignments_update_admin"
on public.client_assignments
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "client_assignments_delete_admin" on public.client_assignments;
create policy "client_assignments_delete_admin"
on public.client_assignments
for delete
to authenticated
using (public.is_admin());

drop policy if exists "client_pages_select_assigned_or_admin" on public.client_pages;
create policy "client_pages_select_assigned_or_admin"
on public.client_pages
for select
to authenticated
using (public.can_read_client(client_id));

drop policy if exists "client_pages_insert_editor_or_admin" on public.client_pages;
create policy "client_pages_insert_editor_or_admin"
on public.client_pages
for insert
to authenticated
with check (
  public.can_edit_client(client_id)
  and (created_by = auth.uid() or public.is_admin())
);

drop policy if exists "client_pages_update_editor_or_admin" on public.client_pages;
create policy "client_pages_update_editor_or_admin"
on public.client_pages
for update
to authenticated
using (public.can_edit_client(client_id))
with check (public.can_edit_client(client_id));

drop policy if exists "client_pages_delete_editor_or_admin" on public.client_pages;
create policy "client_pages_delete_editor_or_admin"
on public.client_pages
for delete
to authenticated
using (public.can_edit_client(client_id));

drop policy if exists "client_page_crawl_jobs_select_assigned_or_admin" on public.client_page_crawl_jobs;
create policy "client_page_crawl_jobs_select_assigned_or_admin"
on public.client_page_crawl_jobs
for select
to authenticated
using (public.can_read_client(client_id));

drop policy if exists "client_page_crawl_jobs_insert_editor_or_admin" on public.client_page_crawl_jobs;
create policy "client_page_crawl_jobs_insert_editor_or_admin"
on public.client_page_crawl_jobs
for insert
to authenticated
with check (
  public.can_edit_client(client_id)
  and (requested_by = auth.uid() or public.is_admin())
  and status = 'queued'
  and attempt_count = 0
);

revoke all on public.clients from public, anon;
revoke all on public.client_domains from public, anon;
revoke all on public.client_assignments from public, anon;
revoke all on public.client_pages from public, anon;
revoke all on public.client_page_crawl_jobs from public, anon;

grant select, insert, update, delete on public.clients to authenticated;
grant select, insert, update, delete on public.client_domains to authenticated;
grant select, insert, update, delete on public.client_assignments to authenticated;
grant select, insert, update, delete on public.client_pages to authenticated;
grant select, insert on public.client_page_crawl_jobs to authenticated;

grant select, insert, update, delete on public.clients to service_role;
grant select, insert, update, delete on public.client_domains to service_role;
grant select, insert, update, delete on public.client_assignments to service_role;
grant select, insert, update, delete on public.client_pages to service_role;
grant select, insert, update, delete on public.client_page_crawl_jobs to service_role;

revoke all on function public.client_access_level_for_user(uuid, uuid) from public, anon, authenticated;
revoke all on function public.client_access_level(uuid) from public, anon;
revoke all on function public.can_read_client(uuid) from public, anon;
revoke all on function public.can_edit_client(uuid) from public, anon;
revoke all on function public.prepare_client_page_audit_fields() from public, anon, authenticated;

grant execute on function public.client_access_level_for_user(uuid, uuid) to service_role;
grant execute on function public.client_access_level(uuid) to authenticated, service_role;
grant execute on function public.can_read_client(uuid) to authenticated, service_role;
grant execute on function public.can_edit_client(uuid) to authenticated, service_role;

comment on table public.clients is
  'Central client records. Deliberately limited to identity, country, language, industry, and company summary.';
comment on table public.client_domains is
  'Verified or approved public hostnames that belong to one client.';
comment on table public.client_assignments is
  'Employee access assignments for one client; administrators retain global access.';
comment on table public.client_pages is
  'Public website pages registered for a client. Editor articles are not a source for these rows.';
comment on table public.client_page_crawl_jobs is
  'Durable crawl requests for extracting public page metadata in later Client Center phases.';
