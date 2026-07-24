-- Client Center phases 2 and 3: page extraction fields and a durable, service-role-only crawl queue.
-- Crawling is deterministic HTML processing. It does not use editor articles, Search Console, or AI.

alter table public.client_pages
  add column if not exists word_count integer not null default 0
    check (word_count between 0 and 10000000),
  add column if not exists response_content_type text
    check (response_content_type is null or char_length(response_content_type) <= 300),
  add column if not exists redirect_count smallint not null default 0
    check (redirect_count between 0 and 10),
  add column if not exists last_crawl_duration_ms integer
    check (last_crawl_duration_ms is null or last_crawl_duration_ms between 0 and 600000),
  add column if not exists crawl_generation integer not null default 0
    check (crawl_generation >= 0);

create or replace function public.claim_next_client_page_crawl_job(
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns setof public.client_page_crawl_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.client_page_crawl_jobs%rowtype;
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 300), 1800));
begin
  if nullif(btrim(p_worker_id), '') is null then
    raise exception 'A crawl worker id is required.';
  end if;

  select job.*
  into v_job
  from public.client_page_crawl_jobs as job
  join public.client_pages as page
    on page.id = job.page_id
   and page.client_id = job.client_id
  join public.clients as client
    on client.id = job.client_id
  where job.status in ('queued', 'retry_scheduled')
    and job.next_attempt_at <= now()
    and page.is_enabled = true
    and client.is_active = true
  order by job.priority desc, job.next_attempt_at, job.created_at
  for update of job skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.client_page_crawl_jobs
  set status = 'running',
      attempt_count = attempt_count + 1,
      locked_by = btrim(p_worker_id),
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      started_at = coalesce(started_at, now()),
      finished_at = null,
      error_code = null,
      error_message = null,
      updated_at = now()
  where id = v_job.id
  returning * into v_job;

  update public.client_pages
  set crawl_status = 'crawling',
      last_error_code = null,
      last_error_message = null,
      updated_at = now()
  where id = v_job.page_id;

  return next v_job;
end;
$$;

create or replace function public.heartbeat_client_page_crawl_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owned boolean := false;
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 300), 1800));
begin
  update public.client_page_crawl_jobs
  set lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      updated_at = now()
  where id = p_job_id
    and status = 'running'
    and locked_by = p_worker_id
  returning true into v_owned;

  return jsonb_build_object('owned', coalesce(v_owned, false));
end;
$$;

create or replace function public.complete_client_page_crawl_job(
  p_job_id uuid,
  p_worker_id text,
  p_page jsonb,
  p_result_summary jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.client_page_crawl_jobs%rowtype;
  v_status public.client_page_status;
begin
  select *
  into v_job
  from public.client_page_crawl_jobs
  where id = p_job_id
    and status = 'running'
    and locked_by = p_worker_id
  for update;

  if not found then
    return false;
  end if;

  v_status := case
    when coalesce(nullif(p_page ->> 'httpStatus', '')::integer, 500) < 200
      or coalesce(nullif(p_page ->> 'httpStatus', '')::integer, 500) >= 400
      then 'needs_review'::public.client_page_status
    when coalesce((p_page ->> 'robotsIndex')::boolean, true) = false then 'noindex'::public.client_page_status
    else 'ready'::public.client_page_status
  end;

  update public.client_pages
  set final_url = nullif(p_page ->> 'finalUrl', ''),
      canonical_url = nullif(p_page ->> 'canonicalUrl', ''),
      crawl_status = v_status,
      http_status = nullif(p_page ->> 'httpStatus', '')::smallint,
      page_title = nullif(p_page ->> 'pageTitle', ''),
      meta_description = nullif(p_page ->> 'metaDescription', ''),
      h1 = nullif(p_page ->> 'h1', ''),
      h2 = case when jsonb_typeof(p_page -> 'h2') = 'array' then p_page -> 'h2' else '[]'::jsonb end,
      h3 = case when jsonb_typeof(p_page -> 'h3') = 'array' then p_page -> 'h3' else '[]'::jsonb end,
      slug = nullif(p_page ->> 'slug', ''),
      page_language = nullif(p_page ->> 'pageLanguage', ''),
      robots_index = case when p_page ? 'robotsIndex' then (p_page ->> 'robotsIndex')::boolean else null end,
      robots_follow = case when p_page ? 'robotsFollow' then (p_page ->> 'robotsFollow')::boolean else null end,
      content_hash = nullif(p_page ->> 'contentHash', ''),
      extracted_terms = case when jsonb_typeof(p_page -> 'extractedTerms') = 'array' then p_page -> 'extractedTerms' else '[]'::jsonb end,
      extracted_phrases = case when jsonb_typeof(p_page -> 'extractedPhrases') = 'array' then p_page -> 'extractedPhrases' else '[]'::jsonb end,
      word_count = greatest(0, coalesce(nullif(p_page ->> 'wordCount', '')::integer, 0)),
      response_content_type = nullif(p_page ->> 'responseContentType', ''),
      redirect_count = greatest(0, least(coalesce(nullif(p_page ->> 'redirectCount', '')::smallint, 0), 10)),
      last_crawl_duration_ms = greatest(0, coalesce(nullif(p_page ->> 'crawlDurationMs', '')::integer, 0)),
      crawl_generation = crawl_generation + 1,
      last_crawled_at = now(),
      last_success_at = now(),
      last_error_code = null,
      last_error_message = null,
      updated_at = now()
  where id = v_job.page_id
    and client_id = v_job.client_id;

  update public.client_page_crawl_jobs
  set status = 'completed',
      result_summary = coalesce(p_result_summary, '{}'::jsonb),
      locked_by = null,
      lease_expires_at = null,
      finished_at = now(),
      error_code = null,
      error_message = null,
      updated_at = now()
  where id = v_job.id;

  return true;
end;
$$;

create or replace function public.fail_client_page_crawl_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_retryable boolean default true,
  p_retry_delay_seconds integer default 60
)
returns public.client_page_crawl_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.client_page_crawl_jobs%rowtype;
  v_retry boolean := false;
begin
  select *
  into v_job
  from public.client_page_crawl_jobs
  where id = p_job_id
    and status = 'running'
    and locked_by = p_worker_id
  for update;

  if not found then
    raise exception 'The crawl job is no longer owned by this worker.';
  end if;

  v_retry := coalesce(p_retryable, true) and v_job.attempt_count < v_job.max_attempts;

  update public.client_page_crawl_jobs
  set status = case
        when v_retry then 'retry_scheduled'::public.client_crawl_job_status
        else 'failed'::public.client_crawl_job_status
      end,
      next_attempt_at = case
        when v_retry then now() + make_interval(secs => greatest(15, least(coalesce(p_retry_delay_seconds, 60), 86400)))
        else next_attempt_at
      end,
      locked_by = null,
      lease_expires_at = null,
      finished_at = case when v_retry then null else now() end,
      error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'client_page_crawl_failed'), 120),
      error_message = left(coalesce(nullif(btrim(p_error_message), ''), 'Client page crawl failed.'), 2000),
      updated_at = now()
  where id = v_job.id
  returning * into v_job;

  update public.client_pages
  set crawl_status = case
        when v_retry then 'pending'::public.client_page_status
        else 'failed'::public.client_page_status
      end,
      last_crawled_at = now(),
      last_error_code = v_job.error_code,
      last_error_message = v_job.error_message,
      updated_at = now()
  where id = v_job.page_id;

  return v_job;
end;
$$;

create or replace function public.recover_stale_client_page_crawl_jobs(
  p_retry_delay_seconds integer default 60
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.client_page_crawl_jobs%rowtype;
  v_count integer := 0;
  v_retry boolean;
begin
  for v_job in
    select *
    from public.client_page_crawl_jobs
    where status = 'running'
      and lease_expires_at is not null
      and lease_expires_at < now()
    for update skip locked
  loop
    v_retry := v_job.attempt_count < v_job.max_attempts;

    update public.client_page_crawl_jobs
    set status = case
          when v_retry then 'retry_scheduled'::public.client_crawl_job_status
          else 'failed'::public.client_crawl_job_status
        end,
        next_attempt_at = case
          when v_retry then now() + make_interval(secs => greatest(15, least(coalesce(p_retry_delay_seconds, 60), 86400)))
          else next_attempt_at
        end,
        locked_by = null,
        lease_expires_at = null,
        finished_at = case when v_retry then null else now() end,
        error_code = 'client_page_crawl_lease_expired',
        error_message = 'The crawl worker lease expired before the page was completed.',
        updated_at = now()
    where id = v_job.id;

    update public.client_pages
    set crawl_status = case
          when v_retry then 'pending'::public.client_page_status
          else 'failed'::public.client_page_status
        end,
        last_error_code = 'client_page_crawl_lease_expired',
        last_error_message = 'The crawl worker lease expired before the page was completed.',
        updated_at = now()
    where id = v_job.page_id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.claim_next_client_page_crawl_job(text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_client_page_crawl_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.complete_client_page_crawl_job(uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_client_page_crawl_job(uuid, text, text, text, boolean, integer) from public, anon, authenticated;
revoke all on function public.recover_stale_client_page_crawl_jobs(integer) from public, anon, authenticated;

grant execute on function public.claim_next_client_page_crawl_job(text, integer) to service_role;
grant execute on function public.heartbeat_client_page_crawl_job(uuid, text, integer) to service_role;
grant execute on function public.complete_client_page_crawl_job(uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_client_page_crawl_job(uuid, text, text, text, boolean, integer) to service_role;
grant execute on function public.recover_stale_client_page_crawl_jobs(integer) to service_role;

comment on function public.claim_next_client_page_crawl_job(text, integer) is
  'Atomically claims one Client Center page crawl job using SKIP LOCKED.';
comment on function public.complete_client_page_crawl_job(uuid, text, jsonb, jsonb) is
  'Persists deterministic HTML metadata extraction and completes an owned crawl job.';
comment on function public.recover_stale_client_page_crawl_jobs(integer) is
  'Recovers Client Center crawl jobs whose worker lease expired.';
