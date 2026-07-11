-- Ordered global external-analysis commands with durable per-article overrides.

alter table public.ai_external_analysis_article_state
  add column if not exists engineering_command_mode text not null default 'default',
  add column if not exists custom_engineering_command_ids jsonb not null default '[]'::jsonb,
  add column if not exists engineering_command_selection_updated_by uuid references public.profiles(id) on delete set null,
  add column if not exists engineering_command_selection_updated_at timestamptz,
  add column if not exists external_analysis_last_command_selection_signature text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ai_external_analysis_article_state'::regclass
      and conname = 'ai_external_analysis_article_state_command_mode_check'
  ) then
    alter table public.ai_external_analysis_article_state
      add constraint ai_external_analysis_article_state_command_mode_check
      check (engineering_command_mode in ('default', 'custom'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ai_external_analysis_article_state'::regclass
      and conname = 'ai_external_analysis_article_state_custom_commands_check'
  ) then
    alter table public.ai_external_analysis_article_state
      add constraint ai_external_analysis_article_state_custom_commands_check
      check (jsonb_typeof(custom_engineering_command_ids) = 'array');
  end if;
end;
$$;

create or replace function public.external_analysis_command_catalog()
returns table (
  catalog_order integer,
  command_id text,
  command_label text
)
language sql
immutable
set search_path = public
as $$
  select *
  from (values
    (1, 'smartAnalysis.entityMap', 'Entity map'),
    (2, 'smartAnalysis.fullArticleAudit', 'Full article audit'),
    (3, 'smartAnalysis.contentSummaryForCompetitors', 'Content summary for competitors'),
    (4, 'smartAnalysis.competitorGapAnalysis', 'Compare content with competitors'),
    (5, 'smartAnalysis.competitorContentComparison', 'New or conflicting competitor ideas'),
    (6, 'smartAnalysis.combinedCommands', 'Commands bundle'),
    (7, 'smartAnalysis.improveConclusion', 'Improve conclusion'),
    (8, 'smartAnalysis.improveWeakest', 'Improve weakest section'),
    (9, 'smartAnalysis.suggestNewIdea', 'Suggest a new idea'),
    (10, 'smartAnalysis.peopleQuestions', 'People also ask'),
    (11, 'smartAnalysis.structuredContent', 'Structured content opportunities'),
    (12, 'smartAnalysis.unsuitableSections', 'Unsuitable sections'),
    (13, 'smartAnalysis.repetitionAndFillerAudit', 'Repetition and filler audit'),
    (14, 'smartAnalysis.articleSectionOrder', 'Section order analysis')
  ) as catalog(catalog_order, command_id, command_label)
  order by catalog.catalog_order;
$$;

insert into public.app_settings (key, value, description, is_secret)
values (
  'ai',
  '{"externalAnalysisDefaultCommandIds":["smartAnalysis.competitorContentComparison","smartAnalysis.competitorGapAnalysis","smartAnalysis.combinedCommands","smartAnalysis.repetitionAndFillerAudit","smartAnalysis.fullArticleAudit"]}'::jsonb,
  'Non-secret AI defaults. Secret API keys remain server environment variables.',
  false
)
on conflict (key) do nothing;

update public.app_settings
set value = jsonb_set(
  coalesce(value, '{}'::jsonb),
  '{externalAnalysisDefaultCommandIds}',
  case
    when jsonb_typeof(value->'externalAnalysisDefaultCommandIds') = 'array'
      and jsonb_array_length(value->'externalAnalysisDefaultCommandIds') > 0
      then value->'externalAnalysisDefaultCommandIds'
    else '["smartAnalysis.competitorContentComparison","smartAnalysis.competitorGapAnalysis","smartAnalysis.combinedCommands","smartAnalysis.repetitionAndFillerAudit","smartAnalysis.fullArticleAudit"]'::jsonb
  end,
  true
)
where key = 'ai';

create or replace function public.get_external_analysis_default_command_ids()
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_configured jsonb;
  v_command_ids text[] := array[]::text[];
  v_fallback text[] := array[
    'smartAnalysis.competitorContentComparison',
    'smartAnalysis.competitorGapAnalysis',
    'smartAnalysis.combinedCommands',
    'smartAnalysis.repetitionAndFillerAudit',
    'smartAnalysis.fullArticleAudit'
  ];
begin
  select setting.value->'externalAnalysisDefaultCommandIds'
  into v_configured
  from public.app_settings as setting
  where setting.key = 'ai'
    and setting.is_secret is not true
  limit 1;

  if jsonb_typeof(v_configured) <> 'array'
    or jsonb_array_length(v_configured) = 0 then
    return v_fallback;
  end if;

  select coalesce(array_agg(item.command_id order by item.first_position), array[]::text[])
  into v_command_ids
  from (
    select catalog.command_id, min(selected.position) as first_position
    from jsonb_array_elements_text(v_configured)
      with ordinality as selected(command_id, position)
    join public.external_analysis_command_catalog() as catalog
      on catalog.command_id = nullif(btrim(selected.command_id), '')
    group by catalog.command_id
  ) as item;

  if cardinality(v_command_ids) = 0 then
    return v_fallback;
  end if;

  return v_command_ids;
end;
$$;

create or replace function public.cancel_external_engineering_jobs_for_selection_change(
  p_article_id uuid,
  p_include_manual boolean default false
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
      last_error = 'The external analysis command selection changed before this command completed.',
      completed_at = case when job.status = 'running' then job.completed_at else now() end,
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', case when job.status = 'running' then 'cancel_requested' else 'cancelled' end,
        'reason', 'command_selection_changed',
        'updatedAt', now()
      ),
      updated_at = now()
    where job.article_id = p_article_id
      and job.job_type = 'engineering_command'
      and (job.origin = 'auto' or coalesce(p_include_manual, false))
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused')
    returning job.id, job.status
  ), closed_runs as (
    update public.ai_external_analysis_runs as run
    set
      status = 'cancelled',
      error_code = 'command_selection_changed',
      error_message = 'The external analysis command selection changed before this command completed.',
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

  if v_state.external_analysis_last_command_selection_signature is distinct from v_selection_signature then
    perform public.cancel_external_engineering_jobs_for_selection_change(p_article_id, false);
  end if;

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

  v_batch_key := 'external-engineering:'
    || v_article.id::text || ':'
    || v_state.external_analysis_readiness_signature || ':'
    || v_selection_signature;

  if v_state.external_analysis_last_enqueued_signature = v_state.external_analysis_readiness_signature
    and v_state.external_analysis_last_command_selection_signature = v_selection_signature
    and (
      select count(distinct job.command_id)
      from public.ai_external_analysis_jobs as job
      where job.article_id = v_article.id
        and job.batch_key = v_batch_key
        and job.job_type = 'engineering_command'
        and job.status = 'completed'
    ) = v_command_count then
    return v_job_ids;
  end if;

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
      || v_state.external_analysis_readiness_signature || ':'
      || v_selection_signature;
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
      updated_at = now()
    where state.article_id = v_article.id;
  end if;

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
begin
  select state.*
  into v_state
  from public.ai_external_analysis_article_state as state
  where state.article_id = p_article_id;

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

  perform public.cancel_external_engineering_jobs_for_selection_change(p_article_id, false);

  update public.ai_external_analysis_article_state as state
  set
    engineering_command_mode = 'custom',
    custom_engineering_command_ids = to_jsonb(v_command_ids),
    engineering_command_selection_updated_by = p_requested_by,
    engineering_command_selection_updated_at = now(),
    external_analysis_last_command_selection_signature = null,
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
begin
  if not exists (
    select 1
    from public.ai_external_analysis_article_state as state
    where state.article_id = p_article_id
  ) then
    raise exception 'external analysis state is not available for article %', p_article_id;
  end if;

  perform public.cancel_external_engineering_jobs_for_selection_change(p_article_id, true);

  update public.ai_external_analysis_article_state as state
  set
    engineering_command_mode = 'default',
    custom_engineering_command_ids = '[]'::jsonb,
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

create or replace function public.apply_external_analysis_default_commands()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_commands jsonb := case
    when tg_op = 'UPDATE' then old.value->'externalAnalysisDefaultCommandIds'
    else null
  end;
  v_new_commands jsonb := new.value->'externalAnalysisDefaultCommandIds';
  v_article_id uuid;
begin
  if tg_op = 'INSERT' or v_old_commands is distinct from v_new_commands then
    for v_article_id in
      select state.article_id
      from public.ai_external_analysis_article_state as state
      where state.engineering_command_mode = 'default'
        and state.external_analysis_ready
      order by state.created_at
    loop
      perform public.enqueue_external_engineering_jobs(v_article_id);
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists apply_external_analysis_default_commands on public.app_settings;
create trigger apply_external_analysis_default_commands
after insert or update of value
on public.app_settings
for each row
when (new.key = 'ai')
execute function public.apply_external_analysis_default_commands();

revoke all on function public.external_analysis_command_catalog() from public;
revoke all on function public.get_external_analysis_default_command_ids() from public;
revoke all on function public.cancel_external_engineering_jobs_for_selection_change(uuid, boolean) from public;
revoke all on function public.enqueue_external_engineering_jobs(uuid) from public;
revoke all on function public.set_external_analysis_custom_commands(uuid, uuid, jsonb) from public;
revoke all on function public.reset_external_analysis_command_preferences(uuid, uuid) from public;
revoke all on function public.apply_external_analysis_default_commands() from public;

grant execute on function public.get_external_analysis_default_command_ids() to service_role;
grant execute on function public.cancel_external_engineering_jobs_for_selection_change(uuid, boolean) to service_role;
grant execute on function public.enqueue_external_engineering_jobs(uuid) to service_role;
grant execute on function public.set_external_analysis_custom_commands(uuid, uuid, jsonb) to service_role;
grant execute on function public.reset_external_analysis_command_preferences(uuid, uuid) to service_role;

comment on function public.get_external_analysis_default_command_ids() is 'Returns the validated ordered global command list for external analysis.';
comment on function public.set_external_analysis_custom_commands(uuid, uuid, jsonb) is 'Persists an ordered article-specific command selection and exempts the article from global defaults.';
comment on function public.reset_external_analysis_command_preferences(uuid, uuid) is 'Removes an article-specific command selection and restores the current admin defaults.';
comment on function public.enqueue_external_engineering_jobs(uuid) is 'Creates the ordered global or article-specific external engineering command chain.';
