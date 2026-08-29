-- Allow one administrator-selected publisher to see all ready and content-preparation articles.
-- Existing ownership, manual assignment, and per-article grants keep their current access levels.

insert into public.app_settings (
  key,
  value,
  description,
  is_secret
)
values (
  'roles',
  '{"publisherUserId":""}'::jsonb,
  'Global role and article visibility controls, including the selected publisher user.',
  false
)
on conflict (key) do update
set
  value = coalesce(public.app_settings.value, '{}'::jsonb)
    || jsonb_build_object(
      'publisherUserId',
      coalesce(public.app_settings.value->>'publisherUserId', '')
    ),
  description = excluded.description,
  is_secret = false,
  updated_at = now();

create or replace function public.article_access_level_for_user(
  target_article_id uuid,
  target_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile_role public.app_role;
  v_owner_id uuid;
  v_created_by uuid;
  v_assigned_to uuid;
  v_article_status text;
  v_access_role text;
  v_publisher_user_id text;
begin
  if target_article_id is null or target_user_id is null then
    return 'none';
  end if;

  select profile.role
  into v_profile_role
  from public.profiles as profile
  where profile.id = target_user_id
    and profile.is_active is true;

  if not found then
    return 'none';
  end if;

  select
    article.owner_id,
    article.created_by,
    article.assigned_to,
    article.status
  into
    v_owner_id,
    v_created_by,
    v_assigned_to,
    v_article_status
  from public.articles as article
  where article.id = target_article_id;

  if not found then
    return 'none';
  end if;

  if v_profile_role = 'admin'::public.app_role then
    return 'admin';
  end if;

  if target_user_id = v_owner_id or target_user_id = v_assigned_to then
    return 'write';
  end if;

  select access_row.role
  into v_access_role
  from public.article_access as access_row
  where access_row.article_id = target_article_id
    and access_row.user_id = target_user_id
  limit 1;

  if v_access_role = 'editor' then
    return 'write';
  end if;

  select nullif(btrim(setting.value->>'publisherUserId'), '')
  into v_publisher_user_id
  from public.app_settings as setting
  where setting.key = 'roles'
    and setting.is_secret is false
  limit 1;

  if target_user_id = v_created_by
     or v_access_role = 'viewer'
     or public.is_article_public_opportunity(target_article_id)
     or (
       lower(target_user_id::text) = lower(v_publisher_user_id)
       and v_article_status in ('in_review', 'content_preparation')
     ) then
    return 'read';
  end if;

  return 'none';
end;
$$;

revoke all on function public.article_access_level_for_user(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.article_access_level_for_user(uuid, uuid)
  to service_role;

comment on function public.article_access_level_for_user(uuid, uuid) is
  'Canonical article authorization policy, including read access for the configured publisher on ready and content-preparation articles.';
