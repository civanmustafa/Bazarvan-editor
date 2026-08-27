begin;

-- Alternative keywords are part of competitor identity. A change to the approved
-- alternatives must create a new discovery signature instead of reusing results
-- that were qualified against an older keyword set.
create or replace function public.evaluate_competitor_discovery_readiness(
  p_status text,
  p_title text,
  p_keywords jsonb,
  p_goal_context jsonb,
  p_article_language text
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_primary_keyword text := btrim(coalesce(p_keywords->>'primary', ''));
  v_company_name text := btrim(coalesce(p_keywords->>'company', ''));
  v_alternative_keywords jsonb := '[]'::jsonb;
  v_query_type text := case when v_primary_keyword <> '' then 'primary_keyword' else 'title' end;
  v_query_text text := case when v_primary_keyword <> '' then v_primary_keyword else v_title end;
  v_missing_fields jsonb := '[]'::jsonb;
  v_signature text;
  v_signature_status text := case
    when public.article_status_supports_external_analysis(p_status) then 'draft'
    else coalesce(p_status, '')
  end;
begin
  if jsonb_typeof(p_keywords->'secondaries') = 'array' then
    select coalesce(jsonb_agg(keyword.value order by keyword.ordinality), '[]'::jsonb)
    into v_alternative_keywords
    from jsonb_array_elements_text(p_keywords->'secondaries') with ordinality as keyword(value, ordinality)
    where nullif(btrim(keyword.value), '') is not null;
  end if;

  if not public.article_status_supports_external_analysis(p_status) then
    v_missing_fields := v_missing_fields || jsonb_build_array('draft_status');
  end if;
  if v_query_text = '' or lower(v_query_text) in ('(untitled)', 'untitled') then
    v_missing_fields := v_missing_fields || jsonb_build_array('article_title_or_primary_keyword');
  end if;
  if v_company_name = '' then
    v_missing_fields := v_missing_fields || jsonb_build_array('company_name');
  end if;

  v_signature := md5(jsonb_build_object(
    'status', v_signature_status,
    'queryType', v_query_type,
    'queryText', v_query_text,
    'articleTitle', v_title,
    'primaryKeyword', v_primary_keyword,
    'alternativeKeywords', v_alternative_keywords,
    'companyName', v_company_name,
    'articleLanguage', case when p_article_language = 'en' then 'en' else 'ar' end,
    'pageType', coalesce(p_goal_context->>'pageType', ''),
    'searchIntent', coalesce(p_goal_context->>'searchIntent', ''),
    'audienceScope', coalesce(p_goal_context->>'audienceScope', ''),
    'targetCountry', coalesce(p_goal_context->>'targetCountry', '')
  )::text);

  return jsonb_build_object(
    'ready', jsonb_array_length(v_missing_fields) = 0,
    'missingFields', v_missing_fields,
    'signature', v_signature,
    'queryType', v_query_type,
    'queryText', v_query_text,
    'alternativeKeywords', v_alternative_keywords
  );
end;
$$;

-- Every competitor-discovery producer (manual, automatic, preparation, and the
-- full-article pipeline) receives the same immutable keyword snapshot without
-- duplicating the large enqueue functions.
create or replace function public.hydrate_competitor_discovery_keywords()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keywords jsonb := '{}'::jsonb;
  v_alternative_keywords jsonb := '[]'::jsonb;
begin
  if new.job_type <> 'competitor_discovery' then return new; end if;

  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = new.article_id;

  if jsonb_typeof(v_keywords->'secondaries') = 'array' then
    select coalesce(jsonb_agg(keyword.value order by keyword.ordinality), '[]'::jsonb)
    into v_alternative_keywords
    from jsonb_array_elements_text(v_keywords->'secondaries') with ordinality as keyword(value, ordinality)
    where nullif(btrim(keyword.value), '') is not null;
  end if;

  new.input_snapshot := jsonb_set(
    coalesce(new.input_snapshot, '{}'::jsonb),
    '{alternativeKeywords}',
    v_alternative_keywords,
    true
  );
  return new;
end;
$$;

drop trigger if exists hydrate_competitor_discovery_keywords on public.ai_external_analysis_jobs;
create trigger hydrate_competitor_discovery_keywords
before insert or update of article_id, job_type, input_snapshot
on public.ai_external_analysis_jobs
for each row
when (new.job_type = 'competitor_discovery')
execute function public.hydrate_competitor_discovery_keywords();

revoke all on function public.evaluate_competitor_discovery_readiness(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.hydrate_competitor_discovery_keywords()
  from public, anon, authenticated;

comment on function public.hydrate_competitor_discovery_keywords()
  is 'Adds approved alternative keywords to every competitor-discovery job snapshot.';

commit;
