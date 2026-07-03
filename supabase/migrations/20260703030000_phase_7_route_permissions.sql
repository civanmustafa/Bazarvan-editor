-- Phase 7: tighten direct-link permissions.
-- Users can read their own articles, explicitly shared articles, and public unclaimed opportunities only.

create or replace function public.is_article_public_opportunity(target_article_id uuid)
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
      and a.visibility = 'public'
      and a.owner_id is null
      and a.created_by is null
      and a.assigned_to is null
      and coalesce(nullif(a.metadata->'n8nSettings'->>'visibleToEmailsCsv', ''), '') = ''
      and not exists (
        select 1
        from public.article_access aa
        where aa.article_id = a.id
      )
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
        or public.has_article_access(a.id, array['viewer', 'editor'])
        or public.is_article_public_opportunity(a.id)
      )
  );
$$;

drop policy if exists "articles_select_visible" on public.articles;
create policy "articles_select_visible"
on public.articles
for select
to authenticated
using (public.can_read_article(id));

create or replace function public.claim_available_article(
  target_article_id uuid
)
returns public.articles
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  profile_row public.profiles%rowtype;
  updated_article public.articles%rowtype;
  current_access_role text;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.';
  end if;

  select *
  into profile_row
  from public.profiles
  where id = current_user_id
    and is_active is not false;

  if not found then
    raise exception 'Active profile was not found.';
  end if;

  select coalesce(nullif(a.metadata->'n8nSettings'->>'accessRole', ''), 'editor')
  into current_access_role
  from public.articles a
  where a.id = target_article_id;

  current_access_role := case when current_access_role = 'viewer' then 'viewer' else 'editor' end;

  perform set_config('app.claim_article', 'on', true);

  update public.articles a
  set
    owner_id = current_user_id,
    assigned_to = current_user_id,
    visibility = 'private',
    updated_at = now(),
    metadata = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            coalesce(a.metadata, '{}'::jsonb),
            '{n8nSettings}',
            coalesce(a.metadata->'n8nSettings', '{}'::jsonb)
              || jsonb_build_object(
                'visibility', 'private',
                'accessRole', current_access_role,
                'visibleToEmailsCsv', coalesce(profile_row.email, '')
              ),
            true
          ),
          '{visibleTo}',
          jsonb_build_array(jsonb_build_object(
            'id', profile_row.id,
            'email', profile_row.email,
            'fullName', profile_row.full_name,
            'role', current_access_role
          )),
          true
        ),
        '{claim}',
        jsonb_build_object(
          'claimedAt', now(),
          'claimedBy', current_user_id,
          'claimedByEmail', profile_row.email,
          'claimedByName', profile_row.full_name
        ),
        true
      ),
      '{n8nSettings,claimedByLabel}',
      to_jsonb(coalesce(nullif(profile_row.full_name, ''), profile_row.email, current_user_id::text)),
      true
    )
  where a.id = target_article_id
    and public.is_article_public_opportunity(a.id)
  returning *
  into updated_article;

  if not found then
    raise exception 'This article is not available for claim.';
  end if;

  insert into public.article_access(article_id, user_id, role)
  values (target_article_id, current_user_id, current_access_role)
  on conflict (article_id, user_id)
  do update set role = excluded.role;

  return updated_article;
end;
$$;

grant execute on function public.is_article_public_opportunity(uuid) to authenticated;
grant execute on function public.can_read_article(uuid) to authenticated;
grant execute on function public.claim_available_article(uuid) to authenticated;
