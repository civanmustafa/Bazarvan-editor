begin;

-- The dashboard only displays draft automation work, but the internal raw
-- projection historically evaluated every accessible article and left the
-- draft filter to a later wrapper.  That made the expensive writing-readiness
-- evaluator run once for every operation row, including unrelated operations
-- and non-draft articles.  Keep the established classifier intact while
-- narrowing its source and short-circuiting writing-only checks.
do $migration$
declare
  v_raw_definition text;
  v_classifier_definition text;
  v_raw_access_clause constant text :=
    'where public.article_access_level_for_user(article.id, p_requested_by) <> ''none''';
  v_raw_draft_clause constant text :=
    'where article.status = ''draft'''
    || E'\n      and public.article_access_level_for_user(article.id, p_requested_by) <> ''none''';
  v_readiness_call constant text :=
    'select public.evaluate_content_writing_automation_readiness(raw.article_id) as value';
  v_guarded_readiness constant text :=
    'select case'
    || E'\n        when raw.operation_key = ''content_writing'''
    || E'\n          then public.evaluate_content_writing_automation_readiness(raw.article_id)'
    || E'\n        else jsonb_build_object('
    || E'\n          ''ready'', false,'
    || E'\n          ''signature'', '''','
    || E'\n          ''missingFields'', ''[]''::jsonb,'
    || E'\n          ''usableCompetitorCount'', 0,'
    || E'\n          ''minimumCompetitorCount'', config.minimum_competitors'
    || E'\n        )'
    || E'\n      end as value';
begin
  select pg_get_functiondef(
    'public.get_visible_automation_task_inventory_raw(uuid)'::regprocedure
  ) into v_raw_definition;

  if position(v_raw_access_clause in v_raw_definition) = 0 then
    raise exception 'The raw automation inventory access clause changed; refusing an unsafe performance patch.';
  end if;

  v_raw_definition := replace(
    v_raw_definition,
    v_raw_access_clause,
    v_raw_draft_clause
  );
  execute v_raw_definition;

  select pg_get_functiondef(
    'public.get_visible_automation_task_inventory_v8(uuid)'::regprocedure
  ) into v_classifier_definition;

  if position(v_readiness_call in v_classifier_definition) = 0 then
    raise exception 'The readiness-aware automation classifier changed; refusing an unsafe performance patch.';
  end if;

  v_classifier_definition := replace(
    v_classifier_definition,
    v_readiness_call,
    v_guarded_readiness
  );
  v_classifier_definition := replace(
    v_classifier_definition,
    'public.article_automatic_policy_allows(article.id, ''content_writing'') as writing_policy_allows',
    'case when raw.operation_key = ''content_writing'' then public.article_automatic_policy_allows(article.id, ''content_writing'') else true end as writing_policy_allows'
  );
  v_classifier_definition := replace(
    v_classifier_definition,
    'public.automatic_article_focus_allows(article.id, ''content_writing'') as writing_focus_allows',
    'case when raw.operation_key = ''content_writing'' then public.automatic_article_focus_allows(article.id, ''content_writing'') else true end as writing_focus_allows'
  );
  execute v_classifier_definition;
end;
$migration$;

comment on function public.get_visible_automation_task_inventory_raw(uuid) is
  'Returns unfinished automation stage rows visible to the requester for draft articles only; downstream classifiers add live readiness evidence.';

comment on function public.get_visible_automation_task_inventory_v8(uuid) is
  'Readiness-aware draft automation inventory classifier optimized to evaluate writing-only checks exclusively for content-writing rows.';

notify pgrst, 'reload schema';

commit;
