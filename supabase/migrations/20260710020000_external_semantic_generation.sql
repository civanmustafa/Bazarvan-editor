-- External analysis phase 3: enqueue semantic jobs and persist worker progress.

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

  v_has_secondaries := jsonb_typeof(v_article.keywords->'secondaries') = 'array'
    and exists (
      select 1
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(v_article.keywords->'secondaries') = 'array'
            then v_article.keywords->'secondaries'
          else '[]'::jsonb
        end
      ) as item(value)
      where nullif(btrim(item.value), '') is not null
    );
  v_has_lsi := jsonb_typeof(v_article.keywords->'lsi') = 'array'
    and exists (
      select 1
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(v_article.keywords->'lsi') = 'array'
            then v_article.keywords->'lsi'
          else '[]'::jsonb
        end
      ) as item(value)
      where nullif(btrim(item.value), '') is not null
    );

  if v_has_secondaries and v_has_lsi then
    return null;
  end if;

  if v_state.semantic_last_enqueued_signature = v_state.semantic_readiness_signature then
    return null;
  end if;

  v_idempotency_key := 'semantic_keywords_lsi:' || v_state.semantic_readiness_signature;

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
  on conflict (article_id, idempotency_key)
    where status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select job.id
    into v_job_id
    from public.ai_external_analysis_jobs as job
    where job.article_id = v_article.id
      and job.idempotency_key = v_idempotency_key
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    order by job.created_at desc
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

create or replace function public.enqueue_external_semantic_analysis_job_from_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.semantic_ready then
    perform public.enqueue_external_semantic_analysis_job(new.article_id);
  end if;
  return new;
end;
$$;

drop trigger if exists enqueue_external_semantic_analysis_job on public.ai_external_analysis_article_state;
create trigger enqueue_external_semantic_analysis_job
after insert or update of semantic_ready, semantic_readiness_signature
on public.ai_external_analysis_article_state
for each row execute function public.enqueue_external_semantic_analysis_job_from_state();

create or replace function public.update_external_analysis_job_progress(
  p_job_id uuid,
  p_worker_id text,
  p_progress jsonb default '{}'::jsonb,
  p_provider text default null,
  p_model text default null,
  p_key_attempts jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt_count integer;
begin
  if p_key_attempts is not null and jsonb_typeof(p_key_attempts) <> 'array' then
    raise exception 'key attempts must be a JSON array' using errcode = '22023';
  end if;

  update public.ai_external_analysis_jobs as job
  set
    progress = coalesce(job.progress, '{}'::jsonb)
      || coalesce(p_progress, '{}'::jsonb)
      || jsonb_build_object('updatedAt', now()),
    updated_at = now()
  where job.id = p_job_id
    and job.status = 'running'
    and job.locked_by = btrim(coalesce(p_worker_id, ''))
  returning job.attempt_count into v_attempt_count;

  if not found then
    return false;
  end if;

  update public.ai_external_analysis_runs as run
  set
    provider = coalesce(nullif(btrim(coalesce(p_provider, '')), ''), run.provider),
    model = coalesce(nullif(btrim(coalesce(p_model, '')), ''), run.model),
    progress = coalesce(run.progress, '{}'::jsonb) || coalesce(p_progress, '{}'::jsonb),
    key_attempts = case
      when p_key_attempts is null then run.key_attempts
      else p_key_attempts
    end
  where run.job_id = p_job_id
    and run.run_number = v_attempt_count
    and run.status = 'running';

  return true;
end;
$$;

revoke all on function public.enqueue_external_semantic_analysis_job(uuid) from public;
revoke all on function public.enqueue_external_semantic_analysis_job_from_state() from public;
revoke all on function public.update_external_analysis_job_progress(uuid, text, jsonb, text, text, jsonb) from public;
grant execute on function public.enqueue_external_semantic_analysis_job(uuid) to service_role;
grant execute on function public.update_external_analysis_job_progress(uuid, text, jsonb, text, text, jsonb) to service_role;

comment on function public.enqueue_external_semantic_analysis_job(uuid) is 'Creates one automatic semantic keyword job for a ready article with empty target fields.';
comment on function public.update_external_analysis_job_progress(uuid, text, jsonb, text, text, jsonb) is 'Persists external analysis progress and sanitized key attempts for the active run.';

do $$
declare
  v_article_id uuid;
begin
  for v_article_id in
    select state.article_id
    from public.ai_external_analysis_article_state as state
    where state.semantic_ready
  loop
    perform public.enqueue_external_semantic_analysis_job(v_article_id);
  end loop;
end;
$$;
