begin;

-- Durable, server-side queue for articles whose saved inputs are ready for the
-- existing structured content-writing engine. The queue never simulates a UI
-- click and therefore keeps working while the editor is closed.
create table if not exists public.content_writing_automation_items (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null unique references public.articles(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'ready'
    check (status in ('ready', 'claiming', 'writing', 'completed', 'blocked', 'cancelled')),
  readiness_signature text not null,
  usable_competitor_count integer not null default 0 check (usable_competitor_count >= 0),
  pending_competitor_count integer not null default 0 check (pending_competitor_count >= 0),
  provider text not null check (provider in ('gemini', 'geminiPaid', 'openai')),
  model text not null default '',
  content_writing_session_id uuid references public.content_writing_sessions(id) on delete set null,
  run_generation integer not null default 1 check (run_generation >= 1),
  session_sequence integer not null default 1 check (session_sequence >= 1),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  ready_at timestamptz not null default now(),
  eligible_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_writing_automation_claim_idx
  on public.content_writing_automation_items(status, eligible_at, ready_at)
  where status in ('ready', 'claiming', 'writing');
create index if not exists content_writing_automation_session_idx
  on public.content_writing_automation_items(content_writing_session_id)
  where content_writing_session_id is not null;

drop trigger if exists set_content_writing_automation_items_updated_at
  on public.content_writing_automation_items;
create trigger set_content_writing_automation_items_updated_at
before update on public.content_writing_automation_items
for each row execute function public.set_updated_at();

create table if not exists public.content_writing_automation_state (
  singleton boolean primary key default true check (singleton is true),
  next_allowed_at timestamptz not null default now(),
  last_item_id uuid references public.content_writing_automation_items(id) on delete set null,
  last_session_id uuid references public.content_writing_sessions(id) on delete set null,
  last_article_id uuid references public.articles(id) on delete set null,
  last_outcome text,
  updated_at timestamptz not null default now()
);

insert into public.content_writing_automation_state(singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.content_writing_automation_items enable row level security;
alter table public.content_writing_automation_state enable row level security;

drop policy if exists "content_writing_automation_items_select_visible"
  on public.content_writing_automation_items;
create policy "content_writing_automation_items_select_visible"
on public.content_writing_automation_items
for select
to authenticated
using (public.can_read_article(article_id));

drop policy if exists "content_writing_automation_state_select_admin"
  on public.content_writing_automation_state;
create policy "content_writing_automation_state_select_admin"
on public.content_writing_automation_state
for select
to authenticated
using (public.is_admin());

revoke all on public.content_writing_automation_items from public, anon, authenticated;
revoke all on public.content_writing_automation_state from public, anon, authenticated;
grant select on public.content_writing_automation_items to authenticated;
grant select on public.content_writing_automation_state to authenticated;
grant all on public.content_writing_automation_items to service_role;
grant all on public.content_writing_automation_state to service_role;

-- Returns the same human-reviewable prerequisites used by the TypeScript
-- content-writing context, plus durable competitor-processing state.
create or replace function public.evaluate_content_writing_automation_readiness(
  p_article_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_missing jsonb := '[]'::jsonb;
  v_metadata_competitors jsonb;
  v_metadata_count integer := 0;
  v_database_count integer := 0;
  v_pending_count integer := 0;
  v_usable_count integer := 0;
  v_database_fingerprint jsonb := '[]'::jsonb;
  v_signature text;
begin
  select article.*
  into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null then
    return jsonb_build_object(
      'ready', false,
      'missingFields', jsonb_build_array('article_not_found'),
      'signature', '',
      'usableCompetitorCount', 0,
      'pendingCompetitorCount', 0,
      'processingComplete', true
    );
  end if;

  v_metadata_competitors := coalesce(
    v_article.metadata #> '{attachments,competitors}',
    v_article.metadata -> 'competitors',
    '{}'::jsonb
  );

  select count(*)::integer
  into v_metadata_count
  from jsonb_array_elements_text(
    case
      when jsonb_typeof(v_metadata_competitors -> 'texts') = 'array'
        then v_metadata_competitors -> 'texts'
      else '[]'::jsonb
    end
  ) with ordinality as item(value, position)
  where item.position <= 5
    and nullif(btrim(item.value), '') is not null
    and btrim(item.value) not like '[تعذر استخراج محتوى المنافس]%';

  select
    count(*) filter (
      where competitor.status = 'completed'
        and nullif(btrim(competitor.content_text), '') is not null
        and btrim(competitor.content_text) not like '[تعذر استخراج محتوى المنافس]%'
    )::integer,
    count(*) filter (
      where competitor.status in ('queued', 'extracting', 'retry_scheduled')
    )::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'position', competitor.position,
          'status', competitor.status,
          'contentHash', md5(coalesce(competitor.content_text, ''))
        ) order by competitor.position
      ),
      '[]'::jsonb
    )
  into v_database_count, v_pending_count, v_database_fingerprint
  from public.article_competitors as competitor
  where competitor.article_id = v_article.id;

  v_usable_count := greatest(coalesce(v_metadata_count, 0), coalesce(v_database_count, 0));

  if coalesce(v_article.status, '') not in ('content_preparation', 'draft') then
    v_missing := v_missing || jsonb_build_array('draft_status');
  end if;
  if nullif(btrim(coalesce(v_article.title, '')), '') is null
     or lower(btrim(v_article.title)) in ('(untitled)', 'untitled', 'draft') then
    v_missing := v_missing || jsonb_build_array('article_title');
  end if;
  if nullif(btrim(coalesce(v_article.keywords ->> 'primary', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('primary_keyword');
  end if;
  if jsonb_typeof(v_article.keywords -> 'secondaries') <> 'array'
     or not exists (
       select 1
       from jsonb_array_elements_text(v_article.keywords -> 'secondaries') as keyword(value)
       where nullif(btrim(keyword.value), '') is not null
     ) then
    v_missing := v_missing || jsonb_build_array('alternative_keywords');
  end if;
  if jsonb_typeof(v_article.keywords -> 'lsi') <> 'array'
     or not exists (
       select 1
       from jsonb_array_elements_text(v_article.keywords -> 'lsi') as keyword(value)
       where nullif(btrim(keyword.value), '') is not null
     ) then
    v_missing := v_missing || jsonb_build_array('lsi_keywords');
  end if;
  if nullif(btrim(coalesce(v_article.keywords ->> 'company', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('company_name');
  end if;
  if nullif(btrim(coalesce(v_article.goal_context ->> 'pageType', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('goal_context.pageType');
  end if;
  if nullif(btrim(coalesce(v_article.goal_context ->> 'objective', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('goal_context.objective');
  end if;
  if nullif(btrim(coalesce(v_article.goal_context ->> 'audienceScope', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('goal_context.audienceScope');
  end if;
  if nullif(btrim(coalesce(v_article.goal_context ->> 'searchIntent', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('goal_context.searchIntent');
  end if;
  if v_usable_count < 1 then
    v_missing := v_missing || jsonb_build_array('competitors');
  end if;

  v_signature := md5(jsonb_build_object(
    'status', case when v_article.status in ('content_preparation', 'draft') then 'draft' else v_article.status end,
    'title', coalesce(v_article.title, ''),
    'keywords', coalesce(v_article.keywords, '{}'::jsonb),
    'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
    'metadataCompetitorTexts', coalesce(v_metadata_competitors -> 'texts', '[]'::jsonb),
    'databaseCompetitors', v_database_fingerprint
  )::text);

  return jsonb_build_object(
    'ready', jsonb_array_length(v_missing) = 0,
    'missingFields', v_missing,
    'signature', v_signature,
    'usableCompetitorCount', v_usable_count,
    'pendingCompetitorCount', coalesce(v_pending_count, 0),
    'processingComplete', coalesce(v_pending_count, 0) = 0,
    'articleTitle', coalesce(v_article.title, ''),
    'articleStatus', coalesce(v_article.status, ''),
    'articleUpdatedAt', v_article.updated_at
  );
end;
$$;

-- Claims exactly one ready article across all worker processes. Manual content
-- writing and an active full workflow always win; automatic work waits.
create or replace function public.claim_next_content_writing_automation_item(
  p_worker_id text,
  p_provider text,
  p_model text default '',
  p_min_competitor_count integer default 1,
  p_require_processing_complete boolean default true,
  p_max_attempts integer default 3,
  p_lease_seconds integer default 300
)
returns public.content_writing_automation_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.content_writing_automation_state%rowtype;
  v_article public.articles%rowtype;
  v_item public.content_writing_automation_items%rowtype;
  v_readiness jsonb;
  v_requested_by uuid;
  v_min_competitors integer := greatest(1, least(coalesce(p_min_competitor_count, 1), 5));
  v_max_attempts integer := greatest(1, least(coalesce(p_max_attempts, 3), 10));
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 300), 1800));
begin
  if nullif(btrim(coalesce(p_worker_id, '')), '') is null then
    raise exception 'Automation worker id is required.' using errcode = '22023';
  end if;
  if p_provider not in ('gemini', 'geminiPaid', 'openai') then
    raise exception 'A valid automation provider is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('content-writing-automation-claim', 0));

  update public.content_writing_automation_items as item
  set
    status = case
      when item.attempt_count >= item.max_attempts then 'blocked'
      else 'ready'
    end,
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    eligible_at = case
      when item.attempt_count >= item.max_attempts then item.eligible_at
      else least(item.eligible_at, now())
    end,
    last_error_code = 'automation_claim_lease_expired',
    last_error = 'The automatic-writing reservation expired before a session was attached.',
    completed_at = case
      when item.attempt_count >= item.max_attempts then now()
      else null
    end
  where item.status = 'claiming'
    and coalesce(item.lease_expires_at, item.locked_at, item.updated_at) <= now();

  select state.*
  into v_state
  from public.content_writing_automation_state as state
  where state.singleton is true
  for update;

  if coalesce(v_state.next_allowed_at, now()) > now() then
    return null;
  end if;

  if exists (
    select 1
    from public.content_writing_automation_items as item
    where item.status in ('claiming', 'writing')
  ) then
    return null;
  end if;

  if exists (
    select 1
    from public.content_writing_sessions as session
    where session.execution_mode = 'api'
      and session.status in ('queued', 'running', 'retry_scheduled')
  ) then
    return null;
  end if;

  if exists (
    select 1
    from public.ai_external_analysis_jobs as job
    where job.job_type = 'full_article_pipeline'
      and (
        job.status in ('queued', 'running')
        or (
          job.status = 'retry_scheduled'
          and coalesce(job.next_attempt_at, now()) <= now()
        )
      )
  ) then
    return null;
  end if;

  select article.*
  into v_article
  from public.articles as article
  left join public.content_writing_automation_items as existing
    on existing.article_id = article.id
  cross join lateral (
    select public.evaluate_content_writing_automation_readiness(article.id) as value
  ) as readiness
  where article.status in ('content_preparation', 'draft')
    and coalesce((readiness.value ->> 'ready')::boolean, false) is true
    and coalesce((readiness.value ->> 'usableCompetitorCount')::integer, 0) >= v_min_competitors
    and (
      p_require_processing_complete is not true
      or coalesce((readiness.value ->> 'processingComplete')::boolean, false) is true
    )
    and (existing.id is null or (
      existing.status = 'ready'
      and existing.eligible_at <= now()
      and existing.attempt_count < existing.max_attempts
    ))
    and (
      existing.id is not null
      or not exists (
        select 1
        from public.content_writing_sessions as completed_session
        where completed_session.article_id = article.id
          and completed_session.status = 'completed'
      )
    )
    and not exists (
      select 1
      from public.ai_external_analysis_jobs as article_pipeline
      where article_pipeline.article_id = article.id
        and article_pipeline.job_type = 'full_article_pipeline'
        and article_pipeline.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    )
  order by coalesce(existing.ready_at, article.updated_at, article.created_at), article.id
  limit 1
  for update of article skip locked;

  if v_article.id is null then
    return null;
  end if;

  v_readiness := public.evaluate_content_writing_automation_readiness(v_article.id);
  select profile.id
  into v_requested_by
  from public.profiles as profile
  where profile.id in (v_article.assigned_to, v_article.owner_id, v_article.created_by)
    and profile.is_active is true
    and public.article_access_level_for_user(v_article.id, profile.id) in ('write', 'admin')
  order by case profile.id
    when v_article.assigned_to then 1
    when v_article.owner_id then 2
    else 3
  end
  limit 1;

  if v_requested_by is null then
    select profile.id
    into v_requested_by
    from public.profiles as profile
    where profile.role = 'admin'::public.app_role
      and profile.is_active is true
      and public.article_access_level_for_user(v_article.id, profile.id) in ('write', 'admin')
    order by profile.created_at
    limit 1;
  end if;

  if v_requested_by is null then
    return null;
  end if;

  insert into public.content_writing_automation_items (
    article_id,
    requested_by,
    status,
    readiness_signature,
    usable_competitor_count,
    pending_competitor_count,
    provider,
    model,
    session_sequence,
    attempt_count,
    max_attempts,
    ready_at,
    eligible_at,
    locked_by,
    locked_at,
    lease_expires_at,
    started_at,
    last_error_code,
    last_error
  ) values (
    v_article.id,
    v_requested_by,
    'claiming',
    coalesce(v_readiness ->> 'signature', ''),
    coalesce((v_readiness ->> 'usableCompetitorCount')::integer, 0),
    coalesce((v_readiness ->> 'pendingCompetitorCount')::integer, 0),
    p_provider,
    left(btrim(coalesce(p_model, '')), 160),
    1,
    1,
    v_max_attempts,
    now(),
    now(),
    left(btrim(p_worker_id), 200),
    now(),
    now() + make_interval(secs => v_lease_seconds),
    now(),
    null,
    null
  )
  on conflict (article_id) do update
  set
    requested_by = excluded.requested_by,
    status = 'claiming',
    readiness_signature = excluded.readiness_signature,
    usable_competitor_count = excluded.usable_competitor_count,
    pending_competitor_count = excluded.pending_competitor_count,
    provider = excluded.provider,
    model = excluded.model,
    content_writing_session_id = null,
    session_sequence = case
      when public.content_writing_automation_items.content_writing_session_id is not null
        then public.content_writing_automation_items.session_sequence + 1
      else public.content_writing_automation_items.session_sequence
    end,
    attempt_count = public.content_writing_automation_items.attempt_count + 1,
    max_attempts = excluded.max_attempts,
    eligible_at = now(),
    locked_by = excluded.locked_by,
    locked_at = now(),
    lease_expires_at = excluded.lease_expires_at,
    started_at = coalesce(public.content_writing_automation_items.started_at, now()),
    completed_at = null,
    last_error_code = null,
    last_error = null
  where public.content_writing_automation_items.status = 'ready'
    and public.content_writing_automation_items.eligible_at <= now()
    and public.content_writing_automation_items.attempt_count < public.content_writing_automation_items.max_attempts
  returning * into v_item;

  return v_item;
end;
$$;

-- Reconciles one linked automatic item from the authoritative session row.
-- It is deliberately callable both by the session trigger and by attach(): a
-- very fast session may become terminal before attach commits, and that path
-- must still persist the terminal outcome and start the global cooldown.
create or replace function public.reconcile_content_writing_automation_session(
  p_item_id uuid,
  p_session_id uuid
)
returns public.content_writing_automation_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.content_writing_automation_items%rowtype;
  v_session public.content_writing_sessions%rowtype;
  v_ai jsonb := '{}'::jsonb;
  v_interval_minutes integer := 15;
  v_retry_minutes integer := 30;
  v_terminal_at timestamptz;
  v_next_allowed_at timestamptz;
  v_expected_idempotency_key text;
begin
  select session.*
  into v_session
  from public.content_writing_sessions as session
  where session.id = p_session_id
  for update;
  if v_session.id is null then
    raise exception 'Content-writing session was not found.' using errcode = 'P0002';
  end if;

  select item.*
  into v_item
  from public.content_writing_automation_items as item
  where item.id = p_item_id
  for update;
  if v_item.id is null then
    raise exception 'Automatic-writing item was not found.' using errcode = 'P0002';
  end if;

  v_expected_idempotency_key := concat_ws(
    ':',
    'auto-ready',
    v_item.id::text,
    v_item.run_generation::text,
    v_item.session_sequence::text
  );
  if v_session.article_id <> v_item.article_id
     or v_session.created_by <> v_item.requested_by
     or v_session.provider <> v_item.provider
     or v_session.idempotency_key <> v_expected_idempotency_key
     or coalesce(v_session.context_snapshot ->> 'triggerSource', '') <> 'automatic_ready'
     or coalesce(v_session.context_snapshot ->> 'automationItemId', '') <> v_item.id::text
     or coalesce(v_session.context_snapshot ->> 'automationRunGeneration', '') <> v_item.run_generation::text
     or coalesce(v_session.context_snapshot ->> 'automationSessionSequence', '') <> v_item.session_sequence::text
     or (
       v_item.content_writing_session_id is not null
       and v_item.content_writing_session_id <> v_session.id
     ) then
    raise exception 'Content-writing session does not belong to this automatic-writing run.'
      using errcode = '22023';
  end if;

  select coalesce(setting.value, '{}'::jsonb)
  into v_ai
  from public.app_settings as setting
  where setting.key = 'ai';
  if coalesce(v_ai ->> 'contentWritingAutomationIntervalMinutes', '') ~ '^\d+$' then
    v_interval_minutes := greatest(1, least((v_ai ->> 'contentWritingAutomationIntervalMinutes')::integer, 1440));
  end if;
  if coalesce(v_ai ->> 'contentWritingAutomationRetryMinutes', '') ~ '^\d+$' then
    v_retry_minutes := greatest(1, least((v_ai ->> 'contentWritingAutomationRetryMinutes')::integer, 1440));
  end if;

  v_terminal_at := coalesce(v_session.completed_at, v_session.updated_at, now());
  update public.content_writing_automation_items as item
  set
    content_writing_session_id = v_session.id,
    model = v_session.model,
    status = case
      when v_session.status = 'completed' then 'completed'
      when v_session.status = 'cancelled'
        or coalesce(v_session.last_error_code, '') = 'content_writing_cancelled' then 'cancelled'
      when v_session.status = 'failed' and item.attempt_count < item.max_attempts then 'ready'
      when v_session.status = 'failed' then 'blocked'
      else 'writing'
    end,
    eligible_at = case
      when v_session.status = 'failed'
        and item.attempt_count < item.max_attempts
        and coalesce(v_session.last_error_code, '') <> 'content_writing_cancelled'
        then v_terminal_at + make_interval(mins => v_retry_minutes)
      else item.eligible_at
    end,
    completed_at = case
      when v_session.status = 'failed'
        and item.attempt_count < item.max_attempts
        and coalesce(v_session.last_error_code, '') <> 'content_writing_cancelled'
        then null
      when v_session.status in ('completed', 'failed', 'cancelled') then v_terminal_at
      else null
    end,
    last_error_code = case
      when v_session.status = 'completed' then null
      when v_session.status in ('failed', 'cancelled')
        then coalesce(v_session.last_error_code, 'content_writing_failed')
      else item.last_error_code
    end,
    last_error = case
      when v_session.status = 'completed' then null
      when v_session.status in ('failed', 'cancelled')
        then coalesce(v_session.last_error, 'Automatic content writing stopped.')
      else item.last_error
    end,
    locked_by = null,
    locked_at = null,
    lease_expires_at = null
  where item.id = v_item.id
  returning item.* into v_item;

  if v_session.status in ('completed', 'failed', 'cancelled') then
    v_next_allowed_at := v_terminal_at + make_interval(mins => v_interval_minutes);
    insert into public.content_writing_automation_state (
      singleton,
      next_allowed_at,
      last_item_id,
      last_session_id,
      last_article_id,
      last_outcome,
      updated_at
    ) values (
      true,
      v_next_allowed_at,
      v_item.id,
      v_session.id,
      v_session.article_id,
      case
        when v_session.status = 'cancelled'
          or coalesce(v_session.last_error_code, '') = 'content_writing_cancelled' then 'cancelled'
        else v_session.status
      end,
      now()
    )
    on conflict (singleton) do update
    set
      next_allowed_at = greatest(
        public.content_writing_automation_state.next_allowed_at,
        excluded.next_allowed_at
      ),
      last_item_id = excluded.last_item_id,
      last_session_id = excluded.last_session_id,
      last_article_id = excluded.last_article_id,
      last_outcome = excluded.last_outcome,
      updated_at = now();
  end if;

  return v_item;
end;
$$;

create or replace function public.attach_content_writing_automation_session(
  p_item_id uuid,
  p_session_id uuid,
  p_worker_id text
)
returns public.content_writing_automation_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.content_writing_automation_items%rowtype;
  v_session public.content_writing_sessions%rowtype;
  v_expected_idempotency_key text;
begin
  -- Lock in session -> item order, matching the terminal-session trigger.
  select session.*
  into v_session
  from public.content_writing_sessions as session
  where session.id = p_session_id
  for update;
  if v_session.id is null then
    raise exception 'Content-writing session was not found.' using errcode = 'P0002';
  end if;

  select item.*
  into v_item
  from public.content_writing_automation_items as item
  where item.id = p_item_id
  for update;
  if v_item.id is null then
    raise exception 'Automatic-writing item was not found.' using errcode = 'P0002';
  end if;

  v_expected_idempotency_key := concat_ws(
    ':',
    'auto-ready',
    v_item.id::text,
    v_item.run_generation::text,
    v_item.session_sequence::text
  );
  if v_session.article_id <> v_item.article_id
     or v_session.created_by <> v_item.requested_by
     or v_session.provider <> v_item.provider
     or v_session.idempotency_key <> v_expected_idempotency_key
     or coalesce(v_session.context_snapshot ->> 'triggerSource', '') <> 'automatic_ready'
     or coalesce(v_session.context_snapshot ->> 'automationItemId', '') <> v_item.id::text
     or coalesce(v_session.context_snapshot ->> 'automationRunGeneration', '') <> v_item.run_generation::text
     or coalesce(v_session.context_snapshot ->> 'automationSessionSequence', '') <> v_item.session_sequence::text then
    raise exception 'Content-writing session does not match the claimed automatic-writing run.'
      using errcode = '22023';
  end if;

  if v_item.content_writing_session_id = v_session.id then
    return public.reconcile_content_writing_automation_session(v_item.id, v_session.id);
  end if;
  if v_item.content_writing_session_id is not null
     or v_item.status <> 'claiming'
     or v_item.locked_by is distinct from left(btrim(coalesce(p_worker_id, '')), 200) then
    raise exception 'The automatic-writing item is no longer owned by this worker.' using errcode = '55000';
  end if;

  update public.content_writing_automation_items as item
  set content_writing_session_id = v_session.id
  where item.id = v_item.id;

  return public.reconcile_content_writing_automation_session(v_item.id, v_session.id);
end;
$$;

create or replace function public.release_content_writing_automation_claim(
  p_item_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_retry_delay_minutes integer default 30
)
returns public.content_writing_automation_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.content_writing_automation_items%rowtype;
  v_retry_minutes integer := greatest(1, least(coalesce(p_retry_delay_minutes, 30), 1440));
begin
  update public.content_writing_automation_items as item
  set
    status = case when item.attempt_count >= item.max_attempts then 'blocked' else 'ready' end,
    eligible_at = case
      when item.attempt_count >= item.max_attempts then item.eligible_at
      else now() + make_interval(mins => v_retry_minutes)
    end,
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    last_error_code = left(nullif(btrim(coalesce(p_error_code, '')), ''), 160),
    last_error = left(nullif(btrim(coalesce(p_error_message, '')), ''), 4000),
    completed_at = case when item.attempt_count >= item.max_attempts then now() else null end
  where item.id = p_item_id
    and item.status = 'claiming'
    and item.locked_by = left(btrim(coalesce(p_worker_id, '')), 200)
  returning item.* into v_item;

  return v_item;
end;
$$;

create or replace function public.sync_content_writing_automation_session()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item_id uuid;
begin
  if new.status not in ('completed', 'failed', 'cancelled')
     or new.status is not distinct from old.status then
    return new;
  end if;

  select item.id
  into v_item_id
  from public.content_writing_automation_items as item
  where item.content_writing_session_id = new.id;
  if v_item_id is null then
    return new;
  end if;

  perform public.reconcile_content_writing_automation_session(v_item_id, new.id);

  return new;
end;
$$;

drop trigger if exists sync_content_writing_automation_session_status
  on public.content_writing_sessions;
create trigger sync_content_writing_automation_session_status
after update of status on public.content_writing_sessions
for each row execute function public.sync_content_writing_automation_session();

create or replace function public.reset_content_writing_automation_item(
  p_item_id uuid,
  p_requested_by uuid
)
returns public.content_writing_automation_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.content_writing_automation_items%rowtype;
begin
  select item.*
  into v_item
  from public.content_writing_automation_items as item
  where item.id = p_item_id
  for update;
  if v_item.id is null then
    raise exception 'Automatic-writing item was not found.' using errcode = 'P0002';
  end if;
  if public.article_access_level_for_user(v_item.article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if v_item.status in ('claiming', 'writing') then
    raise exception 'Active automatic writing cannot be reset.' using errcode = '55000';
  end if;

  update public.content_writing_automation_items as item
  set
    requested_by = p_requested_by,
    status = 'ready',
    content_writing_session_id = null,
    run_generation = item.run_generation + 1,
    session_sequence = 1,
    attempt_count = 0,
    ready_at = now(),
    eligible_at = now(),
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    last_error_code = null,
    last_error = null,
    started_at = null,
    completed_at = null
  where item.id = v_item.id
  returning item.* into v_item;

  insert into public.worker_queue_signals(queue_name) values ('content_writing');
  return v_item;
end;
$$;

create or replace function public.list_content_writing_automation_candidates(
  p_requested_by uuid,
  p_limit integer default 10,
  p_min_competitor_count integer default 1,
  p_require_processing_complete boolean default true
)
returns table (
  article_id uuid,
  article_title text,
  article_status text,
  article_updated_at timestamptz,
  readiness jsonb,
  item_id uuid,
  item_status text,
  eligible_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    article.id,
    article.title,
    article.status,
    article.updated_at,
    evaluated.value,
    existing.id,
    existing.status,
    existing.eligible_at
  from public.articles as article
  left join public.content_writing_automation_items as existing
    on existing.article_id = article.id
  cross join lateral (
    select public.evaluate_content_writing_automation_readiness(article.id) as value
  ) as evaluated
  where public.article_access_level_for_user(article.id, p_requested_by) <> 'none'
    and article.status in ('content_preparation', 'draft')
    and coalesce((evaluated.value ->> 'ready')::boolean, false) is true
    and coalesce((evaluated.value ->> 'usableCompetitorCount')::integer, 0)
      >= greatest(1, least(coalesce(p_min_competitor_count, 1), 5))
    and (
      p_require_processing_complete is not true
      or coalesce((evaluated.value ->> 'processingComplete')::boolean, false) is true
    )
    and (existing.id is null or existing.status = 'ready')
    and (
      existing.id is not null
      or not exists (
        select 1
        from public.content_writing_sessions as completed_session
        where completed_session.article_id = article.id
          and completed_session.status = 'completed'
      )
    )
    and not exists (
      select 1
      from public.ai_external_analysis_jobs as article_pipeline
      where article_pipeline.article_id = article.id
        and article_pipeline.job_type = 'full_article_pipeline'
        and article_pipeline.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    )
  order by coalesce(existing.ready_at, article.updated_at, article.created_at), article.id
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

create or replace function public.cancel_content_writing_automation_item(
  p_item_id uuid,
  p_requested_by uuid
)
returns public.content_writing_automation_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.content_writing_automation_items%rowtype;
begin
  select item.*
  into v_item
  from public.content_writing_automation_items as item
  where item.id = p_item_id
  for update;
  if v_item.id is null then
    raise exception 'Automatic-writing item was not found.' using errcode = 'P0002';
  end if;
  if public.article_access_level_for_user(v_item.article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if v_item.status in ('claiming', 'writing') then
    raise exception 'Cancel the active content-writing session from its writing panel.' using errcode = '55000';
  end if;

  update public.content_writing_automation_items as item
  set
    status = 'cancelled',
    completed_at = now(),
    last_error_code = 'automation_cancelled_by_user',
    last_error = 'Automatic writing was removed from the queue by the user.'
  where item.id = v_item.id
  returning item.* into v_item;
  return v_item;
end;
$$;

-- Serializes an explicit manual/full-pipeline intent with the automatic
-- scheduler. The cancelled sentinel closes the small gap between this RPC and
-- creation/resumption of the explicit job in the following API statement.
create or replace function public.reserve_article_for_explicit_content_writing(
  p_article_id uuid,
  p_requested_by uuid,
  p_intent text,
  p_allowed_session_id uuid default null,
  p_allowed_pipeline_job_id uuid default null,
  p_provider text default 'gemini',
  p_model text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_item public.content_writing_automation_items%rowtype;
  v_readiness jsonb := '{}'::jsonb;
  v_intent text := btrim(coalesce(p_intent, ''));
  v_reason text;
  v_active_session_id uuid;
  v_active_pipeline_job_id uuid;
  v_active_pipeline_status text;
  v_conflicting_pipeline_job_id uuid;
  v_has_completed_session boolean := false;
begin
  if v_intent not in ('manual', 'resume', 'apply', 'full_pipeline', 'full_pipeline_resume') then
    raise exception 'Unsupported explicit content-writing intent.' using errcode = '22023';
  end if;
  if p_provider not in ('gemini', 'geminiPaid', 'openai') then
    raise exception 'A valid content-writing provider is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('content-writing-automation-claim', 0));

  select article.*
  into v_article
  from public.articles as article
  where article.id = p_article_id
  for update;
  if v_article.id is null then
    raise exception 'Article was not found.' using errcode = 'P0002';
  end if;
  if public.article_access_level_for_user(v_article.id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;

  select session.id
  into v_active_session_id
  from public.content_writing_sessions as session
  where session.article_id = v_article.id
    and session.execution_mode = 'api'
    and session.status in ('queued', 'running', 'retry_scheduled')
  order by
    case session.status when 'running' then 0 when 'queued' then 1 else 2 end,
    session.created_at
  limit 1;

  select job.id, job.status
  into v_active_pipeline_job_id, v_active_pipeline_status
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.job_type = 'full_article_pipeline'
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  order by job.created_at desc
  limit 1;

  select job.id
  into v_conflicting_pipeline_job_id
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.job_type = 'full_article_pipeline'
    and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    and (p_allowed_pipeline_job_id is null or job.id <> p_allowed_pipeline_job_id)
  order by job.created_at desc
  limit 1;

  select exists (
    select 1
    from public.content_writing_sessions as session
    where session.article_id = v_article.id
      and session.status = 'completed'
  ) into v_has_completed_session;

  if v_intent in ('full_pipeline', 'full_pipeline_resume')
     and v_active_session_id is not null then
    return jsonb_build_object(
      'reserved', false,
      'reason', 'active_content_writing_session',
      'automationItemId', null,
      'automationSessionId', null,
      'activeContentWritingSessionId', v_active_session_id,
      'activeFullPipelineJobId', v_active_pipeline_job_id,
      'activeFullPipelineStatus', v_active_pipeline_status,
      'hasCompletedContentWritingSession', v_has_completed_session
    );
  end if;
  if v_intent not in ('full_pipeline', 'full_pipeline_resume')
     and v_active_session_id is not null
     and v_active_session_id is distinct from p_allowed_session_id then
    return jsonb_build_object(
      'reserved', false,
      'reason', 'active_content_writing_session',
      'automationItemId', null,
      'automationSessionId', null,
      'activeContentWritingSessionId', v_active_session_id,
      'activeFullPipelineJobId', v_active_pipeline_job_id,
      'activeFullPipelineStatus', v_active_pipeline_status,
      'hasCompletedContentWritingSession', v_has_completed_session
    );
  end if;
  if v_intent not in ('full_pipeline', 'full_pipeline_resume')
     and v_active_pipeline_job_id is not null then
    return jsonb_build_object(
      'reserved', false,
      'reason', 'active_full_article_pipeline',
      'automationItemId', null,
      'automationSessionId', null,
      'activeContentWritingSessionId', v_active_session_id,
      'activeFullPipelineJobId', v_active_pipeline_job_id,
      'activeFullPipelineStatus', v_active_pipeline_status,
      'hasCompletedContentWritingSession', v_has_completed_session
    );
  end if;
  if v_intent = 'full_pipeline_resume'
     and (
       p_allowed_pipeline_job_id is null
       or v_conflicting_pipeline_job_id is not null
       or (
         v_active_pipeline_job_id is not null
         and (
           v_active_pipeline_job_id <> p_allowed_pipeline_job_id
           or v_active_pipeline_status <> 'retry_scheduled'
         )
       )
     ) then
    return jsonb_build_object(
      'reserved', false,
      'reason', 'different_full_article_pipeline_active',
      'automationItemId', null,
      'automationSessionId', null,
      'activeContentWritingSessionId', v_active_session_id,
      'activeFullPipelineJobId', v_active_pipeline_job_id,
      'activeFullPipelineStatus', v_active_pipeline_status,
      'hasCompletedContentWritingSession', v_has_completed_session
    );
  end if;

  select item.*
  into v_item
  from public.content_writing_automation_items as item
  where item.article_id = v_article.id
  for update;

  if v_item.id is not null
     and v_item.status in ('claiming', 'writing')
     and v_item.content_writing_session_id is distinct from p_allowed_session_id then
    return jsonb_build_object(
      'reserved', false,
      'reason', 'automatic_content_writing_active',
      'automationItemId', v_item.id,
      'automationSessionId', v_item.content_writing_session_id,
      'activeContentWritingSessionId', v_active_session_id,
      'activeFullPipelineJobId', v_active_pipeline_job_id,
      'activeFullPipelineStatus', v_active_pipeline_status,
      'hasCompletedContentWritingSession', v_has_completed_session
    );
  end if;

  v_readiness := public.evaluate_content_writing_automation_readiness(v_article.id);
  v_reason := 'superseded_by_explicit_' || v_intent;
  insert into public.content_writing_automation_items (
    article_id,
    requested_by,
    status,
    readiness_signature,
    usable_competitor_count,
    pending_competitor_count,
    provider,
    model,
    run_generation,
    session_sequence,
    attempt_count,
    max_attempts,
    ready_at,
    eligible_at,
    completed_at,
    last_error_code,
    last_error
  ) values (
    v_article.id,
    p_requested_by,
    'cancelled',
    coalesce(nullif(v_readiness ->> 'signature', ''), md5(v_article.id::text || ':' || v_intent)),
    greatest(0, coalesce((v_readiness ->> 'usableCompetitorCount')::integer, 0)),
    greatest(0, coalesce((v_readiness ->> 'pendingCompetitorCount')::integer, 0)),
    p_provider,
    left(btrim(coalesce(p_model, '')), 160),
    1,
    1,
    0,
    3,
    now(),
    now(),
    now(),
    left(v_reason, 160),
    'Automatic writing was superseded by an explicit article-writing request.'
  )
  on conflict (article_id) do update
  set
    requested_by = excluded.requested_by,
    status = 'cancelled',
    provider = excluded.provider,
    model = excluded.model,
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    completed_at = now(),
    last_error_code = excluded.last_error_code,
    last_error = excluded.last_error
  where public.content_writing_automation_items.status not in ('claiming', 'writing')
     or public.content_writing_automation_items.content_writing_session_id = p_allowed_session_id
  returning * into v_item;

  if v_item.id is null then
    return jsonb_build_object(
      'reserved', false,
      'reason', 'automatic_content_writing_active',
      'automationItemId', null,
      'automationSessionId', null,
      'activeContentWritingSessionId', v_active_session_id,
      'activeFullPipelineJobId', v_active_pipeline_job_id,
      'activeFullPipelineStatus', v_active_pipeline_status,
      'hasCompletedContentWritingSession', v_has_completed_session
    );
  end if;

  return jsonb_build_object(
    'reserved', true,
    'reason', v_reason,
    'automationItemId', v_item.id,
    'automationSessionId', v_item.content_writing_session_id,
    'activeContentWritingSessionId', v_active_session_id,
    'activeFullPipelineJobId', v_active_pipeline_job_id,
    'activeFullPipelineStatus', v_active_pipeline_status,
    'hasCompletedContentWritingSession', v_has_completed_session
  );
end;
$$;

revoke all on function public.evaluate_content_writing_automation_readiness(uuid) from public, anon, authenticated;
revoke all on function public.claim_next_content_writing_automation_item(text, text, text, integer, boolean, integer, integer) from public, anon, authenticated;
revoke all on function public.attach_content_writing_automation_session(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.release_content_writing_automation_claim(uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.reset_content_writing_automation_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cancel_content_writing_automation_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_content_writing_automation_candidates(uuid, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.sync_content_writing_automation_session() from public, anon, authenticated;
revoke all on function public.reconcile_content_writing_automation_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reserve_article_for_explicit_content_writing(uuid, uuid, text, uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.evaluate_content_writing_automation_readiness(uuid) to service_role;
grant execute on function public.claim_next_content_writing_automation_item(text, text, text, integer, boolean, integer, integer) to service_role;
grant execute on function public.attach_content_writing_automation_session(uuid, uuid, text) to service_role;
grant execute on function public.release_content_writing_automation_claim(uuid, text, text, text, integer) to service_role;
grant execute on function public.reset_content_writing_automation_item(uuid, uuid) to service_role;
grant execute on function public.cancel_content_writing_automation_item(uuid, uuid) to service_role;
grant execute on function public.list_content_writing_automation_candidates(uuid, integer, integer, boolean) to service_role;
grant execute on function public.reconcile_content_writing_automation_session(uuid, uuid) to service_role;
grant execute on function public.reserve_article_for_explicit_content_writing(uuid, uuid, text, uuid, uuid, text, text) to service_role;

comment on table public.content_writing_automation_items is
  'Durable one-article-at-a-time queue for server-side automatic structured writing.';
comment on function public.claim_next_content_writing_automation_item(text, text, text, integer, boolean, integer, integer) is
  'Atomically discovers and reserves the oldest ready article while manual writing and full workflows have priority.';

commit;
