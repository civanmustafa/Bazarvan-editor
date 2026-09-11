begin;

-- The automatic-ready queue may insert a completed draft only when the
-- administrator explicitly enables it and every safety fence still matches.
create or replace function public.apply_automatic_content_writing_session(
  p_session_id uuid,
  p_expected_article_updated_at timestamptz,
  p_content_json jsonb,
  p_content_html text,
  p_plain_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.content_writing_sessions%rowtype;
  v_article public.articles%rowtype;
  v_ai jsonb := '{}'::jsonb;
  v_version integer;
  v_word_count integer;
  v_stats jsonb;
  v_metadata jsonb;
  v_frozen_updated_at timestamptz;
begin
  select coalesce(setting.value, '{}'::jsonb)
  into v_ai
  from public.app_settings as setting
  where setting.key = 'ai';

  if coalesce(v_ai->'contentWritingAutomationAutoApplyPassedContent', 'false'::jsonb) <> 'true'::jsonb then
    raise exception 'Automatic insertion is disabled by the administrator.' using errcode = '55000';
  end if;

  select session.*
  into v_session
  from public.content_writing_sessions as session
  where session.id = p_session_id
  for update;

  if v_session.id is null then
    raise exception 'Content-writing session was not found.' using errcode = 'P0002';
  end if;
  if v_session.status <> 'completed'
     or v_session.execution_mode <> 'api'
     or v_session.context_snapshot->>'triggerSource' is distinct from 'automatic_ready'
     or nullif(btrim(coalesce(v_session.result_text, '')), '') is null then
    raise exception 'A completed automatic content-writing result is required.' using errcode = '22023';
  end if;
  if coalesce((v_session.quality_report->>'passed')::boolean, false) is not true
     or coalesce((v_session.quality_report->>'blockingFailureCount')::integer, 0) > 0 then
    raise exception 'The generated draft did not pass the mandatory quality gate.' using errcode = '22023';
  end if;
  if coalesce(public.article_access_level_for_user(v_session.article_id, v_session.created_by), 'none') not in ('write', 'admin') then
    raise exception 'Article write access is required.' using errcode = '42501';
  end if;
  if coalesce(public.article_automatic_job_allowed(v_session.article_id, 'content_writing'), false) is not true then
    raise exception 'Automatic writing is no longer allowed for this article.' using errcode = '55000';
  end if;
  if nullif(btrim(coalesce(p_plain_text, '')), '') is null then
    raise exception 'Generated article text cannot be empty.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_content_json, '{}'::jsonb)) <> 'object'
     or p_content_json->>'type' is distinct from 'doc'
     or jsonb_typeof(p_content_json->'content') is distinct from 'array' then
    raise exception 'A valid TipTap JSON document is required.' using errcode = '22023';
  end if;

  begin
    v_frozen_updated_at := (v_session.context_snapshot#>>'{article,updatedAt}')::timestamptz;
  exception when others then
    raise exception 'The automatic-writing article baseline is invalid.' using errcode = '22023';
  end;
  if v_frozen_updated_at is null
     or p_expected_article_updated_at is distinct from v_frozen_updated_at then
    raise exception 'The supplied article baseline does not match the writing session.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_session.article_id::text || ':automatic-content-writing-apply', 0));
  select article.*
  into v_article
  from public.articles as article
  where article.id = v_session.article_id
  for update;

  if v_article.id is null then
    raise exception 'Article was not found.' using errcode = 'P0002';
  end if;
  if v_session.applied_at is not null then
    if v_article.metadata->'automaticContentWriting'->>'sessionId' = v_session.id::text then
      return jsonb_build_object(
        'articleId', v_article.id,
        'alreadyApplied', true,
        'appliedAt', v_session.applied_at,
        'qualityScore', v_session.quality_score
      );
    end if;
    raise exception 'The content-writing result was already applied through another review path.' using errcode = '55000';
  end if;
  if v_article.updated_at is distinct from v_frozen_updated_at then
    raise exception 'The article changed after automatic writing started.' using errcode = '40001';
  end if;
  if public.article_editor_has_text(v_article.plain_text) then
    raise exception 'The article editor is no longer empty.' using errcode = '40001';
  end if;
  if exists (
    select 1
    from public.article_editor_presence as presence
    where presence.article_id = v_article.id
      and presence.last_seen_at >= now() - interval '90 seconds'
  ) then
    raise exception 'A user is currently inside the article editor.' using errcode = '55000';
  end if;

  select greatest(
    coalesce(v_article.save_count, 0) + 1,
    coalesce(max(article_version.version_number), 0) + 1
  )
  into v_version
  from public.article_versions as article_version
  where article_version.article_id = v_article.id;

  v_word_count := coalesce(array_length(regexp_split_to_array(btrim(p_plain_text), '\s+'), 1), 0);
  v_stats := coalesce(v_article.stats, '{}'::jsonb) || jsonb_build_object('wordCount', v_word_count);
  v_metadata := coalesce(v_article.metadata, '{}'::jsonb) || jsonb_build_object(
    'automaticContentWriting', jsonb_build_object(
      'sessionId', v_session.id,
      'qualityGatePassed', true,
      'qualityScore', v_session.quality_score,
      'appliedAt', now()
    )
  );

  update public.articles as article
  set
    content_json = p_content_json,
    content_html = nullif(p_content_html, ''),
    plain_text = p_plain_text,
    analysis = null,
    stats = v_stats,
    metadata = v_metadata,
    save_count = v_version,
    last_saved_at = now()
  where article.id = v_article.id
    and article.updated_at = v_frozen_updated_at
    and not public.article_editor_has_text(article.plain_text)
  returning article.* into v_article;

  if v_article.id is null then
    raise exception 'The article changed while the automatic result was being applied.' using errcode = '40001';
  end if;

  insert into public.article_versions (
    article_id,
    version_number,
    created_by,
    title,
    content_json,
    content_html,
    plain_text,
    keywords,
    goal_context,
    analysis,
    stats,
    note
  ) values (
    v_article.id,
    v_version,
    v_session.created_by,
    v_article.title,
    v_article.content_json,
    v_article.content_html,
    v_article.plain_text,
    v_article.keywords,
    v_article.goal_context,
    null,
    v_article.stats,
    'automatic-content-writing-quality-passed-apply'
  );

  update public.content_writing_sessions as session
  set
    applied_at = now(),
    applied_by = v_session.created_by,
    application_count = session.application_count + 1,
    progress = coalesce(session.progress, '{}'::jsonb) || jsonb_build_object(
      'automaticApplicationStatus', 'applied',
      'articleAppliedAt', now()
    ),
    response_metadata = coalesce(session.response_metadata, '{}'::jsonb) || jsonb_build_object(
      'automaticApplication', jsonb_build_object(
        'status', 'applied',
        'articleId', v_article.id,
        'appliedAt', now()
      )
    ),
    updated_at = now()
  where session.id = v_session.id;

  return jsonb_build_object(
    'articleId', v_article.id,
    'versionNumber', v_version,
    'alreadyApplied', false,
    'wordCount', v_word_count,
    'qualityGatePassed', true,
    'qualityScore', v_session.quality_score,
    'appliedAt', now()
  );
end;
$$;

revoke all on function public.apply_automatic_content_writing_session(
  uuid, timestamptz, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.apply_automatic_content_writing_session(
  uuid, timestamptz, jsonb, text, text
) to service_role;

notify pgrst, 'reload schema';

commit;
