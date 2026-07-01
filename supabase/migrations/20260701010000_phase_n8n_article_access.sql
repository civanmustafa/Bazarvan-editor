-- Phase n8n: per-article access grants for imported articles.
-- This allows n8n to choose whether an article appears to all users or only selected users.

create table if not exists public.article_access (
  article_id uuid not null references public.articles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (article_id, user_id)
);

create index if not exists article_access_user_id_idx on public.article_access(user_id);
create index if not exists article_access_article_id_idx on public.article_access(article_id);

alter table public.article_access enable row level security;

create or replace function public.has_article_access(target_article_id uuid, allowed_roles text[] default array['viewer', 'editor'])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.article_access aa
    where aa.article_id = target_article_id
      and aa.user_id = auth.uid()
      and aa.role = any(allowed_roles)
  );
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
        or a.visibility in ('shared', 'team', 'public')
        or public.has_article_access(a.id, array['viewer', 'editor'])
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
        or public.has_article_access(a.id, array['editor'])
      )
  );
$$;

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
  or visibility in ('shared', 'team', 'public')
  or public.has_article_access(id, array['viewer', 'editor'])
);

drop policy if exists "articles_update_owner_assignee_or_admin" on public.articles;
create policy "articles_update_owner_assignee_or_admin"
on public.articles
for update
to authenticated
using (
  public.is_admin()
  or owner_id = auth.uid()
  or assigned_to = auth.uid()
  or public.has_article_access(id, array['editor'])
)
with check (
  public.is_admin()
  or owner_id = auth.uid()
  or assigned_to = auth.uid()
  or public.has_article_access(id, array['editor'])
);

drop policy if exists "article_access_select_self_or_admin" on public.article_access;
create policy "article_access_select_self_or_admin"
on public.article_access
for select
to authenticated
using (public.is_admin() or user_id = auth.uid());

drop policy if exists "article_access_admin_insert" on public.article_access;
create policy "article_access_admin_insert"
on public.article_access
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "article_access_admin_update" on public.article_access;
create policy "article_access_admin_update"
on public.article_access
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "article_access_admin_delete" on public.article_access;
create policy "article_access_admin_delete"
on public.article_access
for delete
to authenticated
using (public.is_admin());

revoke all on public.article_access from anon;
grant select, insert, update, delete on public.article_access to authenticated;
grant execute on function public.has_article_access(uuid, text[]) to authenticated;

comment on table public.article_access is 'Per-user visibility/edit grants for articles imported from n8n or assigned manually.';
