import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildContentBriefPrompt,
  parseContentBriefText,
} from '../utils/contentBriefGeneration.ts';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('smart brief parsing accepts the strict JSON contract and safe plain text', () => {
  assert.equal(
    parseContentBriefText('{"briefText":"موجز صالح للتحرير"}'),
    'موجز صالح للتحرير',
  );
  assert.equal(
    parseContentBriefText('```json\n{"result":{"generatedBrief":"موجز متداخل"}}\n```'),
    'موجز متداخل',
  );
  assert.equal(parseContentBriefText('موجز نصي مباشر'), 'موجز نصي مباشر');
});

test('smart brief prompt preserves manual choices as read-only context', () => {
  const prompt = buildContentBriefPrompt({
    title: 'عنوان المقالة',
    primaryKeyword: 'الكلمة الأساسية',
    alternativeKeywords: ['صيغة أولى'],
    articleLanguage: 'ar',
    goalContext: {
      pageType: 'article',
      objective: 'educate',
      audienceScope: 'country',
      searchIntent: 'informational',
      generatedBrief: 'الموجز السابق',
    },
  }, [
    '{{article_title}}',
    '{{primary_keyword}}',
    '{{alternative_keywords}}',
    '{{manual_choices_json}}',
    '{{existing_generated_brief}}',
  ].join('\n'));

  assert.match(prompt, /عنوان المقالة/);
  assert.match(prompt, /صيغة أولى/);
  assert.match(prompt, /"pageType": "article"/);
  assert.doesNotMatch(prompt, /"generatedBrief":/);
  assert.match(prompt, /الموجز السابق/);
});

test('full workflow is durable, ordered, cancellable, and applies only a reviewed quality draft', async () => {
  const [
    migration,
    safetyMigration,
    executor,
    briefExecutor,
    worker,
    ecosystem,
    api,
    component,
    contentWritingPanel,
    editorContext,
    supabaseArticles,
    externalAnalysisErrors,
  ] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260728030000_full_article_pipeline.sql'),
    readWorkspaceFile('supabase/migrations/20260824010000_full_article_pipeline_safety.sql'),
    readWorkspaceFile('server/fullArticlePipelineExecutor.ts'),
    readWorkspaceFile('server/contentBriefGenerationExecutor.ts'),
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
    readWorkspaceFile('ecosystem.config.cjs'),
    readWorkspaceFile('api/externalAnalysis.ts'),
    readWorkspaceFile('components/FullArticlePipelineControl.tsx'),
    readWorkspaceFile('components/ContentWritingPanel.tsx'),
    readWorkspaceFile('contexts/EditorContext.tsx'),
    readWorkspaceFile('utils/supabaseArticles.ts'),
    readWorkspaceFile('utils/externalAnalysisErrors.ts'),
  ]);

  for (const jobType of ['content_brief_generation', 'full_article_pipeline']) {
    assert.match(migration, new RegExp(`'${jobType}'`));
  }
  assert.match(safetyMigration, /apply_full_article_pipeline_content/);
  assert.match(safetyMigration, /article_versions/);
  assert.match(safetyMigration, /qualityGatePolicy', 'review_required'/);
  assert.match(safetyMigration, /drop function if exists public\.apply_full_article_pipeline_content\(uuid, uuid, text, text\)/);
  assert.match(safetyMigration, /grant execute on function public\.apply_full_article_pipeline_content[\s\S]*to service_role/);

  const orderedMarkers = [
    "'semantic_keywords_lsi', 1",
    "'content_brief_generation', 2",
    "'competitor_discovery', 3",
    "'competitor_extraction', 4",
    "'content_writing', 5",
    "'comprehensive_competitor_analysis', 6",
    "'article_application', 7",
  ];
  const executeBlock = executor.slice(executor.indexOf('const executeFullArticlePipeline'));
  let previousIndex = -1;
  for (const marker of orderedMarkers) {
    const index = executeBlock.indexOf(marker);
    assert.ok(index > previousIndex, `Missing or out-of-order pipeline marker: ${marker}`);
    previousIndex = index;
  }
  assert.match(executor, /qualityGatePolicy: 'review_required'/);
  assert.match(executor, /apply_full_article_pipeline_content/);
  assert.match(executor, /reevaluateContentWritingQualityAfterExternalReview/);
  assert.match(executor, /full_pipeline_quality_review_required/);
  assert.match(executor, /COMPREHENSIVE_COMMAND_ID/);
  assert.match(executor, /cancelContentWritingSession/);
  assert.match(executor, /request_external_analysis_job_cancel/);
  assert.match(executor, /contentBriefSavedAt/);
  assert.match(executor, /allowMissingCompany: true/);
  assert.match(executor, /allowMissingGoalContext: true/);
  assert.doesNotMatch(executor, /generatedBrief,[\s\S]*last_saved_at/);

  assert.match(briefExecutor, /readPromptRegistrySettings/);
  assert.match(briefExecutor, /generatedBrief: briefText/);
  assert.match(worker, /readAiJobRetryMinutes/);
  assert.match(worker, /administratorRetryMinutes/);
  assert.match(worker, /EXTERNAL_ANALYSIS_MAX_RETRY_COUNT/);
  assert.match(worker, /external_analysis_retry_limit_reached/);
  assert.match(ecosystem, /name: 'bazarvan-full-article-pipeline-worker'/);
  assert.match(ecosystem, /EXTERNAL_ANALYSIS_WORKER_JOB_TYPES: 'full_article_pipeline'/);
  assert.match(ecosystem, /semantic_keywords_lsi,content_brief_generation,engineering_command/);

  assert.match(api, /action === 'full_pipeline'/);
  assert.match(api, /action === 'list'/);
  assert.match(api, /enqueue_full_article_pipeline/);
  assert.match(api, /normalizeExternalAnalysisFailure/);
  assert.match(externalAnalysisErrors, /full_pipeline_schema_unavailable/);
  assert.match(api, /X-Request-ID/);
  assert.match(api, /request_full_article_pipeline_cancel/);
  assert.match(component, /بدء الإنشاء الشامل/);
  assert.match(component, /loadFullArticlePipelineReadiness/);
  assert.match(component, /CONTENT_WRITING_MIN_COMPETITOR_COUNT/);
  assert.match(component, /تتوقف مخالفات الجودة المانعة للمراجعة/);
  assert.match(component, /استئناف الآن/);
  assert.match(component, /\['failed', 'blocked', 'cancelled', 'retry_scheduled'\]/);
  assert.match(component, /loadLatestFullArticlePipeline/);
  assert.match(component, /onReloadGoalContext/);
  assert.match(component, /contentBriefSavedAt/);
  assert.match(contentWritingPanel, /onReloadGoalContext=\{reloadActiveGoalContextFromRemote\}/);
  assert.match(editorContext, /reloadActiveGoalContextFromRemote/);
  assert.match(editorContext, /\.\.\.previousContext,[\s\S]*generatedBrief/);
  assert.match(supabaseArticles, /select\('goal_context,updated_at'\)/);
  assert.match(supabaseArticles, /hasStructuredEditorJson\(row\.content_json\)[\s\S]*row\.content_html/);
});
