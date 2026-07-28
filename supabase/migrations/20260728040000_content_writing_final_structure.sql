begin;

-- Mark unfinished sessions with the deterministic final-section invariant:
-- exactly one FAQ immediately before exactly one goal-aware final section.
update public.content_writing_sessions
set context_snapshot = jsonb_set(
      jsonb_set(
        coalesce(context_snapshot, '{}'::jsonb),
        '{workflowVersion}',
        '9'::jsonb,
        true
      ),
      '{finalSectionStructureVersion}',
      '1'::jsonb,
      true
    ),
    updated_at = now()
where status in ('queued', 'running', 'retry_scheduled', 'failed')
  and coalesce((context_snapshot ->> 'workflowVersion')::integer, 0) < 9;

-- Preserve completed historical articles and the already-audited FAQ. Re-run
-- only the goal-aware final section and its dependent audit/review stages.
with unfinished_final_section as (
  select step.session_id, min(step.ordinal) as final_section_ordinal
  from public.content_writing_steps as step
  join public.content_writing_sessions as session on session.id = step.session_id
  where session.status in ('queued', 'running', 'retry_scheduled', 'failed')
    and step.step_type in ('conclusion', 'call_to_action')
  group by step.session_id
)
update public.content_writing_steps as step
set status = 'pending',
    prompt_text = '',
    output_text = null,
    metadata = jsonb_build_object(
      'workflowVersion', 9,
      'finalSectionStructureVersion', 1
    ),
    last_error_code = null,
    last_error = null,
    started_at = null,
    completed_at = null,
    updated_at = now()
from unfinished_final_section
where step.session_id = unfinished_final_section.session_id
  and step.ordinal >= unfinished_final_section.final_section_ordinal;

commit;
