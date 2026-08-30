import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const loadIsolated = async (entry: string, state: any = {}, stubs: Record<string, string> = {}) => {
  const key = `creator-policy-${randomUUID()}`;
  (globalThis as any)[key] = state;
  try {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))],
      bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false,
      plugins: [{
        name: 'isolated-creator-policy',
        setup(plugin) {
          plugin.onResolve({ filter: /.*/ }, args => {
            const name = args.path.split('/').pop()!.replace(/\.ts$/, '');
            return name in stubs ? { path: name, namespace: 'creator-policy-test' } : undefined;
          });
          plugin.onLoad({ filter: /.*/, namespace: 'creator-policy-test' }, args => ({
            contents: `const s = globalThis[${JSON.stringify(key)}];\n${stubs[args.path]}`,
            loader: 'js',
          }));
        },
      }],
    });
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  } finally {
    delete (globalThis as any)[key];
  }
};

const preferences = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, enabled: true,
  autoGenerateAlternativeKeywords: true, autoGenerateLsiKeywords: true,
  autoGenerateGoogleMetadata: true, autoDiscoverCompetitors: true,
  autoExtractCompetitorContent: true, autoRunReadyEngineeringCommands: true,
  contentWritingAutomationEnabled: true, autoApplyStrongInternalLinkSuggestions: true,
  externalAnalysisCommandIds: ['smartAnalysis.fullArticleAudit'],
  ...overrides,
});

const policy = (overrides: Record<string, unknown> = {}) => ({
  ...preferences(), scope: 'creator', policyVersion: 1, creatorUserId: 'creator-a', ...overrides,
});

const policyFixture = () => {
  const state: any = { rpcCalls: [], rowReads: [], result: { data: policy(), error: null }, row: { origin: 'auto', requested_by: 'creator-a' } };
  state.client = {
    rpc: async (name: string, args: unknown) => { state.rpcCalls.push({ name, args }); return state.result; },
    from: (table: string) => {
      const query: any = { table, filters: {} };
      query.select = () => query;
      query.eq = (key: string, value: unknown) => { query.filters[key] = value; return query; };
      query.maybeSingle = async () => { state.rowReads.push(query); return { data: state.row, error: state.rowError || null }; };
      return query;
    },
  };
  return state;
};

const loadPolicy = (state = policyFixture()) => loadIsolated('server/articleAutomationPolicy.ts', state, {
  externalAnalysisQueue: 'export const getExternalAnalysisSupabaseAdmin = () => s.client;',
  externalAnalysisExecutor: 'export class ExternalAnalysisTerminalError extends Error { constructor(value) { super(value.message); this.code = value.code; } }',
});

test('creator policy rejects invalid/missing schema and disables an absent creator or master switch', async () => {
  const runtime = await loadPolicy();
  for (const malformed of [null, undefined, [], {}, policy({ scope: 'unknown' }), policy({ policyVersion: undefined }), policy({ policyVersion: 0 }), policy({ autoDiscoverCompetitors: 'true' }), policy({ externalAnalysisCommandIds: null })]) {
    assert.throws(() => runtime.parseArticleAutomationPolicy(malformed), /unavailable|invalid/);
  }
  for (const raw of [policy({ creatorUserId: null }), policy({ creatorUserId: '' }), policy({ enabled: false })]) {
    const parsed = runtime.parseArticleAutomationPolicy(raw);
    for (const [key, value] of Object.entries(preferences())) {
      if (typeof value === 'boolean') assert.equal(parsed[key], false, key);
    }
  }
});

test('every creator automatic job requires the original creator and its own enabled stage', async () => {
  const runtime = await loadPolicy();
  const jobs = [
    ['semantic_keywords_lsi', 'autoGenerateAlternativeKeywords'],
    ['competitor_discovery', 'autoDiscoverCompetitors'],
    ['competitor_extraction', 'autoExtractCompetitorContent'],
    ['engineering_command', 'autoRunReadyEngineeringCommands'],
    ['content_writing_preparation', 'contentWritingAutomationEnabled'],
  ];
  for (const [jobType, stage] of jobs) {
    const job = { job_type: jobType, command_id: 'smartAnalysis.fullArticleAudit', requested_by: 'creator-a' };
    assert.equal(runtime.automaticJobAllowedByPolicy(job, policy()), true, jobType);
    for (const actor of ['assignee-b', 'administrator', null, '']) {
      assert.equal(runtime.automaticJobAllowedByPolicy({ ...job, requested_by: actor }, policy()), false, `${jobType}/${actor}`);
    }
    const disabled = policy({ [stage]: false, ...(jobType === 'semantic_keywords_lsi' ? { autoGenerateLsiKeywords: false, autoGenerateGoogleMetadata: false } : {}) });
    assert.equal(runtime.automaticJobAllowedByPolicy(job, disabled), false, stage);
    assert.equal(runtime.automaticJobAllowedByPolicy(job, policy({ enabled: false })), false);
  }
  assert.equal(runtime.automaticJobAllowedByPolicy({ job_type: 'unknown', requested_by: 'creator-a' }, policy()), false);
});

test('legacy work retains its existing actor and creator command selection never falls back from empty', async () => {
  const runtime = await loadPolicy();
  const commandJob = { job_type: 'engineering_command', command_id: 'smartAnalysis.fullArticleAudit', requested_by: 'creator-a' };
  assert.equal(runtime.automaticJobAllowedByPolicy(commandJob, policy({ externalAnalysisCommandIds: [] })), false);
  assert.equal(runtime.automaticJobAllowedByPolicy({ ...commandJob, command_id: 'smartAnalysis.entityMap' }, policy()), false);
  const legacy = runtime.parseArticleAutomationPolicy(policy({ scope: 'legacy', policyVersion: 0, creatorUserId: null }));
  assert.equal(runtime.automaticJobAllowedByPolicy({ ...commandJob, requested_by: 'legacy-assignee' }, legacy), true);
  assert.equal(runtime.automaticJobAllowedByPolicy({ job_type: 'competitor_discovery', requested_by: null }, legacy), true);
});

test('policy reads fail closed on database/schema errors and automatic work is checked before execution', async () => {
  const state = policyFixture();
  const runtime = await loadPolicy(state);
  const job = { id: 'job-a', article_id: 'article-a', origin: 'auto', requested_by: 'creator-a', job_type: 'competitor_discovery' };
  await runtime.assertAutomaticArticlePolicy(job);
  assert.deepEqual(state.rpcCalls[0], { name: 'article_automation_policy', args: { p_article_id: 'article-a' } });
  state.result = { data: null, error: { code: 'PGRST202', message: 'missing function' } };
  await assert.rejects(runtime.assertAutomaticArticlePolicy(job), /PGRST202/);
  state.result = { data: null, error: null };
  await assert.rejects(runtime.assertAutomaticArticlePolicy(job), /unavailable/);
  state.result = { data: policy({ autoDiscoverCompetitors: false }), error: null };
  await assert.rejects(runtime.assertAutomaticArticlePolicy(job), (error: any) => error.code === 'creator_automation_disabled');
  state.result = { data: policy(), error: null };
  await assert.rejects(runtime.assertAutomaticArticlePolicy({ ...job, requested_by: 'assignee-b' }), (error: any) => error.code === 'creator_automation_disabled');
});

test('explicit manual work and persisted manual promotions bypass personal automatic switches', async () => {
  const state = policyFixture();
  const runtime = await loadPolicy(state);
  state.result = { data: null, error: { code: 'PGRST202' } };
  await runtime.assertAutomaticArticlePolicy({ origin: 'manual', requested_by: 'editor-b' });
  assert.equal(state.rowReads.length, 0);
  assert.equal(state.rpcCalls.length, 0);
  state.row = { origin: 'manual', requested_by: 'editor-b' };
  const adopted = { id: 'job-a', article_id: 'article-a', origin: 'auto', requested_by: 'creator-a' };
  await runtime.assertAutomaticArticlePolicy(adopted);
  assert.equal(adopted.origin, 'manual');
  assert.equal(adopted.requested_by, 'editor-b');
  assert.equal(state.rpcCalls.length, 0);
});

const apiFixture = () => ({ principal: { userId: 'self-user', role: 'user' }, calls: [] as any[], limits: [] as any[] });
const loadApi = (state: any) => loadIsolated('api/userAutomation.ts', state, {
  apiSecurity: `export class ApiSecurityError extends Error { constructor(message, status) { super(message); this.status = status; } }
    export const assertAllowedOrigin = () => { if (s.rejectOrigin) throw new ApiSecurityError('origin blocked', 403); };
    export const authenticateApiRequest = async () => { if (!s.principal) throw new ApiSecurityError('sign in', 401); return s.principal; };
    export const consumeApiRateLimit = (...args) => s.limits.push(args);
    export const getCorsPreflightHeaders = () => ({});
    export const getCorsResponseHeaders = () => ({});
    export const toApiSecurityResult = error => error instanceof ApiSecurityError ? { status: error.status, body: { error: error.message } } : null;`,
  userAutomationSettings: `export const readOrSaveUserAutomationSettings = async (userId, preferences) => {
    s.calls.push({ userId, preferences }); return { preferences: preferences || {}, effectivePreferences: {}, blockedReasons: {} };
  };`,
});

test('self endpoint rejects forged targets and neither user nor admin can select another account', async () => {
  const state = apiFixture();
  const api = await loadApi(state);
  for (const role of ['user', 'admin']) {
    state.principal = { userId: `self-${role}`, role };
    const forged = await api.default({ method: 'PUT', body: { preferences: preferences(), userId: 'victim' } });
    assert.equal(forged.status, 400);
    const get = await api.default({ method: 'GET', query: { userId: 'victim' }, url: '/api/user/automation?userId=victim' });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal(state.calls.at(-1).userId, `self-${role}`);
    const nested = await api.default({ method: 'PUT', body: { preferences: preferences({ userId: 'victim', role: 'admin' }) } });
    assert.equal(nested.status, 200);
    assert.equal(state.calls.at(-1).userId, `self-${role}`);
    assert.equal(Object.hasOwn(state.calls.at(-1).preferences, 'userId'), false);
    assert.equal(Object.hasOwn(state.calls.at(-1).preferences, 'role'), false);
  }
  assert.equal(state.calls.length, 4);
  assert.equal(state.limits.length, 6);
});

test('self endpoint preserves explicit false and empty commands and validates payloads before saving', async () => {
  const state = apiFixture();
  const api = await loadApi(state);
  const requested = preferences({ enabled: false, autoGenerateAlternativeKeywords: false, autoRunReadyEngineeringCommands: false, externalAnalysisCommandIds: [] });
  const saved = await api.default({ method: 'PUT', body: { preferences: requested } });
  assert.equal(saved.status, 200);
  assert.deepEqual(state.calls[0].preferences, requested);
  for (const invalid of [null, {}, { preferences: [] }, { preferences: preferences({ enabled: 'false' }) }, { preferences: preferences({ autoDiscoverCompetitors: undefined }) }, { preferences: preferences({ externalAnalysisCommandIds: [null] }) }]) {
    assert.equal((await api.default({ method: 'PUT', body: invalid })).status, 400);
  }
  assert.equal(state.calls.length, 1);
  assert.equal((await api.default({ method: 'DELETE' })).status, 405);
  state.principal = null as any;
  assert.equal((await api.default({ method: 'GET' })).status, 401);
  assert.equal(state.calls.length, 1);
});

const providerFixture = (): any => ({
  schemaAvailable: true,
  assignedCredentials: [],
  policies: Object.fromEntries(['gemini_free', 'gemini_paid', 'openai', 'firecrawl', 'browserless'].map(provider => [provider, {
    provider, enabled: true, credentialMode: 'personal_first',
    dailyRequestLimit: null as number | null, monthlyRequestLimit: null as number | null,
  }])),
  usage: Object.fromEntries(['gemini_free', 'gemini_paid', 'openai', 'firecrawl', 'browserless'].map(provider => [provider, { dailyUsed: 0, monthlyUsed: 0 }])),
});

const serviceFixture = () => {
  const state: any = { providers: providerFixture(), providerReads: [], rpcCalls: [], ai: { contentWritingAutomationProvider: 'gemini', geminiFreeEnabled: true, geminiProEnabled: true, openAiEnabled: true }, settings: { data: { preferences: preferences(), adminLimits: preferences(), initializedAt: '2026-08-31T12:00:00Z' }, error: null } };
  state.client = {
    rpc: async (name: string, args: unknown) => { state.rpcCalls.push({ name, args }); return state.settings; },
    from: () => {
      const query: any = {};
      query.select = query.eq = () => query;
      query.maybeSingle = async () => ({ data: { value: state.ai }, error: state.aiError || null });
      return query;
    },
  };
  return state;
};
const loadService = (state = serviceFixture()) => loadIsolated('server/userAutomationSettings.ts', state, {
  externalAnalysisQueue: 'export const getExternalAnalysisSupabaseAdmin = () => s.client;',
  providerAccessControl: 'export const readUserProviderAccessOverview = async userId => { s.providerReads.push(userId); return s.providers; };',
});

test('effective settings intersect admin limits without overwriting preferences or hiding cap reasons when master is off', async () => {
  const state = serviceFixture();
  const runtime = await loadService(state);
  const desired = preferences({ enabled: false, autoGenerateAlternativeKeywords: false });
  const before = structuredClone(desired);
  const limits = preferences({ autoGenerateAlternativeKeywords: false, autoDiscoverCompetitors: false });
  const result = runtime.computeEffectiveUserAutomation(desired, limits, state.providers, state.ai);
  assert.deepEqual(desired, before);
  for (const [key, value] of Object.entries(desired)) {
    if (typeof value === 'boolean') assert.equal(result.effectivePreferences[key], false, key);
  }
  assert.ok(result.blockedReasons.autoGenerateAlternativeKeywords);
  assert.ok(result.blockedReasons.autoDiscoverCompetitors);
  assert.equal(result.blockedReasons.enabled, undefined);
  const enabled = runtime.computeEffectiveUserAutomation(preferences(), limits, state.providers, state.ai);
  assert.deepEqual(enabled.blockedReasons, result.blockedReasons);
  assert.equal(enabled.effectivePreferences.autoGenerateLsiKeywords, true);
  assert.equal(enabled.effectivePreferences.autoDiscoverCompetitors, false);
  assert.equal(runtime.computeEffectiveUserAutomation(preferences({ externalAnalysisCommandIds: [] }), preferences(), state.providers, state.ai).effectivePreferences.autoRunReadyEngineeringCommands, false);
});

test('provider disabling and exhausted daily/monthly quotas block AI independently of saved user switches', async () => {
  const state = serviceFixture();
  const runtime = await loadService(state);
  for (const providerState of [
    { enabled: false }, { credentialMode: 'disabled' }, { dailyRequestLimit: 2 }, { monthlyRequestLimit: 3 },
  ]) {
    const providers = providerFixture();
    Object.assign(providers.policies.gemini_free, providerState);
    providers.usage.gemini_free = { dailyUsed: 2, monthlyUsed: 3 };
    const result = runtime.computeEffectiveUserAutomation(preferences({ enabled: false }), preferences(), providers, state.ai);
    for (const key of ['autoGenerateAlternativeKeywords', 'autoGenerateLsiKeywords', 'autoGenerateGoogleMetadata', 'autoRunReadyEngineeringCommands']) {
      assert.equal(result.effectivePreferences[key], false);
      assert.ok(result.blockedReasons[key]);
    }
  }
  const result = runtime.computeEffectiveUserAutomation(preferences(), preferences(), state.providers, { ...state.ai, geminiFreeEnabled: false });
  assert.equal(result.effectivePreferences.autoGenerateGoogleMetadata, false);
  assert.ok(result.blockedReasons.autoGenerateGoogleMetadata);
  assert.equal(result.effectivePreferences.autoApplyStrongInternalLinkSuggestions, true);
});

test('writing availability follows the selected free, paid, or OpenAI provider', async () => {
  const state = serviceFixture();
  const runtime = await loadService(state);
  for (const [requested, provider] of [['gemini', 'gemini_free'], ['geminiPaid', 'gemini_paid'], ['openai', 'openai']]) {
    const providers = providerFixture();
    providers.policies[provider].enabled = false;
    const blocked = runtime.computeEffectiveUserAutomation(preferences(), preferences(), providers, { ...state.ai, contentWritingAutomationProvider: requested });
    assert.equal(blocked.effectivePreferences.contentWritingAutomationEnabled, false, requested);
    assert.ok(blocked.blockedReasons.contentWritingAutomationEnabled, requested);
    providers.policies[provider].enabled = true;
    for (const other of ['gemini_free', 'gemini_paid', 'openai'].filter(key => key !== provider)) providers.policies[other].enabled = false;
    const allowed = runtime.computeEffectiveUserAutomation(preferences(), preferences(), providers, { ...state.ai, contentWritingAutomationProvider: requested });
    assert.equal(allowed.effectivePreferences.contentWritingAutomationEnabled, true, requested);
  }
});

test('settings service binds reads and saves to supplied authenticated identity and fails on incomplete schema', async () => {
  const state = serviceFixture();
  const runtime = await loadService(state);
  const loaded = await runtime.readOrSaveUserAutomationSettings('self-a');
  assert.equal(loaded.initializedAt, '2026-08-31T12:00:00Z');
  assert.deepEqual(state.rpcCalls[0], { name: 'get_user_automation_settings', args: { p_user_id: 'self-a' } });
  const wanted = preferences({ autoDiscoverCompetitors: false, externalAnalysisCommandIds: [] });
  state.settings.data.preferences = wanted;
  const saved = await runtime.readOrSaveUserAutomationSettings('self-b', wanted);
  assert.deepEqual(state.rpcCalls[1], { name: 'save_user_automation_settings', args: { p_user_id: 'self-b', p_preferences: wanted } });
  assert.deepEqual(state.providerReads, ['self-a', 'self-b']);
  assert.deepEqual(saved.preferences.externalAnalysisCommandIds, []);
  assert.equal(saved.preferences.autoDiscoverCompetitors, false);
  state.settings = { data: null, error: { code: 'PGRST202' } };
  await assert.rejects(runtime.readOrSaveUserAutomationSettings('self-a'), /قاعدة البيانات/);
  state.settings = { data: { preferences: preferences(), adminLimits: {} }, error: null };
  await assert.rejects(runtime.readOrSaveUserAutomationSettings('self-a'), /غير مكتملة/);
});

test('scoped semantic generation and repair explicitly exclude disabled lists while legacy prompts retain their defaults', async () => {
  const runtime = await loadIsolated('server/externalSemanticTerms.ts');
  const article: any = {
    title: 'Travel guide', plainText: 'A useful article about travel planning.', articleLanguage: 'en', goalContext: {},
    keywords: { primary: 'travel planning', company: '', secondaries: [], lsi: [], googleTitles: [], googleDescriptions: [] },
  };
  const template = 'Create terms for {{primary_keyword}} and {{article_title}}.';
  for (const buildPrompt of [
    (secondary: boolean, lsi: boolean, google: boolean) => runtime.buildExternalSemanticPrompt(article, template, secondary, lsi, google, true),
    (secondary: boolean, lsi: boolean, google: boolean) => runtime.buildExternalSemanticRepairPrompt(article, '{}', template, secondary, lsi, google, true),
  ]) {
    const lsiOnly = buildPrompt(false, true, false);
    const block = lsiOnly.slice(lsiOnly.lastIndexOf('<requested_semantic_lists>'));
    assert.match(block, /secondaries غير مطلوبة: أرجع \[\]/);
    assert.match(block, /أنشئ كلمات LSI المطلوبة/);
    assert.match(block, /googleTitles وgoogleDescriptions غير مطلوبتين: أرجع \[\]/);
    const googleOnly = buildPrompt(false, false, true);
    const googleBlock = googleOnly.slice(googleOnly.lastIndexOf('<requested_semantic_lists>'));
    assert.match(googleBlock, /lsi غير مطلوبة: أرجع \[\]/);
    assert.match(googleBlock, /أنشئ googleTitles وgoogleDescriptions كاملتين/);
    assert.doesNotMatch(googleBlock, /أنشئ صيغًا بديلة جديدة ضمن الأمر الموحد/);
  }
  const legacy = runtime.buildExternalSemanticPrompt(article, template, false, false, false);
  assert.match(legacy, /أنشئ صيغًا بديلة جديدة ضمن الأمر الموحد/);
  assert.match(legacy, /أنشئ دائمًا googleTitles وgoogleDescriptions كاملتين/);
});
