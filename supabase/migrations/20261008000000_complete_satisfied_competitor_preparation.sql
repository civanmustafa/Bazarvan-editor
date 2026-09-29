begin;

-- A user can satisfy the competitor requirement while an automatic preparation
-- job is sleeping until its next retry. Complete that stale preparation in the
-- same transaction as the repository change so the activity feed never shows
-- preparation and writing as active at the same time.
create or replace function public.complete_ready_content_writing_preparations(
  p_article_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_readiness jsonb := '{}'::jsonb;
  v_usable_count integer := 0;
  v_required_count integer := 2;
  v_completed integer := 0;
begin
  if p_article_id is null then return 0; end if;

  v_readiness := public.evaluate_content_writing_automation_readiness(p_article_id);
  v_usable_count := greatest(
    0,
    coalesce((v_readiness->>'usableCompetitorCount')::integer, 0)
  );
  v_required_count := greatest(
    2,
    least(5, coalesce((v_readiness->>'minimumCompetitorCount')::integer, 2))
  );

  if v_usable_count < v_required_count then return 0; end if;

  update public.ai_external_analysis_jobs as job
  set status = 'completed',
      readiness_signature = coalesce(
        nullif(v_readiness->>'signature', ''),
        job.readiness_signature
      ),
      result = coalesce(job.result, '{}'::jsonb) || jsonb_build_object(
        'status', 'competitors_ready',
        'writingQueued', false,
        'usableCompetitorCount', v_usable_count,
        'requiredCompetitorCount', v_required_count,
        'completionReason', 'competitor_requirements_satisfied'
      ),
      progress = (coalesce(job.progress, '{}'::jsonb) - 'blockedBy' - 'focusPause')
        || jsonb_build_object(
          'stage', 'competitors_ready',
          'stageIndex', 3,
          'stageCount', 3,
          'usableCompetitorCount', v_usable_count,
          'requiredCompetitorCount', v_required_count,
          'completionReason', 'competitor_requirements_satisfied',
          'updatedAt', now()
        ),
      next_attempt_at = null,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      cancel_requested_at = null,
      last_error_code = null,
      last_error = null,
      dead_lettered_at = null,
      dead_letter_reason = null,
      completed_at = now(),
      updated_at = now()
  where job.article_id = p_article_id
    and job.job_type = 'content_writing_preparation'
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused');
  get diagnostics v_completed = row_count;
  return v_completed;
end;
$$;

create or replace function public.reconcile_content_writing_preparation_from_competitor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform public.complete_ready_content_writing_preparations(old.article_id);
    return old;
  end if;

  if tg_op = 'UPDATE' and old.article_id is distinct from new.article_id then
    perform public.complete_ready_content_writing_preparations(old.article_id);
  end if;
  perform public.complete_ready_content_writing_preparations(new.article_id);
  return new;
end;
$$;

drop trigger if exists reconcile_content_writing_preparation_from_competitor
  on public.article_competitors;
create trigger reconcile_content_writing_preparation_from_competitor
after insert or delete or update of article_id, status, content_text
on public.article_competitors
for each row execute function public.reconcile_content_writing_preparation_from_competitor();

-- Reconcile any sleeping jobs that became ready immediately before rollout.
do $$
declare v_article record;
begin
  for v_article in
    select distinct job.article_id
    from public.ai_external_analysis_jobs as job
    where job.job_type = 'content_writing_preparation'
      and job.origin = 'auto'
      and job.pipeline_parent_job_id is null
      and job.status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused')
  loop
    perform public.complete_ready_content_writing_preparations(v_article.article_id);
  end loop;
end;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 7;
$$;

revoke all on function public.complete_ready_content_writing_preparations(uuid)
  from public, anon, authenticated;
revoke all on function public.reconcile_content_writing_preparation_from_competitor()
  from public, anon, authenticated;
grant execute on function public.complete_ready_content_writing_preparations(uuid)
  to service_role;

comment on function public.complete_ready_content_writing_preparations(uuid) is
  'Completes stale non-running automatic competitor-preparation jobs as soon as the repository satisfies the configured competitor count.';

notify pgrst, 'reload schema';

commit;
