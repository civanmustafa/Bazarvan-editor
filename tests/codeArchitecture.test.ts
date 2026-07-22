import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { readRequestBody, toWebResponse } from '../api/http.ts';

const workspaceUrl = (relativePath: string): URL => new URL(`../${relativePath}`, import.meta.url);
const readWorkspaceFile = (relativePath: string): Promise<string> => readFile(workspaceUrl(relativePath), 'utf8');

const assertFileMissing = async (relativePath: string): Promise<void> => {
  await assert.rejects(
    access(workspaceUrl(relativePath)),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    `${relativePath} should remain deleted`,
  );
};

test('development and production use one API route registry', async () => {
  const [registry, viteConfig, productionServer] = await Promise.all([
    readWorkspaceFile('server/apiRouteRegistry.ts'),
    readWorkspaceFile('vite.config.ts'),
    readWorkspaceFile('server/server.ts'),
  ]);
  const expectedPaths = [
    '/api/gemini/progress/:progressId/cancel',
    '/api/gemini/progress/:progressId',
    '/api/gemini',
    '/api/chatgpt',
    '/api/content-writing',
    '/api/ai/capabilities',
    '/api/competitors',
    '/api/n8n/articles',
    '/api/articles/save',
    '/api/external-analysis',
    '/api/articles/assigned-automation',
    '/api/system/settings',
    '/api/admin/users',
  ];

  expectedPaths.forEach(path => assert.ok(registry.includes(`path: '${path}'`), `Missing route ${path}`));
  assert.match(viteConfig, /findApiRoute\(url\.pathname/);
  assert.match(productionServer, /API_ROUTES\.forEach/);
  assert.doesNotMatch(viteConfig, /new Map<string, ApiHandler>/);
  assert.doesNotMatch(productionServer, /app\.all\('\/api\//);
});

test('API handlers share the same HTTP request and response adapters', async () => {
  const handlerFiles = [
    'api/adminUsers.ts',
    'api/aiCapabilities.ts',
    'api/articlesSave.ts',
    'api/assignedArticleAutomation.ts',
    'api/chatgpt.ts',
    'api/contentWriting.ts',
    'api/competitors.ts',
    'api/externalAnalysis.ts',
    'api/n8nArticles.ts',
    'api/systemSettings.ts',
  ];
  const handlers = await Promise.all(handlerFiles.map(readWorkspaceFile));

  handlers.forEach((source, index) => {
    assert.match(source, /from ['"]\.\/http\.ts['"]/, `${handlerFiles[index]} must import api/http`);
    assert.doesNotMatch(source, /const readNodeBody\s*=/);
    assert.doesNotMatch(source, /const toWebResponse\s*=/);
    assert.doesNotMatch(source, /const sendNodeResponse\s*=/);
  });
});

test('competitor intent, scoring, and automatic selection use one server engine', async () => {
  const [engine, apiHandler, firecrawlService, browserClient, discoveryPanel] = await Promise.all([
    readWorkspaceFile('server/competitorSelectionEngine.ts'),
    readWorkspaceFile('api/competitors.ts'),
    readWorkspaceFile('server/firecrawlCompetitorService.ts'),
    readWorkspaceFile('utils/competitorDiscovery.ts'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
  ]);

  assert.match(engine, /const INTENT_LEXICONS/);
  assert.match(engine, /const PAGE_TYPE_LEXICONS/);
  assert.match(engine, /export const analyzeAndSelectCompetitors/);
  assert.match(apiHandler, /analyzeAndSelectCompetitors\(/);
  [apiHandler, firecrawlService, browserClient, discoveryPanel].forEach(source => {
    assert.doesNotMatch(source, /const INTENT_LEXICONS|const PAGE_TYPE_LEXICONS/);
    assert.doesNotMatch(source, /selectionScore\s*=\s*\(/);
  });
});

test('shared HTTP adapters preserve Web and Node request semantics', async () => {
  const webRequest = new Request('https://editor.example.com/api/example', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'web' }),
  });
  const nodeRequest = {
    body: Buffer.from(JSON.stringify({ source: 'node' })),
  };

  assert.deepEqual(await readRequestBody(webRequest), { source: 'web' });
  assert.deepEqual(await readRequestBody(nodeRequest), { source: 'node' });

  const response = toWebResponse({
    status: 201,
    body: { ok: true },
    headers: { 'X-Test-Header': 'shared' },
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-test-header'), 'shared');
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(await toWebResponse({ status: 204 }).text(), '');
});

test('legacy browser API key and unreachable settings paths stay removed', async () => {
  const [userContext, aiContext, userActivity, adminApp] = await Promise.all([
    readWorkspaceFile('contexts/UserContext.tsx'),
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('hooks/useUserActivity.ts'),
    readWorkspaceFile('components/AdminApp.tsx'),
  ]);

  assert.doesNotMatch(userContext, /\bapiKeys\b|handleSaveApiKeys|saveUserApiKeys/);
  assert.doesNotMatch(aiContext, /\bapiKeys\b|normalizeGeminiKeys|normalizeChatGptKeys/);
  assert.doesNotMatch(userActivity, /geminiKeyUsage|recordGeminiKeyUsage/);
  assert.doesNotMatch(adminApp, /AdminSettingsPage|AdminSettingsSection/);

  await Promise.all([
    assertFileMissing('components/ApiKeysModal.tsx'),
    assertFileMissing('contexts/AppContext.tsx'),
    assertFileMissing('utils/api.ts'),
    assertFileMissing('utils/analysis/rules/checkTableListOpportunities.ts'),
  ]);
});

test('repository quality gate covers types, tests, build, and security checks', async () => {
  const [packageSource, tsconfigSource, workflow] = await Promise.all([
    readWorkspaceFile('package.json'),
    readWorkspaceFile('tsconfig.json'),
    readWorkspaceFile('.github/workflows/quality-gates.yml'),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    scripts?: Record<string, string>;
  };
  const tsconfig = JSON.parse(tsconfigSource) as {
    compilerOptions?: Record<string, unknown>;
  };
  const scripts = packageJson.scripts || {};
  const compilerOptions = tsconfig.compilerOptions || {};

  ['check:secrets', 'check:dependencies', 'typecheck', 'test', 'build', 'check:bundle']
    .forEach(scriptName => assert.match(scripts.verify || '', new RegExp(`npm run ${scriptName.replace(':', '\\:')}`)));
  assert.match(scripts['check:dependencies'] || '', /npm audit/);
  assert.match(scripts.postbuild || '', /check:content-writing-release/);
  assert.match(scripts['check:content-writing-release'] || '', /checkContentWritingRelease\.ts/);
  assert.equal(compilerOptions.noImplicitAny, true);
  assert.equal(compilerOptions.strictBindCallApply, true);
  assert.equal(compilerOptions.strictFunctionTypes, true);
  assert.equal(compilerOptions.noImplicitThis, true);
  assert.equal(compilerOptions.useUnknownInCatchVariables, true);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
});

test('admin reports distinguish failed key pools and automatic external analysis actors', async () => {
  const [adminApp, externalReports] = await Promise.all([
    readWorkspaceFile('components/AdminApp.tsx'),
    readWorkspaceFile('components/ExternalAnalysisReportsTable.tsx'),
  ]);

  assert.match(adminApp, /API_KEY_POOL_LABEL = 'مجموعة مفاتيح'/);
  assert.match(adminApp, /attemptedKeyCount > 1/);
  assert.match(adminApp, /EXTERNAL_ANALYSIS_API_SOURCES\.has\(request\.source\)/);
  assert.match(adminApp, /النظام التلقائي/);
  assert.match(externalReports, /getExternalAnalysisActorLabel/);
  assert.match(externalReports, /النظام التلقائي/);
});

test('AI provider availability is owned by one capability service across server and editor surfaces', async () => {
  const [
    capabilityRegistry,
    capabilityService,
    capabilityApi,
    openAiExecutionEngine,
    aiExecutionEngine,
    userContext,
    aiContext,
    toolbarActions,
    selectionToolbar,
    rightSidebar,
    settingsPage,
  ] = await Promise.all([
    readWorkspaceFile('constants/aiProviderCapabilities.ts'),
    readWorkspaceFile('server/aiProviderCapabilities.ts'),
    readWorkspaceFile('api/aiCapabilities.ts'),
    readWorkspaceFile('server/openAiExecutionEngine.ts'),
    readWorkspaceFile('server/aiExecutionEngine.ts'),
    readWorkspaceFile('contexts/UserContext.tsx'),
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('components/toolbar/AIActions.tsx'),
    readWorkspaceFile('components/SelectionToolbar.tsx'),
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('components/SettingsPage.tsx'),
  ]);

  assert.match(capabilityRegistry, /getRuntimeProviderForPatchProvider/);
  assert.match(capabilityRegistry, /available: enabled && configured/);
  assert.match(capabilityService, /\.eq\('key', 'ai'\)/);
  assert.match(capabilityService, /settings\.openAiEnabled === true/);
  assert.match(capabilityService, /settings\.geminiProEnabled !== false/);
  assert.match(capabilityApi, /authenticateApiRequest\(req\)/);
  assert.match(capabilityApi, /'Cache-Control': 'no-store'/);
  assert.match(openAiExecutionEngine, /readAiProviderCapabilities\(\)/);
  assert.match(openAiExecutionEngine, /AI_PROVIDER_DISABLED/);
  assert.match(openAiExecutionEngine, /AI_PROVIDER_NOT_CONFIGURED/);
  assert.match(aiExecutionEngine, /readAiProviderCapabilities\(\)/);
  assert.match(aiExecutionEngine, /AI_PROVIDER_DISABLED/);
  assert.match(aiExecutionEngine, /AI_PROVIDER_NOT_CONFIGURED/);
  assert.match(userContext, /AI_PROVIDER_CAPABILITIES_REFRESH_MS/);
  assert.match(userContext, /AI_PROVIDER_CAPABILITIES_CHANGED_EVENT/);
  assert.match(aiContext, /isAiProviderAvailable\('chatgpt'\)/);
  [toolbarActions, selectionToolbar, rightSidebar].forEach(source => {
    assert.match(source, /isAiProviderEnabled\('chatgpt'\)/);
    assert.match(source, /isAiProviderAvailable\('chatgpt'\)/);
    assert.match(source, /isAiProviderEnabled\('geminiPaid'\)/);
    assert.match(source, /isAiProviderAvailable\('geminiPaid'\)/);
  });
  assert.match(aiContext, /isAiProviderAvailable\(provider\)/);
  assert.match(settingsPage, /السماح للمستخدمين باستخدام Gemini Pro/);
  assert.match(settingsPage, /notifyAiProviderCapabilitiesChanged\(\)/);
});

test('content writing has one template registry and one context builder', async () => {
  const [registry, builder, settingsRegistry, settingsPage] = await Promise.all([
    readWorkspaceFile('constants/contentWriting.ts'),
    readWorkspaceFile('utils/contentWritingContext.ts'),
    readWorkspaceFile('constants/settingsRegistry.ts'),
    readWorkspaceFile('components/SettingsPage.tsx'),
  ]);

  assert.match(registry, /DEFAULT_CONTENT_WRITING_TEMPLATES/);
  assert.match(registry, /CONTENT_WRITING_TEMPLATE_FIELDS/);
  assert.match(builder, /buildContentWritingPromptBundle/);
  assert.match(builder, /CONTENT_WRITING_REQUIRED_COMPETITOR_COUNT = 3/);
  assert.doesNotMatch(builder, /content\.slice\(/);
  assert.match(settingsRegistry, /CONTENT_WRITING_TEMPLATE_FIELDS/);
  assert.match(settingsPage, /ContentWritingPromptSettings/);
});

test('content writing editor UI runs through durable authenticated sessions', async () => {
  const [panel, client, rightSidebar] = await Promise.all([
    readWorkspaceFile('components/ContentWritingPanel.tsx'),
    readWorkspaceFile('utils/contentWritingSessions.ts'),
    readWorkspaceFile('components/RightSidebar.tsx'),
  ]);

  assert.match(rightSidebar, /lazy\(\(\) => import\('\.\/ContentWritingPanel'\)\)/);
  assert.match(rightSidebar, /'writing'/);
  assert.match(panel, /isAiProviderEnabled\('gemini'\)/);
  assert.match(panel, /isAiProviderAvailable\('gemini'\)/);
  assert.match(panel, /isAiProviderEnabled\('geminiPaid'\)/);
  assert.match(panel, /isAiProviderAvailable\('geminiPaid'\)/);
  assert.match(panel, /isAiProviderEnabled\('chatgpt'\)/);
  assert.match(panel, /isAiProviderAvailable\('chatgpt'\)/);
  assert.match(panel, /await handleSaveDraft\(\)/);
  assert.match(panel, /startInFlightRef\.current/);
  assert.match(panel, /pendingStartRef\.current/);
  assert.match(panel, /createContentWritingIdempotencyKey\(articleId\)/);
  assert.match(panel, /setProvider\(aiProviderCapabilities\.defaultProvider\)/);
  assert.match(panel, /startContentWritingSession\(/);
  assert.match(panel, /listContentWritingSessions\(/);
  assert.match(panel, /getContentWritingSessionDetail\(/);
  assert.match(panel, /cancelContentWritingSession\(/);
  assert.match(panel, /resumeContentWritingSession\(/);
  assert.match(panel, /workflowSteps\.map/);
  assert.match(panel, /selectedDetail\?\.session\.id === selectedSessionId/);
  assert.match(panel, /activeDetail\.session\.resultText/);
  assert.match(panel, /recordContentWritingSessionApplication/);
  assert.doesNotMatch(panel, /getSupabaseClient|localStorage|sessionStorage/);
  assert.match(client, /getAuthenticatedApiToken\(\)/);
  assert.match(client, /getAuthenticatedApiHeaders\(/);
  assert.match(client, /includeMessages: options\.includeMessages === true/);
  assert.match(client, /includeSteps: options\.includeSteps !== false/);
  assert.match(client, /action: 'start'/);
  assert.match(client, /action: 'get'/);
  assert.match(client, /action: 'list'/);
  assert.match(client, /action: 'cancel'/);
  assert.match(client, /action: 'resume'/);
  assert.match(client, /action: 'recordApplication'/);
});
