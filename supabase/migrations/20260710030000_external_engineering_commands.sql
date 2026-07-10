-- External analysis phase 4: enqueue the first five ready commands in sequence.

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
begin
  with cancelled as (
    update public.ai_external_analysis_jobs as job
    set
      status = 'cancelled',
      cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      next_attempt_at = null,
      last_error_code = 'external_readiness_changed',
      last_error = 'The external analysis inputs changed before this command completed.',
      completed_at = now(),
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'cancelled',
        'reason', 'external_readiness_changed',
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
      error_code = 'external_readiness_changed',
      error_message = 'The external analysis inputs changed before this command completed.',
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

  perform public.cancel_stale_external_engineering_jobs(
    p_article_id,
    v_state.external_analysis_readiness_signature,
    false
  );

  v_semantic_ready := public.external_analysis_has_competitor_value(
    v_article.keywords->'secondaries',
    100
  ) and public.external_analysis_has_competitor_value(
    v_article.keywords->'lsi',
    100
  );

  if not v_semantic_ready then
    perform public.enqueue_external_semantic_analysis_job(p_article_id);
    select job.id
    into v_semantic_job_id
    from public.ai_external_analysis_jobs as job
    where job.article_id = p_article_id
      and job.job_type = 'semantic_keywords_lsi'
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    order by job.created_at desc
    limit 1;
  end if;

  v_batch_key := 'external-engineering:' || v_article.id::text || ':' || v_state.external_analysis_readiness_signature;

  if v_state.external_analysis_last_enqueued_signature = v_state.external_analysis_readiness_signature
    and (
      select count(distinct job.command_id)
      from public.ai_external_analysis_jobs as job
      where job.article_id = v_article.id
        and job.batch_key = v_batch_key
        and job.job_type = 'engineering_command'
        and job.status = 'completed'
    ) = 5 then
    return v_job_ids;
  end if;

  for v_command in
    select *
    from (values
      (1, 'smartAnalysis.competitorContentComparison', 'New or conflicting competitor ideas'),
      (2, 'smartAnalysis.competitorGapAnalysis', 'Compare content with competitors'),
      (3, 'smartAnalysis.combinedCommands', 'Commands bundle'),
      (4, 'smartAnalysis.repetitionAndFillerAudit', 'Repetition and filler audit'),
      (5, 'smartAnalysis.fullArticleAudit', 'Full article audit')
    ) as command(sequence_number, command_id, command_label)
    order by command.sequence_number
  loop
    v_job_id := null;
    v_job_status := null;
    v_idempotency_key := 'engineering:' || v_command.command_id || ':' || v_state.external_analysis_readiness_signature;
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

    select job.id, job.status
    into v_job_id, v_job_status
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_article.id
      and job.batch_key = v_batch_key
      and job.command_id = v_command.command_id
      and job.status in (
        'waiting_for_prerequisites',
        'queued',
        'running',
        'retry_scheduled',
        'paused',
        'completed'
      )
    order by job.created_at desc
    limit 1;

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
        coalesce(v_article.assigned_to, v_article.owner_id, v_article.created_by),
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
          'commandSequence', v_command.sequence_number,
          'commandId', v_command.command_id
        ),
        jsonb_build_object(
          'stage', v_initial_status,
          'commandSequence', v_command.sequence_number,
          'commandTotal', 5,
          'updatedAt', now()
        ),
        case when v_initial_status = 'queued' then now() else null end
      )
      on conflict (article_id, idempotency_key)
        where status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      do nothing
      returning id, status into v_job_id, v_job_status;
    end if;

    if v_job_id is null then
      select job.id, job.status
      into v_job_id, v_job_status
      from public.ai_external_analysis_jobs as job
      where job.article_id = v_article.id
        and job.idempotency_key = v_idempotency_key
        and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
      order by job.created_at desc
      limit 1;
    end if;

    if v_job_id is null then
      raise exception 'could not create external engineering command %', v_command.command_id;
    end if;

    if v_job_id is not null
      and v_job_status = 'waiting_for_prerequisites'
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
    elsif v_job_id is not null
      and v_job_status in ('queued', 'paused') then
      update public.ai_external_analysis_jobs as job
      set
        depends_on_job_id = v_dependency_id,
        updated_at = now()
      where job.id = v_job_id;
    end if;

    if v_job_id is not null then
      v_job_ids := array_append(v_job_ids, v_job_id);
      v_previous_job_id := v_job_id;
    end if;
  end loop;

  if cardinality(v_job_ids) = 5 then
    update public.ai_external_analysis_article_state as state
    set
      external_analysis_last_enqueued_signature = v_state.external_analysis_readiness_signature,
      updated_at = now()
    where state.article_id = v_article.id;
  end if;

  return v_job_ids;
end;
$$;

create or replace function public.enqueue_external_engineering_jobs_from_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.external_analysis_ready then
    perform public.enqueue_external_engineering_jobs(new.article_id);
  else
    perform public.cancel_stale_external_engineering_jobs(new.article_id, null, true);
  end if;
  return new;
end;
$$;

drop trigger if exists enqueue_external_engineering_jobs on public.ai_external_analysis_article_state;
create trigger enqueue_external_engineering_jobs
after insert or update of external_analysis_ready, external_analysis_readiness_signature
on public.ai_external_analysis_article_state
for each row execute function public.enqueue_external_engineering_jobs_from_state();

revoke all on function public.cancel_stale_external_engineering_jobs(uuid, text, boolean) from public;
revoke all on function public.enqueue_external_engineering_jobs(uuid) from public;
revoke all on function public.enqueue_external_engineering_jobs_from_state() from public;
grant execute on function public.cancel_stale_external_engineering_jobs(uuid, text, boolean) to service_role;
grant execute on function public.enqueue_external_engineering_jobs(uuid) to service_role;

comment on function public.enqueue_external_engineering_jobs(uuid) is 'Creates the first five external engineering commands as one sequential dependency chain.';
comment on function public.cancel_stale_external_engineering_jobs(uuid, text, boolean) is 'Cancels automatic engineering commands whose external readiness input is no longer current.';

do $$
declare
  v_article_id uuid;
begin
  for v_article_id in
    select state.article_id
    from public.ai_external_analysis_article_state as state
    where state.external_analysis_ready
  loop
    perform public.enqueue_external_engineering_jobs(v_article_id);
  end loop;
end;
$$;
