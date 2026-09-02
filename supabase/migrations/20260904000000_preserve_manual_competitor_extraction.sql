begin;

-- Manual selection is additive. Automatic discovery keeps its existing,
-- signature-driven replacement RPC; never fall back to it for a manual request.
create or replace function public.enqueue_manual_competitor_extraction_job(
  p_article_id uuid,
  p_requested_by uuid,
  p_query_type text,
  p_query_text text,
  p_sources jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source jsonb;
  v_position integer;
  v_url text;
  v_text text;
  v_saved jsonb;
  v_existing public.article_competitors%rowtype;
  v_id uuid;
  v_ids uuid[] := array[]::uuid[];
  v_preserved integer := 0;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_competitors jsonb;
  v_batch_id uuid := gen_random_uuid();
begin
  -- Serialize allocation with automatic extraction and other manual requests.
  select article.metadata #> '{attachments,competitors}' into v_saved
  from public.articles as article where article.id = p_article_id for update;
  if not found then
    raise exception 'Article was not found.' using errcode = 'P0002';
  end if;
  if coalesce(public.article_access_level_for_user(p_article_id, p_requested_by), '') not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  perform 1 from public.article_competitors where article_id = p_article_id for update;
  if jsonb_typeof(p_sources) is distinct from 'array' then
    raise exception 'Competitor sources must be an array.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_sources) not between 1 and 5 then
    raise exception 'Select between 1 and 5 competitor sources.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.ai_external_analysis_jobs as job
    where job.article_id = p_article_id and job.job_type = 'competitor_extraction'
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  ) then
    raise exception 'An active competitor extraction task already exists.' using errcode = 'P0001';
  end if;

  -- Legacy direct/manual inputs have no managed rows yet. Adopt their text at
  -- the same position before the first metadata synchronization can erase it.
  -- A managed projection must never resurrect removed competitors.
  if coalesce(v_saved->>'managedBy', '') <> 'competitor_discovery'
     and not exists (select 1 from public.article_competitors where article_id = p_article_id) then
    for v_position in 1..5 loop
      v_text := coalesce(v_saved->'texts'->>(v_position - 1), '');
      if nullif(btrim(v_text), '') is null or btrim(v_text) like '[تعذر استخراج محتوى المنافس]%' then
        continue;
      end if;
      v_url := btrim(coalesce(v_saved->'urls'->>(v_position - 1), ''));
      if v_url = '' or exists (
        select 1 from public.article_competitors where article_id = p_article_id and canonical_url = v_url
      ) then
        -- Text-only input is never fetched: the adopted row is completed.
        v_url := 'manual-input:' || p_article_id::text || ':' || v_position::text;
      end if;
      insert into public.article_competitors (
        article_id, position, source_url, canonical_url, domain, content_text,
        word_count, status, extraction_provider, selected_by, fetched_at
      ) values (
        p_article_id, v_position, v_url, v_url, '', v_text,
        cardinality(regexp_split_to_array(btrim(v_text), '\s+')), 'completed', 'manual', p_requested_by, now()
      );
    end loop;
  end if;

  -- Process matching URLs first so a new URL cannot steal an empty slot that
  -- is about to be retried. Position is a saved slot, never a search ranking.
  for v_source in
    select source.value from jsonb_array_elements(p_sources) with ordinality as source(value, ordinality)
    order by exists (
      select 1 from public.article_competitors as competitor
      where competitor.article_id = p_article_id
        and (competitor.canonical_url = coalesce(nullif(source.value->>'canonicalUrl', ''), source.value->>'url')
          or competitor.source_url = source.value->>'url')
    ) desc, source.ordinality
  loop
    v_url := left(btrim(coalesce(nullif(v_source->>'canonicalUrl', ''), v_source->>'url', '')), 2048);
    if v_url = '' then
      raise exception 'Competitor URL is required.' using errcode = '22023';
    end if;
    select * into v_existing from public.article_competitors as competitor
    where competitor.article_id = p_article_id
      and (competitor.canonical_url = v_url or competitor.source_url = v_source->>'url')
    order by (competitor.canonical_url = v_url) desc limit 1;

    if found then
      if (nullif(btrim(v_existing.content_text), '') is not null
          and btrim(v_existing.content_text) not like '[تعذر استخراج محتوى المنافس]%') then
        v_preserved := v_preserved + 1;
        continue;
      end if;
      if v_existing.id = any(v_ids) then continue; end if;
      v_position := v_existing.position;
    else
      select slot.position into v_position from generate_series(1, 5) as slot(position)
      left join public.article_competitors as competitor
        on competitor.article_id = p_article_id and competitor.position = slot.position
      where competitor.id is null or (
        not (competitor.id = any(v_ids))
        and (nullif(btrim(competitor.content_text), '') is null
          or btrim(competitor.content_text) like '[تعذر استخراج محتوى المنافس]%')
      )
      order by slot.position limit 1;
      if v_position is null then
        -- The whole transaction rolls back, including earlier allocations.
        raise exception 'competitor_slots_full' using errcode = 'P0001';
      end if;
    end if;

    insert into public.article_competitors (
      article_id, position, query_type, query_text, source_url, canonical_url,
      domain, title, description, status, selected_by
    ) values (
      p_article_id, v_position,
      case when p_query_type = 'primary_keyword' then 'primary_keyword' else 'title' end,
      left(coalesce(p_query_text, ''), 300), left(coalesce(v_source->>'url', v_url), 2048), v_url,
      left(coalesce(v_source->>'domain', ''), 255), left(coalesce(v_source->>'title', ''), 500),
      left(coalesce(v_source->>'description', ''), 2000), 'queued', p_requested_by
    ) on conflict (article_id, position) do update set
      query_type = excluded.query_type, query_text = excluded.query_text,
      source_url = excluded.source_url, canonical_url = excluded.canonical_url,
      domain = excluded.domain, title = excluded.title, description = excluded.description,
      content_text = '', word_count = 0, headings = '{"h1":[],"h2":[],"h3":[]}'::jsonb,
      status = 'queued', selected_by = excluded.selected_by, extraction_provider = null,
      error_code = null, error_message = null, fetched_at = null
    returning id into v_id;
    v_ids := array_append(v_ids, v_id);
  end loop;

  perform public.sync_article_competitors_metadata(p_article_id);
  select jsonb_agg(to_jsonb(competitor) order by competitor.position) into v_competitors
  from public.article_competitors as competitor where competitor.article_id = p_article_id;

  if cardinality(v_ids) > 0 then
    insert into public.ai_external_analysis_jobs (
      article_id, requested_by, job_type, origin, status, idempotency_key, batch_key,
      sequence_number, readiness_signature, input_snapshot, progress, next_attempt_at
    ) values (
      p_article_id, p_requested_by, 'competitor_extraction', 'manual', 'queued',
      'competitor-extraction:' || v_batch_id::text, 'competitor-extraction:' || v_batch_id::text,
      0, md5(p_sources::text),
      jsonb_build_object(
        'queryType', case when p_query_type = 'primary_keyword' then 'primary_keyword' else 'title' end,
        'queryText', left(coalesce(p_query_text, ''), 300),
        'sourceCount', cardinality(v_ids), 'competitorIds', to_jsonb(v_ids), 'preserveExisting', true
      ),
      jsonb_build_object('stage', 'queued', 'current', 0, 'total', cardinality(v_ids), 'updatedAt', now()),
      now()
    ) returning * into v_job;
  end if;
  return jsonb_build_object(
    'job', case when v_job.id is not null then to_jsonb(v_job) else null end,
    'competitors', coalesce(v_competitors, '[]'::jsonb),
    'queuedCount', cardinality(v_ids), 'preservedCount', v_preserved
  );
end;
$$;

revoke all on function public.enqueue_manual_competitor_extraction_job(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.enqueue_manual_competitor_extraction_job(uuid, uuid, text, text, jsonb)
  to service_role;

comment on function public.enqueue_manual_competitor_extraction_job(uuid, uuid, text, text, jsonb) is
  'Queues only missing manual competitor texts, preserving populated slots and rejecting overflow atomically.';

commit;
