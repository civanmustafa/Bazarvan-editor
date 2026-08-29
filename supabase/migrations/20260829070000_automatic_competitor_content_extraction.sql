-- Automatically accept the deterministic competitor selection and enqueue full
-- content extraction. The setting remains reversible: manual discovery and
-- extraction continue to work when automatic extraction is disabled.

begin;

insert into public.app_settings (
  key,
  value,
  description,
  is_secret
)
values (
  'system',
  '{"autoExtractCompetitorContent":true}'::jsonb,
  'Global editor and content-research automation settings.',
  false
)
on conflict (key) do update
set
  value = coalesce(public.app_settings.value, '{}'::jsonb)
    || jsonb_build_object(
      'autoExtractCompetitorContent',
      case
        when jsonb_typeof(public.app_settings.value->'autoExtractCompetitorContent') = 'boolean'
          then (public.app_settings.value->>'autoExtractCompetitorContent')::boolean
        else true
      end
    ),
  is_secret = false,
  updated_at = now();

create or replace function public.competitor_content_auto_extraction_enabled()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case
      when jsonb_typeof(setting.value->'autoExtractCompetitorContent') = 'boolean'
        then (setting.value->>'autoExtractCompetitorContent')::boolean
      else true
    end
    from public.app_settings as setting
    where setting.key = 'system'
      and setting.is_secret is false
    limit 1
  ), true);
$$;

-- Keep the existing automatic semantic gate and add the independent extraction
-- switch. Explicit manual extraction remains available regardless of the switch.
create or replace function public.enqueue_competitor_extraction_job_controlled(
  p_article_id uuid,
  p_requested_by uuid,
  p_query_type text,
  p_query_text text,
  p_sources jsonb,
  p_origin text default 'auto'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings jsonb := public.get_content_research_automation_settings();
  v_manual boolean := lower(btrim(coalesce(p_origin, 'auto'))) = 'manual';
  v_keywords jsonb := '{}'::jsonb;
  v_result jsonb;
  v_job_id uuid;
begin
  if v_manual then
    return public.enqueue_competitor_extraction_job(
      p_article_id,
      p_requested_by,
      p_query_type,
      p_query_text,
      p_sources
    );
  end if;

  if not coalesce((v_settings->>'autoDiscoverCompetitors')::boolean, true)
     or not public.competitor_content_auto_extraction_enabled() then
    return null;
  end if;
  if exists (
    select 1
    from public.ai_external_analysis_jobs as semantic_job
    where semantic_job.article_id = p_article_id
      and semantic_job.job_type = 'semantic_keywords_lsi'
      and semantic_job.cancel_requested_at is null
      and semantic_job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      )
  ) then
    return null;
  end if;

  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = p_article_id;
  if not found then return null; end if;

  if coalesce((v_settings->>'autoGenerateAlternativeKeywords')::boolean, true)
    and not public.external_analysis_has_competitor_value(v_keywords->'secondaries', 100) then
    return null;
  end if;
  if coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true)
    and not public.external_analysis_has_competitor_value(v_keywords->'lsi', 100) then
    return null;
  end if;

  v_result := public.enqueue_competitor_extraction_job(
    p_article_id,
    p_requested_by,
    p_query_type,
    p_query_text,
    p_sources
  );
  begin
    v_job_id := nullif(v_result #>> '{job,id}', '')::uuid;
  exception when invalid_text_representation then
    v_job_id := null;
  end;
  if v_job_id is not null then
    update public.ai_external_analysis_jobs as job
    set origin = 'auto', updated_at = now()
    where job.id = v_job_id;
    v_result := jsonb_set(v_result, '{job,origin}', to_jsonb('auto'::text), true);
  end if;
  return v_result;
end;
$$;

create or replace function public.enqueue_automatic_competitor_extraction_for_discovery(
  p_discovery_job_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_discovery public.ai_external_analysis_jobs%rowtype;
  v_sources jsonb := '[]'::jsonb;
  v_selected_qualifications jsonb := '{}'::jsonb;
  v_selected_urls jsonb := '[]'::jsonb;
  v_source_signature text;
  v_existing_job_id uuid;
  v_result jsonb;
  v_extraction_job_id uuid;
  v_requested_by uuid;
  v_auto_discovery_enabled boolean := true;
begin
  if p_discovery_job_id is null
     or not public.competitor_content_auto_extraction_enabled() then
    return null;
  end if;

  select job.*
  into v_discovery
  from public.ai_external_analysis_jobs as job
  where job.id = p_discovery_job_id
    and job.job_type = 'competitor_discovery'
    and job.status = 'completed'
  for update;

  if not found or v_discovery.pipeline_parent_job_id is not null then
    return null;
  end if;

  if v_discovery.origin = 'auto' then
    select coalesce(case
      when jsonb_typeof(setting.value->'autoDiscoverCompetitors') = 'boolean'
        then (setting.value->>'autoDiscoverCompetitors')::boolean
      else true
    end, true)
    into v_auto_discovery_enabled
    from public.app_settings as setting
    where setting.key = 'system'
      and setting.is_secret is false
    limit 1;
    if not coalesce(v_auto_discovery_enabled, true) then return null; end if;
  end if;

  select coalesce(jsonb_agg(candidate.source order by candidate.selection_rank), '[]'::jsonb)
  into v_sources
  from (
    select
      coalesce(nullif(result_row.value->>'selectionRank', '')::integer, result_row.ordinality::integer) as selection_rank,
      jsonb_build_object(
        'url', coalesce(nullif(result_row.value->>'url', ''), result_row.value->>'canonicalUrl'),
        'canonicalUrl', coalesce(nullif(result_row.value->>'canonicalUrl', ''), result_row.value->>'url'),
        'domain', coalesce(result_row.value->>'domain', ''),
        'title', coalesce(result_row.value->>'title', ''),
        'description', coalesce(result_row.value->>'description', ''),
        'searchPosition', coalesce(nullif(result_row.value->>'position', '')::integer, result_row.ordinality::integer),
        'autoSelected', true,
        'contentQualification', case
          when jsonb_typeof(result_row.value->'contentQualification') = 'object'
            then result_row.value->'contentQualification'
          else '{}'::jsonb
        end
      ) as source
    from jsonb_array_elements(
      case
        when jsonb_typeof(v_discovery.result->'results') = 'array'
          then v_discovery.result->'results'
        else '[]'::jsonb
      end
    ) with ordinality as result_row(value, ordinality)
    where coalesce((result_row.value->>'autoSelected')::boolean, false)
      and coalesce((result_row.value->>'eligible')::boolean, true)
      and nullif(coalesce(
        result_row.value->>'canonicalUrl',
        result_row.value->>'url',
        ''
      ), '') is not null
    order by selection_rank
    limit 5
  ) as candidate;

  if jsonb_array_length(v_sources) = 0 then return null; end if;

  select
    coalesce(jsonb_object_agg(
      source.value->>'canonicalUrl',
      jsonb_build_object(
        'autoSelected', true,
        'qualificationRequired', coalesce(source.value #>> '{contentQualification,status}', '') = 'qualified',
        'status', coalesce(source.value #>> '{contentQualification,status}', 'unavailable'),
        'score', coalesce(nullif(source.value #>> '{contentQualification,score}', '')::numeric, 0),
        'matchedKeyword', coalesce(source.value #>> '{contentQualification,matchedKeyword}', ''),
        'matchKind', coalesce(source.value #>> '{contentQualification,matchKind}', '')
      )
    ), '{}'::jsonb),
    coalesce(jsonb_agg(to_jsonb(source.value->>'canonicalUrl')), '[]'::jsonb)
  into v_selected_qualifications, v_selected_urls
  from jsonb_array_elements(v_sources) as source(value);

  v_source_signature := md5(v_sources::text);

  select job.id
  into v_existing_job_id
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_discovery.article_id
    and job.job_type = 'competitor_extraction'
    and job.input_snapshot->>'discoveryJobId' = v_discovery.id::text
    and job.input_snapshot->>'discoveryResultSignature' = v_source_signature
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by job.created_at desc
  limit 1;

  if v_existing_job_id is not null then
    update public.ai_external_analysis_jobs as discovery
    set result = coalesce(discovery.result, '{}'::jsonb) || jsonb_build_object(
          'reviewStatus', 'accepted',
          'selectedUrls', v_selected_urls,
          'autoExtractionJobId', v_existing_job_id,
          'autoExtractionStatus', 'reused'
        ),
        progress = coalesce(discovery.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'extraction_queued',
          'extractionJobId', v_existing_job_id,
          'updatedAt', now()
        ),
        updated_at = now()
    where discovery.id = v_discovery.id;
    return v_existing_job_id;
  end if;

  -- An explicit extraction started during discovery already satisfies the gate;
  -- do not replace its rows or create a competing worker task.
  select job.id
  into v_existing_job_id
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_discovery.article_id
    and job.job_type = 'competitor_extraction'
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    )
    and job.cancel_requested_at is null
  order by job.created_at desc
  limit 1;

  if v_existing_job_id is not null then
    update public.ai_external_analysis_jobs as discovery
    set result = coalesce(discovery.result, '{}'::jsonb) || jsonb_build_object(
          'reviewStatus', 'accepted',
          'selectedUrls', v_selected_urls,
          'autoExtractionJobId', v_existing_job_id,
          'autoExtractionStatus', 'existing_active'
        ),
        progress = coalesce(discovery.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'extraction_queued',
          'extractionJobId', v_existing_job_id,
          'updatedAt', now()
        ),
        updated_at = now()
    where discovery.id = v_discovery.id;
    return v_existing_job_id;
  end if;

  select coalesce(
    v_discovery.requested_by,
    article.assigned_to,
    article.owner_id,
    article.created_by
  )
  into v_requested_by
  from public.articles as article
  where article.id = v_discovery.article_id;
  if v_requested_by is null then return null; end if;

  begin
    v_result := public.enqueue_competitor_extraction_job(
      v_discovery.article_id,
      v_requested_by,
      coalesce(nullif(v_discovery.result->>'queryType', ''), 'title'),
      coalesce(v_discovery.result->>'query', ''),
      v_sources
    );
    v_extraction_job_id := nullif(v_result #>> '{job,id}', '')::uuid;
  exception when sqlstate 'P0001' then
    select job.id
    into v_extraction_job_id
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_discovery.article_id
      and job.job_type = 'competitor_extraction'
      and job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      )
    order by job.created_at desc
    limit 1;
  end;

  if v_extraction_job_id is null then return null; end if;

  update public.ai_external_analysis_jobs as extraction
  set origin = case when v_discovery.origin = 'auto' then 'auto' else 'manual' end,
      readiness_signature = coalesce(v_discovery.readiness_signature, extraction.readiness_signature),
      input_snapshot = coalesce(extraction.input_snapshot, '{}'::jsonb) || jsonb_build_object(
        'discoveryJobId', v_discovery.id,
        'discoverySignature', coalesce(v_discovery.readiness_signature, ''),
        'discoveryResultSignature', v_source_signature,
        'selectedQualifications', v_selected_qualifications,
        'automaticSelectionAccepted', true
      ),
      updated_at = now()
  where extraction.id = v_extraction_job_id;

  update public.article_competitors as competitor
  set discovery_signature = v_discovery.readiness_signature,
      updated_at = now()
  where competitor.article_id = v_discovery.article_id;
  perform public.sync_article_competitors_metadata(v_discovery.article_id);

  update public.ai_external_analysis_jobs as discovery
  set result = coalesce(discovery.result, '{}'::jsonb) || jsonb_build_object(
        'reviewStatus', 'accepted',
        'reviewedBy', v_requested_by,
        'reviewedAt', now(),
        'selectedUrls', v_selected_urls,
        'autoExtractionJobId', v_extraction_job_id,
        'autoExtractionStatus', 'queued'
      ),
      progress = coalesce(discovery.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'extraction_queued',
        'selectedCount', jsonb_array_length(v_sources),
        'extractionJobId', v_extraction_job_id,
        'updatedAt', now()
      ),
      updated_at = now()
  where discovery.id = v_discovery.id;

  return v_extraction_job_id;
end;
$$;

create or replace function public.enqueue_automatic_competitor_extraction_after_discovery()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.job_type = 'competitor_discovery' and new.status = 'completed' then
    perform public.enqueue_automatic_competitor_extraction_for_discovery(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists enqueue_automatic_competitor_extraction_after_discovery
  on public.ai_external_analysis_jobs;
create trigger enqueue_automatic_competitor_extraction_after_discovery
after insert or update of status on public.ai_external_analysis_jobs
for each row
execute function public.enqueue_automatic_competitor_extraction_after_discovery();

create or replace function public.reconcile_automatic_competitor_extraction_from_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_enabled boolean := true;
  v_new_enabled boolean := true;
  v_article_id uuid;
  v_discovery_job_id uuid;
begin
  if new.key <> 'system' or new.is_secret then return new; end if;

  v_old_enabled := case
    when jsonb_typeof(old.value->'autoExtractCompetitorContent') = 'boolean'
      then (old.value->>'autoExtractCompetitorContent')::boolean
    else true
  end;
  v_new_enabled := case
    when jsonb_typeof(new.value->'autoExtractCompetitorContent') = 'boolean'
      then (new.value->>'autoExtractCompetitorContent')::boolean
    else true
  end;
  if v_new_enabled is not distinct from v_old_enabled then return new; end if;

  if not v_new_enabled then
    for v_article_id in
      select distinct job.article_id
      from public.ai_external_analysis_jobs as job
      where job.origin = 'auto'
        and job.job_type = 'competitor_extraction'
        and job.input_snapshot ? 'discoveryJobId'
        and job.status in (
          'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
        )
    loop
      update public.ai_external_analysis_jobs as job
      set status = case when job.status = 'running' then 'running' else 'cancelled' end,
          cancel_requested_at = coalesce(job.cancel_requested_at, now()),
          next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
          locked_by = case when job.status = 'running' then job.locked_by else null end,
          locked_at = case when job.status = 'running' then job.locked_at else null end,
          lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
          completed_at = case when job.status = 'running' then job.completed_at else coalesce(job.completed_at, now()) end,
          last_error_code = 'competitor_content_extraction_automation_disabled',
          last_error = 'Automatic competitor content extraction was disabled.',
          progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
            'stage', case when job.status = 'running' then 'cancellation_requested' else 'cancelled' end,
            'reason', 'competitor_content_extraction_automation_disabled',
            'updatedAt', now()
          ),
          updated_at = now()
      where job.article_id = v_article_id
        and job.origin = 'auto'
        and job.job_type = 'competitor_extraction'
        and job.input_snapshot ? 'discoveryJobId'
        and job.status in (
          'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
        );

      update public.article_competitors as competitor
      set status = 'cancelled',
          error_code = 'competitor_content_extraction_automation_disabled',
          error_message = 'Automatic competitor content extraction was disabled.',
          updated_at = now()
      where competitor.article_id = v_article_id
        and competitor.status in ('queued', 'extracting', 'retry_scheduled');
      perform public.sync_article_competitors_metadata(v_article_id);
    end loop;
  else
    for v_discovery_job_id in
      select distinct on (job.article_id) job.id
      from public.ai_external_analysis_jobs as job
      where job.job_type = 'competitor_discovery'
        and job.status = 'completed'
        and job.pipeline_parent_job_id is null
      order by job.article_id, job.completed_at desc nulls last, job.created_at desc
    loop
      perform public.enqueue_automatic_competitor_extraction_for_discovery(v_discovery_job_id);
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists reconcile_automatic_competitor_extraction_from_settings
  on public.app_settings;
create trigger reconcile_automatic_competitor_extraction_from_settings
after update on public.app_settings
for each row
execute function public.reconcile_automatic_competitor_extraction_from_settings();

revoke all on function public.competitor_content_auto_extraction_enabled()
  from public, anon, authenticated;
revoke all on function public.enqueue_competitor_extraction_job_controlled(uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_automatic_competitor_extraction_for_discovery(uuid)
  from public, anon, authenticated;
revoke all on function public.enqueue_automatic_competitor_extraction_after_discovery()
  from public, anon, authenticated;
revoke all on function public.reconcile_automatic_competitor_extraction_from_settings()
  from public, anon, authenticated;

grant execute on function public.competitor_content_auto_extraction_enabled()
  to service_role;
grant execute on function public.enqueue_competitor_extraction_job_controlled(uuid, uuid, text, text, jsonb, text)
  to service_role;
grant execute on function public.enqueue_automatic_competitor_extraction_for_discovery(uuid)
  to service_role;

comment on function public.enqueue_automatic_competitor_extraction_for_discovery(uuid) is
  'Accepts the deterministic auto-selection and idempotently queues full competitor content extraction after discovery.';

notify pgrst, 'reload schema';

commit;
