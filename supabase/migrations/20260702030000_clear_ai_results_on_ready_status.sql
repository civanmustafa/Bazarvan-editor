-- Clear saved AI analysis results when an article is moved to the ready state.
-- The UI label is "ready/جاهز"; the database status value remains "in_review".

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
  if next_status not in ('draft', 'in_review', 'published', 'archived') then
    raise exception 'Invalid article status: %', next_status;
  end if;

  if not public.can_read_article(target_article_id) then
    raise exception 'You do not have access to this article.';
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

grant execute on function public.update_article_dashboard_status(uuid, text) to authenticated;
