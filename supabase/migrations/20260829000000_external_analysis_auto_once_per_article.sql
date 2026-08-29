begin;

-- Automatic research is an article-lifecycle convenience, not a reaction to
-- every readiness-signature change. Keep the signature-scoped implementations
-- available for explicit manual requests, then put a per-article execution
-- guard in front of every automatic entry point. A row which was cancelled
-- before a worker claimed it is intentionally not counted as an execution.
alter function public.enqueue_external_semantic_analysis_job_controlled(uuid, text)
  rename to enqueue_external_semantic_analysis_job_by_signature;

alter function public.enqueue_competitor_discovery_job_controlled(uuid, uuid, text)
  rename to enqueue_competitor_discovery_job_by_signature;

create or replace function public.find_external_analysis_stage_job(
  p_article_id uuid,
  p_job_type text,
  p_command_id text default null
)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select job.id
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = p_job_type
    and (
      p_job_type <> 'engineering_command'
      or coalesce(job.command_id, '') = coalesce(p_command_id, '')
    )
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
    and (
      job.attempt_count > 0
      or job.started_at is not null
      or job.result is not null
    )
  order by job.created_at, job.id
  limit 1;
$$;

-- Freeze the semantic targets at the exact moment a worker claims a run.
-- Job snapshots may be reused after a terminal result, whereas run snapshots
-- are immutable evidence that a specific target was actually attempted.
create or replace function public.stamp_external_semantic_run_targets()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_input_snapshot jsonb := '{}'::jsonb;
begin
  select coalesce(job.input_snapshot, '{}'::jsonb)
  into v_input_snapshot
  from public.ai_external_analysis_jobs as job
  where job.id = new.job_id
    and job.job_type = 'semantic_keywords_lsi';

  if found then
    new.progress := coalesce(new.progress, '{}'::jsonb) || jsonb_build_object(
      'semanticTargetAttempt', jsonb_build_object(
        'secondaries', case
          when jsonb_typeof(v_input_snapshot->'needsSecondaries') = 'boolean'
            then (v_input_snapshot->>'needsSecondaries')::boolean
          else true
        end,
        'lsi', case
          when jsonb_typeof(v_input_snapshot->'needsLsi') = 'boolean'
            then (v_input_snapshot->>'needsLsi')::boolean
          else true
        end
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists stamp_external_semantic_run_targets
  on public.ai_external_analysis_runs;
create trigger stamp_external_semantic_run_targets
before insert on public.ai_external_analysis_runs
for each row
execute function public.stamp_external_semantic_run_targets();

-- Legacy runs did not freeze their target mask, and a canonical job snapshot
-- may already have been reused. Conservatively mark both targets attempted so
-- historical ambiguity can never cause an automatic rerun after deployment.
update public.ai_external_analysis_runs as run
set progress = coalesce(run.progress, '{}'::jsonb) || jsonb_build_object(
  'semanticTargetAttempt', jsonb_build_object(
    'secondaries', true,
    'lsi', true
  )
)
from public.ai_external_analysis_jobs as job
where job.id = run.job_id
  and job.job_type = 'semantic_keywords_lsi'
  and not (coalesce(run.progress, '{}'::jsonb) ? 'semanticTargetAttempt');

create or replace function public.enqueue_external_semantic_analysis_job_controlled(
  p_article_id uuid,
  p_origin text default 'auto'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_manual boolean := lower(btrim(coalesce(p_origin, 'auto'))) = 'manual';
  v_settings jsonb := public.get_content_research_automation_settings();
  v_keywords jsonb := '{}'::jsonb;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_needs_secondaries boolean := false;
  v_needs_lsi boolean := false;
  v_attempted_secondaries boolean := false;
  v_attempted_lsi boolean := false;
  v_execute_secondaries boolean := false;
  v_execute_lsi boolean := false;
  v_existing_job_id uuid;
  v_live_job_status text;
  v_job_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'external-analysis-auto-once:' || p_article_id::text || ':semantic_keywords_lsi',
    0
  ));

  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = p_article_id;

  if not found then return null; end if;

  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

  -- Serialize the lifetime decision with worker claims, including jobs from an
  -- older readiness signature. A concurrent claim commits before this lock is
  -- acquired, so its run is visible to the attempt query below.
  perform job.id
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'semantic_keywords_lsi'
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by job.id
  for update;

  v_needs_secondaries := not public.external_analysis_has_competitor_value(
    v_keywords->'secondaries',
    100
  ) and (
    v_manual
    or coalesce((v_settings->>'autoGenerateAlternativeKeywords')::boolean, true)
  );
  v_needs_lsi := not public.external_analysis_has_competitor_value(
    v_keywords->'lsi',
    100
  ) and (
    v_manual
    or coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true)
  );

  if not v_needs_secondaries and not v_needs_lsi then return null; end if;

  if not v_manual then
    select
      coalesce(bool_or(case
        when jsonb_typeof(run.progress #> '{semanticTargetAttempt,secondaries}') = 'boolean'
          then (run.progress #>> '{semanticTargetAttempt,secondaries}')::boolean
        else true
      end), false),
      coalesce(bool_or(case
        when jsonb_typeof(run.progress #> '{semanticTargetAttempt,lsi}') = 'boolean'
          then (run.progress #>> '{semanticTargetAttempt,lsi}')::boolean
        else true
      end), false)
    into v_attempted_secondaries, v_attempted_lsi
    from public.ai_external_analysis_runs as run
    join public.ai_external_analysis_jobs as job
      on job.id = run.job_id
    where job.article_id = p_article_id
      and job.job_type = 'semantic_keywords_lsi'
      and job.last_error_code is distinct from 'duplicate_task_suppressed';

    v_existing_job_id := public.find_external_analysis_stage_job(
      p_article_id,
      'semantic_keywords_lsi',
      null
    );
    if (not v_needs_secondaries or v_attempted_secondaries)
      and (not v_needs_lsi or v_attempted_lsi) then
      return v_existing_job_id;
    end if;
  end if;

  -- A combined semantic job may cover one or both targets. When a setting is
  -- enabled later, execute only the newly eligible target; never make the
  -- already-attempted target hitch a second automatic ride in the same job.
  v_execute_secondaries := v_needs_secondaries
    and (v_manual or not v_attempted_secondaries);
  v_execute_lsi := v_needs_lsi
    and (v_manual or not v_attempted_lsi);

  -- Never rewrite a target snapshot while a worker is using it. The terminal
  -- follow-up trigger will schedule any newly eligible target afterward.
  select job.id, job.status
  into v_existing_job_id, v_live_job_status
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'semantic_keywords_lsi'
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
    and job.status = 'running'
  order by job.created_at
  limit 1;
  if v_live_job_status = 'running' then return v_existing_job_id; end if;

  v_job_id := public.enqueue_external_semantic_analysis_job_by_signature(
    p_article_id,
    case when v_manual then 'manual' else 'auto' end
  );

  if v_job_id is not null then
    update public.ai_external_analysis_jobs as job
    set
      input_snapshot = coalesce(job.input_snapshot, '{}'::jsonb) || jsonb_build_object(
        'needsSecondaries', v_execute_secondaries,
        'needsLsi', v_execute_lsi,
        'automaticOnceTargets', jsonb_build_object(
          'secondaries', v_execute_secondaries,
          'lsi', v_execute_lsi
        )
      ),
      max_attempts = case
        when v_manual then greatest(job.max_attempts, job.attempt_count + 1)
        else job.attempt_count + 1
      end,
      updated_at = now()
    where job.id = v_job_id
      and job.status <> 'running'
      and not (
        not v_manual
        and job.origin = 'manual'
        and job.status in (
          'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
        )
      );
  end if;

  return v_job_id;
end;
$$;

create or replace function public.enqueue_competitor_discovery_job_controlled(
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
  v_existing_job_id uuid;
  v_job_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'external-analysis-auto-once:' || p_article_id::text || ':competitor_discovery',
    0
  ));

  -- Serialize the lifetime check with a worker claiming either the current or
  -- a stale-signature discovery job.
  perform job.id
  from public.ai_external_analysis_jobs as job
  where job.article_id = p_article_id
    and job.job_type = 'competitor_discovery'
    and job.last_error_code is distinct from 'duplicate_task_suppressed'
  order by job.id
  for update;

  if not v_manual then
    v_existing_job_id := public.find_external_analysis_stage_job(
      p_article_id,
      'competitor_discovery',
      null
    );
    if v_existing_job_id is not null then return v_existing_job_id; end if;
  end if;

  v_job_id := public.enqueue_competitor_discovery_job_by_signature(
    p_article_id,
    p_requested_by,
    case when v_manual then 'manual' else 'auto' end
  );

  if v_job_id is not null then
    update public.ai_external_analysis_jobs as job
    set
      max_attempts = case
        when v_manual then greatest(job.max_attempts, job.attempt_count + 1)
        else greatest(1, job.attempt_count)
      end,
      updated_at = now()
    where job.id = v_job_id
      and (v_manual or job.origin = 'auto');
  end if;

  return v_job_id;
end;
$$;

-- A failed or blocked combined semantic run may have attempted one target
-- while another target only became eligible during that run. Reconcile the
-- unattempted target after every terminal worker outcome. The run-level target
-- stamp above makes this finite: an attempted target cannot be auto-enqueued
-- again, even when it remains empty.
create or replace function public.enqueue_semantic_followup_after_completion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.job_type = 'semantic_keywords_lsi'
    and new.status in ('completed', 'failed', 'blocked')
    and new.status is distinct from old.status
    and new.pipeline_parent_job_id is null then
    perform public.enqueue_external_semantic_analysis_job_controlled(
      new.article_id,
      case
        when new.status = 'completed' and new.origin = 'manual' then 'manual'
        else 'auto'
      end
    );

    if new.status = 'completed' then
      perform public.enqueue_competitor_discovery_job_controlled(
        new.article_id,
        new.requested_by,
        'auto'
      );
    end if;
  elsif new.status = 'cancelled'
    and new.status is distinct from old.status
    and new.origin = 'auto'
    and new.pipeline_parent_job_id is null
    and new.last_error_code in (
      'semantic_automation_disabled',
      'content_research_automation_changed',
      'competitor_automation_disabled'
    ) then
    if new.job_type = 'semantic_keywords_lsi' then
      perform public.enqueue_external_semantic_analysis_job_controlled(
        new.article_id,
        'auto'
      );
    elsif new.job_type = 'competitor_discovery' then
      perform public.enqueue_competitor_discovery_job_controlled(
        new.article_id,
        new.requested_by,
        'auto'
      );
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.enqueue_external_engineering_jobs_sequential_base(
  p_article_id uuid,
  p_origin text
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article public.articles%rowtype;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_origin text := lower(btrim(coalesce(p_origin, 'auto')));
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
  v_all_command_ids text[] := array[]::text[];
  v_command_ids text[] := array[]::text[];
  v_command_count integer := 0;
  v_selection_mode text := 'default';
  v_selection_signature text;
  v_command record;
begin
  if v_origin not in ('auto', 'manual') then
    raise exception 'unsupported external engineering origin %', p_origin;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'external-engineering-enqueue:' || p_article_id::text,
    0
  ));

  select article.*
  into v_article
  from public.articles as article
  where article.id = p_article_id;

  if v_article.id is null then return v_job_ids; end if;

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
    into v_all_command_ids
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
    v_all_command_ids := public.get_external_analysis_default_command_ids();
  end if;

  v_selection_signature := md5(
    v_selection_mode || ':' || coalesce(array_to_string(v_all_command_ids, '|'), '')
  );

  perform public.cancel_external_engineering_jobs_not_selected(
    p_article_id,
    v_all_command_ids,
    v_origin = 'manual'
  );
  perform public.cancel_stale_external_engineering_jobs(
    p_article_id,
    v_state.external_analysis_readiness_signature,
    false
  );

  if v_origin = 'auto' then
    select coalesce(array_agg(selected.command_id order by selected.position), array[]::text[])
    into v_command_ids
    from unnest(v_all_command_ids) with ordinality as selected(command_id, position)
    where not exists (
      select 1
      from public.ai_external_analysis_jobs as previous
      where previous.article_id = p_article_id
        and previous.job_type = 'engineering_command'
        and previous.command_id = selected.command_id
        and previous.last_error_code is distinct from 'duplicate_task_suppressed'
        and (
          previous.attempt_count > 0
          or previous.started_at is not null
          or previous.result is not null
        )
    );
  else
    v_command_ids := v_all_command_ids;
  end if;

  v_command_count := cardinality(v_command_ids);
  if v_command_count = 0 then
    update public.ai_external_analysis_article_state as state
    set
      external_analysis_last_enqueued_signature = v_state.external_analysis_readiness_signature,
      external_analysis_last_command_selection_signature = v_selection_signature,
      external_analysis_effective_command_ids = to_jsonb(v_all_command_ids),
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
    v_semantic_job_id := public.enqueue_external_semantic_analysis_job_controlled(
      p_article_id,
      v_origin
    );
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
        when job.status in (
          'running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused'
        ) then 1
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
        origin = v_origin,
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
        v_origin,
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
      set depends_on_job_id = v_dependency_id, updated_at = now()
      where job.id = v_job_id;
    end if;

    update public.ai_external_analysis_jobs as job
    set
      max_attempts = case
        when v_origin = 'manual' then greatest(job.max_attempts, job.attempt_count + 1)
        else greatest(1, job.attempt_count)
      end,
      updated_at = now()
    where job.id = v_job_id
      and (v_origin = 'manual' or job.origin = 'auto');

    v_job_ids := array_append(v_job_ids, v_job_id);
    v_previous_job_id := v_job_id;
  end loop;

  if cardinality(v_job_ids) = v_command_count then
    update public.ai_external_analysis_article_state as state
    set
      external_analysis_last_enqueued_signature = v_state.external_analysis_readiness_signature,
      external_analysis_last_command_selection_signature = v_selection_signature,
      external_analysis_effective_command_ids = to_jsonb(v_all_command_ids),
      updated_at = now()
    where state.article_id = v_article.id;
  end if;

  return v_job_ids;
end;
$$;

create or replace function public.enqueue_external_engineering_jobs_sequential_base(
  p_article_id uuid
)
returns uuid[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.enqueue_external_engineering_jobs_sequential_base(p_article_id, 'auto');
$$;

create or replace function public.enqueue_external_engineering_jobs(
  p_article_id uuid,
  p_origin text
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_origin text := lower(btrim(coalesce(p_origin, 'auto')));
  v_job_ids uuid[] := array[]::uuid[];
  v_batch_key text;
  v_article_word_count integer := 0;
begin
  if v_origin not in ('auto', 'manual') then
    raise exception 'unsupported external engineering origin %', p_origin;
  end if;

  select public.external_analysis_article_word_count(article.plain_text)
  into v_article_word_count
  from public.articles as article
  where article.id = p_article_id;

  if coalesce(v_article_word_count, 0) < 101 then
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
    return v_job_ids;
  end if;

  v_job_ids := public.enqueue_external_engineering_jobs_sequential_base(
    p_article_id,
    v_origin
  );

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

create or replace function public.enqueue_external_engineering_jobs(
  p_article_id uuid
)
returns uuid[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.enqueue_external_engineering_jobs(p_article_id, 'auto');
$$;

create or replace function public.enqueue_external_engineering_jobs_controlled(
  p_article_id uuid,
  p_requested_by uuid default null,
  p_origin text default 'auto'
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_origin text := lower(btrim(coalesce(p_origin, 'auto')));
  v_job_ids uuid[] := array[]::uuid[];
begin
  if v_origin not in ('auto', 'manual') then
    raise exception 'unsupported external engineering origin %', p_origin;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ready-engineering-command-automation', 0));
  v_job_ids := public.enqueue_external_engineering_jobs(p_article_id, v_origin);

  if v_origin = 'manual' and cardinality(v_job_ids) > 0 then
    update public.ai_external_analysis_jobs as job
    set
      origin = 'manual',
      requested_by = coalesce(p_requested_by, job.requested_by),
      max_attempts = greatest(job.max_attempts, job.attempt_count + 1),
      cancel_requested_at = null,
      last_error_code = case
        when job.last_error_code = 'ready_engineering_commands_automation_disabled' then null
        else job.last_error_code
      end,
      last_error = case
        when job.last_error_code = 'ready_engineering_commands_automation_disabled' then null
        else job.last_error
      end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'source', 'manual_request',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.id = any(v_job_ids)
      and job.status in (
        'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
      );

    update public.ai_external_analysis_batches as batch
    set
      origin = 'manual',
      requested_by = coalesce(p_requested_by, batch.requested_by),
      updated_at = now()
    from (
      select distinct job.batch_key
      from public.ai_external_analysis_jobs as job
      where job.id = any(v_job_ids)
        and job.origin = 'manual'
        and job.batch_key is not null
        and job.status in (
          'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'
        )
    ) as promoted
    where batch.batch_key = promoted.batch_key
      and batch.status in ('queued', 'running', 'retry_scheduled');
  end if;

  return v_job_ids;
end;
$$;

create or replace function public.reset_external_analysis_command_preferences_controlled(
  p_article_id uuid,
  p_requested_by uuid,
  p_origin text default 'manual'
)
returns public.ai_external_analysis_article_state
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_origin text := lower(btrim(coalesce(p_origin, 'manual')));
  v_state public.ai_external_analysis_article_state%rowtype;
  v_default_command_ids text[] := public.get_external_analysis_default_command_ids();
begin
  if v_origin not in ('auto', 'manual') then
    raise exception 'unsupported external engineering origin %', p_origin;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ready-engineering-command-automation', 0));

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

  perform public.enqueue_external_engineering_jobs_controlled(
    p_article_id,
    p_requested_by,
    v_origin
  );

  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

  return v_state;
end;
$$;

-- Route the persisted-state trigger through the guarded coordinator. Manual
-- custom/default command RPCs still bypass the lifetime guard intentionally.
create or replace function public.reconcile_automatic_ready_engineering_commands_for_article(
  p_article_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := '{}'::jsonb;
  v_state public.ai_external_analysis_article_state%rowtype;
  v_keywords jsonb := '{}'::jsonb;
  v_has_secondaries boolean := false;
  v_has_lsi boolean := false;
  v_job_ids uuid[] := array[]::uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended('ready-engineering-command-automation', 0));
  v_settings := public.get_content_research_automation_settings();

  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

  if v_state.article_id is null then return v_job_ids; end if;

  if not v_state.external_analysis_ready then
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
    return v_job_ids;
  end if;

  if not coalesce((v_settings->>'autoRunReadyEngineeringCommands')::boolean, true) then
    perform public.cancel_automatic_ready_engineering_jobs(p_article_id);
    return v_job_ids;
  end if;

  update public.ai_external_analysis_jobs as job
  set
    cancel_requested_at = null,
    last_error_code = null,
    last_error = null,
    progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
      'stage', 'running',
      'source', 'ready_engineering_commands_automation_reenabled',
      'updatedAt', now()
    ),
    updated_at = now()
  where job.article_id = p_article_id
    and job.job_type = 'engineering_command'
    and job.origin = 'auto'
    and job.status = 'running'
    and job.last_error_code = 'ready_engineering_commands_automation_disabled';

  select coalesce(article.keywords, '{}'::jsonb)
  into v_keywords
  from public.articles as article
  where article.id = p_article_id;
  if not found then return v_job_ids; end if;

  v_has_secondaries := public.external_analysis_has_competitor_value(
    v_keywords->'secondaries',
    100
  );
  v_has_lsi := public.external_analysis_has_competitor_value(v_keywords->'lsi', 100);

  if (
    coalesce((v_settings->>'autoGenerateAlternativeKeywords')::boolean, true)
    and not v_has_secondaries
  ) or (
    coalesce((v_settings->>'autoGenerateLsiKeywords')::boolean, true)
    and not v_has_lsi
  ) then
    perform public.enqueue_external_semantic_analysis_job_controlled(p_article_id, 'auto');
    return v_job_ids;
  end if;

  if v_has_secondaries and v_has_lsi then
    v_job_ids := public.enqueue_external_engineering_jobs_controlled(
      p_article_id,
      null,
      'auto'
    );
  else
    perform public.cancel_stale_external_engineering_jobs(p_article_id, null, true);
  end if;

  return v_job_ids;
end;
$$;

-- Retry and resume are explicit user actions. Promote the canonical job and
-- its live batch to manual before returning it to the worker queue.
create or replace function public.retry_external_analysis_job(
  p_job_id uuid,
  p_requested_by uuid
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
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
        when job.status in (
          'running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused'
        ) then 1
        else 2
      end,
      coalesce(job.completed_at, job.updated_at, job.created_at) desc
    limit 1
    for update;
  end if;

  if v_job.id is null then
    raise exception 'canonical external analysis job was not found';
  end if;

  if v_job.status = 'completed' then return v_job; end if;

  if v_job.status in (
    'running', 'queued', 'retry_scheduled', 'waiting_for_prerequisites', 'paused'
  ) then
    update public.ai_external_analysis_jobs as job
    set
      origin = 'manual',
      requested_by = coalesce(p_requested_by, job.requested_by),
      max_attempts = greatest(job.max_attempts, job.attempt_count + 1),
      cancel_requested_at = null,
      updated_at = now()
    where job.id = v_job.id
    returning job.* into v_job;
  else
    if v_job.status not in ('failed', 'blocked', 'cancelled') then
      raise exception 'external analysis job % cannot be retried from status %', v_job.id, v_job.status;
    end if;

    update public.ai_external_analysis_jobs as job
    set
      origin = 'manual',
      requested_by = coalesce(p_requested_by, job.requested_by),
      max_attempts = greatest(job.max_attempts, job.attempt_count + 1),
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
  end if;

  update public.ai_external_analysis_batches as batch
  set
    origin = 'manual',
    requested_by = coalesce(p_requested_by, batch.requested_by),
    updated_at = now()
  where batch.batch_key = v_job.batch_key
    and batch.status in ('queued', 'running', 'retry_scheduled');

  return v_job;
end;
$$;

create or replace function public.resume_external_analysis_job_now(
  p_job_id uuid,
  p_requested_by uuid default null
)
returns public.ai_external_analysis_jobs
language plpgsql
security definer
set search_path = public, pg_temp
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

  if v_job.status = 'completed' then return v_job; end if;

  if v_job.status in ('running', 'queued', 'waiting_for_prerequisites', 'paused') then
    update public.ai_external_analysis_jobs as job
    set
      origin = 'manual',
      requested_by = coalesce(p_requested_by, job.requested_by),
      max_attempts = greatest(job.max_attempts, job.attempt_count + 1),
      cancel_requested_at = null,
      updated_at = now()
    where job.id = v_job.id
    returning job.* into v_job;
  else
    if v_job.status <> 'retry_scheduled' then
      raise exception 'external analysis job % cannot resume from status %', v_job.id, v_job.status;
    end if;

    update public.ai_external_analysis_jobs as job
    set
      origin = 'manual',
      requested_by = coalesce(p_requested_by, job.requested_by),
      max_attempts = greatest(job.max_attempts, job.attempt_count + 1),
      status = 'queued',
      next_attempt_at = now(),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      cancel_requested_at = null,
      last_error = null,
      last_error_code = null,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'queued',
        'source', 'manual_resume',
        'resumedJobId', job.id,
        'resumedAt', now(),
        'updatedAt', now()
      ),
      updated_at = now()
    where job.id = v_job.id
    returning job.* into v_job;
  end if;

  update public.ai_external_analysis_batches as batch
  set
    origin = 'manual',
    requested_by = coalesce(p_requested_by, batch.requested_by),
    updated_at = now()
  where batch.batch_key = v_job.batch_key
    and batch.status in ('queued', 'running', 'retry_scheduled');

  return v_job;
end;
$$;

revoke all on function public.find_external_analysis_stage_job(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.stamp_external_semantic_run_targets()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_external_semantic_analysis_job_by_signature(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_competitor_discovery_job_by_signature(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_external_engineering_jobs_sequential_base(uuid, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_external_engineering_jobs(uuid, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_external_semantic_analysis_job_controlled(uuid, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_competitor_discovery_job_controlled(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_external_engineering_jobs_controlled(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.reset_external_analysis_command_preferences_controlled(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.retry_external_analysis_job(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.resume_external_analysis_job_now(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.enqueue_external_semantic_analysis_job_controlled(uuid, text)
  to service_role;
grant execute on function public.enqueue_competitor_discovery_job_controlled(uuid, uuid, text)
  to service_role;
grant execute on function public.enqueue_external_engineering_jobs_controlled(uuid, uuid, text)
  to service_role;
grant execute on function public.reset_external_analysis_command_preferences_controlled(uuid, uuid, text)
  to service_role;
grant execute on function public.retry_external_analysis_job(uuid, uuid)
  to service_role;
grant execute on function public.resume_external_analysis_job_now(uuid, uuid)
  to service_role;

comment on function public.enqueue_external_semantic_analysis_job_controlled(uuid, text)
  is 'Attempts each enabled semantic keyword target automatically at most once per article; explicit manual retry paths remain available.';
comment on function public.enqueue_competitor_discovery_job_controlled(uuid, uuid, text)
  is 'Attempts competitor discovery automatically at most once per article; explicit manual retry paths remain available.';
comment on function public.enqueue_external_engineering_jobs_controlled(uuid, uuid, text)
  is 'Attempts each automatic ready-engineering command at most once per article; explicit manual retry paths remain available.';

notify pgrst, 'reload schema';

commit;
