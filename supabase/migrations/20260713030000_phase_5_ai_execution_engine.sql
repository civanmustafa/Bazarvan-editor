begin;

create table if not exists public.ai_execution_events (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  user_id uuid references public.profiles(id) on delete set null,
  provider text not null,
  model text not null,
  key_suffix text,
  outcome text not null check (outcome in ('success', 'failed', 'cancelled')),
  status integer,
  source text not null default 'unknown',
  article_id uuid references public.articles(id) on delete set null,
  duration_ms integer not null default 0 check (duration_ms >= 0),
  attempts jsonb not null default '[]'::jsonb check (jsonb_typeof(attempts) = 'array'),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists ai_execution_events_created_at_idx
  on public.ai_execution_events(created_at desc);
create index if not exists ai_execution_events_user_created_idx
  on public.ai_execution_events(user_id, created_at desc);
create index if not exists ai_execution_events_article_created_idx
  on public.ai_execution_events(article_id, created_at desc);
create index if not exists ai_execution_events_provider_model_idx
  on public.ai_execution_events(provider, model, created_at desc);

alter table public.ai_execution_events enable row level security;

drop policy if exists "ai_execution_events_admin_select" on public.ai_execution_events;
create policy "ai_execution_events_admin_select"
on public.ai_execution_events
for select
to authenticated
using (public.is_admin());

revoke all on public.ai_execution_events from anon;
revoke insert, update, delete on public.ai_execution_events from authenticated;
grant select on public.ai_execution_events to authenticated;

comment on table public.ai_execution_events is
  'Server-authenticated AI request telemetry. Raw API keys and key fingerprints are never stored.';

commit;
