-- Client Center phases 4 and 5: deterministic internal-link matching and editor integration.
-- Apply after 20260724020000_client_center_management_and_crawling.sql.
-- The engine uses crawled public client pages only. It does not use editor articles as
-- link targets, Search Console, orphan-page discovery, or an AI provider.

create table if not exists public.article_client_contexts (
  article_id uuid primary key references public.articles(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  selected_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists article_client_contexts_client_idx
  on public.article_client_contexts(client_id, updated_at desc);

create table if not exists public.internal_link_actions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  page_id uuid references public.client_pages(id) on delete set null,
  actor_id uuid references public.profiles(id) on delete set null default auth.uid(),
  action text not null check (action in ('applied', 'dismissed')),
  anchor_text text not null check (
    char_length(btrim(anchor_text)) between 2 and 300
  ),
  target_url text not null check (
    char_length(btrim(target_url)) between 8 and 2048
  ),
  score smallint not null check (score between 0 and 100),
  reason_details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(reason_details) = 'object'),
  article_signature text not null check (
    article_signature ~ '^[A-Za-z0-9_-]{8,128}$'
  ),
  created_at timestamptz not null default now()
);

create index if not exists internal_link_actions_article_client_idx
  on public.internal_link_actions(article_id, client_id, created_at desc);

create index if not exists internal_link_actions_page_idx
  on public.internal_link_actions(page_id, created_at desc);

create or replace function public.prepare_article_client_context()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
    new.selected_by := coalesce(new.selected_by, auth.uid());
  else
    new.selected_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists article_client_contexts_prepare on public.article_client_contexts;
create trigger article_client_contexts_prepare
before insert or update on public.article_client_contexts
for each row execute function public.prepare_article_client_context();

alter table public.article_client_contexts enable row level security;
alter table public.internal_link_actions enable row level security;

drop policy if exists "article_client_contexts_select_visible" on public.article_client_contexts;
create policy "article_client_contexts_select_visible"
on public.article_client_contexts
for select
to authenticated
using (
  public.can_read_article(article_id)
  and public.can_read_client(client_id)
);

drop policy if exists "article_client_contexts_insert_writer" on public.article_client_contexts;
create policy "article_client_contexts_insert_writer"
on public.article_client_contexts
for insert
to authenticated
with check (
  public.can_write_article(article_id)
  and public.can_read_client(client_id)
  and (selected_by = auth.uid() or public.is_admin())
);

drop policy if exists "article_client_contexts_update_writer" on public.article_client_contexts;
create policy "article_client_contexts_update_writer"
on public.article_client_contexts
for update
to authenticated
using (public.can_write_article(article_id))
with check (
  public.can_write_article(article_id)
  and public.can_read_client(client_id)
);

drop policy if exists "article_client_contexts_delete_writer" on public.article_client_contexts;
create policy "article_client_contexts_delete_writer"
on public.article_client_contexts
for delete
to authenticated
using (public.can_write_article(article_id));

drop policy if exists "internal_link_actions_select_visible" on public.internal_link_actions;
create policy "internal_link_actions_select_visible"
on public.internal_link_actions
for select
to authenticated
using (
  public.can_read_article(article_id)
  and public.can_read_client(client_id)
);

drop policy if exists "internal_link_actions_insert_writer" on public.internal_link_actions;
create policy "internal_link_actions_insert_writer"
on public.internal_link_actions
for insert
to authenticated
with check (
  public.can_write_article(article_id)
  and public.can_read_client(client_id)
  and (actor_id = auth.uid() or public.is_admin())
  and exists (
    select 1
    from public.client_pages as page
    where page.id = page_id
      and page.client_id = client_id
  )
);

revoke all on public.article_client_contexts from public, anon;
revoke all on public.internal_link_actions from public, anon;
revoke all on function public.prepare_article_client_context() from public, anon, authenticated;

grant select, insert, update, delete on public.article_client_contexts to authenticated;
grant select, insert on public.internal_link_actions to authenticated;

comment on table public.article_client_contexts is
  'Selects one Client Center website inventory for an article without using editor articles as link targets.';
comment on table public.internal_link_actions is
  'Append-only audit of deterministic internal-link suggestions applied or dismissed in the editor.';
comment on column public.internal_link_actions.reason_details is
  'Transparent algorithmic score evidence; no AI prompt or Search Console data is stored.';
