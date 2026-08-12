begin;

alter table public.content_writing_sessions
  add column if not exists parallel_substeps_version smallint not null default 1
    check (parallel_substeps_version >= 1);

comment on column public.content_writing_sessions.parallel_substeps_version is
  'Database capability marker for parallel knowledge passes and writing candidates.';

-- An ordinal identifies the visible workflow stage, not an individual row.
-- Ensemble knowledge passes and writing candidates are child steps of the same
-- stage, so they intentionally share their parent's ordinal while step_key
-- remains the durable, unique identity used for retries and resumability.
alter table public.content_writing_steps
  drop constraint if exists content_writing_steps_session_id_ordinal_key;

comment on column public.content_writing_steps.ordinal is
  'Visible workflow-stage order. Parallel candidate and ensemble child steps may share the parent stage ordinal.';

-- Keep stage reads efficient after removing the unique constraint and its
-- backing index. This is also safe for databases where the original explicit
-- non-unique index already exists.
create index if not exists content_writing_steps_session_ordinal_idx
  on public.content_writing_steps(session_id, ordinal);

commit;
