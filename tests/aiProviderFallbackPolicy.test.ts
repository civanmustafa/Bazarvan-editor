import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAiProviderFallbackOrder,
  getAvailableAiProviderFallbacks,
  mergeProviderFallbackResult,
  shouldAttemptAiFallback,
} from '../server/aiProviderFallbackPolicy.ts';
import { __adminAiProviderSecretsTestUtils } from '../server/adminAiProviderSecrets.ts';
import type { AiProviderCapabilities } from '../constants/aiProviderCapabilities.ts';

const capabilities: AiProviderCapabilities = {
  providers: {
    openai: { enabled: true, configured: true, available: true, model: 'openai-test' },
    geminiPaid: { enabled: true, configured: true, available: true, model: 'gemini-paid-test' },
    gemini: { enabled: true, configured: true, available: true, model: 'gemini-free-test' },
  },
  defaultProvider: 'openai',
};

test('provider fallback order is deterministic and skips unavailable providers', () => {
  assert.deepEqual(getAiProviderFallbackOrder('openai'), ['openai', 'geminiPaid', 'gemini']);
  assert.deepEqual(getAiProviderFallbackOrder('geminiPaid'), ['geminiPaid', 'gemini']);
  assert.deepEqual(getAiProviderFallbackOrder('gemini'), ['gemini']);
  assert.deepEqual(getAvailableAiProviderFallbacks(capabilities, 'openai'), ['geminiPaid', 'gemini']);

  const withoutPaid: AiProviderCapabilities = {
    ...capabilities,
    providers: {
      ...capabilities.providers,
      geminiPaid: { ...capabilities.providers.geminiPaid, enabled: false, available: false },
    },
  };
  assert.deepEqual(getAvailableAiProviderFallbacks(withoutPaid, 'openai'), ['gemini']);
});

test('fallback policy accepts key, quota, timeout, and server failures only', () => {
  [401, 403, 408, 429, 500, 502, 503, 504].forEach(status => {
    assert.equal(shouldAttemptAiFallback({ status, body: {} }), true, `HTTP ${status}`);
  });
  assert.equal(shouldAttemptAiFallback({
    status: 503,
    body: { code: 'AI_PROVIDER_NOT_CONFIGURED' },
  }), true);
  assert.equal(shouldAttemptAiFallback({
    status: 403,
    body: { code: 'AI_PROVIDER_DISABLED' },
  }), false);
  assert.equal(shouldAttemptAiFallback({
    status: 499,
    body: { cancelled: true },
  }), false);
  assert.equal(shouldAttemptAiFallback({
    status: 400,
    body: { code: 'AI_PROMPT_REQUIRED' },
  }), false);
  assert.equal(shouldAttemptAiFallback({
    status: 400,
    body: { attemptSummary: { blocked: 1, quota: 0, auth: 0, server: 0, unknown: 0 } },
  }), false);
});

test('provider fallback metadata preserves suffixes and removes key fingerprints', () => {
  const result = mergeProviderFallbackResult({
    previous: {
      status: 401,
      body: {
        provider: 'openai',
        model: 'openai-test',
        credentialSource: 'admin',
        keySuffix: 'OA01',
        attempts: [{
          keyFingerprint: 'secret-fingerprint',
          keySuffix: 'OA01',
          status: 401,
          reason: 'invalid key',
        }],
      },
    },
    next: {
      status: 200,
      body: {
        provider: 'geminiPaid',
        model: 'gemini-paid-test',
        credentialSource: 'hostinger',
        keySuffix: 'GM01',
        text: 'ok',
      },
    },
    requestedProvider: 'openai',
  });
  const body = result.body as Record<string, any>;
  assert.equal(body.providerFallbackUsed, true);
  assert.equal(body.requestedProvider, 'openai');
  assert.deepEqual(
    body.providerFallbackChain.map((step: Record<string, unknown>) => [
      step.provider,
      step.outcome,
      step.keySuffix,
    ]),
    [
      ['openai', 'failed', 'OA01'],
      ['geminiPaid', 'success', 'GM01'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(body.providerFallbackAttempts), /secret-fingerprint/);
});

test('administrator credentials stay ahead of Hostinger keys and duplicate keys are removed', () => {
  const enabled = __adminAiProviderSecretsTestUtils.buildResolvedCredentialSet(
    'admin-key',
    true,
    ['hostinger-1', 'admin-key', 'hostinger-2', 'hostinger-1'],
  );
  assert.deepEqual(enabled.tiers, [
    { source: 'admin', keys: ['admin-key'] },
    { source: 'hostinger', keys: ['hostinger-1', 'hostinger-2'] },
  ]);
  assert.deepEqual(enabled.keys, ['admin-key', 'hostinger-1', 'hostinger-2']);
  assert.equal(enabled.source, 'admin');

  const disabled = __adminAiProviderSecretsTestUtils.buildResolvedCredentialSet(
    'admin-key',
    false,
    ['hostinger-1'],
  );
  assert.deepEqual(disabled.tiers, [{ source: 'hostinger', keys: ['hostinger-1'] }]);
  assert.equal(disabled.source, 'hostinger');
});
