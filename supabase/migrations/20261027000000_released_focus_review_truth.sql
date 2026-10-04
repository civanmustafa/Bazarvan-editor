begin;

-- Preserve the active-lane payload and add an explicit, separate review
-- payload for the last article released to manual attention. A released row
-- must never keep presenting its historical stage as the lane's current work.
alter function public.get_automatic_article_focus()
  rename to get_automatic_article_focus_v21;

revoke all on function public.get_automatic_article_focus_v21()
  from public, anon, authenticated;
grant execute on function public.get_automatic_article_focus_v21()
  to service_role;

create or replace function public.get_automatic_article_focus()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb := coalesce(public.get_automatic_article_focus_v21(), '{}'::jsonb);
  v_article_id uuid;
  v_last_article_id uuid;
  v_review_work jsonb := '{}'::jsonb;
  v_review_next_stage text;
begin
  begin
    v_article_id := nullif(v_payload->>'articleId', '')::uuid;
  exception when invalid_text_representation then
    v_article_id := null;
  end;

  begin
    v_last_article_id := nullif(v_payload->>'lastArticleId', '')::uuid;
  exception when invalid_text_representation then
    v_last_article_id := null;
  end;

  if v_article_id is not null then
    return v_payload || jsonb_build_object(
      'laneAvailable', false,
      'reviewArticleId', null,
      'reviewArticleTitle', '',
      'reviewWorkState', null,
      'reviewMissingPrerequisites', '[]'::jsonb,
      'reviewNextRequiredStage', null,
      'reviewStageScheduled', false,
      'reviewLastError', null,
      'reviewReleasedAt', null
    );
  end if;

  if v_last_article_id is not null then
    v_review_work := coalesce(
      public.article_automation_work_readiness(v_last_article_id),
      '{}'::jsonb
    );
    v_review_next_stage := nullif(v_review_work->>'nextRequiredStage', '');

    -- A missing company prevents discovery readiness. It must not make the
    -- card claim that competitor extraction is the next executable stage.
    if coalesce(v_review_work->'missingPrerequisites', '[]'::jsonb) ? 'company_name' then
      v_review_next_stage := 'competitor_discovery';
    end if;
  end if;

  return v_payload || jsonb_build_object(
    'laneAvailable', true,
    'currentStage', null,
    'acquiredAt', null,
    'nextRetryAt', null,
    'activeStageStatus', null,
    'activeStageStartedAt', null,
    'stageNextAttemptAt', null,
    'laneArticleReleased', v_last_article_id is not null,
    'reviewArticleId', v_last_article_id,
    'reviewArticleTitle', coalesce(v_payload->>'lastArticleTitle', ''),
    'reviewWorkState', nullif(v_review_work->>'state', ''),
    'reviewMissingPrerequisites', coalesce(
      v_review_work->'missingPrerequisites',
      '[]'::jsonb
    ),
    'reviewNextRequiredStage', v_review_next_stage,
    'reviewStageScheduled', coalesce(
      (v_review_work->>'stageScheduled')::boolean,
      false
    ),
    'reviewLastError', nullif(v_payload->>'lastError', ''),
    'reviewReleasedAt', nullif(v_payload->>'releasedAt', '')
  );
end;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 22;
$$;

revoke all on function public.get_automatic_article_focus()
  from public, anon, authenticated;
grant execute on function public.get_automatic_article_focus()
  to service_role;

comment on function public.get_automatic_article_focus() is
  'Separates the available lane from the last released review article and exposes that article''s current missing prerequisites.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 22 with truthful released-focus review data.';

notify pgrst, 'reload schema';

commit;
