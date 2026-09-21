begin;

-- Trusted government pages are allowed to be shorter because official service
-- and policy pages are often concise. Their lower analytical weight is stored
-- with the canonical competitor row and follows the source into writing.
alter table public.article_competitors
  add column if not exists source_class text not null default 'commercial',
  add column if not exists content_weight numeric(4, 3) not null default 1.000;

alter table public.article_competitors
  drop constraint if exists article_competitors_source_class_check;
alter table public.article_competitors
  add constraint article_competitors_source_class_check
  check (source_class in ('commercial', 'government'));

alter table public.article_competitors
  drop constraint if exists article_competitors_content_weight_check;
alter table public.article_competitors
  add constraint article_competitors_content_weight_check
  check (content_weight >= 0.100 and content_weight <= 1.000);

update public.article_competitors as competitor
set
  source_class = case
    when lower(coalesce(competitor.domain, '')) ~ '(^|\.)(gov|gouv|gob|go|gc|govt)\.[a-z]{2,}(\.[a-z]{2,})?$'
      or lower(coalesce(competitor.domain, '')) ~ '(^|\.)gov$'
      or lower(coalesce(competitor.domain, '')) in ('u.ae', 'government.ae')
      then 'government'
    else 'commercial'
  end,
  content_weight = case
    when lower(coalesce(competitor.domain, '')) ~ '(^|\.)(gov|gouv|gob|go|gc|govt)\.[a-z]{2,}(\.[a-z]{2,})?$'
      or lower(coalesce(competitor.domain, '')) ~ '(^|\.)gov$'
      or lower(coalesce(competitor.domain, '')) in ('u.ae', 'government.ae')
      then 0.650
    else 1.000
  end;

comment on column public.article_competitors.source_class is
  'Deterministic source policy class. Trusted government sources use the reduced 130-word threshold.';
comment on column public.article_competitors.content_weight is
  'Relative writing-analysis weight. Trusted concise government sources use 0.650; ordinary competitors use 1.000.';

create or replace function public.merge_article_competitors_metadata(
  p_article_id uuid,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_urls jsonb;
  v_texts jsonb;
  v_htmls jsonb := '["","","","",""]'::jsonb;
  v_records jsonb;
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb) - 'competitors';
  v_attachments jsonb;
  v_competitors jsonb;
begin
  select
    jsonb_agg(
      case when competitor.status = 'completed' then coalesce(competitor.canonical_url, competitor.source_url, '') else '' end
      order by slot.position
    ),
    jsonb_agg(
      case when competitor.status = 'completed' then coalesce(competitor.content_text, '') else '' end
      order by slot.position
    ),
    jsonb_agg(
      case when competitor.id is null then null else jsonb_build_object(
        'articleId', competitor.article_id,
        'competitorId', competitor.id,
        'position', competitor.position,
        'sourceOrigin', competitor.source_origin,
        'sourceClass', competitor.source_class,
        'contentWeight', competitor.content_weight,
        'extractionProvider', competitor.extraction_provider,
        'status', competitor.status
      ) end
      order by slot.position
    )
  into v_urls, v_texts, v_records
  from generate_series(1, 5) as slot(position)
  left join public.article_competitors as competitor
    on competitor.article_id = p_article_id
   and competitor.position = slot.position;

  v_competitors := jsonb_build_object(
    'articleId', p_article_id,
    'source', 'article_competitors',
    'schemaVersion', 3,
    'managedBy', 'article_competitor_repository',
    'urls', coalesce(v_urls, '["","","","",""]'::jsonb),
    'htmls', v_htmls,
    'texts', coalesce(v_texts, '["","","","",""]'::jsonb),
    'records', coalesce(v_records, '[null,null,null,null,null]'::jsonb),
    'updatedAt', now()
  );
  v_attachments := (coalesce(v_metadata->'attachments', '{}'::jsonb) - 'competitors')
    || jsonb_build_object('competitors', v_competitors);

  return v_metadata || jsonb_build_object('attachments', v_attachments);
end;
$$;

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
  v_ai_settings jsonb := '{}'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_database_count integer := 0;
  v_pending_count integer := 0;
  v_usable_count integer := 0;
  v_minimum_competitors integer := 3;
  v_database_fingerprint jsonb := '[]'::jsonb;
  v_signature text;
begin
  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null then
    return jsonb_build_object(
      'ready', false, 'missingFields', jsonb_build_array('article_not_found'),
      'signature', '', 'usableCompetitorCount', 0, 'pendingCompetitorCount', 0,
      'minimumCompetitorCount', 2, 'processingComplete', true,
      'competitorRepository', 'article_competitors'
    );
  end if;

  select coalesce(setting.value, '{}'::jsonb)
  into v_ai_settings
  from public.app_settings as setting
  where setting.key = 'ai';

  if coalesce(v_ai_settings->>'contentWritingAutomationMinimumCompetitors', '') ~ '^[0-9]+$' then
    v_minimum_competitors := (v_ai_settings->>'contentWritingAutomationMinimumCompetitors')::integer;
  end if;
  v_minimum_competitors := greatest(2, least(5, v_minimum_competitors));

  select
    count(*) filter (
      where competitor.status = 'completed'
        and nullif(btrim(competitor.content_text), '') is not null
        and btrim(competitor.content_text) not like '[تعذر استخراج محتوى المنافس]%'
        and competitor.word_count >= case
          when competitor.source_class = 'government' then 130
          else 250
        end
    )::integer,
    count(*) filter (
      where competitor.status in ('queued', 'extracting', 'retry_scheduled')
    )::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id', competitor.id,
      'articleId', competitor.article_id,
      'position', competitor.position,
      'status', competitor.status,
      'sourceOrigin', competitor.source_origin,
      'sourceClass', competitor.source_class,
      'contentWeight', competitor.content_weight,
      'wordCount', competitor.word_count,
      'contentHash', md5(coalesce(competitor.content_text, ''))
    ) order by competitor.position), '[]'::jsonb)
  into v_database_count, v_pending_count, v_database_fingerprint
  from public.article_competitors as competitor
  where competitor.article_id = v_article.id;

  v_usable_count := coalesce(v_database_count, 0);

  if coalesce(v_article.status, '') not in ('content_preparation', 'draft') then
    v_missing := v_missing || jsonb_build_array('draft_status');
  end if;
  if public.article_editor_has_text(v_article.plain_text) then
    v_missing := v_missing || jsonb_build_array('article_editor_empty');
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
       select 1 from jsonb_array_elements_text(v_article.keywords -> 'secondaries') as keyword(value)
       where nullif(btrim(keyword.value), '') is not null
     ) then
    v_missing := v_missing || jsonb_build_array('alternative_keywords');
  end if;
  if jsonb_typeof(v_article.keywords -> 'lsi') <> 'array'
     or not exists (
       select 1 from jsonb_array_elements_text(v_article.keywords -> 'lsi') as keyword(value)
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
  if v_usable_count < v_minimum_competitors then
    v_missing := v_missing || jsonb_build_array('competitors');
  end if;

  v_signature := md5(jsonb_build_object(
    'status', case when v_article.status in ('content_preparation', 'draft') then 'draft' else v_article.status end,
    'title', coalesce(v_article.title, ''),
    'plainTextHash', md5(coalesce(v_article.plain_text, '')),
    'keywords', coalesce(v_article.keywords, '{}'::jsonb),
    'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
    'minimumCompetitors', v_minimum_competitors,
    'databaseCompetitors', v_database_fingerprint
  )::text);

  return jsonb_build_object(
    'ready', jsonb_array_length(v_missing) = 0,
    'missingFields', v_missing,
    'signature', v_signature,
    'usableCompetitorCount', v_usable_count,
    'pendingCompetitorCount', coalesce(v_pending_count, 0),
    'minimumCompetitorCount', v_minimum_competitors,
    'processingComplete', coalesce(v_pending_count, 0) = 0,
    'competitorRepository', 'article_competitors',
    'articleTitle', coalesce(v_article.title, ''),
    'articleStatus', coalesce(v_article.status, ''),
    'articleUpdatedAt', v_article.updated_at
  );
end;
$$;

-- Six-argument overload. The existing five-argument function remains the
-- non-destructive implementation and compatibility surface.
create or replace function public.enqueue_manual_competitor_extraction_job(
  p_article_id uuid,
  p_requested_by uuid,
  p_query_type text,
  p_query_text text,
  p_sources jsonb,
  p_replace_existing boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_available integer := 0;
  v_new_count integer := 0;
  v_replace_count integer := 0;
  v_replaced jsonb := '[]'::jsonb;
  v_job_id uuid;
begin
  if coalesce(public.article_access_level_for_user(p_article_id, p_requested_by), 'none') not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.ai_external_analysis_jobs as job
    where job.article_id = p_article_id
      and job.job_type = 'competitor_extraction'
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  ) then
    raise exception 'An active competitor extraction job already exists.' using errcode = 'P0001';
  end if;

  if not coalesce(p_replace_existing, false) then
    v_result := public.enqueue_manual_competitor_extraction_job(
      p_article_id, p_requested_by, p_query_type, p_query_text, p_sources
    );
    return coalesce(v_result, '{}'::jsonb) || jsonb_build_object('replacedCount', 0, 'replacedCompetitors', '[]'::jsonb);
  end if;

  select greatest(0, 5 - count(*) filter (
    where nullif(btrim(competitor.content_text), '') is not null
      and btrim(competitor.content_text) not like '[تعذر استخراج محتوى المنافس]%'
  ))::integer
  into v_available
  from public.article_competitors as competitor
  where competitor.article_id = p_article_id;

  select count(*)::integer into v_new_count
  from (
    select distinct coalesce(nullif(btrim(source.value->>'canonicalUrl'), ''), btrim(source.value->>'url')) as url
    from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) as source(value)
  ) as requested
  where nullif(requested.url, '') is not null
    and not exists (
      select 1 from public.article_competitors as competitor
      where competitor.article_id = p_article_id
        and (competitor.canonical_url = requested.url or competitor.source_url = requested.url)
    );

  v_replace_count := greatest(0, v_new_count - v_available);
  if v_replace_count > 0 then
    with replaceable as (
      select competitor.id
      from public.article_competitors as competitor
      where competitor.article_id = p_article_id
        and nullif(btrim(competitor.content_text), '') is not null
        and btrim(competitor.content_text) not like '[تعذر استخراج محتوى المنافس]%'
        and not exists (
          select 1
          from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) as source(value)
          where competitor.canonical_url = coalesce(nullif(btrim(source.value->>'canonicalUrl'), ''), btrim(source.value->>'url'))
             or competitor.source_url = btrim(source.value->>'url')
        )
      order by case when competitor.status in ('failed', 'cancelled') then 0 else 1 end,
        competitor.content_weight asc, competitor.word_count asc, competitor.position desc
      limit v_replace_count
      for update
    ), removed as (
      delete from public.article_competitors as competitor
      using replaceable
      where competitor.id = replaceable.id
      returning competitor.id, competitor.position, competitor.canonical_url,
        competitor.title, competitor.word_count, competitor.source_class, competitor.content_weight
    )
    select coalesce(jsonb_agg(to_jsonb(removed) order by removed.position), '[]'::jsonb)
    into v_replaced
    from removed;

    if jsonb_array_length(v_replaced) < v_replace_count then
      raise exception 'competitor_slots_full' using errcode = 'P0001';
    end if;
  end if;

  v_result := public.enqueue_manual_competitor_extraction_job(
    p_article_id, p_requested_by, p_query_type, p_query_text, p_sources
  );
  begin
    v_job_id := nullif(v_result #>> '{job,id}', '')::uuid;
  exception when invalid_text_representation then
    v_job_id := null;
  end;
  if v_job_id is not null then
    update public.ai_external_analysis_jobs as job
    set input_snapshot = coalesce(job.input_snapshot, '{}'::jsonb) || jsonb_build_object(
      'replaceExisting', true,
      'replacementPolicy', 'failed_then_lowest_weight_then_shortest',
      'replacedCompetitors', v_replaced
    )
    where job.id = v_job_id;
  end if;
  return coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'replacedCount', jsonb_array_length(v_replaced),
    'replacedCompetitors', v_replaced
  );
end;
$$;

revoke all on function public.enqueue_manual_competitor_extraction_job(uuid, uuid, text, text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.enqueue_manual_competitor_extraction_job(uuid, uuid, text, text, jsonb, boolean)
  to service_role;

comment on function public.enqueue_manual_competitor_extraction_job(uuid, uuid, text, text, jsonb, boolean) is
  'Manual extraction with an explicit transactional replacement mode; weakest saved sources are replaced only when authorized.';

-- The coordinator is a durable projection of every independent stage. Jobs
-- keep their own retry budgets; this table provides one canonical per-article
-- stage state and survives worker restarts.
create table if not exists public.article_automation_stage_states (
  article_id uuid not null references public.articles(id) on delete cascade,
  stage text not null check (stage in (
    'semantic_keywords_lsi', 'competitor_discovery', 'competitor_extraction',
    'content_writing_preparation', 'content_writing', 'engineering_commands'
  )),
  status text not null default 'waiting_for_prerequisites' check (status in (
    'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled',
    'completed', 'failed', 'blocked', 'cancelled', 'paused'
  )),
  source_type text check (source_type is null or source_type in ('external_analysis', 'content_writing')),
  source_id uuid,
  readiness_signature text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  retry_count integer not null default 0 check (retry_count >= 0),
  max_attempts integer not null default 1 check (max_attempts >= 1),
  next_attempt_at timestamptz,
  last_error_code text,
  last_error text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  last_transition_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (article_id, stage)
);

create index if not exists article_automation_stage_states_status_due_idx
  on public.article_automation_stage_states(status, next_attempt_at, updated_at);

alter table public.article_automation_stage_states enable row level security;
drop policy if exists "article_automation_stage_states_select_visible" on public.article_automation_stage_states;
create policy "article_automation_stage_states_select_visible"
on public.article_automation_stage_states for select to authenticated
using (public.can_read_article(article_id));
revoke all on public.article_automation_stage_states from anon;
revoke insert, update, delete on public.article_automation_stage_states from authenticated;
grant select on public.article_automation_stage_states to authenticated;
grant all on public.article_automation_stage_states to service_role;

create or replace function public.initialize_article_automation_stage_states(p_article_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.article_automation_stage_states(article_id, stage)
  select p_article_id, stage
  from unnest(array[
    'semantic_keywords_lsi', 'competitor_discovery', 'competitor_extraction',
    'content_writing_preparation', 'content_writing', 'engineering_commands'
  ]) as stage
  on conflict (article_id, stage) do nothing;
$$;

create or replace function public.external_job_coordinator_stage(p_job_type text)
returns text
language sql
immutable
as $$
  select case p_job_type
    when 'semantic_keywords_lsi' then 'semantic_keywords_lsi'
    when 'competitor_discovery' then 'competitor_discovery'
    when 'competitor_extraction' then 'competitor_extraction'
    when 'content_writing_preparation' then 'content_writing_preparation'
    when 'engineering_command' then 'engineering_commands'
    else null
  end;
$$;

create or replace function public.sync_external_automation_stage_state(
  p_article_id uuid,
  p_stage text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  perform public.initialize_article_automation_stage_states(p_article_id);
  select job.* into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and public.external_job_coordinator_stage(job.job_type) = p_stage
  order by
    case when job.status in ('running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused') then 0 else 1 end,
    job.updated_at desc,
    job.created_at desc
  limit 1;
  if v_job.id is null then return; end if;

  insert into public.article_automation_stage_states(
    article_id, stage, status, source_type, source_id, readiness_signature,
    attempt_count, retry_count, max_attempts, next_attempt_at,
    last_error_code, last_error, details, last_transition_at, updated_at
  ) values (
    p_article_id, p_stage, v_job.status, 'external_analysis', v_job.id,
    v_job.readiness_signature, coalesce(v_job.attempt_count, 0), coalesce(v_job.retry_count, 0),
    greatest(1, coalesce(v_job.max_attempts, 1)), v_job.next_attempt_at,
    v_job.last_error_code, v_job.last_error,
    jsonb_build_object('jobType', v_job.job_type, 'origin', v_job.origin,
      'progress', coalesce(v_job.progress, '{}'::jsonb)), now(), now()
  )
  on conflict (article_id, stage) do update set
    status = excluded.status, source_type = excluded.source_type, source_id = excluded.source_id,
    readiness_signature = excluded.readiness_signature, attempt_count = excluded.attempt_count,
    retry_count = excluded.retry_count, max_attempts = excluded.max_attempts,
    next_attempt_at = excluded.next_attempt_at, last_error_code = excluded.last_error_code,
    last_error = excluded.last_error, details = excluded.details,
    last_transition_at = case
      when public.article_automation_stage_states.status is distinct from excluded.status
        or public.article_automation_stage_states.source_id is distinct from excluded.source_id
      then now() else public.article_automation_stage_states.last_transition_at end,
    updated_at = now();
end;
$$;

create or replace function public.capture_external_automation_stage_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_stage text;
begin
  v_stage := public.external_job_coordinator_stage(new.job_type);
  if v_stage is not null then
    perform public.sync_external_automation_stage_state(new.article_id, v_stage);
  end if;
  return new;
end;
$$;

drop trigger if exists capture_external_automation_stage_state on public.ai_external_analysis_jobs;
create trigger capture_external_automation_stage_state
after insert or update of status, attempt_count, retry_count, max_attempts, next_attempt_at,
  last_error_code, last_error, progress
on public.ai_external_analysis_jobs
for each row execute function public.capture_external_automation_stage_state();

create or replace function public.capture_content_writing_automation_stage_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_status text;
begin
  perform public.initialize_article_automation_stage_states(new.article_id);
  v_status := case new.status
    when 'ready' then 'queued'
    when 'claiming' then 'running'
    when 'writing' then 'running'
    else new.status
  end;
  insert into public.article_automation_stage_states(
    article_id, stage, status, source_type, source_id, readiness_signature,
    attempt_count, retry_count, max_attempts, next_attempt_at,
    last_error_code, last_error, details, last_transition_at, updated_at
  ) values (
    new.article_id, 'content_writing', v_status, 'content_writing', new.id,
    new.readiness_signature, coalesce(new.attempt_count, 0), coalesce(new.recovery_count, 0),
    greatest(1, coalesce(new.max_attempts, 1)), coalesce(new.next_recovery_at, new.eligible_at),
    new.last_error_code, new.last_error,
    jsonb_build_object('runGeneration', new.run_generation,
      'usableCompetitorCount', new.usable_competitor_count,
      'pendingCompetitorCount', new.pending_competitor_count), now(), now()
  )
  on conflict (article_id, stage) do update set
    status = excluded.status, source_type = excluded.source_type, source_id = excluded.source_id,
    readiness_signature = excluded.readiness_signature, attempt_count = excluded.attempt_count,
    retry_count = excluded.retry_count, max_attempts = excluded.max_attempts,
    next_attempt_at = excluded.next_attempt_at, last_error_code = excluded.last_error_code,
    last_error = excluded.last_error, details = excluded.details,
    last_transition_at = case
      when public.article_automation_stage_states.status is distinct from excluded.status
        or public.article_automation_stage_states.source_id is distinct from excluded.source_id
      then now() else public.article_automation_stage_states.last_transition_at end,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists capture_content_writing_automation_stage_state on public.content_writing_automation_items;
create trigger capture_content_writing_automation_stage_state
after insert or update on public.content_writing_automation_items
for each row execute function public.capture_content_writing_automation_stage_state();

create or replace function public.initialize_article_automation_stage_states_from_article()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.initialize_article_automation_stage_states(new.id);
  return new;
end;
$$;

drop trigger if exists initialize_article_automation_stage_states_from_article on public.articles;
create trigger initialize_article_automation_stage_states_from_article
after insert on public.articles
for each row execute function public.initialize_article_automation_stage_states_from_article();

create table if not exists public.article_automation_coordinator_runtime (
  singleton boolean primary key default true check (singleton),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_result jsonb not null default '{}'::jsonb
);
insert into public.article_automation_coordinator_runtime(singleton)
values (true) on conflict (singleton) do nothing;
revoke all on public.article_automation_coordinator_runtime from public, anon, authenticated;
grant all on public.article_automation_coordinator_runtime to service_role;

create or replace function public.reconcile_article_automation_coordinator(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article record;
  v_discovery_id uuid;
  v_processed integer := 0;
  v_error_count integer := 0;
  v_minimum_competitors integer := 3;
  v_preparation_id uuid;
begin
  update public.article_automation_coordinator_runtime
  set last_started_at = now()
  where singleton is true
    and (last_started_at is null or last_started_at < now() - interval '30 seconds');
  if not found then
    return jsonb_build_object('skipped', true, 'reason', 'coordinator_recently_ran');
  end if;

  for v_article in
    select article.id
    from public.articles as article
    join public.ai_external_analysis_article_state as state on state.article_id = article.id
    where article.status in ('draft', 'content_preparation')
    order by article.updated_at desc, article.id
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  loop
    begin
      perform public.initialize_article_automation_stage_states(v_article.id);
      perform public.enqueue_external_semantic_analysis_job_controlled(v_article.id, 'auto');
      perform public.enqueue_competitor_discovery_job_controlled(v_article.id, null, 'auto');
      select job.id into v_discovery_id
      from public.ai_external_analysis_jobs as job
      where job.article_id = v_article.id
        and job.job_type = 'competitor_discovery'
        and job.status = 'completed'
        and job.pipeline_parent_job_id is null
      order by job.completed_at desc nulls last, job.created_at desc
      limit 1;
      if v_discovery_id is not null
         and public.article_automatic_job_allowed(v_article.id, 'competitor_extraction') then
        perform public.enqueue_automatic_competitor_extraction_for_discovery(v_discovery_id);
      end if;
      perform public.reconcile_automatic_ready_engineering_commands_for_article(v_article.id);
      v_processed := v_processed + 1;
    exception when others then
      v_error_count := v_error_count + 1;
    end;
  end loop;

  select greatest(2, least(5, case
    when coalesce(setting.value->>'contentWritingAutomationMinimumCompetitors', '') ~ '^[0-9]+$'
      then (setting.value->>'contentWritingAutomationMinimumCompetitors')::integer
    else 3 end))
  into v_minimum_competitors
  from public.app_settings as setting where setting.key = 'ai';
  v_minimum_competitors := coalesce(v_minimum_competitors, 3);
  begin
    select job.id into v_preparation_id
    from public.enqueue_next_automatic_writing_competitor_preparation(v_minimum_competitors) as job;
  exception when others then
    v_error_count := v_error_count + 1;
  end;

  update public.article_automation_coordinator_runtime
  set last_completed_at = now(),
      last_result = jsonb_build_object(
        'processedArticles', v_processed,
        'errorCount', v_error_count,
        'contentPreparationJobId', v_preparation_id,
        'completedAt', now()
      )
  where singleton is true;

  return jsonb_build_object(
    'skipped', false,
    'processedArticles', v_processed,
    'errorCount', v_error_count,
    'contentPreparationJobId', v_preparation_id
  );
end;
$$;

revoke all on function public.reconcile_article_automation_coordinator(integer)
  from public, anon, authenticated;
grant execute on function public.reconcile_article_automation_coordinator(integer)
  to service_role;

revoke all on function public.initialize_article_automation_stage_states(uuid)
  from public, anon, authenticated;
revoke all on function public.sync_external_automation_stage_state(uuid, text)
  from public, anon, authenticated;
revoke all on function public.capture_external_automation_stage_state()
  from public, anon, authenticated;
revoke all on function public.capture_content_writing_automation_stage_state()
  from public, anon, authenticated;
revoke all on function public.initialize_article_automation_stage_states_from_article()
  from public, anon, authenticated;
grant execute on function public.initialize_article_automation_stage_states(uuid) to service_role;
grant execute on function public.sync_external_automation_stage_state(uuid, text) to service_role;

comment on table public.article_automation_stage_states is
  'Durable master-coordinator projection. Each stage retains its own source job, attempts, retry schedule, and terminal state.';
comment on function public.reconcile_article_automation_coordinator(integer) is
  'Permanent idempotent orchestrator for semantic, competitor, writing-preparation, writing, and engineering stages.';

-- Backfill durable stage rows without starting work during the migration.
do $$
declare v_article_id uuid; v_stage text;
begin
  for v_article_id in select article.id from public.articles as article loop
    perform public.initialize_article_automation_stage_states(v_article_id);
    foreach v_stage in array array[
      'semantic_keywords_lsi', 'competitor_discovery', 'competitor_extraction',
      'content_writing_preparation', 'engineering_commands'
    ] loop
      perform public.sync_external_automation_stage_state(v_article_id, v_stage);
    end loop;
  end loop;
end;
$$;

insert into public.article_automation_stage_states(
  article_id, stage, status, source_type, source_id, readiness_signature,
  attempt_count, retry_count, max_attempts, next_attempt_at,
  last_error_code, last_error, details, last_transition_at, updated_at
)
select
  item.article_id,
  'content_writing',
  case item.status
    when 'ready' then 'queued'
    when 'claiming' then 'running'
    when 'writing' then 'running'
    else item.status
  end,
  'content_writing',
  item.id,
  item.readiness_signature,
  coalesce(item.attempt_count, 0),
  coalesce(item.recovery_count, 0),
  greatest(1, coalesce(item.max_attempts, 1)),
  coalesce(item.next_recovery_at, item.eligible_at),
  item.last_error_code,
  item.last_error,
  jsonb_build_object(
    'runGeneration', item.run_generation,
    'usableCompetitorCount', item.usable_competitor_count,
    'pendingCompetitorCount', item.pending_competitor_count
  ),
  item.updated_at,
  now()
from public.content_writing_automation_items as item
on conflict (article_id, stage) do update set
  status = excluded.status,
  source_type = excluded.source_type,
  source_id = excluded.source_id,
  readiness_signature = excluded.readiness_signature,
  attempt_count = excluded.attempt_count,
  retry_count = excluded.retry_count,
  max_attempts = excluded.max_attempts,
  next_attempt_at = excluded.next_attempt_at,
  last_error_code = excluded.last_error_code,
  last_error = excluded.last_error,
  details = excluded.details,
  last_transition_at = excluded.last_transition_at,
  updated_at = now();

update public.articles as article
set metadata = public.merge_article_competitors_metadata(article.id, article.metadata)
where exists (
  select 1 from public.article_competitors as competitor
  where competitor.article_id = article.id
);

notify pgrst, 'reload schema';
commit;
