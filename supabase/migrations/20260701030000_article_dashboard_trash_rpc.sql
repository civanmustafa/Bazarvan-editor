create or replace function public.move_article_to_dashboard_trash(
  target_article_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id text := auth.uid()::text;
  now_value timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if not public.can_read_article(target_article_id) then
    raise exception 'You do not have access to this article.';
  end if;

  if public.is_admin() then
    update public.articles
    set metadata = jsonb_set(
      coalesce(metadata, '{}'::jsonb),
      '{trash}',
      coalesce(metadata->'trash', '{}'::jsonb) || jsonb_build_object(
        'deletedAt', now_value,
        'deletedBy', current_user_id,
        'deletedScope', 'global'
      ),
      true
    )
    where id = target_article_id;
  else
    update public.articles
    set metadata = jsonb_set(
      jsonb_set(
        coalesce(metadata, '{}'::jsonb),
        '{trash}',
        coalesce(metadata->'trash', '{}'::jsonb),
        true
      ),
      array['trash', 'deletedFor', current_user_id],
      jsonb_build_object(
        'deletedAt', now_value,
        'deletedBy', current_user_id,
        'deletedScope', 'user'
      ),
      true
    )
    where id = target_article_id;
  end if;
end;
$$;

create or replace function public.restore_article_from_dashboard_trash(
  target_article_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id text := auth.uid()::text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if not public.can_read_article(target_article_id) then
    raise exception 'You do not have access to this article.';
  end if;

  if public.is_admin() then
    update public.articles
    set metadata = coalesce(metadata, '{}'::jsonb)
      #- '{trash,deletedAt}'
      #- '{trash,deletedBy}'
      #- '{trash,deletedScope}'
    where id = target_article_id;
  else
    update public.articles
    set metadata = coalesce(metadata, '{}'::jsonb)
      #- array['trash', 'deletedFor', current_user_id]
    where id = target_article_id;
  end if;
end;
$$;

grant execute on function public.move_article_to_dashboard_trash(uuid) to authenticated;
grant execute on function public.restore_article_from_dashboard_trash(uuid) to authenticated;

