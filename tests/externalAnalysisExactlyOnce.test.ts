import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  deduplicateExternalAnalysisTasks,
  getExternalAnalysisTaskIdentity,
} from '../utils/externalAnalysisTaskRegistry.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const task = (options: {
  id: string;
  jobType: 'semantic_keywords_lsi' | 'engineering_command';
  commandId?: string;
  status?: string;
  result?: Record<string, unknown> | null;
  errorCode?: string;
}) => ({
  id: options.id,
  article_id: 'article-1',
  job_type: options.jobType,
  command_id: options.commandId || null,
  readiness_signature: 'signature-1',
  status: options.status || 'queued',
  result: options.result ?? null,
  last_error_code: options.errorCode || null,
  attempt_count: 1,
  completed_at: options.status === 'completed' ? '2026-07-14T12:00:00.000Z' : null,
  updated_at: '2026-07-14T12:00:00.000Z',
  created_at: '2026-07-14T11:00:00.000Z',
});

test('external analysis task identity ignores batch and origin details', () => {
  const first = getExternalAnalysisTaskIdentity(task({
    id: 'job-1',
    jobType: 'engineering_command',
    commandId: 'smartAnalysis.fullArticleAudit',
  }));
  const second = getExternalAnalysisTaskIdentity(task({
    id: 'job-2',
    jobType: 'engineering_command',
    commandId: 'smartAnalysis.fullArticleAudit',
  }));
  assert.equal(first, second);
});

test('six external analyses stay six when historical jobs contain duplicates', () => {
  const rows = [
    task({ id: 'semantic-success', jobType: 'semantic_keywords_lsi', status: 'completed', result: { status: 'completed' } }),
    task({ id: 'semantic-duplicate', jobType: 'semantic_keywords_lsi', status: 'queued' }),
    task({ id: 'command-1-success', jobType: 'engineering_command', commandId: 'command-1', status: 'completed', result: { status: 'completed' } }),
    task({ id: 'command-1-duplicate', jobType: 'engineering_command', commandId: 'command-1', status: 'running' }),
    task({ id: 'command-2', jobType: 'engineering_command', commandId: 'command-2', status: 'completed', result: { status: 'completed' } }),
    task({ id: 'command-3', jobType: 'engineering_command', commandId: 'command-3', status: 'retry_scheduled' }),
    task({ id: 'command-4', jobType: 'engineering_command', commandId: 'command-4', status: 'queued' }),
    task({ id: 'command-5', jobType: 'engineering_command', commandId: 'command-5', status: 'completed', result: { status: 'completed' } }),
  ];

  const deduplicated = deduplicateExternalAnalysisTasks(rows);
  assert.equal(deduplicated.length, 6);
  assert.ok(deduplicated.some(row => row.id === 'semantic-success'));
  assert.ok(deduplicated.some(row => row.id === 'command-1-success'));
  assert.ok(!deduplicated.some(row => row.id === 'semantic-duplicate'));
  assert.ok(!deduplicated.some(row => row.id === 'command-1-duplicate'));
});

test('external analysis queue enforces one canonical job and retries by job id', async () => {
  const [migration, api, client, resultsTab] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260714020000_external_analysis_exactly_once.sql'),
    readWorkspaceFile('api/externalAnalysis.ts'),
    readWorkspaceFile('utils/externalAnalysis.ts'),
    readWorkspaceFile('components/ExternalAnalysisResultsTab.tsx'),
  ]);

  assert.match(migration, /ai_external_analysis_jobs_execution_once_idx/);
  assert.match(migration, /create or replace function public\.retry_external_analysis_job/);
  assert.match(migration, /where job\.id = v_job\.id\s+returning job\.\* into v_job/);
  assert.match(migration, /v_job_status in \('failed', 'blocked', 'cancelled'\)/);
  assert.match(migration, /v_job\.status = 'completed'/);
  assert.match(api, /rpc\(\s*'enqueue_external_engineering_jobs'/);
  assert.match(api, /rpc\('retry_external_analysis_job'/);
  assert.doesNotMatch(api, /\.from\('ai_external_analysis_jobs'\)\s*\.insert\(/);
  assert.match(client, /action: 'retry', jobId/);
  assert.match(resultsTab, /retryExternalAnalysisJob\(articleId, job\.id\)/);
  assert.doesNotMatch(resultsTab, /enqueueExternalEngineeringAnalysis\(articleId, \[job\.command_id\]\)/);
});
