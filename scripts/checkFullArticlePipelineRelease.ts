import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const migrations = [
  '20260728030000_full_article_pipeline.sql',
  '20260824010000_full_article_pipeline_safety.sql',
];
for (const migration of migrations) {
  const migrationPath = path.join(root, 'supabase', 'migrations', migration);
  const migrationInfo = await stat(migrationPath);
  if (!migrationInfo.isFile() || migrationInfo.size < 8_000) {
    throw new Error(`Full article pipeline migration is missing or incomplete: ${migration}`);
  }
}

const deploymentGuide = await readFile(
  path.join(root, 'deploy', 'HOSTINGER_CANONICAL_DEPLOY.md'),
  'utf8',
);
for (const migration of migrations) {
  if (!deploymentGuide.includes(migration)) {
    throw new Error(`Deployment guide does not include full pipeline migration: ${migration}`);
  }
}

const workerBundle = await readFile(
  path.join(root, 'server-dist', 'external-analysis-worker.mjs'),
  'utf8',
);
for (const marker of [
  'full_article_pipeline',
  'content_brief_generation',
  'apply_full_article_pipeline_content',
  'review_required',
  'pipelineLeaseGeneration',
  'full_pipeline_quality_review_required',
  'smartAnalysis.competitorContentComparison',
]) {
  if (!workerBundle.includes(marker)) {
    throw new Error(`External analysis worker bundle is missing full pipeline marker: ${marker}`);
  }
}

const ecosystem = await readFile(path.join(root, 'ecosystem.config.cjs'), 'utf8');
if (!ecosystem.includes('bazarvan-full-article-pipeline-worker')) {
  throw new Error('PM2 configuration is missing the dedicated full article pipeline worker.');
}

console.log(JSON.stringify({
  ok: true,
  migrations,
  stages: 7,
  qualityGatePolicy: 'review_required',
  retrySource: 'administrator externalAnalysisRetryMinutes',
}, null, 2));
