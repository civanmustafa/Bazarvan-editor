-- Include explicit article_access grants when filtering dashboard articles by user.
-- The dashboard RPC predates per-user grants and otherwise reports incomplete totals.
do $migration$
declare
  v_function regprocedure := 'public.list_dashboard_articles_page(integer,integer,text,text,boolean,jsonb)'::regprocedure;
  v_definition text;
  v_marker text := 'or article.assigned_to::text = v_filters->>''profileId''';
  v_replacement text := v_marker || E'\n        or exists (\n          select 1\n          from public.article_access as access_row\n          where access_row.article_id = article.id\n            and access_row.user_id::text = v_filters->>''profileId''\n        )';
begin
  select pg_get_functiondef(v_function::oid)
  into v_definition;

  if position(v_marker in v_definition) = 0 then
    raise exception 'Could not locate the dashboard profile filter in list_dashboard_articles_page';
  end if;

  if position('from public.article_access as access_row' in v_definition) > 0 then
    return;
  end if;

  v_definition := replace(v_definition, v_marker, v_replacement);
  execute v_definition;
end;
$migration$;

comment on function public.list_dashboard_articles_page(integer, integer, text, text, boolean, jsonb) is
  'Returns a complete dashboard page after applying visibility, access-grant, trash, search, and filters.';
