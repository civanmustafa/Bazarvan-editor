begin;

-- Automatic engineering commands remain exactly-once work inside one content
-- snapshot. A completed command from an older article snapshot must not
-- suppress the same command after duplicate cleanup changes the content and
-- therefore changes the external-analysis readiness signature.
do $migration$
declare
  v_function_definition text;
  v_anchor constant text := 'and previous.command_id = selected.command_id';
  v_current_signature_guard constant text :=
    'and previous.readiness_signature = v_state.external_analysis_readiness_signature';
begin
  select pg_get_functiondef(
    'public.enqueue_external_engineering_jobs_sequential_base_before_google_metadata(uuid,text)'::regprocedure
  )
  into v_function_definition;

  if strpos(v_function_definition, v_current_signature_guard) = 0 then
    if strpos(v_function_definition, v_anchor) = 0 then
      raise exception 'Could not find the automatic engineering-command history guard';
    end if;

    v_function_definition := replace(
      v_function_definition,
      v_anchor,
      v_anchor || E'\n        ' || v_current_signature_guard
    );
    execute v_function_definition;
  end if;
end;
$migration$;

-- Repair only genuinely stranded draft articles: cleanup is current, audits
-- are still required, and the current content signature has neither active nor
-- failed audit jobs. The reconciler is idempotent and retains the normal queue
-- and policy checks.
do $repair$
declare
  v_article record;
begin
  for v_article in
    select article.id
    from public.articles as article
    cross join lateral public.article_automation_work_readiness(article.id) as work(readiness)
    where article.status = 'draft'
      and work.readiness->>'state' = 'auditing'
      and coalesce((work.readiness->>'cleanupCurrent')::boolean, false)
      and coalesce((work.readiness->>'requiredAuditCount')::integer, 0)
        > coalesce((work.readiness->>'completedAuditCount')::integer, 0)
      and coalesce((work.readiness->>'activeAuditCount')::integer, 0) = 0
      and coalesce((work.readiness->>'failedAuditCount')::integer, 0) = 0
  loop
    perform public.reconcile_automatic_ready_engineering_commands_for_article(v_article.id);
  end loop;
end;
$repair$;

notify pgrst, 'reload schema';

commit;
