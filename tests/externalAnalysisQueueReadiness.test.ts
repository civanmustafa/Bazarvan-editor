import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importReadiness = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../server/externalAnalysisQueueReadiness.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const createProbeClient = (
  rows: Array<Record<string, unknown>>,
  error: { code?: string; message?: string } | null = null,
) => ({
  from: (table: string) => {
    assert.equal(table, 'ai_external_analysis_jobs');
    return {
      select: (columns: string) => {
        assert.match(columns, /lease_expires_at/);
        return {
          eq: (column: string, value: string) => {
            assert.deepEqual([column, value], ['job_type', 'competitor_extraction']);
            return {
              in: (statusColumn: string, statuses: string[]) => {
                assert.equal(statusColumn, 'status');
                assert.deepEqual(statuses, ['queued', 'running']);
                return {
                  order: () => ({
                    limit: async () => ({ data: rows, error }),
                  }),
                };
              },
            };
          },
        };
      },
    };
  },
});

test('readiness reports a competitor extraction job that no worker claimed', async () => {
  const readiness = await importReadiness();
  readiness.__resetExternalAnalysisQueueReadinessForTests();
  const now = Date.parse('2026-07-25T12:00:00.000Z');
  const result = await readiness.checkExternalAnalysisQueueReadiness({
    client: createProbeClient([{
      status: 'queued',
      created_at: '2026-07-25T11:58:00.000Z',
      lease_expires_at: null,
    }]),
    now,
    force: true,
    firecrawlConfigured: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stalledQueuedCount, 1);
  assert.equal(result.code, 'external_analysis_worker_unavailable');
  assert.equal(result.checks.queueTable, true);
  assert.equal(result.checks.noStalledCompetitorJobs, false);
});

test('a healthy running lease prevents a queued backlog from being labeled as a dead worker', async () => {
  const readiness = await importReadiness();
  readiness.__resetExternalAnalysisQueueReadinessForTests();
  const now = Date.parse('2026-07-25T12:00:00.000Z');
  const result = await readiness.checkExternalAnalysisQueueReadiness({
    client: createProbeClient([
      {
        status: 'queued',
        created_at: '2026-07-25T11:50:00.000Z',
        lease_expires_at: null,
      },
      {
        status: 'running',
        created_at: '2026-07-25T11:59:00.000Z',
        lease_expires_at: '2026-07-25T12:05:00.000Z',
      },
    ]),
    now,
    force: true,
    firecrawlConfigured: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.queuedCount, 1);
  assert.equal(result.runningCount, 1);
  assert.equal(result.stalledQueuedCount, 0);
  assert.equal(result.expiredRunningCount, 0);
});

test('public readiness exposes safe diagnostics without internal database errors', async () => {
  const readiness = await importReadiness();
  readiness.__resetExternalAnalysisQueueReadinessForTests();
  const result = await readiness.checkExternalAnalysisQueueReadiness({
    client: createProbeClient([], {
      code: 'PGRST204',
      message: 'Private database connection detail.',
    }),
    force: true,
    firecrawlConfigured: true,
  });
  const publicResult = readiness.toPublicExternalAnalysisQueueReadiness(result);

  assert.equal(result.ok, false);
  assert.equal(publicResult.code, 'external_analysis_worker_unavailable');
  assert.equal('detail' in publicResult, false);
  assert.doesNotMatch(JSON.stringify(publicResult), /Private database connection detail|PGRST204/);
});

test('Firecrawl configuration is part of worker readiness', async () => {
  const readiness = await importReadiness();
  readiness.__resetExternalAnalysisQueueReadinessForTests();
  const result = await readiness.checkExternalAnalysisQueueReadiness({
    client: createProbeClient([]),
    force: true,
    firecrawlConfigured: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.firecrawlConfigured, false);
});
