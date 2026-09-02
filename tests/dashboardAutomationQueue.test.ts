import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDashboardAutomationOperations } from '../utils/dashboardAutomationQueue.ts';

const automationDefaults = {
  autoGenerateAlternativeKeywords: true,
  autoGenerateLsiKeywords: true,
  autoGenerateGoogleMetadata: true,
  autoDiscoverCompetitors: true,
  autoExtractCompetitorContent: true,
  autoRunReadyEngineeringCommands: true,
  externalAnalysisCommandIds: [],
  contentWritingAutomationEnabled: true,
  autoApplyStrongInternalLinkSuggestions: true,
};

const job = (overrides: Record<string, unknown> = {}) => ({
  id: 'job-1',
  article_id: 'article-1',
  job_type: 'semantic_keywords_lsi',
  origin: 'auto',
  status: 'running',
  batch_key: null,
  sequence_number: 1,
  command_id: null,
  command_label: null,
  readiness_signature: null,
  progress: {},
  result: null,
  last_error: null,
  last_error_code: null,
  attempt_count: 1,
  retry_count: 0,
  next_attempt_at: null,
  cancel_requested_at: null,
  started_at: '2026-09-02T10:00:00.000Z',
  completed_at: null,
  created_at: '2026-09-02T10:00:00.000Z',
  updated_at: '2026-09-02T10:01:00.000Z',
  ...overrides,
});

const summary = {
  articleId: 'article-1',
  latestAutomaticSemanticJob: job(),
  latestAutomaticCompetitorDiscoveryJob: job({
    id: 'discovery',
    job_type: 'competitor_discovery',
    status: 'completed',
  }),
  latestAutomaticCompetitorExtractionJob: job({
    id: 'extraction',
    job_type: 'competitor_extraction',
    status: 'retry_scheduled',
  }),
  latestAutomaticEngineeringJob: job({
    id: 'engineering',
    job_type: 'engineering_command',
    status: 'running',
  }),
  activeAutomaticEngineeringCount: 2,
  runningAutomaticEngineeringCount: 1,
  waitingAutomaticEngineeringCount: 1,
  completedAutomaticEngineeringCount: 3,
  retryingAutomaticEngineeringCount: 1,
  competitorReadyCount: 3,
  competitorTotalCount: 5,
};

test('dashboard automation queue exposes every user-controlled automation stage', () => {
  const operations = buildDashboardAutomationOperations({
    summaries: { 'article-1': summary as any },
    writingOverview: {
      schemaAvailable: true,
      settings: {
        enabled: true,
        intervalMinutes: 15,
        provider: 'gemini',
        model: '',
        minimumCompetitors: 2,
        requireCompetitorTerminalState: true,
        maxAttempts: 3,
        retryMinutes: 15,
      },
      state: null,
      active: null,
      globalBlocker: null,
      candidates: [],
    },
    effectivePreferences: automationDefaults,
    articleTitles: { 'article-1': 'عنوان المقالة' },
  });

  assert.deepEqual(operations.map(operation => operation.key), [
    'alternative_keywords',
    'lsi_keywords',
    'google_metadata',
    'competitor_discovery',
    'competitor_extraction',
    'external_analysis',
    'content_writing',
    'internal_linking',
  ]);
  assert.equal(operations.find(operation => operation.key === 'alternative_keywords')?.status, 'running');
  assert.equal(operations.find(operation => operation.key === 'competitor_discovery')?.status, 'completed');
  assert.equal(operations.find(operation => operation.key === 'competitor_extraction')?.status, 'waiting');
  assert.deepEqual(
    operations.find(operation => operation.key === 'competitor_extraction')?.readyItemCount,
    3,
  );
  assert.equal(operations.find(operation => operation.key === 'external_analysis')?.runningCount, 1);
  assert.equal(operations.find(operation => operation.key === 'external_analysis')?.waitingCount, 1);
  assert.equal(operations.find(operation => operation.key === 'internal_linking')?.status, 'ready');
});

test('a disabled automation remains visible instead of disappearing from the queue', () => {
  const operations = buildDashboardAutomationOperations({
    summaries: {},
    writingOverview: null,
    effectivePreferences: {
      ...automationDefaults,
      autoDiscoverCompetitors: false,
      autoApplyStrongInternalLinkSuggestions: false,
    },
    articleTitles: {},
  });

  assert.equal(operations.length, 8);
  assert.equal(operations.find(operation => operation.key === 'competitor_discovery')?.status, 'disabled');
  assert.equal(operations.find(operation => operation.key === 'internal_linking')?.status, 'disabled');
});
