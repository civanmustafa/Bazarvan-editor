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

test('Hostinger schema scripts and guide track concurrent editing and meta-description migrations', async () => {
  const [applyScript, verifyScript, guide] = await Promise.all([
    readFile(path.join(root, 'deploy', 'hostinger-supabase', 'apply-project-migrations.sh'), 'utf8'),
    readFile(path.join(root, 'deploy', 'hostinger-supabase', 'verify-project-schema.sh'), 'utf8'),
    readFile(path.join(root, 'deploy', 'HOSTINGER_CANONICAL_DEPLOY.md'), 'utf8'),
  ]);

  assert.match(applyScript, /EXPECTED_MIGRATIONS:-89/);
  assert.match(verifyScript, /EXPECTED_MIGRATIONS:-89/);
  assert.match(guide, /20260827030000_content_research_automation_settings\.sql/);
  assert.match(guide, /20260828010000_concurrent_editing_and_meta_description\.sql/);
  assert.match(verifyScript, /META_DESCRIPTION_COLUMNS/);
  assert.match(verifyScript, /CONCURRENT_SAVE_FUNCTION/);
});
