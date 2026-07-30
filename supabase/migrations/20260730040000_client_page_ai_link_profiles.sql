begin;

-- AI enrichment is kept separate from deterministic semantic profiles so a
-- missing provider or a rejected generation can never disable normal linking.
-- Raw HTML and extracted article text are intentionally not persisted.
create table if not exists public.client_page_ai_link_profiles (
  page_id uuid primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  profile_version integer not null default 1
    check (profile_version between 1 and 1000),
  source_signature text not null
    check (source_signature ~ '^[A-Za-z0-9_-]{8,128}$'),
  generation_status text not null default 'pending'
    check (generation_status in ('pending', 'ready', 'skipped', 'failed')),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected')),
  primary_phrase text
    check (
      primary_phrase is null
      or char_length(btrim(primary_phrase)) between 2 and 160
    ),
  alternative_phrases jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(alternative_phrases) = 'array'
      and jsonb_array_length(alternative_phrases) <= 24
    ),
  long_tail_phrases jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(long_tail_phrases) = 'array'
      and jsonb_array_length(long_tail_phrases) <= 16
    ),
  related_entities jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(related_entities) = 'array'
      and jsonb_array_length(related_entities) <= 20
    ),
  negative_phrases jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(negative_phrases) = 'array'
      and jsonb_array_length(negative_phrases) <= 16
    ),
  page_intent text
    check (
      page_intent is null
      or page_intent in (
        'informational',
        'commercial',
        'transactional',
        'navigational',
        'local',
        'mixed'
      )
    ),
  confidence smallint not null default 0
    check (confidence between 0 and 100),
  provider text
    check (provider is null or char_length(provider) between 1 and 80),
  model text
    check (model is null or char_length(model) between 1 and 160),
  error_code text
    check (error_code is null or char_length(error_code) <= 160),
  error_message text
    check (error_message is null or char_length(error_message) <= 2000),
  generated_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_page_ai_link_profiles_page_client_fk
    foreign key (page_id, client_id)
    references public.client_pages(id, client_id)
    on delete cascade,
  constraint client_page_ai_link_profiles_ready_phrase_check
    check (
      generation_status <> 'ready'
      or char_length(btrim(coalesce(primary_phrase, ''))) between 2 and 160
    ),
  constraint client_page_ai_link_profiles_review_check
    check (
      review_status = 'pending'
      or generation_status = 'ready'
    )
);

create index if not exists client_page_ai_link_profiles_client_status_idx
  on public.client_page_ai_link_profiles(
    client_id,
    generation_status,
    review_status,
    confidence desc,
    updated_at desc
  );

drop trigger if exists client_page_ai_link_profiles_updated_at
  on public.client_page_ai_link_profiles;
create trigger client_page_ai_link_profiles_updated_at
before update on public.client_page_ai_link_profiles
for each row execute function public.set_updated_at();

alter table public.client_page_ai_link_profiles enable row level security;

drop policy if exists "client_page_ai_link_profiles_select_assigned"
  on public.client_page_ai_link_profiles;
create policy "client_page_ai_link_profiles_select_assigned"
on public.client_page_ai_link_profiles
for select
to authenticated
using (public.can_read_client(client_id));

create or replace function public.review_client_page_ai_link_profile(
  p_page_id uuid,
  p_review_status text
)
returns public.client_page_ai_link_profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text := lower(btrim(coalesce(p_review_status, '')));
  v_profile public.client_page_ai_link_profiles%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only administrators may review AI link phrase profiles.';
  end if;
  if v_status not in ('pending', 'approved', 'rejected') then
    raise exception 'Unsupported AI link phrase review status.';
  end if;

  update public.client_page_ai_link_profiles
  set review_status = v_status,
      reviewed_by = case when v_status = 'pending' then null else auth.uid() end,
      reviewed_at = case when v_status = 'pending' then null else now() end,
      updated_at = now()
  where page_id = p_page_id
    and generation_status = 'ready'
  returning * into v_profile;

  if v_profile.page_id is null then
    raise exception 'A ready AI link phrase profile was not found.';
  end if;
  return v_profile;
end;
$$;

revoke all on table public.client_page_ai_link_profiles
  from public, anon, authenticated;
revoke all on function public.review_client_page_ai_link_profile(uuid, text)
  from public, anon;

grant select on table public.client_page_ai_link_profiles to authenticated;
grant select, insert, update, delete
  on table public.client_page_ai_link_profiles
  to service_role;
grant execute on function public.review_client_page_ai_link_profile(uuid, text)
  to authenticated, service_role;

comment on table public.client_page_ai_link_profiles is
  'Structured, reviewable AI phrase enrichment for internal linking. Raw crawled page content is never stored here.';
comment on column public.client_page_ai_link_profiles.negative_phrases is
  'Ambiguous or misleading contexts that suppress this target during internal-link matching.';
comment on column public.client_page_ai_link_profiles.review_status is
  'Administrator review state. Rejected profiles never contribute AI signals.';

commit;
