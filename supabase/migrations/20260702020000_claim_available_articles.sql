-- Allow a signed-in user to claim an unassigned public article once.
-- The claim makes the article private to that user and removes it from other users' dashboards after refresh/realtime update.

create or replace function public.protect_article_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and auth.uid() is not null
     and not public.is_admin()
     and current_setting('app.claim_article', true) is distinct from 'on'
     and (
       new.owner_id is distinct from old.owner_id
       or new.created_by is distinct from old.created_by
       or new.assigned_to is distinct from old.assigned_to
       or new.source is distinct from old.source
       or new.visibility is distinct from old.visibility
       or new.external_id is distinct from old.external_id
       or new.n8n_workflow_id is distinct from old.n8n_workflow_id
       or new.n8n_execution_id is distinct from old.n8n_execution_id
     ) then
    raise exception 'Only admins can change article ownership, visibility, source, assignment, or external IDs.';
  end if;

  return new;
end;
$$;

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
    and a.visibility = 'public'
    and a.owner_id is null
    and a.assigned_to is null
    and coalesce(nullif(a.metadata->'n8nSettings'->>'visibleToEmailsCsv', ''), '') = ''
    and not exists (
      select 1
      from public.article_access aa
      where aa.article_id = a.id
    )
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

grant execute on function public.claim_available_article(uuid) to authenticated;
