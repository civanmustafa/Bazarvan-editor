import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { __articleQuotaTestUtils } from '../server/articleQuota.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';

test('article quota values distinguish inherited, custom, blocked, and unlimited policies', () => {
  assert.equal(
    __articleQuotaTestUtils.normalizeLimit(null, { allowNull: true, allowZero: true }),
    null,
  );
  assert.equal(
    __articleQuotaTestUtils.normalizeLimit('0', { allowNull: true, allowZero: true }),
    0,
  );
  assert.throws(
    () => __articleQuotaTestUtils.normalizeLimit(0, { allowNull: false, allowZero: false }),
    /between 1 and 1000000/i,
  );

  const status = __articleQuotaTestUtils.normalizeStatus({
    userId: USER_ID,
    role: 'user',
    periodStart: '2026-08-01',
    resetAt: '2026-08-31T21:00:00.000Z',
    globalDefaultMonthlyLimit: 30,
    mode: 'custom',
    customMonthlyLimit: 12,
    effectiveMonthlyLimit: 12,
    used: 5,
    remaining: 7,
    canCreate: true,
  });
  assert.equal(status.timezone, 'Europe/Istanbul');
  assert.equal(status.effectiveMonthlyLimit, 12);
  assert.equal(status.remaining, 7);
});

test('article quota migration enforces an atomic owner-scoped monthly ledger', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20260827010000_article_monthly_quotas.sql', import.meta.url),
    'utf8',
  );
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, 'SQL contains an unmatched $$ delimiter.');

  for (const table of [
    'article_quota_global_policy',
    'user_article_quota_policies',
    'article_quota_usage',
    'article_quota_audit_events',
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(
      migration,
      new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`),
    );
  }

  assert.match(migration, /before insert on public\.articles/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(migration, /coalesce\(new\.source, 'manual'\) <> 'manual'/);
  assert.match(migration, /ARTICLE_MONTHLY_QUOTA_EXCEEDED/);
  assert.match(migration, /article_id uuid not null unique/);
  assert.doesNotMatch(migration, /article_id uuid[^\n]*references public\.articles/);
  assert.match(migration, /Europe\/Istanbul/g);
  assert.match(migration, /grant select, insert on table public\.article_quota_usage to service_role/);
  assert.match(migration, /grant select, insert on table public\.article_quota_audit_events to service_role/);
  assert.doesNotMatch(migration, /grant[^\n]*update[^\n]*article_quota_audit_events/);
});

test('quota policy changes are administrator-only and audited in the same transaction', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20260827010000_article_monthly_quotas.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /create or replace function public\.set_article_quota_global_policy/);
  assert.match(migration, /create or replace function public\.set_user_article_quota_policy/);
  assert.match(migration, /profile\.role = 'admin'/);
  assert.match(migration, /profile\.is_active is true/);
  assert.match(migration, /insert into public\.article_quota_audit_events/g);
  assert.match(
    migration,
    /revoke all on function public\.set_user_article_quota_policy\(uuid, uuid, text, integer\)\s+from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.set_user_article_quota_policy\(uuid, uuid, text, integer\)\s+to service_role/,
  );
});

test('quota APIs and UI keep writes admin-only while users can read only their own usage', async () => {
  const [adminApi, userApi, routes, articleSave, adminUi, userUi, login, adminUsers] = await Promise.all([
    readFile(new URL('../api/adminArticleQuota.ts', import.meta.url), 'utf8'),
    readFile(new URL('../api/userArticleQuota.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/apiRouteRegistry.ts', import.meta.url), 'utf8'),
    readFile(new URL('../api/articlesSave.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/AdminArticleQuotaSettings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/UserArticleQuotaSummary.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/Login.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../api/adminUsers.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(adminApi, /principal\.role !== 'admin'/);
  assert.match(adminApi, /actorUserId: principal\.userId/);
  assert.match(adminApi, /Cache-Control': 'no-store'/);
  assert.match(userApi, /readArticleQuotaOverview\(principal\.userId\)/);
  assert.doesNotMatch(userApi, /queryUserId|body\.userId/);
  assert.match(routes, /path: '\/api\/admin\/article-quota'/);
  assert.match(routes, /path: '\/api\/user\/article-quota'/);
  assert.match(articleSave, /ARTICLE_MONTHLY_QUOTA_EXCEEDED/);
  assert.match(articleSave, /429/);
  assert.match(adminUi, /يرث الحصة الافتراضية/);
  assert.match(adminUi, /منع إنشاء مقالات جديدة/);
  assert.match(userUi, /يمكن للمسؤول فقط تغيير الحصة/);
  assert.match(login, /const GOOGLE_AUTH_ENABLED = false/);
  assert.match(adminUsers, /auth\.admin\.createUser/);
});
