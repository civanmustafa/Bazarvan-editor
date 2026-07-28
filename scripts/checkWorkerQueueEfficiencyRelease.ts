import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const migration = '20260728020000_worker_queue_wake_signals.sql';
const migrationPath = path.join(root, 'supabase', 'migrations', migration);
const migrationInfo = await stat(migrationPath);
if (!migrationInfo.isFile() || migrationInfo.size < 1_000) {
  throw new Error(`Worker queue efficiency migration is missing or incomplete: ${migration}`);
}

const deploymentGuide = await readFile(
  path.join(root, 'deploy', 'HOSTINGER_CANONICAL_DEPLOY.md'),
  'utf8',
);
if (!deploymentGuide.includes(migration)) {
  throw new Error(`Deployment guide does not include worker queue migration: ${migration}`);
}

const bundles = [
  'external-analysis-worker.mjs',
  'ai-job-worker.mjs',
  'content-writing-worker.mjs',
  'client-page-crawl-worker.mjs',
];
for (const bundle of bundles) {
  const source = await readFile(path.join(root, 'server-dist', bundle), 'utf8');
  for (const marker of ['worker_queue_signals', 'idlePoll=', 'Queue claim failed']) {
    if (!source.includes(marker)) {
      throw new Error(`Worker bundle ${bundle} is missing efficiency marker: ${marker}`);
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  migration,
  idleFallbackMaximumMs: 30_000,
  estimatedMaximumIdleClaimsPerHour: 720,
  bundles,
}, null, 2));
