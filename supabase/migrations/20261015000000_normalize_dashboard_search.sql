-- Normalize dashboard search without changing the stored article text.
create or replace function public.normalize_dashboard_search_text(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select translate(
    regexp_replace(lower(coalesce(p_value, '')), '[ًٌٍَُِّْـٰ]', '', 'g'),
    'أإآٱؤئىیک',
    'ااااويييك'
  );
$$;

revoke all on function public.normalize_dashboard_search_text(text) from public, anon;
grant execute on function public.normalize_dashboard_search_text(text) to authenticated;

do $migration$
declare
  v_function regprocedure := 'public.list_dashboard_articles_page(integer,integer,text,text,boolean,jsonb)'::regprocedure;
  v_definition text;
  v_search_declaration text := $find$v_search text := lower(btrim(coalesce(p_search, '')));$find$;
  v_normalized_declaration text := $replace$v_search text := public.normalize_dashboard_search_text(btrim(p_search));$replace$;
  v_search_expression text := $find$position(v_search in lower(concat_ws(' ',$find$;
  v_normalized_expression text := $replace$position(v_search in public.normalize_dashboard_search_text(concat_ws(' ',$replace$;
begin
  select pg_get_functiondef(v_function::oid)
  into v_definition;

  if position(v_search_declaration in v_definition) = 0 then
    raise exception 'Could not locate the dashboard search declaration';
  end if;

  if position(v_search_expression in v_definition) = 0 then
    raise exception 'Could not locate the dashboard search expression';
  end if;

  v_definition := replace(v_definition, v_search_declaration, v_normalized_declaration);
  v_definition := replace(v_definition, v_search_expression, v_normalized_expression);
  execute v_definition;
end;
$migration$;

comment on function public.normalize_dashboard_search_text(text) is
  'Normalizes Arabic letter variants, Arabic marks, and Latin case for dashboard search.';
comment on function public.list_dashboard_articles_page(integer, integer, text, text, boolean, jsonb) is
  'Returns a dashboard page after tab filters and normalized Arabic/Latin search are applied together.';
