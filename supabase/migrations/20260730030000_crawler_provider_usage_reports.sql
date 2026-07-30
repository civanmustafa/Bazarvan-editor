begin;

-- One immutable audit row is written for every actual page-fetch attempt.
-- API keys are never stored here; only the last four characters and the
-- credential source are retained for administrator reporting.
create table if not exists public.crawler_provider_usage_events (
  id uuid primary key default gen_random_uuid(),
  crawl_job_id uuid references public.client_page_crawl_jobs(id) on delete set null,
  crawl_run_id uuid references public.client_site_crawl_runs(id) on delete set null,
  client_id uuid not null references public.clients(id) on delete cascade,
  page_id uuid references public.client_pages(id) on delete set null,
  requested_by uuid references public.profiles(id) on delete set null,
  job_attempt integer not null default 1 check (job_attempt between 1 and 1000),
  requested_provider text not null
    check (requested_provider in ('auto', 'local', 'firecrawl', 'browserless')),
  provider text not null
    check (provider in ('local', 'firecrawl', 'browserless')),
  credential_source text
    check (credential_source is null or credential_source in ('admin', 'hostinger')),
  key_suffix text
    check (key_suffix is null or char_length(key_suffix) between 1 and 8),
  status text not null check (status in ('completed', 'failed')),
  target_url text not null
    check (char_length(btrim(target_url)) between 8 and 2048 and target_url ~* '^https?://'),
  final_url text
    check (final_url is null or (char_length(btrim(final_url)) between 8 and 2048 and final_url ~* '^https?://')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  duration_ms integer not null default 0 check (duration_ms between 0 and 3600000),
  word_count integer check (word_count is null or word_count >= 0),
  internal_link_count integer check (internal_link_count is null or internal_link_count >= 0),
  response_content_type text check (response_content_type is null or char_length(response_content_type) <= 300),
  fallback_reason text check (fallback_reason is null or char_length(fallback_reason) <= 160),
  error_code text check (error_code is null or char_length(error_code) <= 160),
  error_message text check (error_message is null or char_length(error_message) <= 2000),
  retryable boolean,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists crawler_provider_usage_client_created_idx
  on public.crawler_provider_usage_events(client_id, created_at desc);

create index if not exists crawler_provider_usage_provider_created_idx
  on public.crawler_provider_usage_events(provider, credential_source, created_at desc);

create index if not exists crawler_provider_usage_status_created_idx
  on public.crawler_provider_usage_events(status, created_at desc);

create index if not exists crawler_provider_usage_run_idx
  on public.crawler_provider_usage_events(crawl_run_id, created_at)
  where crawl_run_id is not null;

alter table public.crawler_provider_usage_events enable row level security;

revoke all on table public.crawler_provider_usage_events from public, anon, authenticated;
grant select, insert, update, delete on table public.crawler_provider_usage_events to service_role;

comment on table public.crawler_provider_usage_events is
  'Server-only audit trail for local, Firecrawl, and Browserless page-fetch attempts. Raw API keys are never stored.';

comment on column public.crawler_provider_usage_events.key_suffix is
  'Last characters only, used to distinguish configured keys in administrator reports.';

commit;
