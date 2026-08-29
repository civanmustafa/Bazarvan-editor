import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readWorkspaceFile = (relativePath: string): Promise<string> => (
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
);

const assertBalancedSql = (sql: string): void => {
  let depth = 0;
  let singleQuoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'" && sql[index - 1] !== '\\') {
      if (singleQuoted && sql[index + 1] === "'") {
        index += 1;
        continue;
      }
      singleQuoted = !singleQuoted;
      continue;
    }
    if (singleQuoted) continue;
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    assert.ok(depth >= 0, `Unexpected closing parenthesis at character ${index}.`);
  }
  assert.equal(depth, 0, 'SQL contains mismatched parentheses.');
  assert.equal(singleQuoted, false, 'SQL contains an unterminated string literal.');
};

test('pipeline safety migration fences claims and atomically compares the server baseline', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260824010000_full_article_pipeline_safety.sql',
  );
  assertBalancedSql(migration);
  assert.match(migration, /lease_generation bigint not null default 0/);
  assert.match(migration, /lease_generation = job\.lease_generation \+ 1/);
  assert.match(migration, /pipeline_parent_job_id uuid/);
  assert.match(migration, /dead_lettered_at timestamptz/);
  assert.match(migration, /attempt_count < job\.max_attempts/);
  assert.match(migration, /pipeline\.status <> 'completed'/);
  assert.match(migration, /parent_pipeline_dead_lettered/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
  assert.match(migration, /baselineSaveCount'[\s\S]*v_article\.save_count/);
  assert.match(migration, /baselineContentHash'[\s\S]*v_baseline_hash/);
  assert.match(migration, /p_baseline_save_count is distinct from v_baseline_save_count/);
  assert.match(migration, /p_baseline_content_hash[\s\S]*is distinct from v_baseline_content_hash/);
  assert.doesNotMatch(migration, /v_article\.save_count <> v_baseline_save_count/);
  assert.doesNotMatch(migration, /where id = v_article\.id\s+and save_count = v_baseline_save_count/);
  assert.match(migration, /full_article_pipeline_content_hash\(content_json, content_html, plain_text\)[\s\S]*= v_baseline_content_hash/);
});

test('application requires live ownership, reviewed artifacts, quality, and valid TipTap JSON', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260824010000_full_article_pipeline_safety.sql',
  );
  const apply = migration.slice(migration.indexOf('create or replace function public.apply_full_article_pipeline_content'));
  assert.match(apply, /v_pipeline\.status <> 'running'/);
  assert.match(apply, /v_pipeline\.locked_by is distinct from btrim/);
  assert.match(apply, /v_pipeline\.lease_generation <> p_lease_generation/);
  assert.match(apply, /v_pipeline\.cancel_requested_at is not null/);
  assert.match(apply, /v_pipeline\.lease_expires_at is null/);
  assert.match(apply, /v_pipeline\.lease_expires_at <= now\(\)/);
  assert.match(apply, /v_session\.pipeline_parent_job_id is distinct from v_pipeline\.id/);
  assert.match(apply, /v_analysis\.pipeline_parent_job_id is distinct from v_pipeline\.id/);
  assert.match(apply, /v_analysis\.depends_on_job_id is distinct from v_pipeline\.id/);
  assert.match(apply, /v_analysis\.result->>'status' is distinct from 'completed'/);
  assert.match(apply, /blockingFailureCount/);
  assert.match(apply, /v_session\.quality_report is distinct from p_quality_report/);
  assert.match(apply, /v_session\.result_text is distinct from p_reviewed_markdown/);
  assert.match(apply, /reviewDraftHash/);
  assert.match(apply, /applicationContentHash/);
  assert.match(apply, /p_content_json->>'type' is distinct from 'doc'/);
  assert.match(migration, /drop function if exists public\.apply_full_article_pipeline_content\(uuid, uuid, text, text\)/);
});

test('pipeline resume and cancellation use durable parent-child records', async () => {
  const [migration, api, executor] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260824010000_full_article_pipeline_safety.sql'),
    readWorkspaceFile('api/externalAnalysis.ts'),
    readWorkspaceFile('server/fullArticlePipelineExecutor.ts'),
  ]);
  assert.match(migration, /resume_full_article_pipeline_job/);
  assert.match(migration, /resumeReason'[\s\S]*v_resume_code/);
  assert.match(migration, /resumeTargetId'[\s\S]*v_resume_target_id/);
  assert.match(migration, /contentWritingSessionId'[\s\S]*v_content_writing_session_id/);
  assert.match(migration, /max_attempts = greatest\(job\.max_attempts, job\.attempt_count \+ 3\)/);
  assert.match(migration, /request_full_article_pipeline_cancel/);
  assert.match(migration, /content_writing_sessions[\s\S]*pipeline_parent_job_id = v_job\.id/);
  assert.match(api, /existingJob\.job_type === 'full_article_pipeline'[\s\S]*resume_full_article_pipeline_job/);
  assert.match(api, /request_full_article_pipeline_cancel/);
  assert.match(executor, /savedProgress\.resumeTargetId/);
  assert.match(executor, /savedProgress\.retryReason/);
  assert.match(executor, /resumeTargetId === session\.id/);
  assert.match(executor, /resumeContentWritingAfterScheduledRetry/);
  assert.match(executor, /resumedAfterParentCancellation: true/);
  assert.doesNotMatch(executor, /context\.job\.last_error_code === 'full_pipeline_content_writing_failed'/);
});

test('generated draft is audited before the final reviewed application', async () => {
  const [executor, engineering] = await Promise.all([
    readWorkspaceFile('server/fullArticlePipelineExecutor.ts'),
    readWorkspaceFile('server/externalEngineeringAnalysisExecutor.ts'),
  ]);
  const auditIndex = executor.indexOf("reportStage(context, 'comprehensive_competitor_analysis', 6");
  const applyIndex = executor.indexOf("reportStage(context, 'article_application', 7");
  assert.ok(auditIndex > 0 && applyIndex > auditIndex);
  assert.match(executor, /reevaluateContentWritingQualityAfterExternalReview/);
  assert.match(executor, /configuration: frozenQualityConfiguration/);
  assert.match(executor, /sourceAccuracy,/);
  assert.match(executor, /plainText: prepared\.markdown/);
  assert.match(executor, /getContentWritingSourceAccuracyInput/);
  assert.match(executor, /patchApplication\.rejected\.length > 0/);
  assert.doesNotMatch(executor, /evaluateContentWritingEditorSourceCoverage/);
  assert.doesNotMatch(executor, /evaluateContentWritingEditorStructureCoverage/);
  assert.doesNotMatch(executor, /contentWritingEditorSource/);
  assert.match(executor, /preserveExistingArticleLinks/);
  assert.match(executor, /htmlToTipTapJson/);
  assert.match(executor, /full_pipeline_quality_review_required/);
  assert.match(executor, /full_pipeline_external_review_blocked/);
  assert.doesNotMatch(executor, /qualityGatePolicy: 'insert_regardless'/);
  assert.match(engineering, /getPipelineDraftSnapshot/);
  assert.match(engineering, /pipelineLeaseGeneration/);
  assert.match(engineering, /pipelineDraft\?\.plainText/);
});

test('pipeline completes both semantic keyword lists before content writing', async () => {
  const executor = await readWorkspaceFile('server/fullArticlePipelineExecutor.ts');
  assert.match(executor, /getSemanticKeywordReadiness/);
  assert.match(executor, /pass < 2 && !semanticReadiness\.ready/);
  assert.match(executor, /semanticJobIds\.includes\(semanticJobId\)/);
  assert.match(executor, /enqueue_full_article_pipeline_semantic/);
  assert.match(executor, /completionPass: pass \+ 1/);
  assert.match(executor, /full_pipeline_semantic_keywords_incomplete/);
  assert.match(executor, /missingFields: semanticReadiness\.missingFields/);
  assert.match(executor, /stageIndex < 6 \? \{ qualityGatePassed: null \}/);
  assert.match(executor, /typeof session\.quality_report\.passed === 'boolean'/);
  assert.doesNotMatch(executor, /text\(savedProgress\.semanticJobId\) \|\| await enqueueSemantic/);
});

test('coordinator waits and competitor inputs have bounded professional gates', async () => {
  const [executor, competitorCoordinator, api, migration] = await Promise.all([
    readWorkspaceFile('server/fullArticlePipelineExecutor.ts'),
    readWorkspaceFile('server/competitorPreparationCoordinator.ts'),
    readWorkspaceFile('api/externalAnalysis.ts'),
    readWorkspaceFile('supabase/migrations/20260824010000_full_article_pipeline_safety.sql'),
  ]);
  assert.match(executor, /FULL_ARTICLE_PIPELINE_STAGE_TIMEOUT_MS/);
  assert.match(executor, /full_pipeline_\$\{options\.stage\}_timeout/);
  assert.match(executor, /full_pipeline_content_writing_timeout/);
  assert.match(executor, /selectQualityContentWritingCompetitors/);
  assert.match(executor, /CONTENT_WRITING_MIN_COMPETITOR_COUNT/);
  assert.match(executor, /CONTENT_WRITING_MIN_DISTINCT_SOURCE_DOMAINS/);
  assert.match(executor, /full_pipeline_insufficient_competitor_content/);
  assert.match(executor, /competitorQualityAudit/);
  assert.match(executor, /replacementNeededCount/);
  assert.match(executor, /competitorInputsMustBeReplaced/);
  assert.match(executor, /enqueueCompetitorPreparationDiscovery/);
  assert.match(executor, /enqueueCompetitorPreparationExtraction/);
  assert.match(executor, /selectCompetitorPreparationSources/);
  assert.match(competitorCoordinator, /enqueue_full_article_pipeline_competitor_discovery/);
  assert.match(competitorCoordinator, /p_worker_id: request\.workerId/);
  assert.match(competitorCoordinator, /p_lease_generation: request\.leaseGeneration/);
  assert.match(executor, /forceRefresh: competitorInputsMustBeReplaced/);
  assert.match(executor, /Math\.max\(\s*CONTENT_WRITING_MIN_COMPETITOR_COUNT/);
  assert.match(api, /Math\.max\(\s*CONTENT_WRITING_MIN_COMPETITOR_COUNT/);
  assert.match(migration, /v_competitor_count integer := greatest\(3,/);
  assert.match(migration, /full-pipeline-discovery:[\s\S]*p_lease_generation/);
  assert.match(migration, /pipelineCompetitorRefresh', true/);
});

test('latest pipeline migration keeps company and manual goal choices optional only for the full workflow', async () => {
  const [migration, engine, executor] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260824020000_full_article_pipeline_optional_prerequisites.sql'),
    readWorkspaceFile('server/contentWritingEngine.ts'),
    readWorkspaceFile('server/fullArticlePipelineExecutor.ts'),
  ]);
  assertBalancedSql(migration);
  assert.match(migration, /create or replace function public\.enqueue_full_article_pipeline/);
  assert.doesNotMatch(migration, /company\/client name is required/i);
  assert.match(migration, /primary keyword is required/i);
  assert.match(migration, /notify pgrst, 'reload schema'/);
  assert.match(migration, /full_article_pipeline_schema_version/);
  assert.match(migration, /select 3/);
  assert.match(engine, /allowMissingCompany/);
  assert.match(engine, /allowMissingGoalContext/);
  assert.match(executor, /allowMissingCompany: true/);
  assert.match(executor, /allowMissingGoalContext: true/);
});

test('full workflow competitor discovery stays optional-company and pipeline-owned', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260824030000_full_article_pipeline_optional_discovery.sql',
  );
  assertBalancedSql(migration);
  assert.match(migration, /create or replace function public\.enqueue_full_article_pipeline_competitor_discovery/);
  assert.match(migration, /'companyName', coalesce\(v_article\.keywords->>'company', ''\)/);
  assert.match(migration, /'companyIsOptional', true/);
  assert.match(migration, /pipeline_parent_job_id = v_pipeline\.id/);
  assert.match(migration, /now\(\), v_pipeline\.id, 6/);
  assert.doesNotMatch(migration, /enqueue_competitor_discovery_job/);
  assert.doesNotMatch(migration, /competitor_discovery_ready/);
  assert.match(migration, /full_article_pipeline_schema_version/);
  assert.match(migration, /select 4/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test('full workflow semantic generation is optional-context, fenced, and independently repeatable', async () => {
  const [migration, semanticExecutor] = await Promise.all([
    readWorkspaceFile('supabase/migrations/20260825000000_full_article_pipeline_optional_semantic.sql'),
    readWorkspaceFile('server/externalSemanticAnalysisExecutor.ts'),
  ]);
  assertBalancedSql(migration);
  assert.match(migration, /create or replace function public\.enqueue_full_article_pipeline_semantic/);
  assert.match(migration, /v_pipeline\.lease_generation <> p_lease_generation/);
  assert.match(migration, /'sourceReadinessSignature', v_source_signature/);
  assert.match(migration, /'pipelineSemanticGeneration', true/);
  assert.match(migration, /'companyIsOptional', true/);
  assert.match(migration, /'goalContextIsOptional', true/);
  assert.match(migration, /pipeline_parent_job_id = v_pipeline\.id/);
  assert.match(migration, /':pass:' \|\| v_pass::text/);
  assert.match(migration, /full_article_pipeline_schema_version/);
  assert.match(migration, /select 5/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
  assert.match(semanticExecutor, /input\.pipelineSemanticGeneration === true/);
  assert.match(semanticExecutor, /input\.sourceReadinessSignature/);
});

test('background saves preserve generated semantic and brief fields under one row lock', async () => {
  const migration = await readWorkspaceFile(
    'supabase/migrations/20260824010000_full_article_pipeline_safety.sql',
  );
  const wrapper = migration.slice(migration.indexOf(
    'create or replace function public.save_article_snapshot_with_content_policy',
  ));
  assert.match(wrapper, /p_save_reason in \('auto', 'lifecycle'\)/);
  assert.match(wrapper, /article_access_level_for_user\(id, auth\.uid\(\)\) in \('write', 'admin'\)[\s\S]*for update/);
  assert.match(wrapper, /v_article\.keywords->'secondaries'/);
  assert.match(wrapper, /v_article\.keywords->'lsi'/);
  assert.match(wrapper, /v_article\.goal_context->>'generatedBrief'/);
  assert.match(wrapper, /return public\.save_article_snapshot\([\s\S]*v_snapshot/);
});

test('worker treats review blocks, dead letters, and ownership loss as distinct terminal paths', async () => {
  const [worker, queue, executor] = await Promise.all([
    readWorkspaceFile('server/externalAnalysisWorker.ts'),
    readWorkspaceFile('server/externalAnalysisQueue.ts'),
    readWorkspaceFile('server/externalAnalysisExecutor.ts'),
  ]);
  assert.match(executor, /class ExternalAnalysisBlockedError/);
  assert.match(executor, /class ExternalAnalysisOwnershipLostError/);
  assert.match(worker, /error instanceof ExternalAnalysisOwnershipLostError/);
  assert.match(worker, /error instanceof ExternalAnalysisBlockedError/);
  assert.match(worker, /blockExternalAnalysisJob/);
  assert.match(worker, /deadLetterExternalAnalysisJob/);
  assert.match(queue, /block_external_analysis_job/);
  assert.match(queue, /dead_letter_external_analysis_job/);
});
