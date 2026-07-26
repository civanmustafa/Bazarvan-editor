-- Article text is a hard prerequisite for every external engineering command.
-- Keep this rule at the database boundary so automatic state triggers, manual
-- API requests, and workers cannot create or keep a bundle for an empty article.

create or replace function public.evaluate_external_analysis_readiness(
  p_status text,
  p_title text,
  p_plain_text text,
  p_keywords jsonb,
  p_goal_context jsonb,
  p_metadata jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_has_supported_status boolean := public.article_status_supports_external_analysis(p_status);
  v_signature_status text := case
    when public.article_status_supports_external_analysis(p_status) then 'draft'
    else coalesce(p_status, '')
  end;
  v_has_title boolean := nullif(btrim(coalesce(p_title, '')), '') is not null
    and lower(btrim(coalesce(p_title, ''))) not in ('(untitled)', 'untitled');
  v_has_editor_text boolean := nullif(btrim(coalesce(p_plain_text, '')), '') is not null;
  v_has_primary_keyword boolean := nullif(btrim(coalesce(p_keywords->>'primary', '')), '') is not null;
  v_has_company boolean := nullif(btrim(coalesce(p_keywords->>'company', '')), '') is not null;
  v_has_goal_context boolean := nullif(btrim(coalesce(p_goal_context->>'pageType', '')), '') is not null
    and nullif(btrim(coalesce(p_goal_context->>'objective', '')), '') is not null;
  v_competitors jsonb := coalesce(p_metadata->'attachments'->'competitors', '{}'::jsonb);
  v_has_competitor boolean;
  v_semantic_missing jsonb := '[]'::jsonb;
  v_external_missing jsonb := '[]'::jsonb;
  v_semantic_signature text;
  v_external_signature text;
begin
  v_has_competitor := public.external_analysis_has_competitor_value(v_competitors->'texts', 5)
    or public.external_analysis_has_competitor_value(v_competitors->'urls', 5);

  if not v_has_supported_status then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('draft_status');
    v_external_missing := v_external_missing || jsonb_build_array('draft_status');
  end if;
  if not v_has_title then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('article_title');
    v_external_missing := v_external_missing || jsonb_build_array('article_title');
  end if;
  if not v_has_editor_text then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('editor_text');
    v_external_missing := v_external_missing || jsonb_build_array('editor_text');
  end if;
  if not v_has_primary_keyword then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('primary_keyword');
    v_external_missing := v_external_missing || jsonb_build_array('primary_keyword');
  end if;
  if not v_has_goal_context then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('goal_context');
    v_external_missing := v_external_missing || jsonb_build_array('goal_context');
  end if;
  if not v_has_company then
    v_semantic_missing := v_semantic_missing || jsonb_build_array('company_name');
    v_external_missing := v_external_missing || jsonb_build_array('company_name');
  end if;
  if not v_has_competitor then
    v_external_missing := v_external_missing || jsonb_build_array('competitor_content_or_url');
  end if;

  v_semantic_signature := md5(jsonb_build_object(
    'status', v_signature_status,
    'title', coalesce(p_title, ''),
    'plainText', coalesce(p_plain_text, ''),
    'primaryKeyword', coalesce(p_keywords->>'primary', ''),
    'companyName', coalesce(p_keywords->>'company', ''),
    'goalContext', coalesce(p_goal_context, '{}'::jsonb)
  )::text);
  v_external_signature := md5(jsonb_build_object(
    'status', v_signature_status,
    'title', coalesce(p_title, ''),
    'primaryKeyword', coalesce(p_keywords->>'primary', ''),
    'companyName', coalesce(p_keywords->>'company', ''),
    'goalContext', coalesce(p_goal_context, '{}'::jsonb),
    'competitorUrls', coalesce(v_competitors->'urls', '[]'::jsonb),
    'competitorTexts', coalesce(v_competitors->'texts', '[]'::jsonb)
  )::text);

  return jsonb_build_object(
    'semantic', jsonb_build_object(
      'ready', jsonb_array_length(v_semantic_missing) = 0,
      'missingFields', v_semantic_missing,
      'signature', v_semantic_signature
    ),
    'externalAnalysis', jsonb_build_object(
      'ready', jsonb_array_length(v_external_missing) = 0,
      'missingFields', v_external_missing,
      'signature', v_external_signature
    )
  );
end;
$$;

create or replace function public.cancel_stale_external_engineering_jobs(
  p_article_id uuid,
  p_current_signature text default null,
  p_cancel_all boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cancelled_count integer := 0;
  v_article_text_missing boolean := false;
  v_error_code text;
  v_error_message text;
begin
  select nullif(btrim(coalesce(article.plain_text, '')), '') is null
  into v_article_text_missing
  from public.articles as article
  where article.id = p_article_id;

  v_error_code := case
    when coalesce(v_article_text_missing, true) then 'engineering_article_text_missing'
    else 'external_readiness_changed'
  end;
  v_error_message := case
    when coalesce(v_article_text_missing, true)
      then 'The engineering command bundle was cancelled because the article text is empty.'
    else 'The external analysis inputs changed before this command completed.'
  end;

  with cancelled as (
    update public.ai_external_analysis_jobs as job
    set
      status = 'cancelled',
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      next_attempt_at = null,
      last_error_code = v_error_code,
      last_error = v_error_message,
      completed_at = now(),
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'cancelled',
        'reason', v_error_code,
        'updatedAt', now()
      ),
      updated_at = now()
    where job.article_id = p_article_id
      and job.job_type = 'engineering_command'
      and job.origin = 'auto'
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      and (
        coalesce(p_cancel_all, false)
        or job.readiness_signature is distinct from nullif(coalesce(p_current_signature, ''), '')
      )
    returning job.id
  ), closed_runs as (
    update public.ai_external_analysis_runs as run
    set
      status = 'cancelled',
      error_code = v_error_code,
      error_message = v_error_message,
      finished_at = now()
    from cancelled
    where run.job_id = cancelled.id
      and run.status = 'running'
    returning run.id
  )
  select count(*)::integer
  into v_cancelled_count
  from cancelled;

  return coalesce(v_cancelled_count, 0);
end;
$$;

create or replace function public.enqueue_external_engineering_jobs(
  p_article_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_ids uuid[] := array[]::uuid[];
  v_batch_key text;
  v_has_article_text boolean := false;
begin
  select nullif(btrim(coalesce(article.plain_text, '')), '') is not null
  into v_has_article_text
  from public.articles as article
  where article.id = p_article_id;

  if not coalesce(v_has_article_text, false) then
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
    return v_job_ids;
  end if;

  v_job_ids := public.enqueue_external_engineering_jobs_sequential_base(p_article_id);

  for v_batch_key in
    select distinct job.batch_key
    from public.ai_external_analysis_jobs as job
    where job.id = any(v_job_ids)
      and job.batch_key is not null
      and job.status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused')
  loop
    perform public.apply_external_analysis_execution_mode_to_batch(v_batch_key);
  end loop;

  return v_job_ids;
end;
$$;

-- Repair existing article states without touching ready articles. Updating only
-- empty articles prevents a migration from re-enqueuing valid historical bundles.
update public.ai_external_analysis_article_state as state
set
  external_analysis_ready = false,
  external_analysis_missing_fields = case
    when coalesce(state.external_analysis_missing_fields, '[]'::jsonb)
      @> '["editor_text"]'::jsonb
      then coalesce(state.external_analysis_missing_fields, '[]'::jsonb)
    else coalesce(state.external_analysis_missing_fields, '[]'::jsonb)
      || jsonb_build_array('editor_text')
  end,
  last_evaluated_at = now(),
  updated_at = now()
from public.articles as article
where article.id = state.article_id
  and nullif(btrim(coalesce(article.plain_text, '')), '') is null
  and (
    state.external_analysis_ready
    or not (
      coalesce(state.external_analysis_missing_fields, '[]'::jsonb)
        @> '["editor_text"]'::jsonb
    )
  );

revoke all on function public.cancel_stale_external_engineering_jobs(uuid, text, boolean) from public;
revoke all on function public.enqueue_external_engineering_jobs(uuid) from public;
grant execute on function public.cancel_stale_external_engineering_jobs(uuid, text, boolean) to service_role;
grant execute on function public.enqueue_external_engineering_jobs(uuid) to service_role;

comment on function public.evaluate_external_analysis_readiness(text, text, text, jsonb, jsonb, jsonb)
is 'Requires persisted article text for both semantic generation and external engineering commands.';

comment on function public.enqueue_external_engineering_jobs(uuid)
is 'Queues the configured engineering chain only when the persisted article text is non-empty.';
