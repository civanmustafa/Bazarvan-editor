begin;

-- article_competitors is the canonical persisted repository. source_origin
-- records how a row entered that repository; extraction_provider continues to
-- record how its content was fetched.
alter table public.article_competitors
  add column if not exists source_origin text not null default 'automatic_discovery';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.article_competitors'::regclass
      and conname = 'article_competitors_source_origin_check'
  ) then
    alter table public.article_competitors
      add constraint article_competitors_source_origin_check
      check (source_origin in ('automatic_discovery', 'manual_selection', 'manual_text', 'legacy_import'));
  end if;
end;
$$;

update public.article_competitors
set source_origin = case
  when extraction_provider = 'manual' then 'legacy_import'
  else 'automatic_discovery'
end;

create or replace function public.stamp_article_competitor_source_origin()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.extraction_provider = 'manual'
     and coalesce(new.source_origin, 'automatic_discovery') = 'automatic_discovery' then
    new.source_origin := 'manual_text';
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_article_competitor_source_origin
  on public.article_competitors;
create trigger stamp_article_competitor_source_origin
before insert or update of extraction_provider, source_origin
on public.article_competitors
for each row execute function public.stamp_article_competitor_source_origin();

comment on column public.article_competitors.source_origin is
  'Canonical provenance: automatic discovery, manual URL selection, manual text, or one-time legacy import.';

-- Keep a compatibility projection for old readers, but always derive it from
-- article_competitors. Browser/article metadata is never accepted as input.
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
    'schemaVersion', 2,
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

create or replace function public.preserve_article_competitors_metadata()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Always replace an incoming browser copy, including when the canonical
  -- repository is empty. This is what clears cross-article contamination.
  new.metadata := public.merge_article_competitors_metadata(new.id, new.metadata);
  return new;
end;
$$;

-- Rebuild every existing projection now so contaminated legacy attachments are
-- removed before readiness is recalculated.
update public.articles as article
set metadata = public.merge_article_competitors_metadata(article.id, article.metadata)
where article.metadata ? 'competitors'
   or article.metadata #> '{attachments,competitors}' is not null;

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
      'ready', false,
      'missingFields', jsonb_build_array('article_not_found'),
      'signature', '',
      'usableCompetitorCount', 0,
      'pendingCompetitorCount', 0,
      'minimumCompetitorCount', 2,
      'processingComplete', true,
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
        and competitor.word_count >= 250
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

-- A truly stale semantic job gets a fresh current-signature job. Harmless
-- autosaves are handled by the worker's field-level merge and never reach this
-- function.
create or replace function public.enqueue_semantic_superseded_recovery(
  p_previous_job_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous public.ai_external_analysis_jobs%rowtype;
  v_article public.articles%rowtype;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_policy jsonb := '{}'::jsonb;
  v_needs_secondaries boolean := false;
  v_needs_lsi boolean := false;
  v_needs_google boolean := false;
  v_idempotency_key text;
  v_existing_id uuid;
  v_job_id uuid;
begin
  select job.* into v_previous
  from public.ai_external_analysis_jobs as job
  where job.id = p_previous_job_id
    and job.job_type = 'semantic_keywords_lsi';
  if v_previous.id is null then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'semantic-superseded-recovery:' || v_previous.article_id::text,
    0
  ));

  select article.* into v_article
  from public.articles as article
  where article.id = v_previous.article_id;
  select state.* into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = v_previous.article_id;
  if v_article.id is null or v_state.article_id is null
     or not v_state.semantic_ready
     or nullif(v_state.semantic_readiness_signature, '') is null then
    return null;
  end if;

  v_policy := public.article_automation_policy(v_article.id);
  v_needs_secondaries := not public.external_analysis_has_competitor_value(
    coalesce(v_article.keywords, '{}'::jsonb)->'secondaries', 100
  ) and (
    v_previous.origin = 'manual'
    or coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, true)
  );
  v_needs_lsi := not public.external_analysis_has_competitor_value(
    coalesce(v_article.keywords, '{}'::jsonb)->'lsi', 100
  ) and (
    v_previous.origin = 'manual'
    or coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, true)
  );
  v_needs_google := not public.semantic_keywords_have_google_metadata(v_article.keywords)
    and (
      v_previous.origin = 'manual'
      or coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false)
    );
  if not v_needs_secondaries and not v_needs_lsi and not v_needs_google then
    return null;
  end if;

  v_idempotency_key := 'semantic-superseded-recovery:'
    || v_article.id::text || ':' || v_state.semantic_readiness_signature;
  select job.id into v_existing_id
  from public.ai_external_analysis_jobs as job
  where job.idempotency_key = v_idempotency_key
  order by job.created_at desc
  limit 1;
  if v_existing_id is not null then return v_existing_id; end if;

  insert into public.ai_external_analysis_jobs (
    article_id, requested_by, job_type, origin, status, idempotency_key,
    readiness_signature, input_snapshot, progress, next_attempt_at, max_attempts
  ) values (
    v_article.id,
    coalesce(v_previous.requested_by, v_article.assigned_to, v_article.owner_id, v_article.created_by),
    'semantic_keywords_lsi',
    case when v_previous.origin = 'manual' then 'manual' else 'auto' end,
    'queued',
    v_idempotency_key,
    v_state.semantic_readiness_signature,
    jsonb_build_object(
      'title', v_article.title,
      'plainText', v_article.plain_text,
      'keywords', coalesce(v_article.keywords, '{}'::jsonb),
      'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
      'articleLanguage', v_article.article_language,
      'articleUpdatedAt', v_article.updated_at,
      'readinessSignature', v_state.semantic_readiness_signature,
      'needsSecondaries', v_needs_secondaries,
      'needsLsi', v_needs_lsi,
      'needsGoogleMetadata', v_needs_google,
      'automationSettings', v_policy,
      'controlledOrigin', case when v_previous.origin = 'manual' then 'manual' else 'auto' end,
      'supersededRecoveryOf', v_previous.id
    ),
    jsonb_build_object(
      'stage', 'queued',
      'reason', 'superseded_recovery',
      'previousJobId', v_previous.id,
      'updatedAt', now()
    ),
    now(),
    greatest(6, coalesce(v_previous.max_attempts, 1))
  ) returning id into v_job_id;

  return v_job_id;
exception
  when unique_violation then
    select job.id into v_existing_id
    from public.ai_external_analysis_jobs as job
    where job.idempotency_key = v_idempotency_key
    order by job.created_at desc
    limit 1;
    return v_existing_id;
end;
$$;

revoke all on function public.enqueue_semantic_superseded_recovery(uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_semantic_superseded_recovery(uuid)
  to service_role;

create or replace function public.recover_superseded_semantic_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.job_type = 'semantic_keywords_lsi'
     and new.status = 'completed'
     and new.status is distinct from old.status
     and coalesce(new.result->>'status', '') = 'superseded'
     and new.pipeline_parent_job_id is null then
    perform public.enqueue_semantic_superseded_recovery(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists recover_superseded_semantic_job
  on public.ai_external_analysis_jobs;
create trigger recover_superseded_semantic_job
after update of status on public.ai_external_analysis_jobs
for each row execute function public.recover_superseded_semantic_job();

-- Heal superseded jobs that completed before this migration.
do $$
declare
  v_job record;
begin
  for v_job in
    select job.id
    from public.ai_external_analysis_jobs as job
    where job.job_type = 'semantic_keywords_lsi'
      and job.status = 'completed'
      and coalesce(job.result->>'status', '') = 'superseded'
      and job.pipeline_parent_job_id is null
  loop
    perform public.enqueue_semantic_superseded_recovery(v_job.id);
  end loop;
end;
$$;

commit;
