import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CONTENT_WRITING_RELEASE_ARTIFACTS,
  CONTENT_WRITING_REQUIRED_MIGRATIONS,
} from '../constants/contentWritingRelease.ts';

const root = process.cwd();
const deploymentGuidePath = path.join(root, 'deploy', 'HOSTINGER_CANONICAL_DEPLOY.md');
const deploymentGuide = await readFile(deploymentGuidePath, 'utf8');

let previousMigrationPosition = -1;
for (const migration of CONTENT_WRITING_REQUIRED_MIGRATIONS) {
  const migrationPath = path.join(root, 'supabase', 'migrations', migration);
  const migrationInfo = await stat(migrationPath);
  if (!migrationInfo.isFile() || migrationInfo.size < 100) {
    throw new Error(`Required content-writing migration is missing or empty: ${migration}`);
  }
  const position = deploymentGuide.indexOf(migration);
  if (position < 0) {
    throw new Error(`Deployment guide does not include required migration: ${migration}`);
  }
  if (position <= previousMigrationPosition) {
    throw new Error(`Content-writing migrations are not listed in execution order: ${migration}`);
  }
  previousMigrationPosition = position;
}

const artifactSizes: Record<string, number> = {};
for (const artifact of CONTENT_WRITING_RELEASE_ARTIFACTS) {
  const artifactPath = path.join(root, ...artifact.split('/'));
  const artifactInfo = await stat(artifactPath);
  if (!artifactInfo.isFile() || artifactInfo.size < 100) {
    throw new Error(`Content-writing release artifact is missing or empty: ${artifact}`);
  }
  artifactSizes[artifact] = artifactInfo.size;
}

const serverBundle = await readFile(path.join(root, 'server-dist', 'server.mjs'), 'utf8');
const workerBundle = await readFile(path.join(root, 'server-dist', 'content-writing-worker.mjs'), 'utf8');
const requiredServerMarkers = [
  '/readyz',
  '/api/content-writing',
  '/api/content-writing/external-result',
  'content_writing_sessions',
  'content_writing_steps',
  'quality_guard_version',
  'quality_policy_version',
  'quality_report',
];
for (const marker of requiredServerMarkers) {
  if (!serverBundle.includes(marker)) {
    throw new Error(`Production server bundle is missing content-writing marker: ${marker}`);
  }
}
const requiredWorkerMarkers = [
  'claim_next_content_writing_session',
  'heartbeat_content_writing_session',
  'complete_content_writing_session',
  'fail_content_writing_session',
  'Quality repair',
  'Competitor knowledge index',
  'Knowledge coverage audit',
  'competitor_index',
  'coverage_audit',
];
for (const marker of requiredWorkerMarkers) {
  if (!workerBundle.includes(marker)) {
    throw new Error(`Content-writing worker bundle is missing marker: ${marker}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  migrations: CONTENT_WRITING_REQUIRED_MIGRATIONS.length,
  artifacts: artifactSizes,
  readinessEndpoint: '/readyz',
}, null, 2));
