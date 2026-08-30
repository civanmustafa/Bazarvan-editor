begin;

-- The unified semantic release added Google titles/descriptions as a new target
-- without changing the persisted article-readiness rows. Existing ready rows
-- therefore did not fire their state triggers and stayed idle until a later
-- article UPDATE (for example, the editor's first save after opening it).
--
-- It also left the settings reconciler aware of only the two keyword lists.
-- Once those lists existed, changing an automation setting could cancel an
-- active Google-metadata-only run as if no semantic target remained. Keep the
-- unified target in that cancellation decision before backfilling ready rows.
create or replace function public.reconcile_content_research_automation()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := public.get_content_research_automation_settings();
  v_auto_secondaries boolean := coalesce(
    (v_settings->>'autoGenerateAlternativeKeywords')::boolean,
    true
  );
  v_auto_lsi boolean := coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true);
  v_auto_competitors boolean := coalesce((v_settings->>'autoDiscoverCompetitors')::boolean, true);
  v_article_id uuid;
begin
  -- Stop automatic competitor work that is no longer allowed or whose enabled
  -- precursor lists are not ready. Running workers receive a cancellation flag;
  -- queued work becomes terminal immediately and can be reused later.
  update public.ai_external_analysis_jobs as job
  set
    status = case when job.status = 'running' then 'running' else 'cancelled' end,
    cancel_requested_at = coalesce(job.cancel_requested_at, now()),
    next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
    locked_by = case when job.status = 'running' then job.locked_by else null end,
    locked_at = case when job.status = 'running' then job.locked_at else null end,
    lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
    completed_at = case when job.status = 'running' then job.completed_at else coalesce(job.completed_at, now()) end,
    last_error_code = 'content_research_automation_changed',
    last_error = 'Automatic competitor discovery was disabled or is waiting for enabled keyword stages.',
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', case when job.status = 'running' then 'cancellation_requested' else 'cancelled' end,
      'reason', 'content_research_automation_changed',
      'updatedAt', now()
    ),
    updated_at = now()
  from public.articles as article
  where article.id = job.article_id
    and job.origin = 'auto'
    and job.job_type in ('competitor_discovery', 'competitor_extraction')
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    )
    and (
      not v_auto_competitors
      or (
        v_auto_secondaries
        and not public.external_analysis_has_competitor_value(
          article.keywords->'secondaries',
          100
        )
      )
      or (
        v_auto_lsi
        and not public.external_analysis_has_competitor_value(article.keywords->'lsi', 100)
      )
    );

  if not v_auto_competitors then
    update public.ai_external_analysis_jobs as job
    set
      status = case when job.status = 'running' then 'running' else 'cancelled' end,
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
      locked_by = case when job.status = 'running' then job.locked_by else null end,
      locked_at = case when job.status = 'running' then job.locked_at else null end,
      lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
      completed_at = case when job.status = 'running' then job.completed_at else coalesce(job.completed_at, now()) end,
      last_error_code = 'competitor_automation_disabled',
      last_error = 'Automatic competitor preparation was disabled.',
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.status = 'running' then 'cancellation_requested' else 'cancelled' end,
        'reason', 'competitor_automation_disabled',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.origin = 'auto'
      and job.job_type = 'content_writing_preparation'
      and job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      );
  end if;

  update public.ai_external_analysis_jobs as job
  set
    status = case when job.status = 'running' then 'running' else 'cancelled' end,
    cancel_requested_at = coalesce(job.cancel_requested_at, now()),
    next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
    locked_by = case when job.status = 'running' then job.locked_by else null end,
    locked_at = case when job.status = 'running' then job.locked_at else null end,
    lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
    completed_at = case when job.status = 'running' then job.completed_at else coalesce(job.completed_at, now()) end,
    last_error_code = 'semantic_automation_disabled',
    last_error = 'No enabled automatic semantic target remains for this article.',
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', case when job.status = 'running' then 'cancellation_requested' else 'cancelled' end,
      'reason', 'semantic_automation_disabled',
      'updatedAt', now()
    ),
    updated_at = now()
  from public.articles as article
  where article.id = job.article_id
    and job.origin = 'auto'
    and job.job_type = 'semantic_keywords_lsi'
    and job.pipeline_parent_job_id is null
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
    )
    and not (
      (
        v_auto_secondaries
        and not public.external_analysis_has_competitor_value(
          article.keywords->'secondaries',
          100
        )
      )
      or (
        v_auto_lsi
        and not public.external_analysis_has_competitor_value(article.keywords->'lsi', 100)
      )
      or (
        (v_auto_secondaries or v_auto_lsi)
        and not public.semantic_keywords_have_google_metadata(
          coalesce(article.keywords, '{}'::jsonb)
        )
      )
    );

  if v_auto_secondaries or v_auto_lsi then
    for v_article_id in
      select state.article_id
      from public.ai_external_analysis_article_state as state
      where state.semantic_ready
      order by state.article_id
    loop
      perform public.enqueue_external_semantic_analysis_job_controlled(
        v_article_id,
        'auto'
      );
    end loop;
  end if;

  if v_auto_competitors then
    for v_article_id in
      select state.article_id
      from public.ai_external_analysis_article_state as state
      where state.competitor_discovery_ready
      order by state.article_id
    loop
      perform public.enqueue_competitor_discovery_job_controlled(
        v_article_id,
        null,
        'auto'
      );
    end loop;
  end if;
end;
$$;

revoke all on function public.reconcile_content_research_automation()
  from public, anon, authenticated;
grant execute on function public.reconcile_content_research_automation()
  to service_role;

comment on function public.reconcile_content_research_automation()
  is 'Reconciles enabled keyword, Google metadata, and competitor automation for all ready articles.';

-- Run the server-owned reconcilers once at deployment so every already-ready
-- article is evaluated immediately. Both coordinators are idempotent and use
-- their existing per-article/lifetime guards, so this cannot duplicate a
-- started semantic target or an engineering command.
select public.reconcile_content_research_automation();
select public.reconcile_ready_engineering_command_automation();

commit;
