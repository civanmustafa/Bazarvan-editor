-- Retire overlapping engineering commands and persist one independent AI map per
-- competitor for the surviving competitor comparison workflow.

create table if not exists public.ai_engineering_competitor_map_cache (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  command_id text not null,
  competitor_number integer not null check (competitor_number between 1 and 5),
  article_signature text not null check (char_length(article_signature) = 64),
  competitor_signature text not null check (char_length(competitor_signature) = 64),
  prompt_signature text not null check (char_length(prompt_signature) = 64),
  source_url text,
  source_chars integer not null default 0 check (source_chars >= 0),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  provider text,
  model text,
  completed_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (
    article_id,
    command_id,
    competitor_number,
    article_signature,
    competitor_signature,
    prompt_signature
  )
);

create index if not exists ai_engineering_competitor_map_cache_article_idx
  on public.ai_engineering_competitor_map_cache(article_id, command_id, competitor_number, last_used_at desc);

alter table public.ai_engineering_competitor_map_cache enable row level security;
revoke all on table public.ai_engineering_competitor_map_cache from anon, authenticated;
grant select, insert, update, delete on table public.ai_engineering_competitor_map_cache to service_role;

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
    (4, 'smartAnalysis.competitorContentComparison', 'Comprehensive competitor analysis'),
    (5, 'smartAnalysis.improveConclusion', 'Improve conclusion'),
    (6, 'smartAnalysis.improveWeakest', 'Improve weakest section'),
    (7, 'smartAnalysis.suggestNewIdea', 'Suggest a new idea'),
    (8, 'smartAnalysis.peopleQuestions', 'People also ask'),
    (9, 'smartAnalysis.structuredContent', 'Structured content opportunities'),
    (10, 'smartAnalysis.unsuitableSections', 'Unsuitable sections'),
    (11, 'smartAnalysis.repetitionAndFillerAudit', 'Repetition and filler audit'),
    (12, 'smartAnalysis.articleSectionOrder', 'Section order analysis')
  ) as catalog(catalog_order, command_id, command_label)
  order by catalog.catalog_order;
$$;

update public.app_settings
set value = jsonb_set(
  coalesce(value, '{}'::jsonb),
  '{externalAnalysisDefaultCommandIds}',
  '["smartAnalysis.competitorContentComparison","smartAnalysis.repetitionAndFillerAudit","smartAnalysis.fullArticleAudit"]'::jsonb,
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
    'smartAnalysis.repetitionAndFillerAudit',
    'smartAnalysis.fullArticleAudit'
  ];
begin
  select setting.value->'externalAnalysisDefaultCommandIds'
  into v_configured
  from public.app_settings as setting
  where setting.key = 'ai'
  limit 1;

  if jsonb_typeof(v_configured) <> 'array' then
    v_configured := to_jsonb(v_fallback);
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

with filtered as (
  select
    state.article_id,
    coalesce((
      select jsonb_agg(selected.command_id order by selected.position)
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(state.custom_engineering_command_ids) = 'array'
            then state.custom_engineering_command_ids
          else '[]'::jsonb
        end
      ) with ordinality as selected(command_id, position)
      join public.external_analysis_command_catalog() as catalog
        on catalog.command_id = selected.command_id
    ), '[]'::jsonb) as custom_ids
  from public.ai_external_analysis_article_state as state
)
update public.ai_external_analysis_article_state as state
set
  engineering_command_mode = case
    when state.engineering_command_mode = 'custom'
      and jsonb_array_length(filtered.custom_ids) > 0
      then 'custom'
    else 'default'
  end,
  custom_engineering_command_ids = case
    when state.engineering_command_mode = 'custom'
      and jsonb_array_length(filtered.custom_ids) > 0
      then filtered.custom_ids
    else '[]'::jsonb
  end,
  external_analysis_effective_command_ids = case
    when state.engineering_command_mode = 'custom'
      and jsonb_array_length(filtered.custom_ids) > 0
      then filtered.custom_ids
    else to_jsonb(public.get_external_analysis_default_command_ids())
  end,
  updated_at = now()
from filtered
where filtered.article_id = state.article_id;

update public.ai_external_analysis_jobs
set
  status = case when status = 'running' then status else 'cancelled' end,
  cancel_requested_at = case when status = 'running' then coalesce(cancel_requested_at, now()) else cancel_requested_at end,
  last_error_code = 'engineering_command_retired',
  last_error = 'This overlapping engineering command was retired. Historical completed results remain available.',
  completed_at = case when status = 'running' then completed_at else coalesce(completed_at, now()) end,
  locked_by = case when status = 'running' then locked_by else null end,
  locked_at = case when status = 'running' then locked_at else null end,
  lease_expires_at = case when status = 'running' then lease_expires_at else null end,
  updated_at = now()
where job_type = 'engineering_command'
  and command_id in (
    'smartAnalysis.competitorGapAnalysis',
    'smartAnalysis.combinedCommands'
  )
  and status in (
    'waiting_for_prerequisites',
    'queued',
    'running',
    'retry_scheduled',
    'paused'
  );

revoke all on function public.external_analysis_command_catalog() from public;
revoke all on function public.get_external_analysis_default_command_ids() from public;
grant execute on function public.get_external_analysis_default_command_ids() to service_role;

comment on table public.ai_engineering_competitor_map_cache is
  'Validated per-competitor map results reused by the independent competitor engineering workflow.';
comment on function public.external_analysis_command_catalog() is
  'Active engineering command catalog. Retired command IDs remain readable only in historical job rows.';
