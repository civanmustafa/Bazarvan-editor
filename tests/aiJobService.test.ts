import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const assertBalancedSqlParentheses = (sql: string): void => {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (!quote && character === '-' && next === '-') {
      index = sql.indexOf('\n', index);
      if (index < 0) break;
      continue;
    }
    if (quote) {
      if (character === quote && next === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    assert.ok(depth >= 0, `Unexpected closing parenthesis at character ${index}.`);
  }
  assert.equal(quote, null, 'SQL contains an unterminated quoted value.');
  assert.equal(depth, 0, 'SQL contains mismatched parentheses.');
};

test('phase 6 migration creates durable owner-scoped jobs and atomic worker RPCs', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260713040000_phase_6_persistent_ai_jobs.sql',
  );

  assert.match(migration, /create table if not exists public\.ai_jobs/);
  assert.match(migration, /create table if not exists public\.ai_job_attempts/);
  assert.match(migration, /create or replace function public\.claim_next_ai_job/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /create or replace function public\.heartbeat_ai_job/);
  assert.match(migration, /create or replace function public\.request_ai_job_cancel/);
  assert.match(migration, /create or replace function public\.recover_stale_ai_jobs/);
  assert.match(migration, /using \(user_id = auth\.uid\(\) or public\.is_admin\(\)\)/);
  assert.match(migration, /grant execute on function public\.claim_next_ai_job\(text, integer\) to service_role/);
  assert.doesNotMatch(migration, /api_key|key_fingerprint/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL has an unbalanced dollar quote.');
  assertBalancedSqlParentheses(migration);
});

test('AiJobService exclusively owns persistence and stores only safe key suffixes', async () => {
  const service = await readWorkspaceFile('server/aiJobService.ts');

  assert.match(service, /from\('ai_jobs'\)/);
  assert.match(service, /from\('ai_job_attempts'\)/);
  assert.match(service, /request_ai_job_cancel/);
  assert.match(service, /claim_next_ai_job/);
  assert.match(service, /recover_stale_ai_jobs/);
  assert.match(service, /key_suffix: suffix \|\| null/);
  assert.doesNotMatch(service, /key_fingerprint|api_key|GEMINI_API_KEYS/);
});

test('durable worker uses the unified engine, heartbeat cancellation, and configured retries', async () => {
  const [worker, engine, browserEngine, buildScript, ecosystem] = await Promise.all([
    readWorkspaceFile('server/aiJobWorker.ts'),
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('utils/geminiAnalysisEngine.ts'),
    readWorkspaceFile('scripts/build-server.mjs'),
    readWorkspaceFile('ecosystem.config.cjs'),
  ]);

  assert.match(worker, /aiExecutionEngine\.executeGemini/);
  assert.match(worker, /heartbeatAiJob/);
  assert.match(worker, /controller\.abort\(new UserCancellationError/);
  assert.match(worker, /readAiJobRetryMinutes/);
  assert.match(worker, /scheduleAiJobRetry/);
  assert.match(worker, /recoverStaleAiJobs/);
  assert.match(engine, /await createAiJob/);
  assert.match(engine, /await getAiJobForOwner/);
  assert.match(engine, /await requestAiJobCancel/);
  assert.doesNotMatch(engine, /const geminiJobStore = new Map/);
  assert.match(browserEngine, /data\.cancellationRequested === true/);
  assert.match(browserEngine, /progress\.jobStatus === 'cancelled'/);
  assert.match(buildScript, /server\/aiJobWorker\.ts/);
  assert.match(ecosystem, /bazarvan-ai-job-worker/);
});
