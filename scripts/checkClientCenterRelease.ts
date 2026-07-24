import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CLIENT_CENTER_FOUNDATION_MIGRATION,
  CLIENT_CENTER_REQUIRED_MIGRATION,
} from '../constants/clientCenter.ts';

const root = process.cwd();
for (const migration of [CLIENT_CENTER_FOUNDATION_MIGRATION, CLIENT_CENTER_REQUIRED_MIGRATION]) {
  const migrationPath = path.join(root, 'supabase', 'migrations', migration);
  const migrationInfo = await stat(migrationPath);
  if (!migrationInfo.isFile() || migrationInfo.size < 1_000) {
    throw new Error(`Client Center migration is missing or empty: ${migration}`);
  }
}

const deploymentGuide = await readFile(
  path.join(root, 'deploy', 'HOSTINGER_CANONICAL_DEPLOY.md'),
  'utf8',
);
for (const marker of [
  CLIENT_CENTER_REQUIRED_MIGRATION,
  'مركز العملاء',
  'bazarvan-client-page-crawler',
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

const crawlerBundle = await readFile(
  path.join(root, 'server-dist', 'client-page-crawl-worker.mjs'),
  'utf8',
);
for (const marker of [
  'claim_next_client_page_crawl_job',
  'deterministic_html',
  'client_page_domain_not_allowed',
]) {
  if (!crawlerBundle.includes(marker)) {
    throw new Error(`Client Center crawler bundle is missing marker: ${marker}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  migrations: [CLIENT_CENTER_FOUNDATION_MIGRATION, CLIENT_CENTER_REQUIRED_MIGRATION],
  crawler: 'server-dist/client-page-crawl-worker.mjs',
  readinessEndpoint: '/readyz',
}, null, 2));
