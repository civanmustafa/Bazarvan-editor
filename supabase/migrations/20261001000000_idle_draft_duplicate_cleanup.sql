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
    where a.id = p_article_id and a.deleted_at is null and a.status = 'draft'
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
  if v_article.id is null or v_article.deleted_at is not null or v_article.status <> 'draft'
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
  if new.deleted_at is not null or new.status <> 'draft' or new.content_json->>'type' is distinct from 'doc'
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
  from public.articles a where a.status = 'draft' and a.deleted_at is null
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
