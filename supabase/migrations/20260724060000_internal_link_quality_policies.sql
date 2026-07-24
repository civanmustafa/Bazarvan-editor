-- Client Center phase 8: deterministic internal-link quality policies.
-- Apply after 20260724050000_editor_internal_link_suggestions.sql.
-- Policies control scoring and density only. Fixed safety rules still reject
-- self-links, noindex/disabled/unready pages, overlapping anchors, and anchors
-- outside two to five words. No AI, Search Console, editor corpus, or orphan-page
-- discovery is introduced by this migration.

create table if not exists public.internal_link_quality_policies (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'client'
    check (scope in ('global', 'client')),
  client_id uuid references public.clients(id) on delete cascade,
  minimum_score smallint not null default 45
    check (minimum_score between 0 and 100),
  max_links_per_1000_words numeric(5,2) not null default 5
    check (max_links_per_1000_words between 0.5 and 20),
  absolute_maximum_links smallint not null default 20
    check (absolute_maximum_links between 1 and 50),
  maximum_links_per_target smallint not null default 1
    check (maximum_links_per_target between 1 and 5),
  minimum_matched_terms smallint not null default 2
    check (minimum_matched_terms between 2 and 5),
  forbidden_anchors jsonb not null default
    '["اضغط هنا","اعرف المزيد","اقرأ المزيد","المزيد من التفاصيل","click here","learn more","read more"]'::jsonb
    check (
      jsonb_typeof(forbidden_anchors) = 'array'
      and jsonb_array_length(forbidden_anchors) between 1 and 100
    ),
  policy_version integer not null default 1
    check (policy_version between 1 and 1000000),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint internal_link_quality_policies_scope_client_check check (
    (scope = 'global' and client_id is null)
    or (scope = 'client' and client_id is not null)
  ),
  unique (client_id)
);

create unique index if not exists internal_link_quality_policies_one_global_idx
  on public.internal_link_quality_policies(scope)
  where scope = 'global';

create index if not exists internal_link_quality_policies_client_idx
  on public.internal_link_quality_policies(client_id)
  where client_id is not null;

create or replace function public.prepare_internal_link_quality_policy()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if old.scope is distinct from new.scope
      or old.client_id is distinct from new.client_id then
      raise exception 'The quality-policy scope cannot be changed after creation.';
    end if;
    new.policy_version := least(1000000, old.policy_version + 1);
  else
    new.policy_version := 1;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists prepare_internal_link_quality_policy_trigger
  on public.internal_link_quality_policies;
create trigger prepare_internal_link_quality_policy_trigger
before insert or update on public.internal_link_quality_policies
for each row execute function public.prepare_internal_link_quality_policy();

alter table public.internal_link_quality_policies enable row level security;

drop policy if exists "internal_link_quality_policies_select_visible"
  on public.internal_link_quality_policies;
create policy "internal_link_quality_policies_select_visible"
on public.internal_link_quality_policies
for select
to authenticated
using (
  scope = 'global'
  or public.can_read_client(client_id)
);

drop policy if exists "internal_link_quality_policies_insert_editor_or_admin"
  on public.internal_link_quality_policies;
create policy "internal_link_quality_policies_insert_editor_or_admin"
on public.internal_link_quality_policies
for insert
to authenticated
with check (
  (scope = 'global' and client_id is null and public.is_admin())
  or (
    scope = 'client'
    and client_id is not null
    and public.can_edit_client(client_id)
  )
);

drop policy if exists "internal_link_quality_policies_update_editor_or_admin"
  on public.internal_link_quality_policies;
create policy "internal_link_quality_policies_update_editor_or_admin"
on public.internal_link_quality_policies
for update
to authenticated
using (
  (scope = 'global' and public.is_admin())
  or (scope = 'client' and public.can_edit_client(client_id))
)
with check (
  (scope = 'global' and client_id is null and public.is_admin())
  or (
    scope = 'client'
    and client_id is not null
    and public.can_edit_client(client_id)
  )
);

drop policy if exists "internal_link_quality_policies_delete_client_override"
  on public.internal_link_quality_policies;
create policy "internal_link_quality_policies_delete_client_override"
on public.internal_link_quality_policies
for delete
to authenticated
using (
  scope = 'client'
  and public.can_edit_client(client_id)
);

insert into public.internal_link_quality_policies (
  scope,
  client_id,
  minimum_score,
  max_links_per_1000_words,
  absolute_maximum_links,
  maximum_links_per_target,
  minimum_matched_terms,
  forbidden_anchors
)
select
  'global',
  null,
  45,
  5,
  20,
  1,
  2,
  '["اضغط هنا","اعرف المزيد","اقرأ المزيد","المزيد من التفاصيل","click here","learn more","read more"]'::jsonb
where not exists (
  select 1
  from public.internal_link_quality_policies
  where scope = 'global'
);

revoke all on public.internal_link_quality_policies from public, anon;
grant select, insert, update, delete
  on public.internal_link_quality_policies to authenticated;

revoke all on function public.prepare_internal_link_quality_policy()
  from public, anon;
grant execute on function public.prepare_internal_link_quality_policy()
  to authenticated;

comment on table public.internal_link_quality_policies is
  'Versioned deterministic quality thresholds. One global policy can be overridden once per client.';
comment on column public.internal_link_quality_policies.forbidden_anchors is
  'Anchor-text phrases excluded from link suggestions; this is not a writing terminology list.';
