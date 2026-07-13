-- Phases 2/3: one article access policy and one atomic save transaction.
-- Apply after 20260713000000_phase_0_1_security_hardening.sql.

create or replace function public.article_access_level_for_user(
  target_article_id uuid,
  target_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile_role public.app_role;
  v_owner_id uuid;
  v_created_by uuid;
  v_assigned_to uuid;
  v_access_role text;
begin
  if target_article_id is null or target_user_id is null then
    return 'none';
  end if;

  select profile.role
  into v_profile_role
  from public.profiles as profile
  where profile.id = target_user_id
    and profile.is_active is true;

  if not found then
    return 'none';
  end if;

  select article.owner_id, article.created_by, article.assigned_to
  into v_owner_id, v_created_by, v_assigned_to
  from public.articles as article
  where article.id = target_article_id;

  if not found then
    return 'none';
  end if;

  if v_profile_role = 'admin'::public.app_role then
    return 'admin';
  end if;

  if target_user_id = v_owner_id or target_user_id = v_assigned_to then
    return 'write';
  end if;

  select access_row.role
  into v_access_role
  from public.article_access as access_row
  where access_row.article_id = target_article_id
    and access_row.user_id = target_user_id
  limit 1;

  if v_access_role = 'editor' then
    return 'write';
  end if;

  if target_user_id = v_created_by
     or v_access_role = 'viewer'
     or public.is_article_public_opportunity(target_article_id) then
    return 'read';
  end if;

  return 'none';
end;
$$;

create or replace function public.article_access_level(target_article_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.article_access_level_for_user(target_article_id, auth.uid());
$$;

create or replace function public.can_read_article(target_article_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.article_access_level(target_article_id) in ('read', 'write', 'admin');
$$;

create or replace function public.can_write_article(target_article_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.article_access_level(target_article_id) in ('write', 'admin');
$$;

revoke all on function public.article_access_level_for_user(uuid, uuid) from public, anon, authenticated;
revoke all on function public.article_access_level(uuid) from public, anon;
revoke all on function public.can_read_article(uuid) from public, anon;
revoke all on function public.can_write_article(uuid) from public, anon;
grant execute on function public.article_access_level_for_user(uuid, uuid) to service_role;
grant execute on function public.article_access_level(uuid) to authenticated;
grant execute on function public.can_read_article(uuid) to authenticated;
grant execute on function public.can_write_article(uuid) to authenticated;

drop policy if exists "articles_select_visible" on public.articles;
create policy "articles_select_visible"
on public.articles
for select
to authenticated
using (public.can_read_article(id));

drop policy if exists "articles_update_owner_assignee_or_admin" on public.articles;
create policy "articles_update_owner_assignee_or_admin"
on public.articles
for update
to authenticated
using (public.can_write_article(id))
with check (public.can_write_article(id));

create table if not exists public.article_save_requests (
  user_id uuid not null references public.profiles(id) on delete cascade,
  idempotency_key text not null,
  article_id uuid not null references public.articles(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key),
  constraint article_save_requests_key_format check (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,160}$'
  )
);

create index if not exists article_save_requests_article_created_idx
  on public.article_save_requests(article_id, created_at desc);
create index if not exists article_save_requests_created_at_idx
  on public.article_save_requests(created_at desc);
create index if not exists article_save_requests_user_created_idx
  on public.article_save_requests(user_id, created_at desc);

alter table public.article_save_requests enable row level security;
revoke all on public.article_save_requests from public, anon, authenticated;
grant select, insert, update, delete on public.article_save_requests to service_role;

create or replace function public.save_article_snapshot(
  p_article_id uuid,
  p_idempotency_key text,
  p_snapshot jsonb,
  p_save_reason text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_article public.articles%rowtype;
  v_existing_article_id uuid;
  v_existing_version integer;
  v_summary jsonb;
  v_analysis_summary jsonb;
  v_stats jsonb;
  v_new_attachments jsonb;
  v_existing_attachments jsonb;
  v_metadata jsonb;
  v_visible_to jsonb;
  v_title text;
  v_language text;
  v_reason text := lower(btrim(coalesce(p_save_reason, 'manual')));
  v_version integer;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9:_-]{16,160}$' then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;

  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'Article snapshot must be a JSON object.' using errcode = '22023';
  end if;

  if v_reason not in ('manual', 'auto', 'lifecycle', 'recovery') then
    raise exception 'Unsupported article save reason.' using errcode = '22023';
  end if;

  select profile.*
  into v_profile
  from public.profiles as profile
  where profile.id = v_user_id
    and profile.is_active is true;

  if not found then
    raise exception 'An active user profile is required.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_user_id::text || ':' || p_idempotency_key, 0)
  );

  select save_request.article_id, save_request.version_number
  into v_existing_article_id, v_existing_version
  from public.article_save_requests as save_request
  where save_request.user_id = v_user_id
    and save_request.idempotency_key = p_idempotency_key;

  if found then
    if p_article_id is not null and p_article_id <> v_existing_article_id then
      raise exception 'The idempotency key belongs to another article.' using errcode = '22023';
    end if;
    if public.article_access_level_for_user(v_existing_article_id, v_user_id) = 'none' then
      raise exception 'Article access is no longer available.' using errcode = '42501';
    end if;
    select article.*
    into v_article
    from public.articles as article
    where article.id = v_existing_article_id;
    if not found then
      raise exception 'Article was not found.' using errcode = 'P0002';
    end if;
    return jsonb_build_object(
      'article', to_jsonb(v_article),
      'versionNumber', v_existing_version,
      'replayed', true
    );
  end if;

  v_title := coalesce(nullif(btrim(p_snapshot->>'title'), ''), '(untitled)');
  if char_length(v_title) > 5000 then
    raise exception 'Article title is too long.' using errcode = '22023';
  end if;

  v_language := case when p_snapshot->>'articleLanguage' = 'en' then 'en' else 'ar' end;
  v_summary := case
    when jsonb_typeof(p_snapshot->'analysisSummary') = 'object'
      then p_snapshot->'analysisSummary'
    else '{}'::jsonb
  end;

  v_stats := jsonb_build_object(
    'wordCount', case
      when coalesce(v_summary->>'wordCount', '') ~ '^\d+(\.\d+)?$'
        then greatest(0, floor((v_summary->>'wordCount')::numeric)::integer)
      else 0
    end,
    'keywordViolations', case
      when coalesce(v_summary->>'keywordViolations', '') ~ '^\d+(\.\d+)?$'
        then greatest(0, floor((v_summary->>'keywordViolations')::numeric)::integer)
      else 0
    end,
    'violatingCriteriaCount', case
      when coalesce(v_summary->>'structureViolations', '') ~ '^\d+(\.\d+)?$'
        then greatest(0, floor((v_summary->>'structureViolations')::numeric)::integer)
      else 0
    end,
    'totalDuplicates', case
      when coalesce(v_summary->>'totalDuplicates', '') ~ '^\d+(\.\d+)?$'
        then greatest(0, floor((v_summary->>'totalDuplicates')::numeric)::integer)
      else 0
    end
  );
  v_analysis_summary := jsonb_build_object(
    'wordCount', v_stats->'wordCount',
    'keywordViolations', v_stats->'keywordViolations',
    'structureViolations', v_stats->'violatingCriteriaCount',
    'totalDuplicates', v_stats->'totalDuplicates'
  );
  v_new_attachments := case
    when jsonb_typeof(p_snapshot->'attachments') = 'object'
      then p_snapshot->'attachments'
    else '{}'::jsonb
  end;

  if p_article_id is not null then
    select article.*
    into v_article
    from public.articles as article
    where article.id = p_article_id
    for update;

    if not found then
      raise exception 'Article was not found.' using errcode = 'P0002';
    end if;

    if public.article_access_level_for_user(p_article_id, v_user_id) not in ('write', 'admin') then
      raise exception 'You do not have permission to update this article.' using errcode = '42501';
    end if;

    select greatest(
      coalesce(v_article.save_count, 0) + 1,
      coalesce(max(article_version.version_number), 0) + 1
    )
    into v_version
    from public.article_versions as article_version
    where article_version.article_id = p_article_id;

    v_existing_attachments := case
      when jsonb_typeof(v_article.metadata->'attachments') = 'object'
        then v_article.metadata->'attachments'
      else '{}'::jsonb
    end;
    v_metadata := coalesce(v_article.metadata, '{}'::jsonb) || jsonb_build_object(
      'analysisSummary', v_analysis_summary,
      'attachments', v_existing_attachments || v_new_attachments
    );

    update public.articles as article
    set
      title = v_title,
      content_json = case
        when jsonb_typeof(p_snapshot->'content') is null
          or jsonb_typeof(p_snapshot->'content') = 'null' then '{}'::jsonb
        else p_snapshot->'content'
      end,
      content_html = nullif(p_snapshot->>'contentHtml', ''),
      plain_text = coalesce(p_snapshot->>'plainText', ''),
      keywords = case
        when jsonb_typeof(p_snapshot->'keywords') = 'object' then p_snapshot->'keywords'
        else '{}'::jsonb
      end,
      goal_context = case
        when jsonb_typeof(p_snapshot->'goalContext') = 'object' then p_snapshot->'goalContext'
        else '{}'::jsonb
      end,
      article_language = v_language,
      analysis = null,
      stats = v_stats,
      metadata = v_metadata,
      save_count = v_version,
      last_saved_at = now()
    where article.id = p_article_id
    returning article.* into v_article;
  else
    v_version := 1;
    v_visible_to := case
      when nullif(btrim(coalesce(v_profile.email, '')), '') is null then '[]'::jsonb
      else jsonb_build_array(jsonb_build_object(
        'id', v_profile.id,
        'email', v_profile.email,
        'fullName', v_profile.full_name,
        'role', 'editor'
      ))
    end;
    v_metadata := jsonb_build_object(
      'analysisSummary', v_analysis_summary,
      'attachments', v_new_attachments,
      'n8nSettings', jsonb_build_object(
        'visibility', 'private',
        'accessRole', 'editor',
        'visibleToEmailsCsv', coalesce(v_profile.email, ''),
        'articleLanguage', v_language,
        'status', 'draft'
      ),
      'visibleTo', v_visible_to
    );

    insert into public.articles (
      owner_id,
      created_by,
      assigned_to,
      source,
      visibility,
      status,
      title,
      content_json,
      content_html,
      plain_text,
      keywords,
      goal_context,
      article_language,
      analysis,
      stats,
      time_spent_seconds,
      save_count,
      metadata,
      last_saved_at
    ) values (
      v_user_id,
      v_user_id,
      v_user_id,
      'manual',
      'private',
      'draft',
      v_title,
      case
        when jsonb_typeof(p_snapshot->'content') is null
          or jsonb_typeof(p_snapshot->'content') = 'null' then '{}'::jsonb
        else p_snapshot->'content'
      end,
      nullif(p_snapshot->>'contentHtml', ''),
      coalesce(p_snapshot->>'plainText', ''),
      case
        when jsonb_typeof(p_snapshot->'keywords') = 'object' then p_snapshot->'keywords'
        else '{}'::jsonb
      end,
      case
        when jsonb_typeof(p_snapshot->'goalContext') = 'object' then p_snapshot->'goalContext'
        else '{}'::jsonb
      end,
      v_language,
      null,
      v_stats,
      0,
      v_version,
      v_metadata,
      now()
    )
    returning * into v_article;
  end if;

  insert into public.article_versions (
    article_id,
    version_number,
    created_by,
    title,
    content_json,
    content_html,
    plain_text,
    keywords,
    goal_context,
    analysis,
    stats,
    note
  ) values (
    v_article.id,
    v_version,
    v_user_id,
    v_article.title,
    v_article.content_json,
    v_article.content_html,
    v_article.plain_text,
    v_article.keywords,
    v_article.goal_context,
    null,
    v_article.stats,
    case v_reason
      when 'auto' then 'auto-save'
      when 'lifecycle' then 'lifecycle-save'
      when 'recovery' then 'recovery-save'
      else 'manual-save'
    end
  );

  v_result := jsonb_build_object(
    'article', to_jsonb(v_article),
    'versionNumber', v_version,
    'replayed', false
  );

  insert into public.article_save_requests (
    user_id,
    idempotency_key,
    article_id,
    version_number
  ) values (
    v_user_id,
    p_idempotency_key,
    v_article.id,
    v_version
  );

  delete from public.article_save_requests as old_request
  where old_request.user_id = v_user_id
    and old_request.created_at < now() - interval '7 days';

  return v_result;
end;
$$;

revoke all on function public.save_article_snapshot(uuid, text, jsonb, text) from public, anon;
grant execute on function public.save_article_snapshot(uuid, text, jsonb, text) to authenticated;

-- Recreate the dashboard RPC so it delegates visibility to the same access policy.
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
        and public.can_read_article(article.id)
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

revoke all on function public.list_dashboard_articles_page(integer, integer, text, text, boolean, jsonb) from public, anon;
grant execute on function public.list_dashboard_articles_page(integer, integer, text, text, boolean, jsonb) to authenticated;

comment on function public.article_access_level_for_user(uuid, uuid) is
  'Canonical article authorization policy for server-side calls.';
comment on function public.article_access_level(uuid) is
  'Canonical article authorization policy for the authenticated user.';
comment on function public.save_article_snapshot(uuid, text, jsonb, text) is
  'Atomically saves an article, records its version, and stores an idempotent response.';
