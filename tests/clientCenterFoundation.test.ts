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
  calls?: Array<{ table: string; columns: string; limit: number }>;
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

test('Client Center readiness probes every required table and hides provider details', async () => {
  const readiness = await importReadiness();
  readiness.__resetClientCenterReadinessForTests();
  const calls: Array<{ table: string; columns: string; limit: number }> = [];
  const ready = await readiness.checkClientCenterReadiness({
    client: createProbeClient({ calls }),
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
  });
  assert.deepEqual(calls.map(call => call.table).sort(), [
    'client_assignments',
    'client_domains',
    'client_page_crawl_jobs',
    'client_pages',
    'clients',
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
  assert.match(script, /CLIENT_CENTER_REQUIRED_MIGRATION/);
  assert.match(server, /checkClientCenterReadiness/);
  assert.match(server, /toPublicClientCenterReadiness/);
  assert.match(guide, /20260724010000_client_center_foundation\.sql/);
  assert.match(guide, /20260724020000_client_center_management_and_crawling\.sql/);
  assert.match(packageJson.scripts?.postbuild || '', /check:client-center-release/);
});
