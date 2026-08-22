import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('content-writing resume key is isolated by provider and precedes ordinary rotation', async () => {
  await withEncryptionKey(() => {
    const plaintext = 'resume-gemini-provider-key-1234567890';
    const encrypted = __adminAiProviderSecretsTestUtils.encryptSecret(
      'content_writing_resume_gemini',
      plaintext,
    );
    assert.equal(
      __adminAiProviderSecretsTestUtils.decryptSecret({
        provider: 'content_writing_resume_gemini',
        ...encrypted,
      } as any),
      plaintext,
    );
    assert.throws(
      () => __adminAiProviderSecretsTestUtils.decryptSecret({
        provider: 'content_writing_resume_openai',
        ...encrypted,
      } as any),
      /could not be decrypted/i,
    );

    const credentials = __adminAiProviderSecretsTestUtils.buildResolvedCredentialSet(
      'admin-key-12345678901234567890',
      true,
      ['hostinger-key-123456789012345'],
      ['user-key-123456789012345678901'],
      plaintext,
    );
    assert.deepEqual(credentials.tiers.map((tier: { source: string }) => tier.source), [
      'resume',
      'user',
      'admin',
      'hostinger',
    ]);
    assert.equal(credentials.keys[0], plaintext);
  });

  const migration = await readFile(
    new URL('../supabase/migrations/20260823000000_content_writing_resume_secret.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /content_writing_resume_gemini/);
  assert.match(migration, /content_writing_resume_gemini_paid/);
  assert.match(migration, /content_writing_resume_openai/);
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
    assert.deepEqual(ready.checks, { schema: true, userSchema: true, encryptionKey: true });
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
