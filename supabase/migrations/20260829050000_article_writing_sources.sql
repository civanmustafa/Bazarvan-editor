begin;

create table if not exists public.article_writing_sources (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  source_type text not null check (source_type in ('url', 'raw')),
  source_role text not null default 'primary' check (source_role in ('primary', 'supporting')),
  title text not null default '',
  source_url text,
  content_text text not null default '',
  focus_instructions text not null default '',
  status text not null default 'pending' check (status in ('pending', 'extracting', 'ready', 'failed')),
  extraction_method text check (extraction_method in ('raw', 'programmatic')),
  content_hash text,
  word_count integer not null default 0 check (word_count >= 0),
  enabled boolean not null default true,
  last_error text,
  fetched_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete cascade,
  updated_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint article_writing_sources_url_shape check (
    (source_type = 'url' and nullif(btrim(coalesce(source_url, '')), '') is not null)
    or (source_type = 'raw' and source_url is null)
  ),
  constraint article_writing_sources_content_hash_shape check (
    content_hash is null or content_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint article_writing_sources_text_limits check (
    char_length(title) <= 500
    and char_length(coalesce(source_url, '')) <= 2048
    and char_length(content_text) <= 120000
    and char_length(focus_instructions) <= 2000
    and char_length(coalesce(last_error, '')) <= 2000
  )
);

create index if not exists article_writing_sources_article_order_idx
  on public.article_writing_sources(article_id, created_at, id);

create unique index if not exists article_writing_sources_enabled_url_unique_idx
  on public.article_writing_sources(article_id, source_url)
  where source_type = 'url' and enabled = true;

drop trigger if exists set_article_writing_sources_updated_at on public.article_writing_sources;
create trigger set_article_writing_sources_updated_at
before update on public.article_writing_sources
for each row execute function public.set_updated_at();

alter table public.article_writing_sources enable row level security;

revoke all on table public.article_writing_sources from public, anon, authenticated;
grant all on table public.article_writing_sources to service_role;

comment on table public.article_writing_sources is
  'Canonical per-article writing references. The content-writing API enforces article access and freezes enabled ready sources into each session snapshot; current editor text is never stored here or used as a writing source.';

commit;
