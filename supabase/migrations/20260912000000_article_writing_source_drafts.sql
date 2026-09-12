begin;

create table if not exists public.article_writing_source_drafts (
  article_id uuid primary key references public.articles(id) on delete cascade,
  source_type text not null default 'url' check (source_type in ('url', 'raw')),
  source_role text not null default 'primary' check (source_role in ('primary', 'supporting')),
  title text not null default '',
  source_url text not null default '',
  raw_text text not null default '',
  focus_instructions text not null default '',
  updated_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint article_writing_source_drafts_text_limits check (
    char_length(title) <= 500
    and char_length(source_url) <= 2048
    and char_length(raw_text) <= 120000
    and char_length(focus_instructions) <= 2000
  )
);

drop trigger if exists set_article_writing_source_drafts_updated_at on public.article_writing_source_drafts;
create trigger set_article_writing_source_drafts_updated_at
before update on public.article_writing_source_drafts
for each row execute function public.set_updated_at();

alter table public.article_writing_source_drafts enable row level security;

revoke all on table public.article_writing_source_drafts from public, anon, authenticated;
grant all on table public.article_writing_source_drafts to service_role;

comment on table public.article_writing_source_drafts is
  'Server-persisted per-article draft for the new writing-source form. The authenticated writing-sources API enforces article access; browser roles cannot read or mutate rows directly.';

commit;
