begin;

-- A post-write pause is recoverable once a real, policy-allowed automatic job
-- has been scheduled and is waiting only for the article focus. Keeping the
-- pause in that state creates a circular block: the job needs the focus while
-- the focus remains released because the job was not schedulable in the past.
create or replace function public.release_recoverable_automatic_focus_stalls(
  p_limit integer default 10
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article_ids uuid[] := array[]::uuid[];
  v_released integer := 0;
begin
  select coalesce(array_agg(candidate.article_id), array[]::uuid[])
  into v_article_ids
  from (
    select pause.article_id
    from public.automatic_article_focus_pauses as pause
    join public.articles as article on article.id = pause.article_id
    left join public.ai_external_analysis_article_state as state
      on state.article_id = pause.article_id
    cross join lateral (
      select public.automatic_content_writing_requirement(pause.article_id) as value
    ) as requirement
    cross join lateral (
      select public.evaluate_content_writing_automation_readiness(pause.article_id) as value
    ) as readiness
    where pause.reason in (
      'focus_stalled',
      'post_write_prerequisite_unscheduled'
    )
      and article.status in ('draft', 'content_preparation')
      and not public.article_is_globally_trashed(article.id)
      and (
        exists (
          select 1
          from public.ai_external_analysis_jobs as job
          where job.article_id = article.id
            and job.origin = 'auto'
            and job.pipeline_parent_job_id is null
            and job.cancel_requested_at is null
            and job.status in (
              'waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused'
            )
            and (
              coalesce((job.progress->>'focusPause')::boolean, false)
              or job.progress->>'blockedBy' = 'automatic_article_focus'
            )
            and public.article_automatic_policy_allows(
              article.id, job.job_type, job.command_id
            )
        )
        or (
          pause.reason = 'focus_stalled'
          and (
            (
              public.article_automatic_policy_allows(article.id, 'duplicate_cleanup')
              and public.unified_duplicate_cleanup_auto_ready(article.id)
            )
            or (
              coalesce((requirement.value->>'required')::boolean, false)
              and (
                (
                  coalesce((readiness.value->>'ready')::boolean, false)
                  and public.article_automatic_policy_allows(article.id, 'content_writing')
                )
                or (
                  coalesce(state.semantic_ready, false)
                  and public.article_automatic_policy_allows(article.id, 'semantic_keywords_lsi')
                )
                or (
                  coalesce(state.competitor_discovery_ready, false)
                  and public.article_automatic_policy_allows(article.id, 'competitor_discovery')
                )
              )
            )
          )
        )
      )
    order by pause.paused_at, pause.article_id
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update of pause skip locked
  ) as candidate;

  if coalesce(array_length(v_article_ids, 1), 0) = 0 then
    return 0;
  end if;

  delete from public.automatic_article_focus_pauses as pause
  where pause.article_id = any(v_article_ids)
    and pause.reason in (
      'focus_stalled',
      'post_write_prerequisite_unscheduled'
    );
  get diagnostics v_released = row_count;

  update public.automatic_article_focus as focus
  set state = 'idle',
      current_stage = null,
      last_release_reason = 'recoverable_stall_released',
      released_at = now(),
      next_retry_at = null,
      last_error_code = null,
      last_error = null,
      last_progress_at = now(),
      updated_at = now()
  where focus.singleton is true
    and focus.article_id is null
    and focus.last_article_id = any(v_article_ids)
    and focus.state = 'needs_attention';

  if v_released > 0 then
    insert into public.worker_queue_signals(queue_name)
    values ('external_analysis'), ('content_writing')
    on conflict do nothing;
    perform public.reconcile_automatic_article_focus();
  end if;

  return v_released;
end;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$ select 25; $$;

revoke all on function public.release_recoverable_automatic_focus_stalls(integer)
  from public, anon, authenticated;
grant execute on function public.release_recoverable_automatic_focus_stalls(integer)
  to service_role;

comment on function public.release_recoverable_automatic_focus_stalls(integer) is
  'Releases temporary stalls and obsolete post-write prerequisite pauses only when current policy-allowed automatic work is provably waiting for the focus.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 25 with circular post-write focus recovery.';

-- Repair existing rows immediately; the single automation master continues
-- to call the same bounded function after deployment.
select public.release_recoverable_automatic_focus_stalls(50);

notify pgrst, 'reload schema';

commit;
