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

test('content-writing application migration records explicit editor approvals', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260722020000_content_writing_application.sql',
  );

  assert.match(migration, /add column if not exists applied_at timestamptz/);
  assert.match(migration, /add column if not exists applied_by uuid/);
  assert.match(migration, /add column if not exists application_count integer/);
  assert.match(migration, /create or replace function public\.record_content_writing_application/);
  assert.match(migration, /v_session\.status <> 'completed'/);
  assert.match(migration, /application_count = session\.application_count \+ 1/);
  assert.match(migration, /grant execute on function public\.record_content_writing_application\(uuid, uuid\)/);
  assert.doesNotMatch(migration, /key_fingerprint|api_key/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL has an unbalanced dollar quote.');
  assertBalancedSqlParentheses(migration);
});

test('content-writing external reporting migration records one completed external result safely', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260722030000_content_writing_external_reporting.sql',
  );

  assert.match(migration, /add column if not exists execution_mode text not null default 'api'/);
  assert.match(migration, /check \(execution_mode in \('api', 'external'\)\)/);
  assert.match(migration, /create or replace function public\.record_external_content_writing_result/);
  assert.match(migration, /on conflict \(created_by, idempotency_key\) do nothing/);
  assert.match(migration, /jsonb_array_length\(p_messages\) <> 3/);
  assert.match(migration, /'assistant_result'/);
  assert.match(migration, /v_session\.result_text is distinct from p_result_text/);
  assert.match(migration, /to service_role/);
  assert.doesNotMatch(migration, /api_key|key_fingerprint/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL has an unbalanced dollar quote.');
  assertBalancedSqlParentheses(migration);
});

test('content-writing quality guards serialize starts and enforce one active API session', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260722040000_content_writing_quality_guards.sql',
  );

  assert.match(migration, /content_writing_sessions_one_active_api_idx/);
  assert.match(migration, /quality_guard_version smallint not null default 1/);
  assert.match(migration, /where execution_mode = 'api'/);
  assert.match(migration, /status in \('queued', 'running', 'retry_scheduled'\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /'reusedActive', true/);
  assert.match(migration, /active_session\.id <> v_session\.id/);
  assert.match(migration, /create or replace function public\.resume_content_writing_session/);
  assert.match(migration, /duplicate_active_session_closed/);
  assert.doesNotMatch(migration, /api_key|key_fingerprint/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL has an unbalanced dollar quote.');
  assertBalancedSqlParentheses(migration);
});

test('content-writing quality policy migration persists versioned reports, repairs, and audited overrides', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260723000000_content_writing_quality_policy.sql',
  );

  assert.match(migration, /quality_policy_version integer not null default 1/);
  assert.match(migration, /quality_score integer/);
  assert.match(migration, /quality_report jsonb not null default '\{\}'::jsonb/);
  assert.match(migration, /quality_repair_count integer not null default 0/);
  assert.match(migration, /'quality_repair'/);
  assert.match(migration, /sync_content_writing_quality_metadata/);
  assert.match(migration, /p_quality_override_reason text default null/);
  assert.match(migration, /char_length\(coalesce\(v_override_reason, ''\)\) < 8/);
  assert.doesNotMatch(migration, /api_key|key_fingerprint/i);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL has an unbalanced dollar quote.');
  assertBalancedSqlParentheses(migration);
});

test('content-writing knowledge workflow migration enables indexing, audits, and targeted repairs', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260723010000_content_writing_knowledge_workflow.sql',
  );

  assert.match(migration, /'competitor_index'/);
  assert.match(migration, /'coverage_audit'/);
  assert.match(migration, /'section_repair'/);
  assert.match(migration, /create or replace function public\.ensure_content_writing_step/);
  assert.doesNotMatch(migration, /api_key|key_fingerprint/i);
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
  assert.match(engine, /prepareContentWritingConversation/);
  assert.match(engine, /messages: conversation\.messages\.map/);
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
  assert.match(workflow, /buildContentWritingCompetitorIndexPrompt/);
  assert.match(workflow, /buildContentWritingCoverageAuditPrompt/);
  assert.match(workflow, /section-repair-/);
  assert.match(workflow, /evaluateContentWritingQuality/);
  assert.match(workflow, /buildContentWritingRepairPrompt/);
  assert.match(workflow, /quality-repair-/);
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
  assert.match(openAiEngine, /prompt_cache_key/);
  assert.match(openAiEngine, /conversationMode === 'independent'/);
});

test('content-writing API enforces authentication, article access, and idempotent starts', async () => {
  const [api, externalApi, registry] = await Promise.all([
    readWorkspaceFile('api/contentWriting.ts'),
    readWorkspaceFile('api/contentWritingExternalResult.ts'),
    readWorkspaceFile('server/apiRouteRegistry.ts'),
  ]);

  assert.match(api, /authenticateApiRequest\(req\)/);
  assert.match(api, /requireArticleWriteAccess\(supabase, articleId, principal\.userId\)/);
  assert.match(api, /requireArticleReadAccess\(supabase, session\.article_id, principal\.userId\)/);
  assert.match(api, /IDEMPOTENCY_KEY_PATTERN/);
  assert.match(api, /queueContentWritingSession/);
  assert.match(api, /reusedActive: queued\.reusedActive === true/);
  assert.match(api, /action === 'prepareExternal'/);
  assert.match(api, /prepareContentWritingConversation/);
  assert.match(api, /action === 'get'/);
  assert.match(api, /action === 'list'/);
  assert.match(api, /action === 'cancel'/);
  assert.match(api, /action === 'resume'/);
  assert.match(api, /action === 'recordApplication'/);
  assert.match(api, /recordContentWritingApplication/);
  assert.match(api, /resolveSessionQualityReport/);
  assert.match(api, /content_writing_quality_gate_failed/);
  assert.match(api, /getContentWritingSteps/);
  assert.match(registry, /path: '\/api\/content-writing'/);
  assert.match(registry, /path: '\/api\/content-writing\/external-result'/);
  assert.match(externalApi, /authenticateApiRequest\(req\)/);
  assert.match(externalApi, /requireArticleWriteAccess\(supabase, articleId, principal\.userId\)/);
  assert.match(externalApi, /CONTENT_WRITING_EXTERNAL_RESULT_MAX_BYTES/);
  assert.match(externalApi, /recordExternalContentWritingResult/);
});

test('content-writing review requires explicit approval and uses the central editor save path', async () => {
  const [panel, modal, editorContext] = await Promise.all([
    readWorkspaceFile('components/ContentWritingPanel.tsx'),
    readWorkspaceFile('components/ContentWritingReviewModal.tsx'),
    readWorkspaceFile('contexts/EditorContext.tsx'),
  ]);

  assert.match(panel, /recordContentWritingSessionApplication/);
  assert.match(panel, /applyGeneratedArticleContent/);
  assert.match(panel, /selectedDetail\?\.session\.id === selectedSessionId/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /onConfirm/);
  assert.match(modal, /prepareContentWritingResultForEditor/);
  assert.match(modal, /qualityReport\.score/);
  assert.match(modal, /qualityOverrideReason/);
  assert.match(editorContext, /const applyGeneratedArticleContent = useCallback/);
  assert.match(editorContext, /handleSaveDraft\(\{ reason: 'manual', force: true \}\)/);
  assert.match(editorContext, /parseMarkdownToArticleHtml/);
  assert.doesNotMatch(panel, /commands\.setContent/);
});

test('external content writing reuses server preparation, the shared bridge, and editor review', async () => {
  const [api, engine, client, bridgePanel, writingPanel, service] = await Promise.all([
    readWorkspaceFile('api/contentWriting.ts'),
    readWorkspaceFile('server/contentWritingEngine.ts'),
    readWorkspaceFile('utils/contentWritingSessions.ts'),
    readWorkspaceFile('components/ContentWritingExternalBridgePanel.tsx'),
    readWorkspaceFile('components/ContentWritingPanel.tsx'),
    readWorkspaceFile('server/contentWritingSessionService.ts'),
  ]);

  assert.match(api, /CONTENT_WRITING_EXTERNAL_RATE_LIMIT_PER_MINUTE/);
  assert.match(api, /messages: conversation\.messages\.map/);
  assert.match(api, /generation_request/);
  assert.match(engine, /const assertContentWritingBundleReady/);
  assert.match(engine, /prepareContentWritingConversation\(input\.articleId\)/);
  assert.match(client, /prepareExternalContentWritingConversation/);
  assert.match(client, /recordExternalContentWritingResult/);
  assert.match(client, /expectedStages/);
  assert.match(bridgePanel, /EXTERNAL_AI_BRIDGE_PROVIDERS\.map/);
  assert.match(bridgePanel, /openExternalAiBridge/);
  assert.match(bridgePanel, /copyExternalAiBridgePrompt/);
  assert.match(bridgePanel, /copiedSequence >= message\.sequenceNumber - 1/);
  assert.doesNotMatch(bridgePanel, /https:\/\/(?:chatgpt|gemini\.)/);
  assert.match(writingPanel, /<ContentWritingExternalBridgePanel/);
  assert.match(writingPanel, /setReviewSnapshot/);
  assert.match(writingPanel, /sessionId: recorded\.session\.id/);
  assert.match(engine, /conversation\.inputHash !== input\.preparedInputHash/);
  assert.match(service, /record_external_content_writing_result/);
  assert.doesNotMatch(bridgePanel, /applyGeneratedArticleContent/);
});

test('admin content-writing reports load lightweight daily rows without generated article bodies', async () => {
  const [loader, table, admin] = await Promise.all([
    readWorkspaceFile('utils/contentWritingReports.ts'),
    readWorkspaceFile('components/ContentWritingReportsTable.tsx'),
    readWorkspaceFile('components/AdminApp.tsx'),
  ]);

  assert.match(loader, /from\('content_writing_sessions'\)/);
  assert.match(loader, /\.gte\('created_at', options\.from\)/);
  assert.match(loader, /\.lte\('created_at', options\.to\)/);
  assert.match(loader, /execution_mode/);
  assert.doesNotMatch(loader, /result_text|context_snapshot/);
  assert.match(loader, /quality_score/);
  assert.match(loader, /quality_policy_version/);
  assert.match(loader, /quality_repair_count/);
  assert.match(loader, /cachedInputTokens/);
  assert.match(loader, /knowledgeCoveragePercent/);
  assert.match(table, /buildAdminArticlePath\(session\.articleId\)/);
  assert.match(table, /session\.applicationCount/);
  assert.match(table, /session\.qualityScore/);
  assert.match(admin, /<ContentWritingReportsTable/);
  assert.match(admin, /listContentWritingReportSessions/);
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
