begin;

create table if not exists public.competitor_page_cache (
  cache_key text primary key check (cache_key ~ '^[0-9a-f]{64}$'),
  canonical_url text not null check (char_length(canonical_url) between 1 and 2048),
  source_url text not null check (char_length(source_url) between 1 and 2048),
  fetched_url text not null check (char_length(fetched_url) between 1 and 2048),
  domain text not null check (char_length(domain) between 1 and 255),
  title text not null default '' check (char_length(title) <= 500),
  description text not null default '' check (char_length(description) <= 2000),
  headings jsonb not null default '{"h1":[],"h2":[],"h3":[]}'::jsonb
    check (jsonb_typeof(headings) = 'object'),
  content_text text not null check (char_length(content_text) between 1 and 120000),
  word_count integer not null default 0 check (word_count >= 0),
  extraction_provider text not null default 'firecrawl',
  provider_key_suffix text not null default '' check (char_length(provider_key_suffix) <= 12),
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > fetched_at)
);

create index if not exists competitor_page_cache_expires_idx
  on public.competitor_page_cache(expires_at);

drop trigger if exists set_competitor_page_cache_updated_at on public.competitor_page_cache;
create trigger set_competitor_page_cache_updated_at
before update on public.competitor_page_cache
for each row execute function public.set_updated_at();

alter table public.competitor_page_cache enable row level security;

revoke all on public.competitor_page_cache from public, anon, authenticated;
grant all on public.competitor_page_cache to service_role;

comment on table public.competitor_page_cache is
  'Private short-lived normalized competitor previews shared by the API and extraction worker.';

commit;
