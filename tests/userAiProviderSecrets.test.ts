import assert from 'node:assert/strict';
import test from 'node:test';
import { __userAiProviderSecretsTestUtils } from '../server/userAiProviderSecrets.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const withEncryptionKey = async (callback: () => Promise<void> | void): Promise<void> => {
  const previous = process.env.AI_SETTINGS_ENCRYPTION_KEY;
  process.env.AI_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString('base64');
  try {
    await callback();
  } finally {
    if (previous === undefined) delete process.env.AI_SETTINGS_ENCRYPTION_KEY;
    else process.env.AI_SETTINGS_ENCRYPTION_KEY = previous;
  }
};

test('personal AI keys normalize lists, remove duplicates, and reject invalid values', () => {
  assert.deepEqual(
    __userAiProviderSecretsTestUtils.normalizeApiKeyList(
      'personal-gemini-key-1234567890, personal-gemini-key-1234567890;second-personal-key-1234567890',
    ),
    ['personal-gemini-key-1234567890', 'second-personal-key-1234567890'],
  );
  assert.throws(
    () => __userAiProviderSecretsTestUtils.normalizeApiKeyList('too-short'),
    /between 20 and 512 characters/i,
  );
});

test('personal AI key lists use authenticated encryption bound to owner and provider', async () => {
  await withEncryptionKey(() => {
    const apiKeys = [
      'personal-gemini-key-1234567890',
      'second-personal-key-1234567890',
    ];
    const encrypted = __userAiProviderSecretsTestUtils.encryptKeyList(
      USER_ID,
      'gemini_free',
      apiKeys,
    );
    assert.notEqual(encrypted.ciphertext, JSON.stringify(apiKeys));
    assert.deepEqual(
      __userAiProviderSecretsTestUtils.decryptKeyList({
        user_id: USER_ID,
        provider: 'gemini_free',
        enabled: true,
        key_count: apiKeys.length,
        key_suffixes: apiKeys.map(key => key.slice(-4)),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...encrypted,
      }),
      apiKeys,
    );
    assert.throws(
      () => __userAiProviderSecretsTestUtils.decryptKeyList({
        user_id: '22222222-2222-4222-8222-222222222222',
        provider: 'gemini_free',
        enabled: true,
        key_count: apiKeys.length,
        key_suffixes: apiKeys.map(key => key.slice(-4)),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...encrypted,
      }),
      /could not be decrypted/i,
    );
  });
});
