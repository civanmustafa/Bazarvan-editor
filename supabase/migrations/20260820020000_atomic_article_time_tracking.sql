-- Record editor time with one atomic database update so overlapping browser flushes
-- cannot overwrite each other.

create or replace function public.record_article_time(
  p_article_id uuid,
  p_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_total integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication is required.';
  end if;

  if p_article_id is null or p_seconds is null or p_seconds < 1 or p_seconds > 3600 then
    raise exception using errcode = '22023', message = 'Article time delta must be between 1 and 3600 seconds.';
  end if;

  if public.article_access_level_for_user(p_article_id, v_user_id) not in ('write', 'admin') then
    raise exception using errcode = '42501', message = 'Write access to the article is required.';
  end if;

  update public.articles as article
  set time_spent_seconds = coalesce(article.time_spent_seconds, 0) + p_seconds
  where article.id = p_article_id
  returning article.time_spent_seconds into v_total;

  if not found then
    raise exception using errcode = 'P0002', message = 'Article not found.';
  end if;

  return v_total;
end;
$$;

revoke all on function public.record_article_time(uuid, integer) from public, anon;
grant execute on function public.record_article_time(uuid, integer) to authenticated, service_role;

comment on function public.record_article_time(uuid, integer) is
  'Atomically increments editor time for an authenticated article writer.';
