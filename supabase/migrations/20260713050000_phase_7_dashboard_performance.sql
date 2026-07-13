-- Phase 7: dashboard pagination performance.
-- The RPC already applies access, trash, search, and filters before LIMIT/OFFSET.
-- Running it as definer avoids evaluating the articles RLS policy and the explicit
-- AccessPolicy check twice for every candidate row.

alter function public.list_dashboard_articles_page(
  integer,
  integer,
  text,
  text,
  boolean,
  jsonb
) security definer;

alter function public.list_dashboard_articles_page(
  integer,
  integer,
  text,
  text,
  boolean,
  jsonb
) set search_path = public, pg_temp;

revoke all on function public.list_dashboard_articles_page(
  integer,
  integer,
  text,
  text,
  boolean,
  jsonb
) from public, anon;

grant execute on function public.list_dashboard_articles_page(
  integer,
  integer,
  text,
  text,
  boolean,
  jsonb
) to authenticated;

-- Match the stable dashboard order used by the RPC. The id suffix keeps paging
-- deterministic when several rows share the same save/update timestamp.
create index if not exists articles_dashboard_sort_idx
  on public.articles (
    (greatest(
      coalesce(updated_at, '-infinity'::timestamptz),
      coalesce(last_saved_at, '-infinity'::timestamptz),
      coalesce(created_at, '-infinity'::timestamptz)
    )) desc,
    id desc
  );

create index if not exists articles_dashboard_source_sort_idx
  on public.articles (
    source,
    (greatest(
      coalesce(updated_at, '-infinity'::timestamptz),
      coalesce(last_saved_at, '-infinity'::timestamptz),
      coalesce(created_at, '-infinity'::timestamptz)
    )) desc,
    id desc
  );

create index if not exists articles_dashboard_status_sort_idx
  on public.articles (
    status,
    (greatest(
      coalesce(updated_at, '-infinity'::timestamptz),
      coalesce(last_saved_at, '-infinity'::timestamptz),
      coalesce(created_at, '-infinity'::timestamptz)
    )) desc,
    id desc
  );

comment on function public.list_dashboard_articles_page(
  integer,
  integer,
  text,
  text,
  boolean,
  jsonb
) is
  'Returns a full page after canonical AccessPolicy, trash, search, and filters; defaults to 10 rows.';
