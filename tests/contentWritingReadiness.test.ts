import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importReadiness = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../server/contentWritingReadiness.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const createProbeClient = (options: {
  failedTable?: string;
  calls?: Array<{ table: string; columns: string; limit: number }>;
} = {}) => ({
  from: (table: string) => ({
    select: (columns: string) => ({
      limit: async (limit: number) => {
        options.calls?.push({ table, columns, limit });
        return {
          data: [] as unknown[],
          error: table === options.failedTable
            ? { code: 'PGRST204', message: 'Internal schema detail that must stay private.' }
            : null,
        };
      },
    }),
  }),
});

test('content-writing readiness checks every required schema surface', async () => {
  const readiness = await importReadiness();
  readiness.__resetContentWritingReadinessForTests();
  const calls: Array<{ table: string; columns: string; limit: number }> = [];
  const result = await readiness.checkContentWritingReadiness({
    client: createProbeClient({ calls }),
    force: true,
    timeoutMs: 1_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.requiredMigrationCount, 7);
  assert.deepEqual(result.checks, { sessions: true, messages: true, steps: true });
  assert.deepEqual(calls.map(call => call.table).sort(), [
    'content_writing_messages',
    'content_writing_sessions',
    'content_writing_steps',
  ]);
  assert.ok(calls.every(call => call.limit === 1));
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /execution_mode/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /application_count/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /quality_guard_version/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /quality_policy_version/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /quality_report/);
});

test('public readiness reports a safe 503 reason without exposing Supabase details', async () => {
  const readiness = await importReadiness();
  readiness.__resetContentWritingReadinessForTests();
  const result = await readiness.checkContentWritingReadiness({
    client: createProbeClient({ failedTable: 'content_writing_steps' }),
    force: true,
    timeoutMs: 1_000,
  });
  const publicResult = readiness.toPublicContentWritingReadiness(result);

  assert.equal(result.ok, false);
  assert.match(result.detail, /Internal schema detail/);
  assert.equal(publicResult.ok, false);
  assert.equal(publicResult.code, 'content_writing_schema_unavailable');
  assert.equal('detail' in publicResult, false);
  assert.doesNotMatch(JSON.stringify(publicResult), /Internal schema detail|PGRST204/);
});

test('production release gate verifies ordered migrations, bundles, and readiness endpoints', async () => {
  const [releaseRegistry, releaseScript, server, deploymentGuide, packageSource] = await Promise.all([
    readWorkspaceFile('constants/contentWritingRelease.ts'),
    readWorkspaceFile('scripts/checkContentWritingRelease.ts'),
    readWorkspaceFile('server/server.ts'),
    readWorkspaceFile('deploy/HOSTINGER_CANONICAL_DEPLOY.md'),
    readWorkspaceFile('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> };

  assert.match(releaseRegistry, /20260722040000_content_writing_quality_guards\.sql/);
  assert.match(releaseRegistry, /20260723000000_content_writing_quality_policy\.sql/);
  assert.match(releaseRegistry, /20260723010000_content_writing_knowledge_workflow\.sql/);
  assert.match(releaseRegistry, /server-dist\/content-writing-worker\.mjs/);
  assert.match(releaseScript, /CONTENT_WRITING_REQUIRED_MIGRATIONS/);
  assert.match(releaseScript, /claim_next_content_writing_session/);
  assert.match(server, /app\.get\('\/readyz', readyzHandler\)/);
  assert.match(server, /toPublicContentWritingReadiness/);
  assert.match(deploymentGuide, /curl -fsS https:\/\/smarteditor\.bazarvan\.com\/readyz/);
  assert.match(packageJson.scripts?.postbuild || '', /check:content-writing-release/);
});
