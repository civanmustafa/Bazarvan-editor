begin;

-- Competitor discovery is a deterministic crawler/search operation. The
-- worker no longer waits for Gemini-generated semantic fields, so the durable
-- scheduler must also revive rows that the former runtime guard parked behind
-- semantic_keywords before contacting Firecrawl.
create or replace function public.enqueue_competitor_discovery_job_by_signature(
  p_article_id uuid,
  p_requested_by uuid default null,
  p_origin text default 'auto'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_manual boolean := lower(btrim(coalesce(p_origin, 'auto'))) = 'manual';
  v_policy jsonb := public.article_automation_policy(p_article_id);
  v_current_signature text;
  v_job_id uuid;
begin
  if not v_manual
     and (
       not coalesce((v_policy->>'enabled')::boolean, false)
       or not coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
     ) then
    return null;
  end if;

  select nullif(state.competitor_discovery_signature, '')
  into v_current_signature
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id
    and state.competitor_discovery_ready;

  if v_current_signature is null then
    perform public.cancel_stale_competitor_discovery_jobs(p_article_id, null);
    return null;
  end if;

  perform public.cancel_stale_competitor_discovery_jobs(
    p_article_id,
    v_current_signature
  );

  -- This error was raised before any crawler request. Re-queue the canonical
  -- row without consuming an execution attempt. The master coordinator calls
  -- this wrapper periodically, so the repair is durable even if deployment
  -- overlaps an old worker process for a few seconds.
  if not v_manual then
    update public.ai_external_analysis_jobs as job
    set
      status = 'queued',
      next_attempt_at = now(),
      cancel_requested_at = null,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      started_at = null,
      completed_at = null,
      last_error_code = null,
      last_error = null,
      progress = ((((coalesce(job.progress, '{}'::jsonb)
        - 'blockedBy') - 'waitingPrerequisite') - 'focusPause') - 'reason')
        || jsonb_build_object(
          'stage', 'queued',
          'executionPath', 'programmatic_competitor_research',
          'providerClass', 'search_not_generative_ai',
          'independentFromSemanticGeneration', true,
          'semanticPrerequisiteReleasedAt', now(),
          'updatedAt', now()
        ),
      updated_at = now()
    where job.article_id = p_article_id
      and job.job_type = 'competitor_discovery'
      and job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and job.readiness_signature = v_current_signature
      and job.status = 'waiting_for_prerequisites'
      and job.result is null
      and job.last_error_code = 'content_research_automation_changed'
      and job.progress->>'blockedBy' = 'semantic_keywords';
  end if;

  v_job_id := public.enqueue_competitor_discovery_job(
    p_article_id,
    p_requested_by,
    case when v_manual then 'manual' else 'auto' end
  );

  if v_job_id is not null then
    update public.ai_external_analysis_jobs as job
    set
      requested_by = coalesce(p_requested_by, job.requested_by),
      origin = case when v_manual then 'manual' else 'auto' end,
      cancel_requested_at = null,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'executionPath', 'programmatic_competitor_research',
        'providerClass', 'search_not_generative_ai',
        'independentFromSemanticGeneration', true,
        'updatedAt', now()
      ),
      updated_at = now()
    where job.id = v_job_id;
  end if;

  return v_job_id;
end;
$$;

-- Repair all existing automatic rows that were deferred by the obsolete
-- worker guard. Rows waiting for any other reason are intentionally untouched.
update public.ai_external_analysis_jobs as job
set
  status = 'queued',
  next_attempt_at = now(),
  cancel_requested_at = null,
  locked_by = null,
  locked_at = null,
  lease_expires_at = null,
  started_at = null,
  completed_at = null,
  last_error_code = null,
  last_error = null,
  progress = ((((coalesce(job.progress, '{}'::jsonb)
    - 'blockedBy') - 'waitingPrerequisite') - 'focusPause') - 'reason')
    || jsonb_build_object(
      'stage', 'queued',
      'executionPath', 'programmatic_competitor_research',
      'providerClass', 'search_not_generative_ai',
      'independentFromSemanticGeneration', true,
      'semanticPrerequisiteReleasedAt', now(),
      'updatedAt', now()
    ),
  updated_at = now()
from public.ai_external_analysis_article_state as state
where state.article_id = job.article_id
  and state.competitor_discovery_ready
  and job.job_type = 'competitor_discovery'
  and job.origin = 'auto'
  and job.pipeline_parent_job_id is null
  and job.readiness_signature = state.competitor_discovery_signature
  and job.status = 'waiting_for_prerequisites'
  and job.result is null
  and job.last_error_code = 'content_research_automation_changed'
  and job.progress->>'blockedBy' = 'semantic_keywords'
  and public.article_automatic_policy_allows(
    job.article_id,
    'competitor_discovery'
  );

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$ select 24; $$;

revoke all on function public.enqueue_competitor_discovery_job_by_signature(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.enqueue_competitor_discovery_job_by_signature(uuid,uuid,text)
  to service_role;

comment on function public.enqueue_competitor_discovery_job_by_signature(uuid,uuid,text) is
  'Queues independent programmatic competitor discovery and durably revives rows parked by the obsolete semantic prerequisite guard.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 24 with independent competitor-discovery runtime recovery.';

notify pgrst, 'reload schema';

commit;
