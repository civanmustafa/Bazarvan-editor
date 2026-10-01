import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildArticleAutomationStages } from '../utils/articleAutomationStages.ts';

const job = (status: string, overrides: Record<string, unknown> = {}) => ({
  id: `job-${status}`,
  article_id: 'article-1',
  job_type: 'semantic_keywords_lsi',
  origin: 'auto',
  status,
  batch_key: null,
  sequence_number: 0,
  command_id: null,
  command_label: null,
  readiness_signature: 'signature',
  result: null,
  progress: {},
  last_error: null,
  last_error_code: null,
  attempt_count: 0,
  max_attempts: 6,
  retry_count: 0,
  next_attempt_at: null,
  cancel_requested_at: null,
  started_at: null,
  completed_at: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
} as any);

test('article automation strip exposes all stages and prefers saved completion evidence', () => {
  const summary = {
    articleId: 'article-1',
    duplicateCleanup: { state: 'partial', completedCount: 4, totalCount: 7 },
    state: {
      external_analysis_effective_command_ids: ['audit-a', 'audit-b'],
    },
    latestSemanticJob: job('failed', { last_error: 'old failure' }),
    latestAutomaticSemanticJob: null,
    latestCompetitorDiscoveryJob: job('completed', {
      job_type: 'competitor_discovery',
      result: { results: [{ url: 'https://example.com' }] },
    }),
    latestAutomaticCompetitorDiscoveryJob: null,
    latestCompetitorExtractionJob: job('running', { job_type: 'competitor_extraction' }),
    latestAutomaticCompetitorExtractionJob: null,
    competitorReadyCount: 1,
    competitorTotalCount: 3,
    currentEngineeringJobs: [
      job('completed', { job_type: 'engineering_command', command_id: 'audit-a' }),
      job('queued', { job_type: 'engineering_command', command_id: 'audit-b' }),
    ],
    latestEngineeringJob: job('queued', { job_type: 'engineering_command', command_id: 'audit-b' }),
    savedInternalLinkCount: 2,
  } as any;
  const writing = {
    state: 'applied',
    workReadiness: {
      state: 'auditing', ready: false, cleanupCurrent: true, cleanupActive: false,
      cleanupFailed: false, requiredAuditCount: 2, completedAuditCount: 1,
      activeAuditCount: 0, failedAuditCount: 0,
    },
  } as any;

  const stages = buildArticleAutomationStages({
    summary,
    contentWritingSummary: writing,
    hasAlternativeKeywords: true,
    hasLsiKeywords: true,
    googleMetadataReady: true,
    locale: 'ar',
  });

  assert.equal(stages.length, 9);
  assert.equal(stages.find(stage => stage.key === 'alternative_keywords')?.status, 'completed');
  assert.equal(stages.find(stage => stage.key === 'lsi_keywords')?.status, 'completed');
  assert.equal(stages.find(stage => stage.key === 'google_metadata')?.status, 'completed');
  assert.equal(stages.find(stage => stage.key === 'competitor_discovery')?.status, 'completed');
  assert.equal(stages.find(stage => stage.key === 'competitor_extraction')?.status, 'partial');
  assert.equal(stages.find(stage => stage.key === 'external_analysis')?.status, 'waiting');
  assert.equal(stages.find(stage => stage.key === 'content_writing')?.status, 'completed');
  assert.match(stages.find(stage => stage.key === 'content_writing')?.details || '', /تنفيذ التدقيقات الخارجية/);
  assert.equal(stages.find(stage => stage.key === 'duplicate_suggestions')?.status, 'partial');
  assert.equal(stages.find(stage => stage.key === 'internal_linking')?.status, 'completed');
});

test('article card renders a compact tooltip workflow without the old visible counters', async () => {
  const [controls, dashboard] = await Promise.all([
    readFile(new URL('../components/ExternalAnalysisCardControls.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/Dashboard.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(controls, /aria-label=\{locale === 'ar' \? 'مسار أتمتة المقالة'/);
  assert.match(controls, /group-hover\/automation-stage:visible/);
  assert.match(controls, /getAutomationStage\('content_writing'\)/);
  assert.match(controls, /getAutomationStage\('duplicate_suggestions'\)/);
  assert.match(controls, /getAutomationStage\('internal_linking'\)/);
  assert.doesNotMatch(controls, /إعادة توليد الكل/);
  assert.doesNotMatch(controls, /المنافسون جاهزون/);
  assert.doesNotMatch(controls, /مهمة مكتملة/);
  assert.match(dashboard, /contentWritingSummary=\{contentWritingSummary\}/);
  assert.doesNotMatch(dashboard, /<ContentWritingSummaryChip/);
  assert.doesNotMatch(dashboard, /<DuplicateCleanupSummaryChip/);
});
