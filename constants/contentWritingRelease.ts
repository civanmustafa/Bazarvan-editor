export const CONTENT_WRITING_REQUIRED_MIGRATIONS = [
  '20260722000000_content_writing_sessions.sql',
  '20260722010000_structured_content_writing.sql',
  '20260722020000_content_writing_application.sql',
  '20260722030000_content_writing_external_reporting.sql',
  '20260722040000_content_writing_quality_guards.sql',
  '20260723000000_content_writing_quality_policy.sql',
  '20260723010000_content_writing_knowledge_workflow.sql',
  '20260723020000_content_writing_resume_preferences.sql',
  '20260728000000_dynamic_content_writing_final_section.sql',
  '20260728010000_content_writing_faq_independence.sql',
  '20260728040000_content_writing_final_structure.sql',
  '20260812000000_allow_parallel_content_writing_substeps.sql',
  '20260812010000_gemini_key_availability_waiting.sql',
  '20260823010000_automatic_content_writing_queue.sql',
  '20260823020000_content_writing_competitor_preparation.sql',
  '20260829050000_article_writing_sources.sql',
] as const;

export const FULL_ARTICLE_PIPELINE_REQUIRED_MIGRATIONS = [
  '20260728030000_full_article_pipeline.sql',
  '20260824010000_full_article_pipeline_safety.sql',
  '20260824020000_full_article_pipeline_optional_prerequisites.sql',
  '20260824030000_full_article_pipeline_optional_discovery.sql',
  '20260825000000_full_article_pipeline_optional_semantic.sql',
] as const;

export const CONTENT_WRITING_RUNTIME_REQUIRED_MIGRATIONS = [
  ...CONTENT_WRITING_REQUIRED_MIGRATIONS,
  ...FULL_ARTICLE_PIPELINE_REQUIRED_MIGRATIONS,
] as const;

export const CONTENT_WRITING_RELEASE_ARTIFACTS = [
  'dist/index.html',
  'server-dist/server.mjs',
  'server-dist/content-writing-worker.mjs',
  'server-dist/external-analysis-worker.mjs',
] as const;
