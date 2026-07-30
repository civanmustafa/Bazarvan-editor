begin;

alter table public.client_site_crawl_runs
  add column if not exists external_reuse_days smallint not null default 14,
  add column if not exists force_external_refresh boolean not null default false,
  add column if not exists max_external_requests integer not null default 100,
  add column if not exists external_requests_used integer not null default 0,
  add column if not exists pages_reused integer not null default 0;

alter table public.client_site_crawl_runs
  drop constraint if exists client_site_crawl_runs_external_reuse_days_check,
  drop constraint if exists client_site_crawl_runs_max_external_requests_check,
  drop constraint if exists client_site_crawl_runs_external_requests_used_check,
  drop constraint if exists client_site_crawl_runs_pages_reused_check;

alter table public.client_site_crawl_runs
  add constraint client_site_crawl_runs_external_reuse_days_check
    check (external_reuse_days between 1 and 90),
  add constraint client_site_crawl_runs_max_external_requests_check
    check (max_external_requests between 1 and 2000),
  add constraint client_site_crawl_runs_external_requests_used_check
    check (external_requests_used between 0 and 2000),
  add constraint client_site_crawl_runs_pages_reused_check
    check (pages_reused >= 0);

-- A conservative reservation is recorded immediately before an external HTTP
-- request. Concurrent workers therefore cannot exceed the monthly limit.
create table if not exists public.crawler_provider_monthly_usage (
  provider text not null check (provider in ('firecrawl', 'browserless')),
  month_start date not null,
  reserved_attempts integer not null default 0 check (reserved_attempts >= 0),
  updated_at timestamptz not null default now(),
  primary key (provider, month_start)
);

alter table public.crawler_provider_monthly_usage enable row level security;
revoke all on table public.crawler_provider_monthly_usage
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.crawler_provider_monthly_usage to service_role;

insert into public.app_settings (key, value, description, is_secret)
values (
  'crawler',
  '{
    "externalReuseDays": 14,
    "maxExternalRequestsPerRun": 100,
    "firecrawlMonthlyRequestLimit": 500,
    "browserlessMonthlyRequestLimit": 500
  }'::jsonb,
  'External crawler freshness and hard request budgets.',
  false
)
on conflict (key) do nothing;

create or replace function public.start_client_site_crawl(
  p_client_id uuid,
  p_started_by uuid,
  p_start_url text,
  p_max_pages integer,
  p_max_depth integer,
  p_follow_nofollow boolean,
  p_provider text,
  p_external_reuse_days integer,
  p_force_external_refresh boolean,
  p_max_external_requests integer
)
returns public.client_site_crawl_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.client_site_crawl_runs%rowtype;
begin
  if coalesce(p_force_external_refresh, false)
    and public.client_access_level_for_user(p_client_id, p_started_by) <> 'admin'
  then
    raise exception 'Only administrators can force a full external refresh.';
  end if;

  v_run := public.start_client_site_crawl(
    p_client_id,
    p_started_by,
    p_start_url,
    p_max_pages,
    p_max_depth,
    p_follow_nofollow,
    p_provider
  );

  update public.client_site_crawl_runs
  set external_reuse_days = greatest(1, least(coalesce(p_external_reuse_days, 14), 90)),
      force_external_refresh = coalesce(p_force_external_refresh, false),
      max_external_requests = greatest(1, least(coalesce(p_max_external_requests, 100), 2000))
  where id = v_run.id
  returning * into v_run;

  return v_run;
end;
$$;

-- The worker supplies links already stored for this page. The existing
-- process_completed_client_page_links trigger replays that graph and queues
-- the next depth without updating the page's last successful HTTP crawl.
create or replace function public.reuse_fresh_client_page_crawl_job(
  p_job_id uuid,
  p_worker_id text,
  p_result_summary jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
begin
  select job.crawl_run_id
  into v_run_id
  from public.client_page_crawl_jobs as job
  join public.client_site_crawl_runs as run
    on run.id = job.crawl_run_id
   and run.client_id = job.client_id
  join public.client_pages as page
    on page.id = job.page_id
   and page.client_id = job.client_id
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = p_worker_id
    and run.status in ('queued', 'running')
    and run.provider in ('firecrawl', 'browserless')
    and run.force_external_refresh = false
    and page.is_enabled = true
    and page.crawl_status in ('ready', 'needs_review', 'redirected', 'noindex')
    and page.http_status between 200 and 399
    and page.last_success_at >= now() - make_interval(days => run.external_reuse_days)
    and (
      page.word_count >= 40
      or exists (
        select 1
        from public.client_internal_links as link
        where link.client_id = job.client_id
          and link.source_page_id = job.page_id
          and link.is_active = true
          and link.crawlable = true
      )
    )
  for update of job;

  if not found then
    return false;
  end if;

  update public.client_page_crawl_jobs
  set status = 'completed',
      finished_at = now(),
      locked_by = null,
      lease_expires_at = null,
      error_code = null,
      error_message = null,
      result_summary = coalesce(p_result_summary, '{}'::jsonb)
        || jsonb_build_object('reused', true, 'provider', 'cache'),
      updated_at = now()
  where id = p_job_id
    and status = 'running'
    and locked_by = p_worker_id;

  if not found then
    return false;
  end if;

  update public.client_site_crawl_runs
  set pages_reused = pages_reused + 1,
      updated_at = now()
  where id = v_run_id;

  return true;
end;
$$;

create or replace function public.reserve_crawler_external_request(
  p_run_id uuid,
  p_provider text,
  p_monthly_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.client_site_crawl_runs%rowtype;
  v_month date := date_trunc('month', now())::date;
  v_limit integer := greatest(1, least(coalesce(p_monthly_limit, 1), 1000000));
  v_month_used integer;
  v_run_used integer;
begin
  if p_provider not in ('firecrawl', 'browserless') then
    raise exception 'Only external crawler providers can reserve usage.';
  end if;

  select *
  into v_run
  from public.client_site_crawl_runs
  where id = p_run_id
  for update;

  if not found or v_run.status not in ('queued', 'running') then
    return jsonb_build_object('allowed', false, 'reason', 'crawl_run_not_active');
  end if;

  if v_run.external_requests_used >= v_run.max_external_requests then
    update public.client_site_crawl_runs
    set limit_reached = true
    where id = v_run.id;
    return jsonb_build_object(
      'allowed', false,
      'reason', 'run_external_request_limit_reached',
      'runUsed', v_run.external_requests_used,
      'runLimit', v_run.max_external_requests
    );
  end if;

  insert into public.crawler_provider_monthly_usage (
    provider,
    month_start,
    reserved_attempts
  )
  select p_provider, v_month, count(*)::integer
  from public.crawler_provider_usage_events
  where provider = p_provider
    and created_at >= v_month::timestamptz
    and created_at < (v_month + interval '1 month')
  on conflict (provider, month_start) do nothing;

  update public.crawler_provider_monthly_usage
  set reserved_attempts = reserved_attempts + 1,
      updated_at = now()
  where provider = p_provider
    and month_start = v_month
    and reserved_attempts < v_limit
  returning reserved_attempts into v_month_used;

  if not found then
    update public.client_site_crawl_runs
    set limit_reached = true
    where id = v_run.id;
    return jsonb_build_object(
      'allowed', false,
      'reason', 'provider_monthly_request_limit_reached',
      'monthlyLimit', v_limit
    );
  end if;

  update public.client_site_crawl_runs
  set external_requests_used = external_requests_used + 1,
      updated_at = now()
  where id = v_run.id
  returning external_requests_used into v_run_used;

  return jsonb_build_object(
    'allowed', true,
    'monthlyUsed', v_month_used,
    'monthlyLimit', v_limit,
    'runUsed', v_run_used,
    'runLimit', v_run.max_external_requests
  );
end;
$$;

revoke all on function public.reuse_fresh_client_page_crawl_job(
  uuid, text, jsonb
) from public, anon, authenticated;
revoke all on function public.reserve_crawler_external_request(
  uuid, text, integer
) from public, anon, authenticated;
revoke all on function public.start_client_site_crawl(
  uuid, uuid, text, integer, integer, boolean, text, integer, boolean, integer
) from public, anon, authenticated;
grant execute on function public.reuse_fresh_client_page_crawl_job(
  uuid, text, jsonb
) to service_role;
grant execute on function public.reserve_crawler_external_request(
  uuid, text, integer
) to service_role;
grant execute on function public.start_client_site_crawl(
  uuid, uuid, text, integer, integer, boolean, text, integer, boolean, integer
) to service_role;

comment on table public.crawler_provider_monthly_usage is
  'Atomic monthly external crawler request reservations.';
comment on function public.reuse_fresh_client_page_crawl_job(uuid, text, jsonb) is
  'Completes an eligible direct-external crawl job from recent stored data.';
comment on function public.reserve_crawler_external_request(uuid, text, integer) is
  'Enforces per-run and monthly external request budgets before HTTP.';

commit;
