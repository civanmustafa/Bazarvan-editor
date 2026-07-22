import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __adminAiProviderSecretsTestUtils,
  isAiSettingsEncryptionConfigured,
} from '../server/adminAiProviderSecrets.ts';
import {
  __resetAdminAiProviderSecretsReadinessForTests,
  checkAdminAiProviderSecretsReadiness,
} from '../server/adminAiProviderSecretsReadiness.ts';

const withEncryptionKey = async (callback: () => Promise<void> | void): Promise<void> => {
  const previous = process.env.AI_SETTINGS_ENCRYPTION_KEY;
  process.env.AI_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
  try {
    await callback();
  } finally {
    if (previous === undefined) delete process.env.AI_SETTINGS_ENCRYPTION_KEY;
    else process.env.AI_SETTINGS_ENCRYPTION_KEY = previous;
  }
};

test('administrator AI keys use authenticated encryption bound to one provider', async () => {
  await withEncryptionKey(() => {
    const plaintext = 'test-openai-provider-key-1234567890';
    const encrypted = __adminAiProviderSecretsTestUtils.encryptSecret('openai_latest', plaintext);
    assert.notEqual(encrypted.ciphertext, plaintext);
    assert.equal(
      __adminAiProviderSecretsTestUtils.decryptSecret({
        provider: 'openai_latest',
        ...encrypted,
      } as any),
      plaintext,
    );
    assert.throws(
      () => __adminAiProviderSecretsTestUtils.decryptSecret({
        provider: 'gemini_latest',
        ...encrypted,
      } as any),
      /could not be decrypted/i,
    );
  });
});

test('administrator AI key validation accepts one key and rejects lists', () => {
  assert.equal(
    __adminAiProviderSecretsTestUtils.normalizeApiKey('single-provider-key-1234567890'),
    'single-provider-key-1234567890',
  );
  assert.throws(
    () => __adminAiProviderSecretsTestUtils.normalizeApiKey('first-provider-key-12345,second-provider-key-67890'),
    /single non-whitespace value/i,
  );
});

test('administrator AI secret readiness checks schema and encryption independently', async () => {
  await withEncryptionKey(async () => {
    __resetAdminAiProviderSecretsReadinessForTests();
    const ready = await checkAdminAiProviderSecretsReadiness({
      force: true,
      client: {
        from: () => ({
          select: () => ({
            limit: async () => ({ error: null }),
          }),
        }),
      },
    });
    assert.equal(isAiSettingsEncryptionConfigured(), true);
    assert.equal(ready.ok, true);
    assert.deepEqual(ready.checks, { schema: true, encryptionKey: true });
  });

  const previous = process.env.AI_SETTINGS_ENCRYPTION_KEY;
  delete process.env.AI_SETTINGS_ENCRYPTION_KEY;
  try {
    __resetAdminAiProviderSecretsReadinessForTests();
    const notReady = await checkAdminAiProviderSecretsReadiness({
      force: true,
      client: {
        from: () => ({
          select: () => ({
            limit: async () => ({ error: null }),
          }),
        }),
      },
    });
    assert.equal(notReady.ok, false);
    assert.equal(notReady.checks.encryptionKey, false);
  } finally {
    if (previous !== undefined) process.env.AI_SETTINGS_ENCRYPTION_KEY = previous;
  }
});
