begin;

-- Live article occupancy with an expiring heartbeat. Clients can use only the
-- guarded RPC functions; the underlying table is not directly exposed.

create table if not exists public.article_editor_presence (
  presence_id uuid primary key,
  article_id uuid not null references public.articles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  entered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists article_editor_presence_article_last_seen_idx
  on public.article_editor_presence(article_id, last_seen_at desc);

create index if not exists article_editor_presence_user_idx
  on public.article_editor_presence(user_id);

alter table public.article_editor_presence enable row level security;

revoke all on table public.article_editor_presence from public, anon, authenticated;
grant all on table public.article_editor_presence to service_role;

create or replace function public.list_article_editor_presence(
  p_article_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if coalesce(cardinality(p_article_ids), 0) = 0 then
    return '[]'::jsonb;
  end if;

  if cardinality(p_article_ids) > 50 then
    raise exception 'A maximum of 50 articles can be monitored at once.' using errcode = '22023';
  end if;

  delete from public.article_editor_presence
  where last_seen_at < now() - interval '90 seconds';

  select coalesce(jsonb_agg(jsonb_build_object(
    'articleId', active.article_id,
    'userId', active.user_id,
    'displayName', active.display_name,
    'enteredAt', active.entered_at,
    'lastSeenAt', active.last_seen_at
  ) order by active.article_id, active.display_name), '[]'::jsonb)
  into v_result
  from (
    select distinct on (presence.article_id, presence.user_id)
      presence.article_id,
      presence.user_id,
      split_part(
        coalesce(
          nullif(btrim(profile.email), ''),
          nullif(btrim(profile.full_name), ''),
          presence.user_id::text
        ),
        '@',
        1
      ) as display_name,
      presence.entered_at,
      presence.last_seen_at
    from public.article_editor_presence as presence
    join public.profiles as profile on profile.id = presence.user_id
    where presence.article_id = any(p_article_ids)
      and presence.last_seen_at >= now() - interval '90 seconds'
      and public.can_read_article(presence.article_id)
    order by presence.article_id, presence.user_id, presence.last_seen_at desc
  ) as active;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

create or replace function public.heartbeat_article_editor_presence(
  p_article_id uuid,
  p_presence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing_user_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if p_article_id is null or p_presence_id is null then
    raise exception 'Article and presence identifiers are required.' using errcode = '22023';
  end if;

  if not public.can_read_article(p_article_id) then
    raise exception 'Article access is required.' using errcode = '42501';
  end if;

  select presence.user_id
  into v_existing_user_id
  from public.article_editor_presence as presence
  where presence.presence_id = p_presence_id;

  if found and v_existing_user_id <> auth.uid() then
    raise exception 'Presence identifier belongs to another user.' using errcode = '42501';
  end if;

  insert into public.article_editor_presence (
    presence_id,
    article_id,
    user_id,
    entered_at,
    last_seen_at
  ) values (
    p_presence_id,
    p_article_id,
    auth.uid(),
    now(),
    now()
  )
  on conflict (presence_id) do update
  set
    article_id = excluded.article_id,
    entered_at = case
      when public.article_editor_presence.article_id is distinct from excluded.article_id
        then excluded.entered_at
      else public.article_editor_presence.entered_at
    end,
    last_seen_at = excluded.last_seen_at
  where public.article_editor_presence.user_id = auth.uid();

  return public.list_article_editor_presence(array[p_article_id]);
end;
$$;

create or replace function public.leave_article_editor_presence(
  p_article_id uuid,
  p_presence_id uuid
)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  delete from public.article_editor_presence
  where presence_id = p_presence_id
    and article_id = p_article_id
    and user_id = auth.uid();
$$;

revoke all on function public.list_article_editor_presence(uuid[])
  from public, anon, authenticated;
revoke all on function public.heartbeat_article_editor_presence(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.leave_article_editor_presence(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.list_article_editor_presence(uuid[])
  to authenticated;
grant execute on function public.heartbeat_article_editor_presence(uuid, uuid)
  to authenticated;
grant execute on function public.leave_article_editor_presence(uuid, uuid)
  to authenticated;

comment on table public.article_editor_presence is
  'Expiring per-browser-tab occupancy records for articles currently open in the editor.';
comment on function public.list_article_editor_presence(uuid[]) is
  'Returns active occupants only for articles the current user can read; labels never expose the email domain.';

notify pgrst, 'reload schema';
commit;
