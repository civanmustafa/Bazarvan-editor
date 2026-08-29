import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const importExternalSemanticTerms = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../server/externalSemanticTerms.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

test('semantic prompts always request unified Google metadata while preserving enabled keyword targets', async () => {
  const semantic = await importExternalSemanticTerms();
  const article = {
    title: 'دليل التسويق بالمحتوى',
    plainText: 'محتوى عربي للاختبار',
    articleLanguage: 'ar',
    keywords: {
      primary: 'التسويق بالمحتوى',
      secondaries: [] as string[],
      company: 'بازارفان',
      lsi: [] as string[],
      googleTitles: [] as string[],
      googleDescriptions: [] as Array<{ text: string; callToAction: string }>,
    },
    goalContext: { pageType: 'guide', objective: 'educate' },
  };
  const template = [
    'الكلمة: {{primary_keyword}}',
    'اللغة: {{article_language}}',
    'السياق: {{goal_context}}',
    'القيود: {{protected_constraints}}',
    'أرجع JSON يحوي secondaries وlsi.',
  ].join('\n');

  const alternativesOnly = semantic.buildExternalSemanticPrompt(article, template, true, false);
  assert.match(alternativesOnly, /أنشئ الصيغ البديلة المطلوبة/);
  assert.match(alternativesOnly, /أنشئ كلمات LSI جديدة ضمن الأمر الموحد، لكن النظام لن يستبدل القائمة الحالية تلقائيًا/);
  assert.match(alternativesOnly, /أنشئ دائمًا googleTitles وgoogleDescriptions كاملتين/);

  const lsiOnly = semantic.buildExternalSemanticPrompt(article, template, false, true);
  assert.match(lsiOnly, /أنشئ صيغًا بديلة جديدة ضمن الأمر الموحد، لكن النظام لن يستبدل القائمة الحالية تلقائيًا/);
  assert.match(lsiOnly, /أنشئ كلمات LSI المطلوبة/);
  assert.match(lsiOnly, /أنشئ دائمًا googleTitles وgoogleDescriptions كاملتين/);

  const repair = semantic.buildExternalSemanticRepairPrompt(
    article,
    '{"secondaries":[],"lsi":[]}',
    template,
    false,
    true,
  );
  assert.equal((repair.match(/<requested_semantic_lists>/g) || []).length, 1);
  assert.match(repair, /أنشئ صيغًا بديلة جديدة ضمن الأمر الموحد، لكن النظام لن يستبدل القائمة الحالية تلقائيًا/);
  assert.match(repair, /أنشئ كلمات LSI المطلوبة/);
  assert.match(repair, /أنشئ دائمًا googleTitles وgoogleDescriptions كاملتين/);
});

test('content research automation is server-owned, settings-aware, and preserves manual actions', async () => {
  const [
    migration,
    semanticExecutor,
    competitorApi,
    externalApi,
    preparationExecutor,
    writingAutomation,
    workerGuard,
    discoveryExecutor,
    extractionExecutor,
    panel,
    card,
    competitorCoordinator,
  ] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260827030000_content_research_automation_settings.sql'),
    readWorkspaceFile('server/externalSemanticAnalysisExecutor.ts'),
    readWorkspaceFile('api/competitors.ts'),
    readWorkspaceFile('api/externalAnalysis.ts'),
    readWorkspaceFile('server/contentWritingCompetitorPreparationExecutor.ts'),
    readWorkspaceFile('server/contentWritingAutomation.ts'),
    readWorkspaceFile('server/contentResearchAutomationGuard.ts'),
    readWorkspaceFile('server/competitorDiscoveryExecutor.ts'),
    readWorkspaceFile('server/competitorExtractionExecutor.ts'),
    readWorkspaceFile('components/CompetitorDiscoveryPanel.tsx'),
    readWorkspaceFile('components/ExternalAnalysisCardControls.tsx'),
    readWorkspaceFile('server/competitorPreparationCoordinator.ts'),
  ]);

  for (const key of [
    'autoGenerateAlternativeKeywords',
    'autoGenerateLsiKeywords',
    'autoDiscoverCompetitors',
  ]) {
    assert.match(migration, new RegExp(`'${key}', true`));
  }
  assert.match(migration, /language sql\s+volatile/);
  assert.match(migration, /enqueue_external_semantic_analysis_job_controlled/);
  assert.match(migration, /promote_external_analysis_job_manual/);
  assert.match(migration, /enqueue_competitor_discovery_job_controlled/);
  assert.match(migration, /enqueue_competitor_extraction_job_controlled/);
  assert.match(migration, /create or replace function public\.enqueue_external_engineering_jobs_from_state/);
  assert.match(migration, /trigger enqueue_semantic_followup_after_completion/);
  assert.match(migration, /revoke all on function public\.enqueue_competitor_extraction_job_controlled/);
  assert.match(migration, /revoke all on function public\.promote_external_analysis_job_manual/);
  assert.match(migration, /grant execute on function public\.enqueue_competitor_extraction_job_controlled[\s\S]*to service_role/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);

  const manualPromotion = migration.slice(
    migration.indexOf('create or replace function public.promote_external_analysis_job_manual'),
    migration.indexOf('create or replace function public.enqueue_external_semantic_analysis_job_from_state'),
  );
  assert.match(manualPromotion, /duplicate_task_suppressed/);
  assert.ok((manualPromotion.match(/for update/g) || []).length >= 2);
  assert.match(manualPromotion, /origin = 'manual'/);
  assert.match(manualPromotion, /if v_job\.status = 'completed' then return v_job/);

  const completionCoordinator = migration.slice(
    migration.indexOf('create or replace function public.enqueue_semantic_followup_after_completion'),
    migration.indexOf('drop trigger if exists enqueue_semantic_followup_after_completion'),
  );
  assert.match(completionCoordinator, /enqueue_external_semantic_analysis_job_controlled/);
  assert.match(completionCoordinator, /enqueue_competitor_discovery_job_controlled/);
  assert.ok(
    completionCoordinator.indexOf('enqueue_external_semantic_analysis_job_controlled')
      < completionCoordinator.indexOf('enqueue_competitor_discovery_job_controlled'),
  );

  const controlledDiscovery = migration.slice(
    migration.indexOf('create or replace function public.enqueue_competitor_discovery_job_controlled'),
    migration.indexOf('create or replace function public.enqueue_competitor_extraction_job_controlled'),
  );
  const controlledExtraction = migration.slice(
    migration.indexOf('create or replace function public.enqueue_competitor_extraction_job_controlled'),
    migration.indexOf('create or replace function public.enqueue_semantic_followup_after_completion'),
  );
  for (const coordinator of [controlledDiscovery, controlledExtraction]) {
    assert.match(coordinator, /autoDiscoverCompetitors/);
    assert.match(coordinator, /semantic_job\.cancel_requested_at is null/);
    assert.match(coordinator, /autoGenerateAlternativeKeywords/);
    assert.match(coordinator, /keywords->'secondaries'/);
    assert.match(coordinator, /autoGenerateLsiKeywords/);
    assert.match(coordinator, /keywords->'lsi'/);
  }

  assert.match(semanticExecutor, /readContentResearchAutomationSettings/);
  assert.match(semanticExecutor, /automation_disabled/);
  assert.match(semanticExecutor, /const keepRequestedTerms/);
  assert.ok((semanticExecutor.match(/readContentResearchAutomationSettings\(\)/g) || []).length >= 2);
  assert.match(
    competitorApi,
    /action === 'ensure_discovery'[\s\S]*enqueue_competitor_discovery_job_controlled[\s\S]*p_origin:\s*'manual'/,
  );
  assert.match(
    externalApi,
    /enqueue_external_semantic_analysis_job_controlled'[\s\S]*p_origin:\s*'manual'/,
  );
  assert.match(
    externalApi,
    /promote_external_analysis_job_manual'[\s\S]*p_job_id:\s*jobId/,
  );
  const engineeringHandler = externalApi.slice(
    externalApi.indexOf('const enqueueEngineeringJobs'),
    externalApi.indexOf('const useDefaultEngineeringCommands'),
  );
  assert.match(
    engineeringHandler,
    /const needsSemanticPrerequisite = toStringList\(keywords\.secondaries\)[\s\S]*toStringList\(keywords\.lsi\)/,
  );
  assert.doesNotMatch(engineeringHandler, /activeCommands\.some\(command => command\.options\.targetKeywords\)/);
  assert.match(preparationExecutor, /enqueueCompetitorPreparationExtraction/);
  assert.match(competitorCoordinator, /enqueue_competitor_extraction_job_controlled/);
  assert.match(writingAutomation, /researchAutomation\.autoDiscoverCompetitors/);
  assert.match(workerGuard, /readContentResearchAutomationSettings/);
  assert.match(workerGuard, /semantic_keywords_lsi/);
  assert.match(workerGuard, /content_research_automation_changed/);
  assert.match(discoveryExecutor, /assertAutomaticCompetitorResearchAllowed\(context\.job\)/);
  assert.ok((extractionExecutor.match(/assertAutomaticCompetitorResearchAllowed\(context\.job\)/g) || []).length >= 2);
  assert.doesNotMatch(panel, /ensureArticleCompetitorDiscovery/);
  assert.doesNotMatch(panel, /ensuredDiscoverySignatureRef/);
  assert.doesNotMatch(card, /ensuredCompetitorSignatureRef/);
  assert.equal((card.match(/ensureArticleCompetitorDiscovery/g) || []).length, 2);
});
