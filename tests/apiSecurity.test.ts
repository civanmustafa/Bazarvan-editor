import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiSecurityError,
  __resetApiSecurityStateForTests,
  assertAiRequestPayload,
  assertAllowedOrigin,
  consumeApiRateLimit,
  getCorsResponseHeaders,
} from '../api/apiSecurity.ts';

test.beforeEach(() => {
  __resetApiSecurityStateForTests();
});

test('allows same-origin browser requests', () => {
  const request = new Request('https://editor.example.com/api/gemini', {
    headers: { Origin: 'https://editor.example.com' },
  });

  assert.doesNotThrow(() => assertAllowedOrigin(request));
  assert.equal(getCorsResponseHeaders(request)['Access-Control-Allow-Origin'], 'https://editor.example.com');
});

test('rejects an unapproved cross-origin browser request', () => {
  const request = new Request('https://editor.example.com/api/gemini', {
    headers: { Origin: 'https://attacker.example' },
  });

  assert.throws(
    () => assertAllowedOrigin(request),
    (error: unknown) => error instanceof ApiSecurityError && error.status === 403,
  );
});

test('limits repeated requests within the same window', () => {
  consumeApiRateLimit('gemini:start', 'user-1', 2, 60_000, 1_000);
  consumeApiRateLimit('gemini:start', 'user-1', 2, 60_000, 1_001);

  assert.throws(
    () => consumeApiRateLimit('gemini:start', 'user-1', 2, 60_000, 1_002),
    (error: unknown) => (
      error instanceof ApiSecurityError
      && error.status === 429
      && error.headers['Retry-After'] === '60'
    ),
  );
});

test('validates prompt and history size', () => {
  assert.doesNotThrow(() => assertAiRequestPayload({ prompt: 'Analyze this article.' }));
  assert.throws(
    () => assertAiRequestPayload({ prompt: '' }),
    (error: unknown) => error instanceof ApiSecurityError && error.status === 400,
  );
  assert.throws(
    () => assertAiRequestPayload({
      prompt: 'Analyze',
      history: Array.from({ length: 51 }, () => ({ role: 'user', text: 'x' })),
    }),
    (error: unknown) => error instanceof ApiSecurityError && error.status === 413,
  );
});
