import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CLIENT_CENTER_FOUNDATION_MIGRATION,
  CLIENT_CENTER_HYBRID_CRAWLER_MIGRATION,
  CLIENT_CENTER_CRAWLING_MIGRATION,
  CLIENT_CENTER_CRAWL_SOURCE_MIGRATION,
  CLIENT_CENTER_DRAFT_CREATION_MIGRATION,
  CLIENT_CENTER_EDITOR_SUGGESTIONS_MIGRATION,
  CLIENT_CENTER_INTERNAL_LINKING_MIGRATION,
  CLIENT_CENTER_QUALITY_POLICY_MIGRATION,
  CLIENT_CENTER_SEMANTIC_INDEX_MIGRATION,
  CLIENT_CENTER_SITE_CRAWLER_MIGRATION,
  CLIENT_CENTER_AI_LINK_PROFILES_MIGRATION,
  CLIENT_CENTER_CRAWL_PGCRYPTO_FIX_MIGRATION,
  CLIENT_CENTER_ECONOMIC_CRAWLER_MIGRATION,
  CRAWLER_PROVIDER_SECRETS_MIGRATION,
  CRAWLER_PROVIDER_USAGE_REPORTS_MIGRATION,
  CLIENT_CENTER_REQUIRED_MIGRATION,
} from '../constants/clientCenter.ts';
import {
  CLIENT_CENTER_ACCEPTANCE_CASES,
  CLIENT_CENTER_ACCEPTANCE_VERSION,
} from '../constants/clientCenterAcceptance.ts';
import { PROVIDER_CREDENTIAL_VAULT_MIGRATION } from '../server/providerCredentialVault.ts';
import { PROVIDER_EXPLICIT_GRANTS_MIGRATION } from '../constants/providerAccessControl.ts';

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
  CLIENT_CENTER_DRAFT_CREATION_MIGRATION,
  CLIENT_CENTER_SITE_CRAWLER_MIGRATION,
  CRAWLER_PROVIDER_SECRETS_MIGRATION,
  CLIENT_CENTER_HYBRID_CRAWLER_MIGRATION,
  CRAWLER_PROVIDER_USAGE_REPORTS_MIGRATION,
  CLIENT_CENTER_AI_LINK_PROFILES_MIGRATION,
  CLIENT_CENTER_CRAWL_PGCRYPTO_FIX_MIGRATION,
  CLIENT_CENTER_ECONOMIC_CRAWLER_MIGRATION,
  PROVIDER_CREDENTIAL_VAULT_MIGRATION,
  PROVIDER_EXPLICIT_GRANTS_MIGRATION,
]) {
  const migrationPath = path.join(root, 'supabase', 'migrations', migration);
  const migrationInfo = await stat(migrationPath);
  if (!migrationInfo.isFile() || migrationInfo.size < 1_000) {
    throw new Error(`Client Center migration is missing or empty: ${migration}`);
  }
}
const crawlSourceMigration = await stat(
  path.join(root, 'supabase', 'migrations', CLIENT_CENTER_CRAWL_SOURCE_MIGRATION),
);
if (!crawlSourceMigration.isFile() || crawlSourceMigration.size < 1) {
  throw new Error(`Client Center crawl source migration is missing: ${CLIENT_CENTER_CRAWL_SOURCE_MIGRATION}`);
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
  ['server/clientPageCrawler.ts', 'extractClientPageLinksFromHtml'],
  ['server/clientPageCrawlerProviders.ts', 'crawlClientPageWithProvider'],
  ['server/crawlerProviderSecrets.ts', 'resolveCrawlerProviderCredential'],
  ['api/clientSiteCrawler.ts', 'start_client_site_crawl'],
  ['api/adminCrawlerProviderSecrets.ts', 'admin:crawler-provider-secrets'],
  ['api/adminCrawlerProviderUsage.ts', 'admin:crawler-provider-usage'],
  ['server/crawlerProviderUsage.ts', 'recordCrawlerProviderUsageEvent'],
  ['server/crawlerUsagePolicy.ts', 'reserveCrawlerExternalRequest'],
  ['utils/clientSemanticIndex.ts', 'isGenericClientPageTitle'],
  ['utils/internalLinkingEngine.ts', 'resolveInternalLinkTargetUrl'],
  ['server/clientPageAiLinkProfile.ts', 'client_page_link_profile'],
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
  CLIENT_CENTER_CRAWL_SOURCE_MIGRATION,
  CRAWLER_PROVIDER_SECRETS_MIGRATION,
  PROVIDER_CREDENTIAL_VAULT_MIGRATION,
  PROVIDER_EXPLICIT_GRANTS_MIGRATION,
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
  'client_site_crawl_runs',
  'client_internal_links',
  'client_page_semantic_profiles',
  'client_page_ai_link_profiles',
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
  'internalLinks',
  'firecrawl',
  'browserless',
  'rendered_html',
  'reuse_fresh_client_page_crawl_job',
  'reserve_crawler_external_request',
  'client_page_link_profile',
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
    CLIENT_CENTER_DRAFT_CREATION_MIGRATION,
    CLIENT_CENTER_CRAWL_SOURCE_MIGRATION,
    CLIENT_CENTER_SITE_CRAWLER_MIGRATION,
    CRAWLER_PROVIDER_SECRETS_MIGRATION,
    CLIENT_CENTER_HYBRID_CRAWLER_MIGRATION,
    CRAWLER_PROVIDER_USAGE_REPORTS_MIGRATION,
    CLIENT_CENTER_AI_LINK_PROFILES_MIGRATION,
    CLIENT_CENTER_CRAWL_PGCRYPTO_FIX_MIGRATION,
    CLIENT_CENTER_ECONOMIC_CRAWLER_MIGRATION,
    PROVIDER_CREDENTIAL_VAULT_MIGRATION,
    PROVIDER_EXPLICIT_GRANTS_MIGRATION,
  ],
  crawler: 'server-dist/client-page-crawl-worker.mjs',
  readinessEndpoint: '/readyz',
  acceptanceVersion: CLIENT_CENTER_ACCEPTANCE_VERSION,
  acceptanceCases: CLIENT_CENTER_ACCEPTANCE_CASES.map(item => item.id),
}, null, 2));
