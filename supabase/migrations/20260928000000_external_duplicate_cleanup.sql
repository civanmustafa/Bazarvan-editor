begin;

alter table public.ai_external_analysis_jobs
  drop constraint ai_external_analysis_jobs_job_type_check,
  drop constraint ai_external_analysis_jobs_command_shape_check;
alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_job_type_check check (job_type in (
    'semantic_keywords_lsi', 'content_brief_generation', 'meta_description_generation',
    'full_article_pipeline', 'content_writing_preparation', 'engineering_command',
    'competitor_discovery', 'competitor_extraction', 'duplicate_cleanup'
  )),
  add constraint ai_external_analysis_jobs_command_shape_check check (
    (job_type = 'engineering_command' and nullif(btrim(command_id), '') is not null)
    or (job_type <> 'engineering_command' and command_id is null)
  );

-- Serialize starts per article/category, including simultaneous clicks from different tabs.
create or replace function public.enqueue_duplicate_cleanup(
  p_article_id uuid, p_requested_by uuid, p_request_id text, p_input jsonb
) returns setof public.ai_external_analysis_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job public.ai_external_analysis_jobs;
begin
  if coalesce(public.article_access_level_for_user(p_article_id, p_requested_by), 'none') not in ('write', 'admin') then
    raise exception 'article write access required' using errcode = '42501';
  end if;
  if coalesce(p_input->>'version', '') <> '1'
    or coalesce(p_input->>'category', '') !~ '^[2-8]$'
    or nullif(p_request_id, '') is null then raise exception 'invalid cleanup input'; end if;
  perform pg_advisory_xact_lock(hashtextextended('duplicate-cleanup:' || p_article_id || ':' || (p_input->>'category'), 0));
  select * into v_job from public.ai_external_analysis_jobs
    where article_id = p_article_id and job_type = 'duplicate_cleanup'
      and (idempotency_key = 'duplicate-cleanup:' || p_request_id
        or (input_snapshot->>'category' = p_input->>'category'
          and status in ('queued', 'running', 'retry_scheduled', 'paused')))
    order by created_at desc limit 1;
  if found then return next v_job; return; end if;
  insert into public.ai_external_analysis_jobs(
    article_id, requested_by, job_type, origin, status, idempotency_key, input_snapshot, command_label
  ) values (p_article_id, p_requested_by, 'duplicate_cleanup', 'manual', 'queued',
    'duplicate-cleanup:' || p_request_id, p_input, 'تنقية العبارات العامة (' || (p_input->>'category') || ')')
    returning * into v_job;
  return next v_job;
end;
$$;
revoke all on function public.enqueue_duplicate_cleanup(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_duplicate_cleanup(uuid, uuid, text, jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
