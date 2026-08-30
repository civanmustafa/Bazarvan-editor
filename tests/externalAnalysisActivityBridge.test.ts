import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ExternalAnalysisJobRow } from '../utils/externalAnalysis.ts';
import {
  getAiExecutionActivities,
  resetAiExecutionActivitiesForTests,
  type AiExecutionActivity,
  updateAiExecutionActivity,
} from '../utils/aiExecutionActivity.ts';
import { projectExternalAnalysisActivity } from '../utils/externalAnalysisActivityBridge.ts';
import {
  isEditorAiExecutionActivity,
  mergeEditorAiExecutionIntoHistory,
} from '../utils/aiHistoryActivity.ts';
import {
  filterExternalAnalysisJobs,
  getExternalAnalysisJobTypeLabel,
  groupExternalAnalysisJobs,
} from '../utils/externalAnalysisPresentation.ts';

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

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const createActivity = (
  overrides: Partial<AiExecutionActivity> = {},
): AiExecutionActivity => ({
  id: 'gemini:operation-1',
  articleId: 'article-1',
  articleTitle: 'عنوان المقالة',
  articleKey: 'article-key-1',
  commandId: '',
  provider: 'gemini',
  requestedProvider: 'gemini',
  model: 'gemini-3.6-flash',
  requestedModel: 'gemini-3.6-flash',
  credentialTier: 'free',
  state: 'running',
  stage: 'queued',
  surface: 'smart_analysis',
  action: 'تحليل المقالة',
  message: 'جار التحليل',
  keySuffix: '',
  cancellable: false,
  entries: [],
  startedAt: '2026-08-30T08:00:00.000Z',
  updatedAt: '2026-08-30T08:00:01.000Z',
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

test('automatic meta description generation uses its own unified activity surface', () => {
  const metaDescription = projectExternalAnalysisActivity(createJob({
    id: 'job-meta-description',
    job_type: 'meta_description_generation',
    command_id: null,
    progress: { stage: 'generating_meta_description' },
  }), 'عنوان المقالة');

  assert.equal(metaDescription.surface, 'meta_description_generation');
  assert.equal(metaDescription.provider, 'gemini');
  assert.equal(metaDescription.stage, 'generating_meta_description');
});

test('external analysis presentation keeps every known and future job type visible', () => {
  const jobs = [
    createJob({ id: 'semantic', job_type: 'semantic_keywords_lsi', batch_key: null, status: 'completed' }),
    createJob({ id: 'meta', job_type: 'meta_description_generation', batch_key: null, status: 'running' }),
    createJob({ id: 'extraction', job_type: 'competitor_extraction', batch_key: null, status: 'queued' }),
    createJob({ id: 'future', job_type: 'future_analysis_type', batch_key: null, status: 'failed' }),
  ];

  assert.equal(filterExternalAnalysisJobs(jobs, 'all').length, 4);
  assert.deepEqual(filterExternalAnalysisJobs(jobs, 'active').map(job => job.id), ['meta', 'extraction']);
  assert.deepEqual(filterExternalAnalysisJobs(jobs, 'completed').map(job => job.id), ['semantic']);
  assert.equal(groupExternalAnalysisJobs(jobs).length, 4);
  assert.equal(getExternalAnalysisJobTypeLabel('meta_description_generation', 'ar'), 'كتابة وصف الميتا');
  assert.equal(getExternalAnalysisJobTypeLabel('future_analysis_type', 'en'), 'future analysis type');
});

test('editor history accepts scoped local operations and rejects external, unrelated, or unscoped work', () => {
  const identity = {
    articleScope: 'article-1',
    articleId: 'article-1',
    articleKey: 'article-key-1',
  };

  assert.equal(isEditorAiExecutionActivity(createActivity(), identity), true);
  assert.equal(isEditorAiExecutionActivity(createActivity({ articleId: 'article-2' }), identity), false);
  assert.equal(isEditorAiExecutionActivity(createActivity({ articleId: '', articleKey: '' }), identity), false);
  assert.equal(isEditorAiExecutionActivity(createActivity({ id: 'external-analysis:job-1' }), identity), false);
  assert.equal(isEditorAiExecutionActivity(createActivity({ surface: 'automatic_content_writing' }), identity), false);
  assert.equal(isEditorAiExecutionActivity(createActivity({ articleId: '', articleKey: 'article-key-1' }), identity), true);
});

test('editor execution lifecycle upserts one durable history item through completion', () => {
  const identity = {
    articleScope: 'article-1',
    articleId: 'article-1',
    articleKey: 'article-key-1',
  };
  const running = createActivity();
  const initial = mergeEditorAiExecutionIntoHistory([], running, identity);
  const completed = mergeEditorAiExecutionIntoHistory(initial, createActivity({
    state: 'success',
    stage: 'completed',
    message: 'اكتمل التحليل',
    updatedAt: '2026-08-30T08:00:05.000Z',
    completedAt: '2026-08-30T08:00:05.000Z',
  }), identity);

  assert.equal(initial.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].id, 'ai-execution:gemini:operation-1');
  assert.equal(completed[0].execution?.state, 'success');
  assert.equal(completed[0].execution?.message, 'اكتمل التحليل');
});

test('editor UI wires the all-type external feed and the durable local execution history', async () => {
  const [externalClient, externalTab, aiContext, historyTab] = await Promise.all([
    readWorkspaceFile('utils/externalAnalysis.ts'),
    readWorkspaceFile('components/ExternalAnalysisResultsTab.tsx'),
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('components/AIHistoryTab.tsx'),
  ]);

  assert.match(externalClient, /job_type: normalizeExternalAnalysisJobType\(row\.job_type\)/);
  assert.match(externalTab, /const rows = await listExternalAnalysisJobs\(articleId\)/);
  assert.doesNotMatch(externalTab, /competitor_extraction['"],\s*['"]content_writing_preparation/);
  assert.match(externalTab, /جميع التحليلات الخارجية/);
  assert.match(aiContext, /window\.addEventListener\(AI_EXECUTION_ACTIVITY_EVENT, handleActivity\)/);
  assert.match(aiContext, /mergeEditorAiExecutionIntoHistory/);
  assert.match(historyTab, /data-ai-history-kind="execution"/);
});
