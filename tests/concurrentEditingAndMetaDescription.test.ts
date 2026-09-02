import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mergeSavedSemanticKeywords } from '../utils/semanticKeywordMerge.ts';
import type { Keywords } from '../types';
import {
  buildMetaDescriptionGenerationPrompt,
  buildMetaDescriptionPrompt,
  buildMetaDescriptionSuggestionsPrompt,
  extractArticleTableOfContents,
  getValidMetaDescriptionSuggestionPair,
  parseGeneratedMetaDescription,
  parseGeneratedMetaDescriptionSuggestions,
  parseValidMetaDescriptionGeneration,
  shouldRetryMetaDescriptionGeneration,
  validateMetaDescription,
} from '../utils/metaDescription.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('a background Google result never overwrites newer unsaved semantic edits', () => {
  const baseline: Keywords = { primary: 'ذهب', company: 'شركة', secondaries: ['بديل'], lsi: ['دلالة'], googleTitles: [], googleDescriptions: [] };
  const remote = { ...baseline, googleTitles: ['عنوان محفوظ'], googleDescriptions: [{ text: 'وصف محفوظ', callToAction: '' }] };
  const local = { ...baseline, lsi: ['تعديل يدوي جديد'] };
  const merged = mergeSavedSemanticKeywords(local, JSON.stringify({ keywords: baseline }), remote);
  assert.deepEqual(merged.lsi, local.lsi);
  assert.deepEqual(merged.googleTitles, remote.googleTitles);
  const editedGoogle = { ...local, googleTitles: ['عنوان يدوي جديد'] };
  assert.deepEqual(mergeSavedSemanticKeywords(editedGoogle, JSON.stringify({ keywords: baseline }), remote, true).googleTitles, editedGoogle.googleTitles);
  const changedPrimary = { ...local, primary: 'فضة' };
  assert.deepEqual(mergeSavedSemanticKeywords(changedPrimary, JSON.stringify({ keywords: baseline }), remote), changedPrimary);
});

test('manual Google action is durable, access-checked, scoped and confirmed only after saving', async () => {
  const [migration, api, component, summary] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260903000000_manual_google_metadata.sql'),
    readWorkspaceFile('api/externalAnalysis.ts'),
    readWorkspaceFile('components/GoogleMetadataSuggestions.tsx'),
    readWorkspaceFile('utils/externalAnalysis.ts'),
  ]);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /order by job.id for update/);
  assert.match(migration, /raise exception 'semantic_already_active'/);
  assert.match(migration, /'needsSecondaries', false, 'needsLsi', false, 'needsGoogleMetadata', true/);
  assert.match(migration, /enqueue_manual_google_metadata_job\(uuid\) from public, anon, authenticated/);
  assert.match(migration, /language sql stable security invoker/);
  assert.match(migration, /jsonb_path_exists/);
  assert.match(migration, /nullif\(btrim\(session.result_text\), ''\) is not null/);
  assert.match(api, /requireArticleWriteAccess[\s\S]*action === 'google_metadata'/);
  assert.match(component, /const saved = await handleSaveDraft\(\)/);
  assert.match(component, /if \(!saved\) throw[\s\S]*enqueueGoogleMetadataGeneration/);
  assert.match(component, /job\?\.status === 'completed'/);
  assert.match(component, /reloadSavedGoogleMetadata\(articleId\)/);
  assert.match(component, /requestVersion.current !== version/);
  assert.match(summary, /currentEngineeringJobs: engineeringJobs/);
});

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

test('two-description contract parses exactly two distinct valid suggestions', () => {
  const keyword = 'جهاز كشف الذهب';
  const first = `${keyword} دليل عملي يشرح الاختيار والاستخدام والمعايير المهمة للوصول إلى قرار يناسب احتياجات القارئ بوضوح`.padEnd(140, 'ا');
  const second = `${keyword} تعرف على المزايا وخطوات المقارنة والنصائح العملية التي تساعدك على تقييم الخيارات واختيار الجهاز الأنسب`.padEnd(140, 'ب');
  const response = JSON.stringify({ metaDescriptionSuggestions: [first, second] });

  assert.deepEqual(parseGeneratedMetaDescriptionSuggestions(response), [first, second]);
  assert.deepEqual(getValidMetaDescriptionSuggestionPair(response, keyword), [first, second]);
  assert.equal(getValidMetaDescriptionSuggestionPair(JSON.stringify({ suggestions: [first] }), keyword), null);
  assert.equal(getValidMetaDescriptionSuggestionPair(JSON.stringify({ suggestions: [first, first] }), keyword), null);

  const prompt = buildMetaDescriptionSuggestionsPrompt({
    title: 'دليل أجهزة الكشف',
    primaryKeyword: keyword,
    articleLanguage: 'ar',
    finalArticle: '# دليل أجهزة الكشف\n\nمقالة نهائية.',
    goalContext: { objective: 'مساعدة القارئ على الاختيار' },
  });
  assert.match(prompt, /exactly two distinct/);
  assert.match(prompt, /140 to 150 Unicode characters/);
  assert.match(prompt, /metaDescriptionSuggestions/);
  assert.match(prompt, /جهاز كشف الذهب/);
});

test('one shared meta-description service preserves automatic-apply and writing-suggestion modes', () => {
  const keyword = 'جهاز كشف الذهب';
  const automatic = `${keyword} دليل عملي يوضح خطوات الاختيار والاستخدام وأهم المعايير والنصائح المرتبطة بهدف الصفحة ومحتواها`.padEnd(140, 'ا');
  const first = `${keyword} دليل عملي يشرح الاختيار والاستخدام والمعايير المهمة للوصول إلى قرار يناسب احتياجات القارئ بوضوح`.padEnd(140, 'ا');
  const second = `${keyword} تعرف على المزايا وخطوات المقارنة والنصائح العملية التي تساعدك على تقييم الخيارات واختيار الجهاز الأنسب`.padEnd(140, 'ب');

  const automaticPrompt = buildMetaDescriptionGenerationPrompt({
    mode: 'automatic_apply',
    title: 'دليل الاختيار',
    primaryKeyword: keyword,
    articleLanguage: 'ar',
    tableOfContents: ['كيفية الاختيار'],
    goalContext: { objective: 'مساعدة القارئ' },
  });
  const suggestionsPrompt = buildMetaDescriptionGenerationPrompt({
    mode: 'writing_suggestions',
    title: 'دليل الاختيار',
    primaryKeyword: keyword,
    articleLanguage: 'ar',
    finalArticle: '# كيفية الاختيار\n\nمقالة نهائية',
    goalContext: { objective: 'مساعدة القارئ' },
  });
  assert.match(automaticPrompt, /"metaDescription"/);
  assert.match(suggestionsPrompt, /"metaDescriptionSuggestions"/);
  assert.deepEqual(
    parseValidMetaDescriptionGeneration({
      mode: 'automatic_apply',
      response: JSON.stringify({ metaDescription: automatic }),
      primaryKeyword: keyword,
    }),
    { mode: 'automatic_apply', description: automatic, descriptions: [automatic] },
  );
  assert.deepEqual(
    parseValidMetaDescriptionGeneration({
      mode: 'automatic_apply',
      response: { metaDescription: automatic },
      primaryKeyword: keyword,
    }),
    { mode: 'automatic_apply', description: automatic, descriptions: [automatic] },
  );
  assert.deepEqual(
    parseValidMetaDescriptionGeneration({
      mode: 'writing_suggestions',
      response: JSON.stringify({ metaDescriptionSuggestions: [first, second] }),
      primaryKeyword: keyword,
    }),
    { mode: 'writing_suggestions', descriptions: [first, second] },
  );
  assert.equal(shouldRetryMetaDescriptionGeneration(1), true);
  assert.equal(shouldRetryMetaDescriptionGeneration(2), false);
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

test('background semantic Google suggestions update the open article without a false edit conflict', async () => {
  const [editor, suggestions, translations] = await Promise.all([
    readWorkspaceFile('contexts/EditorContext.tsx'),
    readWorkspaceFile('components/GoogleMetadataSuggestions.tsx'),
    readWorkspaceFile('components/translations.ts'),
  ]);

  assert.match(editor, /const remoteKeywords = normalizeKeywords\(row\.keywords\)/);
  assert.match(editor, /hasCompleteGoogleMetadata/);
  assert.match(editor, /setKeywords\(current => mergeSavedSemanticKeywords\([\s\S]*lastSavedArticleSignatureRef\.current, remoteKeywords/);
  assert.match(editor, /setConcurrentEditConflict\(null\)/);
  assert.match(suggestions, /googleMetadataSuggestionsPending/);
  assert.match(translations, /ستظهر هنا عنوانان ووصفان بعد اكتمال التوليد التلقائي/);
});

test('meta-description automation remains available while ready-status automation is retired', async () => {
  const [migration, retirement, executor, worker, monitor, bridge, settings, ecosystem] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260828010000_concurrent_editing_and_meta_description.sql'),
    readWorkspaceFile('supabase/migrations/20260829080000_unified_semantic_google_metadata.sql'),
    readWorkspaceFile('server/metaDescriptionGenerationExecutor.ts'),
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
    readWorkspaceFile('components/AiKeyUsageToast.tsx'),
    readWorkspaceFile('utils/externalAnalysisActivityBridge.ts'),
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
  assert.match(executor, /parseValidMetaDescriptionGeneration/);
  assert.match(executor, /mode: 'automatic_apply'/);
  assert.match(worker, /import '\.\/metaDescriptionGenerationExecutor'/);
  assert.match(ecosystem, /meta_description_generation/);
  assert.match(bridge, /meta_description_generation.*meta_description_generation/);
  assert.match(monitor, /كتابة وصف الميتا/);
  assert.match(retirement, /drop trigger if exists enqueue_article_meta_description_from_article/);
  assert.match(retirement, /ready_status_meta_description_retired/);
  assert.match(retirement, /select false/);
  assert.doesNotMatch(settings, /autoGenerateMetaDescription/);
});

test('Google title and description suggestion sections follow the article inside the editor scroll panel', async () => {
  const [editorApp, suggestions, sidebar] = await Promise.all([
    readWorkspaceFile('components/EditorApp.tsx'),
    readWorkspaceFile('components/GoogleMetadataSuggestions.tsx'),
    readWorkspaceFile('components/LeftSidebar.tsx'),
  ]);

  assert.match(
    editorApp,
    /data-bazarvan-editor-panel="true"[\s\S]*?<EditorContent\s+editor=\{editor\}\s+className="min-h-full"\s*\/>\s*<GoogleMetadataSuggestions\s*\/>/,
  );
  assert.match(suggestions, /googleTitleSuggestions/);
  assert.match(suggestions, /googleDescriptionSuggestions/);
  assert.doesNotMatch(sidebar, /googleTitleSuggestions|googleDescriptionSuggestions/);
  assert.doesNotMatch(editorApp, /MetaDescriptionField/);
});

test('manual, write-article, full-pipeline, and automatic writing share the strict two-description contract', async () => {
  const [
    aiContext,
    contentWorkflow,
    workflowUtilities,
    panel,
    promptRegistry,
    migration,
    stepTypeMigration,
  ] = await Promise.all([
    readWorkspaceFile('contexts/AIContext.tsx'),
    readWorkspaceFile('server/contentWritingWorkflow.ts'),
    readWorkspaceFile('utils/contentWritingWorkflow.ts'),
    readWorkspaceFile('components/ContentWritingPanel.tsx'),
    readWorkspaceFile('constants/promptRegistry.ts'),
    readWorkspaceFile('supabase/migrations/20260829010000_content_writing_two_meta_descriptions.sql'),
    readWorkspaceFile('supabase/migrations/20260902000000_allow_content_writing_meta_description_step.sql'),
  ]);

  assert.match(aiContext, /getValidMetaDescriptionSuggestionPair/);
  assert.match(aiContext, /action === 'copy-meta' && suggestions\.length !== 2/);
  assert.match(aiContext, /maximumRequests = action === 'copy-meta' \? 2 : 1/);
  assert.match(workflowUtilities, /type: 'meta_description'/);
  assert.match(contentWorkflow, /PROMPT_TEMPLATE_IDS\.metaDescriptionSuggestions/);
  assert.match(contentWorkflow, /metaDescriptionSuggestions/);
  assert.match(contentWorkflow, /previousInvalidMetaDescriptionResponse/);
  assert.match(contentWorkflow, /parseValidMetaDescriptionGeneration/);
  assert.match(contentWorkflow, /mode: 'writing_suggestions'/);
  assert.match(panel, /اقتراحا وصف الميتا/);
  assert.match(panel, /استخدام الوصف/);
  assert.match(promptRegistry, /contentWriting\.metaDescriptionSuggestions/);
  assert.match(migration, /'meta_description'/);
  assert.match(migration, /manual, full-pipeline, and automatic content-writing sessions/);
  assert.match(stepTypeMigration, /create or replace function public\.ensure_content_writing_step/);
  assert.match(stepTypeMigration, /'quality_repair',\s*'meta_description'\s*\)/);
  assert.match(stepTypeMigration, /notify pgrst, 'reload schema'/);
  assert.doesNotMatch(stepTypeMigration, /api_key|key_fingerprint/i);
  assert.equal((stepTypeMigration.match(/\$\$/g) || []).length % 2, 0, 'SQL has an unbalanced dollar quote.');
});
