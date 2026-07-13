-- Phase 0/1 security hardening.
-- Status changes mutate canonical article data and therefore require write access.

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

  if next_status not in ('draft', 'in_review', 'published', 'archived') then
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

revoke all on function public.update_article_dashboard_status(uuid, text) from public;
revoke all on function public.update_article_dashboard_status(uuid, text) from anon;
grant execute on function public.update_article_dashboard_status(uuid, text) to authenticated;
