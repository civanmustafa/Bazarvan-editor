begin;

create or replace function public.get_dashboard_activity_summary()
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication is required' using errcode = '42501';
  end if;

  with visible_articles as materialized (
    select
      article.id,
      coalesce(article.owner_id, article.created_by, article.assigned_to) as profile_id,
      article.status,
      greatest(coalesce(article.time_spent_seconds, 0), 0)::bigint as time_spent_seconds,
      greatest(coalesce(article.save_count, 0), 0)::bigint as save_count,
      case
        when coalesce(article.stats->>'wordCount', '') ~ '^\d+(\.\d+)?$'
          then greatest((article.stats->>'wordCount')::numeric, 0)::bigint
        else 0::bigint
      end as word_count,
      greatest(
        coalesce(article.updated_at, '-infinity'::timestamptz),
        coalesce(article.last_saved_at, '-infinity'::timestamptz),
        coalesce(article.created_at, '-infinity'::timestamptz)
      ) as activity_at
    from public.articles as article
    where not public.dashboard_article_is_trashed(article.metadata, v_user_id)
      and public.can_read_article(article.id)
  ), profile_scope as materialized (
    select
      profile.id,
      profile.email,
      profile.full_name,
      profile.role,
      profile.is_active,
      profile.last_seen_at
    from public.profiles as profile
  ), profile_summary as materialized (
    select
      profile.id,
      profile.email,
      profile.full_name,
      profile.role,
      profile.is_active,
      profile.last_seen_at,
      count(article.id)::integer as article_count,
      coalesce(sum(article.time_spent_seconds), 0)::bigint as total_time_seconds,
      coalesce(sum(article.word_count), 0)::bigint as total_words,
      max(article.activity_at) as last_activity_at,
      jsonb_build_object(
        'content_preparation', count(article.id) filter (where article.status = 'content_preparation'),
        'draft', count(article.id) filter (where article.status = 'draft'),
        'in_review', count(article.id) filter (where article.status = 'in_review'),
        'published', count(article.id) filter (where article.status = 'published'),
        'archived', count(article.id) filter (where article.status = 'archived')
      ) as status_counts
    from profile_scope as profile
    left join visible_articles as article
      on article.profile_id = profile.id
    group by
      profile.id,
      profile.email,
      profile.full_name,
      profile.role,
      profile.is_active,
      profile.last_seen_at
  ), totals as (
    select
      count(*)::integer as total_articles,
      coalesce(sum(article.time_spent_seconds), 0)::bigint as total_time_seconds,
      coalesce(sum(article.word_count), 0)::bigint as total_words,
      coalesce(sum(article.save_count), 0)::bigint as total_saves,
      count(*) filter (where article.activity_at >= now() - interval '7 days')::integer as articles_updated_last_7_days,
      count(*) filter (where article.profile_id is null)::integer as unassigned_articles,
      max(article.activity_at) as last_activity_at,
      jsonb_build_object(
        'content_preparation', count(*) filter (where article.status = 'content_preparation'),
        'draft', count(*) filter (where article.status = 'draft'),
        'in_review', count(*) filter (where article.status = 'in_review'),
        'published', count(*) filter (where article.status = 'published'),
        'archived', count(*) filter (where article.status = 'archived')
      ) as status_counts
    from visible_articles as article
  ), profile_totals as (
    select
      count(*)::integer as total_users,
      count(*) filter (where profile.is_active)::integer as enabled_users,
      count(*) filter (where profile.article_count > 0)::integer as contributor_users
    from profile_summary as profile
  )
  select jsonb_build_object(
    'totalArticles', totals.total_articles,
    'totalTimeSeconds', totals.total_time_seconds,
    'averageTimeSeconds', case
      when totals.total_articles > 0 then round(totals.total_time_seconds::numeric / totals.total_articles)::bigint
      else 0::bigint
    end,
    'totalWords', totals.total_words,
    'totalSaves', totals.total_saves,
    'articlesUpdatedLast7Days', totals.articles_updated_last_7_days,
    'unassignedArticles', totals.unassigned_articles,
    'lastActivityAt', totals.last_activity_at,
    'statusCounts', totals.status_counts,
    'totalUsers', profile_totals.total_users,
    'enabledUsers', profile_totals.enabled_users,
    'contributorUsers', profile_totals.contributor_users,
    'users', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', profile.id,
          'email', profile.email,
          'fullName', profile.full_name,
          'role', profile.role,
          'isActive', profile.is_active,
          'lastSeenAt', profile.last_seen_at,
          'articleCount', profile.article_count,
          'totalTimeSeconds', profile.total_time_seconds,
          'totalWords', profile.total_words,
          'lastActivityAt', profile.last_activity_at,
          'statusCounts', profile.status_counts
        )
        order by
          profile.article_count desc,
          profile.total_time_seconds desc,
          lower(coalesce(profile.full_name, profile.email, profile.id::text))
      )
      from profile_summary as profile
    ), '[]'::jsonb)
  )
  into v_result
  from totals
  cross join profile_totals;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

revoke all on function public.get_dashboard_activity_summary() from public, anon;
grant execute on function public.get_dashboard_activity_summary() to authenticated;

comment on function public.get_dashboard_activity_summary() is
  'Access-aware aggregate for the dashboard activity card, including status totals and per-profile article/time metrics.';

notify pgrst, 'reload schema';

commit;
