export const CONTENT_WRITING_REQUIRED_MIGRATIONS = [
  '20260722000000_content_writing_sessions.sql',
  '20260722010000_structured_content_writing.sql',
  '20260722020000_content_writing_application.sql',
  '20260722030000_content_writing_external_reporting.sql',
  '20260722040000_content_writing_quality_guards.sql',
] as const;

export const CONTENT_WRITING_RELEASE_ARTIFACTS = [
  'dist/index.html',
  'server-dist/server.mjs',
  'server-dist/content-writing-worker.mjs',
] as const;
