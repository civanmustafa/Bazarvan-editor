-- Dashboard pagination after visibility, trash, search, and article filters.

create or replace function public.dashboard_article_is_trashed(
  p_metadata jsonb,
  p_user_id uuid
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select
    nullif(btrim(coalesce(p_metadata #>> '{trash,deletedAt}', '')), '') is not null
    or (
      p_user_id is not null
      and nullif(btrim(coalesce(
        p_metadata #>> array['trash', 'deletedFor', p_user_id::text, 'deletedAt'],
        ''
      )), '') is not null
    );
$$;

create or replace function public.dashboard_article_is_public_opportunity(
  p_visibility text,
  p_owner_id uuid,
  p_created_by uuid,
  p_assigned_to uuid,
  p_metadata jsonb
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select
    coalesce(p_visibility, '') = 'public'
    and p_owner_id is null
    and p_created_by is null
    and p_assigned_to is null
    and nullif(btrim(coalesce(
      p_metadata #>> '{n8nSettings,visibleToEmailsCsv}',
      ''
    )), '') is null
    and not exists (
      select 1
      from jsonb_array_elements(
        case
          when jsonb_typeof(coalesce(p_metadata->'visibleTo', '[]'::jsonb)) = 'array'
            then coalesce(p_metadata->'visibleTo', '[]'::jsonb)
          else '[]'::jsonb
        end
      ) as visible_user(value)
      where nullif(btrim(coalesce(visible_user.value->>'email', '')), '') is not null
    );
$$;

create or replace function public.list_dashboard_articles_page(
  p_page integer default 1,
  p_page_size integer default 10,
  p_search text default '',
  p_mode text default 'all',
  p_trash boolean default false,
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean := public.is_admin();
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 10), 50));
  v_offset integer;
  v_filters jsonb := case when jsonb_typeof(p_filters) = 'object' then p_filters else '{}'::jsonb end;
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication is required' using errcode = '42501';
  end if;

  v_offset := (v_page - 1) * v_page_size;

  with visible_scope as materialized (
      select article.*
      from public.articles as article
      where public.dashboard_article_is_trashed(article.metadata, v_user_id) = coalesce(p_trash, false)
        and (coalesce(p_mode, 'all') <> 'n8n' or article.source = 'n8n')
        and (
          v_is_admin
          or article.owner_id = v_user_id
          or article.created_by = v_user_id
          or article.assigned_to = v_user_id
          or (
            not coalesce(p_trash, false)
            and public.dashboard_article_is_public_opportunity(
              article.visibility,
              article.owner_id,
              article.created_by,
              article.assigned_to,
              article.metadata
            )
          )
        )
    ), filtered as materialized (
      select article.*
      from visible_scope as article
      left join public.profiles as owner_profile
        on owner_profile.id = coalesce(article.owner_id, article.created_by, article.assigned_to)
      where (
        v_search = ''
        or position(v_search in lower(concat_ws(' ',
          article.id::text,
          article.title,
          article.plain_text,
          article.source::text,
          article.status::text,
          article.visibility::text,
          article.keywords->>'primary',
          article.keywords->>'company',
          article.keywords->'secondaries',
          article.keywords->'lsi',
          article.goal_context->>'pageType',
          article.goal_context->>'objective',
          article.goal_context->>'audienceScope',
          article.goal_context->>'targetCountry',
          article.goal_context->>'searchIntent',
          owner_profile.email,
          owner_profile.full_name,
          article.owner_id::text,
          article.created_by::text,
          article.assigned_to::text
        ))) > 0
      )
      and (
        nullif(v_filters->>'dateFrom', '') is null
        or (
          (v_filters->>'dateFrom') ~ '^\d{4}-\d{2}-\d{2}$'
          and article.last_saved_at is not null
          and article.last_saved_at >= (((v_filters->>'dateFrom')::date)::timestamp at time zone 'Europe/Istanbul')
        )
      )
      and (
        nullif(v_filters->>'dateTo', '') is null
        or (
          (v_filters->>'dateTo') ~ '^\d{4}-\d{2}-\d{2}$'
          and article.last_saved_at is not null
          and article.last_saved_at < ((((v_filters->>'dateTo')::date + 1)::timestamp) at time zone 'Europe/Istanbul')
        )
      )
      and (
        nullif(v_filters->>'createdFrom', '') is null
        or (
          (v_filters->>'createdFrom') ~ '^\d{4}-\d{2}-\d{2}$'
          and article.created_at >= (((v_filters->>'createdFrom')::date)::timestamp at time zone 'Europe/Istanbul')
        )
      )
      and (
        nullif(v_filters->>'createdTo', '') is null
        or (
          (v_filters->>'createdTo') ~ '^\d{4}-\d{2}-\d{2}$'
          and article.created_at < ((((v_filters->>'createdTo')::date + 1)::timestamp) at time zone 'Europe/Istanbul')
        )
      )
      and (
        nullif(v_filters->>'wordCountMin', '') is null
        or (
          (v_filters->>'wordCountMin') ~ '^\d+$'
          and case
            when coalesce(article.stats->>'wordCount', '') ~ '^\d+(\.\d+)?$'
              then (article.stats->>'wordCount')::numeric
            else 0
          end >= (v_filters->>'wordCountMin')::numeric
        )
      )
      and (
        nullif(v_filters->>'wordCountMax', '') is null
        or (
          (v_filters->>'wordCountMax') ~ '^\d+$'
          and case
            when coalesce(article.stats->>'wordCount', '') ~ '^\d+(\.\d+)?$'
              then (article.stats->>'wordCount')::numeric
            else 0
          end <= (v_filters->>'wordCountMax')::numeric
        )
      )
      and (
        nullif(v_filters->>'timeMin', '') is null
        or (
          (v_filters->>'timeMin') ~ '^\d+$'
          and floor(coalesce(article.time_spent_seconds, 0)::numeric / 60) >= (v_filters->>'timeMin')::numeric
        )
      )
      and (
        nullif(v_filters->>'timeMax', '') is null
        or (
          (v_filters->>'timeMax') ~ '^\d+$'
          and floor(coalesce(article.time_spent_seconds, 0)::numeric / 60) <= (v_filters->>'timeMax')::numeric
        )
      )
      and (coalesce(v_filters->>'language', 'all') = 'all' or article.article_language = v_filters->>'language')
      and (coalesce(v_filters->>'status', 'all') = 'all' or article.status = v_filters->>'status')
      and (
        coalesce(v_filters->>'profileId', 'all') = 'all'
        or article.owner_id::text = v_filters->>'profileId'
        or article.created_by::text = v_filters->>'profileId'
        or article.assigned_to::text = v_filters->>'profileId'
      )
      and (coalesce(v_filters->>'visibility', 'all') = 'all' or article.visibility = v_filters->>'visibility')
      and (coalesce(v_filters->>'source', 'all') = 'all' or article.source = v_filters->>'source')
      and (coalesce(v_filters->>'company', 'all') = 'all' or article.keywords->>'company' = v_filters->>'company')
      and (coalesce(v_filters->>'pageType', 'all') = 'all' or article.goal_context->>'pageType' = v_filters->>'pageType')
      and (coalesce(v_filters->>'audienceScope', 'all') = 'all' or article.goal_context->>'audienceScope' = v_filters->>'audienceScope')
    ), paged as (
      select
        article.id,
        article.owner_id,
        article.created_by,
        article.assigned_to,
        article.source,
        article.visibility,
        article.status,
        article.title,
        article.keywords,
        article.goal_context,
        article.article_language,
        article.stats,
        article.time_spent_seconds,
        article.save_count,
        article.metadata,
        article.created_at,
        article.updated_at,
        article.last_saved_at,
        greatest(
          coalesce(article.updated_at, '-infinity'::timestamptz),
          coalesce(article.last_saved_at, '-infinity'::timestamptz),
          coalesce(article.created_at, '-infinity'::timestamptz)
        ) as _sort_at
      from filtered as article
      order by _sort_at desc, article.id desc
      offset v_offset
      limit v_page_size
    ), totals as (
      select count(*)::integer as total_count from filtered
    )
  select jsonb_build_object(
      'articles', coalesce((
        select jsonb_agg(to_jsonb(paged) - '_sort_at' order by paged._sort_at desc, paged.id desc)
        from paged
      ), '[]'::jsonb),
      'totalCount', totals.total_count,
      'page', v_page,
      'pageSize', v_page_size,
      'hasNextPage', v_offset + v_page_size < totals.total_count,
      'filterOptions', jsonb_build_object(
        'companies', coalesce((
          select jsonb_agg(option_value order by option_value)
          from (
            select distinct btrim(article.keywords->>'company') as option_value
            from visible_scope as article
            where nullif(btrim(coalesce(article.keywords->>'company', '')), '') is not null
          ) as options
        ), '[]'::jsonb),
        'pageTypes', coalesce((
          select jsonb_agg(option_value order by option_value)
          from (
            select distinct btrim(article.goal_context->>'pageType') as option_value
            from visible_scope as article
            where nullif(btrim(coalesce(article.goal_context->>'pageType', '')), '') is not null
          ) as options
        ), '[]'::jsonb),
        'audienceScopes', coalesce((
          select jsonb_agg(option_value order by option_value)
          from (
            select distinct btrim(article.goal_context->>'audienceScope') as option_value
            from visible_scope as article
            where nullif(btrim(coalesce(article.goal_context->>'audienceScope', '')), '') is not null
          ) as options
        ), '[]'::jsonb),
        'sources', coalesce((
          select jsonb_agg(option_value order by option_value)
          from (
            select distinct article.source::text as option_value
            from visible_scope as article
          ) as options
        ), '[]'::jsonb),
        'visibilities', coalesce((
          select jsonb_agg(option_value order by option_value)
          from (
            select distinct article.visibility::text as option_value
            from visible_scope as article
          ) as options
        ), '[]'::jsonb)
      )
    )
  into v_result
  from totals;

  return v_result;
end;
$$;

revoke all on function public.dashboard_article_is_trashed(jsonb, uuid) from public;
revoke all on function public.dashboard_article_is_public_opportunity(text, uuid, uuid, uuid, jsonb) from public;
revoke all on function public.list_dashboard_articles_page(integer, integer, text, text, boolean, jsonb) from public;
grant execute on function public.dashboard_article_is_trashed(jsonb, uuid) to authenticated;
grant execute on function public.dashboard_article_is_public_opportunity(text, uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.list_dashboard_articles_page(integer, integer, text, text, boolean, jsonb) to authenticated;

comment on function public.list_dashboard_articles_page(integer, integer, text, text, boolean, jsonb) is 'Returns a full dashboard page after applying visibility, trash, search, and filters.';
