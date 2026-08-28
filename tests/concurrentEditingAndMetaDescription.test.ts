import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildMetaDescriptionPrompt,
  extractArticleTableOfContents,
  parseGeneratedMetaDescription,
  validateMetaDescription,
} from '../utils/metaDescription.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('meta description validation enforces 140–150 characters and the exact primary keyword', () => {
  const keyword = 'جهاز كشف الذهب';
  const validDescription = `${keyword} دليل عملي يوضح خطوات الاختيار والاستخدام وأهم المعايير والنصائح المرتبطة بهدف الصفحة ومحتواها`.padEnd(140, 'ا');
  const valid = validateMetaDescription(validDescription, keyword);
  assert.equal(valid.length, 140);
  assert.equal(valid.lengthValid, true);
  assert.equal(valid.includesPrimaryKeyword, true);
  assert.equal(valid.valid, true);

  assert.equal(validateMetaDescription(validDescription.slice(0, 139), keyword).valid, false);
  assert.equal(validateMetaDescription(`${validDescription}ا`.padEnd(151, 'ا'), keyword).valid, false);
  assert.equal(validateMetaDescription(validDescription.replace(keyword, 'كلمة أخرى'), keyword).valid, false);
});

test('meta description generation is grounded in the table of contents and page goal', () => {
  const headings = extractArticleTableOfContents(
    '<h2>كيفية الاختيار</h2><p>نص</p><h3>معايير المقارنة</h3>',
    '',
  );
  assert.deepEqual(headings, ['كيفية الاختيار', 'معايير المقارنة']);
  const prompt = buildMetaDescriptionPrompt({
    title: 'دليل الاختيار',
    primaryKeyword: 'جهاز كشف الذهب',
    articleLanguage: 'ar',
    tableOfContents: headings,
    goalContext: { objective: 'مساعدة القارئ على اتخاذ قرار مناسب' },
  });
  assert.match(prompt, /140 to 150 Unicode characters/);
  assert.match(prompt, /جهاز كشف الذهب/);
  assert.match(prompt, /كيفية الاختيار/);
  assert.match(prompt, /مساعدة القارئ/);
  assert.equal(
    parseGeneratedMetaDescription('{"metaDescription":"  وصف   منظم  "}'),
    'وصف منظم',
  );
});

test('database save fencing protects every existing-article save and requires an explicit overwrite decision', async () => {
  const [migration, api, client, editor, banner] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260828010000_concurrent_editing_and_meta_description.sql'),
    readWorkspaceFile('api/articlesSave.ts'),
    readWorkspaceFile('utils/supabaseArticles.ts'),
    readWorkspaceFile('contexts/EditorContext.tsx'),
    readWorkspaceFile('components/ConcurrentEditConflictBanner.tsx'),
  ]);

  assert.match(migration, /p_force_overwrite boolean/);
  assert.match(migration, /v_article\.last_saved_at is distinct from p_expected_last_saved_at/);
  assert.match(migration, /'concurrentEditConflict'/);
  assert.match(migration, /Only an explicit manual or recovery save may overwrite/);
  assert.doesNotMatch(
    migration.slice(
      migration.indexOf('create or replace function public.save_article_snapshot_with_content_policy(', migration.indexOf('-- Seven-argument')),
      migration.indexOf('-- Compatibility wrapper'),
    ),
    /p_save_reason in \('auto', 'lifecycle'\)/,
  );
  assert.match(api, /p_force_overwrite: forceOverwrite/);
  assert.match(api, /ARTICLE_CONCURRENT_EDIT_CONFLICT/);
  assert.match(client, /class ArticleSaveRequestError/);
  assert.match(client, /forceOverwrite: options\.forceOverwrite === true/);
  assert.match(editor, /concurrentEditConflict/);
  assert.match(editor, /ARTICLE_CONCURRENT_EDIT_CONFLICT/);
  assert.match(editor, /postgres_changes/);
  assert.match(banner, /تحميل النسخة الأحدث/);
  assert.match(banner, /اعتماد نسختي الحالية/);
});

test('ready status queues a fenced AI meta-description task and exposes it in the editor monitor', async () => {
  const [migration, executor, worker, monitor, bridge, field, settings, ecosystem] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260828010000_concurrent_editing_and_meta_description.sql'),
    readWorkspaceFile('server/metaDescriptionGenerationExecutor.ts'),
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
    readWorkspaceFile('components/AiKeyUsageToast.tsx'),
    readWorkspaceFile('utils/externalAnalysisActivityBridge.ts'),
    readWorkspaceFile('components/MetaDescriptionField.tsx'),
    readWorkspaceFile('components/SettingsPage.tsx'),
    readWorkspaceFile('ecosystem.config.cjs'),
  ]);

  assert.match(migration, /new\.status = 'in_review'/);
  assert.match(migration, /autoGenerateMetaDescription/);
  assert.match(migration, /'meta_description_generation'/);
  assert.match(migration, /apply_generated_article_meta_description/);
  assert.match(migration, /v_job\.locked_by is distinct from p_worker_id/);
  assert.match(migration, /char_length\(v_description\) < 140/);
  assert.match(executor, /registerExternalAnalysisJobExecutor\(\s*'meta_description_generation'/);
  assert.match(executor, /extractArticleTableOfContents/);
  assert.match(executor, /validateMetaDescription/);
  assert.match(worker, /import '\.\/metaDescriptionGenerationExecutor'/);
  assert.match(ecosystem, /meta_description_generation/);
  assert.match(bridge, /meta_description_generation.*meta_description_generation/);
  assert.match(monitor, /كتابة وصف الميتا/);
  assert.match(field, /المطلوب.*META_DESCRIPTION_MIN_LENGTH/);
  assert.match(field, /الكلمة المفتاحية/);
  assert.match(settings, /autoGenerateMetaDescription/);
});
