import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ExternalAnalysisJobRow } from '../utils/externalAnalysis.ts';
import {
  FULL_ARTICLE_PIPELINE_STAGES,
  formatPipelineDuration,
  getFullArticlePipelineProgressView,
} from '../utils/fullArticlePipelineProgress.ts';

const job = (patch: Partial<ExternalAnalysisJobRow> = {}): ExternalAnalysisJobRow => ({
  id: 'pipeline-job',
  article_id: 'article-id',
  job_type: 'full_article_pipeline',
  origin: 'manual',
  status: 'running',
  batch_key: null,
  sequence_number: 0,
  command_id: null,
  command_label: null,
  readiness_signature: null,
  input_snapshot: { provider: 'gemini', model: 'requested-model' },
  result: null,
  progress: {},
  last_error: null,
  last_error_code: null,
  attempt_count: 1,
  retry_count: 0,
  next_attempt_at: null,
  cancel_requested_at: null,
  started_at: '2026-08-24T12:00:00.000Z',
  completed_at: null,
  created_at: '2026-08-24T12:00:00.000Z',
  updated_at: '2026-08-24T12:01:00.000Z',
  ...patch,
});

test('full workflow stage contract reviews and repairs before safe insertion', () => {
  assert.deepEqual(FULL_ARTICLE_PIPELINE_STAGES.map(stage => stage.key), [
    'semantic_keywords_lsi',
    'content_brief_generation',
    'competitor_discovery',
    'competitor_extraction',
    'content_writing',
    'comprehensive_competitor_analysis',
    'article_application',
  ]);
});

test('pipeline progress uses one stage counter and exposes actual execution details', () => {
  const view = getFullArticlePipelineProgressView(job({
    progress: {
      stage: 'content_writing',
      stageIndex: 5,
      stageCount: 7,
      selectedCompetitorCount: 4,
      childProgress: {
        provider: 'gemini',
        model: 'actual-fallback-model',
        workflowStepLabel: 'Section 1',
        workflowStepIndex: 3,
        workflowStepCount: 11,
        workflowCompletedSteps: 2,
        candidateCount: 3,
        selectedCandidateIndex: 2,
      },
    },
  }), Date.parse('2026-08-24T12:02:05.000Z'));

  assert.equal(view.stageIndex, 5);
  assert.equal(view.stageCount, 7);
  assert.equal(view.requestedModel, 'requested-model');
  assert.equal(view.actualModel, 'actual-fallback-model');
  assert.equal(view.substage, 'Section 1');
  assert.equal(view.workflowStepCount, 11);
  assert.equal(view.candidateCount, 3);
  assert.equal(view.rejectedCandidateCount, 2);
  assert.equal(view.elapsedMs, 125_000);
  assert.equal(formatPipelineDuration(view.elapsedMs, false), '2m 5s');
});

test('quality block becomes review-required and clears stale retry reason', () => {
  const view = getFullArticlePipelineProgressView(job({
    status: 'blocked',
    last_error_code: 'full_pipeline_quality_review_required',
    last_error: 'Quality review is required.',
    progress: {
      stage: 'comprehensive_competitor_analysis',
      stageIndex: 6,
      stageCount: 7,
      retryReason: 'stale-old-retry',
      contentWritingSessionId: 'session-id',
      qualityReport: {
        score: 74,
        minimumScore: 85,
        passed: false,
        blockingFailureCount: 1,
        criteria: [{
          id: 'claims',
          title: 'Unsupported claims',
          status: 'fail',
          severity: 'blocking',
          messages: ['One claim needs a source.'],
        }, {
          id: 'non-blocking',
          title: 'Advisory failure',
          status: 'fail',
          severity: 'advisory',
          messages: ['Should not be shown as a blocking reason.'],
        }, {
          id: 'passing-blocker',
          title: 'Passing blocking check',
          status: 'pass',
          severity: 'blocking',
          messages: ['Should not be shown either.'],
        }],
      },
    },
  }));

  assert.equal(view.reviewRequired, true);
  assert.equal(view.retryReason, '');
  assert.equal(view.qualityScore, 74);
  assert.equal(view.qualityBlockingFailureCount, 1);
  assert.ok(view.reviewReasons.some(reason => reason.includes('Unsupported claims')));
  assert.ok(!view.reviewReasons.some(reason => reason.includes('Advisory failure')));
  assert.ok(!view.reviewReasons.some(reason => reason.includes('Passing blocking check')));
});

test('pipeline UI uses a lightweight one-row status read and explicit review action', async () => {
  const [component, externalAnalysis] = await Promise.all([
    readFile(new URL('../components/FullArticlePipelineControl.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../utils/externalAnalysis.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(component, /loadLatestFullArticlePipeline/);
  assert.match(component, /loadFullArticlePipelineReadiness/);
  assert.match(component, /إعادة فحص الجاهزية/);
  assert.match(component, /مراجعة النواقص/);
  assert.match(component, /!progressView\.reviewRequired/);
  assert.doesNotMatch(component, /listExternalAnalysisJobsViaApi\(articleId, 50\)/);
  assert.match(externalAnalysis, /eq\('job_type', 'full_article_pipeline'\)[\s\S]*limit\(1\)/);
});
