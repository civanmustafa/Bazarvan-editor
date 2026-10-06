begin;

-- Match the external-analysis claimer's job-type/status predicates and its due
-- ordering. The older status-only index remains useful for general reporting.
create index if not exists ai_external_analysis_jobs_worker_claim_idx
  on public.ai_external_analysis_jobs (
    job_type,
    status,
    (coalesce(next_attempt_at, created_at)),
    article_id,
    sequence_number,
    created_at,
    id
  )
  where status in ('queued', 'retry_scheduled')
    and cancel_requested_at is null
    and dead_lettered_at is null;

create index if not exists ai_external_analysis_jobs_worker_lease_idx
  on public.ai_external_analysis_jobs (job_type, lease_expires_at, article_id, id)
  where status = 'running'
    and cancel_requested_at is null
    and dead_lettered_at is null;

-- The automatic writing claimer scans only draft/preparation articles and then
-- orders by their last change. Avoid walking unrelated published/trashed rows.
create index if not exists articles_automatic_writing_candidates_idx
  on public.articles (updated_at, created_at, id)
  where status in ('content_preparation', 'draft');

-- Support both the ready-item lookup and expired reservation recovery. Existing
-- session and step indexes already match their current claim/read paths.
create index if not exists content_writing_automation_items_active_claim_idx
  on public.content_writing_automation_items (
    status,
    (coalesce(lease_expires_at, locked_at, updated_at)),
    eligible_at,
    ready_at,
    article_id
  )
  where status in ('ready', 'claiming', 'writing');

comment on index public.ai_external_analysis_jobs_worker_claim_idx is
  'Partial covering index for the durable external-analysis worker claim path.';
comment on index public.ai_external_analysis_jobs_worker_lease_idx is
  'Partial index for active external-analysis lease checks and recovery.';
comment on index public.articles_automatic_writing_candidates_idx is
  'Partial index for automatic content-writing candidate discovery.';
comment on index public.content_writing_automation_items_active_claim_idx is
  'Partial index for automatic-writing claims and expired reservation recovery.';

-- Queue workers wake through the tiny worker_queue_signals table. Browser views
-- use visibility-aware polling, so publishing full queue/state rows only creates
-- duplicate WAL decoding and WebSocket traffic.
do $realtime$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  foreach v_table in array array[
    'ai_external_analysis_jobs',
    'ai_external_analysis_article_state',
    'article_competitors',
    'ai_jobs',
    'content_writing_sessions',
    'content_writing_steps',
    'content_writing_automation_items',
    'client_page_crawl_jobs'
  ] loop
    if exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      execute format(
        'alter publication supabase_realtime drop table %I.%I',
        'public',
        v_table
      );
    end if;
  end loop;
end;
$realtime$;

commit;
