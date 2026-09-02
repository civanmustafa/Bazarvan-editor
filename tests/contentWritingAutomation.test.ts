import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const loadOverviewApi = async (access: string, completedAt = '') => {
  const stateKey = `writing-overview-${randomUUID()}`;
  const itemId = '11111111-1111-4111-8111-111111111111';
  const articleId = '22222222-2222-4222-8222-222222222222';
  const checks: string[] = [];
  const sessionReads: Record<string, unknown>[] = [];
  const state = {
    access,
    checks,
    client: {
      rpc: async (): Promise<{ data: unknown[]; error: null }> => ({ data: [], error: null }),
      from: (table: string) => {
        const filters: Record<string, unknown> = {};
        const query: any = {};
        for (const method of ['select', 'order', 'limit']) query[method] = () => query;
        for (const method of ['eq', 'in', 'neq', 'gt']) query[method] = (key: string, value: unknown) => {
          filters[key] = value;
          return query;
        };
        query.maybeSingle = async (): Promise<{ data: Record<string, unknown> | null; error: null }> => {
          if (table === 'content_writing_sessions' && filters.article_id) sessionReads.push(filters);
          return ({
          data: table === 'content_writing_automation_state' ? {
            last_item_id: itemId, last_article_id: articleId, last_outcome: 'failed',
            next_allowed_at: '', updated_at: '2026-09-02T10:00:00Z',
          } : table === 'content_writing_automation_items' && filters.id === itemId ? {
            id: itemId, article_id: articleId, status: 'blocked',
            completed_at: '2026-09-02T10:00:00Z',
            last_error_code: 'gemini_http_429', last_error: 'Quota exhausted',
            articles: { title: 'أغلى جهاز كشف الذهب في العالم', status: 'draft' },
            content_writing_sessions: { status: 'failed' },
          } : table === 'content_writing_sessions' && filters.article_id === articleId
            && completedAt > String(filters.completed_at) ? { id: 'manual-session', completed_at: completedAt } : null,
          error: null,
        }); };
        return query;
      },
    },
  };
  (globalThis as any)[stateKey] = state;
  const stubs: Record<string, string> = {
    apiSecurity: `
      export const assertAllowedOrigin = () => {};
      export const assertRequestContentLength = () => {};
      export const authenticateApiRequest = async () => ({ userId: 'viewer', role: 'user' });
      export const consumeApiRateLimit = () => {};
      export const getCorsPreflightHeaders = () => ({});
      export const getCorsResponseHeaders = () => ({});
      export const getPositiveIntegerEnv = (name, fallback) => fallback;
      export const toApiSecurityResult = () => null;
    `,
    articleAccessPolicy: `
      export const getArticleAccessLevelForUser = async (client, articleId, userId) => {
        s.checks.push(articleId + ':' + userId); return s.access;
      };
      export const requireArticleReadAccess = async () => {};
      export const requireArticleWriteAccess = async () => {};
    `,
    externalAnalysisQueue: 'export const getExternalAnalysisSupabaseAdmin = () => s.client;',
    contentWritingAutomation: `
      export const isContentWritingAutomationSchemaUnavailableError = () => false;
      export const readContentWritingAutomationSettings = async () => ({ enabled: true, minimumCompetitors: 1 });
    `,
  };
  try {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('../api/contentWritingAutomation.ts', import.meta.url))],
      bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false,
      plugins: [{
        name: 'isolated-writing-overview',
        setup(plugin) {
          plugin.onResolve({ filter: /.*/ }, args => {
            if (args.kind === 'entry-point') return undefined;
            const name = args.path.split('/').pop()!.replace(/\.ts$/, '');
            return name in stubs ? { path: name, namespace: 'overview-test' } : undefined;
          });
          plugin.onLoad({ filter: /.*/, namespace: 'overview-test' }, args => ({
            contents: `const s = globalThis[${JSON.stringify(stateKey)}];\n${stubs[args.path]}`,
            loader: 'js',
          }));
        },
      }],
    });
    const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    return { handler: module.default, checks, articleId, itemId, sessionReads };
  } finally {
    delete (globalThis as any)[stateKey];
  }
};

test('writing overview returns the last accessible item title and error after checking article access', async () => {
  const api = await loadOverviewApi('read');
  const response = await api.handler({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: { action: 'status' },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.overview.lastItem.articleTitle, 'أغلى جهاز كشف الذهب في العالم');
  assert.equal(payload.overview.lastItem.lastErrorCode, 'gemini_http_429');
  assert.equal(payload.overview.state.lastItemId, api.itemId);
  assert.deepEqual(api.checks, [`${api.articleId}:viewer`]);
  assert.equal(api.sessionReads.length, 1);
});

test('writing failure resolves only through a later completed nonempty session on the same accessible article', async () => {
  for (const completedAt of ['2026-09-02T09:00:00Z', '2026-09-02T11:00:00Z']) {
    const api = await loadOverviewApi('read', completedAt);
    const response = await api.handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { action: 'status' } });
    const payload = await response.json();
    assert.equal(Boolean(payload.overview.lastItem.resolvedBySessionId), completedAt.includes('11:00'));
    assert.deepEqual(api.sessionReads, [{ article_id: api.articleId, status: 'completed', result_text: '', completed_at: '2026-09-02T10:00:00Z' }]);
  }
});

test('writing overview never exposes another users inaccessible last item or failure', async () => {
  const api = await loadOverviewApi('none');
  const response = await api.handler({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: { action: 'status' },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.overview.lastItem, null);
  assert.equal(payload.overview.state.lastItemId, null);
  assert.equal(payload.overview.state.lastArticleId, null);
  assert.equal(payload.overview.state.lastOutcome, null);
  assert.deepEqual(api.checks, [`${api.articleId}:viewer`]);
  assert.equal(api.sessionReads.length, 0);
});

test('automatic writing readiness exposes every administrator prerequisite in plain Arabic', async () => {
  const client = await readWorkspaceFile('utils/contentWritingAutomation.ts');
  for (const code of [
    'draft_status',
    'article_editor_empty',
    'article_title',
    'primary_keyword',
    'alternative_keywords',
    'lsi_keywords',
    'company_name',
    'goal_context.pageType',
    'goal_context.objective',
    'goal_context.audienceScope',
    'goal_context.searchIntent',
    'competitors',
  ]) {
    assert.match(client, new RegExp(code.replace('.', '\\.')));
  }
  assert.match(client, /company_name: \['اسم الشركة'/);
});

test('automatic writing is a durable one-at-a-time server queue with cooldown and retries', async () => {
  const [migration, scheduler, worker, routeRegistry, API, panel] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260823010000_automatic_content_writing_queue.sql'),
    readWorkspaceFile('server/contentWritingAutomation.ts'),
    readWorkspaceFile('server/contentWritingWorker.ts'),
    readWorkspaceFile('server/apiRouteRegistry.ts'),
    readWorkspaceFile('api/contentWritingAutomation.ts'),
    readWorkspaceFile('components/ContentWritingAutomationArticleStatus.tsx'),
  ]);

  assert.match(migration, /content_writing_automation_items/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /next_allowed_at/);
  assert.match(migration, /run_generation = item\.run_generation \+ 1/);
  assert.match(migration, /attempt_count < existing\.max_attempts/);
  assert.match(migration, /content_writing_sessions[\s\S]*status in \('queued', 'running', 'retry_scheduled'\)/);
  assert.match(migration, /ai_external_analysis_jobs[\s\S]*full_article_pipeline/);
  assert.match(migration, /sync_content_writing_automation_session_status/);
  assert.match(migration, /reconcile_content_writing_automation_session/);
  assert.match(migration, /v_session\.last_error_code, ''\) = 'content_writing_cancelled'/);
  assert.match(migration, /session_sequence integer not null default 1/);
  assert.match(migration, /reserve_article_for_explicit_content_writing/);
  assert.match(scheduler, /auto-ready:\$\{item\.id\}:\$\{Math\.max\(1, item\.run_generation\)\}:\$\{Math\.max\(1, item\.session_sequence\)\}/);
  assert.match(scheduler, /automationReviewPolicy: 'review_only'/);
  assert.match(worker, /beforeClaim:[\s\S]*scheduleNextAutomaticContentWritingSession/);
  assert.match(routeRegistry, /\/api\/content-writing\/automation/);
  assert.match(API, /list_content_writing_automation_candidates/);
  assert.match(panel, /قائمة التحقق/);
});

test('automatic writing requires an empty saved editor and cancels invalid active work', async () => {
  const [migration, client] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260830030000_automatic_content_writing_empty_editor_guard.sql'),
    readWorkspaceFile('utils/contentWritingAutomation.ts'),
  ]);

  assert.match(migration, /article_editor_has_text\(v_article\.plain_text\)/);
  assert.match(migration, /jsonb_build_array\('article_editor_empty'\)/);
  assert.match(migration, /before insert on public\.content_writing_sessions/);
  assert.match(migration, /Automatic content writing requires an empty article editor/);
  assert.match(migration, /cancel_requested_at = coalesce\(session\.cancel_requested_at, now\(\)\)/);
  assert.match(client, /article_editor_empty: \['المحرر خالٍ من نص سابق'/);
});

test('manual writing and the full workflow explicitly arbitrate with the automatic queue', async () => {
  const [manualAPI, fullPipelineAPI, engine] = await Promise.all([
    readWorkspaceFile('api/contentWriting.ts'),
    readWorkspaceFile('api/externalAnalysis.ts'),
    readWorkspaceFile('server/contentWritingEngine.ts'),
  ]);
  assert.match(manualAPI, /reserveArticleForExplicitContentWriting/);
  assert.match(manualAPI, /intent: 'manual'/);
  assert.match(fullPipelineAPI, /reserveArticleForExplicitContentWriting/);
  assert.match(fullPipelineAPI, /intent: input\.resume \? 'full_pipeline_resume' : 'full_pipeline'/);
  assert.match(engine, /contextSnapshotPatch/);
});

test('Write article durably discovers and extracts competitor prose before queuing writing', async () => {
  const [
    migration,
    executor,
    worker,
    ecosystem,
    manualAPI,
    browserClient,
    scheduler,
    guide,
    competitorCoordinator,
  ] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260823020000_content_writing_competitor_preparation.sql'),
    readWorkspaceFile('server/contentWritingCompetitorPreparationExecutor.ts'),
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
    readWorkspaceFile('ecosystem.config.cjs'),
    readWorkspaceFile('api/contentWriting.ts'),
    readWorkspaceFile('utils/contentWritingSessions.ts'),
    readWorkspaceFile('server/contentWritingAutomation.ts'),
    readWorkspaceFile('constants/userGuide.ts'),
    readWorkspaceFile('server/competitorPreparationCoordinator.ts'),
  ]);

  assert.match(migration, /content_writing_preparation/);
  assert.match(migration, /enqueue_content_writing_competitor_preparation/);
  assert.match(migration, /enqueue_next_automatic_writing_competitor_preparation/);
  assert.match(migration, /missingFields[\s\S]*competitors/);
  assert.match(executor, /enqueueCompetitorPreparationDiscovery/);
  assert.match(executor, /enqueueCompetitorPreparationExtraction/);
  assert.match(executor, /selectCompetitorPreparationSources/);
  assert.match(competitorCoordinator, /origin === 'auto'[\s\S]*enqueue_competitor_discovery_job_controlled[\s\S]*enqueue_competitor_discovery_job/);
  assert.match(competitorCoordinator, /enqueue_competitor_extraction_job_controlled/);
  assert.match(competitorCoordinator, /enqueue_competitor_extraction_job/);
  assert.match(competitorCoordinator, /selectedQualifications/);
  assert.match(executor, /queueContentWritingSession/);
  assert.match(executor, /readCurrentPreparationIntent/);
  assert.match(worker, /contentWritingCompetitorPreparationExecutor/);
  assert.match(ecosystem, /bazarvan-content-writing-preparation-worker/);
  assert.match(ecosystem, /EXTERNAL_ANALYSIS_WORKER_JOB_TYPES: 'content_writing_preparation'/);
  assert.match(manualAPI, /action === 'getPreparation'/);
  assert.match(manualAPI, /preparingCompetitors: true/);
  assert.match(browserClient, /onPreparationProgress/);
  assert.match(scheduler, /enqueueNextAutomaticCompetitorPreparation/);
  assert.match(guide, /لا تبدأ الكتابة قبل وجود نص منافس فعلي/);
});
