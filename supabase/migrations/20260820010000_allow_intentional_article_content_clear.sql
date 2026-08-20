-- Preserve the existing accidental-empty safeguard, while allowing the editor
-- to explicitly clear a loaded article after a real user edit.

create or replace function public.preserve_saved_article_content()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('app.allow_empty_article_body', true), '') = 'on' then
    return new;
  end if;

  if public.article_body_has_content(old.content_json, old.content_html, old.plain_text)
     and not public.article_body_has_content(new.content_json, new.content_html, new.plain_text) then
    new.content_json := old.content_json;
    new.content_html := old.content_html;
    new.plain_text := old.plain_text;
  end if;
  return new;
end;
$$;

comment on function public.preserve_saved_article_content() is
  'Prevents accidental empty TipTap saves while permitting a transaction-scoped explicit clear.';

create or replace function public.save_article_snapshot_with_content_policy(
  p_article_id uuid,
  p_idempotency_key text,
  p_snapshot jsonb,
  p_save_reason text default 'manual',
  p_allow_empty_body boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_allow_empty_body, false) then
    if p_article_id is null then
      raise exception 'Only an existing article body can be explicitly cleared.' using errcode = '22023';
    end if;

    if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
      raise exception 'Article snapshot must be a JSON object.' using errcode = '22023';
    end if;

    if public.article_body_has_content(
      p_snapshot->'content',
      p_snapshot->>'contentHtml',
      p_snapshot->>'plainText'
    ) then
      raise exception 'An explicit body clear must contain an empty article body.' using errcode = '22023';
    end if;

    perform set_config('app.allow_empty_article_body', 'on', true);
  end if;

  return public.save_article_snapshot(
    p_article_id,
    p_idempotency_key,
    p_snapshot,
    p_save_reason
  );
end;
$$;

revoke all on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean)
  from public, anon;
grant execute on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean)
  to authenticated;

comment on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean) is
  'Atomically saves an article and enables empty-body persistence only for an explicit existing-article clear.';

notify pgrst, 'reload schema';
