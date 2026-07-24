-- Client Center phase 7: paragraph-aware internal-link suggestions inside the editor.
-- Apply after 20260724040000_client_semantic_index.sql.
-- The workflow remains deterministic and approval-based. It does not use AI,
-- Search Console, editor articles as link targets, or orphan-page discovery.

alter table public.article_client_contexts
  add column if not exists current_page_url text;

alter table public.article_client_contexts
  drop constraint if exists article_client_contexts_current_page_url_check;

alter table public.article_client_contexts
  add constraint article_client_contexts_current_page_url_check
  check (
    current_page_url is null
    or char_length(btrim(current_page_url)) between 8 and 2048
  );

alter table public.internal_link_actions
  drop constraint if exists internal_link_actions_action_check;

alter table public.internal_link_actions
  add constraint internal_link_actions_action_check
  check (action in ('applied', 'dismissed', 'blocked', 'reported'));

create index if not exists internal_link_actions_article_action_idx
  on public.internal_link_actions(article_id, client_id, action, page_id, created_at desc);

create table if not exists public.client_link_suggestion_runs (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  article_signature text not null
    check (article_signature ~ '^[A-Za-z0-9_-]{8,128}$'),
  inventory_signature text not null
    check (inventory_signature ~ '^[A-Za-z0-9_-]{8,128}$'),
  current_page_url text
    check (
      current_page_url is null
      or char_length(btrim(current_page_url)) between 8 and 2048
    ),
  page_count integer not null default 0
    check (page_count between 0 and 1000000),
  suggestion_count integer not null default 0
    check (suggestion_count between 0 and 10000),
  top_score smallint
    check (top_score is null or top_score between 0 and 100),
  algorithm_version text not null
    check (char_length(btrim(algorithm_version)) between 3 and 80),
  result_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result_summary) = 'object'),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (article_id, client_id, article_signature, inventory_signature)
);

create index if not exists client_link_suggestion_runs_article_idx
  on public.client_link_suggestion_runs(article_id, client_id, created_at desc);

alter table public.client_link_suggestion_runs enable row level security;

drop policy if exists "client_link_suggestion_runs_select_visible"
  on public.client_link_suggestion_runs;
create policy "client_link_suggestion_runs_select_visible"
on public.client_link_suggestion_runs
for select
to authenticated
using (
  public.can_read_article(article_id)
  and public.can_read_client(client_id)
);

drop policy if exists "client_link_suggestion_runs_insert_writer"
  on public.client_link_suggestion_runs;
create policy "client_link_suggestion_runs_insert_writer"
on public.client_link_suggestion_runs
for insert
to authenticated
with check (
  public.can_write_article(article_id)
  and public.can_read_client(client_id)
  and (created_by = auth.uid() or public.is_admin())
);

revoke all on public.client_link_suggestion_runs from public, anon;
grant select, insert on public.client_link_suggestion_runs to authenticated;

comment on column public.article_client_contexts.current_page_url is
  'Optional published page selected from the client inventory so the editor never suggests linking an article to itself.';
comment on table public.client_link_suggestion_runs is
  'Aggregate append-only audit of deterministic paragraph-aware suggestion runs; article bodies are not stored.';
comment on column public.client_link_suggestion_runs.result_summary is
  'Bounded transparent metrics only; no article body, API key, AI prompt, or Search Console data.';
