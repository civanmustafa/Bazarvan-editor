begin;

do $migration$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.ai_external_analysis_jobs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%job_type%'
  loop
    execute format(
      'alter table public.ai_external_analysis_jobs drop constraint %I',
      constraint_row.conname
    );
  end loop;
end;
$migration$;

alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_job_type_check
  check (job_type in ('semantic_keywords_lsi', 'engineering_command', 'competitor_extraction'));

alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_command_shape_check
  check (
    (job_type in ('semantic_keywords_lsi', 'competitor_extraction') and command_id is null)
    or (job_type = 'engineering_command' and nullif(btrim(command_id), '') is not null)
  );

create table if not exists public.article_competitors (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  position integer not null check (position between 1 and 5),
  query_type text not null default 'title' check (query_type in ('title', 'primary_keyword')),
  query_text text not null default '',
  source_url text not null,
  canonical_url text not null,
  domain text not null,
  title text not null default '',
  description text not null default '',
  headings jsonb not null default '{"h1":[],"h2":[],"h3":[]}'::jsonb
    check (jsonb_typeof(headings) = 'object'),
  content_text text not null default '',
  word_count integer not null default 0 check (word_count >= 0),
  status text not null default 'queued'
    check (status in ('queued', 'extracting', 'retry_scheduled', 'completed', 'failed', 'cancelled')),
  extraction_provider text,
  error_code text,
  error_message text,
  fetched_at timestamptz,
  selected_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (article_id, position),
  unique (article_id, canonical_url)
);

create index if not exists article_competitors_article_status_idx
  on public.article_competitors(article_id, status, position);
create index if not exists article_competitors_selected_created_idx
  on public.article_competitors(selected_by, created_at desc);
create index if not exists external_jobs_competitor_active_idx
  on public.ai_external_analysis_jobs(article_id, created_at desc)
  where job_type = 'competitor_extraction'
    and status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');

drop trigger if exists set_article_competitors_updated_at on public.article_competitors;
create trigger set_article_competitors_updated_at
before update on public.article_competitors
for each row execute function public.set_updated_at();

alter table public.article_competitors enable row level security;

drop policy if exists "article_competitors_select_visible" on public.article_competitors;
create policy "article_competitors_select_visible"
on public.article_competitors
for select
to authenticated
using (public.can_read_article(article_id));

revoke all on public.article_competitors from anon;
revoke insert, update, delete on public.article_competitors from authenticated;
grant select on public.article_competitors to authenticated;
grant all on public.article_competitors to service_role;

create or replace function public.external_analysis_has_competitor_value(
  p_values jsonb,
  p_max_items integer default 5
)
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(p_values) = 'array' then p_values
        else '[]'::jsonb
      end
    ) with ordinality as item(value, position)
    where item.position <= greatest(coalesce(p_max_items, 5), 1)
      and nullif(btrim(item.value), '') is not null
  );
$$;

create or replace function public.evaluate_external_analysis_readiness(
  p_status text,
  p_title text,
  p_plain_text text,
  p_keywords jsonb,
  p_goal_context jsonb,
  p_metadata jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_has_draft boolean := coalesce(p_status, '') = 'draft';
  v_has_title boolean := nullif(btrim(coalesce(p_title, '')), '') is not null
    and lower(btrim(coalesce(p_title, ''))) not in ('(untitled)', 'untitled');
  v_has_editor_text boolean := nullif(btrim(coalesce(p_plain_text, '')), '') is not null;
  v_has_primary_keyword boolean := nullif(btrim(coalesce(p_keywords->>'primary', '')), '') is not null;
  v_has_company boolean := nullif(btrim(coalesce(p_keywords->>'company', '')), '') is not null;
  v_has_goal_context boolean := nullif(btrim(coalesce(p_goal_context->>'pageType', '')), '') is not null
    and nullif(btrim(coalesce(p_goal_context->>'objective', '')), '') is not null;
  v_competitors jsonb := coalesce(p_metadata->'attachments'->'competitors', '{}'::jsonb);
  v_has_competitor boolean;
  v_semantic_missing jsonb := '[]'::jsonb;
  v_external_missing jsonb := '[]'::jsonb;
  v_semantic_signature text;
  v_external_signature text;
begin
  v_has_competitor := public.external_analysis_has_competitor_value(v_competitors->'texts', 5)
    or public.external_analysis_has_competitor_value(v_competitors->'urls', 5);

  if not v_has_draft then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('draft_status');
    v_external_missing := v_external_missing || jsonb_build_array('draft_status');
  end if;
  if not v_has_title then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('article_title');
    v_external_missing := v_external_missing || jsonb_build_array('article_title');
  end if;
  if not v_has_editor_text then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('editor_text');
  end if;
  if not v_has_primary_keyword then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('primary_keyword');
    v_external_missing := v_external_missing || jsonb_build_array('primary_keyword');
  end if;
  if not v_has_goal_context then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('goal_context');
    v_external_missing := v_external_missing || jsonb_build_array('goal_context');
  end if;
  if not v_has_company then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('company_name');
    v_external_missing := v_external_missing || jsonb_build_array('company_name');
  end if;
  if not v_has_competitor then
    v_external_missing := v_external_missing || jsonb_build_array('competitor_content_or_url');
  end if;

  v_semantic_signature := md5(jsonb_build_object(
    'status', coalesce(p_status, ''),
    'title', coalesce(p_title, ''),
    'plainText', coalesce(p_plain_text, ''),
    'primaryKeyword', coalesce(p_keywords->>'primary', ''),
    'companyName', coalesce(p_keywords->>'company', ''),
    'goalContext', coalesce(p_goal_context, '{}'::jsonb)
  )::text);
  v_external_signature := md5(jsonb_build_object(
    'status', coalesce(p_status, ''),
    'title', coalesce(p_title, ''),
    'primaryKeyword', coalesce(p_keywords->>'primary', ''),
    'companyName', coalesce(p_keywords->>'company', ''),
    'goalContext', coalesce(p_goal_context, '{}'::jsonb),
    'competitorUrls', coalesce(v_competitors->'urls', '[]'::jsonb),
    'competitorTexts', coalesce(v_competitors->'texts', '[]'::jsonb)
  )::text);

  return jsonb_build_object(
    'semantic', jsonb_build_object(
      'ready', jsonb_array_length(v_semantic_missing) = 0,
      'missingFields', v_semantic_missing,
      'signature', v_semantic_signature
    ),
    'externalAnalysis', jsonb_build_object(
      'ready', jsonb_array_length(v_external_missing) = 0,
      'missingFields', v_external_missing,
      'signature', v_external_signature
    )
  );
end;
$$;

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
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_attachments jsonb;
  v_competitors jsonb;
begin
  select
    jsonb_agg(
      case when competitor.status = 'completed' then competitor.canonical_url else '' end
      order by slot.position
    ),
    jsonb_agg(
      case when competitor.status = 'completed' then competitor.content_text else '' end
      order by slot.position
    )
  into v_urls, v_texts
  from generate_series(1, 5) as slot(position)
  left join public.article_competitors as competitor
    on competitor.article_id = p_article_id
   and competitor.position = slot.position;

  v_competitors := coalesce(v_metadata #> '{attachments,competitors}', '{}'::jsonb)
    || jsonb_build_object(
      'urls', v_urls,
      'htmls', v_htmls,
      'texts', v_texts,
      'managedBy', 'competitor_discovery',
      'updatedAt', now()
    );
  v_attachments := coalesce(v_metadata->'attachments', '{}'::jsonb)
    || jsonb_build_object('competitors', v_competitors);

  return v_metadata || jsonb_build_object('attachments', v_attachments);
end;
$$;

create or replace function public.sync_article_competitors_metadata(
  p_article_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_metadata jsonb;
begin
  select coalesce(article.metadata, '{}'::jsonb)
  into v_metadata
  from public.articles as article
  where article.id = p_article_id
  for update;

  if not found then
    raise exception 'Article was not found.' using errcode = 'P0002';
  end if;

  v_metadata := public.merge_article_competitors_metadata(p_article_id, v_metadata);

  update public.articles
  set metadata = v_metadata
  where id = p_article_id;

  return coalesce(v_metadata #> '{attachments,competitors}', '{}'::jsonb);
end;
$$;

create or replace function public.preserve_article_competitors_metadata()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.article_competitors as competitor
    where competitor.article_id = new.id
  ) then
    new.metadata := public.merge_article_competitors_metadata(new.id, new.metadata);
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_article_competitors_metadata on public.articles;
create trigger preserve_article_competitors_metadata
before update of metadata on public.articles
for each row execute function public.preserve_article_competitors_metadata();

create or replace function public.enqueue_competitor_extraction_job(
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
  v_count integer;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_competitors jsonb;
  v_batch_id uuid := gen_random_uuid();
begin
  perform 1 from public.articles where id = p_article_id for update;
  if not found then
    raise exception 'Article was not found.' using errcode = 'P0002';
  end if;
  if public.article_access_level_for_user(p_article_id, p_requested_by) not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_sources) <> 'array' then
    raise exception 'Competitor sources must be an array.' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_sources);
  if v_count < 1 or v_count > 5 then
    raise exception 'Select between 1 and 5 competitor sources.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.ai_external_analysis_jobs as job
    where job.article_id = p_article_id
      and job.job_type = 'competitor_extraction'
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  ) then
    raise exception 'An active competitor extraction task already exists.' using errcode = 'P0001';
  end if;

  delete from public.article_competitors where article_id = p_article_id;

  for v_source, v_position in
    select source.value, source.ordinality::integer
    from jsonb_array_elements(p_sources) with ordinality as source(value, ordinality)
  loop
    insert into public.article_competitors (
      article_id,
      position,
      query_type,
      query_text,
      source_url,
      canonical_url,
      domain,
      title,
      description,
      status,
      selected_by
    ) values (
      p_article_id,
      v_position,
      case when p_query_type = 'primary_keyword' then 'primary_keyword' else 'title' end,
      left(coalesce(p_query_text, ''), 300),
      left(coalesce(v_source->>'url', ''), 2048),
      left(coalesce(v_source->>'canonicalUrl', v_source->>'url', ''), 2048),
      left(coalesce(v_source->>'domain', ''), 255),
      left(coalesce(v_source->>'title', ''), 500),
      left(coalesce(v_source->>'description', ''), 2000),
      'queued',
      p_requested_by
    );
  end loop;

  perform public.sync_article_competitors_metadata(p_article_id);

  select jsonb_agg(to_jsonb(competitor) order by competitor.position)
  into v_competitors
  from public.article_competitors as competitor
  where competitor.article_id = p_article_id;

  insert into public.ai_external_analysis_jobs (
    article_id,
    requested_by,
    job_type,
    origin,
    status,
    idempotency_key,
    batch_key,
    sequence_number,
    command_id,
    command_label,
    readiness_signature,
    input_snapshot,
    progress,
    next_attempt_at
  ) values (
    p_article_id,
    p_requested_by,
    'competitor_extraction',
    'manual',
    'queued',
    'competitor-extraction:' || v_batch_id::text,
    'competitor-extraction:' || v_batch_id::text,
    0,
    null,
    null,
    md5(coalesce(p_sources, '[]'::jsonb)::text),
    jsonb_build_object(
      'queryType', case when p_query_type = 'primary_keyword' then 'primary_keyword' else 'title' end,
      'queryText', left(coalesce(p_query_text, ''), 300),
      'sourceCount', v_count,
      'competitorIds', (
        select jsonb_agg(competitor.id order by competitor.position)
        from public.article_competitors as competitor
        where competitor.article_id = p_article_id
      )
    ),
    jsonb_build_object(
      'stage', 'queued',
      'current', 0,
      'total', v_count,
      'updatedAt', now()
    ),
    now()
  )
  returning * into v_job;

  return jsonb_build_object(
    'job', to_jsonb(v_job),
    'competitors', coalesce(v_competitors, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.merge_article_competitors_metadata(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.sync_article_competitors_metadata(uuid) from public, anon, authenticated;
revoke all on function public.preserve_article_competitors_metadata() from public, anon, authenticated;
revoke all on function public.enqueue_competitor_extraction_job(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.merge_article_competitors_metadata(uuid, jsonb) to service_role;
grant execute on function public.sync_article_competitors_metadata(uuid) to service_role;
grant execute on function public.enqueue_competitor_extraction_job(uuid, uuid, text, text, jsonb) to service_role;

comment on table public.article_competitors is
  'User-selected competitor pages and normalized main content used by article analysis.';
comment on function public.enqueue_competitor_extraction_job(uuid, uuid, text, text, jsonb) is
  'Atomically replaces competitor selections and queues one durable sequential extraction task.';

commit;
