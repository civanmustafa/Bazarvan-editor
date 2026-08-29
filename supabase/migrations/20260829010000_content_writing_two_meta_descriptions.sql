begin;

-- The same persistent structured-writing workflow serves manual "Write
-- article", full-article pipelines, and automatic writing sessions. A
-- dedicated final stage stores two validated suggestions without choosing or
-- applying either one on the user's behalf.
alter table public.content_writing_steps
  drop constraint if exists content_writing_steps_step_type_check;

alter table public.content_writing_steps
  add constraint content_writing_steps_step_type_check
  check (
    step_type in (
      'competitor_index',
      'outline',
      'section',
      'introduction',
      'conclusion',
      'call_to_action',
      'faq',
      'coverage_audit',
      'section_repair',
      'final_review',
      'quality_repair',
      'meta_description'
    )
  );

comment on constraint content_writing_steps_step_type_check on public.content_writing_steps
  is 'Allows the durable two-meta-description stage shared by manual, full-pipeline, and automatic content-writing sessions.';

commit;
