import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ADMIN_AI_PROVIDER_SECRETS_MIGRATION } from '../constants/adminAiProviderSecrets.ts';
import { USER_AI_PROVIDER_SECRETS_MIGRATION } from '../constants/userAiProviderSecrets.ts';

const root = process.cwd();
for (const migration of [ADMIN_AI_PROVIDER_SECRETS_MIGRATION, USER_AI_PROVIDER_SECRETS_MIGRATION]) {
  const migrationPath = path.join(root, 'supabase', 'migrations', migration);
  const migrationInfo = await stat(migrationPath);
  if (!migrationInfo.isFile() || migrationInfo.size < 500) {
    throw new Error(`AI secret migration is missing or empty: ${migration}`);
  }
}

const deploymentGuide = await readFile(path.join(root, 'deploy', 'HOSTINGER_CANONICAL_DEPLOY.md'), 'utf8');
for (const marker of [
  ADMIN_AI_PROVIDER_SECRETS_MIGRATION,
  USER_AI_PROVIDER_SECRETS_MIGRATION,
  'AI_SETTINGS_ENCRYPTION_KEY',
]) {
  if (!deploymentGuide.includes(marker)) {
    throw new Error(`Deployment guide is missing administrator AI secret marker: ${marker}`);
  }
}

const serverBundle = await readFile(path.join(root, 'server-dist', 'server.mjs'), 'utf8');
for (const marker of [
  '/api/admin/ai-provider-secrets',
  '/api/user/ai-provider-secrets',
  'user_ai_provider_secrets',
  'AI_SETTINGS_ENCRYPTION_KEY',
]) {
  if (!serverBundle.includes(marker)) {
    throw new Error(`Production server bundle is missing administrator AI secret marker: ${marker}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  migrations: [ADMIN_AI_PROVIDER_SECRETS_MIGRATION, USER_AI_PROVIDER_SECRETS_MIGRATION],
  readinessEndpoint: '/readyz',
}, null, 2));
