import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectAiKeyUsageEntries,
  formatAiKeySuffix,
  notifyAiKeyUsageFeedback,
} from '../utils/aiKeyUsageFeedback.ts';

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
