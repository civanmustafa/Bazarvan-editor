import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExternalAnalysisJobRow } from '../utils/externalAnalysis.ts';
import {
  getAiExecutionActivities,
  resetAiExecutionActivitiesForTests,
  updateAiExecutionActivity,
} from '../utils/aiExecutionActivity.ts';
import { projectExternalAnalysisActivity } from '../utils/externalAnalysisActivityBridge.ts';

const createJob = (
  overrides: Partial<ExternalAnalysisJobRow> = {},
): ExternalAnalysisJobRow => ({
  id: 'job-3',
  article_id: 'article-1',
  job_type: 'engineering_command',
  origin: 'auto',
  status: 'running',
  batch_key: 'batch-1',
  sequence_number: 2,
  command_id: 'smartAnalysis.competitorContentComparison',
  command_label: 'تحليل المنافسين الشامل',
  readiness_signature: 'ready',
  input_snapshot: {},
  result: null,
  progress: {
    stage: 'gemini_attempting',
    message: 'جار تحليل المنافس 3 بصورة مستقلة (3/5).',
    competitorCurrent: 3,
    competitorTotal: 5,
    gemini: {
      stage: 'attempting',
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      currentModelIndex: 1,
      modelCount: 4,
      currentKeyIndex: 1,
      keyCount: 13,
      keySuffix: 'YbAY',
      completed: false,
    },
  },
  last_error: null,
  last_error_code: null,
  attempt_count: 1,
  retry_count: 0,
  next_attempt_at: null,
  cancel_requested_at: null,
  started_at: '2026-07-27T08:00:00.000Z',
  completed_at: null,
  created_at: '2026-07-27T07:59:00.000Z',
  updated_at: '2026-07-27T08:01:00.000Z',
  ...overrides,
});

test('running external competitor analysis projects into the unified live activity', () => {
  const projection = projectExternalAnalysisActivity(createJob(), 'عنوان المقالة');

  assert.equal(projection.activityId, 'external-analysis:job-3');
  assert.equal(projection.articleTitle, 'عنوان المقالة');
  assert.equal(projection.state, 'running');
  assert.equal(projection.stage, 'attempting');
  assert.equal(projection.surface, 'competitor_comparison_map');
  assert.equal(projection.model, 'gemini-3.6-flash');
  assert.equal(projection.currentKeyIndex, 1);
  assert.equal(projection.keyCount, 13);
  assert.equal(projection.keySuffix, 'YbAY');
  assert.match(projection.message, /المنافس 3/);
});

test('projected external progress populates the same activity store used by the unified bar', () => {
  resetAiExecutionActivitiesForTests();
  const projection = projectExternalAnalysisActivity(createJob(), 'عنوان المقالة');
  const {
    activityId,
    fingerprint: _fingerprint,
    outcome: _outcome,
    ...activity
  } = projection;

  updateAiExecutionActivity(activityId, {
    ...activity,
    state: 'running',
    completed: false,
  });

  const stored = getAiExecutionActivities()[0];
  assert.equal(stored.articleTitle, 'عنوان المقالة');
  assert.equal(stored.surface, 'competitor_comparison_map');
  assert.equal(stored.model, 'gemini-3.6-flash');
  assert.equal(stored.keySuffix, 'YbAY');
  assert.equal(stored.currentKeyIndex, 1);
  assert.equal(stored.keyCount, 13);
  resetAiExecutionActivitiesForTests();
});

test('terminal external jobs close the same unified activity with the correct outcome', () => {
  const completed = projectExternalAnalysisActivity(createJob({
    status: 'completed',
    progress: { stage: 'engineering_completed' },
    completed_at: '2026-07-27T08:03:00.000Z',
  }), 'عنوان المقالة');
  const failed = projectExternalAnalysisActivity(createJob({
    status: 'failed',
    progress: { stage: 'failed' },
    last_error: 'تعذر تنفيذ المهمة.',
  }), 'عنوان المقالة');

  assert.equal(completed.state, 'success');
  assert.equal(completed.outcome, 'success');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.message, 'تعذر تنفيذ المهمة.');
});

test('competitor discovery and content import use distinct unified activity surfaces', () => {
  const discovery = projectExternalAnalysisActivity(createJob({
    id: 'job-discovery',
    job_type: 'competitor_discovery',
    command_id: null,
    progress: {
      stage: 'searching_competitors',
      provider: 'firecrawl',
      current: 2,
      total: 10,
    },
  }), 'عنوان المقالة');
  const extraction = projectExternalAnalysisActivity(createJob({
    id: 'job-extraction',
    job_type: 'competitor_extraction',
    command_id: null,
    progress: {
      stage: 'extracting_competitor',
      current: 1,
      total: 5,
    },
  }), 'عنوان المقالة');

  assert.equal(discovery.surface, 'competitor_discovery');
  assert.equal(discovery.provider, 'firecrawl');
  assert.equal(discovery.stage, 'searching_competitors');
  assert.equal(extraction.surface, 'competitor_extraction');
  assert.equal(extraction.provider, 'crawler');
  assert.equal(extraction.stage, 'extracting_competitor');
});
