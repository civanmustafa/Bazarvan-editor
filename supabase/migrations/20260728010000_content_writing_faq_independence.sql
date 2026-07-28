begin;

-- New sessions persist the marker through the server snapshot. Mark unfinished
-- sessions too so an operator can tell that their resumed FAQ must use the
-- evidence-backed independence protocol.
update public.content_writing_sessions
set context_snapshot = jsonb_set(
      jsonb_set(
        coalesce(context_snapshot, '{}'::jsonb),
        '{workflowVersion}',
        '8'::jsonb,
        true
      ),
      '{faqIndependenceVersion}',
      '1'::jsonb,
      true
    ),
    updated_at = now()
where status in ('queued', 'running', 'retry_scheduled', 'failed')
  and coalesce((context_snapshot ->> 'workflowVersion')::integer, 0) < 8;

-- Preserve completed historical articles. For unfinished sessions only, keep
-- the already-written introduction/body but regenerate FAQ and every dependent
-- stage so an old free-form FAQ can never bypass the new audit on resume.
with unfinished_faq as (
  select step.session_id, min(step.ordinal) as faq_ordinal
  from public.content_writing_steps as step
  join public.content_writing_sessions as session on session.id = step.session_id
  where session.status in ('queued', 'running', 'retry_scheduled', 'failed')
    and step.step_type = 'faq'
  group by step.session_id
)
update public.content_writing_steps as step
set status = 'pending',
    prompt_text = '',
    output_text = null,
    metadata = jsonb_build_object(
      'workflowVersion', 8,
      'faqIndependenceVersion', 1
    ),
    last_error_code = null,
    last_error = null,
    started_at = null,
    completed_at = null,
    updated_at = now()
from unfinished_faq
where step.session_id = unfinished_faq.session_id
  and step.ordinal >= unfinished_faq.faq_ordinal;

commit;
