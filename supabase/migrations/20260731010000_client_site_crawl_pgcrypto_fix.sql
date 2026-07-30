begin;

-- Supabase installs pgcrypto in the protected `extensions` schema. The site
-- crawl trigger originally restricted its search_path to `public`, so the
-- unqualified digest(text, text) call failed only after a provider had already
-- returned valid HTML and the job attempted to persist its internal links.
do $migration_guard$
declare
  v_pgcrypto_schema text;
begin
  if to_regprocedure('public.process_completed_client_page_links()') is null then
    raise exception
      'process_completed_client_page_links() must exist before applying the pgcrypto fix.';
  end if;

  select namespace.nspname
  into v_pgcrypto_schema
  from pg_extension as extension
  join pg_namespace as namespace
    on namespace.oid = extension.extnamespace
  where extension.extname = 'pgcrypto';

  if v_pgcrypto_schema is null then
    raise exception 'The pgcrypto extension is required by the Client Center crawler.';
  end if;
end;
$migration_guard$;

-- ALTER FUNCTION preserves the reviewed trigger body, owner, and privileges.
-- `pg_temp` stays last to avoid resolving attacker-controlled temporary objects
-- before the application and protected extension schemas.
alter function public.process_completed_client_page_links()
  set search_path = public, extensions, pg_temp;

-- Keep direct invocation unavailable; PostgreSQL can still execute the
-- function through its registered trigger.
revoke all on function public.process_completed_client_page_links()
  from public, anon, authenticated;

comment on function public.process_completed_client_page_links() is
  'Persists the internal-link graph and resolves pgcrypto digest from the protected extensions schema.';

commit;
