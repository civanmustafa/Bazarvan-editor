import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeDuplicateCleanupJobs } from '../utils/duplicateCleanupDashboard.ts';

const job = (category: number, status: string, created_at = '2026-09-28T10:00:00Z') => ({
  status, created_at, input_snapshot: { category },
});

test('unified cleanup covers all categories and never reports reverted or failed work as complete', () => {
  const unified = { status: 'running', created_at: '2026-09-29T10:00:00Z', input_snapshot: { version: 2, category: 0 },
    progress: { unified: { phase: 'reviewing', remaining: { 2: 3, 3: 1, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 } } } };
  assert.deepEqual(summarizeDuplicateCleanupJobs([job(4, 'completed'), unified]), { state: 'running', completedCount: 5, totalCount: 7 });
  assert.equal(summarizeDuplicateCleanupJobs([{ ...unified, status: 'completed' }]).state, 'partial');
  assert.equal(summarizeDuplicateCleanupJobs([{ ...unified, status: 'failed' }]).state, 'partial');
  const complete = { ...unified, status: 'completed', progress: { unified: { phase: 'completed', remaining: { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 } } } };
  assert.deepEqual(summarizeDuplicateCleanupJobs([complete]), { state: 'completed', completedCount: 7, totalCount: 7 });
  assert.deepEqual(summarizeDuplicateCleanupJobs([{ ...complete, progress: { unified: { ...complete.progress.unified, phase: 'reverted' } } }]),
    { state: 'partial', completedCount: 0, totalCount: 7 });
});

test('duplicate cleanup dashboard starts empty and aggregates attempted categories', () => {
  assert.deepEqual(summarizeDuplicateCleanupJobs([]), {
    state: 'not_started', completedCount: 0, totalCount: 0,
  });
  assert.deepEqual(summarizeDuplicateCleanupJobs([job(4, 'completed'), job(6, 'running')]), {
    state: 'running', completedCount: 1, totalCount: 2,
  });
  assert.deepEqual(summarizeDuplicateCleanupJobs([job(4, 'completed'), job(6, 'queued')]), {
    state: 'partial', completedCount: 1, totalCount: 2,
  });
  assert.deepEqual(summarizeDuplicateCleanupJobs([job(4, 'completed'), job(6, 'completed')]), {
    state: 'completed', completedCount: 2, totalCount: 2,
  });
});

test('latest generation replaces an earlier result for the same category', () => {
  assert.deepEqual(summarizeDuplicateCleanupJobs([
    job(4, 'completed', '2026-09-28T09:00:00Z'),
    job(4, 'failed', '2026-09-28T11:00:00Z'),
    job(6, 'completed'),
    { status: 'completed', created_at: '2026-09-28T12:00:00Z', input_snapshot: { category: 9 } },
  ]), { state: 'partial', completedCount: 1, totalCount: 2 });
  assert.deepEqual(summarizeDuplicateCleanupJobs([job(4, 'failed')]), {
    state: 'failed', completedCount: 0, totalCount: 1,
  });
  assert.deepEqual(summarizeDuplicateCleanupJobs([{
    ...job(4, 'completed'), result: { status: 'partial' },
  }]), { state: 'partial', completedCount: 0, totalCount: 1 });
  assert.deepEqual(summarizeDuplicateCleanupJobs([{
    ...job(4, 'failed'), progress: { cleanup: { decisions: [{ occurrenceId: '1' }] } },
  }]), { state: 'partial', completedCount: 0, totalCount: 1 });
});
