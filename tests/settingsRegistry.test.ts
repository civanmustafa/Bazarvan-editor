import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  GEMINI_ANALYSIS_MODEL,
  GEMINI_FREE_MODEL_VALUES,
  GEMINI_PAID_ANALYSIS_MODEL,
  GEMINI_PAID_MODEL_VALUES,
  MODEL_REGISTRY,
  normalizeGeminiFreeModelId,
  normalizeGeminiPaidModelId,
} from '../constants/modelRegistry.ts';
import {
  ARTICLE_STATUS_VALUES,
  DASHBOARD_ARTICLE_STATUS_TABS,
  DASHBOARD_PREFETCH_ARTICLE_STATUSES,
  isExternalAnalysisArticleStatus,
  normalizeArticleStatus,
} from '../constants/articleStatuses.ts';

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

const importSettingsRegistry = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../constants/settingsRegistry.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

const importAiProviderCapabilities = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../constants/aiProviderCapabilities.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

test('ModelRegistry owns a unique strongest-to-lightest Gemini order', () => {
  assert.equal(GEMINI_ANALYSIS_MODEL, MODEL_REGISTRY.gemini.free[0].id);
  assert.deepEqual(
    GEMINI_FREE_MODEL_VALUES,
    MODEL_REGISTRY.gemini.free.map((model: { id: string }) => model.id),
  );
  assert.equal(new Set(GEMINI_FREE_MODEL_VALUES).size, GEMINI_FREE_MODEL_VALUES.length);
  assert.equal(normalizeGeminiFreeModelId('not-a-model'), GEMINI_ANALYSIS_MODEL);
  assert.deepEqual(
    new Set(GEMINI_PAID_MODEL_VALUES),
    new Set(MODEL_REGISTRY.gemini.paid.map(model => model.id)),
  );
  assert.equal(GEMINI_PAID_ANALYSIS_MODEL, 'gemini-3.1-pro-preview');
  assert.equal(
    GEMINI_PAID_MODEL_VALUES.some(model => new Set<string>(GEMINI_FREE_MODEL_VALUES).has(model)),
    false,
  );
  assert.equal(normalizeGeminiPaidModelId('not-a-model'), GEMINI_PAID_ANALYSIS_MODEL);
});

test('SettingsRegistry validates system settings and discards unknown fields', async () => {
  const registry = await importSettingsRegistry();
  const normalized = registry.normalizeSystemSettingsMap({
    ai: {
      defaultGeminiModel: 'unknown-model',
      defaultGeminiPaidModel: 'unknown-paid-model',
      externalAnalysisRetryMinutes: 1,
      contentWritingInstructionsTemplate: 'تعليمات مخصصة',
      contentWritingMaxInputTokens: 1,
      contentWritingQualityPolicyVersion: 999,
      contentWritingMinimumQualityScore: 1,
      contentWritingMaxRepairPasses: 99,
      unknownSecret: 'must-not-survive',
    },
    articles: {
      trashRetentionDays: 99_999,
      defaultLanguage: 'invalid',
      defaultStatus: 'content_preparation',
    },
  });

  assert.equal(normalized.ai.defaultGeminiModel, GEMINI_ANALYSIS_MODEL);
  assert.equal(normalized.ai.defaultGeminiPaidModel, GEMINI_PAID_ANALYSIS_MODEL);
  assert.equal(normalized.ai.externalAnalysisRetryMinutes, 5);
  assert.equal(normalized.ai.contentWritingInstructionsTemplate, 'تعليمات مخصصة');
  assert.equal(normalized.ai.contentWritingMaxInputTokens, 10_000);
  assert.equal(normalized.ai.contentWritingQualityPolicyVersion, 1);
  assert.equal(normalized.ai.contentWritingMinimumQualityScore, 50);
  assert.equal(normalized.ai.contentWritingMaxRepairPasses, 3);
  assert.equal(normalized.ai.unknownSecret, undefined);
  assert.equal(normalized.articles.trashRetentionDays, 3_650);
  assert.equal(normalized.articles.defaultLanguage, 'ar');
  assert.equal(normalized.articles.defaultStatus, 'content_preparation');
});

test('ArticleStatusRegistry owns workflow states, dashboard priority, and analysis eligibility', () => {
  assert.deepEqual(ARTICLE_STATUS_VALUES, [
    'content_preparation',
    'draft',
    'in_review',
    'published',
    'archived',
  ]);
  assert.deepEqual(DASHBOARD_ARTICLE_STATUS_TABS.slice(0, 4), [
    'all',
    'in_review',
    'content_preparation',
    'draft',
  ]);
  assert.deepEqual(DASHBOARD_PREFETCH_ARTICLE_STATUSES, [
    'in_review',
    'content_preparation',
    'draft',
  ]);
  assert.equal(normalizeArticleStatus('تجهيز محتوى'), 'content_preparation');
  assert.equal(normalizeArticleStatus('ready'), 'in_review');
  assert.equal(isExternalAnalysisArticleStatus('content_preparation'), true);
  assert.equal(isExternalAnalysisArticleStatus('draft'), true);
  assert.equal(isExternalAnalysisArticleStatus('in_review'), false);
});

test('AiProviderCapabilities centrally gates OpenAI and resolves a safe default provider', async () => {
  const {
    getDefaultAiPatchProvider,
    isAiPatchProviderAvailable,
    isAiPatchProviderEnabled,
    normalizeAiProviderCapabilities,
  } = await importAiProviderCapabilities();
  const disabled = normalizeAiProviderCapabilities({
    providers: {
      openai: { enabled: false, configured: true, model: 'gpt-enabled-but-blocked' },
    },
    defaultProvider: 'openai',
  });
  assert.equal(isAiPatchProviderEnabled(disabled, 'chatgpt'), false);
  assert.equal(isAiPatchProviderAvailable(disabled, 'chatgpt'), false);
  assert.equal(getDefaultAiPatchProvider(disabled), 'gemini');

  const enabled = normalizeAiProviderCapabilities({
    providers: {
      openai: { enabled: true, configured: true, model: 'gpt-admin-default' },
    },
    defaultProvider: 'openai',
  });
  assert.equal(isAiPatchProviderEnabled(enabled, 'chatgpt'), true);
  assert.equal(isAiPatchProviderAvailable(enabled, 'chatgpt'), true);
  assert.equal(getDefaultAiPatchProvider(enabled), 'chatgpt');
  assert.equal(enabled.providers.openai.model, 'gpt-admin-default');

  const missingKey = normalizeAiProviderCapabilities({
    providers: {
      openai: { enabled: true, configured: false, model: 'gpt-no-key' },
    },
    defaultProvider: 'openai',
  });
  assert.equal(isAiPatchProviderEnabled(missingKey, 'chatgpt'), true);
  assert.equal(isAiPatchProviderAvailable(missingKey, 'chatgpt'), false);
  assert.equal(getDefaultAiPatchProvider(missingKey), 'gemini');
});

test('legacy browser preferences migrate without replacing existing online values', async () => {
  const registry = await importSettingsRegistry();
  const legacy = registry.createLegacyUserPreferences({
    preferredTheme: 'light',
    preferredHighlightStyle: 'underline',
    preferredLanguage: 'en',
    clientGoalContexts: { Acme: { objective: 'legacy objective' } },
    engineeringPrompts: { analyzeFull: 'legacy prompt' },
  }, {
    model: 'gemini-2.5-flash',
    allowModelFallback: false,
  });
  const migrated = registry.migrateLegacyUserPreferences({
    appearance: { theme: 'dark' },
    ai: { defaultGeminiModel: 'gemini-2.5-pro' },
  }, legacy);

  assert.equal(migrated.appearance.theme, 'dark');
  assert.equal(migrated.appearance.highlightStyle, 'underline');
  assert.equal(migrated.editor.preferredLanguage, 'en');
  assert.equal(migrated.ai.defaultGeminiModel, 'gemini-2.5-pro');
  assert.equal(migrated.ai.allowGeminiModelFallback, false);
  assert.equal(migrated.clientGoalContexts.Acme.objective, 'legacy objective');
  assert.equal(migrated.engineeringPrompts.analyzeFull, 'legacy prompt');
});

test('browser, API, and worker consume the shared registries', async () => {
  const [geminiApi, aiEngine, settingsApi, assignedAutomation, externalSettings, settingsPage] = await Promise.all([
    readWorkspaceFile('api/gemini.ts'),
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('api/systemSettings.ts'),
    readWorkspaceFile('api/assignedArticleAutomation.ts'),
    readWorkspaceFile('server/externalAnalysisSettings.ts'),
    readWorkspaceFile('components/SettingsPage.tsx'),
  ]);

  assert.match(geminiApi, /server\/aiExecutionEngine/);
  assert.match(aiEngine, /constants\/modelRegistry/);
  assert.match(settingsApi, /constants\/settingsRegistry/);
  assert.match(assignedAutomation, /constants\/modelRegistry/);
  assert.match(externalSettings, /constants\/settingsRegistry/);
  assert.match(settingsPage, /constants\/settingsRegistry/);
  assert.match(settingsPage, /options=\{GEMINI_PAID_MODEL_OPTIONS\}/);
  assert.doesNotMatch(
    settingsPage,
    /label="موديل Gemini Pro الافتراضي">\s*<TextInput/,
  );
  [geminiApi, aiEngine, settingsApi, assignedAutomation, externalSettings, settingsPage].forEach(source => {
    assert.doesNotMatch(source, /\['gemini-3\.5-flash'/);
  });
});

test('user settings do not duplicate centralized Gemini controls', async () => {
  const settingsPage = await readWorkspaceFile('components/SettingsPage.tsx');
  const personalPreferences = settingsPage.slice(
    settingsPage.indexOf('const renderPersonalPreferences'),
    settingsPage.indexOf('const renderAiSettings'),
  );

  assert.doesNotMatch(personalPreferences, /موديل Gemini الافتراضي/);
  assert.doesNotMatch(personalPreferences, /التبديل بين نماذج جيميني المجانية/);
  assert.match(settingsPage, /موديل Gemini الافتراضي للتحليل الخارجي/);
  assert.match(settingsPage, /التبديل بين نماذج جيميني المجانية للعامل الخارجي/);
});

test('phase 4 migration creates protected durable user preferences', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260713020000_phase_4_settings_and_model_registry.sql',
  );
  assert.match(migration, /create table if not exists public\.user_preferences/);
  assert.match(migration, /alter table public\.user_preferences enable row level security/);
  assert.match(migration, /using \(user_id = auth\.uid\(\)\)/);
  assert.match(migration, /function public\.merge_current_user_preferences\(p_patch jsonb\)/);
  assert.match(migration, /coalesce\(public\.user_preferences\.preferences, '\{\}'::jsonb\)\s*\|\| excluded\.preferences/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
  assertBalancedSqlParentheses(migration);
});

test('content preparation migration expands status and external-analysis eligibility safely', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260721000000_content_preparation_status.sql',
  );

  assert.match(migration, /articles_status_check/);
  assert.match(migration, /'content_preparation', 'draft', 'in_review', 'published', 'archived'/);
  assert.match(migration, /article_status_supports_external_analysis/);
  assert.match(migration, /in \('content_preparation', 'draft'\)/);
  assert.match(migration, /create or replace function public\.evaluate_external_analysis_readiness/);
  assert.match(migration, /create or replace function public\.evaluate_competitor_discovery_readiness/);
  assert.match(migration, /public\.can_write_article\(target_article_id\)/);
  assertBalancedSqlParentheses(migration);
});

test('administrator AI secret migration keeps encrypted values server-only', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260722050000_admin_ai_provider_secrets.sql',
  );

  assert.match(migration, /create table if not exists public\.ai_provider_secrets/);
  assert.match(migration, /provider in \('openai_latest', 'gemini_latest'\)/);
  assert.match(migration, /revoke all on table public\.ai_provider_secrets from anon/);
  assert.match(migration, /revoke all on table public\.ai_provider_secrets from authenticated/);
  assert.match(migration, /to service_role/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
  assertBalancedSqlParentheses(migration);
});
