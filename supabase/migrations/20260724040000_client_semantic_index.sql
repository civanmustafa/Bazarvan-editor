-- Client Center phase 6: deterministic per-page semantic profiles and client dictionaries.
-- Apply after 20260724030000_internal_linking_engine.sql.
-- No external API, AI provider, Search Console, editor-article corpus, or orphan-page analysis is used.

create table if not exists public.client_link_dictionaries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  dictionary_type text not null
    check (dictionary_type in ('synonym', 'topic', 'excluded_term')),
  label text not null
    check (char_length(btrim(label)) between 2 and 160),
  terms jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(terms) = 'array'
      and jsonb_array_length(terms) between 1 and 100
    ),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists client_link_dictionaries_label_unique_idx
  on public.client_link_dictionaries(client_id, dictionary_type, lower(btrim(label)));

create index if not exists client_link_dictionaries_active_idx
  on public.client_link_dictionaries(client_id, is_active, dictionary_type);

create table if not exists public.client_page_semantic_profiles (
  page_id uuid primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  profile_version integer not null default 1
    check (profile_version between 1 and 1000),
  source_signature text not null
    check (source_signature ~ '^[A-Za-z0-9_-]{8,128}$'),
  dictionary_signature text not null
    check (dictionary_signature ~ '^[A-Za-z0-9_-]{8,128}$'),
  page_language text
    check (
      page_language is null
      or (
        page_language = lower(page_language)
        and page_language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'
      )
    ),
  path_segments jsonb not null default '[]'::jsonb
    check (jsonb_typeof(path_segments) = 'array'),
  weighted_terms jsonb not null default '[]'::jsonb
    check (jsonb_typeof(weighted_terms) = 'array'),
  phrases jsonb not null default '[]'::jsonb
    check (jsonb_typeof(phrases) = 'array'),
  light_stems jsonb not null default '[]'::jsonb
    check (jsonb_typeof(light_stems) = 'array'),
  dictionary_matches jsonb not null default '[]'::jsonb
    check (jsonb_typeof(dictionary_matches) = 'array'),
  document_length integer not null default 0
    check (document_length between 0 and 1000000),
  completeness_score smallint not null default 0
    check (completeness_score between 0 and 100),
  completeness_details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(completeness_details) = 'object'),
  indexed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_page_semantic_profiles_page_client_fk
    foreign key (page_id, client_id)
    references public.client_pages(id, client_id)
    on delete cascade
);

create index if not exists client_page_semantic_profiles_client_idx
  on public.client_page_semantic_profiles(client_id, completeness_score desc, indexed_at desc);

create or replace function public.prepare_client_link_dictionary()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_terms jsonb;
begin
  select coalesce(
    jsonb_agg(value order by first_ordinal),
    '[]'::jsonb
  )
  into clean_terms
  from (
    select btrim(raw.value) as value, min(raw.ordinality) as first_ordinal
    from jsonb_array_elements_text(new.terms) with ordinality as raw(value, ordinality)
    where char_length(btrim(raw.value)) between 2 and 160
    group by lower(btrim(raw.value)), btrim(raw.value)
    order by min(raw.ordinality)
    limit 100
  ) as normalized;

  if jsonb_array_length(clean_terms) = 0 then
    raise exception 'At least one valid dictionary term is required.';
  end if;

  new.label := btrim(new.label);
  new.terms := clean_terms;
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists client_link_dictionaries_prepare on public.client_link_dictionaries;
create trigger client_link_dictionaries_prepare
before insert or update on public.client_link_dictionaries
for each row execute function public.prepare_client_link_dictionary();

drop trigger if exists client_page_semantic_profiles_updated_at on public.client_page_semantic_profiles;
create trigger client_page_semantic_profiles_updated_at
before update on public.client_page_semantic_profiles
for each row execute function public.set_updated_at();

alter table public.client_link_dictionaries enable row level security;
alter table public.client_page_semantic_profiles enable row level security;

drop policy if exists "client_link_dictionaries_select_assigned" on public.client_link_dictionaries;
create policy "client_link_dictionaries_select_assigned"
on public.client_link_dictionaries
for select
to authenticated
using (public.can_read_client(client_id));

drop policy if exists "client_link_dictionaries_insert_editor" on public.client_link_dictionaries;
create policy "client_link_dictionaries_insert_editor"
on public.client_link_dictionaries
for insert
to authenticated
with check (
  public.can_edit_client(client_id)
  and (created_by = auth.uid() or public.is_admin())
);

drop policy if exists "client_link_dictionaries_update_editor" on public.client_link_dictionaries;
create policy "client_link_dictionaries_update_editor"
on public.client_link_dictionaries
for update
to authenticated
using (public.can_edit_client(client_id))
with check (public.can_edit_client(client_id));

drop policy if exists "client_link_dictionaries_delete_editor" on public.client_link_dictionaries;
create policy "client_link_dictionaries_delete_editor"
on public.client_link_dictionaries
for delete
to authenticated
using (public.can_edit_client(client_id));

drop policy if exists "client_page_semantic_profiles_select_assigned" on public.client_page_semantic_profiles;
create policy "client_page_semantic_profiles_select_assigned"
on public.client_page_semantic_profiles
for select
to authenticated
using (public.can_read_client(client_id));

drop policy if exists "client_page_semantic_profiles_insert_editor" on public.client_page_semantic_profiles;
create policy "client_page_semantic_profiles_insert_editor"
on public.client_page_semantic_profiles
for insert
to authenticated
with check (
  public.can_edit_client(client_id)
  and exists (
    select 1
    from public.client_pages as page
    where page.id = page_id
      and page.client_id = client_id
  )
);

drop policy if exists "client_page_semantic_profiles_update_editor" on public.client_page_semantic_profiles;
create policy "client_page_semantic_profiles_update_editor"
on public.client_page_semantic_profiles
for update
to authenticated
using (public.can_edit_client(client_id))
with check (
  public.can_edit_client(client_id)
  and exists (
    select 1
    from public.client_pages as page
    where page.id = page_id
      and page.client_id = client_id
  )
);

drop policy if exists "client_page_semantic_profiles_delete_editor" on public.client_page_semantic_profiles;
create policy "client_page_semantic_profiles_delete_editor"
on public.client_page_semantic_profiles
for delete
to authenticated
using (public.can_edit_client(client_id));

revoke all on public.client_link_dictionaries from public, anon;
revoke all on public.client_page_semantic_profiles from public, anon;
revoke all on function public.prepare_client_link_dictionary() from public, anon, authenticated;

grant select, insert, update, delete on public.client_link_dictionaries to authenticated;
grant select, insert, update, delete on public.client_page_semantic_profiles to authenticated;

comment on table public.client_link_dictionaries is
  'Client-scoped synonym groups, topic groups, and terms excluded only from internal-link matching.';
comment on table public.client_page_semantic_profiles is
  'Deterministic reusable page index built from crawled metadata, light stems, n-grams, and client dictionaries.';
comment on column public.client_page_semantic_profiles.completeness_score is
  'Metadata completeness from 0 to 100; it is not a Search Console or AI metric.';
