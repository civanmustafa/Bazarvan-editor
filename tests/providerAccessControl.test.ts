import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { __providerAccessControlTestUtils } from '../server/providerAccessControl.ts';

const CREDENTIAL_ID = '11111111-1111-4111-8111-111111111111';

const withEncryptionKey = async (callback: () => Promise<void> | void): Promise<void> => {
  const previous = process.env.PROVIDER_ACCESS_ENCRYPTION_KEY;
  process.env.PROVIDER_ACCESS_ENCRYPTION_KEY = Buffer.alloc(32, 37).toString('base64');
  try {
    await callback();
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_ACCESS_ENCRYPTION_KEY;
    else process.env.PROVIDER_ACCESS_ENCRYPTION_KEY = previous;
  }
};

test('assigned provider key lists use authenticated encryption bound to credential and provider', async () => {
  await withEncryptionKey(() => {
    const keys = ['assigned-openai-key-1234567890', 'assigned-openai-key-abcdefghij'];
    const encrypted = __providerAccessControlTestUtils.encryptKeys(CREDENTIAL_ID, 'openai', keys);
    assert.notEqual(encrypted.ciphertext, JSON.stringify(keys));
    const baseRow = {
      id: CREDENTIAL_ID,
      provider: 'openai',
      label: 'Editorial team',
      enabled: true,
      key_count: keys.length,
      key_suffixes: keys.map(key => key.slice(-4)),
      expires_at: null as string | null,
      created_by: null as string | null,
      updated_by: null as string | null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...encrypted,
    };
    assert.deepEqual(__providerAccessControlTestUtils.decryptKeys(baseRow as any), keys);
    assert.throws(
      () => __providerAccessControlTestUtils.decryptKeys({ ...baseRow, provider: 'firecrawl' } as any),
      /could not be decrypted/i,
    );
  });
});

test('global denials and ceilings cannot be loosened by a user override', () => {
  const globalPolicy = {
    ...__providerAccessControlTestUtils.defaultPolicy('openai'),
    enabled: false,
    allowPersonalKeys: false,
    allowedModels: ['gpt-5.4', 'gpt-5.5'],
    dailyRequestLimit: 100,
    monthlyRequestLimit: 1000,
  };
  const effective = __providerAccessControlTestUtils.mergePolicy(globalPolicy, {
    user_id: '22222222-2222-4222-8222-222222222222',
    provider: 'openai',
    enabled_override: true,
    allow_personal_keys_override: true,
    credential_mode_override: 'personal_first',
    allow_shared_fallback_override: true,
    allow_provider_fallback_override: true,
    default_model_override: 'gpt-5.5',
    allowed_models_override: ['gpt-5.5', 'unapproved-model'],
    daily_request_limit_override: 200,
    monthly_request_limit_override: 2000,
  } as any);
  assert.equal(effective.enabled, false);
  assert.equal(effective.allowPersonalKeys, false);
  assert.deepEqual(effective.allowedModels, ['gpt-5.5']);
  assert.equal(effective.dailyRequestLimit, 100);
  assert.equal(effective.monthlyRequestLimit, 1000);
});

test('credential tiers remove duplicate keys without changing source precedence', () => {
  const tiers = __providerAccessControlTestUtils.uniqueTiers([
    { source: 'user', keys: ['personal-key', 'duplicate-key'] },
    { source: 'assigned_user', keys: ['duplicate-key', 'assigned-key'] },
    { source: 'hostinger', keys: ['assigned-key', 'server-key'] },
  ] as any);
  assert.deepEqual(tiers.map((tier: { source: string }) => tier.source), [
    'user',
    'assigned_user',
    'hostinger',
  ]);
  assert.deepEqual(tiers.flatMap((tier: { keys: string[] }) => tier.keys), [
    'personal-key',
    'duplicate-key',
    'assigned-key',
    'server-key',
  ]);
});

test('provider access migration and APIs keep raw credentials server-only', async () => {
  const [migration, adminApi, userApi, client, login, context] = await Promise.all([
    readFile(new URL('../supabase/migrations/20260827000000_provider_access_control.sql', import.meta.url), 'utf8'),
    readFile(new URL('../api/adminProviderAccess.ts', import.meta.url), 'utf8'),
    readFile(new URL('../api/userProviderAccess.ts', import.meta.url), 'utf8'),
    readFile(new URL('../utils/providerAccessControl.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/Login.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../contexts/UserContext.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(migration, /revoke all on table public\.provider_shared_credentials from public, anon, authenticated/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /grant execute on function public\.reserve_provider_request/);
  assert.match(adminApi, /principal\.role !== 'admin'/);
  assert.match(adminApi, /Cache-Control': 'no-store'/);
  assert.match(userApi, /principal\.userId/);
  assert.doesNotMatch(client, /ciphertext|authentication_tag|initialization_vector/);
  assert.match(login, /الدخول أو إنشاء حساب بواسطة Google/);
  assert.match(context, /signInWithOAuth\(\{\s*provider: 'google'/);
});
