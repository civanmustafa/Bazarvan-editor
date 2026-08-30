-- Automatic writing creates a new draft; it must never consume tokens for an
-- article that already contains saved editor prose. Keep this invariant in the
-- database so background workers and rolling application versions agree.

create or replace function public.article_editor_has_text(p_plain_text text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(
    regexp_replace(
      replace(replace(coalesce(p_plain_text, ''), chr(160), ''), chr(8203), ''),
      '[[:space:]]+',
      '',
      'g'
    ),
    ''
  ) is not null;
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
    'plainTextHash', md5(coalesce(v_article.plain_text, '')),
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

-- This trigger closes the interval between the scheduler's readiness check and
-- session insertion. Manual writing and the explicit full pipeline are not
-- affected; only sessions carrying the automatic queue marker are rejected.
create or replace function public.guard_automatic_content_writing_empty_editor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.execution_mode = 'api'
     and coalesce(new.context_snapshot ->> 'triggerSource', '') = 'automatic_ready'
     and exists (
       select 1
       from public.articles as article
       where article.id = new.article_id
         and public.article_editor_has_text(article.plain_text)
     ) then
    raise exception 'Automatic content writing requires an empty article editor.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_automatic_content_writing_empty_editor
  on public.content_writing_sessions;
create trigger guard_automatic_content_writing_empty_editor
before insert on public.content_writing_sessions
for each row execute function public.guard_automatic_content_writing_empty_editor();

-- Stop invalid queued work immediately and ask an active worker to stop at its
-- next cancellation checkpoint. This also repairs sessions created before the
-- guard was deployed, including the incident that motivated this migration.
update public.content_writing_sessions as session
set
  status = 'cancelled',
  cancel_requested_at = coalesce(session.cancel_requested_at, now()),
  last_error_code = 'automatic_article_editor_not_empty',
  last_error = 'Automatic writing was cancelled because the article editor already contains saved text.',
  completed_at = coalesce(session.completed_at, now()),
  locked_by = null,
  locked_at = null,
  lease_expires_at = null
where session.execution_mode = 'api'
  and session.status in ('queued', 'retry_scheduled')
  and coalesce(session.context_snapshot ->> 'triggerSource', '') = 'automatic_ready'
  and exists (
    select 1
    from public.articles as article
    where article.id = session.article_id
      and public.article_editor_has_text(article.plain_text)
  );

update public.content_writing_sessions as session
set
  cancel_requested_at = coalesce(session.cancel_requested_at, now()),
  last_error_code = 'automatic_article_editor_not_empty',
  last_error = 'Automatic writing was cancelled because the article editor already contains saved text.'
where session.execution_mode = 'api'
  and session.status = 'running'
  and coalesce(session.context_snapshot ->> 'triggerSource', '') = 'automatic_ready'
  and exists (
    select 1
    from public.articles as article
    where article.id = session.article_id
      and public.article_editor_has_text(article.plain_text)
  );

update public.content_writing_automation_items as item
set
  status = 'cancelled',
  locked_by = null,
  locked_at = null,
  lease_expires_at = null,
  completed_at = coalesce(item.completed_at, now()),
  last_error_code = 'automatic_article_editor_not_empty',
  last_error = 'Automatic writing was cancelled because the article editor already contains saved text.'
where item.status = 'claiming'
  and item.content_writing_session_id is null
  and exists (
    select 1
    from public.articles as article
    where article.id = item.article_id
      and public.article_editor_has_text(article.plain_text)
  );

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 2;
$$;

revoke all on function public.article_editor_has_text(text) from public, anon, authenticated;
revoke all on function public.guard_automatic_content_writing_empty_editor() from public, anon, authenticated;
revoke all on function public.content_writing_automation_schema_version() from public, anon, authenticated;
grant execute on function public.content_writing_automation_schema_version() to service_role;
