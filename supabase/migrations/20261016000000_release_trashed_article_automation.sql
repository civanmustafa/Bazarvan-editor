begin;

-- Dashboard deletion is a recoverable global trash marker, not an immediate
-- DELETE.  Automatic workers must nevertheless treat that article as absent:
-- it must not own the finish-first lane, be recovered, or be scheduled again.
create or replace function public.article_is_globally_trashed(
  p_article_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select nullif(btrim(article.metadata #>> '{trash,deletedAt}'), '') is not null
    from public.articles as article
    where article.id = p_article_id
  ), false);
$$;

create or replace function public.article_automatic_policy_allows(
  p_article_id uuid,
  p_job_type text,
  p_command_id text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_policy jsonb;
begin
  if p_article_id is null
     or not exists (select 1 from public.articles where id = p_article_id)
     or public.article_is_globally_trashed(p_article_id) then
    return false;
  end if;

  v_policy := public.article_automation_policy(p_article_id);
  if coalesce((v_policy->>'policyVersion')::integer, 0) = 0 then
    return true;
  end if;
  if not coalesce((v_policy->>'enabled')::boolean, false) then
    return false;
  end if;
  return case p_job_type
    when 'semantic_keywords_lsi' then coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false)
      or coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false)
      or coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false)
    when 'competitor_discovery' then coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
    when 'competitor_extraction' then coalesce((v_policy->>'autoExtractCompetitorContent')::boolean, false)
    when 'engineering_command' then coalesce((v_policy->>'autoRunReadyEngineeringCommands')::boolean, false)
      and coalesce(v_policy->'externalAnalysisCommandIds', '[]'::jsonb) ? coalesce(p_command_id, '')
    when 'content_writing_preparation' then coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false)
      and coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
      and coalesce((v_policy->>'autoExtractCompetitorContent')::boolean, false)
    when 'content_writing' then coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false)
    when 'duplicate_cleanup' then true
    else false
  end;
end;
$$;

create or replace function public.automatic_article_focus_allows(
  p_article_id uuid,
  p_job_type text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not public.automatic_article_focus_controls_job_type(p_job_type) then true
    when p_article_id is null
      or not exists (select 1 from public.articles where id = p_article_id)
      or public.article_is_globally_trashed(p_article_id) then false
    when exists (
      select 1 from public.automatic_article_focus_pauses as pause
      where pause.article_id = p_article_id
    ) then false
    else coalesce(
      (select focus.article_id is null or focus.article_id = p_article_id
       from public.automatic_article_focus as focus
       where focus.singleton is true),
      true
    )
  end;
$$;

create or replace function public.try_acquire_automatic_article_focus(
  p_article_id uuid,
  p_stage text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_focus public.automatic_article_focus%rowtype;
begin
  if p_article_id is null
     or not exists (select 1 from public.articles where id = p_article_id)
     or public.article_is_globally_trashed(p_article_id)
     or exists (
       select 1 from public.automatic_article_focus_pauses as pause
       where pause.article_id = p_article_id
     ) then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('automatic-article-focus', 0));
  select focus.* into v_focus
  from public.automatic_article_focus as focus
  where focus.singleton is true
  for update;

  if v_focus.article_id is null then
    update public.automatic_article_focus
    set article_id = p_article_id,
        state = 'active',
        current_stage = coalesce(nullif(btrim(p_stage), ''), 'preparation'),
        acquired_at = now(),
        last_progress_at = now(),
        next_retry_at = null,
        last_error_code = null,
        last_error = null,
        generation = generation + 1,
        updated_at = now()
    where singleton is true;
    return true;
  end if;

  if v_focus.article_id = p_article_id then
    update public.automatic_article_focus
    set current_stage = coalesce(nullif(btrim(p_stage), ''), current_stage),
        updated_at = now()
    where singleton is true;
    return true;
  end if;

  return false;
end;
$$;

create or replace function public.automatic_content_writing_requirement(
  p_article_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
begin
  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null then
    return jsonb_build_object('required', false, 'reason', 'article_not_found');
  end if;

  if nullif(btrim(v_article.metadata #>> '{trash,deletedAt}'), '') is not null then
    return jsonb_build_object('required', false, 'reason', 'article_trashed');
  end if;

  if coalesce(v_article.status, '') not in ('draft', 'content_preparation') then
    return jsonb_build_object('required', false, 'reason', 'article_left_automation_scope');
  end if;

  if public.article_body_has_content(
    v_article.content_json,
    v_article.content_html,
    v_article.plain_text
  ) then
    return jsonb_build_object('required', false, 'reason', 'article_editor_not_empty');
  end if;

  if exists (
    select 1
    from public.content_writing_sessions as session
    where session.article_id = p_article_id
      and session.status = 'completed'
  ) then
    return jsonb_build_object('required', false, 'reason', 'content_writing_already_completed');
  end if;

  return jsonb_build_object('required', true, 'reason', 'automatic_writing_required');
end;
$$;

create or replace function public.guard_content_writing_automation_requirement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requirement jsonb;
  v_reason text;
begin
  if new.status not in ('ready', 'claiming', 'writing', 'blocked', 'cancelled') then
    return new;
  end if;

  v_requirement := public.automatic_content_writing_requirement(new.article_id);
  if coalesce((v_requirement->>'required')::boolean, false) then
    return new;
  end if;

  if new.status = 'cancelled'
     and new.last_error_code in ('superseded_by_explicit_manual', 'article_trashed') then
    return new;
  end if;

  v_reason := coalesce(v_requirement->>'reason', 'automatic_writing_not_required');
  new.status := 'cancelled';
  new.attempt_count := 0;
  new.locked_by := null;
  new.locked_at := null;
  new.lease_expires_at := null;
  new.next_recovery_at := null;
  new.failure_class := null;
  new.completed_at := coalesce(new.completed_at, now());
  new.last_error_code := case
    when v_reason = 'article_trashed' then 'article_trashed'
    when v_reason = 'article_left_automation_scope' then 'article_left_automation_scope'
    else 'automatic_writing_not_required'
  end;
  new.last_error := case
    when v_reason = 'article_trashed'
      then 'The article is in the dashboard trash; automatic writing was cancelled.'
    when v_reason = 'article_left_automation_scope'
      then 'The article left draft preparation; automatic writing is no longer required.'
    when v_reason = 'content_writing_already_completed'
      then 'The article already has a completed writing session; automatic writing is no longer required.'
    else 'The article editor already contains content; automatic writing is no longer required.'
  end;
  return new;
end;
$$;

-- Keep the writing candidate source aligned with dashboard trash semantics.
create or replace function public.list_content_writing_automation_candidates(
  p_requested_by uuid,
  p_limit integer default 10,
  p_min_competitor_count integer default 1,
  p_require_processing_complete boolean default true
)
returns table (
  article_id uuid,
  article_title text,
  article_status text,
  article_updated_at timestamptz,
  readiness jsonb,
  item_id uuid,
  item_status text,
  eligible_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    article.id,
    article.title,
    article.status,
    article.updated_at,
    evaluated.value,
    existing.id,
    existing.status,
    existing.eligible_at
  from public.articles as article
  left join public.content_writing_automation_items as existing
    on existing.article_id = article.id
  cross join lateral (
    select public.evaluate_content_writing_automation_readiness(article.id) as value
  ) as evaluated
  where public.article_access_level_for_user(article.id, p_requested_by) <> 'none'
    and article.status in ('content_preparation', 'draft')
    and nullif(btrim(article.metadata #>> '{trash,deletedAt}'), '') is null
    and coalesce((evaluated.value ->> 'ready')::boolean, false) is true
    and coalesce((evaluated.value ->> 'usableCompetitorCount')::integer, 0)
      >= greatest(1, least(coalesce(p_min_competitor_count, 1), 5))
    and (
      p_require_processing_complete is not true
      or coalesce((evaluated.value ->> 'processingComplete')::boolean, false) is true
    )
    and (existing.id is null or existing.status = 'ready')
    and (
      existing.id is not null
      or not exists (
        select 1
        from public.content_writing_sessions as completed_session
        where completed_session.article_id = article.id
          and completed_session.status = 'completed'
      )
    )
    and not exists (
      select 1
      from public.ai_external_analysis_jobs as article_pipeline
      where article_pipeline.article_id = article.id
        and article_pipeline.job_type = 'full_article_pipeline'
        and article_pipeline.status in (
          'waiting_for_prerequisites', 'queued', 'running',
          'retry_scheduled', 'paused'
        )
    )
  order by coalesce(existing.ready_at, article.updated_at, article.created_at), article.id
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

-- The current reconciler already asks the canonical writing requirement for
-- writing rows.  Add the same trash guard to its external-job candidate arm.
do $migration$
declare
  v_definition text;
  v_status_clause constant text :=
    'and article.status in (''draft'', ''content_preparation'')';
  v_trash_clause constant text :=
    'and article.status in (''draft'', ''content_preparation'')'
    || E'\n        and nullif(btrim(article.metadata #>> ''{trash,deletedAt}''), '''') is null';
begin
  select pg_get_functiondef(
    'public.reconcile_automatic_article_focus()'::regprocedure
  ) into v_definition;

  if position('metadata #>> ''{trash,deletedAt}''' in v_definition) = 0 then
    if position(v_status_clause in v_definition) = 0 then
      raise exception 'The automatic focus reconciler changed; refusing an unsafe trash patch.';
    end if;
    v_definition := replace(v_definition, v_status_clause, v_trash_clause);
    execute v_definition;
  end if;
end;
$migration$;

-- Exclude trashed draft rows before the expensive dashboard inventory
-- classifier evaluates them.
do $migration$
declare
  v_definition text;
  v_draft_clause constant text := 'where article.status = ''draft''';
  v_trash_clause constant text :=
    'where article.status = ''draft'''
    || E'\n      and nullif(btrim(article.metadata #>> ''{trash,deletedAt}''), '''') is null';
begin
  select pg_get_functiondef(
    'public.get_visible_automation_task_inventory_raw(uuid)'::regprocedure
  ) into v_definition;

  if position('metadata #>> ''{trash,deletedAt}''' in v_definition) = 0 then
    if position(v_draft_clause in v_definition) = 0 then
      raise exception 'The raw automation inventory changed; refusing an unsafe trash patch.';
    end if;
    v_definition := replace(v_definition, v_draft_clause, v_trash_clause);
    execute v_definition;
  end if;
end;
$migration$;

create or replace function public.release_trashed_article_automation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(btrim(new.metadata #>> '{trash,deletedAt}'), '') is null then
    return new;
  end if;

  update public.content_writing_sessions as session
  set status = case when session.status = 'running' then session.status else 'cancelled' end,
      cancel_requested_at = coalesce(session.cancel_requested_at, now()),
      last_error_code = 'article_trashed',
      last_error = 'The article is in the dashboard trash; automatic writing was cancelled.',
      completed_at = case when session.status = 'running' then session.completed_at
        else coalesce(session.completed_at, now()) end,
      locked_by = case when session.status = 'running' then session.locked_by else null end,
      locked_at = case when session.status = 'running' then session.locked_at else null end,
      lease_expires_at = case when session.status = 'running' then session.lease_expires_at else null end,
      updated_at = now()
  where session.article_id = new.id
    and session.execution_mode = 'api'
    and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
    and session.status in ('queued', 'running', 'retry_scheduled');

  update public.content_writing_automation_items as item
  set status = 'cancelled',
      attempt_count = 0,
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      next_recovery_at = null,
      failure_class = null,
      completed_at = coalesce(item.completed_at, now()),
      last_error_code = 'article_trashed',
      last_error = 'The article is in the dashboard trash; automatic writing was cancelled.',
      updated_at = now()
  where item.article_id = new.id
    and item.status in ('ready', 'claiming', 'writing', 'blocked');

  update public.ai_external_analysis_jobs as job
  set status = case when job.status = 'running' then job.status else 'cancelled' end,
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      next_attempt_at = null,
      last_error_code = 'article_trashed',
      last_error = 'The article is in the dashboard trash; automatic work was cancelled.',
      completed_at = case when job.status = 'running' then job.completed_at
        else coalesce(job.completed_at, now()) end,
      locked_by = case when job.status = 'running' then job.locked_by else null end,
      locked_at = case when job.status = 'running' then job.locked_at else null end,
      lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
      updated_at = now()
  where job.article_id = new.id
    and job.origin = 'auto'
    and job.pipeline_parent_job_id is null
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running',
      'retry_scheduled', 'paused', 'blocked'
    );

  delete from public.automatic_article_focus_pauses where article_id = new.id;

  update public.automatic_article_focus
  set article_id = null,
      state = 'idle',
      current_stage = null,
      acquired_at = null,
      last_article_id = null,
      last_release_reason = 'article_trashed',
      released_at = now(),
      next_retry_at = null,
      last_error_code = null,
      last_error = null,
      last_progress_at = now(),
      generation = generation + 1,
      updated_at = now()
  where singleton is true
    and (article_id = new.id or last_article_id = new.id);

  insert into public.worker_queue_signals(queue_name)
  values ('external_analysis'), ('content_writing')
  on conflict do nothing;

  perform public.reconcile_automatic_article_focus();
  return new;
end;
$$;

drop trigger if exists release_trashed_article_automation_after_update
  on public.articles;
create trigger release_trashed_article_automation_after_update
after update of metadata on public.articles
for each row
when (
  old.metadata #>> '{trash,deletedAt}' is distinct from
  new.metadata #>> '{trash,deletedAt}'
)
execute function public.release_trashed_article_automation();

create or replace function public.release_deleted_article_focus_before_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.automatic_article_focus
  set article_id = null,
      state = 'idle',
      current_stage = null,
      acquired_at = null,
      last_article_id = null,
      last_release_reason = 'article_deleted',
      released_at = now(),
      next_retry_at = null,
      last_error_code = null,
      last_error = null,
      last_progress_at = now(),
      generation = generation + 1,
      updated_at = now()
  where singleton is true
    and (article_id = old.id or last_article_id = old.id);
  return old;
end;
$$;

drop trigger if exists release_deleted_article_focus_before_delete
  on public.articles;
create trigger release_deleted_article_focus_before_delete
before delete on public.articles
for each row execute function public.release_deleted_article_focus_before_delete();

-- Repair every globally trashed draft already present before this migration.
update public.content_writing_sessions as session
set status = case when session.status = 'running' then session.status else 'cancelled' end,
    cancel_requested_at = coalesce(session.cancel_requested_at, now()),
    last_error_code = 'article_trashed',
    last_error = 'The article is in the dashboard trash; automatic writing was cancelled.',
    completed_at = case when session.status = 'running' then session.completed_at
      else coalesce(session.completed_at, now()) end,
    locked_by = case when session.status = 'running' then session.locked_by else null end,
    locked_at = case when session.status = 'running' then session.locked_at else null end,
    lease_expires_at = case when session.status = 'running' then session.lease_expires_at else null end,
    updated_at = now()
from public.articles as article
where article.id = session.article_id
  and nullif(btrim(article.metadata #>> '{trash,deletedAt}'), '') is not null
  and session.execution_mode = 'api'
  and coalesce(session.context_snapshot->>'triggerSource', '') = 'automatic_ready'
  and session.status in ('queued', 'running', 'retry_scheduled');

update public.content_writing_automation_items as item
set status = 'cancelled',
    attempt_count = 0,
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    next_recovery_at = null,
    failure_class = null,
    completed_at = coalesce(item.completed_at, now()),
    last_error_code = 'article_trashed',
    last_error = 'The article is in the dashboard trash; automatic writing was cancelled.',
    updated_at = now()
from public.articles as article
where article.id = item.article_id
  and nullif(btrim(article.metadata #>> '{trash,deletedAt}'), '') is not null
  and item.status in ('ready', 'claiming', 'writing', 'blocked');

update public.ai_external_analysis_jobs as job
set status = case when job.status = 'running' then job.status else 'cancelled' end,
    cancel_requested_at = coalesce(job.cancel_requested_at, now()),
    next_attempt_at = null,
    last_error_code = 'article_trashed',
    last_error = 'The article is in the dashboard trash; automatic work was cancelled.',
    completed_at = case when job.status = 'running' then job.completed_at
      else coalesce(job.completed_at, now()) end,
    locked_by = case when job.status = 'running' then job.locked_by else null end,
    locked_at = case when job.status = 'running' then job.locked_at else null end,
    lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
    updated_at = now()
from public.articles as article
where article.id = job.article_id
  and nullif(btrim(article.metadata #>> '{trash,deletedAt}'), '') is not null
  and job.origin = 'auto'
  and job.pipeline_parent_job_id is null
  and job.status in (
    'waiting_for_prerequisites', 'queued', 'running',
    'retry_scheduled', 'paused', 'blocked'
  );

delete from public.automatic_article_focus_pauses as pause
using public.articles as article
where article.id = pause.article_id
  and nullif(btrim(article.metadata #>> '{trash,deletedAt}'), '') is not null;

update public.automatic_article_focus as focus
set article_id = null,
    state = 'idle',
    current_stage = null,
    acquired_at = null,
    last_article_id = null,
    last_release_reason = 'article_trashed',
    released_at = now(),
    next_retry_at = null,
    last_error_code = null,
    last_error = null,
    last_progress_at = now(),
    generation = generation + 1,
    updated_at = now()
where focus.singleton is true
  and (
    exists (
      select 1 from public.articles as article
      where article.id = focus.article_id
        and nullif(btrim(article.metadata #>> '{trash,deletedAt}'), '') is not null
    )
    or exists (
      select 1 from public.articles as article
      where article.id = focus.last_article_id
        and nullif(btrim(article.metadata #>> '{trash,deletedAt}'), '') is not null
    )
  );

select public.reconcile_automatic_article_focus();

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 13;
$$;

revoke all on function public.article_is_globally_trashed(uuid)
  from public, anon, authenticated;
revoke all on function public.release_trashed_article_automation()
  from public, anon, authenticated;
revoke all on function public.release_deleted_article_focus_before_delete()
  from public, anon, authenticated;
grant execute on function public.article_is_globally_trashed(uuid) to service_role;

comment on function public.article_is_globally_trashed(uuid) is
  'Returns true only for the global dashboard trash marker; per-user hidden rows remain eligible for their other collaborators.';
comment on function public.release_trashed_article_automation() is
  'Cancels automatic work and releases the finish-first lane immediately when an article enters the global dashboard trash.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 13 with globally trashed articles excluded from all automatic queues and focus ownership.';

notify pgrst, 'reload schema';

commit;
