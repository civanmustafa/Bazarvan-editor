import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  ADMIN_AI_PROVIDER_SECRETS_MIGRATION,
  CONTENT_WRITING_RESUME_SECRET_MIGRATION,
} from '../constants/adminAiProviderSecrets.ts';
import { USER_AI_PROVIDER_SECRETS_MIGRATION } from '../constants/userAiProviderSecrets.ts';
import { PROVIDER_CREDENTIAL_VAULT_MIGRATION } from '../server/providerCredentialVault.ts';
import { PROVIDER_EXPLICIT_GRANTS_MIGRATION } from '../constants/providerAccessControl.ts';

const root = process.cwd();
for (const migration of [
  ADMIN_AI_PROVIDER_SECRETS_MIGRATION,
  USER_AI_PROVIDER_SECRETS_MIGRATION,
  CONTENT_WRITING_RESUME_SECRET_MIGRATION,
  PROVIDER_CREDENTIAL_VAULT_MIGRATION,
  PROVIDER_EXPLICIT_GRANTS_MIGRATION,
]) {
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
  CONTENT_WRITING_RESUME_SECRET_MIGRATION,
  PROVIDER_CREDENTIAL_VAULT_MIGRATION,
  PROVIDER_EXPLICIT_GRANTS_MIGRATION,
  'AI_SETTINGS_ENCRYPTION_KEY',
  'provider_credentials_vault',
  'لا يوجد أي fallback لمفاتيح المزوّدين من بيئة Hostinger',
]) {
  if (!deploymentGuide.includes(marker)) {
    throw new Error(`Deployment guide is missing administrator AI secret marker: ${marker}`);
  }
}

const providerApiEnvironmentAccess = /process\.env(?:\.|\[['"])(?:GEMINI(?:_PAID|_PRO)?_API_KEYS?|OPENAI_API_KEYS?|FIRECRAWL_API_KEY|BROWSERLESS_API_KEY)/;
for (const entry of await readdir(path.join(root, 'server'), { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  const source = await readFile(path.join(root, 'server', entry.name), 'utf8');
  if (providerApiEnvironmentAccess.test(source)) {
    throw new Error(`Provider API environment fallback is forbidden: server/${entry.name}`);
  }
}

for (const example of ['.env.example', '.env.production.example', 'deploy/env.server.example']) {
  const source = await readFile(path.join(root, example), 'utf8');
  if (/^(?:GEMINI(?:_PAID|_PRO)?_API_KEYS?|OPENAI_API_KEYS?|FIRECRAWL_API_KEY|BROWSERLESS_API_KEY)=/m.test(source)) {
    throw new Error(`Provider API keys must not be declared in environment example: ${example}`);
  }
}

const providerAccessSettings = await readFile(
  path.join(root, 'components', 'AdminProviderAccessSettings.tsx'),
  'utf8',
);
for (const marker of [
  'حفظ دون تعيين',
  'content_writing_resume',
  'saveAdminSharedCredential',
  'غير معيّن — لن يُستخدم',
]) {
  if (!providerAccessSettings.includes(marker)) {
    throw new Error(`Unified provider settings are missing the explicit-grant marker: ${marker}`);
  }
}

const settingsPage = await readFile(path.join(root, 'components', 'SettingsPage.tsx'), 'utf8');
if (!settingsPage.includes('مركز المزودات والمفاتيح والصلاحيات')) {
  throw new Error('The unified provider center is missing from the settings page.');
}
if (/AdminAiProviderSecretsSettings|AdminCrawlerProviderSecretsSettings/.test(settingsPage)) {
  throw new Error('A retired administrator provider-key screen is still mounted.');
}

const componentNames = new Set(await readdir(path.join(root, 'components')));
const utilityNames = new Set(await readdir(path.join(root, 'utils')));
for (const legacyComponent of [
  'AdminAiProviderSecretsSettings.tsx',
  'AdminCrawlerProviderSecretsSettings.tsx',
]) {
  if (componentNames.has(legacyComponent)) {
    throw new Error(`Retired administrator provider-key screen still exists: ${legacyComponent}`);
  }
}
for (const legacyUtility of ['adminAiProviderSecrets.ts', 'adminCrawlerProviderSecrets.ts']) {
  if (utilityNames.has(legacyUtility)) {
    throw new Error(`Retired administrator provider-key client still exists: ${legacyUtility}`);
  }
}

const userProviderSettings = await readFile(
  path.join(root, 'components', 'UserAiProviderSecretsSettings.tsx'),
  'utf8',
);
if (/مفاتيح الإدارة وهوستينجر|OpenAI \(ChatGPT API\) المدفوعة/.test(userProviderSettings)) {
  throw new Error('Personal provider settings still describe the retired Hostinger fallback or paid-only OpenAI keys.');
}

const serverBundle = await readFile(path.join(root, 'server-dist', 'server.mjs'), 'utf8');
for (const marker of [
  '/api/admin/ai-provider-secrets',
  '/api/user/ai-provider-secrets',
  'provider_credentials_vault',
  'PROVIDER_CREDENTIAL_VAULT_KEY',
]) {
  if (!serverBundle.includes(marker)) {
    throw new Error(`Production server bundle is missing administrator AI secret marker: ${marker}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  migrations: [
    ADMIN_AI_PROVIDER_SECRETS_MIGRATION,
    USER_AI_PROVIDER_SECRETS_MIGRATION,
    CONTENT_WRITING_RESUME_SECRET_MIGRATION,
    PROVIDER_CREDENTIAL_VAULT_MIGRATION,
    PROVIDER_EXPLICIT_GRANTS_MIGRATION,
  ],
  readinessEndpoint: '/readyz',
}, null, 2));
