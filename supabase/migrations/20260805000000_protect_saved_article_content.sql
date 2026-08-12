-- A valid but empty TipTap document serializes as {"type":"doc","content":[{"type":"paragraph"}]}
-- and HTML <p></p>. Do not allow it to erase an article that still has a body.

create or replace function public.article_body_has_content(
  p_content_json jsonb,
  p_content_html text,
  p_plain_text text
)
returns boolean
language sql
immutable
as $$
  select
    nullif(btrim(coalesce(p_plain_text, '')), '') is not null
    or jsonb_path_exists(
      coalesce(p_content_json, '{}'::jsonb),
      '$.**.text ? (@ != "")'
    )
    or nullif(
      btrim(
        regexp_replace(
          replace(replace(coalesce(p_content_html, ''), '&nbsp;', ' '), '&#160;', ' '),
          '<[^>]*>',
          ' ',
          'g'
        )
      ),
      ''
    ) is not null;
$$;

create or replace function public.preserve_saved_article_content()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if public.article_body_has_content(old.content_json, old.content_html, old.plain_text)
     and not public.article_body_has_content(new.content_json, new.content_html, new.plain_text) then
    new.content_json := old.content_json;
    new.content_html := old.content_html;
    new.plain_text := old.plain_text;
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_saved_article_content on public.articles;
create trigger preserve_saved_article_content
before update of content_json, content_html, plain_text on public.articles
for each row
execute function public.preserve_saved_article_content();

comment on function public.preserve_saved_article_content() is
  'Prevents an empty TipTap document (<p></p>) from overwriting a non-empty saved article body.';
