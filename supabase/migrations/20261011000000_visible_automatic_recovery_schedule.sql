begin;

-- Expose the same bounded recovery timetable used by the single automation
-- master.  The dashboard consumes this permission-aware summary so it can
-- show an exact next eligible time instead of only saying recovery is enabled.
create or replace function public.get_visible_automatic_recovery_schedule(
  p_requested_by uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with visible_articles as (
    select article.id
    from public.articles as article
    where article.status = 'draft'
      and public.article_access_level_for_user(article.id, p_requested_by) <> 'none'
  ), external_candidates as (
    select
      job.id,
      'external_analysis'::text as recovery_kind,
      coalesce(job.completed_at, job.updated_at) + case recovery.value
        when 0 then interval '1 hour'
        when 1 then interval '6 hours'
        else interval '24 hours'
      end as eligible_at
    from public.ai_external_analysis_jobs as job
    join visible_articles as article on article.id = job.article_id
    cross join lateral (
      select case
        when coalesce(job.progress->>'automaticRecoveryCount', '') ~ '^\d+$'
          then greatest(0, (job.progress->>'automaticRecoveryCount')::integer)
        else 0
      end as value
    ) as recovery
    left join lateral (
      select run.error_code, run.error_message
      from public.ai_external_analysis_runs as run
      where run.job_id = job.id
      order by run.run_number desc
      limit 1
    ) as latest_run on true
    where job.origin = 'auto'
      and job.status in ('failed', 'blocked')
      and job.cancel_requested_at is null
      and job.job_type <> 'full_article_pipeline'
      and recovery.value < 3
      and public.automation_failure_is_retryable(
        coalesce(latest_run.error_code, job.last_error_code),
        coalesce(latest_run.error_message, job.last_error)
      )
      and public.article_automatic_job_allowed(job.article_id, job.job_type, job.command_id)
      and not exists (
        select 1
        from public.ai_external_analysis_jobs as active
        where active.article_id = job.article_id
          and active.job_type = job.job_type
          and active.id <> job.id
          and active.status in (
            'waiting_for_prerequisites', 'queued', 'running',
            'retry_scheduled', 'paused'
          )
      )
  ), writing_candidates as (
    select
      item.id,
      'content_writing'::text as recovery_kind,
      item.next_recovery_at as eligible_at
    from public.content_writing_automation_items as item
    join visible_articles as article on article.id = item.article_id
    where item.status = 'blocked'
      and item.failure_class = 'transient'
      and item.recovery_count < 3
      and item.next_recovery_at is not null
      and public.automation_failure_is_retryable(item.last_error_code, item.last_error)
      and public.article_automatic_job_allowed(item.article_id, 'content_writing')
  ), candidates as (
    select id, recovery_kind, eligible_at from external_candidates
    union all
    select id, recovery_kind, eligible_at from writing_candidates
  ), summary as (
    select
      count(*)::integer as pending_count,
      count(*) filter (where eligible_at <= now())::integer as due_count,
      min(eligible_at) as next_recovery_at
    from candidates
  )
  select jsonb_build_object(
    'available', true,
    'enabled', true,
    'checkIntervalSeconds', 60,
    'pendingCount', summary.pending_count,
    'dueCount', summary.due_count,
    'nextRecoveryAt', summary.next_recovery_at
  )
  from summary;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 10;
$$;

revoke all on function public.get_visible_automatic_recovery_schedule(uuid)
  from public, anon, authenticated;
grant execute on function public.get_visible_automatic_recovery_schedule(uuid)
  to service_role;

comment on function public.get_visible_automatic_recovery_schedule(uuid) is
  'Returns the access-scoped count, due count and earliest exact eligibility time for bounded automatic recovery; the single master checks it every 60 seconds.';

notify pgrst, 'reload schema';

commit;
