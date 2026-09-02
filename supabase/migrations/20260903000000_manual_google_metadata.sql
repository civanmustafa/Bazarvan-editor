-- Use the existing durable semantic task, but scope this manual request to
-- Google suggestions. The transaction/locks prevent a worker claiming the
-- shared task before its targets have been narrowed.
create or replace function public.enqueue_manual_google_metadata_job(p_article_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'external-analysis-auto-once:' || p_article_id::text || ':semantic_keywords_lsi', 0
  ));

  -- Never retarget an active shared task, including a task waiting to retry.
  perform job.id from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id and job.job_type = 'semantic_keywords_lsi'
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by job.id for update;
  if exists (
    select 1 from public.ai_external_analysis_jobs as job
    where job.article_id = p_article_id and job.job_type = 'semantic_keywords_lsi'
      and job.last_error_code is distinct from 'duplicate_task_suppressed'
      and job.status in ('running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused')
  ) then
    raise exception 'semantic_already_active' using errcode = 'P0001';
  end if;

  v_job_id := public.enqueue_external_semantic_analysis_job_controlled(p_article_id, 'manual_regenerate');
  if v_job_id is null then return null; end if;
  update public.ai_external_analysis_jobs
  set input_snapshot = input_snapshot || jsonb_build_object(
        'needsSecondaries', false, 'needsLsi', false, 'needsGoogleMetadata', true,
        'manualTarget', 'google_metadata',
        'automaticOnceTargets', jsonb_build_object('secondaries', false, 'lsi', false, 'googleMetadata', true)
      ),
      progress = progress || jsonb_build_object(
        'needsSecondaries', false, 'needsLsi', false, 'needsGoogleMetadata', true
      )
  where id = v_job_id and status = 'queued';
  return v_job_id;
end;
$$;

revoke all on function public.enqueue_manual_google_metadata_job(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_manual_google_metadata_job(uuid) to service_role;

-- Return compact completion evidence, not article bodies. Both article and
-- session/action RLS apply; this function never elevates the caller's access.
create or replace function public.dashboard_saved_automation_results(p_article_ids uuid[])
returns table(article_id uuid, internal_link_count bigint, writing_session_id uuid, writing_completed_at timestamptz)
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select article.id,
    (select count(distinct action.target_url)
     from public.internal_link_actions as action
     where action.article_id = article.id and action.action = 'applied'
       and jsonb_path_exists(coalesce(article.content_json, '{}'::jsonb),
         '$.** ? (@.type == "link" && @.attrs.href == $url)',
         jsonb_build_object('url', action.target_url))),
    writing.id, writing.completed_at
  from public.articles as article
  left join lateral (
    select session.id, session.completed_at
    from public.content_writing_sessions as session
    where session.article_id = article.id and session.status = 'completed'
      and nullif(btrim(session.result_text), '') is not null
    order by session.completed_at desc nulls last limit 1
  ) as writing on true
  where article.id = any(p_article_ids[1:100]);
$$;
revoke all on function public.dashboard_saved_automation_results(uuid[]) from public, anon;
grant execute on function public.dashboard_saved_automation_results(uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';
