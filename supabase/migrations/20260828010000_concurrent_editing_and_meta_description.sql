begin;

-- SEO description is canonical article data and is also copied into the
-- corresponding content version so restores and audits retain the exact value.
alter table public.articles
  add column if not exists meta_description text not null default '',
  add column if not exists meta_description_source text,
  add column if not exists meta_description_generated_at timestamptz,
  add column if not exists meta_description_signature text,
  add column if not exists meta_description_job_id uuid
    references public.ai_external_analysis_jobs(id) on delete set null;

alter table public.articles
  drop constraint if exists articles_meta_description_length_check,
  drop constraint if exists articles_meta_description_source_check;
alter table public.articles
  add constraint articles_meta_description_length_check
    check (char_length(meta_description) <= 500),
  add constraint articles_meta_description_source_check
    check (meta_description_source is null or meta_description_source in ('manual', 'automatic'));

alter table public.article_versions
  add column if not exists meta_description text not null default '';
alter table public.article_versions
  drop constraint if exists article_versions_meta_description_length_check;
alter table public.article_versions
  add constraint article_versions_meta_description_length_check
    check (char_length(meta_description) <= 500);

-- Register the durable automatic task in the shared external-analysis queue.
alter table public.ai_external_analysis_jobs
  drop constraint if exists ai_external_analysis_jobs_job_type_check;
alter table public.ai_external_analysis_jobs
  drop constraint if exists ai_external_analysis_jobs_command_shape_check;

alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_job_type_check
  check (job_type in (
    'semantic_keywords_lsi',
    'content_brief_generation',
    'meta_description_generation',
    'full_article_pipeline',
    'content_writing_preparation',
    'engineering_command',
    'competitor_discovery',
    'competitor_extraction'
  ));

alter table public.ai_external_analysis_jobs
  add constraint ai_external_analysis_jobs_command_shape_check
  check (
    (
      job_type in (
        'semantic_keywords_lsi',
        'content_brief_generation',
        'meta_description_generation',
        'full_article_pipeline',
        'content_writing_preparation',
        'competitor_discovery',
        'competitor_extraction'
      )
      and command_id is null
    )
    or (
      job_type = 'engineering_command'
      and nullif(btrim(command_id), '') is not null
    )
  );

insert into public.app_settings (key, value, description, is_secret)
values (
  'system',
  jsonb_build_object('autoGenerateMetaDescription', true),
  'General application and content automation settings.',
  false
)
on conflict (key) do update
set value = jsonb_build_object('autoGenerateMetaDescription', true)
      || coalesce(public.app_settings.value, '{}'::jsonb),
    updated_at = now();

create or replace function public.article_meta_description_signature(
  p_title text,
  p_content_html text,
  p_plain_text text,
  p_keywords jsonb,
  p_goal_context jsonb,
  p_article_language text
)
returns text
language sql
immutable
set search_path = public
as $$
  select md5(jsonb_build_object(
    'title', coalesce(p_title, ''),
    'contentHtml', coalesce(p_content_html, ''),
    'plainText', coalesce(p_plain_text, ''),
    'primaryKeyword', coalesce(p_keywords->>'primary', ''),
    'goalContext', coalesce(p_goal_context, '{}'::jsonb),
    'articleLanguage', case when p_article_language = 'en' then 'en' else 'ar' end
  )::text);
$$;

create or replace function public.meta_description_automation_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when jsonb_typeof(setting.value->'autoGenerateMetaDescription') = 'boolean'
      then (setting.value->>'autoGenerateMetaDescription')::boolean
    else true
  end
  from (select coalesce((
    select value from public.app_settings
    where key = 'system' and not is_secret
    limit 1
  ), '{}'::jsonb) as value) as setting;
$$;

create or replace function public.enqueue_article_meta_description_generation(
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
  v_article public.articles%rowtype;
  v_job public.ai_external_analysis_jobs%rowtype;
  v_signature text;
  v_missing jsonb := '[]'::jsonb;
  v_primary_keyword text;
  v_status text;
  v_idempotency_key text;
begin
  if not public.meta_description_automation_enabled() then return null; end if;

  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id
  for update;
  if not found or v_article.status <> 'in_review' then return null; end if;

  v_primary_keyword := btrim(coalesce(v_article.keywords->>'primary', ''));
  if nullif(btrim(coalesce(v_article.title, '')), '') is null
     or lower(btrim(coalesce(v_article.title, ''))) in ('(untitled)', 'untitled') then
    v_missing := v_missing || jsonb_build_array('article_title');
  end if;
  if nullif(v_primary_keyword, '') is null then
    v_missing := v_missing || jsonb_build_array('primary_keyword');
  end if;
  if nullif(btrim(coalesce(v_article.content_html, '')), '') is null
     or coalesce(v_article.content_html, '') !~* '<h[2-4]([ >])' then
    v_missing := v_missing || jsonb_build_array('table_of_contents');
  end if;
  if nullif(btrim(coalesce(v_article.goal_context->>'pageType', '')), '') is null
     and nullif(btrim(coalesce(v_article.goal_context->>'objective', '')), '') is null
     and nullif(btrim(coalesce(v_article.goal_context->>'generatedBrief', '')), '') is null then
    v_missing := v_missing || jsonb_build_array('goal_context');
  end if;

  v_signature := public.article_meta_description_signature(
    v_article.title,
    v_article.content_html,
    v_article.plain_text,
    v_article.keywords,
    v_article.goal_context,
    v_article.article_language
  );
  if nullif(btrim(v_article.meta_description), '') is not null
     and v_article.meta_description_signature = v_signature then
    return v_article.meta_description_job_id;
  end if;

  select job.* into v_job
  from public.ai_external_analysis_jobs as job
  where job.article_id = v_article.id
    and job.job_type = 'meta_description_generation'
    and job.readiness_signature = v_signature
    and job.status in (
      'waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused', 'completed'
    )
  order by job.created_at desc
  limit 1;
  if found then return v_job.id; end if;

  update public.ai_external_analysis_jobs as job
  set status = 'cancelled',
      completed_at = now(),
      next_attempt_at = null,
      last_error_code = 'meta_description_source_superseded',
      last_error = 'The article inputs changed before this meta description task started.',
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'cancelled', 'reason', 'article_inputs_changed', 'updatedAt', now()
      ),
      updated_at = now()
  where job.article_id = v_article.id
    and job.job_type = 'meta_description_generation'
    and job.status in ('waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused')
    and job.readiness_signature is distinct from v_signature;

  update public.ai_external_analysis_jobs as job
  set cancel_requested_at = coalesce(job.cancel_requested_at, now()),
      last_error_code = 'meta_description_source_superseded',
      progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
        'stage', 'cancel_requested', 'reason', 'article_inputs_changed', 'updatedAt', now()
      ),
      updated_at = now()
  where job.article_id = v_article.id
    and job.job_type = 'meta_description_generation'
    and job.status = 'running'
    and job.readiness_signature is distinct from v_signature;

  v_status := case when jsonb_array_length(v_missing) = 0
    then 'queued' else 'waiting_for_prerequisites' end;
  v_idempotency_key := 'meta-description:' || v_signature;

  insert into public.ai_external_analysis_jobs (
    article_id,
    requested_by,
    job_type,
    origin,
    status,
    idempotency_key,
    sequence_number,
    readiness_signature,
    input_snapshot,
    progress,
    next_attempt_at
  ) values (
    v_article.id,
    coalesce(p_requested_by, v_article.assigned_to, v_article.owner_id, v_article.created_by),
    'meta_description_generation',
    case when lower(btrim(coalesce(p_origin, 'auto'))) = 'manual' then 'manual' else 'auto' end,
    v_status,
    v_idempotency_key,
    0,
    v_signature,
    jsonb_build_object(
      'sourceSignature', v_signature,
      'missingFields', v_missing,
      'primaryKeyword', v_primary_keyword,
      'articleUpdatedAt', v_article.updated_at
    ),
    jsonb_build_object(
      'stage', v_status,
      'missingFields', v_missing,
      'message', case when v_status = 'queued'
        then 'Meta description generation is queued.'
        else 'Meta description generation is waiting for article inputs.' end,
      'updatedAt', now()
    ),
    case when v_status = 'queued' then now() else null end
  )
  returning * into v_job;
  return v_job.id;
end;
$$;

create or replace function public.enqueue_article_meta_description_from_article()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_should_enqueue boolean := false;
begin
  if new.status = 'in_review' then
    if tg_op = 'INSERT' then
      v_should_enqueue := true;
    else
      v_should_enqueue := old.status is distinct from new.status or exists (
        select 1 from public.ai_external_analysis_jobs as job
        where job.article_id = new.id
          and job.job_type = 'meta_description_generation'
          and job.status = 'waiting_for_prerequisites'
      );
    end if;
  end if;

  if v_should_enqueue then
    perform public.enqueue_article_meta_description_generation(
      new.id,
      coalesce(new.assigned_to, new.owner_id, new.created_by),
      'auto'
    );
  elsif tg_op = 'UPDATE' and old.status = 'in_review' and new.status <> 'in_review' then
    update public.ai_external_analysis_jobs as job
    set status = case when job.status = 'running' then job.status else 'cancelled' end,
        cancel_requested_at = case when job.status = 'running'
          then coalesce(job.cancel_requested_at, now()) else job.cancel_requested_at end,
        completed_at = case when job.status = 'running' then job.completed_at else now() end,
        next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
        last_error_code = 'article_left_ready_status',
        last_error = 'The article is no longer in the ready state.',
        progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', case when job.status = 'running' then 'cancel_requested' else 'cancelled' end,
          'reason', 'article_left_ready_status', 'updatedAt', now()
        ),
        updated_at = now()
    where job.article_id = new.id
      and job.job_type = 'meta_description_generation'
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');
  end if;
  return new;
end;
$$;

drop trigger if exists enqueue_article_meta_description_from_article on public.articles;
create trigger enqueue_article_meta_description_from_article
after insert or update of status, title, content_html, plain_text, keywords, goal_context
on public.articles
for each row execute function public.enqueue_article_meta_description_from_article();

create or replace function public.reconcile_meta_description_automation_from_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_article_id uuid;
  v_enabled boolean;
begin
  if new.key <> 'system'
     or new.value->'autoGenerateMetaDescription'
        is not distinct from old.value->'autoGenerateMetaDescription' then
    return new;
  end if;
  v_enabled := case
    when jsonb_typeof(new.value->'autoGenerateMetaDescription') = 'boolean'
      then (new.value->>'autoGenerateMetaDescription')::boolean
    else true
  end;
  if v_enabled then
    for v_article_id in
      select id from public.articles where status = 'in_review'
    loop
      perform public.enqueue_article_meta_description_generation(v_article_id, null, 'auto');
    end loop;
  else
    update public.ai_external_analysis_jobs as job
    set status = case when job.status = 'running' then job.status else 'cancelled' end,
        cancel_requested_at = case when job.status = 'running'
          then coalesce(job.cancel_requested_at, now()) else job.cancel_requested_at end,
        completed_at = case when job.status = 'running' then job.completed_at else now() end,
        next_attempt_at = case when job.status = 'running' then job.next_attempt_at else null end,
        last_error_code = 'meta_description_automation_disabled',
        last_error = 'Automatic meta description generation was disabled by an administrator.',
        progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
          'stage', case when job.status = 'running' then 'cancel_requested' else 'cancelled' end,
          'reason', 'automation_disabled', 'updatedAt', now()
        ),
        updated_at = now()
    where job.job_type = 'meta_description_generation'
      and job.origin = 'auto'
      and job.status in ('waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused');
  end if;
  return new;
end;
$$;

drop trigger if exists reconcile_meta_description_automation_from_settings on public.app_settings;
create trigger reconcile_meta_description_automation_from_settings
after update of value on public.app_settings
for each row
when (new.key = 'system')
execute function public.reconcile_meta_description_automation_from_settings();

-- Fenced worker apply: the AI result is accepted only for the exact article
-- revision and the currently-owned queue lease that produced it.
create or replace function public.apply_generated_article_meta_description(
  p_job_id uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_article_id uuid,
  p_expected_updated_at timestamptz,
  p_source_signature text,
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_external_analysis_jobs%rowtype;
  v_article public.articles%rowtype;
  v_description text := regexp_replace(btrim(coalesce(p_description, '')), '[[:space:]]+', ' ', 'g');
  v_primary_keyword text;
  v_current_signature text;
begin
  select job.* into v_job
  from public.ai_external_analysis_jobs as job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.article_id <> p_article_id
     or v_job.job_type <> 'meta_description_generation'
     or v_job.status <> 'running'
     or v_job.locked_by is distinct from p_worker_id
     or coalesce(v_job.lease_generation, 0) <> coalesce(p_lease_generation, 0)
     or v_job.lease_expires_at is null
     or v_job.lease_expires_at <= now()
     or v_job.cancel_requested_at is not null then
    return jsonb_build_object('applied', false, 'reason', 'job_lease_changed');
  end if;
  if char_length(v_description) < 140 or char_length(v_description) > 150 then
    raise exception 'Meta description must contain 140 to 150 characters.' using errcode = '22023';
  end if;

  select article.* into v_article
  from public.articles as article
  where article.id = p_article_id
  for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'article_not_found'); end if;
  if v_article.status <> 'in_review' then
    return jsonb_build_object('applied', false, 'reason', 'article_is_not_ready');
  end if;
  if v_article.updated_at is distinct from p_expected_updated_at then
    return jsonb_build_object('applied', false, 'reason', 'article_changed_before_apply');
  end if;
  v_primary_keyword := btrim(coalesce(v_article.keywords->>'primary', ''));
  if nullif(v_primary_keyword, '') is null
     or position(lower(v_primary_keyword) in lower(v_description)) = 0 then
    raise exception 'Meta description must include the primary keyword.' using errcode = '22023';
  end if;
  v_current_signature := public.article_meta_description_signature(
    v_article.title,
    v_article.content_html,
    v_article.plain_text,
    v_article.keywords,
    v_article.goal_context,
    v_article.article_language
  );
  if v_current_signature is distinct from p_source_signature then
    return jsonb_build_object('applied', false, 'reason', 'article_signature_changed');
  end if;

  update public.articles as article
  set meta_description = v_description,
      meta_description_source = 'automatic',
      meta_description_generated_at = now(),
      meta_description_signature = p_source_signature,
      meta_description_job_id = p_job_id,
      last_saved_at = now()
  where article.id = v_article.id
  returning article.* into v_article;

  update public.article_versions as version
  set meta_description = v_description
  where version.article_id = v_article.id
    and version.version_number = v_article.save_count;

  return jsonb_build_object(
    'applied', true,
    'articleUpdatedAt', v_article.updated_at,
    'lastSavedAt', v_article.last_saved_at,
    'metaDescriptionGeneratedAt', v_article.meta_description_generated_at
  );
end;
$$;

-- Seven-argument canonical save function. Every existing-article save is
-- optimistic: the server revision must match unless the user explicitly chose
-- to overwrite after seeing the conflict warning.
create or replace function public.save_article_snapshot_with_content_policy(
  p_article_id uuid,
  p_idempotency_key text,
  p_snapshot jsonb,
  p_save_reason text,
  p_allow_empty_body boolean,
  p_expected_last_saved_at timestamptz,
  p_force_overwrite boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_snapshot jsonb := p_snapshot;
  v_article public.articles%rowtype;
  v_saved_article public.articles%rowtype;
  v_keywords jsonb;
  v_goal_context jsonb;
  v_result jsonb;
  v_result_article_id uuid;
  v_version integer;
  v_meta_description text;
  v_meta_changed boolean := false;
  v_reason text := lower(btrim(coalesce(p_save_reason, 'manual')));
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9:_-]{16,160}$' then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;
  if v_snapshot is null or jsonb_typeof(v_snapshot) <> 'object' then
    raise exception 'Article snapshot must be a JSON object.' using errcode = '22023';
  end if;
  if v_reason not in ('manual', 'auto', 'lifecycle', 'recovery') then
    raise exception 'Unsupported article save reason.' using errcode = '22023';
  end if;
  if coalesce(p_force_overwrite, false) and v_reason not in ('manual', 'recovery') then
    raise exception 'Only an explicit manual or recovery save may overwrite a newer revision.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_user_id::text || ':' || p_idempotency_key, 0)
  );
  if exists (
    select 1 from public.article_save_requests as request
    where request.user_id = v_user_id
      and request.idempotency_key = p_idempotency_key
  ) then
    return public.save_article_snapshot(
      p_article_id, p_idempotency_key, v_snapshot, v_reason
    );
  end if;

  if p_article_id is not null then
    select article.* into v_article
    from public.articles as article
    where article.id = p_article_id
    for update;
    if not found then
      raise exception 'Article was not found.' using errcode = 'P0002';
    end if;
    if public.article_access_level_for_user(v_article.id, v_user_id) not in ('write', 'admin') then
      raise exception 'You do not have permission to update this article.' using errcode = '42501';
    end if;
    if not coalesce(p_force_overwrite, false)
       and (
         p_expected_last_saved_at is null
         or v_article.last_saved_at is distinct from p_expected_last_saved_at
       ) then
      return jsonb_build_object(
        'article', to_jsonb(v_article),
        'versionNumber', v_article.save_count,
        'replayed', false,
        case when v_reason in ('auto', 'lifecycle')
          then 'staleBackgroundSave' else 'concurrentEditConflict' end,
        true,
        'staleReason', 'article_revision_changed_since_editor_load',
        'serverLastSavedAt', v_article.last_saved_at
      );
    end if;

    if v_reason in ('auto', 'lifecycle') then
      v_keywords := case when jsonb_typeof(v_snapshot->'keywords') = 'object'
        then v_snapshot->'keywords' else '{}'::jsonb end;
      if jsonb_array_length(case when jsonb_typeof(v_keywords->'secondaries') = 'array'
          then v_keywords->'secondaries' else '[]'::jsonb end) = 0
         and jsonb_array_length(case when jsonb_typeof(v_article.keywords->'secondaries') = 'array'
          then v_article.keywords->'secondaries' else '[]'::jsonb end) > 0 then
        v_keywords := jsonb_set(v_keywords, '{secondaries}', v_article.keywords->'secondaries', true);
      end if;
      if jsonb_array_length(case when jsonb_typeof(v_keywords->'lsi') = 'array'
          then v_keywords->'lsi' else '[]'::jsonb end) = 0
         and jsonb_array_length(case when jsonb_typeof(v_article.keywords->'lsi') = 'array'
          then v_article.keywords->'lsi' else '[]'::jsonb end) > 0 then
        v_keywords := jsonb_set(v_keywords, '{lsi}', v_article.keywords->'lsi', true);
      end if;
      v_snapshot := jsonb_set(v_snapshot, '{keywords}', v_keywords, true);

      v_goal_context := case when jsonb_typeof(v_snapshot->'goalContext') = 'object'
        then v_snapshot->'goalContext' else '{}'::jsonb end;
      if nullif(btrim(coalesce(v_goal_context->>'generatedBrief', '')), '') is null
         and nullif(btrim(coalesce(v_article.goal_context->>'generatedBrief', '')), '') is not null then
        v_goal_context := jsonb_set(
          v_goal_context,
          '{generatedBrief}',
          to_jsonb(v_article.goal_context->>'generatedBrief'),
          true
        );
      end if;
      v_snapshot := jsonb_set(v_snapshot, '{goalContext}', v_goal_context, true);
    end if;
  end if;

  if coalesce(p_allow_empty_body, false) then
    if p_article_id is null then
      raise exception 'Only an existing article body can be explicitly cleared.' using errcode = '22023';
    end if;
    if public.article_body_has_content(
      v_snapshot->'content', v_snapshot->>'contentHtml', v_snapshot->>'plainText'
    ) then
      raise exception 'An explicit body clear must contain an empty article body.' using errcode = '22023';
    end if;
    perform set_config('app.allow_empty_article_body', 'on', true);
  end if;

  v_meta_description := regexp_replace(
    btrim(coalesce(v_snapshot->>'metaDescription', '')),
    '[[:space:]]+', ' ', 'g'
  );
  if char_length(v_meta_description) > 500 then
    raise exception 'Meta description is too long.' using errcode = '22023';
  end if;
  v_meta_changed := p_article_id is null
    or v_article.meta_description is distinct from v_meta_description;

  v_result := public.save_article_snapshot(
    p_article_id, p_idempotency_key, v_snapshot, v_reason
  );
  v_result_article_id := nullif(v_result #>> '{article,id}', '')::uuid;
  v_version := coalesce((v_result->>'versionNumber')::integer, 1);
  if v_result_article_id is null then return v_result; end if;

  update public.articles as article
  set meta_description = v_meta_description,
      meta_description_source = case
        when v_meta_changed and nullif(v_meta_description, '') is not null then 'manual'
        when v_meta_changed then null
        else article.meta_description_source
      end,
      meta_description_generated_at = case
        when v_meta_changed then null else article.meta_description_generated_at end,
      meta_description_signature = case
        when v_meta_changed then null else article.meta_description_signature end,
      meta_description_job_id = case
        when v_meta_changed then null else article.meta_description_job_id end
  where article.id = v_result_article_id
  returning article.* into v_saved_article;

  update public.article_versions as version
  set meta_description = v_meta_description
  where version.article_id = v_result_article_id
    and version.version_number = v_version;

  return jsonb_set(v_result, '{article}', to_jsonb(v_saved_article), true);
end;
$$;

-- Compatibility wrapper protects old application instances during a rolling
-- deployment. New instances pass the explicit overwrite decision as arg 7.
create or replace function public.save_article_snapshot_with_content_policy(
  p_article_id uuid,
  p_idempotency_key text,
  p_snapshot jsonb,
  p_save_reason text default 'manual',
  p_allow_empty_body boolean default false,
  p_expected_last_saved_at timestamptz default null
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.save_article_snapshot_with_content_policy(
    p_article_id,
    p_idempotency_key,
    p_snapshot,
    p_save_reason,
    p_allow_empty_body,
    p_expected_last_saved_at,
    false
  );
$$;

revoke all on function public.article_meta_description_signature(text, text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.meta_description_automation_enabled()
  from public, anon, authenticated;
revoke all on function public.enqueue_article_meta_description_generation(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_article_meta_description_from_article()
  from public, anon, authenticated;
revoke all on function public.reconcile_meta_description_automation_from_settings()
  from public, anon, authenticated;
revoke all on function public.apply_generated_article_meta_description(uuid, text, bigint, uuid, timestamptz, text, text)
  from public, anon, authenticated;
revoke all on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean, timestamptz, boolean)
  from public, anon;
revoke all on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean, timestamptz)
  from public, anon;

grant execute on function public.article_meta_description_signature(text, text, text, jsonb, jsonb, text)
  to service_role;
grant execute on function public.meta_description_automation_enabled()
  to service_role;
grant execute on function public.enqueue_article_meta_description_generation(uuid, uuid, text)
  to service_role;
grant execute on function public.apply_generated_article_meta_description(uuid, text, bigint, uuid, timestamptz, text, text)
  to service_role;
grant execute on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean, timestamptz, boolean)
  to authenticated;
grant execute on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean, timestamptz)
  to authenticated;

comment on function public.save_article_snapshot_with_content_policy(uuid, text, jsonb, text, boolean, timestamptz, boolean)
  is 'Atomically saves an article only from the loaded server revision; an explicit manual conflict decision is required to overwrite newer work.';
comment on function public.enqueue_article_meta_description_generation(uuid, uuid, text)
  is 'Queues settings-aware automatic 140–150 character meta-description generation for a ready article.';
comment on function public.apply_generated_article_meta_description(uuid, text, bigint, uuid, timestamptz, text, text)
  is 'Applies a generated meta description only for the owned worker lease and unchanged ready article revision.';

commit;
