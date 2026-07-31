-- Mark articles created or replaced through the authenticated URL importer.
-- The atomic save RPC already persists sanitized snapshot attachments in metadata,
-- so the trigger can classify the article without widening the save API surface.

create or replace function public.classify_url_imported_article()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_origin jsonb;
begin
  v_origin := new.metadata #> '{attachments,importOrigin}';
  if jsonb_typeof(v_origin) = 'object'
     and coalesce(v_origin->>'sourceUrl', '') <> ''
     and coalesce(v_origin->>'contentHash', '') <> ''
     and coalesce(v_origin->>'mode', '') in ('new', 'replace') then
    new.source := 'import';
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'importedAt', coalesce(nullif(v_origin->>'importedAt', ''), now()::text),
      'importedBy', 'url'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists classify_url_imported_article_trigger on public.articles;
create trigger classify_url_imported_article_trigger
before insert or update of metadata on public.articles
for each row
execute function public.classify_url_imported_article();

comment on function public.classify_url_imported_article() is
  'Classifies authenticated editor snapshots with a validated URL import origin as source=import.';
