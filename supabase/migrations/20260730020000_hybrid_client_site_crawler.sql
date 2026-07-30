begin;

alter table public.client_site_crawl_runs
  add column if not exists provider text not null default 'auto';

alter table public.client_site_crawl_runs
  drop constraint if exists client_site_crawl_runs_provider_check;

alter table public.client_site_crawl_runs
  add constraint client_site_crawl_runs_provider_check
  check (provider in ('auto', 'local', 'firecrawl', 'browserless'));

create or replace function public.start_client_site_crawl(
  p_client_id uuid,
  p_started_by uuid,
  p_start_url text,
  p_max_pages integer,
  p_max_depth integer,
  p_follow_nofollow boolean,
  p_provider text
)
returns public.client_site_crawl_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.client_site_crawl_runs%rowtype;
  v_provider text := lower(btrim(coalesce(p_provider, 'auto')));
begin
  if v_provider not in ('auto', 'local', 'firecrawl', 'browserless') then
    raise exception 'Unsupported client site crawl provider.';
  end if;

  v_run := public.start_client_site_crawl(
    p_client_id,
    p_started_by,
    p_start_url,
    p_max_pages,
    p_max_depth,
    p_follow_nofollow
  );

  update public.client_site_crawl_runs
  set provider = v_provider,
      updated_at = now()
  where id = v_run.id
  returning * into v_run;

  return v_run;
end;
$$;

revoke all on function public.start_client_site_crawl(
  uuid,
  uuid,
  text,
  integer,
  integer,
  boolean,
  text
) from public, anon, authenticated;

grant execute on function public.start_client_site_crawl(
  uuid,
  uuid,
  text,
  integer,
  integer,
  boolean,
  text
) to service_role;

comment on column public.client_site_crawl_runs.provider is
  'Requested page-fetch provider. Auto tries local HTML first and uses configured external providers only when needed.';
comment on function public.start_client_site_crawl(
  uuid,
  uuid,
  text,
  integer,
  integer,
  boolean,
  text
) is
  'Starts a bounded client-site crawl with a local, automatic, Firecrawl, or Browserless page-fetch strategy.';

commit;
