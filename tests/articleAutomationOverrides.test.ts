import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS,
  COMPETITOR_COMPARISON_COMMAND_ID,
  countArticleAutomationExceptions,
  normalizeArticleAutomationOverrides,
} from '../constants/articleAutomationOverrides.ts';

const readWorkspaceFile = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('article overrides are opt-in, restrictive, deduplicated, and bounded', () => {
  assert.deepEqual(normalizeArticleAutomationOverrides(null), ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS);
  const normalized = normalizeArticleAutomationOverrides({
    disabledCapabilities: [
      'autoDiscoverCompetitors',
      'autoDiscoverCompetitors',
      'not-a-capability',
    ],
    writingMode: 'available_inputs',
    excludedExternalCommandIds: [COMPETITOR_COMPARISON_COMMAND_ID, COMPETITOR_COMPARISON_COMMAND_ID, ''],
    reason: `  ${'x'.repeat(1100)}  `,
  });
  assert.deepEqual(normalized.disabledCapabilities, ['autoDiscoverCompetitors']);
  assert.equal(normalized.writingMode, 'available_inputs');
  assert.deepEqual(normalized.excludedExternalCommandIds, [COMPETITOR_COMPARISON_COMMAND_ID]);
  assert.equal(normalized.reason.length, 1000);
  assert.equal(countArticleAutomationExceptions(normalized), 3);
});

test('migration overlays policy, bypasses only competitor gates, and cancels excluded work neutrally', async () => {
  const [migration, trashGuardMigration] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20261028000000_article_automation_overrides.sql'),
    readWorkspaceFile('supabase/migrations/20261028010000_restore_trashed_article_policy_guard.sql'),
  ]);
  assert.match(migration, /create table if not exists public\.article_automation_overrides/);
  assert.match(migration, /alter table public\.article_automation_overrides enable row level security/);
  assert.match(migration, /articleWritingMode/);
  assert.match(migration, /v_writing_mode = 'available_inputs'/);
  assert.match(migration, /content_writing_preparation[\s\S]*articleWritingMode[\s\S]*strict/);
  assert.match(migration, /article_automation_stage_excluded/);
  assert.match(migration, /create or replace function public\.article_automatic_policy_allows/);
  assert.match(migration, /articleOverrideVersion/);
  assert.match(trashGuardMigration, /public\.article_is_globally_trashed\(p_article_id\)/);
  assert.match(migration, /perform public\.reconcile_automatic_article_focus\(\)/);
  assert.match(migration, /select 23/);
  assert.equal((migration.match(/\$readiness_patch\$/g) || []).length, 2);
  assert.equal((migration.match(/\$claim_patch\$/g) || []).length, 2);
});

test('dashboard exposes a per-article modal and API route without changing defaults', async () => {
  const [dashboard, control, api, registry, engine] = await Promise.all([
    readWorkspaceFile('components/Dashboard.tsx'),
    readWorkspaceFile('components/ArticleAutomationOverridesControl.tsx'),
    readWorkspaceFile('api/articleAutomationOverrides.ts'),
    readWorkspaceFile('server/apiRouteRegistry.ts'),
    readWorkspaceFile('server/contentWritingEngine.ts'),
  ]);
  assert.match(dashboard, /ArticleAutomationOverridesControl/);
  assert.match(control, /استعادة الوراثة الافتراضية/);
  assert.match(control, /الكتابة بالمدخلات المتاحة/);
  assert.match(control, /كتابة يدوية فقط/);
  assert.match(api, /requireArticleWriteAccess/);
  assert.match(api, /Object\.keys\(body\)\.some/);
  assert.match(registry, /\/api\/articles\/automation-overrides/);
  assert.match(engine, /readinessIssues\.filter\(issue => issue\.code !== 'competitors'\)/);
});
