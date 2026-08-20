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
  assert.match(script, /bazarvan-staging-client-page-crawler/);
  assert.match(script, /smarteditor\.bazarvan\.com\/healthz/);
  assert.match(script, /smarteditor\.bazarvan\.com\/readyz/);
});
