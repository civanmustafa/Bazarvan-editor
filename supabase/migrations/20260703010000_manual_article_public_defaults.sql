-- Allow normal users to create manual articles with the new dashboard defaults:
-- draft, public, assigned to the creator, and editable by the creator.

drop policy if exists "articles_insert_own_private_manual" on public.articles;
drop policy if exists "articles_insert_own_manual_defaults" on public.articles;

create policy "articles_insert_own_manual_defaults"
on public.articles
for insert
to authenticated
with check (
  public.is_admin()
  or (
    owner_id = auth.uid()
    and created_by = auth.uid()
    and source = 'manual'
    and (
      visibility = 'private'
      or (
        visibility = 'public'
        and assigned_to = auth.uid()
      )
    )
  )
);
