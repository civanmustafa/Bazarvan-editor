import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectAiKeyUsageEntries,
  formatAiKeySuffix,
  notifyAiKeyUsageFeedback,
} from '../utils/aiKeyUsageFeedback.ts';
import {
  beginAiExecutionActivity,
  finishAiExecutionActivity,
  getAiExecutionActivities,
  resetAiExecutionActivitiesForTests,
  updateAiExecutionActivity,
} from '../utils/aiExecutionActivity.ts';

test('AI key feedback keeps failed rotations and the successful key suffix', () => {
  const entries = collectAiKeyUsageEntries({
    keySuffix: 'SUCCESS1',
    attempts: [
      { keySuffix: 'FAILED01', status: 429, reason: 'quota', model: 'gemini-test' },
      { keySuffix: 'FAILED02', status: 401, reason: 'auth', model: 'gemini-test' },
    ],
  }, 'success');

  assert.deepEqual(entries.map(entry => [entry.keySuffix, entry.outcome, entry.status]), [
    ['CCESS1', 'success', undefined],
    ['ILED01', 'failed', 429],
    ['ILED02', 'failed', 401],
  ]);
});

test('AI key feedback reads nested content-writing execution metadata', () => {
  const feedback = notifyAiKeyUsageFeedback({
    provider: 'Gemini Pro',
    status: 200,
    payload: {
      result: [{
        execution: {
          status: 200,
          keySuffix: '1234',
          providerMetadata: {
            attempts: [{ keySuffix: '9876', status: 503, reason: 'server' }],
          },
        },
      }],
    },
  });

  assert.ok(feedback);
  assert.deepEqual(feedback.entries.map(entry => [entry.keySuffix, entry.outcome]), [
    ['1234', 'success'],
    ['9876', 'failed'],
  ]);
  assert.equal(formatAiKeySuffix('...abcdefghi'), '••••defghi');
});

test('AI key feedback includes credential and provider fallback suffixes', () => {
  const entries = collectAiKeyUsageEntries({
    keySuffix: 'FREE04',
    status: 200,
    credentialFallbackChain: [
      { keySuffix: 'ADMIN1', status: 401, outcome: 'failed', model: 'openai-test' },
      { keySuffix: 'HOST02', status: 429, outcome: 'failed', model: 'openai-test' },
    ],
    providerFallbackChain: [
      { keySuffix: 'PRO003', status: 503, outcome: 'failed', model: 'gemini-paid-test' },
      { keySuffix: 'FREE04', status: 200, outcome: 'success', model: 'gemini-free-test' },
    ],
  });

  assert.deepEqual(
    entries.map(entry => [entry.keySuffix, entry.outcome, entry.status]),
    [
      ['FREE04', 'success', 200],
      ['ADMIN1', 'failed', 401],
      ['HOST02', 'failed', 429],
      ['PRO003', 'failed', 503],
    ],
  );
});

test('unified AI activity follows live key, model, and paid-to-free fallback state', () => {
  resetAiExecutionActivitiesForTests();
  const started = beginAiExecutionActivity({
    id: 'activity-test',
    provider: 'geminiPaid',
    requestedProvider: 'geminiPaid',
    model: 'gemini-paid-test',
    requestedModel: 'gemini-paid-test',
    surface: 'quick_provider',
  });
  assert.equal(started.state, 'running');
  assert.equal(started.credentialTier, 'paid');

  const rotating = updateAiExecutionActivity('activity-test', {
    progress: {
      stage: 'failed-key',
      provider: 'geminiPaid',
      model: 'gemini-paid-test',
      currentKeyIndex: 1,
      keyCount: 2,
      keySuffix: 'PAID01',
      status: 429,
      completed: false,
    },
    completed: false,
  });
  assert.equal(rotating.state, 'running');
  assert.equal(rotating.keySuffix, 'PAID01');
  assert.deepEqual(rotating.entries.map(entry => [entry.keySuffix, entry.outcome]), [
    ['PAID01', 'failed'],
  ]);

  const completed = finishAiExecutionActivity('activity-test', {
    provider: 'gemini',
    requestedProvider: 'geminiPaid',
    model: 'gemini-free-test',
    requestedModel: 'gemini-paid-test',
    httpStatus: 200,
    outcome: 'success',
    payload: {
      provider: 'gemini',
      model: 'gemini-free-test',
      keySuffix: 'FREE02',
      status: 200,
      providerFallbackChain: [
        { provider: 'geminiPaid', model: 'gemini-paid-test', keySuffix: 'PAID01', status: 429 },
        { provider: 'gemini', model: 'gemini-free-test', keySuffix: 'FREE02', status: 200 },
      ],
    },
  });

  assert.equal(completed.state, 'success');
  assert.equal(completed.credentialTier, 'free');
  assert.equal(completed.requestedProvider, 'geminiPaid');
  assert.equal(completed.provider, 'gemini');
  assert.equal(completed.model, 'gemini-free-test');
  assert.equal(completed.keySuffix, 'FREE02');
  assert.ok(completed.entries.some(entry => entry.keySuffix === 'PAID01' && entry.outcome === 'failed'));
  assert.ok(completed.entries.some(entry => entry.keySuffix === 'FREE02' && entry.outcome === 'success'));
  assert.equal(getAiExecutionActivities()[0].id, 'activity-test');
});
