import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { readRequestBody, toWebResponse } from '../api/http.ts';
import { parseAppRoute } from '../utils/appRoutes.ts';

const workspaceUrl = (relativePath: string): URL => new URL(`../${relativePath}`, import.meta.url);
const readWorkspaceFile = (relativePath: string): Promise<string> => readFile(workspaceUrl(relativePath), 'utf8');

const assertFileMissing = async (relativePath: string): Promise<void> => {
  await assert.rejects(
    access(workspaceUrl(relativePath)),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    `${relativePath} should remain deleted`,
  );
};

test('settings route registry accepts every standalone settings tab', () => {
  assert.deepEqual(parseAppRoute('/settings/prompts'), {
    name: 'settings',
    section: 'prompts',
  });
  assert.deepEqual(parseAppRoute('/settings/crawler'), {
    name: 'settings',
    section: 'crawler',
  });
  assert.equal(parseAppRoute('/settings/not-registered').name, 'notFound');
});

test('the searchable user guide is globally routed and reachable from the app shell', async () => {
  const [app, guide, registry, search] = await Promise.all([
    readWorkspaceFile('App.tsx'),
    readWorkspaceFile('components/UserGuidePage.tsx'),
    readWorkspaceFile('constants/userGuide.ts'),
    readWorkspaceFile('utils/userGuideSearch.ts'),
  ]);
  assert.deepEqual(parseAppRoute('/guide'), { name: 'guide' });
  assert.match(app, /دليل الاستخدام/);
  assert.match(app, /navigateToAppPath\('\/guide'\)/);
  assert.match(guide, /searchUserGuide/);
  assert.match(guide, /USER_GUIDE_CATEGORIES/);
  assert.match(registry, /knowledge-and-candidate-modes/);
  assert.match(registry, /الكتابة العميقة الاستقصائية/);
  assert.match(registry, /الكتابة المركّزة الشاملة/);
  assert.match(search, /normalizeUserGuideSearchText/);
});

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
    '/api/ai/prompt-registry',
    '/api/competitors',
    '/api/n8n/articles',
    '/api/articles/save',
    '/api/external-analysis',
    '/api/articles/assigned-automation',
    '/api/system/settings',
    '/api/admin/crawler-provider-usage',
    '/api/user/ai-provider-secrets',
    '/api/admin/ai-provider-secrets',
    '/api/admin/users',
  ];

  expectedPaths.forEach(path => assert.ok(registry.includes(`path: '${path}'`), `Missing route ${path}`));
  assert.match(viteConfig, /findApiRoute\(url\.pathname/);
  assert.match(productionServer, /API_ROUTES\.forEach/);
  assert.doesNotMatch(viteConfig, /new Map<string, ApiHandler>/);
  assert.doesNotMatch(productionServer, /app\.all\('\/api\//);
});

test('all editor AI execution paths publish to one inline live activity monitor', async () => {
  const [
    editorApp,
    dashboard,
    monitor,
    activityEngine,
    geminiEngine,
    aiContext,
    userContext,
    writingPanel,
    writingMonitor,
    externalControls,
    externalAnalysisUtils,
    automaticQueue,
    leftSidebar,
    rightSidebar,
    selectionToolbar,
    toolbarAiActions,
    structureTab,
    internalLinkingPanel,
  ] = await Promise.all([
    readWorkspaceFile('components/EditorApp.tsx'),
    readWorkspaceFile('components/Dashboard.tsx'),
    readWorkspaceFile('components/AiKeyUsageToast.tsx'),
    readWorkspaceFile('utils/aiExecutionActivity.ts'),
    readWorkspaceFile('utils/geminiAnalysisEngine.ts'),
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('contexts/UserContext.tsx'),
    readWorkspaceFile('components/ContentWritingPanel.tsx'),
    readWorkspaceFile('utils/contentWritingActivityMonitor.ts'),
    readWorkspaceFile('components/ExternalAnalysisCardControls.tsx'),
    readWorkspaceFile('utils/externalAnalysis.ts'),
    readWorkspaceFile('components/AutomaticContentWritingQueuePanel.tsx'),
    readWorkspaceFile('components/LeftSidebar.tsx'),
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('components/SelectionToolbar.tsx'),
    readWorkspaceFile('components/toolbar/AIActions.tsx'),
    readWorkspaceFile('components/StructureTab.tsx'),
    readWorkspaceFile('components/InternalLinkingPanel.tsx'),
  ]);

  assert.match(
    editorApp,
    /<TipsCarousel\s*\/>\s*<AiExecutionMonitor\s+articleId=\{activeArticleId\}\s+articleKey=\{articleKey\}\s*\/>\s*<EditorToolbar\s+isFocusMode=\{isFocusMode\}\s+onToggleFocusMode=\{toggleFocusMode\}\s*\/>/,
  );
  assert.match(editorApp, /import AiExecutionMonitor from '\.\/AiKeyUsageToast'/);
  assert.match(monitor, /getAiExecutionActivitiesForArticle\(activities, articleId, articleKey\)/);
  assert.match(dashboard, /<DashboardAiExecutionMonitor\s*\/>/);
  assert.match(
    dashboard,
    /<AutomaticContentWritingQueuePanel[\s\S]*?<DashboardAiExecutionMonitor\s*\/>/,
  );
  assert.match(monitor, /data-ai-execution-monitor="dashboard"/);
  assert.match(monitor, /rounded-xl border border-blue-200 bg-white p-4/);
  assert.match(monitor, /ستظهر هنا أي مهمة جارية فور تشغيلها/);
  assert.match(monitor, /runningActivities\.map\(activity =>/);
  assert.match(monitor, /MAX_TERMINAL_FEED_ACTIVITIES/);
  assert.match(
    monitor,
    /getRunningAiExecutionActivities\(getAiExecutionActivities\(\)\)\.filter/,
  );
  assert.doesNotMatch(monitor, /\.slice\(0, 24\)/);
  assert.match(monitor, /data-ai-execution-article-id=\{activity\.articleId \|\| undefined\}/);
  assert.match(monitor, /data-ai-execution-monitor="inline"/);
  assert.doesNotMatch(monitor, /fixed bottom-4 left-4/);
  assert.match(monitor, /AI_EXECUTION_ACTIVITY_EVENT/);
  assert.match(monitor, /articleLabel/);
  assert.match(monitor, /selected\.articleTitle/);
  assert.match(monitor, /المهمة/);
  assert.match(monitor, /حالة الموديلات/);
  assert.match(monitor, /حالة المفاتيح المباشرة/);
  assert.match(monitor, /aria-expanded=\{expanded\}/);
  assert.match(monitor, /summarizeAiExecutionModelAttempts/);
  assert.doesNotMatch(monitor, /المزوّد/);
  assert.doesNotMatch(monitor, /جار تنفيذ الأمر الهندسي/);
  assert.doesNotMatch(monitor, /selected\.totalAttemptCount/);
  assert.match(monitor, /'إيقاف'/);
  assert.match(monitor, /requestAiExecutionActivityCancel/);
  assert.match(monitor, /formatLastUpdateAge/);
  assert.match(monitor, /loadExternalAnalysisJobsByIds/);
  assert.match(monitor, /projectExternalAnalysisActivity/);
  assert.match(activityEngine, /export const beginAiExecutionActivity/);
  assert.match(activityEngine, /export const updateAiExecutionActivity/);
  assert.match(activityEngine, /export const finishAiExecutionActivity/);
  assert.match(activityEngine, /export const removeAiExecutionActivity/);
  assert.match(activityEngine, /export const clearAiExecutionActivities/);
  assert.match(activityEngine, /retiredActivityStore/);
  assert.match(activityEngine, /export const requestAiExecutionActivityCancel/);
  assert.match(geminiEngine, /beginAiExecutionActivity/);
  assert.match(geminiEngine, /updateAiExecutionActivity/);
  assert.match(geminiEngine, /finishAiExecutionActivity/);
  assert.match(geminiEngine, /cancel:\s*\(\) => cancelGeminiAnalysisEngine\(progressId\)/);
  assert.match(aiContext, /openai:\$\{requestId\}/);
  assert.match(aiContext, /beginAiExecutionActivity/);
  assert.match(aiContext, /manualCancellationRequested = true/);
  assert.match(userContext, /clearAiExecutionActivities\(\)/);
  assert.match(writingPanel, /content-writing:/);
  assert.match(writingPanel, /monitorContentWritingSessionActivity/);
  assert.match(writingMonitor, /syncContentWritingSessionActivity/);
  assert.match(writingMonitor, /getContentWritingSessionDetail/);
  assert.match(writingMonitor, /cancelContentWritingSession\(session\.id\)/);
  assert.match(externalControls, /external-analysis:/);
  assert.match(externalControls, /updateAiExecutionActivity/);
  assert.match(externalControls, /activeEngineeringRootJob/);
  assert.match(externalControls, /syncJob\(\s*'competitor-discovery'/);
  assert.match(externalControls, /syncJob\(\s*'competitor-extraction'/);
  assert.match(externalControls, /getAiExecutionActivities/);
  assert.match(externalControls, /`external-analysis:\$\{job\.id\}`/);
  assert.match(
    externalAnalysisUtils,
    /loadExternalAnalysisJobsByIds[\s\S]*?\.select\(SUMMARY_JOB_SELECT\)/,
  );
  assert.match(externalControls, /data-analysis-control-group="semantic"/);
  assert.match(externalControls, /data-analysis-control-group="engineering"/);
  assert.match(externalControls, /data-analysis-control-group="competitor"/);
  assert.match(externalControls, /cancelExternalAnalysisJob\(articleId, job\.id\)/);
  assert.match(dashboard, /runAssignedArticleAutomationWithActivity/);
  assert.match(dashboard, /beginAiExecutionActivity/);
  assert.match(dashboard, /finishAiExecutionActivity/);
  assert.match(dashboard, /surface: 'assigned_article_automation'/);
  assert.match(automaticQueue, /automatic-writing:/);
  assert.match(automaticQueue, /surface: 'automatic_content_writing'/);
  assert.match(automaticQueue, /beginAiExecutionActivity/);
  assert.match(automaticQueue, /finishAiExecutionActivity/);
  assert.match(automaticQueue, /getAiExecutionActivities/);
  assert.match(automaticQueue, /removeAiExecutionActivity/);
  assert.match(automaticQueue, /refreshRequestRef/);
  assert.match(automaticQueue, /refreshRequestRef\.current !== requestId/);
  assert.doesNotMatch(automaticQueue, /trackedAiActivityRef/);
  assert.doesNotMatch(leftSidebar, /GeminiProgressStatus/);
  assert.doesNotMatch(leftSidebar, /aiRequestProgress\?\.source === 'semantic_keywords_lsi'/);
  await assertFileMissing('components/GeminiProgressStatus.tsx');
  for (const editorSurface of [
    rightSidebar,
    selectionToolbar,
    toolbarAiActions,
    structureTab,
    internalLinkingPanel,
  ]) {
    assert.doesNotMatch(editorSurface, /GeminiProgressStatus/);
  }
  assert.doesNotMatch(rightSidebar, /جاري التفكير|جاري الاتصال بـ ChatGPT/);
  assert.match(monitor, /internal_link_review/);
  assert.match(monitor, /timeout: \['انتهت مهلة الموديل', 'Model timed out'\]/);
});

test('dashboard article headers distinguish statuses and share one external-analysis identity', async () => {
  const [dashboard, externalControls] = await Promise.all([
    readWorkspaceFile('components/Dashboard.tsx'),
    readWorkspaceFile('components/ExternalAnalysisCardControls.tsx'),
  ]);

  assert.match(
    dashboard,
    /const ARTICLE_STATUS_TONES[\s\S]*?draft:[\s\S]*?amber[\s\S]*?in_review:[\s\S]*?emerald[\s\S]*?published:[\s\S]*?sky[\s\S]*?archived:[\s\S]*?slate/,
  );
  assert.match(dashboard, /data-article-status=\{status\}/);
  assert.match(dashboard, /const articleStatus = normalizeArticleStatus\(remoteActivity\.status \|\| n8nSettings\.status\)/);
  assert.match(dashboard, /<ArticleStatusControl[\s\S]*?value=\{articleStatus\}/);
  assert.match(dashboard, /articleStatus=\{articleStatus\}/);

  assert.equal(
    (externalControls.match(/className=\{ANALYSIS_CONTROL_GROUP_CLASS\}/g) || []).length,
    3,
  );
  assert.equal(
    (externalControls.match(/className=\{ANALYSIS_ACTION_BUTTON_CLASS\}/g) || []).length,
    3,
  );
  assert.match(
    externalControls,
    /const requirementsEnabled = articleStatus === 'draft'/,
  );
  assert.match(externalControls, /const readinessState = requirementsEnabled \? summary\?\.state \|\| null : null/);
  assert.match(externalControls, /const semanticRequirements:[\s\S]*?requirementsEnabled[\s\S]*?: \[\]/);
  assert.match(externalControls, /const engineeringRequirements:[\s\S]*?requirementsEnabled[\s\S]*?: \[\]/);
  assert.match(externalControls, /const competitorRequirements:[\s\S]*?requirementsEnabled[\s\S]*?: \[\]/);
  assert.match(externalControls, /\{requirementsEnabled && requirementsOpen && \(/);
});

test('API handlers share the same HTTP request and response adapters', async () => {
  const handlerFiles = [
    'api/adminUsers.ts',
    'api/adminAiProviderSecrets.ts',
    'api/userAiProviderSecrets.ts',
    'api/aiCapabilities.ts',
    'api/promptRegistry.ts',
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

  const geminiEngine = await readWorkspaceFile('server/aiExecutionEngine.ts');
  assert.match(geminiEngine, /from ['"]\.\.\/api\/http\.ts['"]/);
  assert.match(geminiEngine, /deliverApiResult\(result, res\)/);
  assert.doesNotMatch(geminiEngine, /const readNodeBody\s*=/);
  assert.doesNotMatch(geminiEngine, /const readRequestBody\s*=/);
  assert.doesNotMatch(geminiEngine, /const toWebResponse\s*=/);
  assert.doesNotMatch(geminiEngine, /const sendNodeResponse\s*=/);
});

test('semantic indexing and internal links share one normalization module', async () => {
  const [semanticIndex, linkingEngine, sharedText] = await Promise.all([
    readWorkspaceFile('utils/clientSemanticIndex.ts'),
    readWorkspaceFile('utils/internalLinkingEngine.ts'),
    readWorkspaceFile('utils/arabicEnglishText.ts'),
  ]);

  assert.match(semanticIndex, /from ['"]\.\/arabicEnglishText\.ts['"]/);
  assert.match(linkingEngine, /from ['"]\.\/arabicEnglishText\.ts['"]/);
  assert.match(sharedText, /export const normalizeArabicEnglishText/);
  assert.match(sharedText, /CORE_ARABIC_ENGLISH_STOP_WORDS/);
  assert.doesNotMatch(semanticIndex, /const ARABIC_DIACRITICS/);
  assert.doesNotMatch(linkingEngine, /const ARABIC_DIACRITICS/);
});

test('administrator prompts use one renderer for legacy and current placeholders', async () => {
  const [engineeringPrompts, promptRegistry, internalLinkReview, renderer] = await Promise.all([
    readWorkspaceFile('constants/engineeringPrompts.ts'),
    readWorkspaceFile('constants/promptRegistry.ts'),
    readWorkspaceFile('utils/internalLinkAiReview.ts'),
    readWorkspaceFile('constants/promptTemplateRenderer.ts'),
  ]);

  assert.match(engineeringPrompts, /renderPromptTemplateVariables\(template, variables\)/);
  assert.match(promptRegistry, /renderPromptTemplateVariables\(template, variables\)/);
  assert.match(internalLinkReview, /renderPromptTemplateVariables\(template, variables\)/);
  assert.doesNotMatch(internalLinkReview, /replaceAll\(`\{\{/);
  assert.match(renderer, /`\{\{\$\{key\}\}\}`/);
  assert.match(renderer, /`\\\$\{\$\{key\}\}`/);
  assert.equal((renderer.match(/export const renderPromptTemplateVariables/g) || []).length, 1);
});

test('competitor intent, scoring, and automatic selection use one server engine', async () => {
  const [engine, discoveryService, apiHandler, firecrawlService, browserClient, discoveryPanel] = await Promise.all([
    readWorkspaceFile('server/competitorSelectionEngine.ts'),
    readWorkspaceFile('server/competitorDiscoveryService.ts'),
    readWorkspaceFile('api/competitors.ts'),
    readWorkspaceFile('server/firecrawlCompetitorService.ts'),
    readWorkspaceFile('utils/competitorDiscovery.ts'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
  ]);

  assert.match(engine, /const INTENT_LEXICONS/);
  assert.match(engine, /const PAGE_TYPE_LEXICONS/);
  assert.match(engine, /export const analyzeAndSelectCompetitors/);
  assert.match(discoveryService, /analyzeAndSelectCompetitors\(/);
  assert.match(apiHandler, /discoverAndSelectCompetitors\(/);
  [discoveryService, apiHandler, firecrawlService, browserClient, discoveryPanel].forEach(source => {
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
  assert.doesNotMatch(userActivity, /recordLogin|recordTimeSpentOnArticle|recordArticleSave/);
  assert.doesNotMatch(userContext, /recordLoginActivity|recordLogin\(/);
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
  assert.match(scripts.postbuild || '', /check:admin-ai-secrets-release/);
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
  assert.match(adminApp, /articleTitle: string/);
  assert.match(adminApp, /metadata\.articleTitle \?\? metadata\.article_title/);
  assert.match(adminApp, />اسم المقالة</);
  assert.match(adminApp, /articlesById\.get\(request\.articleId\)/);
  assert.match(adminApp, /غير مرتبط بمقالة/);
  assert.match(adminApp, /buildAdminArticlePath\(request\.articleId\)/);
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
  assert.match(openAiExecutionEngine, /readAiProviderCapabilities\(telemetry\.actorUserId\)/);
  assert.match(openAiExecutionEngine, /AI_PROVIDER_DISABLED/);
  assert.match(openAiExecutionEngine, /AI_PROVIDER_NOT_CONFIGURED/);
  assert.match(aiExecutionEngine, /readAiProviderCapabilities\(userId\)/);
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

test('administrator prompt registry is the shared source for editor and writing workflows', async () => {
  const [
    settingsPage,
    registry,
    promptApi,
    userContext,
    aiContext,
    contentWritingEngine,
    contentWritingWorkflow,
    externalExecutor,
    engineeringPrompts,
    promptRegistrySettings,
  ] = await Promise.all([
    readWorkspaceFile('components/SettingsPage.tsx'),
    readWorkspaceFile('constants/promptRegistry.ts'),
    readWorkspaceFile('api/promptRegistry.ts'),
    readWorkspaceFile('contexts/UserContext.tsx'),
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('server/contentWritingEngine.ts'),
    readWorkspaceFile('server/contentWritingWorkflow.ts'),
    readWorkspaceFile('server/externalEngineeringAnalysisExecutor.ts'),
    readWorkspaceFile('constants/engineeringPrompts.ts'),
    readWorkspaceFile('components/AdminPromptRegistrySettings.tsx'),
  ]);

  assert.match(settingsPage, /label: 'الأوامر الهندسية'/);
  assert.match(settingsPage, /<AdminPromptRegistrySettings/);
  assert.match(registry, /PROMPT_REGISTRY_DEFINITIONS/);
  assert.match(registry, /attachments:/);
  assert.match(promptApi, /authenticateApiRequest\(req\)/);
  assert.match(userContext, /loadPromptRegistry\(\)/);
  assert.match(userContext, /PROMPT_REGISTRY_CHANGED_EVENT/);
  assert.match(userContext, /PROMPT_REGISTRY_REFRESH_MS/);
  assert.match(userContext, /window\.addEventListener\('focus', refreshPrompts\)/);
  assert.match(aiContext, /PROMPT_TEMPLATE_IDS\.repairSingleViolation/);
  assert.match(aiContext, /PROMPT_TEMPLATE_IDS\.repairBulkGroup/);
  assert.match(aiContext, /PROMPT_TEMPLATE_IDS\.contentBriefGeneration/);
  assert.match(registry, /contentWriting\.contentBriefGeneration/);
  assert.match(contentWritingEngine, /promptTemplates: settings\.promptRegistry\.templates/);
  assert.match(contentWritingWorkflow, /context_snapshot\?\.promptTemplates/);
  assert.match(externalExecutor, /readPromptRegistrySettings\(\)/);
  assert.match(promptRegistrySettings, /role="tablist"/);
  assert.match(promptRegistrySettings, /role="tabpanel"/);
  assert.match(promptRegistrySettings, /PROMPT_GROUP_IDS\.qualityGate/);
  assert.match(promptRegistrySettings, /PROMPT_GROUP_IDS\.internalLinking/);
  assert.match(promptRegistrySettings, /tabLabel: 'الربط الداخلي'/);
  assert.match(promptRegistrySettings, /setActiveGroupId\(group\.id\)/);
  assert.doesNotMatch(engineeringPrompts, /ENGINEERING_PROMPT_PASSWORD|Rezan90/);
  await assertFileMissing('components/EngineeringPromptsSettings.tsx');
});

test('administrator AI overrides are encrypted, admin-only, and resolved by shared provider engines', async () => {
  const [
    migration,
    vaultMigration,
    vaultService,
    secretService,
    secretApi,
    secretClient,
    secretSettings,
    settingsPage,
    capabilityService,
    openAiExecutionEngine,
    aiExecutionEngine,
  ] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260722050000_admin_ai_provider_secrets.sql'),
    readWorkspaceFile('supabase/migrations/20260829030000_provider_credential_vault.sql'),
    readWorkspaceFile('server/providerCredentialVault.ts'),
    readWorkspaceFile('server/adminAiProviderSecrets.ts'),
    readWorkspaceFile('api/adminAiProviderSecrets.ts'),
    readWorkspaceFile('utils/adminAiProviderSecrets.ts'),
    readWorkspaceFile('components/AdminAiProviderSecretsSettings.tsx'),
    readWorkspaceFile('components/SettingsPage.tsx'),
    readWorkspaceFile('server/aiProviderCapabilities.ts'),
    readWorkspaceFile('server/openAiExecutionEngine.ts'),
    readWorkspaceFile('server/aiExecutionEngine.ts'),
  ]);

  assert.match(migration, /alter table public\.ai_provider_secrets enable row level security/);
  assert.match(migration, /revoke all on table public\.ai_provider_secrets from authenticated/);
  assert.match(migration, /grant select, insert, update, delete on table public\.ai_provider_secrets to service_role/);
  assert.match(vaultMigration, /create table if not exists public\.provider_credentials_vault/);
  assert.match(vaultMigration, /revoke all on table public\.provider_credentials_vault from public, anon, authenticated/);
  assert.match(vaultService, /aes-256-gcm/);
  assert.match(vaultService, /cipher\.setAAD\(Buffer\.from\(encryptionContext, 'utf8'\)\)/);
  assert.match(vaultService, /AI_SETTINGS_ENCRYPTION_KEY/);
  assert.match(secretService, /saveProviderCredentialVaultRow/);
  assert.match(secretApi, /principal\.role !== 'admin'/);
  assert.match(secretApi, /Cache-Control': 'no-store'/);
  assert.doesNotMatch(secretApi, /ciphertext|authentication_tag|initialization_vector/);
  assert.doesNotMatch(secretClient, /localStorage|sessionStorage/);
  assert.match(secretSettings, /autoComplete="new-password"/);
  assert.match(secretSettings, /saveAndEnableAdminAiProviderSecret/);
  assert.match(settingsPage, /\{isAdmin && \(\s*<SettingsSection title="مفاتيح المزودات الإدارية المشفّرة">/);
  assert.match(capabilityService, /readAiProviderCredentialAvailability\(userId\)/);
  assert.match(openAiExecutionEngine, /resolveOpenAiApiKeys\(\s*telemetry\.actorUserId,\s*options\.credentialPurpose/);
  assert.match(aiExecutionEngine, /resolveGeminiApiKeys\(provider, userId, options\.credentialPurpose\)/);
  assert.doesNotMatch(openAiExecutionEngine, /process\.env\.OPENAI_API_KEYS?/);
  assert.doesNotMatch(aiExecutionEngine, /process\.env\.GEMINI_(?:PAID|PRO)_API_KEYS?/);
});

test('each user can manage encrypted personal AI key groups without exposing raw keys', async () => {
  const [
    migration,
    vaultMigration,
    vaultService,
    secretService,
    secretApi,
    secretClient,
    secretSettings,
    settingsPage,
    adminSecretService,
  ] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260726000000_user_ai_provider_secrets.sql'),
    readWorkspaceFile('supabase/migrations/20260829030000_provider_credential_vault.sql'),
    readWorkspaceFile('server/providerCredentialVault.ts'),
    readWorkspaceFile('server/userAiProviderSecrets.ts'),
    readWorkspaceFile('api/userAiProviderSecrets.ts'),
    readWorkspaceFile('utils/userAiProviderSecrets.ts'),
    readWorkspaceFile('components/UserAiProviderSecretsSettings.tsx'),
    readWorkspaceFile('components/SettingsPage.tsx'),
    readWorkspaceFile('server/adminAiProviderSecrets.ts'),
  ]);

  assert.match(migration, /alter table public\.user_ai_provider_secrets enable row level security/);
  assert.match(migration, /revoke all on table public\.user_ai_provider_secrets from authenticated/);
  assert.match(migration, /primary key \(user_id, provider\)/);
  assert.match(vaultMigration, /credential_type text not null/);
  assert.match(vaultMigration, /owner_user_id uuid references public\.profiles\(id\) on delete cascade/);
  assert.match(vaultService, /aes-256-gcm/);
  assert.match(vaultService, /getProviderCredentialVaultAad/);
  assert.match(secretService, /getPersonalVaultKey/);
  assert.match(secretService, /saveProviderCredentialVaultRow/);
  assert.match(secretApi, /principal\.userId/);
  assert.doesNotMatch(secretApi, /body\.userId|body\.user_id/);
  assert.doesNotMatch(secretApi, /ciphertext|authentication_tag|initialization_vector/);
  assert.doesNotMatch(secretClient, /localStorage|sessionStorage/);
  assert.match(secretSettings, /gemini_free/);
  assert.match(secretSettings, /gemini_paid/);
  assert.match(secretSettings, /openai_paid/);
  assert.match(settingsPage, /<UserAiProviderSecretsSettings\s*\/>/);
  assert.match(adminSecretService, /source: 'user'/);
  assert.match(adminSecretService, /resolveUserAiProviderKeys/);
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
  assert.match(builder, /CONTENT_WRITING_MIN_COMPETITOR_COUNT = 3/);
  assert.match(builder, /CONTENT_WRITING_MIN_COMPETITOR_WORDS = 250/);
  assert.match(builder, /CONTENT_WRITING_MIN_DISTINCT_SOURCE_DOMAINS = 2/);
  assert.match(builder, /CONTENT_WRITING_MAX_COMPETITOR_COUNT = MAX_ARTICLE_COMPETITORS/);
  assert.doesNotMatch(builder, /content\.slice\(/);
  assert.match(settingsRegistry, /CONTENT_WRITING_TEMPLATE_FIELDS/);
  assert.match(settingsPage, /ContentWritingPromptSettings/);
});

test('smart content brief keeps only its core fields required and is controlled by the prompt registry', async () => {
  const [goalTab, goalFields, contextBuilder, promptRegistry, aiContext] = await Promise.all([
    readWorkspaceFile('components/GoalTab.tsx'),
    readWorkspaceFile('components/GoalContextFields.tsx'),
    readWorkspaceFile('utils/contentWritingContext.ts'),
    readWorkspaceFile('constants/promptRegistry.ts'),
    readWorkspaceFile('contexts/AIContext.tsx'),
  ]);

  assert.match(goalTab, /getSmartContentBriefMissingKeys/);
  assert.match(goalTab, /smartBriefComplete/);
  assert.match(goalFields, /SMART_CONTENT_BRIEF_REQUIRED_KEYS/);
  assert.match(contextBuilder, /optionalFields/);
  assert.match(contextBuilder, /if \(value\) serialized\[key\] = value/);
  assert.doesNotMatch(contextBuilder, /goal_context\.targetAudience/);
  assert.match(promptRegistry, /contentWriting\.contentBriefGeneration/);
  assert.match(promptRegistry, /manual_choices_json/);
  assert.match(promptRegistry, /existing_generated_brief/);
  assert.match(promptRegistry, /\{"briefText":/);
  assert.match(promptRegistry, /موجز المقالة الذكي/);
  assert.match(promptRegistry, /لا تُرفق بقية حقول الجمهور/);
  assert.match(goalTab, /generatedBrief: result\.briefText/);
  assert.doesNotMatch(goalTab, /setGoalContext\(result\.context\)/);
  assert.match(contextBuilder, /'generatedBrief'/);
  assert.match(aiContext, /getPromptTemplate\([\s\S]*PROMPT_TEMPLATE_IDS\.contentBriefGeneration/);
  assert.doesNotMatch(
    `${goalTab}\n${contextBuilder}\n${promptRegistry}\n${aiContext}`,
    /search\s*console|searchConsole/i,
  );
});

test('content writing and editor standards share manual or competitor-derived dynamic length targets', async () => {
  const [targets, engine, workflow, quality, goalFields, analysisHook, wordRule, competitorStorage] = await Promise.all([
    readWorkspaceFile('utils/contentWritingTargets.ts'),
    readWorkspaceFile('server/contentWritingEngine.ts'),
    readWorkspaceFile('server/contentWritingWorkflow.ts'),
    readWorkspaceFile('utils/contentWritingQuality.ts'),
    readWorkspaceFile('components/GoalContextFields.tsx'),
    readWorkspaceFile('hooks/useContentAnalysis.ts'),
    readWorkspaceFile('utils/analysis/rules/checkWordCount.ts'),
    readWorkspaceFile('utils/competitorStorage.ts'),
  ]);

  assert.match(targets, /CONTENT_WRITING_AUTOMATIC_WORD_MULTIPLIER = 1\.2/);
  assert.match(targets, /CONTENT_WRITING_AUTOMATIC_WORD_TOLERANCE = 0\.1/);
  assert.match(targets, /resolveRobustBaselineCompetitor/);
  assert.match(targets, /deriveContentWritingOutlineSections/);
  assert.match(engine, /resolveContentWritingLengthTarget/);
  assert.match(engine, /lengthTarget,/);
  assert.match(workflow, /balanceContentWritingOutlineWordTargets/);
  assert.match(workflow, /targetWords: qualityRuntime\?\.configuration\.policy\.targetWords/);
  assert.match(
    quality,
    /\.filter\(\(\[id, result\]\) => id !== 'wordCount' && result\.status !== 'info'\)/,
  );
  assert.match(goalFields, /parseContentWritingTargetWordRange/);
  assert.match(analysisHook, /resolveContentWritingLengthTarget/);
  assert.match(analysisHook, /COMPETITOR_TEXTS_CHANGED_EVENT/);
  assert.match(wordRule, /lengthTarget\?\.mode === 'automatic'/);
  assert.match(wordRule, /automaticTarget\.baselineCompetitor\.wordCount/);
  assert.match(competitorStorage, /COMPETITOR_TEXTS_CHANGED_EVENT/);
});

test('content writing enforces one goal-aware final section after FAQ across assembly and revisions', async () => {
  const [workflow, serverWorkflow, resultUi, engine] = await Promise.all([
    readWorkspaceFile('utils/contentWritingWorkflow.ts'),
    readWorkspaceFile('server/contentWritingWorkflow.ts'),
    readWorkspaceFile('components/ContentWritingStepResult.tsx'),
    readWorkspaceFile('server/contentWritingEngine.ts'),
  ]);

  assert.match(workflow, /CONTENT_WRITING_WORKFLOW_VERSION = 13/);
  assert.match(workflow, /auditContentWritingFinalSectionStructure/);
  assert.match(workflow, /final_structure_faq_not_penultimate/);
  assert.match(workflow, /final_structure_duplicate_final_heading/);
  assert.match(workflow, /truncateGeneratedBodyBeforeH2/);
  assert.match(serverWorkflow, /finalSectionStructureGuard/);
  assert.match(serverWorkflow, /finalSectionStructureGuard\.accepted/);
  assert.match(resultUi, /final_structure_duplicate_final_heading/);
  assert.match(engine, /finalSectionStructureVersion: 1/);
});

test('competitor coverage matrix and phrase intelligence are deterministic and controlled by the prompt registry', async () => {
  const [knowledge, phraseAnalysis, workflow, serverWorkflow, promptRegistry, settings] = await Promise.all([
    readWorkspaceFile('utils/contentWritingKnowledge.ts'),
    readWorkspaceFile('utils/competitorPhraseAnalysis.ts'),
    readWorkspaceFile('utils/contentWritingWorkflow.ts'),
    readWorkspaceFile('server/contentWritingWorkflow.ts'),
    readWorkspaceFile('constants/promptRegistry.ts'),
    readWorkspaceFile('components/ContentWritingPromptSettings.tsx'),
  ]);

  assert.match(knowledge, /CONTENT_WRITING_KNOWLEDGE_VERSION = 4/);
  assert.match(knowledge, /buildContentWritingCompetitorCoverageMatrix/);
  assert.match(knowledge, /deriveCompetitorNumbers\(sourceChunkIds, chunksById\)/);
  assert.match(knowledge, /coverageLevel: deriveCoverageLevel/);
  assert.match(knowledge, /competitorCoverageMatrix: knowledge\.competitorCoverageMatrix/);
  assert.match(workflow, /title: 'Competitor coverage and claim ledger'/);
  assert.match(serverWorkflow, /persisted_competitor_coverage_matrix/);
  assert.match(serverWorkflow, /originalityOpportunityIdeaCount/);
  assert.match(phraseAnalysis, /createCompetitorPhraseIntelligence/);
  assert.match(phraseAnalysis, /competitorPhraseIntelligenceToPromptJson/);
  assert.match(workflow, /competitor_phrase_intelligence_json/);
  assert.match(serverWorkflow, /deterministic_competitor_phrase_intelligence/);
  assert.match(serverWorkflow, /competitorPhraseIntelligence/);
  assert.match(promptRegistry, /PROMPT_REGISTRY_VERSION = 21/);
  assert.match(promptRegistry, /بناء مصفوفة تغطية المنافسين/);
  assert.match(promptRegistry, /competitor_phrase_intelligence_json/);
  assert.match(promptRegistry, /originalityOpportunity/);
  assert.match(promptRegistry, /مصفوفة تغطية المنافسين/);
  assert.match(settings, /contentWritingCompetitorPhraseIntelligenceEnabled/);
  assert.match(settings, /تفعيل ذكاء عبارات المنافسين/);
  assert.match(settings, /contentWritingDualKnowledgeExtractionEnabled/);
  assert.match(settings, /contentWritingMultiCandidateGenerationEnabled/);
  assert.match(serverWorkflow, /buildContentWritingKnowledgeReconciliationPrompt/);
  assert.match(serverWorkflow, /knowledgeEnsemble/);
  assert.match(serverWorkflow, /runCandidateStage/);
  assert.match(serverWorkflow, /candidateMode: 'single_balanced'/);
  assert.match(serverWorkflow, /knowledgeStrategyKey/);
  assert.match(settings, /الكتابة المركّزة الشاملة/);
  assert.match(settings, /الكتابة العميقة الاستقصائية/);
  assert.match(settings, /الكتابة المتوازنة/);
  assert.match(promptRegistry, /contentWriting\.knowledgeReconciliation/);
  assert.doesNotMatch(
    `${knowledge}\n${phraseAnalysis}\n${workflow}\n${serverWorkflow}\n${promptRegistry}`,
    /search\s*console|searchConsole/i,
  );
});

test('FAQ writing uses a goal-aware evidence-backed independence audit with visible decisions', async () => {
  const [faqEngine, workflow, serverWorkflow, quality, resultUi, promptRegistry] = await Promise.all([
    readWorkspaceFile('utils/contentWritingFaq.ts'),
    readWorkspaceFile('utils/contentWritingWorkflow.ts'),
    readWorkspaceFile('server/contentWritingWorkflow.ts'),
    readWorkspaceFile('utils/contentWritingQuality.ts'),
    readWorkspaceFile('components/ContentWritingFaqAudit.tsx'),
    readWorkspaceFile('constants/promptRegistry.ts'),
  ]);

  assert.match(faqEngine, /PAGE_TYPE_INTENTS/);
  assert.match(faqEngine, /extractContentWritingFaqQuestionSeeds/);
  assert.match(faqEngine, /normalizeContentWritingFaqAudit/);
  assert.match(faqEngine, /evaluateContentWritingFaqRevision/);
  assert.match(workflow, /mandatory_faq_independence_protocol/);
  assert.match(serverWorkflow, /faqIndependenceAudit/);
  assert.match(serverWorkflow, /faqIndependenceGuard/);
  assert.match(quality, /quality\.faqIndependence/);
  assert.match(resultUi, /الأسئلة المقبولة وما أضافته/);
  assert.match(resultUi, /الأسئلة المستبعدة وأسباب القرار/);
  assert.match(promptRegistry, /faq_intent_blueprints_json/);
  assert.match(promptRegistry, /faq_question_seeds_json/);
});

test('semantic keyword generation shares one editable prompt and one deterministic policy', async () => {
  const [aiContext, externalTerms, externalExecutor, assignedAutomation, promptRegistry, adminRegistry] = await Promise.all([
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('server/externalSemanticTerms.ts'),
    readWorkspaceFile('server/externalSemanticAnalysisExecutor.ts'),
    readWorkspaceFile('api/assignedArticleAutomation.ts'),
    readWorkspaceFile('constants/promptRegistry.ts'),
    readWorkspaceFile('components/AdminPromptRegistrySettings.tsx'),
  ]);

  assert.match(promptRegistry, /semanticKeywords\.generation/);
  assert.match(promptRegistry, /المفرد في بعض الصيغ والجمع في صيغ أخرى/);
  assert.match(promptRegistry, /«أفضل» و«أحسن»/);
  assert.match(adminRegistry, /PROMPT_GROUP_IDS\.semanticKeywords/);
  assert.match(aiContext, /renderSemanticKeywordPrompt/);
  assert.match(aiContext, /parseSemanticKeywordTerms/);
  assert.match(externalTerms, /semanticKeywordPolicy/);
  assert.match(externalExecutor, /readPromptRegistrySettings/);
  assert.match(assignedAutomation, /PROMPT_TEMPLATE_IDS\.semanticKeywordsGeneration/);
  assert.doesNotMatch(
    `${aiContext}\n${externalTerms}\n${assignedAutomation}`,
    /You are an expert semantic SEO editor/,
  );
});

test('source registry and claim ledger constrain every content-writing repair surface', async () => {
  const [claims, knowledge, workflow, serverWorkflow, promptRegistry, quality, revision] = await Promise.all([
    readWorkspaceFile('utils/contentWritingClaims.ts'),
    readWorkspaceFile('utils/contentWritingKnowledge.ts'),
    readWorkspaceFile('utils/contentWritingWorkflow.ts'),
    readWorkspaceFile('server/contentWritingWorkflow.ts'),
    readWorkspaceFile('constants/promptRegistry.ts'),
    readWorkspaceFile('utils/contentWritingQuality.ts'),
    readWorkspaceFile('utils/contentWritingRevision.ts'),
  ]);

  assert.match(claims, /normalizeContentWritingSourceClaims/);
  assert.match(claims, /requires_external_verification/);
  assert.match(claims, /usagePolicy: 'qualify'/);
  assert.match(claims, /summarizeContentWritingClaimUsage/);
  assert.match(knowledge, /sourceRegistry: sourceClaims\.sourceRegistry/);
  assert.match(knowledge, /claimLedger: sourceClaims\.claimLedger/);
  assert.match(workflow, /PROMPT_TEMPLATE_IDS\.sourceClaimsLedger/);
  assert.match(workflow, /claims_ledger_json/);
  assert.match(serverWorkflow, /deterministicBlockedClaimIds/);
  assert.match(serverWorkflow, /usedClaimIds: repairedCoverage\.usedClaimIds/);
  assert.match(promptRegistry, /contentWriting\.sourceClaimsLedger/);
  assert.match(promptRegistry, /محرك المصادر وسجل الادعاءات/);
  assert.match(promptRegistry, /لا تُدخل ادعاء blocked/);
  assert.match(quality, /PROMPT_TEMPLATE_IDS\.qualityRepair/);
  assert.match(revision, /blocked_claim_introduced/);
  assert.match(revision, /knowledge_coverage_decreased/);
  assert.match(serverWorkflow, /compareContentWritingQualityReports/);
  assert.match(serverWorkflow, /acceptedDraft: accepted \? application\.candidateMarkdown : null/);
  assert.match(serverWorkflow, /buildTargetedRevisionArticleContext\(compactArticleContext\)/);
  assert.match(serverWorkflow, /withheld="targeted-revision"/);
  assert.match(promptRegistry, /لا تُرجع المقالة كاملة/);
  assert.doesNotMatch(
    `${claims}\n${knowledge}\n${workflow}\n${serverWorkflow}\n${promptRegistry}\n${quality}`,
    /search\s*console|searchConsole/i,
  );
});

test('content writing editor UI runs through durable authenticated sessions', async () => {
  const [panel, client, rightSidebar, workflow, stepResult, transparencyPanel] = await Promise.all([
    readWorkspaceFile('components/ContentWritingPanel.tsx'),
    readWorkspaceFile('utils/contentWritingSessions.ts'),
    readWorkspaceFile('components/RightSidebar.tsx'),
    readWorkspaceFile('server/contentWritingWorkflow.ts'),
    readWorkspaceFile('components/ContentWritingStepResult.tsx'),
    readWorkspaceFile('components/ContentWritingTransparencyPanel.tsx'),
  ]);

  assert.match(rightSidebar, /lazy\(\(\) => import\('\.\/ContentWritingPanel'\)\)/);
  assert.match(rightSidebar, /'writing'/);
  assert.match(panel, /isAiProviderEnabled\('gemini'\)/);
  assert.match(panel, /isAiProviderAvailable\('gemini'\)/);
  assert.match(panel, /isAiProviderEnabled\('geminiPaid'\)/);
  assert.match(panel, /isAiProviderAvailable\('geminiPaid'\)/);
  assert.match(panel, /isAiProviderEnabled\('chatgpt'\)/);
  assert.match(panel, /isAiProviderAvailable\('chatgpt'\)/);
  assert.ok(
    (panel.match(/await handleSaveDraft\(\{ reason: 'manual', force: true \}\)/g) || []).length >= 2,
    'starting either API or external writing must force a successful article save first',
  );
  assert.doesNotMatch(panel, /!saved && editor\?\.getText\(\)\.trim\(\)/);
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
  assert.match(panel, /includeStepOutput: true/);
  assert.match(panel, /includeStepMetadata: true/);
  assert.match(panel, /expandedWorkflowStepKey/);
  assert.match(panel, /workflowStepSelectionLockedRef\.current = true/);
  assert.match(panel, /aria-expanded=\{isExpanded\}/);
  assert.match(panel, /outputText/);
  assert.match(panel, /ستظهر هنا مباشرة فور اكتمالها/);
  assert.match(panel, /selectedDetail\?\.session\.id === selectedSessionId/);
  assert.match(panel, /activeDetail\.session\.resultText/);
  assert.match(panel, /recordContentWritingSessionApplication/);
  assert.match(panel, /contextSnapshot=\{activeDetail\?\.session\.contextSnapshot/);
  assert.doesNotMatch(panel, /getSupabaseClient|localStorage|sessionStorage/);
  assert.match(workflow, /evidenceTrace/);
  assert.match(workflow, /CONTENT_WRITING_EVIDENCE_TRACE_VERSION/);
  assert.match(stepResult, /ContentWritingEvidenceTrace/);
  assert.match(transparencyPanel, /data-content-writing-transparency="complete"/);
  assert.match(transparencyPanel, /knowledge\.claimLedger\.claims/);
  assert.match(transparencyPanel, /source\.chunkIds\.map/);
  assert.match(transparencyPanel, /ContentWritingChunkDisclosure/);
  assert.match(stepResult, /ContentWritingChunkDisclosure/);
  assert.match(client, /getAuthenticatedApiToken\(\)/);
  assert.match(client, /getAuthenticatedApiHeaders\(/);
  assert.match(client, /includeMessages: options\.includeMessages === true/);
  assert.match(client, /includeSteps: options\.includeSteps !== false/);
  assert.match(client, /includeStepOutput: options\.includeStepOutput === true/);
  assert.match(client, /includeStepMetadata: options\.includeStepMetadata === true/);
  assert.match(client, /action: 'start'/);
  assert.match(client, /action: 'get'/);
  assert.match(client, /action: 'list'/);
  assert.match(client, /action: 'cancel'/);
  assert.match(client, /action: 'resume'/);
  assert.match(client, /action: 'recordApplication'/);
});

test('single-result AI actions share one suggestion presenter and keep bulk review isolated', async () => {
  const [aiContext, suggestionModal, interactionContext] = await Promise.all([
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('components/SuggestionModal.tsx'),
    readWorkspaceFile('contexts/InteractionContext.tsx'),
  ]);
  const quickCommandFlow = aiContext.slice(
    aiContext.indexOf('const handleAiRequest = useCallback'),
    aiContext.indexOf('const handleAnalyzeHeadings = useCallback'),
  );
  const singleCriterionFixFlow = aiContext.slice(
    aiContext.indexOf('const handleAiFix = useCallback'),
    aiContext.indexOf('const getRelatedBulkFixRules = useCallback'),
  );

  assert.match(aiContext, /const presentSuggestion = useCallback/);
  assert.match(quickCommandFlow, /presentSuggestion\(/);
  assert.match(singleCriterionFixFlow, /presentSuggestion\(/);
  assert.doesNotMatch(singleCriterionFixFlow, /replaceBulkFixReviewItems|setFixAllProgress|setSuggestion\(/);
  assert.match(suggestionModal, /data-ai-suggestion-panel="true"/);
  assert.match(suggestionModal, /data-unified-suggestion-engine="true"/);
  assert.match(suggestionModal, /context => context\.dismissSuggestion/);
  assert.doesNotMatch(suggestionModal, /context => context\.setSuggestion/);
  assert.match(interactionContext, /setPinnedTooltip\(null\)[\s\S]*handleAiFix\(violation\.rule, violation\)/);
});
