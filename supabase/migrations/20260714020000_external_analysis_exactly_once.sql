-- External analysis exactly-once execution per article input signature and command.
-- Successful jobs are reused, failed jobs are retried in place, and historical
-- duplicates remain available for audit while being excluded from normal views.

alter table public.ai_external_analysis_article_state
  add column if not exists external_analysis_effective_command_ids jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ai_external_analysis_article_state'::regclass
      and conname = 'ai_external_analysis_article_state_effective_commands_check'
  ) then
    alter table public.ai_external_analysis_article_state
      add constraint ai_external_analysis_article_state_effective_commands_check
      check (jsonb_typeof(external_analysis_effective_command_ids) = 'array');
  end if;
end;
$$;

update public.ai_external_analysis_article_state as state
set external_analysis_effective_command_ids = case
  when state.engineering_command_mode = 'custom'
    and jsonb_typeof(state.custom_engineering_command_ids) = 'array'
    then state.custom_engineering_command_ids
  else to_jsonb(public.get_external_analysis_default_command_ids())
end;

drop table if exists _external_analysis_duplicate_jobs;
create temporary table _external_analysis_duplicate_jobs as
with ranked as (
  select
    job.id,
    first_value(job.id) over (
      partition by
        job.article_id,
        job.job_type,
        coalesce(job.command_id, ''),
        job.readiness_signature
      order by
        case
          when job.status = 'completed'
            and coalesce(job.result->>'status', 'completed') = 'completed' then 0
          when job.status in ('running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused') then 1
          when job.status = 'completed' then 2
          when job.status in ('failed', 'blocked') then 3
          else 4
        end,
        coalesce(job.completed_at, job.updated_at, job.created_at) desc,
        job.created_at,
        job.id
    ) as canonical_job_id,
    row_number() over (
      partition by
        job.article_id,
        job.job_type,
        coalesce(job.command_id, ''),
        job.readiness_signature
      order by
        case
          when job.status = 'completed'
            and coalesce(job.result->>'status', 'completed') = 'completed' then 0
          when job.status in ('running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused') then 1
          when job.status = 'completed' then 2
          when job.status in ('failed', 'blocked') then 3
          else 4
        end,
        coalesce(job.completed_at, job.updated_at, job.created_at) desc,
        job.created_at,
        job.id
    ) as duplicate_rank
  from public.ai_external_analysis_jobs as job
  where job.job_type in ('semantic_keywords_lsi', 'engineering_command')
    and nullif(job.readiness_signature, '') is not null
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
)
select id, canonical_job_id
from ranked
where duplicate_rank > 1;

update public.ai_external_analysis_runs as run
set
  status = 'cancelled',
  error_code = 'duplicate_task_suppressed',
  error_message = 'A canonical task already exists for this article input and command.',
  progress = coalesce(run.progress, '{}'::jsonb) || jsonb_build_object(
    'stage', 'cancelled',
    'reason', 'duplicate_task_suppressed',
    'updatedAt', now()
  ),
  finished_at = coalesce(run.finished_at, now())
from _external_analysis_duplicate_jobs as duplicate
where run.job_id = duplicate.id
  and run.status = 'running';

update public.ai_external_analysis_jobs as job
set
  status = case
    when job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      then 'cancelled'
    else job.status
  end,
  last_error_code = 'duplicate_task_suppressed',
  last_error = 'A canonical task already exists for this article input and command.',
  locked_by = null,
  locked_at = null,
  lease_expires_at = null,
  cancel_requested_at = case
    when job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      then coalesce(job.cancel_requested_at, now())
    else job.cancel_requested_at
  end,
  next_attempt_at = null,
  completed_at = case
    when job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      then coalesce(job.completed_at, now())
    else job.completed_at
  end,
  progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
    'stage', 'duplicate_suppressed',
    'duplicateOfJobId', duplicate.canonical_job_id,
    'updatedAt', now()
  ),
  updated_at = now()
from _external_analysis_duplicate_jobs as duplicate
where job.id = duplicate.id;

drop table _external_analysis_duplicate_jobs;

create unique index if not exists ai_external_analysis_jobs_execution_once_idx
  on public.ai_external_analysis_jobs(
    article_id,
    job_type,
    coalesce(command_id, ''),
    readiness_signature
  )
  where job_type in ('semantic_keywords_lsi', 'engineering_command')
    and nullif(readiness_signature, '') is not null
    and last_error_code is distinct from 'duplicate_task_suppressed';

create or replace function public.cancel_external_engineering_jobs_not_selected(
  p_article_id uuid,
  p_command_ids text[],
  p_include_manual boolean default true
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affected_count integer := 0;
begin
  with affected as (
    update public.ai_external_analysis_jobs as job
    set
      status = case when job.status = 'running' then 'running' else 'cancelled' end,
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      locked_by = case when job.status = 'running' then job.locked_by else null end,
      locked_at = case when job.status = 'running' then job.locked_at else null end,
      lease_expires_at = case when job.status = 'running' then job.lease_expires_at else null end,
      next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
      last_error_code = 'command_selection_changed',
      last_error = 'The command is no longer part of the selected external-analysis set.',
      completed_at = case when job.status = 'running' then job.completed_at else now() end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.status = 'running' then 'cancel_requested' else 'cancelled' end,
        'reason', 'command_selection_changed',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.article_id = p_article_id
      and job.job_type = 'engineering_command'
      and (job.origin = 'auto' or coalesce(p_include_manual, true))
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      and not (
        coalesce(job.command_id, '') = any(coalesce(p_command_ids, array[]::text[]))
      )
    returning job.id, job.status
  ), closed_runs as (
    update public.ai_external_analysis_runs as run
    set
      status = 'cancelled',
      error_code = 'command_selection_changed',
      error_message = 'The command is no longer part of the selected external-analysis set.',
      progress = coalesce(run.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'cancelled',
        'reason', 'command_selection_changed',
        'updatedAt', now()
      ),
      finished_at = now()
    from affected
    where run.job_id = affected.id
      and affected.status = 'cancelled'
      and run.status = 'running'
    returning run.id
  )
  select count(*)::integer
  into v_affected_count
  from affected;

  return coalesce(v_affected_count, 0);
end;
$$;

create or replace function public.enqueue_external_semantic_analysis_job(
  p_article_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_article public.articles%rowtype;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_has_secondaries boolean := false;
  v_has_lsi boolean := false;
  v_idempotency_key text;
  v_job_id uuid;
  v_job_status text;
begin
  select article.*
  into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null then
    return null;
  end if;

  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

  if v_state.article_id is null
    or not v_state.semantic_ready
    or nullif(v_state.semantic_readiness_signature, '') is null then
    return null;
  end if;

  v_has_secondaries := public.external_analysis_has_competitor_value(
    v_article.keywords->'secondaries',
    100
  );
  v_has_lsi := public.external_analysis_has_competitor_value(
    v_article.keywords->'lsi',
    100
  );

  if v_has_secondaries and v_has_lsi then
    return null;
  end if;

  v_idempotency_key := 'semantic_keywords_lsi:' || v_state.semantic_readiness_signature;
  perform pg_advisory_xact_lock(hashtextextended(
    v_article.id::text || ':' || v_idempotency_key,
    0
  ));

  select job.id, job.status
  into v_job_id, v_job_status
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.job_type = 'semantic_keywords_lsi'
    and job.readiness_signature = v_state.semantic_readiness_signature
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by
    case
      when job.status = 'completed' then 0
      when job.status in ('running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused') then 1
      when job.status in ('failed', 'blocked') then 2
      else 3
    end,
    coalesce(job.completed_at, job.updated_at, job.created_at) desc
  limit 1
  for update;

  if v_job_id is not null and v_job_status in ('failed', 'blocked') then
    update public.ai_external_analysis_jobs as job
    set
      requested_by = coalesce(v_article.assigned_to, v_article.owner_id, v_article.created_by),
      status = 'queued',
      idempotency_key = v_idempotency_key,
      input_snapshot = jsonb_build_object(
        'title', v_article.title,
        'plainText', v_article.plain_text,
        'keywords', coalesce(v_article.keywords, '{}'::jsonb),
        'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
        'articleLanguage', v_article.article_language,
        'articleUpdatedAt', v_article.updated_at,
        'readinessSignature', v_state.semantic_readiness_signature,
        'needsSecondaries', not v_has_secondaries,
        'needsLsi', not v_has_lsi
      ),
      result = null,
      progress = jsonb_build_object(
        'stage', 'queued',
        'source', 'failed_task_retry',
        'updatedAt', now()
      ),
      last_error = null,
      last_error_code = null,
      next_attempt_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      cancel_requested_at = null,
      completed_at = null,
      updated_at = now()
    where job.id = v_job_id;
    v_job_status := 'queued';
  end if;

  if v_job_id is null then
    insert into public.ai_external_analysis_jobs (
      article_id,
      requested_by,
      job_type,
      origin,
      status,
      idempotency_key,
      batch_key,
      sequence_number,
      readiness_signature,
      input_snapshot,
      progress,
      next_attempt_at
    ) values (
      v_article.id,
      coalesce(v_article.assigned_to, v_article.owner_id, v_article.created_by),
      'semantic_keywords_lsi',
      'auto',
      'queued',
      v_idempotency_key,
      'semantic:' || v_article.id::text || ':' || v_state.semantic_readiness_signature,
      0,
      v_state.semantic_readiness_signature,
      jsonb_build_object(
        'title', v_article.title,
        'plainText', v_article.plain_text,
        'keywords', coalesce(v_article.keywords, '{}'::jsonb),
        'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
        'articleLanguage', v_article.article_language,
        'articleUpdatedAt', v_article.updated_at,
        'readinessSignature', v_state.semantic_readiness_signature,
        'needsSecondaries', not v_has_secondaries,
        'needsLsi', not v_has_lsi
      ),
      jsonb_build_object(
        'stage', 'queued',
        'source', 'readiness_trigger',
        'updatedAt', now()
      ),
      now()
    )
    on conflict do nothing
    returning id, status into v_job_id, v_job_status;
  end if;

  if v_job_id is null then
    select job.id, job.status
    into v_job_id, v_job_status
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_article.id
      and job.job_type = 'semantic_keywords_lsi'
      and job.readiness_signature = v_state.semantic_readiness_signature
      and job.last_error_code is distinct from 'duplicate_task_suppressed'
    order by job.created_at
    limit 1;
  end if;

  if v_job_id is not null then
    update public.ai_external_analysis_article_state as state
    set
      semantic_last_enqueued_signature = v_state.semantic_readiness_signature,
      updated_at = now()
    where state.article_id = v_article.id;
  end if;

  return v_job_id;
end;
$$;

create or replace function public.enqueue_external_engineering_jobs_sequential_base(
  p_article_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_article public.articles%rowtype;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_semantic_ready boolean := false;
  v_semantic_job_id uuid;
  v_previous_job_id uuid;
  v_job_id uuid;
  v_job_status text;
  v_initial_status text;
  v_dependency_id uuid;
  v_idempotency_key text;
  v_batch_key text;
  v_job_ids uuid[] := array[]::uuid[];
  v_command_ids text[] := array[]::text[];
  v_command_count integer := 0;
  v_selection_mode text := 'default';
  v_selection_signature text;
  v_command record;
begin
  select article.*
  into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null then
    return v_job_ids;
  end if;

  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

  if v_state.article_id is null
    or not v_state.external_analysis_ready
    or nullif(v_state.external_analysis_readiness_signature, '') is null then
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
    return v_job_ids;
  end if;

  v_selection_mode := case
    when v_state.engineering_command_mode = 'custom' then 'custom'
    else 'default'
  end;

  if v_selection_mode = 'custom' then
    select coalesce(array_agg(item.command_id order by item.first_position), array[]::text[])
    into v_command_ids
    from (
      select catalog.command_id, min(selected.position) as first_position
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(v_state.custom_engineering_command_ids) = 'array'
            then v_state.custom_engineering_command_ids
          else '[]'::jsonb
        end
      ) with ordinality as selected(command_id, position)
      join public.external_analysis_command_catalog() as catalog
        on catalog.command_id = nullif(btrim(selected.command_id), '')
      group by catalog.command_id
    ) as item;
  else
    v_command_ids := public.get_external_analysis_default_command_ids();
  end if;

  v_command_count := cardinality(v_command_ids);
  v_selection_signature := md5(
    v_selection_mode || ':' || coalesce(array_to_string(v_command_ids, '|'), '')
  );

  perform public.cancel_external_engineering_jobs_not_selected(
    p_article_id,
    v_command_ids,
    true
  );
  perform public.cancel_stale_external_engineering_jobs(
    p_article_id,
    v_state.external_analysis_readiness_signature,
    false
  );

  if v_command_count = 0 then
    update public.ai_external_analysis_article_state as state
    set
      external_analysis_last_enqueued_signature = v_state.external_analysis_readiness_signature,
      external_analysis_last_command_selection_signature = v_selection_signature,
      external_analysis_effective_command_ids = to_jsonb(v_command_ids),
      updated_at = now()
    where state.article_id = v_article.id;
    return v_job_ids;
  end if;

  v_semantic_ready := public.external_analysis_has_competitor_value(
    v_article.keywords->'secondaries',
    100
  ) and public.external_analysis_has_competitor_value(
    v_article.keywords->'lsi',
    100
  );

  if not v_semantic_ready then
    v_semantic_job_id := public.enqueue_external_semantic_analysis_job(p_article_id);
  end if;

  v_batch_key := 'external-engineering:'
    || v_article.id::text || ':'
    || v_state.external_analysis_readiness_signature || ':'
    || v_selection_signature;

  for v_command in
    select
      selected.position::integer as sequence_number,
      catalog.command_id,
      catalog.command_label
    from unnest(v_command_ids) with ordinality as selected(command_id, position)
    join public.external_analysis_command_catalog() as catalog
      on catalog.command_id = selected.command_id
    order by selected.position
  loop
    v_job_id := null;
    v_job_status := null;
    v_idempotency_key := 'engineering:'
      || v_command.command_id || ':'
      || v_state.external_analysis_readiness_signature;
    v_dependency_id := case
      when v_command.sequence_number = 1 and v_semantic_ready then null
      when v_command.sequence_number = 1 then v_semantic_job_id
      else v_previous_job_id
    end;
    v_initial_status := case
      when v_command.sequence_number = 1
        and not v_semantic_ready
        and v_semantic_job_id is null then 'waiting_for_prerequisites'
      else 'queued'
    end;

    perform pg_advisory_xact_lock(hashtextextended(
      v_article.id::text || ':' || v_idempotency_key,
      0
    ));

    select job.id, job.status
    into v_job_id, v_job_status
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_article.id
      and job.job_type = 'engineering_command'
      and job.command_id = v_command.command_id
      and job.readiness_signature = v_state.external_analysis_readiness_signature
      and job.last_error_code is distinct from 'duplicate_task_suppressed'
    order by
      case
        when job.status = 'completed' then 0
        when job.status in ('running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused') then 1
        when job.status in ('failed', 'blocked') then 2
        else 3
      end,
      coalesce(job.completed_at, job.updated_at, job.created_at) desc
    limit 1
    for update;

    if v_job_id is not null
      and v_job_status in ('failed', 'blocked', 'cancelled') then
      update public.ai_external_analysis_jobs as job
      set
        requested_by = coalesce(
          case
            when v_selection_mode = 'custom'
              then v_state.engineering_command_selection_updated_by
            else null
          end,
          v_article.assigned_to,
          v_article.owner_id,
          v_article.created_by
        ),
        status = v_initial_status,
        idempotency_key = v_idempotency_key,
        batch_key = v_batch_key,
        sequence_number = v_command.sequence_number,
        command_label = v_command.command_label,
        depends_on_job_id = v_dependency_id,
        input_snapshot = jsonb_build_object(
          'title', v_article.title,
          'plainText', v_article.plain_text,
          'keywords', coalesce(v_article.keywords, '{}'::jsonb),
          'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
          'articleLanguage', v_article.article_language,
          'competitors', coalesce(v_article.metadata->'attachments'->'competitors', '{}'::jsonb),
          'articleUpdatedAt', v_article.updated_at,
          'readinessSignature', v_state.external_analysis_readiness_signature,
          'selectionMode', v_selection_mode,
          'selectionSignature', v_selection_signature,
          'commandSequence', v_command.sequence_number,
          'commandTotal', v_command_count,
          'commandId', v_command.command_id
        ),
        result = null,
        progress = jsonb_build_object(
          'stage', v_initial_status,
          'source', 'failed_task_retry',
          'selectionMode', v_selection_mode,
          'commandSequence', v_command.sequence_number,
          'commandTotal', v_command_count,
          'updatedAt', now()
        ),
        last_error = null,
        last_error_code = null,
        next_attempt_at = case when v_initial_status = 'queued' then now() else null end,
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        cancel_requested_at = null,
        completed_at = null,
        updated_at = now()
      where job.id = v_job_id;
      v_job_status := v_initial_status;
    end if;

    if v_job_id is null then
      insert into public.ai_external_analysis_jobs (
        article_id,
        requested_by,
        job_type,
        origin,
        status,
        idempotency_key,
        batch_key,
        sequence_number,
        command_id,
        command_label,
        depends_on_job_id,
        readiness_signature,
        input_snapshot,
        progress,
        next_attempt_at
      ) values (
        v_article.id,
        coalesce(
          case
            when v_selection_mode = 'custom'
              then v_state.engineering_command_selection_updated_by
            else null
          end,
          v_article.assigned_to,
          v_article.owner_id,
          v_article.created_by
        ),
        'engineering_command',
        'auto',
        v_initial_status,
        v_idempotency_key,
        v_batch_key,
        v_command.sequence_number,
        v_command.command_id,
        v_command.command_label,
        v_dependency_id,
        v_state.external_analysis_readiness_signature,
        jsonb_build_object(
          'title', v_article.title,
          'plainText', v_article.plain_text,
          'keywords', coalesce(v_article.keywords, '{}'::jsonb),
          'goalContext', coalesce(v_article.goal_context, '{}'::jsonb),
          'articleLanguage', v_article.article_language,
          'competitors', coalesce(v_article.metadata->'attachments'->'competitors', '{}'::jsonb),
          'articleUpdatedAt', v_article.updated_at,
          'readinessSignature', v_state.external_analysis_readiness_signature,
          'selectionMode', v_selection_mode,
          'selectionSignature', v_selection_signature,
          'commandSequence', v_command.sequence_number,
          'commandTotal', v_command_count,
          'commandId', v_command.command_id
        ),
        jsonb_build_object(
          'stage', v_initial_status,
          'selectionMode', v_selection_mode,
          'commandSequence', v_command.sequence_number,
          'commandTotal', v_command_count,
          'updatedAt', now()
        ),
        case when v_initial_status = 'queued' then now() else null end
      )
      on conflict do nothing
      returning id, status into v_job_id, v_job_status;
    end if;

    if v_job_id is null then
      select job.id, job.status
      into v_job_id, v_job_status
      from public.ai_external_analysis_jobs as job
      where job.article_id = v_article.id
        and job.job_type = 'engineering_command'
        and job.command_id = v_command.command_id
        and job.readiness_signature = v_state.external_analysis_readiness_signature
        and job.last_error_code is distinct from 'duplicate_task_suppressed'
      order by job.created_at
      limit 1;
    end if;

    if v_job_id is null then
      raise exception 'could not create or reuse external engineering command %', v_command.command_id;
    end if;

    if v_job_status = 'waiting_for_prerequisites'
      and (
        v_command.sequence_number > 1
        or v_semantic_ready
        or v_semantic_job_id is not null
      ) then
      update public.ai_external_analysis_jobs as job
      set
        status = 'queued',
        depends_on_job_id = v_dependency_id,
        next_attempt_at = now(),
        progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'queued',
          'updatedAt', now()
        ),
        updated_at = now()
      where job.id = v_job_id
        and job.status = 'waiting_for_prerequisites';
      v_job_status := 'queued';
    elsif v_job_status in ('queued', 'paused') then
      update public.ai_external_analysis_jobs as job
      set
        depends_on_job_id = v_dependency_id,
        updated_at = now()
      where job.id = v_job_id;
    end if;

    v_job_ids := array_append(v_job_ids, v_job_id);
    v_previous_job_id := v_job_id;
  end loop;

  if cardinality(v_job_ids) = v_command_count then
    update public.ai_external_analysis_article_state as state
    set
      external_analysis_last_enqueued_signature = v_state.external_analysis_readiness_signature,
      external_analysis_last_command_selection_signature = v_selection_signature,
      external_analysis_effective_command_ids = to_jsonb(v_command_ids),
      updated_at = now()
    where state.article_id = v_article.id;
  end if;

  return v_job_ids;
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
begin
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

create or replace function public.set_external_analysis_custom_commands(
  p_article_id uuid,
  p_requested_by uuid,
  p_command_ids jsonb
)
returns public.ai_external_analysis_article_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.ai_external_analysis_article_state%rowtype;
  v_command_ids text[] := array[]::text[];
  v_requested_count integer := 0;
  v_selection_changed boolean := true;
begin
  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id
  for update;

  if v_state.article_id is null then
    raise exception 'external analysis state is not available for article %', p_article_id;
  end if;
  if jsonb_typeof(p_command_ids) <> 'array' then
    raise exception 'p_command_ids must be a JSON array';
  end if;

  select count(distinct nullif(btrim(selected.command_id), ''))::integer
  into v_requested_count
  from jsonb_array_elements_text(p_command_ids) as selected(command_id)
  where nullif(btrim(selected.command_id), '') is not null;

  select coalesce(array_agg(item.command_id order by item.first_position), array[]::text[])
  into v_command_ids
  from (
    select catalog.command_id, min(selected.position) as first_position
    from jsonb_array_elements_text(p_command_ids)
      with ordinality as selected(command_id, position)
    join public.external_analysis_command_catalog() as catalog
      on catalog.command_id = nullif(btrim(selected.command_id), '')
    group by catalog.command_id
  ) as item;

  if v_requested_count = 0 or cardinality(v_command_ids) <> v_requested_count then
    raise exception 'p_command_ids contains an empty or unsupported command';
  end if;

  v_selection_changed := v_state.engineering_command_mode <> 'custom'
    or coalesce(v_state.custom_engineering_command_ids, '[]'::jsonb) <> to_jsonb(v_command_ids);

  if v_selection_changed then
    perform public.cancel_external_engineering_jobs_not_selected(
      p_article_id,
      v_command_ids,
      true
    );
  end if;

  update public.ai_external_analysis_article_state as state
  set
    engineering_command_mode = 'custom',
    custom_engineering_command_ids = to_jsonb(v_command_ids),
    external_analysis_effective_command_ids = to_jsonb(v_command_ids),
    engineering_command_selection_updated_by = p_requested_by,
    engineering_command_selection_updated_at = now(),
    external_analysis_last_command_selection_signature = case
      when v_selection_changed then null
      else state.external_analysis_last_command_selection_signature
    end,
    updated_at = now()
  where state.article_id = p_article_id
  returning state.* into v_state;

  return v_state;
end;
$$;

create or replace function public.reset_external_analysis_command_preferences(
  p_article_id uuid,
  p_requested_by uuid
)
returns public.ai_external_analysis_article_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.ai_external_analysis_article_state%rowtype;
  v_default_command_ids text[] := public.get_external_analysis_default_command_ids();
begin
  if not exists (
    select 1
    from public.ai_external_analysis_article_state as state
    where state.article_id = p_article_id
  ) then
    raise exception 'external analysis state is not available for article %', p_article_id;
  end if;

  perform public.cancel_external_engineering_jobs_not_selected(
    p_article_id,
    v_default_command_ids,
    true
  );

  update public.ai_external_analysis_article_state as state
  set
    engineering_command_mode = 'default',
    custom_engineering_command_ids = '[]'::jsonb,
    external_analysis_effective_command_ids = to_jsonb(v_default_command_ids),
    engineering_command_selection_updated_by = p_requested_by,
    engineering_command_selection_updated_at = now(),
    external_analysis_last_command_selection_signature = null,
    updated_at = now()
  where state.article_id = p_article_id;

  perform public.enqueue_external_engineering_jobs(p_article_id);

  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

  return v_state;
end;
$$;

create or replace function public.retry_external_analysis_job(
  p_job_id uuid,
  p_requested_by uuid
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.ai_external_analysis_jobs%rowtype;
begin
  select job.*
  into v_job
  from public.ai_external_analysis_jobs as job
  where job.id = p_job_id
  for update;

  if v_job.id is null then
    raise exception 'external analysis job % was not found', p_job_id;
  end if;

  if v_job.last_error_code = 'duplicate_task_suppressed'
    and nullif(v_job.readiness_signature, '') is not null then
    select job.*
    into v_job
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_job.article_id
      and job.job_type = v_job.job_type
      and coalesce(job.command_id, '') = coalesce(v_job.command_id, '')
      and job.readiness_signature = v_job.readiness_signature
      and job.last_error_code is distinct from 'duplicate_task_suppressed'
    order by
      case
        when job.status = 'completed' then 0
        when job.status in ('running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused') then 1
        else 2
      end,
      coalesce(job.completed_at, job.updated_at, job.created_at) desc
    limit 1
    for update;
  end if;

  if v_job.id is null then
    raise exception 'canonical external analysis job was not found';
  end if;

  if v_job.status = 'completed'
    or v_job.status in ('running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused') then
    return v_job;
  end if;

  if v_job.status not in ('failed', 'blocked', 'cancelled') then
    raise exception 'external analysis job % cannot be retried from status %', v_job.id, v_job.status;
  end if;

  update public.ai_external_analysis_jobs as job
  set
    requested_by = coalesce(p_requested_by, job.requested_by),
    status = 'queued',
    result = null,
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'queued',
      'source', 'manual_retry',
      'retriedJobId', job.id,
      'updatedAt', now()
    ),
    last_error = null,
    last_error_code = null,
    next_attempt_at = now(),
    locked_by = null,
    locked_at = null,
    lease_expires_at = null,
    cancel_requested_at = null,
    completed_at = null,
    updated_at = now()
  where job.id = v_job.id
  returning job.* into v_job;

  return v_job;
end;
$$;

revoke all on function public.cancel_external_engineering_jobs_not_selected(uuid, text[], boolean) from public;
revoke all on function public.enqueue_external_semantic_analysis_job(uuid) from public;
revoke all on function public.enqueue_external_engineering_jobs_sequential_base(uuid) from public;
revoke all on function public.enqueue_external_engineering_jobs(uuid) from public;
revoke all on function public.set_external_analysis_custom_commands(uuid, uuid, jsonb) from public;
revoke all on function public.reset_external_analysis_command_preferences(uuid, uuid) from public;
revoke all on function public.retry_external_analysis_job(uuid, uuid) from public;

grant execute on function public.cancel_external_engineering_jobs_not_selected(uuid, text[], boolean) to service_role;
grant execute on function public.enqueue_external_semantic_analysis_job(uuid) to service_role;
grant execute on function public.enqueue_external_engineering_jobs(uuid) to service_role;
grant execute on function public.set_external_analysis_custom_commands(uuid, uuid, jsonb) to service_role;
grant execute on function public.reset_external_analysis_command_preferences(uuid, uuid) to service_role;
grant execute on function public.retry_external_analysis_job(uuid, uuid) to service_role;

comment on index public.ai_external_analysis_jobs_execution_once_idx is
  'Allows one canonical semantic or engineering task per article input signature and command.';
comment on function public.retry_external_analysis_job(uuid, uuid) is
  'Requeues the same failed external-analysis task; successful sibling tasks are never recreated.';
