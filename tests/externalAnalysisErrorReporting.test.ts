import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExternalAnalysisFailure } from '../utils/externalAnalysisErrors.ts';

test('plain Supabase schema errors become actionable pipeline failures with a request id', async () => {
  const failure = normalizeExternalAnalysisFailure({
    code: 'PGRST202',
    message: 'Could not find the function public.enqueue_full_article_pipeline in the schema cache.',
  }, 'request-123', 'enqueue_rpc');

  assert.equal(failure.status, 503);
  assert.equal(failure.code, 'full_pipeline_schema_unavailable');
  assert.match(failure.message, /required pipeline migrations/i);
  assert.equal(failure.details.requestId, 'request-123');
  assert.equal(failure.details.phase, 'enqueue_rpc');
  assert.equal(failure.details.databaseCode, 'PGRST202');
  assert.doesNotMatch(failure.message, /Unknown external analysis error/);

  const wrapped = Object.assign(new Error(failure.message), failure);
  const reported = normalizeExternalAnalysisFailure(wrapped, 'request-123');
  assert.equal(reported.details.phase, 'enqueue_rpc');
});

test('plain operational errors preserve their useful message and correlation data', async () => {
  const failure = normalizeExternalAnalysisFailure({
    code: '57014',
    message: 'The enqueue request timed out.',
  }, 'request-456', 'reservation');

  assert.equal(failure.status, 500);
  assert.equal(failure.code, 'external_analysis_request_failed');
  assert.equal(failure.message, 'The enqueue request timed out.');
  assert.equal(failure.details.requestId, 'request-456');
  assert.equal(failure.details.phase, 'reservation');
});
