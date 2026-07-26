-- Keep only the comprehensive competitor command in active prompt settings and
-- update the server-side catalog for environments that already applied the
-- independent competitor workflow migration.

create or replace function public.external_analysis_command_catalog()
returns table (
  sequence integer,
  command_id text,
  command_label text
)
language sql
stable
set search_path = public
as $$
  values
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
$$;

update public.app_settings
set value = jsonb_set(
  jsonb_set(
    value,
    '{templates}',
    coalesce(value -> 'templates', '{}'::jsonb)
      - 'smartAnalysis.competitorGapAnalysis'
      - 'smartAnalysis.combinedCommands',
    true
  ),
  '{registryVersion}',
  '8'::jsonb,
  true
)
where key = 'prompts'
  and jsonb_typeof(value) = 'object';
