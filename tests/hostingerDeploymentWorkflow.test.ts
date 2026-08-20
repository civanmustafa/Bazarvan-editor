import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Hostinger production deploy runs only after a successful main quality gate', async () => {
  const workflow = await readFile(
    path.join(root, '.github', 'workflows', 'deploy-hostinger.yml'),
    'utf8',
  );

  assert.match(workflow, /workflows:\s*\n\s*- Quality gates/);
  assert.match(workflow, /branches:\s*\n\s*- main/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(workflow, /group: hostinger-production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /name: hostinger-production/);
  assert.match(workflow, /DEPLOY_COMMIT: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
});

test('Hostinger deploy requires a pinned trusted SSH connection without leaking secrets', async () => {
  const workflow = await readFile(
    path.join(root, '.github', 'workflows', 'deploy-hostinger.yml'),
    'utf8',
  );

  for (const secretName of [
    'HOSTINGER_SSH_HOST',
    'HOSTINGER_SSH_USER',
    'HOSTINGER_SSH_PRIVATE_KEY',
    'HOSTINGER_SSH_KNOWN_HOSTS',
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secretName}`));
  }
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
  assert.doesNotMatch(workflow, /StrictHostKeyChecking=no/);
  assert.match(workflow, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/);
});

test('Hostinger script deploys the exact verified commit and restarts only approved processes', async () => {
  const script = await readFile(
    path.join(root, 'deploy', 'deploy-hostinger-production.sh'),
    'utf8',
  );

  assert.match(script, /git pull --ff-only origin/);
  assert.match(script, /REMOTE_COMMIT.*TARGET_COMMIT/s);
  assert.match(script, /npm ci/);
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
