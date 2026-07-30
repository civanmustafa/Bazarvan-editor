-- Local, API-triggered website crawling built on the existing Client Center page worker.
-- No third-party crawling service is used. The worker fetches approved public domains,
-- extracts internal links, persists the current link graph, and expands the crawl queue.

create table if not exists public.client_site_crawl_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  started_by uuid references public.profiles(id) on delete set null,
  start_url text not null
    check (char_length(btrim(start_url)) between 8 and 2048 and start_url ~* '^https?://'),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'partial', 'cancelled')),
  max_pages integer not null default 250 check (max_pages between 1 and 2000),
  max_depth smallint not null default 6 check (max_depth between 0 and 20),
  follow_nofollow boolean not null default false,
  pages_discovered integer not null default 1 check (pages_discovered >= 0),
  pages_queued integer not null default 0 check (pages_queued >= 0),
  pages_completed integer not null default 0 check (pages_completed >= 0),
  pages_failed integer not null default 0 check (pages_failed >= 0),
  limit_reached boolean not null default false,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists client_site_crawl_runs_one_active_idx
  on public.client_site_crawl_runs(client_id)
  where status in ('queued', 'running');

create index if not exists client_site_crawl_runs_client_created_idx
  on public.client_site_crawl_runs(client_id, created_at desc);

alter table public.client_page_crawl_jobs
  add column if not exists crawl_run_id uuid
    references public.client_site_crawl_runs(id) on delete set null,
  add column if not exists crawl_depth smallint not null default 0
    check (crawl_depth between 0 and 20);

create index if not exists client_page_crawl_jobs_run_idx
  on public.client_page_crawl_jobs(crawl_run_id, status, crawl_depth, created_at)
  where crawl_run_id is not null;

create table if not exists public.client_internal_links (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  source_page_id uuid not null references public.client_pages(id) on delete cascade,
  target_page_id uuid references public.client_pages(id) on delete set null,
  target_url text not null
    check (char_length(btrim(target_url)) between 8 and 2048 and target_url ~* '^https?://'),
  anchor_text text not null default '' check (char_length(anchor_text) <= 500),
  link_fingerprint text not null check (char_length(link_fingerprint) = 64),
  rel_nofollow boolean not null default false,
  rel_sponsored boolean not null default false,
  rel_ugc boolean not null default false,
  crawlable boolean not null default true,
  occurrence_count integer not null default 1 check (occurrence_count between 1 and 10000),
  is_active boolean not null default true,
  last_seen_run_id uuid references public.client_site_crawl_runs(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_internal_links_source_client_fk
    foreign key (source_page_id, client_id)
    references public.client_pages(id, client_id)
    on delete cascade,
  unique (client_id, source_page_id, link_fingerprint)
);

create index if not exists client_internal_links_client_active_idx
  on public.client_internal_links(client_id, is_active, source_page_id);
create index if not exists client_internal_links_target_page_idx
  on public.client_internal_links(client_id, target_page_id)
  where target_page_id is not null and is_active = true;
create index if not exists client_internal_links_target_url_idx
  on public.client_internal_links(client_id, target_url)
  where is_active = true;

drop trigger if exists set_client_site_crawl_runs_updated_at on public.client_site_crawl_runs;
create trigger set_client_site_crawl_runs_updated_at
before update on public.client_site_crawl_runs
for each row execute function public.set_updated_at();

drop trigger if exists set_client_internal_links_updated_at on public.client_internal_links;
create trigger set_client_internal_links_updated_at
before update on public.client_internal_links
for each row execute function public.set_updated_at();

alter table public.client_site_crawl_runs enable row level security;
alter table public.client_internal_links enable row level security;

drop policy if exists "client_site_crawl_runs_select_assigned" on public.client_site_crawl_runs;
create policy "client_site_crawl_runs_select_assigned"
on public.client_site_crawl_runs
for select
to authenticated
using (public.can_read_client(client_id));

drop policy if exists "client_internal_links_select_assigned" on public.client_internal_links;
create policy "client_internal_links_select_assigned"
on public.client_internal_links
for select
to authenticated
using (public.can_read_client(client_id));

revoke all on public.client_site_crawl_runs from public, anon;
revoke all on public.client_internal_links from public, anon;
grant select on public.client_site_crawl_runs to authenticated;
grant select on public.client_internal_links to authenticated;
grant select, insert, update, delete on public.client_site_crawl_runs to service_role;
grant select, insert, update, delete on public.client_internal_links to service_role;

create or replace function public.client_site_crawl_url_host(p_url text)
returns text
language sql
immutable
strict
as $$
  select lower(
    split_part(
      split_part(regexp_replace(btrim(p_url), '^https?://', '', 'i'), '/', 1),
      ':',
      1
    )
  );
$$;

create or replace function public.sync_client_site_crawl_run(p_run_id uuid)
returns public.client_site_crawl_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.client_site_crawl_runs%rowtype;
  v_total integer := 0;
  v_active integer := 0;
  v_completed integer := 0;
  v_failed integer := 0;
  v_discovered integer := 1;
begin
  select *
  into v_run
  from public.client_site_crawl_runs
  where id = p_run_id
  for update;

  if not found then
    return null;
  end if;

  select
    count(*)::integer,
    count(*) filter (where status in ('queued', 'running', 'retry_scheduled'))::integer,
    count(*) filter (where status = 'completed')::integer,
    count(*) filter (where status in ('failed', 'cancelled'))::integer
  into v_total, v_active, v_completed, v_failed
  from public.client_page_crawl_jobs
  where crawl_run_id = p_run_id;

  select greatest(
    1,
    count(distinct target_url)::integer + 1
  )
  into v_discovered
  from public.client_internal_links
  where last_seen_run_id = p_run_id;

  update public.client_site_crawl_runs
  set pages_discovered = v_discovered,
      pages_queued = v_total,
      pages_completed = v_completed,
      pages_failed = v_failed,
      limit_reached = v_total >= v_run.max_pages and v_discovered > v_total,
      status = case
        when status = 'cancelled' then 'cancelled'
        when v_active > 0 then 'running'
        when v_failed > 0 then 'partial'
        else 'completed'
      end,
      started_at = coalesce(started_at, case when v_total > 0 then now() else null end),
      finished_at = case
        when status = 'cancelled' or v_active = 0 then coalesce(finished_at, now())
        else null
      end,
      updated_at = now()
  where id = p_run_id
  returning * into v_run;

  return v_run;
end;
$$;

create or replace function public.start_client_site_crawl(
  p_client_id uuid,
  p_started_by uuid,
  p_start_url text,
  p_max_pages integer default 250,
  p_max_depth integer default 6,
  p_follow_nofollow boolean default false
)
returns public.client_site_crawl_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.client_site_crawl_runs%rowtype;
  v_page_id uuid;
  v_host text;
  v_authority text;
  v_url text := left(btrim(p_start_url), 2048);
begin
  if public.client_access_level_for_user(p_client_id, p_started_by) not in ('admin', 'editor') then
    raise exception 'Client editor access is required.';
  end if;

  if v_url !~* '^https?://' then
    raise exception 'A public HTTP or HTTPS start URL is required.';
  end if;

  v_authority := split_part(regexp_replace(v_url, '^https?://', '', 'i'), '/', 1);
  if position('@' in v_authority) > 0 then
    raise exception 'Credentials are not allowed in a crawl URL.';
  end if;

  v_host := public.client_site_crawl_url_host(v_url);
  if not exists (
    select 1
    from public.client_domains as domain
    where domain.client_id = p_client_id
      and domain.is_active = true
      and (
        v_host = domain.hostname
        or (
          domain.include_subdomains = true
          and v_host like '%.' || domain.hostname
        )
      )
  ) then
    raise exception 'The start URL is outside the client approved domains.';
  end if;

  insert into public.client_site_crawl_runs (
    client_id,
    started_by,
    start_url,
    max_pages,
    max_depth,
    follow_nofollow
  )
  values (
    p_client_id,
    p_started_by,
    v_url,
    greatest(1, least(coalesce(p_max_pages, 250), 2000)),
    greatest(0, least(coalesce(p_max_depth, 6), 20)),
    coalesce(p_follow_nofollow, false)
  )
  returning * into v_run;

  insert into public.client_pages (
    client_id,
    source,
    input_url,
    is_enabled,
    priority,
    created_by,
    updated_by
  )
  values (
    p_client_id,
    'crawl',
    v_url,
    true,
    100,
    p_started_by,
    p_started_by
  )
  on conflict (client_id, input_url)
  do update set
    is_enabled = true,
    priority = greatest(public.client_pages.priority, 100),
    updated_by = excluded.updated_by
  returning id into v_page_id;

  insert into public.client_page_crawl_jobs (
    client_id,
    page_id,
    requested_by,
    request_reason,
    status,
    priority,
    idempotency_key,
    crawl_run_id,
    crawl_depth
  )
  values (
    p_client_id,
    v_page_id,
    p_started_by,
    'initial',
    'queued',
    100,
    'site:' || v_run.id::text || ':' || v_page_id::text,
    v_run.id,
    0
  );

  return public.sync_client_site_crawl_run(v_run.id);
exception
  when unique_violation then
    raise exception 'An active site crawl already exists for this client.';
end;
$$;

create or replace function public.cancel_client_site_crawl(
  p_run_id uuid,
  p_requested_by uuid
)
returns public.client_site_crawl_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.client_site_crawl_runs%rowtype;
begin
  select *
  into v_run
  from public.client_site_crawl_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'The site crawl run was not found.';
  end if;
  if public.client_access_level_for_user(v_run.client_id, p_requested_by) not in ('admin', 'editor') then
    raise exception 'Client editor access is required.';
  end if;

  update public.client_site_crawl_runs
  set status = 'cancelled',
      finished_at = coalesce(finished_at, now()),
      updated_at = now()
  where id = p_run_id;

  update public.client_page_crawl_jobs
  set status = 'cancelled',
      finished_at = now(),
      error_code = 'client_site_crawl_cancelled',
      error_message = 'The site crawl was cancelled by a user.',
      updated_at = now()
  where crawl_run_id = p_run_id
    and status in ('queued', 'retry_scheduled');

  return public.sync_client_site_crawl_run(p_run_id);
end;
$$;

create or replace function public.process_completed_client_page_links()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_links jsonb;
  v_link jsonb;
  v_run public.client_site_crawl_runs%rowtype;
  v_target_url text;
  v_anchor_text text;
  v_host text;
  v_fingerprint text;
  v_target_page_id uuid;
  v_current_pages integer := 0;
  v_link_count integer := 0;
  v_source_follows boolean := true;
begin
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  v_links := new.result_summary -> 'internalLinks';
  if jsonb_typeof(v_links) <> 'array' then
    return new;
  end if;

  v_link_count := least(jsonb_array_length(v_links), 1000);
  v_source_follows := coalesce((new.result_summary ->> 'robotsFollow')::boolean, true);

  update public.client_internal_links
  set is_active = false,
      updated_at = now()
  where client_id = new.client_id
    and source_page_id = new.page_id
    and is_active = true;

  if new.crawl_run_id is not null then
    select *
    into v_run
    from public.client_site_crawl_runs
    where id = new.crawl_run_id
      and status in ('queued', 'running')
    for update;

    if found then
      select count(*)::integer
      into v_current_pages
      from public.client_page_crawl_jobs
      where crawl_run_id = new.crawl_run_id;
    end if;
  end if;

  for v_link in
    select value
    from jsonb_array_elements(v_links)
    limit 1000
  loop
    v_target_url := left(nullif(btrim(v_link ->> 'targetUrl'), ''), 2048);
    v_anchor_text := left(coalesce(v_link ->> 'anchorText', ''), 500);
    if v_target_url is null or v_target_url !~* '^https?://' then
      continue;
    end if;

    v_host := public.client_site_crawl_url_host(v_target_url);
    if not exists (
      select 1
      from public.client_domains as domain
      where domain.client_id = new.client_id
        and domain.is_active = true
        and (
          v_host = domain.hostname
          or (domain.include_subdomains = true and v_host like '%.' || domain.hostname)
        )
    ) then
      continue;
    end if;

    select page.id
    into v_target_page_id
    from public.client_pages as page
    where page.client_id = new.client_id
      and (
        page.input_url = v_target_url
        or page.final_url = v_target_url
        or page.canonical_url = v_target_url
      )
    order by
      case when page.input_url = v_target_url then 0 else 1 end,
      page.updated_at desc
    limit 1;

    v_fingerprint := encode(
      digest(v_target_url || E'\n' || v_anchor_text, 'sha256'),
      'hex'
    );

    insert into public.client_internal_links (
      client_id,
      source_page_id,
      target_page_id,
      target_url,
      anchor_text,
      link_fingerprint,
      rel_nofollow,
      rel_sponsored,
      rel_ugc,
      crawlable,
      occurrence_count,
      is_active,
      last_seen_run_id,
      last_seen_at
    )
    values (
      new.client_id,
      new.page_id,
      v_target_page_id,
      v_target_url,
      v_anchor_text,
      v_fingerprint,
      coalesce((v_link ->> 'relNofollow')::boolean, false),
      coalesce((v_link ->> 'relSponsored')::boolean, false),
      coalesce((v_link ->> 'relUgc')::boolean, false),
      coalesce((v_link ->> 'crawlable')::boolean, true),
      greatest(1, least(coalesce((v_link ->> 'occurrenceCount')::integer, 1), 10000)),
      true,
      new.crawl_run_id,
      now()
    )
    on conflict (client_id, source_page_id, link_fingerprint)
    do update set
      target_page_id = excluded.target_page_id,
      target_url = excluded.target_url,
      anchor_text = excluded.anchor_text,
      rel_nofollow = excluded.rel_nofollow,
      rel_sponsored = excluded.rel_sponsored,
      rel_ugc = excluded.rel_ugc,
      crawlable = excluded.crawlable,
      occurrence_count = excluded.occurrence_count,
      is_active = true,
      last_seen_run_id = excluded.last_seen_run_id,
      last_seen_at = now(),
      updated_at = now();

    if v_run.id is null
      or v_run.status not in ('queued', 'running')
      or new.crawl_depth >= v_run.max_depth
      or v_current_pages >= v_run.max_pages
      or coalesce((v_link ->> 'crawlable')::boolean, true) = false
      or (
        coalesce((v_link ->> 'relNofollow')::boolean, false) = true
        and v_run.follow_nofollow = false
      )
      or (v_source_follows = false and v_run.follow_nofollow = false)
    then
      continue;
    end if;

    if v_target_page_id is null then
      insert into public.client_pages (
        client_id,
        source,
        input_url,
        is_enabled,
        priority,
        created_by,
        updated_by
      )
      values (
        new.client_id,
        'crawl',
        v_target_url,
        true,
        greatest(10, 100 - ((new.crawl_depth + 1) * 5)),
        v_run.started_by,
        v_run.started_by
      )
      on conflict (client_id, input_url)
      do update set updated_by = excluded.updated_by
      returning id into v_target_page_id;

      update public.client_internal_links
      set target_page_id = v_target_page_id,
          updated_at = now()
      where client_id = new.client_id
        and source_page_id = new.page_id
        and link_fingerprint = v_fingerprint;
    end if;

    if exists (
      select 1
      from public.client_pages
      where id = v_target_page_id
        and client_id = new.client_id
        and is_enabled = true
    ) then
      insert into public.client_page_crawl_jobs (
        client_id,
        page_id,
        requested_by,
        request_reason,
        status,
        priority,
        idempotency_key,
        crawl_run_id,
        crawl_depth
      )
      values (
        new.client_id,
        v_target_page_id,
        v_run.started_by,
        'initial',
        'queued',
        greatest(10, 100 - ((new.crawl_depth + 1) * 5)),
        'site:' || v_run.id::text || ':' || v_target_page_id::text,
        v_run.id,
        new.crawl_depth + 1
      )
      on conflict do nothing;

      if found then
        v_current_pages := v_current_pages + 1;
      end if;
    end if;
  end loop;

  new.result_summary := (new.result_summary - 'internalLinks')
    || jsonb_build_object('internalLinkCount', v_link_count);
  return new;
end;
$$;

drop trigger if exists process_completed_client_page_links on public.client_page_crawl_jobs;
create trigger process_completed_client_page_links
before update of status, result_summary on public.client_page_crawl_jobs
for each row execute function public.process_completed_client_page_links();

create or replace function public.sync_client_site_crawl_run_from_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.crawl_run_id is not null
    and (
      old.status is distinct from new.status
      or old.crawl_run_id is distinct from new.crawl_run_id
    )
  then
    perform public.sync_client_site_crawl_run(new.crawl_run_id);
  end if;
  return new;
end;
$$;

drop trigger if exists sync_client_site_crawl_run_from_job on public.client_page_crawl_jobs;
create trigger sync_client_site_crawl_run_from_job
after update of status, crawl_run_id on public.client_page_crawl_jobs
for each row execute function public.sync_client_site_crawl_run_from_job();

revoke all on function public.client_site_crawl_url_host(text) from public, anon;
revoke all on function public.sync_client_site_crawl_run(uuid) from public, anon, authenticated;
revoke all on function public.start_client_site_crawl(uuid, uuid, text, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.cancel_client_site_crawl(uuid, uuid) from public, anon, authenticated;
revoke all on function public.process_completed_client_page_links() from public, anon, authenticated;
revoke all on function public.sync_client_site_crawl_run_from_job() from public, anon, authenticated;

grant execute on function public.client_site_crawl_url_host(text) to service_role;
grant execute on function public.sync_client_site_crawl_run(uuid) to service_role;
grant execute on function public.start_client_site_crawl(uuid, uuid, text, integer, integer, boolean) to service_role;
grant execute on function public.cancel_client_site_crawl(uuid, uuid) to service_role;

comment on table public.client_site_crawl_runs is
  'Bounded local website crawls started through the editor API.';
comment on table public.client_internal_links is
  'Current internal link graph extracted by the local Client Center crawler.';
comment on function public.start_client_site_crawl(uuid, uuid, text, integer, integer, boolean) is
  'Atomically creates a bounded site crawl and queues its approved start page.';
