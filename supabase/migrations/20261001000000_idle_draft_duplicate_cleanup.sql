begin;

create table public.duplicate_cleanup_schedule (
  article_id uuid primary key references public.articles(id) on delete cascade,
  signature text not null,
  quiet_since timestamptz not null default clock_timestamp(),
  dispatched_signature text
);
create index duplicate_cleanup_schedule_due_idx on public.duplicate_cleanup_schedule(quiet_since)
  where dispatched_signature is null or dispatched_signature is distinct from signature;
alter table public.duplicate_cleanup_schedule enable row level security;
revoke all on public.duplicate_cleanup_schedule from public, anon, authenticated;
grant all on public.duplicate_cleanup_schedule to service_role;

create or replace function public.unified_duplicate_cleanup_signature(p_article public.articles)
returns text language sql immutable as $$
  select md5(coalesce((p_article).content_json::text, '') || coalesce((p_article).keywords::text, '{}')
    || coalesce((p_article).article_language, 'ar') || coalesce((p_article).title, ''));
$$;

create or replace function public.unified_duplicate_cleanup_auto_ready(p_article_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.articles a
    join public.duplicate_cleanup_schedule s on s.article_id = a.id
    where a.id = p_article_id and a.status = 'draft'
      and a.content_json->>'type' = 'doc' and nullif(btrim(coalesce(a.plain_text, '')), '') is not null
      and s.quiet_since <= now() - interval '15 minutes'
      and not exists (select 1 from public.article_editor_presence p
        where p.article_id = a.id and p.last_seen_at >= now() - interval '90 seconds')
      and not exists (select 1 from public.content_writing_sessions w
        where w.article_id = a.id and w.status in ('queued', 'running', 'retry_scheduled'))
  );
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
  if v_article.id is null or v_article.status <> 'draft'
    or v_article.content_json->>'type' is distinct from 'doc'
    or nullif(btrim(coalesce(v_article.plain_text, '')), '') is null then return; end if;
  if p_automatic and (not public.article_automatic_job_allowed(p_article_id, 'duplicate_cleanup')
    or not public.unified_duplicate_cleanup_auto_ready(p_article_id)) then return; end if;
  v_requester := case when p_automatic then coalesce(v_article.automation_creator_id, v_article.created_by, p_requested_by) else p_requested_by end;
  if coalesce(public.article_access_level_for_user(p_article_id, v_requester), 'none') not in ('write', 'admin') then return; end if;
  v_key := 'unified-cleanup:' || p_article_id || ':' || case when p_automatic then
    public.unified_duplicate_cleanup_signature(v_article) || ':' ||
      (select extract(epoch from quiet_since)::text from public.duplicate_cleanup_schedule where article_id = p_article_id)
    else coalesce(nullif(p_request_id, ''), gen_random_uuid()::text) end;
  select * into v_job from public.ai_external_analysis_jobs
    where article_id = p_article_id and job_type = 'duplicate_cleanup'
      and (status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
        or (p_automatic and status = 'completed' and input_snapshot->>'version' = '2'
          and coalesce(progress#>'{unified,document}', input_snapshot->'document') = v_article.content_json
          and input_snapshot->'keywords' = v_article.keywords
          and input_snapshot->>'language' = v_article.article_language
          and input_snapshot->>'title' = v_article.title))
    order by created_at desc limit 1;
  if found then
    if not p_automatic and v_job.origin = 'auto' and v_job.status in ('queued', 'running', 'retry_scheduled', 'paused')
      and v_job.input_snapshot->'document' = v_article.content_json then
      update public.ai_external_analysis_jobs set origin = 'manual', requested_by = p_requested_by,
        status = case when status = 'running' then status else 'queued' end,
        next_attempt_at = case when status = 'running' then next_attempt_at else now() end,
        updated_at = clock_timestamp()
        where id = v_job.id returning * into v_job;
    end if;
    return next v_job; return;
  end if;
  insert into public.ai_external_analysis_jobs(article_id, requested_by, job_type, origin, status,
    idempotency_key, input_snapshot, command_label, next_attempt_at)
  values (p_article_id, v_requester, 'duplicate_cleanup', case when p_automatic then 'auto' else 'manual' end,
    'queued', v_key, jsonb_build_object('version', 2, 'category', 0, 'document', v_article.content_json,
      'keywords', v_article.keywords, 'language', v_article.article_language, 'title', v_article.title),
    'تنقية تلقائية لجميع العبارات العامة', now()) returning * into v_job;
  return next v_job;
end;
$$;

create or replace function public.schedule_unified_duplicate_cleanup()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_signature text;
begin
  if current_setting('app.duplicate_cleanup_mutation', true) = 'true' then return new; end if;
  if tg_op = 'UPDATE' and new.content_json is not distinct from old.content_json
    and new.keywords is not distinct from old.keywords and new.article_language is not distinct from old.article_language
    and new.title is not distinct from old.title and new.status is not distinct from old.status
    and new.plain_text is not distinct from old.plain_text then return new; end if;
  if new.status <> 'draft' or new.content_json->>'type' is distinct from 'doc'
    or nullif(btrim(coalesce(new.plain_text, '')), '') is null then
    delete from public.duplicate_cleanup_schedule where article_id = new.id;
    return new;
  end if;
  v_signature := public.unified_duplicate_cleanup_signature(new);
  insert into public.duplicate_cleanup_schedule(article_id, signature, quiet_since)
    values (new.id, v_signature, clock_timestamp())
    on conflict (article_id) do update set signature = excluded.signature,
      quiet_since = excluded.quiet_since, dispatched_signature = null
    where public.duplicate_cleanup_schedule.signature is distinct from excluded.signature;
  return new;
end;
$$;
drop trigger schedule_unified_duplicate_cleanup on public.articles;
create trigger schedule_unified_duplicate_cleanup after insert or update of content_json, plain_text, keywords, article_language, title, status
  on public.articles for each row execute function public.schedule_unified_duplicate_cleanup();

create or replace function public.dispatch_due_unified_duplicate_cleanup(p_limit integer default 20)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_schedule public.duplicate_cleanup_schedule%rowtype; v_job public.ai_external_analysis_jobs%rowtype;
  v_actor uuid; v_count integer := 0;
begin
  for v_schedule in select * from public.duplicate_cleanup_schedule
    where quiet_since <= clock_timestamp() - interval '15 minutes'
      and dispatched_signature is distinct from signature
    order by quiet_since limit greatest(1, least(coalesce(p_limit, 20), 100)) loop
    if not public.unified_duplicate_cleanup_auto_ready(v_schedule.article_id) then continue; end if;
    select coalesce(automation_creator_id, created_by, owner_id) into v_actor
      from public.articles where id = v_schedule.article_id;
    if v_actor is null then continue; end if;
    select * into v_job from public.enqueue_unified_duplicate_cleanup(v_schedule.article_id, v_actor, true, null);
    if v_job.id is null then continue; end if;
    if v_job.input_snapshot->'document' = (select content_json from public.articles where id = v_schedule.article_id)
      and v_job.input_snapshot->>'version' = '2' then
      update public.duplicate_cleanup_schedule set dispatched_signature = v_schedule.signature
        where article_id = v_schedule.article_id and signature = v_schedule.signature;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.reschedule_changed_duplicate_cleanup()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.job_type = 'duplicate_cleanup' and new.origin = 'auto'
    and old.status is distinct from new.status and new.status = 'blocked'
    and new.last_error_code = 'duplicate_cleanup_not_ready' then
    update public.duplicate_cleanup_schedule set quiet_since = clock_timestamp(), dispatched_signature = null
      where article_id = new.article_id;
  end if;
  return new;
end;
$$;

create or replace function public.guard_unified_duplicate_cleanup_mutation()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job public.ai_external_analysis_jobs%rowtype;
begin
  if current_setting('app.duplicate_cleanup_mutation', true) is distinct from 'true' then return new; end if;
  if old.status <> 'draft' or new.status <> 'draft' then
    raise exception 'Cleanup can modify draft articles only.' using errcode = '55000';
  end if;
  if new.metadata->'duplicateCleanup' is distinct from old.metadata->'duplicateCleanup' then
    select * into v_job from public.ai_external_analysis_jobs
      where id = (new.metadata#>>'{duplicateCleanup,jobId}')::uuid;
    if v_job.origin = 'auto' and not public.unified_duplicate_cleanup_auto_ready(old.id) then
      raise exception 'Automatic cleanup is no longer ready.' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_unified_duplicate_cleanup_mutation before update of content_json
  on public.articles for each row execute function public.guard_unified_duplicate_cleanup_mutation();

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
  if v_article.id is null or v_article.status <> 'draft'
    or v_article.content_json is distinct from p_before
    or coalesce(v_job.progress#>'{unified,document}', v_job.input_snapshot->'document') is distinct from p_before
    or v_article.keywords is distinct from v_job.input_snapshot->'keywords'
    or v_article.article_language is distinct from v_job.input_snapshot->>'language'
    or v_article.title is distinct from v_job.input_snapshot->>'title' then
    raise exception 'Article changed during cleanup.' using errcode = '40001';
  end if;
  if v_job.origin = 'auto' and not public.unified_duplicate_cleanup_auto_ready(v_article.id) then
    raise exception 'Automatic cleanup is no longer ready.' using errcode = '55000';
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
  if v_article.id is null or v_article.status <> 'draft' or v_article.content_json is distinct from v_state->'document' then
    raise exception 'Article changed after cleanup; cannot revert automatically.' using errcode = '40001';
  end if;
  select greatest(v_article.save_count, coalesce(max(version_number), 0)) + 1 into v_version
    from public.article_versions where article_id = v_article.id;
  perform set_config('app.duplicate_cleanup_mutation', 'true', true);
  update public.articles set content_json = p_document, content_html = p_html, plain_text = p_text,
    analysis = null, stats = (coalesce(stats, '{}'::jsonb) - 'commonDuplicatesCount' - 'totalDuplicates') ||
      jsonb_build_object('wordCount', coalesce(array_length(regexp_split_to_array(btrim(p_text), '\s+'), 1), 0)),
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

-- Old automatic queue entries used a 30-second delay. Retire them before the new worker starts.
update public.ai_external_analysis_jobs set status = 'cancelled', cancel_requested_at = now(),
  completed_at = now(), next_attempt_at = null, last_error_code = 'duplicate_cleanup_idle_policy',
  last_error = 'Replaced by draft-only, closed-editor, 15-minute idle scheduling.', updated_at = now()
  where job_type = 'duplicate_cleanup' and origin = 'auto'
    and status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused');
update public.ai_external_analysis_jobs set cancel_requested_at = now(), updated_at = now()
  where job_type = 'duplicate_cleanup' and origin = 'auto' and status = 'running';
insert into public.duplicate_cleanup_schedule(article_id, signature, quiet_since)
  select id, public.unified_duplicate_cleanup_signature(a), clock_timestamp()
  from public.articles a where a.status = 'draft'
    and a.content_json->>'type' = 'doc' and nullif(btrim(coalesce(a.plain_text, '')), '') is not null
  on conflict (article_id) do nothing;

revoke all on function public.unified_duplicate_cleanup_signature(public.articles) from public, anon, authenticated;
revoke all on function public.unified_duplicate_cleanup_auto_ready(uuid) from public, anon, authenticated;
revoke all on function public.dispatch_due_unified_duplicate_cleanup(integer) from public, anon, authenticated;
revoke all on function public.guard_unified_duplicate_cleanup_mutation() from public, anon, authenticated;
grant execute on function public.unified_duplicate_cleanup_signature(public.articles) to service_role;
grant execute on function public.unified_duplicate_cleanup_auto_ready(uuid) to service_role;
grant execute on function public.dispatch_due_unified_duplicate_cleanup(integer) to service_role;
notify pgrst, 'reload schema';
commit;
