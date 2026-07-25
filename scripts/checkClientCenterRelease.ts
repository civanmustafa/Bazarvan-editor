import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CLIENT_CENTER_FOUNDATION_MIGRATION,
  CLIENT_CENTER_CRAWLING_MIGRATION,
  CLIENT_CENTER_EDITOR_SUGGESTIONS_MIGRATION,
  CLIENT_CENTER_INTERNAL_LINKING_MIGRATION,
  CLIENT_CENTER_QUALITY_POLICY_MIGRATION,
  CLIENT_CENTER_SEMANTIC_INDEX_MIGRATION,
  CLIENT_CENTER_REQUIRED_MIGRATION,
} from '../constants/clientCenter.ts';
import {
  CLIENT_CENTER_ACCEPTANCE_CASES,
  CLIENT_CENTER_ACCEPTANCE_VERSION,
} from '../constants/clientCenterAcceptance.ts';

const root = process.cwd();
if (CLIENT_CENTER_ACCEPTANCE_VERSION !== 10) {
  throw new Error(
    `Unexpected Client Center acceptance version: ${CLIENT_CENTER_ACCEPTANCE_VERSION}`,
  );
}
if (
  CLIENT_CENTER_ACCEPTANCE_CASES.length !== 13
  || new Set(CLIENT_CENTER_ACCEPTANCE_CASES.map(item => item.id)).size !== 13
) {
  throw new Error('Client Center final acceptance registry must contain 13 unique cases.');
}

for (const migration of [
  CLIENT_CENTER_FOUNDATION_MIGRATION,
  CLIENT_CENTER_CRAWLING_MIGRATION,
  CLIENT_CENTER_INTERNAL_LINKING_MIGRATION,
  CLIENT_CENTER_SEMANTIC_INDEX_MIGRATION,
  CLIENT_CENTER_EDITOR_SUGGESTIONS_MIGRATION,
  CLIENT_CENTER_QUALITY_POLICY_MIGRATION,
  CLIENT_CENTER_REQUIRED_MIGRATION,
]) {
  const migrationPath = path.join(root, 'supabase', 'migrations', migration);
  const migrationInfo = await stat(migrationPath);
  if (!migrationInfo.isFile() || migrationInfo.size < 1_000) {
    throw new Error(`Client Center migration is missing or empty: ${migration}`);
  }
}

const acceptanceTest = await readFile(
  path.join(root, 'tests', 'clientCenterAcceptance.test.ts'),
  'utf8',
);
for (const acceptanceCase of CLIENT_CENTER_ACCEPTANCE_CASES) {
  if (!acceptanceTest.includes(acceptanceCase.id)) {
    throw new Error(
      `Client Center acceptance test is missing registered case: ${acceptanceCase.id}`,
    );
  }
}

for (const [sourcePath, marker] of [
  ['utils/clientCenter.ts', 'prepareClientPageUrlBatch'],
  ['server/clientPageCrawler.ts', 'sanitizeDiscoveredClientUrl'],
  ['utils/clientSemanticIndex.ts', 'isGenericClientPageTitle'],
  ['utils/internalLinkingEngine.ts', 'resolveInternalLinkTargetUrl'],
] as const) {
  const source = await readFile(path.join(root, ...sourcePath.split('/')), 'utf8');
  if (!source.includes(marker)) {
    throw new Error(`Client Center release protection is missing: ${sourcePath} -> ${marker}`);
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
  'client_page_semantic_profiles',
  'client_link_suggestion_runs',
  'internal_link_quality_policies',
  'client_draft_creation_schema_version',
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
  'Semantic indexing failed',
  'client_page_domain_not_allowed',
]) {
  if (!crawlerBundle.includes(marker)) {
    throw new Error(`Client Center crawler bundle is missing marker: ${marker}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  migrations: [
    CLIENT_CENTER_FOUNDATION_MIGRATION,
    CLIENT_CENTER_CRAWLING_MIGRATION,
    CLIENT_CENTER_INTERNAL_LINKING_MIGRATION,
    CLIENT_CENTER_SEMANTIC_INDEX_MIGRATION,
    CLIENT_CENTER_EDITOR_SUGGESTIONS_MIGRATION,
    CLIENT_CENTER_QUALITY_POLICY_MIGRATION,
    CLIENT_CENTER_REQUIRED_MIGRATION,
  ],
  crawler: 'server-dist/client-page-crawl-worker.mjs',
  readinessEndpoint: '/readyz',
  acceptanceVersion: CLIENT_CENTER_ACCEPTANCE_VERSION,
  acceptanceCases: CLIENT_CENTER_ACCEPTANCE_CASES.map(item => item.id),
}, null, 2));
