import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  __userAiProviderSecretsTestUtils,
  assertPersonalCredentialOwner,
  deleteUserAiProviderKeys,
  normalizeUserAiSecretProvider,
  readUserAiProviderSecretsOverview,
  resolveUserAiProviderKeys,
  saveUserAiProviderKeys,
} from '../server/userAiProviderSecrets.ts';

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

test('OpenAI personal credentials use the canonical provider while accepting the legacy identifier', () => {
  assert.equal(normalizeUserAiSecretProvider('openai'), 'openai');
  assert.equal(normalizeUserAiSecretProvider('openai_paid'), 'openai');
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

test('personal AI key storage and execution reject every actor other than the key owner', async () => {
  const otherUserId = '22222222-2222-4222-8222-222222222222';
  assert.equal(assertPersonalCredentialOwner(USER_ID, USER_ID), USER_ID);
  assert.throws(
    () => assertPersonalCredentialOwner(otherUserId, USER_ID),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 403);
      assert.equal((error as { code?: string }).code, 'USER_AI_SECRET_OWNER_MISMATCH');
      return true;
    },
  );

  const assertOwnerMismatch = (operation: Promise<unknown>) => assert.rejects(
    operation,
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 403);
      assert.equal((error as { code?: string }).code, 'USER_AI_SECRET_OWNER_MISMATCH');
      return true;
    },
  );
  await assertOwnerMismatch(readUserAiProviderSecretsOverview({
    actorUserId: otherUserId,
    ownerUserId: USER_ID,
  }));
  await assertOwnerMismatch(resolveUserAiProviderKeys({
    actorUserId: otherUserId,
    ownerUserId: USER_ID,
    provider: 'gemini_free',
  }));
  await assertOwnerMismatch(saveUserAiProviderKeys({
    actorUserId: otherUserId,
    ownerUserId: USER_ID,
    provider: 'gemini_free',
    apiKeys: ['personal-gemini-key-1234567890'],
  }));
  await assertOwnerMismatch(deleteUserAiProviderKeys({
    actorUserId: otherUserId,
    ownerUserId: USER_ID,
    provider: 'gemini_free',
  }));
});

test('personal secret APIs never let an administrator select another owner', async () => {
  const [userApi, adminAiApi, adminCrawlerApi, service, aiResolver, crawlerResolver, vaultMigration] = await Promise.all([
    readFile(new URL('../api/userAiProviderSecrets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../api/adminAiProviderSecrets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../api/adminCrawlerProviderSecrets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/userAiProviderSecrets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/adminAiProviderSecrets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/crawlerProviderSecrets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260829030000_provider_credential_vault.sql', import.meta.url), 'utf8'),
  ]);

  assert.match(userApi, /readOverviewResult\(principal\.userId\)/);
  assert.match(userApi, /actorUserId: principal\.userId,\s+ownerUserId: principal\.userId/g);
  assert.doesNotMatch(userApi, /body\.userId|queryUserId/);
  assert.doesNotMatch(adminAiApi, /userAiProviderSecrets|resolveUserAiProviderKeys/);
  assert.doesNotMatch(adminCrawlerApi, /userAiProviderSecrets|resolveUserAiProviderKeys/);
  assert.match(service, /USER_AI_SECRET_OWNER_MISMATCH/);
  assert.match(service, /actorUserId: string \| null \| undefined/);
  assert.match(service, /ownerUserId: string \| null \| undefined/);
  assert.match(aiResolver, /actorUserId: userId,\s+ownerUserId: userId/g);
  assert.match(crawlerResolver, /actorUserId: userId,\s+ownerUserId: userId/);
  assert.doesNotMatch(aiResolver, /process\.env\.(?:OPENAI|GEMINI).*API_KEY/);
  assert.doesNotMatch(crawlerResolver, /process\.env\.(?:FIRECRAWL|BROWSERLESS).*KEY/);
  assert.match(vaultMigration, /create table if not exists public\.provider_credentials_vault/);
  assert.match(vaultMigration, /alter table public\.provider_credentials_vault enable row level security/);
  assert.match(vaultMigration, /revoke all on table public\.provider_credentials_vault from public, anon, authenticated/);
});
