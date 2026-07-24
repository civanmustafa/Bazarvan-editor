import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CLIENT_CENTER_REQUIRED_MIGRATION } from '../constants/clientCenter.ts';

const root = process.cwd();
const migrationPath = path.join(root, 'supabase', 'migrations', CLIENT_CENTER_REQUIRED_MIGRATION);
const migrationInfo = await stat(migrationPath);
if (!migrationInfo.isFile() || migrationInfo.size < 1_000) {
  throw new Error(`Client Center migration is missing or empty: ${CLIENT_CENTER_REQUIRED_MIGRATION}`);
}

const deploymentGuide = await readFile(
  path.join(root, 'deploy', 'HOSTINGER_CANONICAL_DEPLOY.md'),
  'utf8',
);
for (const marker of [
  CLIENT_CENTER_REQUIRED_MIGRATION,
  'مركز العملاء',
  '/readyz',
]) {
  if (!deploymentGuide.includes(marker)) {
    throw new Error(`Deployment guide is missing Client Center marker: ${marker}`);
  }
}

const serverBundle = await readFile(path.join(root, 'server-dist', 'server.mjs'), 'utf8');
for (const marker of [
  'client_center_schema_unavailable',
  'client_page_crawl_jobs',
  CLIENT_CENTER_REQUIRED_MIGRATION,
]) {
  if (!serverBundle.includes(marker)) {
    throw new Error(`Production server bundle is missing Client Center marker: ${marker}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  migration: CLIENT_CENTER_REQUIRED_MIGRATION,
  readinessEndpoint: '/readyz',
}, null, 2));
