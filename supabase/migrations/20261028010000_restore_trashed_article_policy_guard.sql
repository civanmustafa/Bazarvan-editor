begin;

-- The per-article override policy must retain the global trash admission
-- invariant introduced by 20261016000000. This corrective migration is
-- separate because the override migration may already be tracked in a live
-- project and therefore will not be replayed there.
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
  if coalesce((v_policy->>'policyVersion')::integer, 0) = 0
     and coalesce((v_policy->>'articleOverrideVersion')::integer, 0) = 0 then
    return true;
  end if;
  if not coalesce((v_policy->>'enabled')::boolean, false) then return false; end if;
  return case p_job_type
    when 'semantic_keywords_lsi' then coalesce((v_policy->>'autoGenerateAlternativeKeywords')::boolean, false)
      or coalesce((v_policy->>'autoGenerateLsiKeywords')::boolean, false)
      or coalesce((v_policy->>'autoGenerateGoogleMetadata')::boolean, false)
    when 'competitor_discovery' then coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
    when 'competitor_extraction' then coalesce((v_policy->>'autoExtractCompetitorContent')::boolean, false)
    when 'engineering_command' then coalesce((v_policy->>'autoRunReadyEngineeringCommands')::boolean, false)
      and coalesce(v_policy->'externalAnalysisCommandIds', '[]'::jsonb) ? coalesce(p_command_id, '')
    when 'content_writing_preparation' then coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false)
      and coalesce(v_policy->>'articleWritingMode', 'strict') = 'strict'
      and coalesce((v_policy->>'autoDiscoverCompetitors')::boolean, false)
      and coalesce((v_policy->>'autoExtractCompetitorContent')::boolean, false)
    when 'content_writing' then coalesce((v_policy->>'contentWritingAutomationEnabled')::boolean, false)
    when 'duplicate_cleanup' then true
    else false
  end;
end;
$$;

revoke all on function public.article_automatic_policy_allows(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.article_automatic_policy_allows(uuid,text,text)
  to service_role;

notify pgrst, 'reload schema';

commit;
