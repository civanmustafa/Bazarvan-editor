begin;

create table if not exists public.article_quota_global_policy (
  singleton boolean primary key default true,
  default_monthly_limit integer,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint article_quota_global_policy_singleton_check check (singleton),
  constraint article_quota_global_policy_limit_check
    check (default_monthly_limit is null or default_monthly_limit between 0 and 1000000)
);

insert into public.article_quota_global_policy (singleton, default_monthly_limit)
values (true, null)
on conflict (singleton) do nothing;

create table if not exists public.user_article_quota_policies (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  mode text not null default 'inherit',
  monthly_limit integer,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_article_quota_policies_mode_check
    check (mode in ('inherit', 'custom', 'unlimited', 'blocked')),
  constraint user_article_quota_policies_limit_check
    check (
      (mode = 'custom' and monthly_limit between 1 and 1000000)
      or (mode <> 'custom' and monthly_limit is null)
    )
);

create table if not exists public.article_quota_usage (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null unique,
  user_id uuid references public.profiles(id) on delete set null,
  period_start date not null,
  article_source text not null default 'manual',
  created_at timestamptz not null default now(),
  constraint article_quota_usage_source_check
    check (article_source in ('manual', 'import', 'n8n', 'system'))
);

create index if not exists article_quota_usage_user_period_idx
  on public.article_quota_usage(user_id, period_start, created_at desc);

create table if not exists public.article_quota_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  target_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  previous_value jsonb not null default '{}'::jsonb,
  next_value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint article_quota_audit_action_check
    check (char_length(btrim(action)) between 1 and 120),
  constraint article_quota_audit_previous_check
    check (jsonb_typeof(previous_value) = 'object'),
  constraint article_quota_audit_next_check
    check (jsonb_typeof(next_value) = 'object')
);

create index if not exists article_quota_audit_created_idx
  on public.article_quota_audit_events(created_at desc);

-- Preserve the current month's existing manual article usage so enabling a
-- limit cannot be bypassed by articles created immediately before deployment.
insert into public.article_quota_usage (
  article_id,
  user_id,
  period_start,
  article_source,
  created_at
)
select
  article.id,
  article.created_by,
  date_trunc('month', article.created_at at time zone 'Europe/Istanbul')::date,
  article.source,
  article.created_at
from public.articles as article
where article.created_by is not null
  and article.source = 'manual'
on conflict (article_id) do nothing;

create or replace function public.get_article_monthly_quota_status(
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_global_limit integer;
  v_mode text := 'inherit';
  v_custom_limit integer;
  v_effective_limit integer;
  v_used integer := 0;
  v_period_start date := date_trunc('month', now() at time zone 'Europe/Istanbul')::date;
  v_reset_at timestamptz;
begin
  if p_user_id is null then
    raise exception 'A user is required.' using errcode = '22023';
  end if;

  select profile.role
  into v_role
  from public.profiles as profile
  where profile.id = p_user_id;

  if not found then
    raise exception 'User was not found.' using errcode = 'P0002';
  end if;

  select policy.default_monthly_limit
  into v_global_limit
  from public.article_quota_global_policy as policy
  where policy.singleton is true;

  select policy.mode, policy.monthly_limit
  into v_mode, v_custom_limit
  from public.user_article_quota_policies as policy
  where policy.user_id = p_user_id;

  if not found then
    v_mode := 'inherit';
    v_custom_limit := null;
  end if;

  v_effective_limit := case v_mode
    when 'custom' then v_custom_limit
    when 'blocked' then 0
    when 'unlimited' then null
    else case when v_role = 'admin' then null else v_global_limit end
  end;

  select count(*)::integer
  into v_used
  from public.article_quota_usage as usage
  where usage.user_id = p_user_id
    and usage.period_start = v_period_start;

  v_reset_at := ((v_period_start + interval '1 month')::timestamp at time zone 'Europe/Istanbul');

  return jsonb_build_object(
    'userId', p_user_id,
    'role', v_role,
    'timezone', 'Europe/Istanbul',
    'periodStart', v_period_start,
    'resetAt', v_reset_at,
    'globalDefaultMonthlyLimit', v_global_limit,
    'mode', v_mode,
    'customMonthlyLimit', v_custom_limit,
    'effectiveMonthlyLimit', v_effective_limit,
    'used', v_used,
    'remaining', case
      when v_effective_limit is null then null
      else greatest(0, v_effective_limit - v_used)
    end,
    'canCreate', v_effective_limit is null or v_used < v_effective_limit
  );
end;
$$;

create or replace function public.set_article_quota_global_policy(
  p_actor_user_id uuid,
  p_default_monthly_limit integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous_limit integer;
begin
  if not exists (
    select 1
    from public.profiles as profile
    where profile.id = p_actor_user_id
      and profile.role = 'admin'
      and profile.is_active is true
  ) then
    raise exception 'An active administrator is required.' using errcode = '42501';
  end if;

  if p_default_monthly_limit is not null
     and (p_default_monthly_limit < 0 or p_default_monthly_limit > 1000000) then
    raise exception 'The monthly article limit is invalid.' using errcode = '22023';
  end if;

  select policy.default_monthly_limit
  into v_previous_limit
  from public.article_quota_global_policy as policy
  where policy.singleton is true
  for update;

  insert into public.article_quota_global_policy (
    singleton,
    default_monthly_limit,
    updated_by,
    updated_at
  ) values (
    true,
    p_default_monthly_limit,
    p_actor_user_id,
    now()
  )
  on conflict (singleton) do update
  set
    default_monthly_limit = excluded.default_monthly_limit,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  insert into public.article_quota_audit_events (
    actor_user_id,
    action,
    previous_value,
    next_value
  ) values (
    p_actor_user_id,
    'global_article_quota_updated',
    jsonb_build_object('defaultMonthlyLimit', v_previous_limit),
    jsonb_build_object('defaultMonthlyLimit', p_default_monthly_limit)
  );
end;
$$;

create or replace function public.set_user_article_quota_policy(
  p_actor_user_id uuid,
  p_user_id uuid,
  p_mode text,
  p_monthly_limit integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous_mode text := 'inherit';
  v_previous_limit integer;
begin
  if not exists (
    select 1
    from public.profiles as profile
    where profile.id = p_actor_user_id
      and profile.role = 'admin'
      and profile.is_active is true
  ) then
    raise exception 'An active administrator is required.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles as profile where profile.id = p_user_id
  ) then
    raise exception 'User was not found.' using errcode = 'P0002';
  end if;

  if p_mode is null
     or p_mode not in ('inherit', 'custom', 'unlimited', 'blocked') then
    raise exception 'The article quota mode is invalid.' using errcode = '22023';
  end if;

  if (p_mode = 'custom' and (
        p_monthly_limit is null
        or p_monthly_limit < 1
        or p_monthly_limit > 1000000
      ))
     or (p_mode <> 'custom' and p_monthly_limit is not null) then
    raise exception 'The custom monthly article limit is invalid.' using errcode = '22023';
  end if;

  select policy.mode, policy.monthly_limit
  into v_previous_mode, v_previous_limit
  from public.user_article_quota_policies as policy
  where policy.user_id = p_user_id
  for update;

  if not found then
    v_previous_mode := 'inherit';
    v_previous_limit := null;
  end if;

  insert into public.user_article_quota_policies (
    user_id,
    mode,
    monthly_limit,
    updated_by,
    updated_at
  ) values (
    p_user_id,
    p_mode,
    p_monthly_limit,
    p_actor_user_id,
    now()
  )
  on conflict (user_id) do update
  set
    mode = excluded.mode,
    monthly_limit = excluded.monthly_limit,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  insert into public.article_quota_audit_events (
    actor_user_id,
    target_user_id,
    action,
    previous_value,
    next_value
  ) values (
    p_actor_user_id,
    p_user_id,
    'user_article_quota_updated',
    jsonb_build_object(
      'mode', v_previous_mode,
      'monthlyLimit', v_previous_limit
    ),
    jsonb_build_object(
      'mode', p_mode,
      'monthlyLimit', p_monthly_limit
    )
  );
end;
$$;

create or replace function public.enforce_article_monthly_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_status jsonb;
  v_limit integer;
  v_used integer;
  v_period_start date := date_trunc('month', now() at time zone 'Europe/Istanbul')::date;
begin
  -- Service integrations such as n8n do not carry a user JWT and keep their
  -- separate integration accounting. Authenticated manual creation is charged.
  if v_user_id is null or coalesce(new.source, 'manual') <> 'manual' then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_user_id::text || ':article-quota:' || v_period_start::text, 0)
  );

  if exists (
    select 1 from public.article_quota_usage where article_id = new.id
  ) then
    return new;
  end if;

  v_status := public.get_article_monthly_quota_status(v_user_id);
  v_limit := nullif(v_status->>'effectiveMonthlyLimit', '')::integer;
  v_used := coalesce((v_status->>'used')::integer, 0);

  if v_limit is not null and v_used >= v_limit then
    raise exception using
      errcode = 'P0001',
      message = 'ARTICLE_MONTHLY_QUOTA_EXCEEDED',
      detail = jsonb_build_object(
        'used', v_used,
        'limit', v_limit,
        'resetAt', v_status->>'resetAt'
      )::text;
  end if;

  insert into public.article_quota_usage (
    article_id,
    user_id,
    period_start,
    article_source,
    created_at
  ) values (
    new.id,
    v_user_id,
    v_period_start,
    coalesce(new.source, 'manual'),
    coalesce(new.created_at, now())
  ) on conflict (article_id) do nothing;

  return new;
end;
$$;

drop trigger if exists zz_enforce_article_monthly_quota on public.articles;
create trigger zz_enforce_article_monthly_quota
before insert on public.articles
for each row execute function public.enforce_article_monthly_quota();

alter table public.article_quota_global_policy enable row level security;
alter table public.user_article_quota_policies enable row level security;
alter table public.article_quota_usage enable row level security;
alter table public.article_quota_audit_events enable row level security;

revoke all on table public.article_quota_global_policy from public, anon, authenticated;
revoke all on table public.user_article_quota_policies from public, anon, authenticated;
revoke all on table public.article_quota_usage from public, anon, authenticated;
revoke all on table public.article_quota_audit_events from public, anon, authenticated;

grant select, insert, update on table public.article_quota_global_policy to service_role;
grant select, insert, update, delete on table public.user_article_quota_policies to service_role;
grant select, insert on table public.article_quota_usage to service_role;
grant select, insert on table public.article_quota_audit_events to service_role;

revoke all on function public.get_article_monthly_quota_status(uuid)
  from public, anon, authenticated;
grant execute on function public.get_article_monthly_quota_status(uuid)
  to service_role;

revoke all on function public.set_article_quota_global_policy(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.set_article_quota_global_policy(uuid, integer)
  to service_role;

revoke all on function public.set_user_article_quota_policy(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.set_user_article_quota_policy(uuid, uuid, text, integer)
  to service_role;

revoke all on function public.enforce_article_monthly_quota()
  from public, anon, authenticated;

comment on table public.article_quota_usage is
  'Append-only monthly accounting for authenticated manual article creation. Deletion does not refund quota.';
comment on function public.get_article_monthly_quota_status(uuid) is
  'Server-only effective monthly article quota and usage status in Europe/Istanbul.';
comment on function public.set_article_quota_global_policy(uuid, integer) is
  'Atomically updates the global quota and appends an immutable administrator audit event.';
comment on function public.set_user_article_quota_policy(uuid, uuid, text, integer) is
  'Atomically updates one user quota and appends an immutable administrator audit event.';

notify pgrst, 'reload schema';

commit;
