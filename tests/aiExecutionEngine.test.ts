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
  assert.equal(quote, null);
  assert.equal(depth, 0);
};

test('one server engine owns Gemini execution, key rotation, and model fallback', async () => {
  const [engine, apiRoute, automation, externalRunner, aiContext, rightSidebar] = await Promise.all([
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('api/gemini.ts'),
    readWorkspaceFile('api/assignedArticleAutomation.ts'),
    readWorkspaceFile('server/externalGeminiRunner.ts'),
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('components/RightSidebar.tsx'),
  ]);

  assert.match(engine, /new GoogleGenAI/);
  assert.match(engine, /claimGeminiApiKey/);
  assert.match(engine, /getGeminiModelOrder/);
  assert.match(engine, /recordAiExecutionTelemetry/);
  assert.match(apiRoute, /server\/aiExecutionEngine/);
  assert.doesNotMatch(apiRoute, /new GoogleGenAI|claimGeminiApiKey/);
  assert.match(automation, /aiExecutionEngine\.executeGemini/);
  assert.match(externalRunner, /aiExecutionEngine\.executeGemini/);
  [automation, externalRunner, aiContext, rightSidebar].forEach(source => {
    assert.doesNotMatch(source, /new GoogleGenAI|claimGeminiApiKey/);
  });
});

test('AI telemetry is server-authenticated and browser code cannot forge key reports', async () => {
  const [migration, telemetry, aiContext, rightSidebar, userContext] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260713030000_phase_5_ai_execution_engine.sql'),
    readWorkspaceFile('server/aiExecutionTelemetry.ts'),
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('contexts/UserContext.tsx'),
  ]);

  assert.match(migration, /create table if not exists public\.ai_execution_events/);
  assert.match(migration, /using \(public\.is_admin\(\)\)/);
  assert.match(migration, /revoke insert, update, delete on public\.ai_execution_events from authenticated/);
  assert.match(telemetry, /from\('ai_execution_events'\)\.insert/);
  assert.doesNotMatch(telemetry, /key_fingerprint|apiKey/);
  [aiContext, rightSidebar, userContext].forEach(source => {
    assert.doesNotMatch(source, /api-key-used|gemini-key-used/);
  });
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
  assertBalancedSqlParentheses(migration);
});

test('public AI responses remove key fingerprints while preserving safe attempt details', async () => {
  const [engine, openAiApi] = await Promise.all([
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('api/chatgpt.ts'),
  ]);

  assert.match(engine, /export const sanitizeAiExecutionResult/);
  assert.match(engine, /keyFingerprint: _fingerprint/);
  assert.match(openAiApi, /const finalizeResult/);
  assert.match(openAiApi, /keyFingerprint: _fingerprint/);
});
