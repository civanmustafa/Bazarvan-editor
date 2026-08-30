import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('manual Hostinger deployment verifies the commit and restarts only approved processes', async () => {
  const script = await readFile(
    path.join(root, 'deploy', 'deploy-hostinger-production.sh'),
    'utf8',
  );

  assert.match(script, /git pull --ff-only origin/);
  assert.match(script, /REMOTE_COMMIT.*TARGET_COMMIT/s);
  assert.match(script, /npm ci --include=dev/);
  assert.match(script, /npm run build/);
  assert.match(script, /pm2 describe/);
  assert.match(script, /pm2 save/);
  assert.doesNotMatch(script, /pm2 restart all/);
  assert.match(script, /bazarvan-editor-staging/);
  assert.match(script, /bazarvan-staging-content-writing-worker/);
  assert.match(script, /bazarvan-staging-content-writing-preparation-worker/);
  assert.match(script, /EXTERNAL_ANALYSIS_WORKER_JOB_TYPES=content_writing_preparation/);
  assert.match(
    script,
    /EXTERNAL_ANALYSIS_WORKER_JOB_TYPES=semantic_keywords_lsi,content_brief_generation,meta_description_generation,engineering_command/,
  );
  assert.match(script, /pm2 start server-dist\/external-analysis-worker\.mjs/);
  assert.match(script, /bazarvan-staging-client-page-crawler/);
  assert.match(script, /smarteditor\.bazarvan\.com\/healthz/);
  assert.match(script, /smarteditor\.bazarvan\.com\/readyz/);
});

test('Hostinger schema scripts and guide track the current production migrations', async () => {
  const [applyScript, verifyScript, guide] = await Promise.all([
    readFile(path.join(root, 'deploy', 'hostinger-supabase', 'apply-project-migrations.sh'), 'utf8'),
    readFile(path.join(root, 'deploy', 'hostinger-supabase', 'verify-project-schema.sh'), 'utf8'),
    readFile(path.join(root, 'deploy', 'HOSTINGER_CANONICAL_DEPLOY.md'), 'utf8'),
  ]);

  assert.match(applyScript, /EXPECTED_MIGRATIONS:-104/);
  assert.match(verifyScript, /EXPECTED_MIGRATIONS:-104/);
  assert.match(verifyScript, /EXPECTED_PUBLIC_TABLES:-60/);
  assert.match(guide, /20260831000000_creator_article_automation\.sql/);
  assert.match(verifyScript, /CREATOR_AUTOMATION_CLIENT_PRIVILEGES/);
  assert.match(guide, /20260827030000_content_research_automation_settings\.sql/);
  assert.match(guide, /20260828010000_concurrent_editing_and_meta_description\.sql/);
  assert.match(guide, /20260828020000_automatic_ready_engineering_commands\.sql/);
  assert.match(guide, /20260829000000_external_analysis_auto_once_per_article\.sql/);
  assert.match(guide, /20260829010000_content_writing_two_meta_descriptions\.sql/);
  assert.match(guide, /20260829020000_dashboard_activity_summary\.sql/);
  assert.match(guide, /20260829030000_provider_credential_vault\.sql/);
  assert.match(guide, /20260829040000_provider_credentials_explicit_grants\.sql/);
  assert.match(guide, /20260829050000_article_writing_sources\.sql/);
  assert.match(guide, /20260829060000_publisher_user_article_visibility\.sql/);
  assert.match(guide, /20260829070000_automatic_competitor_content_extraction\.sql/);
  assert.match(guide, /20260829080000_unified_semantic_google_metadata\.sql/);
  assert.match(guide, /20260830000000_reconcile_unified_semantic_automation\.sql/);
  assert.match(guide, /20260830010000_reconcile_automatic_competitor_extraction\.sql/);
  assert.match(guide, /20260830020000_automatic_internal_link_insertion\.sql/);
  assert.match(guide, /20260830030000_automatic_content_writing_empty_editor_guard\.sql/);
  assert.match(verifyScript, /META_DESCRIPTION_COLUMNS/);
  assert.match(verifyScript, /CONCURRENT_SAVE_FUNCTION/);
  assert.match(verifyScript, /READY_ENGINEERING_CONTROLLED_FUNCTION/);
  assert.match(verifyScript, /READY_ENGINEERING_TRIGGER/);
  assert.match(verifyScript, /READY_ENGINEERING_SETTING/);
  assert.match(verifyScript, /AUTOMATIC_ONCE_ENGINEERING_FUNCTION/);
  assert.match(verifyScript, /AUTOMATIC_ONCE_STAGE_FUNCTION/);
  assert.match(verifyScript, /AUTOMATIC_ONCE_RUN_TRIGGER/);
  assert.match(verifyScript, /DASHBOARD_ACTIVITY_SUMMARY_FUNCTION/);
  assert.match(verifyScript, /PROVIDER_CREDENTIAL_VAULT_TABLE/);
  assert.match(verifyScript, /PROVIDER_CREDENTIAL_VAULT_RLS/);
  assert.match(verifyScript, /PROVIDER_CREDENTIAL_VAULT_CLIENT_PRIVILEGES/);
  assert.match(verifyScript, /ARTICLE_WRITING_SOURCES_TABLE/);
  assert.match(verifyScript, /ARTICLE_WRITING_SOURCES_RLS/);
  assert.match(verifyScript, /ARTICLE_WRITING_SOURCES_CLIENT_PRIVILEGES/);
  assert.match(verifyScript, /PUBLISHER_USER_SETTING/);
  assert.match(verifyScript, /PUBLISHER_ACCESS_POLICY/);
  assert.match(verifyScript, /AUTO_COMPETITOR_EXTRACTION_SETTING/);
  assert.match(verifyScript, /AUTO_COMPETITOR_EXTRACTION_TRIGGER/);
  assert.match(verifyScript, /UNIFIED_SEMANTIC_GOOGLE_METADATA_FUNCTION/);
  assert.match(verifyScript, /UNIFIED_SEMANTIC_GOOGLE_TARGET_STAMP/);
  assert.match(verifyScript, /READY_STATUS_META_DESCRIPTION_TRIGGER_RETIRED/);
  assert.match(verifyScript, /AUTOMATIC_WRITING_SCHEMA_VERSION/);
  assert.match(verifyScript, /AUTOMATIC_WRITING_EMPTY_EDITOR_TRIGGER/);
});
