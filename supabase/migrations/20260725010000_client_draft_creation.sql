-- Allow an authenticated editor to create only the minimal Client Center record
-- needed by the Keywords and Goals tab. Full client data and domains remain under
-- the existing administrator-only policies.

create or replace function public.create_client_draft(
  p_name text,
  p_default_language text default 'ar'
)
returns public.clients
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g');
  v_language text := lower(btrim(coalesce(p_default_language, 'ar')));
  v_existing public.clients;
  v_client public.clients;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication is required to create a client draft.';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 160 then
    raise exception using
      errcode = '22023',
      message = 'Client name must contain between 2 and 160 characters.';
  end if;

  if v_language !~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid default language code.';
  end if;

  -- Serializes equal normalized names so two simultaneous editor requests do not
  -- create duplicate clients even though historic rows do not have a unique index.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(lower(v_name), 0)
  );

  select client.*
  into v_existing
  from public.clients as client
  where lower(btrim(client.name)) = lower(v_name)
  order by client.created_at asc
  limit 1;

  if found then
    if not public.can_read_client(v_existing.id) then
      raise exception using
        errcode = '42501',
        message = 'A client with this name already exists. Ask an administrator to grant access.';
    end if;
    return v_existing;
  end if;

  insert into public.clients (
    name,
    default_language,
    is_active,
    created_by,
    updated_by
  )
  values (
    v_name,
    v_language,
    true,
    v_user_id,
    v_user_id
  )
  returning * into v_client;

  -- Administrators already have global access. A regular editor receives access
  -- only to the draft they created, without gaining access to other clients.
  if not public.is_admin() then
    insert into public.client_assignments (
      client_id,
      user_id,
      access_level,
      is_active,
      assigned_by
    )
    values (
      v_client.id,
      v_user_id,
      'editor'::public.client_assignment_access,
      true,
      v_user_id
    )
    on conflict (client_id, user_id) do update
      set access_level = excluded.access_level,
          is_active = true,
          assigned_by = excluded.assigned_by,
          updated_at = now();
  end if;

  return v_client;
end;
$$;

revoke all on function public.create_client_draft(text, text)
from public, anon;

grant execute on function public.create_client_draft(text, text)
to authenticated;

comment on function public.create_client_draft(text, text) is
  'Creates a minimal Client Center record from the editor and assigns only its creator when the caller is not an admin.';

-- A read-only probe lets /readyz verify that this function migration exists
-- without creating a client or changing any production data.
create or replace function public.client_draft_creation_schema_version()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 1;
$$;

revoke all on function public.client_draft_creation_schema_version()
from public, anon;

grant execute on function public.client_draft_creation_schema_version()
to authenticated, service_role;

comment on function public.client_draft_creation_schema_version() is
  'Read-only readiness marker for the minimal Client Center draft creation migration.';
