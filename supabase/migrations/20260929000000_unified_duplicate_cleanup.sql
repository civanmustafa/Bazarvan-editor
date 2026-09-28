begin;

create or replace function public.article_automatic_job_allowed(
  p_article_id uuid, p_job_type text, p_command_id text default null
) returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_policy jsonb := public.article_automation_policy(p_article_id);
begin
  if (v_policy->>'policyVersion')::integer = 0 then return true; end if;
  if not (v_policy->>'enabled')::boolean then return false; end if;
  return case p_job_type
    when 'duplicate_cleanup' then true
    when 'semantic_keywords_lsi' then (v_policy->>'autoGenerateAlternativeKeywords')::boolean
      or (v_policy->>'autoGenerateLsiKeywords')::boolean or (v_policy->>'autoGenerateGoogleMetadata')::boolean
    when 'competitor_discovery' then (v_policy->>'autoDiscoverCompetitors')::boolean
    when 'competitor_extraction' then (v_policy->>'autoExtractCompetitorContent')::boolean
    when 'engineering_command' then (v_policy->>'autoRunReadyEngineeringCommands')::boolean
      and (v_policy->'externalAnalysisCommandIds') ? p_command_id
    when 'content_writing_preparation' then (v_policy->>'contentWritingAutomationEnabled')::boolean
      and (v_policy->>'autoDiscoverCompetitors')::boolean and (v_policy->>'autoExtractCompetitorContent')::boolean
    when 'content_writing' then (v_policy->>'contentWritingAutomationEnabled')::boolean
    else false end;
end;
$$;

create or replace function public.enqueue_unified_duplicate_cleanup(
  p_article_id uuid, p_requested_by uuid, p_automatic boolean default false, p_request_id text default null
) returns setof public.ai_external_analysis_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_article public.articles%rowtype; v_job public.ai_external_analysis_jobs%rowtype; v_key text; v_requester uuid;
begin
  if coalesce(public.article_access_level_for_user(p_article_id, p_requested_by), 'none') not in ('write', 'admin') then
    raise exception 'Article write access required.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('duplicate-cleanup:' || p_article_id, 0));
  select * into v_article from public.articles where id = p_article_id;
  if v_article.id is null or v_article.deleted_at is not null or v_article.status in ('published', 'archived')
    or v_article.content_json->>'type' is distinct from 'doc' or length(btrim(coalesce(v_article.plain_text, ''))) < 20 then return; end if;
  if p_automatic and not public.article_automatic_job_allowed(p_article_id, 'duplicate_cleanup') then return; end if;
  v_requester := case when p_automatic then coalesce(v_article.automation_creator_id, v_article.created_by, p_requested_by) else p_requested_by end;
  if coalesce(public.article_access_level_for_user(p_article_id, v_requester), 'none') not in ('write', 'admin') then return; end if;
  v_key := 'unified-cleanup:' || p_article_id || ':' || case when p_automatic then
    md5(v_article.content_json::text || coalesce(v_article.keywords::text, '{}') || coalesce(v_article.article_language, 'ar') || coalesce(v_article.title, ''))
    else coalesce(nullif(p_request_id, ''), gen_random_uuid()::text) end;
  select * into v_job from public.ai_external_analysis_jobs
    where article_id = p_article_id and job_type = 'duplicate_cleanup'
      and (idempotency_key = v_key or status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
        or (p_automatic and input_snapshot->>'version' = '2'
          and coalesce(progress#>'{unified,document}', input_snapshot->'document') = v_article.content_json
          and input_snapshot->'keywords' = v_article.keywords
          and input_snapshot->>'language' = v_article.article_language
          and input_snapshot->>'title' = v_article.title))
    order by created_at desc limit 1;
  if found then return next v_job; return; end if;
  insert into public.ai_external_analysis_jobs(article_id, requested_by, job_type, origin, status,
    idempotency_key, input_snapshot, command_label, next_attempt_at)
  values (p_article_id, v_requester, 'duplicate_cleanup', case when p_automatic then 'auto' else 'manual' end, 'queued', v_key,
    jsonb_build_object('version', 2, 'category', 0, 'document', v_article.content_json,
      'keywords', v_article.keywords, 'language', v_article.article_language, 'title', v_article.title),
    'تنقية تلقائية لجميع العبارات العامة', case when p_automatic then now() + interval '30 seconds' else now() end)
  returning * into v_job;
  return next v_job;
end;
$$;

-- Keep the legacy manual path, but serialize it with the article-wide workflow.
create or replace function public.enqueue_duplicate_cleanup(
  p_article_id uuid, p_requested_by uuid, p_request_id text, p_input jsonb
) returns setof public.ai_external_analysis_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job public.ai_external_analysis_jobs;
begin
  if coalesce(public.article_access_level_for_user(p_article_id, p_requested_by), 'none') not in ('write', 'admin') then
    raise exception 'article write access required' using errcode = '42501';
  end if;
  if coalesce(p_input->>'version', '') <> '1' or coalesce(p_input->>'category', '') !~ '^[2-8]$'
    or nullif(p_request_id, '') is null then raise exception 'invalid cleanup input'; end if;
  perform pg_advisory_xact_lock(hashtextextended('duplicate-cleanup:' || p_article_id, 0));
  select * into v_job from public.ai_external_analysis_jobs
    where article_id = p_article_id and job_type = 'duplicate_cleanup'
      and (idempotency_key = 'duplicate-cleanup:' || p_request_id
        or ((input_snapshot->>'category' = p_input->>'category' or input_snapshot->>'version' = '2')
          and status in ('queued', 'running', 'retry_scheduled', 'paused')))
    order by created_at desc limit 1;
  if found then return next v_job; return; end if;
  insert into public.ai_external_analysis_jobs(article_id, requested_by, job_type, origin, status, idempotency_key, input_snapshot, command_label)
  values (p_article_id, p_requested_by, 'duplicate_cleanup', 'manual', 'queued', 'duplicate-cleanup:' || p_request_id,
    p_input, 'تنقية العبارات العامة (' || (p_input->>'category') || ')') returning * into v_job;
  return next v_job;
end;
$$;

create or replace function public.apply_unified_duplicate_cleanup(
  p_job_id uuid, p_worker_id text, p_lease_generation bigint,
  p_before jsonb, p_state jsonb, p_html text, p_text text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job public.ai_external_analysis_jobs%rowtype; v_article public.articles%rowtype; v_version integer;
begin
  select * into v_job from public.ai_external_analysis_jobs where id = p_job_id for update;
  if v_job.job_type is distinct from 'duplicate_cleanup' or v_job.input_snapshot->>'version' is distinct from '2'
    or v_job.status is distinct from 'running' or v_job.locked_by is distinct from p_worker_id
    or v_job.lease_generation is distinct from p_lease_generation or v_job.lease_expires_at is null
    or v_job.lease_expires_at <= now() or v_job.cancel_requested_at is not null then
    raise exception 'Cleanup execution fenced or cancelled.' using errcode = '55000';
  end if;
  if coalesce(public.article_access_level_for_user(v_job.article_id, v_job.requested_by), 'none') not in ('write', 'admin') then
    raise exception 'Article write access required.' using errcode = '42501';
  end if;
  if v_job.origin = 'auto' and not public.article_automatic_job_allowed(v_job.article_id, 'duplicate_cleanup') then
    raise exception 'Automatic cleanup disabled.' using errcode = '55000';
  end if;
  select * into v_article from public.articles where id = v_job.article_id for update;
  if v_article.deleted_at is not null or v_article.status in ('published', 'archived')
    or v_article.content_json is distinct from p_before
    or coalesce(v_job.progress#>'{unified,document}', v_job.input_snapshot->'document') is distinct from p_before
    or v_article.keywords is distinct from v_job.input_snapshot->'keywords'
    or v_article.article_language is distinct from v_job.input_snapshot->>'language'
    or v_article.title is distinct from v_job.input_snapshot->>'title' then
    raise exception 'Article changed during cleanup.' using errcode = '40001';
  end if;
  if p_state->>'version' is distinct from '2' or p_state#>>'{document,type}' is distinct from 'doc'
    or jsonb_typeof(p_state#>'{document,content}') is distinct from 'array' or nullif(btrim(p_text), '') is null then
    raise exception 'Invalid cleanup result.' using errcode = '22023';
  end if;
  select greatest(v_article.save_count, coalesce(max(version_number), 0)) + 1 into v_version
    from public.article_versions where article_id = v_article.id;
  insert into public.article_versions(article_id, version_number, created_by, title, content_json, content_html,
    plain_text, keywords, goal_context, analysis, stats, note)
  values (v_article.id, v_version, v_job.requested_by, v_article.title, v_article.content_json, v_article.content_html,
    v_article.plain_text, v_article.keywords, v_article.goal_context, v_article.analysis, v_article.stats, 'before-unified-duplicate-cleanup');
  perform set_config('app.duplicate_cleanup_mutation', 'true', true);
  update public.articles set content_json = p_state->'document', content_html = p_html, plain_text = p_text,
    analysis = null, stats = (coalesce(stats, '{}'::jsonb) - 'totalDuplicates') || jsonb_build_object(
      'wordCount', coalesce(array_length(regexp_split_to_array(btrim(p_text), '\s+'), 1), 0),
      'commonDuplicatesCount', (select coalesce(sum(value::integer), 0) from jsonb_each_text(p_state->'remaining'))),
    save_count = v_version + 1, last_saved_at = clock_timestamp(),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('duplicateCleanup', jsonb_build_object('jobId', p_job_id, 'appliedAt', clock_timestamp()))
    where id = v_article.id returning * into v_article;
  insert into public.article_versions(article_id, version_number, created_by, title, content_json, content_html,
    plain_text, keywords, goal_context, analysis, stats, note)
  values (v_article.id, v_version + 1, v_job.requested_by, v_article.title, v_article.content_json, v_article.content_html,
    v_article.plain_text, v_article.keywords, v_article.goal_context, null, v_article.stats, 'unified-duplicate-cleanup-apply');
  update public.ai_external_analysis_jobs set progress = coalesce(progress, '{}'::jsonb) || jsonb_build_object('unified', p_state),
    updated_at = clock_timestamp() where id = p_job_id;
  perform set_config('app.duplicate_cleanup_mutation', 'false', true);
  return jsonb_build_object('applied', true, 'savedAt', v_article.last_saved_at);
end;
$$;

create or replace function public.revert_unified_duplicate_cleanup(
  p_job_id uuid, p_requested_by uuid, p_scope text, p_document jsonb, p_html text, p_text text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job public.ai_external_analysis_jobs%rowtype; v_article public.articles%rowtype; v_state jsonb; v_target jsonb; v_round integer; v_version integer;
begin
  select * into v_job from public.ai_external_analysis_jobs where id = p_job_id for update;
  if v_job.job_type is distinct from 'duplicate_cleanup' or v_job.input_snapshot->>'version' is distinct from '2'
    or v_job.status not in ('completed', 'failed', 'blocked', 'cancelled') or p_scope not in ('round', 'all') then
    raise exception 'Stop cleanup before reverting it.' using errcode = '55000';
  end if;
  if coalesce(public.article_access_level_for_user(v_job.article_id, p_requested_by), 'none') not in ('write', 'admin') then
    raise exception 'Article write access required.' using errcode = '42501';
  end if;
  v_state := v_job.progress->'unified';
  if coalesce((v_state->>'appliedCount')::integer, 0) = 0 then raise exception 'No applied cleanup to revert.'; end if;
  v_round := jsonb_array_length(v_state->'rounds') - 1;
  while v_round > 0 and v_state#>array['rounds', v_round::text, 'document'] = v_state->'document' loop
    v_round := v_round - 1;
  end loop;
  v_target := case when p_scope = 'all' then v_job.input_snapshot->'document' else v_state#>array['rounds', v_round::text, 'document'] end;
  if p_document is distinct from v_target or nullif(btrim(p_text), '') is null then raise exception 'Invalid undo target.'; end if;
  select * into v_article from public.articles where id = v_job.article_id for update;
  if v_article.deleted_at is not null or v_article.content_json is distinct from v_state->'document' then
    raise exception 'Article changed after cleanup; cannot revert automatically.' using errcode = '40001';
  end if;
  select greatest(v_article.save_count, coalesce(max(version_number), 0)) + 1 into v_version
    from public.article_versions where article_id = v_article.id;
  perform set_config('app.duplicate_cleanup_mutation', 'true', true);
  update public.articles set content_json = p_document, content_html = p_html, plain_text = p_text,
    analysis = null, stats = (coalesce(stats, '{}'::jsonb) - 'commonDuplicatesCount' - 'totalDuplicates') || jsonb_build_object('wordCount', coalesce(array_length(regexp_split_to_array(btrim(p_text), '\s+'), 1), 0)),
    save_count = v_version, last_saved_at = clock_timestamp() where id = v_article.id returning * into v_article;
  insert into public.article_versions(article_id, version_number, created_by, title, content_json, content_html,
    plain_text, keywords, goal_context, analysis, stats, note)
  values (v_article.id, v_version, p_requested_by, v_article.title, p_document, p_html, p_text,
    v_article.keywords, v_article.goal_context, null, v_article.stats, 'unified-duplicate-cleanup-undo');
  v_state := v_state || jsonb_build_object('phase', 'reverted', 'document', p_document, 'remaining', '{}'::jsonb,
    'appliedCount', case when p_scope = 'all' then 0 else coalesce((v_state#>>array['rounds', v_round::text, 'appliedCount'])::integer, 0) end,
    'rounds', case when p_scope = 'all' then '[]'::jsonb else coalesce((select jsonb_agg(value order by ordinality)
      from jsonb_array_elements(v_state->'rounds') with ordinality where ordinality <= v_round), '[]'::jsonb) end,
    'steps', case when p_scope = 'all' then '[]'::jsonb else coalesce((select jsonb_agg(value)
      from jsonb_array_elements(v_state->'steps') where (value->>'round')::integer < v_round), '[]'::jsonb) end);
  update public.ai_external_analysis_jobs set progress = progress || jsonb_build_object('unified', v_state),
    result = coalesce(result, '{}'::jsonb) || jsonb_build_object('status', 'partial', 'unified', v_state), updated_at = clock_timestamp() where id = p_job_id;
  perform set_config('app.duplicate_cleanup_mutation', 'false', true);
  return jsonb_build_object('reverted', true);
end;
$$;

create or replace function public.schedule_unified_duplicate_cleanup()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid;
begin
  if current_setting('app.duplicate_cleanup_mutation', true) = 'true' then return new; end if;
  if tg_op = 'UPDATE' and new.content_json is not distinct from old.content_json
    and new.keywords is not distinct from old.keywords and new.article_language is not distinct from old.article_language
    and new.title is not distinct from old.title then return new; end if;
  v_actor := coalesce(new.automation_creator_id, new.created_by, new.owner_id);
  if v_actor is not null and coalesce(public.article_access_level_for_user(new.id, v_actor), 'none') in ('write', 'admin') then
    perform public.enqueue_unified_duplicate_cleanup(new.id, v_actor, true, null);
  end if;
  return new;
end;
$$;
create trigger schedule_unified_duplicate_cleanup after insert or update of content_json, keywords, article_language, title
  on public.articles for each row execute function public.schedule_unified_duplicate_cleanup();

-- A save made while a job was active must not leave the new revision unscheduled.
-- Do not touch active job rows from an article trigger: apply locks job then article.
create or replace function public.reschedule_changed_duplicate_cleanup()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.job_type = 'duplicate_cleanup'
    and new.status in ('completed', 'failed', 'blocked', 'cancelled')
    and old.status is distinct from new.status
    and coalesce(public.article_access_level_for_user(new.article_id, new.requested_by), 'none') in ('write', 'admin') then
    perform public.enqueue_unified_duplicate_cleanup(new.article_id, new.requested_by, true, null);
  end if;
  return new;
end;
$$;
create trigger reschedule_changed_duplicate_cleanup after update of status on public.ai_external_analysis_jobs
  for each row execute function public.reschedule_changed_duplicate_cleanup();

revoke all on function public.enqueue_unified_duplicate_cleanup(uuid,uuid,boolean,text) from public, anon, authenticated;
revoke all on function public.apply_unified_duplicate_cleanup(uuid,text,bigint,jsonb,jsonb,text,text) from public, anon, authenticated;
revoke all on function public.revert_unified_duplicate_cleanup(uuid,uuid,text,jsonb,text,text) from public, anon, authenticated;
revoke all on function public.schedule_unified_duplicate_cleanup() from public, anon, authenticated;
revoke all on function public.reschedule_changed_duplicate_cleanup() from public, anon, authenticated;
grant execute on function public.enqueue_unified_duplicate_cleanup(uuid,uuid,boolean,text) to service_role;
grant execute on function public.apply_unified_duplicate_cleanup(uuid,text,bigint,jsonb,jsonb,text,text) to service_role;
grant execute on function public.revert_unified_duplicate_cleanup(uuid,uuid,text,jsonb,text,text) to service_role;
notify pgrst, 'reload schema';
commit;
