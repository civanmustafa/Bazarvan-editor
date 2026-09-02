import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDashboardAutomationOperations,
  countDashboardAutomationIssues,
} from '../utils/dashboardAutomationQueue.ts';
import type { ContentWritingAutomationItem, ContentWritingAutomationOverview } from '../utils/contentWritingAutomation.ts';
import type { UserAutomationPreferences } from '../constants/userAutomation.ts';
import type { ExternalAnalysisJobRow, ExternalAnalysisJobStatus } from '../utils/externalAnalysis.ts';

const automationDefaults: UserAutomationPreferences = {
  schemaVersion: 1,
  enabled: true,
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

const job = (overrides: Partial<ExternalAnalysisJobRow> = {}): ExternalAnalysisJobRow => ({
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
      lastItem: null,
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

const readySnapshot = {
  title: 'أغلى جهاز كشف الذهب في العالم',
  alternativeKeywordsReady: true,
  lsiKeywordsReady: true,
  googleMetadataReady: true,
};

const semanticOptions = (
  status: ExternalAnalysisJobStatus = 'failed',
): Parameters<typeof buildDashboardAutomationOperations>[0] => ({
  summaries: {
    'article-1': {
      ...summary,
      latestAutomaticSemanticJob: job({
        status,
        last_error_code: 'gemini_http_429',
        last_error: 'Provider quota exhausted',
      }),
    } as any,
  },
  writingOverview: null,
  effectivePreferences: automationDefaults,
  articleTitles: { 'article-1': readySnapshot.title },
});

test('current saved semantic results resolve historical failures independently for every stage', () => {
  const operations = buildDashboardAutomationOperations({
    ...semanticOptions(),
    articleSnapshots: { 'article-1': readySnapshot },
  });
  for (const operation of operations.slice(0, 3)) {
    assert.equal(operation.status, 'completed');
    assert.equal(operation.failedCount, 0);
    assert.equal(operation.completedCount, 1);
    assert.equal(operation.errorMessage, '');
    assert.equal(operation.latestJobStatus, 'resolved_current_state');
    assert.equal(operation.articleTitle, readySnapshot.title);
  }
  assert.equal(countDashboardAutomationIssues(operations), 0);
});

test('only missing semantic stages remain failed, and shared failures count once per job', () => {
  const options = semanticOptions();
  const operations = buildDashboardAutomationOperations({
    ...options,
    summaries: {
      ...options.summaries,
      'article-2': {
        ...summary,
        articleId: 'article-2',
        latestAutomaticSemanticJob: job({ id: 'job-2', article_id: 'article-2', status: 'failed' }),
      } as any,
    },
    articleSnapshots: { 'article-1': { ...readySnapshot, googleMetadataReady: false } },
  });
  assert.equal(operations[0].failedCount, 1);
  assert.equal(operations[1].failedCount, 1);
  assert.equal(operations[2].failedCount, 2);
  assert.equal(countDashboardAutomationIssues(operations), 2);
});

test('an unresolved failure points to its article, not a newer successful article', () => {
  const options = semanticOptions();
  const operations = buildDashboardAutomationOperations({
    ...options,
    summaries: {
      ...options.summaries,
      'article-2': {
        ...summary,
        articleId: 'article-2',
        latestAutomaticSemanticJob: job({
          id: 'job-2', article_id: 'article-2', status: 'completed', updated_at: '2026-09-02T12:00:00Z',
        }),
      } as any,
    },
  });
  assert.equal(operations[0].articleId, 'article-1');
  assert.equal(operations[0].errorCode, 'gemini_http_429');
  assert.equal(operations[0].errorMessage, 'Provider quota exhausted');
});

test('current results do not conceal a genuinely running or retrying job', () => {
  for (const status of ['running', 'retry_scheduled'] as const) {
    const operations = buildDashboardAutomationOperations({
      ...semanticOptions(status),
      articleSnapshots: { 'article-1': readySnapshot },
    });
    assert.equal(operations[0].status, status === 'running' ? 'running' : 'waiting');
    assert.equal(operations[0].completedCount, 0);
    assert.equal(operations[0].failedCount, 0);
  }
});

test('saved results are visible even without an automatic semantic job', () => {
  const operations = buildDashboardAutomationOperations({
    ...semanticOptions(),
    summaries: {},
    articleSnapshots: { 'article-1': readySnapshot },
  });
  assert.equal(operations[0].status, 'completed');
  assert.equal(operations[0].articleTitle, readySnapshot.title);
});

test('a cancelled semantic job is not reported as an unresolved provider failure', () => {
  const operations = buildDashboardAutomationOperations(semanticOptions('cancelled'));
  assert.equal(operations[0].failedCount, 0);
  assert.equal(countDashboardAutomationIssues(operations), 0);
});

test('ready competitor texts resolve old extraction failures without hiding active extraction', () => {
  const options = semanticOptions('completed');
  const operations = buildDashboardAutomationOperations({
    ...options,
    summaries: {
      'article-1': {
        ...summary,
        competitorReadyCount: 5,
        latestAutomaticCompetitorExtractionJob: job({ job_type: 'competitor_extraction', status: 'failed' }),
      } as any,
    },
  });
  assert.equal(operations[4].status, 'completed');
  assert.equal(operations[4].failedCount, 0);
});

const writingOverview = (lastItem: ContentWritingAutomationItem | null): ContentWritingAutomationOverview => ({
  schemaAvailable: true,
  settings: {
    enabled: true, intervalMinutes: 15, provider: 'gemini', model: '', minimumCompetitors: 1,
    requireCompetitorTerminalState: true, maxAttempts: 3, retryMinutes: 15,
  },
  state: {
    nextAllowedAt: '', lastItemId: 'writing-1', lastArticleId: 'article-1',
    lastSessionId: null, lastOutcome: 'failed', updatedAt: '',
  },
  active: null,
  lastItem,
  globalBlocker: null,
  candidates: [],
});

const writingItem = (status: ContentWritingAutomationItem['status']): ContentWritingAutomationItem => ({
  id: 'writing-1', articleId: 'article-1', articleTitle: readySnapshot.title, articleStatus: 'draft',
  requestedBy: 'user-1', status, readinessSignature: '', usableCompetitorCount: 2,
  pendingCompetitorCount: 0, provider: 'gemini', model: 'test-model', sessionId: null,
  sessionStatus: null, qualityScore: null, qualityPassed: null, attemptCount: 3, maxAttempts: 3,
  readyAt: '', eligibleAt: '', startedAt: null, completedAt: null,
  lastErrorCode: 'gemini_http_429', lastError: 'Provider quota exhausted', updatedAt: '',
});

test('writing shows the accessible item title and exact unresolved error, not a global old outcome', () => {
  const options = { ...semanticOptions('completed'), summaries: {}, articleTitles: {} };
  const blocked = buildDashboardAutomationOperations({
    ...options, writingOverview: writingOverview(writingItem('blocked')),
  })[6];
  assert.equal(blocked.status, 'attention');
  assert.equal(blocked.articleTitle, readySnapshot.title);
  assert.equal(blocked.errorCode, 'gemini_http_429');
  assert.equal(blocked.errorMessage, 'Provider quota exhausted');
  assert.equal(countDashboardAutomationIssues([blocked]), 1);

  for (const status of ['completed', 'cancelled', 'ready'] as const) {
    const current = buildDashboardAutomationOperations({
      ...options, writingOverview: writingOverview(writingItem(status)),
    })[6];
    assert.equal(current.failedCount, 0);
    assert.equal(current.errorMessage, '');
    assert.equal(countDashboardAutomationIssues([current]), 0);
  }

  const unavailable = buildDashboardAutomationOperations({
    ...options, writingOverview: writingOverview(null),
  })[6];
  assert.equal(unavailable.failedCount, 0);
});

test('disabled stages do not contribute issues to the attention badge', () => {
  const operations = buildDashboardAutomationOperations({
    ...semanticOptions(),
    effectivePreferences: {
      ...automationDefaults, autoGenerateAlternativeKeywords: false,
      autoGenerateLsiKeywords: false, autoGenerateGoogleMetadata: false,
    },
  });
  assert.equal(countDashboardAutomationIssues(operations), 0);
});

test('manual Google-only work does not run or complete missing alternatives and LSI', () => {
  const options = semanticOptions('failed');
  const manual = job({ origin: 'manual', status: 'completed',
    input_snapshot: { needsSecondaries: false, needsLsi: false, needsGoogleMetadata: true } });
  const operations = buildDashboardAutomationOperations({ ...options,
    summaries: { 'article-1': { ...summary, latestSemanticJob: manual } as any },
    articleSnapshots: { 'article-1': { ...readySnapshot, alternativeKeywordsReady: false, lsiKeywordsReady: false } },
  });
  assert.equal(operations[0].status, 'ready');
  assert.equal(operations[1].completedCount, 0);
  assert.equal(operations[2].status, 'completed');
  assert.equal(operations[2].errorMessage, '');
});

test('a completed job without saved Google results is not reported as successful generation', () => {
  const operations = buildDashboardAutomationOperations({ ...semanticOptions('completed'),
    articleSnapshots: { 'article-1': { ...readySnapshot, googleMetadataReady: false } },
  });
  assert.equal(operations[2].completedCount, 0);
});

test('engineering recognizes canonical manual success but retains an unrelated command failure', () => {
  const operations = buildDashboardAutomationOperations({ ...semanticOptions(),
    summaries: { 'article-1': { ...summary,
      currentEngineeringJobs: [
        job({ id: 'manual-ok', job_type: 'engineering_command', command_id: 'one', origin: 'manual', status: 'completed' }),
        job({ id: 'auto-failed', job_type: 'engineering_command', command_id: 'two', status: 'failed', last_error: 'still unresolved' }),
      ],
    } as any },
  });
  const operation = operations[5];
  assert.equal(operation.completedCount, 1);
  assert.equal(operation.failedCount, 1);
  assert.equal(operation.errorMessage, 'still unresolved');
  assert.deepEqual(operation.issueIds, ['external:auto-failed']);
});

test('writing retry exposes attempts and the later of item eligibility and global cooldown', () => {
  const item = { ...writingItem('ready'), attemptCount: 1, eligibleAt: '2026-09-02T11:00:00Z' };
  const overview = writingOverview(item);
  overview.state!.nextAllowedAt = '2026-09-02T11:15:00Z';
  overview.candidates = [{ articleId: item.articleId, articleTitle: item.articleTitle,
    itemId: item.id, eligibleAt: item.eligibleAt } as any];
  const operation = buildDashboardAutomationOperations({ ...semanticOptions(), writingOverview: overview })[6];
  assert.equal(operation.status, 'waiting');
  assert.equal(operation.retryScheduled, true);
  assert.equal(operation.retryAt, '2026-09-02T11:15:00.000Z');
  assert.equal(operation.attemptCount, 1);
  assert.equal(operation.maxAttempts, 3);
  assert.equal(operation.failedCount, 0);
  assert.equal(operation.errorMessage, '');
});

test('exhausted writing attempts stay blocked until a verified later session completes', () => {
  const item = writingItem('blocked');
  const buildWriting = () => buildDashboardAutomationOperations({
    ...semanticOptions(), writingOverview: writingOverview(item),
  })[6];
  assert.equal(buildWriting().attemptsExhausted, true);
  item.resolvedBySessionId = 'completed-manual-session';
  item.resolvedAt = '2026-09-02T12:00:00Z';
  const completed = buildWriting();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.errorMessage, '');
  assert.equal(completed.retryScheduled, false);
  assert.deepEqual(completed.issueIds, []);
});

test('a different active article never inherits the last failed articles attempt counts', () => {
  const overview = writingOverview(writingItem('blocked'));
  overview.active = { ...writingItem('writing'), id: 'writing-2', articleId: 'article-2', articleTitle: 'Active title', attemptCount: 1 };
  const operation = buildDashboardAutomationOperations({ ...semanticOptions(), writingOverview: overview })[6];
  assert.equal(operation.articleTitle, 'Active title');
  assert.equal(operation.attemptCount, 1);
  assert.equal(operation.attemptsExhausted, false);
});

test('saved manual writing and currently applied internal links complete their own cards', () => {
  const operations = buildDashboardAutomationOperations({ ...semanticOptions(), summaries: { 'article-1': {
    ...summary, savedInternalLinkCount: 2,
    completedWritingSession: { id: 'session-1', completedAt: '2026-09-02T12:00:00Z' },
  } as any } });
  assert.equal(operations[6].completedCount, 1);
  assert.equal(operations[6].articleId, 'article-1');
  assert.equal(operations[7].status, 'completed');
  assert.equal(operations[7].completedLinkCount, 2);
});

test('historical completed tasks do not stand in for competitor texts or links that were removed', () => {
  const operations = buildDashboardAutomationOperations({ ...semanticOptions(), summaries: { 'article-1': {
    ...summary, savedInternalLinkCount: 0, competitorReadyCount: 0, competitorTotalCount: 0,
    latestCompetitorExtractionJob: job({ job_type: 'competitor_extraction', status: 'completed' }),
  } as any } });
  assert.equal(operations[3].completedCount, 0);
  assert.equal(operations[4].completedCount, 0);
  assert.equal(operations[7].status, 'ready');
});
