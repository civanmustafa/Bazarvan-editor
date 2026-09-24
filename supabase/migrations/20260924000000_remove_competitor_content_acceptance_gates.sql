begin;

alter table public.article_competitors
  drop constraint if exists article_competitors_article_id_canonical_url_key;

-- Competitor content no longer receives a special class or reduced writing
-- weight. Keep the columns for API compatibility while normalizing all saved
-- rows to the neutral policy.
update public.article_competitors
set
  source_class = 'commercial',
  content_weight = 1.000,
  updated_at = now()
where source_class is distinct from 'commercial'
   or content_weight is distinct from 1.000;

comment on column public.article_competitors.source_class is
  'Compatibility field. All extracted competitor content uses the neutral commercial class.';
comment on column public.article_competitors.content_weight is
  'Compatibility field. All extracted competitor content has a neutral writing weight of 1.0.';

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

revoke all on function public.evaluate_content_writing_automation_readiness(uuid)
  from public, anon, authenticated;
grant execute on function public.evaluate_content_writing_automation_readiness(uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
