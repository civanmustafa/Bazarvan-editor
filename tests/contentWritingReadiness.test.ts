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
  failedRpc?: string;
  calls?: Array<{ table: string; columns: string; limit: number }>;
  rpcCalls?: string[];
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
  rpc: async (name: string) => {
    options.rpcCalls?.push(name);
    return {
      data: name === 'full_article_pipeline_schema_version' ? 3 : [] as unknown[],
      error: name === options.failedRpc
        ? { code: 'PGRST202', message: 'Internal RPC schema detail that must stay private.' }
        : null,
    };
  },
});

test('content-writing readiness checks every required schema surface', async () => {
  const readiness = await importReadiness();
  readiness.__resetContentWritingReadinessForTests();
  const calls: Array<{ table: string; columns: string; limit: number }> = [];
  const rpcCalls: string[] = [];
  const result = await readiness.checkContentWritingReadiness({
    client: createProbeClient({ calls, rpcCalls }),
    force: true,
    timeoutMs: 1_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.requiredMigrationCount, 18);
  assert.deepEqual(result.checks, {
    sessions: true,
    messages: true,
    steps: true,
    automationQueue: true,
    fullPipelineJobs: true,
    keyCoordinator: true,
    automationEvaluator: true,
    competitorPreparationCoordinator: true,
    fullPipelineCoordinator: true,
    fullPipelineVersion: true,
  });
  assert.deepEqual(rpcCalls.sort(), [
    'enqueue_content_writing_competitor_preparation',
    'enqueue_full_article_pipeline',
    'evaluate_content_writing_automation_readiness',
    'full_article_pipeline_schema_version',
    'inspect_gemini_api_key_availability',
  ]);
  assert.deepEqual(calls.map(call => call.table).sort(), [
    'ai_external_analysis_jobs',
    'content_writing_automation_items',
    'content_writing_messages',
    'content_writing_sessions',
    'content_writing_steps',
  ]);
  assert.ok(calls.every(call => call.limit === 1));
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /execution_mode/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /resume_preference_version/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /application_count/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /quality_guard_version/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /quality_policy_version/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /quality_report/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /knowledge_workflow_version/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /dynamic_final_section_version/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /parallel_substeps_version/);
  assert.match(calls.find(call => call.table === 'content_writing_sessions')?.columns || '', /pipeline_parent_job_id/);
  assert.match(calls.find(call => call.table === 'ai_external_analysis_jobs')?.columns || '', /lease_generation/);
  assert.match(calls.find(call => call.table === 'ai_external_analysis_jobs')?.columns || '', /dead_lettered_at/);
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

test('full-pipeline coordinator is a mandatory non-mutating readiness surface', async () => {
  const readiness = await importReadiness();
  readiness.__resetContentWritingReadinessForTests();
  const result = await readiness.checkContentWritingReadiness({
    client: createProbeClient({ failedRpc: 'enqueue_full_article_pipeline' }),
    force: true,
    timeoutMs: 1_000,
  });
  const publicResult = readiness.toPublicContentWritingReadiness(result);

  assert.equal(result.ok, false);
  assert.equal(result.checks.fullPipelineCoordinator, false);
  assert.match(result.detail, /fullPipelineCoordinator/);
  assert.doesNotMatch(JSON.stringify(publicResult), /Internal RPC schema detail|PGRST202/);
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
  assert.match(releaseRegistry, /20260723020000_content_writing_resume_preferences\.sql/);
  assert.match(releaseRegistry, /20260728000000_dynamic_content_writing_final_section\.sql/);
  assert.match(releaseRegistry, /20260728010000_content_writing_faq_independence\.sql/);
  assert.match(releaseRegistry, /20260728040000_content_writing_final_structure\.sql/);
  assert.match(releaseRegistry, /20260812010000_gemini_key_availability_waiting\.sql/);
  assert.match(releaseRegistry, /20260823010000_automatic_content_writing_queue\.sql/);
  assert.match(releaseRegistry, /20260823020000_content_writing_competitor_preparation\.sql/);
  assert.match(releaseRegistry, /20260728030000_full_article_pipeline\.sql/);
  assert.match(releaseRegistry, /20260824010000_full_article_pipeline_safety\.sql/);
  assert.match(releaseRegistry, /20260824020000_full_article_pipeline_optional_prerequisites\.sql/);
  assert.match(
    await readWorkspaceFile('server/contentWritingReadiness.ts'),
    /resume_preference_version/,
  );
  assert.match(releaseRegistry, /server-dist\/content-writing-worker\.mjs/);
  assert.match(releaseScript, /CONTENT_WRITING_REQUIRED_MIGRATIONS/);
  assert.match(releaseScript, /claim_next_content_writing_session/);
  assert.match(releaseScript, /resume_preference_version/);
  assert.match(releaseScript, /dynamic_final_section_version/);
  assert.match(releaseScript, /parallel_substeps_version/);
  assert.match(releaseScript, /faqIndependenceGuard/);
  assert.match(releaseScript, /finalSectionStructureGuard/);
  assert.match(releaseScript, /Competitor-preparation worker bundle is missing marker/);
  assert.match(server, /app\.get\('\/readyz', readyzHandler\)/);
  assert.match(server, /toPublicContentWritingReadiness/);
  assert.match(server, /toPublicExternalAnalysisQueueReadiness/);
  assert.match(server, /const degraded = ok && !externalAnalysisWorker\.ok/);
  assert.doesNotMatch(server, /&& externalAnalysisWorker\.ok/);
  assert.match(deploymentGuide, /curl -fsS https:\/\/smarteditor\.bazarvan\.com\/readyz/);
  assert.match(deploymentGuide, /pm2 describe bazarvan-staging-competitor-worker/);
  assert.match(deploymentGuide, /لا تعِد تشغيل خادم الويب تلقائيًا/);
  assert.match(packageJson.scripts?.postbuild || '', /check:content-writing-release/);
});
