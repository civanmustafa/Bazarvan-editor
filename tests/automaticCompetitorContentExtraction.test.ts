import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

test('completed competitor discovery automatically queues selected content extraction', async () => {
  const [migration, settings, registry, api, client, panel] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260829070000_automatic_competitor_content_extraction.sql'),
    readWorkspaceFile('components/SettingsPage.tsx'),
    readWorkspaceFile('constants/settingsRegistry.ts'),
    readWorkspaceFile('api/competitors.ts'),
    readWorkspaceFile('utils/competitorDiscovery.ts'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
  ]);

  assert.match(migration, /"autoExtractCompetitorContent":true/);
  assert.match(migration, /enqueue_automatic_competitor_extraction_for_discovery/);
  assert.match(migration, /after insert or update of status on public\.ai_external_analysis_jobs/);
  assert.match(migration, /result_row\.value->>'autoSelected'/);
  assert.match(migration, /public\.enqueue_competitor_extraction_job\(/);
  assert.match(migration, /'selectedQualifications', v_selected_qualifications/);
  assert.match(migration, /'reviewStatus', 'accepted'/);
  assert.match(migration, /pipeline_parent_job_id is not null/);
  assert.match(migration, /competitor_content_extraction_automation_disabled/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);

  assert.match(settings, /label="سحب محتوى المنافسين تلقائيًا"/);
  assert.match(settings, /autoExtractCompetitorContent !== false/);
  assert.match(registry, /autoExtractCompetitorContent: true/);
  assert.match(api, /Automatic extraction is queued by the database completion trigger/);
  assert.match(client, /automaticExtractionQueued/);
  assert.match(panel, /بدأ سحب محتواها تلقائيًا/);
});

test('automatic extraction setting is rechecked by the worker and writing coordinator reuses the queued child', async () => {
  const [externalSettings, guard, preparation] = await Promise.all([
    readWorkspaceFile('server/externalAnalysisSettings.ts'),
    readWorkspaceFile('server/contentResearchAutomationGuard.ts'),
    readWorkspaceFile('server/contentWritingCompetitorPreparationExecutor.ts'),
  ]);

  assert.match(externalSettings, /autoExtractCompetitorContent: boolean/);
  assert.match(guard, /job\.job_type === 'competitor_extraction'/);
  assert.match(guard, /competitor_content_extraction_automation_disabled/);
  assert.match(
    preparation,
    /findActiveExtractionJob\(context\.job\.article_id\)[\s\S]*enqueueCompetitorPreparationExtraction/,
  );
});

test('final keyword rechecks are advisory so approved automatic sources continue into writing', async () => {
  const [executor, content, panel] = await Promise.all([
    readWorkspaceFile('server/competitorExtractionExecutor.ts'),
    readWorkspaceFile('utils/competitorContent.ts'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
  ]);

  assert.match(executor, /Deterministic qualification is the hard selection gate/);
  assert.match(executor, /COMPETITOR_KEYWORD_TARGETING_WARNING_CODE/);
  assert.match(executor, /status: 'completed'[\s\S]*error_code: keywordTargeting\.warningCode \|\| null/);
  assert.doesNotMatch(executor, /The final page content did not contain the primary keyword/);
  assert.match(content, /competitor_keyword_targeting_unconfirmed/);
  assert.match(panel, /isCompetitorKeywordTargetingWarning/);
});

test('ready-status meta-description automation is retired in favor of unified semantic Google metadata', async () => {
  const [migration, registry, settings] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260829080000_unified_semantic_google_metadata.sql'),
    readWorkspaceFile('constants/settingsRegistry.ts'),
    readWorkspaceFile('components/SettingsPage.tsx'),
  ]);

  assert.match(migration, /drop trigger if exists enqueue_article_meta_description_from_article/);
  assert.match(migration, /ready_status_meta_description_retired/);
  assert.match(migration, /semantic_keywords_have_google_metadata/);
  assert.doesNotMatch(registry, /autoGenerateMetaDescription/);
  assert.doesNotMatch(settings, /عند تحويل المقالة إلى جاهز/);
});
