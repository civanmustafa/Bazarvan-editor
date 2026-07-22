import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ADMIN_AI_PROVIDER_SECRETS_MIGRATION } from '../constants/adminAiProviderSecrets.ts';

const root = process.cwd();
const migrationPath = path.join(root, 'supabase', 'migrations', ADMIN_AI_PROVIDER_SECRETS_MIGRATION);
const migrationInfo = await stat(migrationPath);
if (!migrationInfo.isFile() || migrationInfo.size < 500) {
  throw new Error(`Administrator AI secret migration is missing or empty: ${ADMIN_AI_PROVIDER_SECRETS_MIGRATION}`);
}

const deploymentGuide = await readFile(path.join(root, 'deploy', 'HOSTINGER_CANONICAL_DEPLOY.md'), 'utf8');
for (const marker of [ADMIN_AI_PROVIDER_SECRETS_MIGRATION, 'AI_SETTINGS_ENCRYPTION_KEY']) {
  if (!deploymentGuide.includes(marker)) {
    throw new Error(`Deployment guide is missing administrator AI secret marker: ${marker}`);
  }
}

const serverBundle = await readFile(path.join(root, 'server-dist', 'server.mjs'), 'utf8');
for (const marker of ['/api/admin/ai-provider-secrets', 'ai_provider_secrets', 'AI_SETTINGS_ENCRYPTION_KEY']) {
  if (!serverBundle.includes(marker)) {
    throw new Error(`Production server bundle is missing administrator AI secret marker: ${marker}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  migration: ADMIN_AI_PROVIDER_SECRETS_MIGRATION,
  readinessEndpoint: '/readyz',
}, null, 2));
