-- A separate migration is intentional: PostgreSQL must commit a new enum value
-- before later migrations can safely use it in inserts.

alter type public.client_page_source
  add value if not exists 'crawl';
