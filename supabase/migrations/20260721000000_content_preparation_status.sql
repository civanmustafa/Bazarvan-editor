-- Add the content-preparation workflow state and keep external analysis eligible
-- while an article is either being prepared or actively drafted.

alter table public.articles
  drop constraint if exists articles_status_check;

alter table public.articles
  add constraint articles_status_check
  check (status in ('content_preparation', 'draft', 'in_review', 'published', 'archived'));

create or replace function public.article_status_supports_external_analysis(p_status text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_status, '') in ('content_preparation', 'draft');
$$;

create or replace function public.update_article_dashboard_status(
  target_article_id uuid,
  next_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if next_status not in ('content_preparation', 'draft', 'in_review', 'published', 'archived') then
    raise exception 'Invalid article status: %', next_status;
  end if;

  if not public.can_write_article(target_article_id) then
    raise exception 'You do not have write access to this article.';
  end if;

  update public.articles
  set
    status = next_status,
    metadata = jsonb_set(
      jsonb_set(
        case
          when next_status = 'in_review'
            then coalesce(metadata, '{}'::jsonb) - 'aiResults'
          else coalesce(metadata, '{}'::jsonb)
        end,
        '{n8nSettings}',
        coalesce(metadata->'n8nSettings', '{}'::jsonb),
        true
      ),
      '{n8nSettings,status}',
      to_jsonb(next_status),
      true
    )
  where id = target_article_id;
end;
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
  v_has_supported_status boolean := public.article_status_supports_external_analysis(p_status);
  v_signature_status text := case
    when public.article_status_supports_external_analysis(p_status) then 'draft'
    else coalesce(p_status, '')
  end;
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

  if not v_has_supported_status then
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
    'status', v_signature_status,
    'title', coalesce(p_title, ''),
    'plainText', coalesce(p_plain_text, ''),
    'primaryKeyword', coalesce(p_keywords->>'primary', ''),
    'companyName', coalesce(p_keywords->>'company', ''),
    'goalContext', coalesce(p_goal_context, '{}'::jsonb)
  )::text);
  v_external_signature := md5(jsonb_build_object(
    'status', v_signature_status,
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
  v_query_type text := case when v_primary_keyword <> '' then 'primary_keyword' else 'title' end;
  v_query_text text := case when v_primary_keyword <> '' then v_primary_keyword else v_title end;
  v_missing_fields jsonb := '[]'::jsonb;
  v_signature text;
  v_signature_status text := case
    when public.article_status_supports_external_analysis(p_status) then 'draft'
    else coalesce(p_status, '')
  end;
begin
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
    'queryText', v_query_text
  );
end;
$$;

revoke all on function public.update_article_dashboard_status(uuid, text) from public;
revoke all on function public.update_article_dashboard_status(uuid, text) from anon;
grant execute on function public.update_article_dashboard_status(uuid, text) to authenticated;

comment on function public.article_status_supports_external_analysis(text)
  is 'Canonical eligibility rule for automatic and manual external analysis.';
