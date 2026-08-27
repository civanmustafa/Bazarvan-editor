import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('automatic writing readiness exposes every administrator prerequisite in plain Arabic', async () => {
  const client = await readWorkspaceFile('utils/contentWritingAutomation.ts');
  for (const code of [
    'draft_status',
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
  ] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260823020000_content_writing_competitor_preparation.sql'),
    readWorkspaceFile('server/contentWritingCompetitorPreparationExecutor.ts'),
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
    readWorkspaceFile('ecosystem.config.cjs'),
    readWorkspaceFile('api/contentWriting.ts'),
    readWorkspaceFile('utils/contentWritingSessions.ts'),
    readWorkspaceFile('server/contentWritingAutomation.ts'),
    readWorkspaceFile('constants/userGuide.ts'),
  ]);

  assert.match(migration, /content_writing_preparation/);
  assert.match(migration, /enqueue_content_writing_competitor_preparation/);
  assert.match(migration, /enqueue_next_automatic_writing_competitor_preparation/);
  assert.match(migration, /missingFields[\s\S]*competitors/);
  assert.match(executor, /origin === 'auto'[\s\S]*enqueue_competitor_discovery_job_controlled[\s\S]*enqueue_competitor_discovery_job/);
  assert.match(executor, /enqueue_competitor_extraction_job/);
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
