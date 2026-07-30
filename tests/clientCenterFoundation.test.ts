import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const assertBalancedSqlParentheses = (sql: string): void => {
  let depth = 0;
  for (const char of sql.replace(/--.*$/gm, '').replace(/'(?:''|[^'])*'/g, "''")) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    assert.ok(depth >= 0, 'SQL closes a parenthesis before it opens one.');
  }
  assert.equal(depth, 0, 'SQL has unbalanced parentheses.');
};

const importReadiness = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../server/clientCenterReadiness.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const createProbeClient = (options: {
  failedTable?: string;
  failedFunction?: string;
  calls?: Array<{ table: string; columns: string; limit: number }>;
  rpcCalls?: string[];
} = {}) => ({
  from: (table: string) => ({
    select: (columns: string) => ({
      limit: async (limit: number) => {
        options.calls?.push({ table, columns, limit });
        return {
          error: table === options.failedTable
            ? { code: 'PGRST204', message: 'Private schema detail.' }
            : null,
        };
      },
    }),
  }),
  rpc: async (functionName: string) => {
    options.rpcCalls?.push(functionName);
    return {
      error: functionName === options.failedFunction
        ? { code: 'PGRST202', message: 'Private function detail.' }
        : null,
    };
  },
});

test('Client Center migration creates the scoped multi-client foundation', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260724010000_client_center_foundation.sql',
  );

  for (const table of [
    'clients',
    'client_domains',
    'client_assignments',
    'client_pages',
    'client_page_crawl_jobs',
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }

  assert.match(migration, /create or replace function public\.client_access_level_for_user/);
  assert.match(migration, /create or replace function public\.can_read_client/);
  assert.match(migration, /create or replace function public\.can_edit_client/);
  assert.match(migration, /client_assignments_select_self_or_admin/);
  assert.match(migration, /client_pages_insert_editor_or_admin/);
  assert.match(migration, /client_page_crawl_jobs_insert_editor_or_admin/);
  assert.match(migration, /client_page_crawl_jobs_one_active_idx/);
  assert.match(
    migration,
    /revoke all on function public\.client_access_level_for_user\(uuid, uuid\) from public, anon, authenticated/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.client_access_level_for_user\(uuid, uuid\) to authenticated/,
  );
  assert.match(migration, /Editor articles are not a source for these rows/);

  for (const excludedField of [
    'logo_url',
    'brand_voice',
    'approved_terms',
    'prohibited_terms',
    'admin_notes',
    'products_services',
    'target_audience',
    'target_markets',
  ]) {
    assert.doesNotMatch(migration, new RegExp(`\\b${excludedField}\\b`, 'i'));
  }

  assert.doesNotMatch(migration, /api_key|key_fingerprint/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL has an unbalanced dollar quote.');
  assertBalancedSqlParentheses(migration);
});

test('Client Center draft creation is minimal, duplicate-safe, and scoped to its creator', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260725010000_client_draft_creation.sql',
  );

  assert.match(migration, /create or replace function public\.create_client_draft/);
  assert.match(migration, /returns public\.clients/);
  assert.match(migration, /security definer/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /lower\(btrim\(client\.name\)\) = lower\(v_name\)/);
  assert.match(migration, /insert into public\.client_assignments/);
  assert.match(migration, /'editor'::public\.client_assignment_access/);
  assert.match(migration, /if not public\.is_admin\(\)/);
  assert.match(migration, /grant execute on function public\.create_client_draft\(text, text\)\s+to authenticated/);
  assert.match(migration, /create or replace function public\.client_draft_creation_schema_version/);
  assert.match(migration, /grant execute on function public\.client_draft_creation_schema_version\(\)\s+to authenticated, service_role/);
  assert.doesNotMatch(migration, /insert into public\.client_domains/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL has an unbalanced dollar quote.');
  assertBalancedSqlParentheses(migration);
});

test('Client Center readiness probes every required table and hides provider details', async () => {
  const readiness = await importReadiness();
  readiness.__resetClientCenterReadinessForTests();
  const calls: Array<{ table: string; columns: string; limit: number }> = [];
  const rpcCalls: string[] = [];
  const ready = await readiness.checkClientCenterReadiness({
    client: createProbeClient({ calls, rpcCalls }),
    force: true,
    timeoutMs: 1_000,
  });

  assert.equal(ready.ok, true);
  assert.deepEqual(ready.checks, {
    clients: true,
    domains: true,
    assignments: true,
    pages: true,
    crawlJobs: true,
    siteCrawlRuns: true,
    crawlerProviderSecrets: true,
    internalLinkGraph: true,
    articleClientContexts: true,
    internalLinkActions: true,
    linkDictionaries: true,
    semanticProfiles: true,
    suggestionRuns: true,
    qualityPolicies: true,
    clientDraftCreation: true,
  });
  assert.deepEqual(rpcCalls, ['client_draft_creation_schema_version']);
  assert.deepEqual(calls.map(call => call.table).sort(), [
    'article_client_contexts',
    'client_assignments',
    'client_domains',
    'client_internal_links',
    'client_link_dictionaries',
    'client_link_suggestion_runs',
    'client_page_crawl_jobs',
    'client_page_semantic_profiles',
    'client_pages',
    'client_site_crawl_runs',
    'clients',
    'crawler_provider_secrets',
    'internal_link_actions',
    'internal_link_quality_policies',
  ]);
  assert.ok(calls.every(call => call.limit === 1));

  readiness.__resetClientCenterReadinessForTests();
  const failed = await readiness.checkClientCenterReadiness({
    client: createProbeClient({ failedTable: 'client_pages' }),
    force: true,
    timeoutMs: 1_000,
  });
  const publicResult = readiness.toPublicClientCenterReadiness(failed);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /Private schema detail/);
  assert.equal(publicResult.code, 'client_center_schema_unavailable');
  assert.equal('detail' in publicResult, false);
  assert.doesNotMatch(JSON.stringify(publicResult), /Private schema detail|PGRST204/);

  readiness.__resetClientCenterReadinessForTests();
  const missingDraftFunction = await readiness.checkClientCenterReadiness({
    client: createProbeClient({ failedFunction: 'client_draft_creation_schema_version' }),
    force: true,
    timeoutMs: 1_000,
  });
  assert.equal(missingDraftFunction.ok, false);
  assert.equal(missingDraftFunction.checks.clientDraftCreation, false);
  assert.match(missingDraftFunction.detail, /Private function detail/);
});

test('Client Center release gate is wired to build and readiness', async () => {
  const [registry, script, server, guide, packageSource] = await Promise.all([
    readWorkspaceFile('constants/clientCenter.ts'),
    readWorkspaceFile('scripts/checkClientCenterRelease.ts'),
    readWorkspaceFile('server/server.ts'),
    readWorkspaceFile('deploy/HOSTINGER_CANONICAL_DEPLOY.md'),
    readWorkspaceFile('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> };

  assert.match(registry, /20260724010000_client_center_foundation\.sql/);
  assert.match(registry, /20260724020000_client_center_management_and_crawling\.sql/);
  assert.match(registry, /20260724030000_internal_linking_engine\.sql/);
  assert.match(registry, /20260724040000_client_semantic_index\.sql/);
  assert.match(registry, /20260724050000_editor_internal_link_suggestions\.sql/);
  assert.match(registry, /20260724060000_internal_link_quality_policies\.sql/);
  assert.match(registry, /20260725010000_client_draft_creation\.sql/);
  assert.match(script, /CLIENT_CENTER_REQUIRED_MIGRATION/);
  assert.match(script, /CLIENT_CENTER_ACCEPTANCE_VERSION/);
  assert.match(script, /CLIENT_CENTER_ACCEPTANCE_CASES/);
  assert.match(script, /clientCenterAcceptance\.test\.ts/);
  assert.match(server, /checkClientCenterReadiness/);
  assert.match(server, /toPublicClientCenterReadiness/);
  assert.match(guide, /20260724010000_client_center_foundation\.sql/);
  assert.match(guide, /20260724020000_client_center_management_and_crawling\.sql/);
  assert.match(guide, /20260724030000_internal_linking_engine\.sql/);
  assert.match(guide, /20260724040000_client_semantic_index\.sql/);
  assert.match(guide, /20260724050000_editor_internal_link_suggestions\.sql/);
  assert.match(guide, /20260724060000_internal_link_quality_policies\.sql/);
  assert.match(guide, /20260725010000_client_draft_creation\.sql/);
  assert.match(guide, /المرحلة العاشرة/);
  assert.match(guide, /13 حالة قبول/);
  assert.match(packageJson.scripts?.postbuild || '', /check:client-center-release/);
  assert.match(packageJson.scripts?.postbuild || '', /test:client-center-acceptance/);
});
