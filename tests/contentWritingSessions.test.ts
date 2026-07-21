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

test('content-writing migration persists idempotent sessions and exactly three input messages', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260722000000_content_writing_sessions.sql',
  );

  assert.match(migration, /create table if not exists public\.content_writing_sessions/);
  assert.match(migration, /create table if not exists public\.content_writing_messages/);
  assert.match(migration, /unique \(created_by, idempotency_key\)/);
  assert.match(migration, /jsonb_array_length\(p_messages\) <> 3/);
  assert.match(migration, /Exactly three content writing messages are required/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /session\.status = 'running' and session\.lease_expires_at < now\(\)/);
  assert.match(migration, /'assistant_result'/);
  assert.match(migration, /using \(created_by = auth\.uid\(\) or public\.is_admin\(\)\)/);
  assert.match(migration, /grant execute on function public\.claim_next_content_writing_session\(text, integer\) to service_role/);
  assert.doesNotMatch(migration, /api_key|key_fingerprint/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL has an unbalanced dollar quote.');
  assertBalancedSqlParentheses(migration);
});

test('structured content-writing migration persists resumable steps without API secrets', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260722010000_structured_content_writing.sql',
  );

  assert.match(migration, /create table if not exists public\.content_writing_steps/);
  assert.match(migration, /unique \(session_id, step_key\)/);
  assert.match(migration, /unique \(session_id, ordinal\)/);
  assert.match(migration, /create policy "content_writing_steps_select_owner_or_admin"/);
  assert.match(migration, /create or replace function public\.start_content_writing_step/);
  assert.match(migration, /create or replace function public\.complete_content_writing_step/);
  assert.match(migration, /create or replace function public\.resume_content_writing_session/);
  assert.match(migration, /status in \('running', 'failed'\)/);
  assert.doesNotMatch(migration, /key_fingerprint|api_key/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL has an unbalanced dollar quote.');
  assertBalancedSqlParentheses(migration);
});

test('content-writing engine owns server-side context assembly and structured provider execution', async () => {
  const [engine, workflow, workflowBuilder, service, geminiEngine, openAiEngine] = await Promise.all([
    readWorkspaceFile('server/contentWritingEngine.ts'),
    readWorkspaceFile('server/contentWritingWorkflow.ts'),
    readWorkspaceFile('utils/contentWritingWorkflow.ts'),
    readWorkspaceFile('server/contentWritingSessionService.ts'),
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('server/openAiExecutionEngine.ts'),
  ]);

  assert.match(engine, /from\('articles'\)/);
  assert.match(engine, /from\('article_competitors'\)/);
  assert.match(engine, /getContentWritingCompetitorsFromMetadata/);
  assert.match(engine, /buildContentWritingPromptBundle/);
  assert.match(engine, /messages: bundle\.messages\.map/);
  assert.match(engine, /assertContentWritingConversation/);
  assert.match(engine, /systemInstruction: instructions\.content/);
  assert.match(engine, /executeContentWritingTurn/);
  assert.match(engine, /executeOpenAiRequest/);
  assert.doesNotMatch(engine, /competitor\.content\.slice|content_text\.slice/);
  assert.match(workflow, /executeStructuredContentWritingWorkflow/);
  assert.match(workflow, /getContentWritingSteps/);
  assert.match(workflow, /startContentWritingStep/);
  assert.match(workflow, /completeContentWritingStep/);
  assert.match(workflow, /buildContentWritingFinalReviewPrompt/);
  assert.match(workflow, /existing\.status === 'completed'/);
  assert.match(workflowBuilder, /createContentWritingWorkflowSteps/);
  assert.match(workflowBuilder, /assembleContentWritingDraft/);
  assert.doesNotMatch(workflowBuilder, /competitor.*slice/i);
  assert.match(service, /create_content_writing_session/);
  assert.match(service, /complete_content_writing_session/);
  assert.match(service, /resume_content_writing_session/);
  assert.match(service, /ContentWritingSessionSummary/);
  assert.doesNotMatch(service.match(/export const listContentWritingSessions[\s\S]*?export const cancelContentWritingSession/)?.[0] || '', /\.select\('\*'\)/);
  assert.match(geminiEngine, /systemInstruction: normalizedSystemInstruction/);
  assert.match(openAiEngine, /readAiProviderCapabilities\(\)/);
  assert.match(openAiEngine, /recordAiExecutionTelemetry/);
});

test('content-writing API enforces authentication, article access, and idempotent starts', async () => {
  const [api, registry] = await Promise.all([
    readWorkspaceFile('api/contentWriting.ts'),
    readWorkspaceFile('server/apiRouteRegistry.ts'),
  ]);

  assert.match(api, /authenticateApiRequest\(req\)/);
  assert.match(api, /requireArticleWriteAccess\(supabase, articleId, principal\.userId\)/);
  assert.match(api, /requireArticleReadAccess\(supabase, session\.article_id, principal\.userId\)/);
  assert.match(api, /IDEMPOTENCY_KEY_PATTERN/);
  assert.match(api, /queueContentWritingSession/);
  assert.match(api, /action === 'get'/);
  assert.match(api, /action === 'list'/);
  assert.match(api, /action === 'cancel'/);
  assert.match(api, /action === 'resume'/);
  assert.match(api, /getContentWritingSteps/);
  assert.match(registry, /path: '\/api\/content-writing'/);
});

test('content-writing worker keeps leases alive and is built and managed by PM2', async () => {
  const [worker, buildScript, ecosystem] = await Promise.all([
    readWorkspaceFile('server/contentWritingWorker.ts'),
    readWorkspaceFile('scripts/build-server.mjs'),
    readWorkspaceFile('ecosystem.config.cjs'),
  ]);

  assert.match(worker, /claimNextContentWritingSession/);
  assert.match(worker, /heartbeatContentWritingSession/);
  assert.match(worker, /executeStructuredContentWritingWorkflow/);
  assert.match(worker, /completeContentWritingSession/);
  assert.match(worker, /controller\.abort\(new ContentWritingCancellationError/);
  assert.match(worker, /ContentWritingWorkerShutdownError/);
  assert.match(buildScript, /server\/contentWritingWorker\.ts/);
  assert.match(ecosystem, /bazarvan-content-writing-worker/);
  assert.match(ecosystem, /CONTENT_WRITING_WORKER_CONCURRENCY/);
});
