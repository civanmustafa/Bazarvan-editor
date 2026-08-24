import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getGeminiKeyFailureCooldownSeconds,
  isGeminiModelKeyPermanentlyIncompatibleFailure,
} from '../server/geminiKeyCoordinator.ts';

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
  assert.match(engine, /claimGeminiApiKeyDetailed/);
  assert.match(engine, /getGeminiModelOrder/);
  assert.ok(
    engine.indexOf('for (let modelIndex = 0; modelIndex < modelOrder.length; modelIndex += 1)')
      < engine.indexOf('while (keyIndex < orderedKeys.length)'),
    'Gemini must exhaust the available keys on the strongest active model before moving to the next model.',
  );
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
  const [engine, openAiEngine] = await Promise.all([
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('server/openAiExecutionEngine.ts'),
  ]);

  assert.match(engine, /export const sanitizeAiExecutionResult/);
  assert.match(engine, /keyFingerprint: _fingerprint/);
  assert.match(engine, /keyFingerprint: _reportFingerprint/);
  assert.match(engine, /keyFingerprint: _attemptFingerprint/);
  assert.match(openAiEngine, /const sanitizeResult/);
  assert.match(openAiEngine, /keyFingerprint: _fingerprint/);
});

test('all paid provider engines use the shared automatic fallback policy', async () => {
  const [policy, secretService, geminiEngine, openAiEngine, settingsPage] = await Promise.all([
    readWorkspaceFile('server/aiProviderFallbackPolicy.ts'),
    readWorkspaceFile('server/adminAiProviderSecrets.ts'),
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('server/openAiExecutionEngine.ts'),
    readWorkspaceFile('components/SettingsPage.tsx'),
  ]);

  assert.match(policy, /openai: \['openai', 'geminiPaid', 'gemini'\]/);
  assert.match(policy, /geminiPaid: \['geminiPaid', 'gemini'\]/);
  assert.match(policy, /shouldAttemptAiFallback/);
  assert.match(secretService, /tiers\.flatMap/);
  assert.match(geminiEngine, /mergeCredentialFallbackResult/);
  assert.match(geminiEngine, /stage: 'switching-provider'/);
  assert.match(openAiEngine, /executeOpenAiProviderFallback/);
  assert.match(openAiEngine, /getAvailableAiProviderFallbacks/);
  assert.match(settingsPage, /الرجوع التلقائي للمفاتيح والمزودات مفعّل/);
});

test('quick free Gemini commands evaluate all eligible keys and models after a local timeout', async () => {
  const [engine, aiContext] = await Promise.all([
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('contexts/AIContext.tsx'),
  ]);

  assert.match(engine, /class GeminiRequestTimeoutError extends Error/);
  assert.match(engine, /error instanceof GeminiRequestTimeoutError/);
  assert.match(engine, /outcome: 'cancelled',\s+status: lastError\.status,\s+reason: 'cancelled',\s+cooldownSeconds: 0/);
  assert.match(engine, /const hasNextKey = failedModelAttemptedKeyCount < orderedKeys\.length/);
  assert.doesNotMatch(engine, /timedOutKeyFingerprints|modelTimedOutLocally/);
  assert.match(engine, /لم تُعتبر المفاتيح مستنفدة/);
  assert.match(engine, /allowModelFallback = requestBody\?\.allowModelFallback === true\s+&& settings\.allowModelFallback/);
  assert.match(aiContext, /requireFreeModelFallback \|\| isGeminiFreeModelFallbackEnabled\(\)/);
  assert.match(aiContext, /geminiProvider === 'gemini',\s+\);/);
});

test('Gemini coordination waits for temporary key states and publishes safe per-model reports', async () => {
  const [engine, coordinator, migration, auditPanel] = await Promise.all([
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('server/geminiKeyCoordinator.ts'),
    readWorkspaceFile('supabase/migrations/20260812010000_gemini_key_availability_waiting.sql'),
    readWorkspaceFile('components/ContentWritingStageAuditPanel.tsx'),
  ]);

  assert.match(engine, /stage: 'waiting-key'/);
  assert.match(engine, /GEMINI_KEY_AVAILABILITY_MAX_WAIT_MS/);
  assert.match(engine, /getGeminiKeyAvailabilityWaitMs/);
  assert.match(engine, /modelKeyReports/);
  assert.match(engine, /keyAvailabilityWaitedMs/);
  assert.match(coordinator, /claimGeminiApiKeyDetailed/);
  assert.match(coordinator, /inspect_gemini_api_key_availability/);
  assert.match(migration, /returns table \(/);
  assert.match(migration, /leased_count integer/);
  assert.match(migration, /cooldown_count integer/);
  assert.match(migration, /next_eligible_at timestamptz/);
  assert.match(migration, /grant execute on function public\.inspect_gemini_api_key_availability[^;]+to service_role/s);
  assert.doesNotMatch(migration, /returns table \([^)]*key_fingerprint/s);
  assert.match(auditPanel, /تقرير الموديلات والمفاتيح/);
  assert.match(auditPanel, /collectAiModelKeyReports/);
  assertBalancedSqlParentheses(migration);
});

test('Gemini remembers model/key 404 incompatibility while keeping 429 temporary', async () => {
  const [engine, coordinator] = await Promise.all([
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('server/geminiKeyCoordinator.ts'),
  ]);

  assert.equal(isGeminiModelKeyPermanentlyIncompatibleFailure('incompatible', 404), true);
  assert.equal(isGeminiModelKeyPermanentlyIncompatibleFailure('quota', 429), false);
  assert.equal(getGeminiKeyFailureCooldownSeconds('quota', 429), 30 * 60);
  assert.equal(getGeminiKeyFailureCooldownSeconds('incompatible', 404), 24 * 60 * 60);
  assert.match(engine, /details\.status === 404[\s\S]*return "incompatible"/);
  assert.match(coordinator, /\.from\('ai_gemini_key_model_state'\)[\s\S]*\.eq\('last_status', 404\)/);
  assert.match(coordinator, /localModelIncompatibilities/);
});
