import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  buildCompetitorComparisonMapPrompt,
  combineCompetitorComparisonMapResults,
  createCompetitorComparisonBatches,
  createCompetitorComparisonChunks,
  getCompetitorComparisonExpectedItemIds,
  parseCompetitorComparisonMapResponse,
  validateCompetitorComparisonSynthesisResponse,
  type CompetitorComparisonSource,
} from '../utils/competitorComparisonWorkflow.ts';

const source = (overrides: Partial<CompetitorComparisonSource> = {}): CompetitorComparisonSource => ({
  competitorNumber: 1,
  url: 'https://competitor.example/article',
  title: 'Competitor article',
  text: [
    'BEGINNING unique idea and evidence.',
    'MIDDLE unique idea and evidence.',
    'ENDING unique idea and evidence.',
  ].join('\n\n'),
  ...overrides,
});

test('independent competitor chunking keeps every idea marker and stable competitor IDs', () => {
  const longSource = source({
    text: Array.from({ length: 20 }, (_, index) => (
      `MARKER_${index + 1} ${'evidence '.repeat(500)}`
    )).join('\n\n'),
  });
  const chunks = createCompetitorComparisonChunks(longSource);
  const batches = createCompetitorComparisonBatches(longSource);
  const reconstructed = chunks.map(chunk => chunk.text).join('\n\n');

  assert.ok(chunks.length > 1);
  assert.ok(batches.length > 1);
  assert.deepEqual(
    chunks.map(chunk => chunk.id),
    chunks.map((_, index) => `competitor_1_chunk_${index + 1}`),
  );
  for (let index = 1; index <= 20; index += 1) {
    assert.match(reconstructed, new RegExp(`MARKER_${index}\\b`));
  }
});

test('one map prompt contains one competitor and requires exact chunk coverage', () => {
  const batch = createCompetitorComparisonBatches(source())[0];
  const prompt = buildCompetitorComparisonMapPrompt({
    articleContext: 'Current article text.',
    batch,
  });

  assert.match(prompt, /competitor_1/);
  assert.doesNotMatch(prompt, /competitor_2/);
  batch.chunks.forEach(chunk => assert.match(prompt, new RegExp(chunk.id)));

  const responseText = JSON.stringify({
    competitorId: 'competitor_1',
    processedChunkIds: batch.chunks.map(chunk => chunk.id),
    items: [{
      category: 'missing_idea',
      topic: 'Important topic',
      summary: 'The competitor covers an important missing topic.',
      articleStatus: 'missing',
      importance: 'high',
      entities: ['Entity'],
      articleEvidence: '',
      competitorEvidence: [{
        chunkId: batch.chunks[0].id,
        excerpt: 'BEGINNING unique idea and evidence.',
      }],
      confidence: 0.9,
    }],
  });
  const parsed = parseCompetitorComparisonMapResponse({ responseText, batch });
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.result?.items[0].id, 'competitor_1_item_1');

  const missingCoverage = parseCompetitorComparisonMapResponse({
    responseText: JSON.stringify({
      competitorId: 'competitor_1',
      processedChunkIds: [],
      items: [],
    }),
    batch,
  });
  assert.equal(missingCoverage.result, null);
  assert.match(missingCoverage.errors.join(','), /missing_chunks/);
});

test('AI synthesis is accepted only when every independent item is dispositioned once', () => {
  const batch = createCompetitorComparisonBatches(source())[0];
  const first = parseCompetitorComparisonMapResponse({
    batch,
    responseText: JSON.stringify({
      competitorId: 'competitor_1',
      processedChunkIds: batch.chunks.map(chunk => chunk.id),
      items: [{
        category: 'partial_idea',
        topic: 'Coverage depth',
        summary: 'The article covers the idea only partially.',
        articleStatus: 'partial',
        importance: 'medium',
        entities: [],
        articleEvidence: 'Partial article sentence.',
        competitorEvidence: [{
          chunkId: batch.chunks[0].id,
          excerpt: 'BEGINNING unique idea and evidence.',
        }],
        confidence: 0.8,
      }],
    }),
  }).result;
  assert.ok(first);
  const combined = combineCompetitorComparisonMapResults(1, [first!]);
  const expectedItemIds = getCompetitorComparisonExpectedItemIds([combined]);
  const valid = validateCompetitorComparisonSynthesisResponse({
    expectedItemIds,
    responseText: JSON.stringify({
      analysisMarkdown: '',
      patches: [{
        marker: 'patch_1',
        operation: 'append_to_article',
        title: 'Ready editor change',
        contentMarkdown: 'Directly applicable content.',
      }],
      itemDispositions: expectedItemIds.map(itemId => ({
        itemId,
        disposition: 'retained',
        clusterId: 'cluster_1',
        reason: 'Important unique result.',
      })),
      clusters: [],
    }),
  });
  assert.equal(valid.ok, true);

  const narrativeOnly = validateCompetitorComparisonSynthesisResponse({
    expectedItemIds,
    responseText: JSON.stringify({
      analysisMarkdown: 'Generic narrative report.',
      patches: [],
      itemDispositions: expectedItemIds.map(itemId => ({
        itemId,
        disposition: 'retained',
        clusterId: 'cluster_1',
        reason: 'Important unique result.',
      })),
    }),
  });
  assert.equal(narrativeOnly.ok, false);
  assert.match(narrativeOnly.errors.join(','), /analysis_markdown_must_be_empty/);
  assert.match(narrativeOnly.errors.join(','), /missing_patch_cards/);

  const missing = validateCompetitorComparisonSynthesisResponse({
    expectedItemIds,
    responseText: JSON.stringify({
      analysisMarkdown: 'Incomplete report.',
      patches: [],
      itemDispositions: [],
    }),
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingItemIds, expectedItemIds);
});

test('overlapping commands are retired from new execution but keep historical labels', async () => {
  const sourceText = await readFile(
    new URL('../constants/externalAnalysisCommands.ts', import.meta.url),
    'utf8',
  );
  assert.match(sourceText, /RETIRED_ENGINEERING_COMMAND_IDS/);
  assert.match(sourceText, /competitorGapAnalysis/);
  assert.match(sourceText, /combinedCommands/);
  assert.match(
    sourceText,
    /EXTERNAL_READY_COMMAND_DEFINITIONS = ALL_EXTERNAL_READY_COMMAND_DEFINITIONS\s*\.filter/,
  );
  assert.match(
    sourceText,
    /getExternalReadyCommandDefinition[\s\S]*ALL_EXTERNAL_READY_COMMAND_DEFINITIONS/,
  );
  const automaticBlock = sourceText.match(
    /EXTERNAL_AUTOMATIC_COMMAND_IDS = \[([\s\S]*?)\] as const;/,
  )?.[1] || '';
  assert.match(automaticBlock, /competitorContentComparison/);
  assert.doesNotMatch(automaticBlock, /competitorGapAnalysis|combinedCommands/);
  assert.match(sourceText, /RETIRED_COMMAND_LABEL_KEYS/);
  assert.match(sourceText, /مقارنة محتوى المنافسين/);
  assert.match(sourceText, /تجميعة الأوامر/);
});

test('only the comprehensive competitor command remains active and covers retired command scopes', async () => {
  const [engineeringSource, promptRegistrySource] = await Promise.all([
    readFile(new URL('../constants/engineeringPrompts.ts', import.meta.url), 'utf8'),
    readFile(new URL('../constants/promptRegistry.ts', import.meta.url), 'utf8'),
  ]);
  const activeDefinitionBlock = engineeringSource.match(
    /export const ENGINEERING_PROMPT_DEFINITIONS:[\s\S]*?= \[([\s\S]*?)\n\];\n\nexport const DEFAULT_ENGINEERING_PROMPTS/,
  )?.[1] || '';
  assert.match(activeDefinitionBlock, /competitorContentComparison/);
  assert.doesNotMatch(activeDefinitionBlock, /competitorGapAnalysis|combinedCommands/);
  assert.match(promptRegistrySource, /ENGINEERING_PROMPT_DEFINITIONS/);
  assert.match(promptRegistrySource, /sanitizeEngineeringPrompt/);

  const prompt = engineeringSource.match(
    /const COMPETITOR_CONTENT_COMPARISON_PROMPT = `([\s\S]*?)`;\n\nconst FULL_ARTICLE_SEO_AI_AUDIT_PROMPT/,
  )?.[1] || '';
  assert.ok(prompt.length > 0);
  [
    'نية البحث وعمق الإجابة',
    'نقاط التفوق والفجوات',
    'المواصفات التقنية',
    'E-E-A-T',
    'SEO وAEO/GEO/LLM',
    'أسئلة القرار والمقارنة والتكلفة',
    'جدول أو قائمة أو خطوات',
    'قوة التحويل وCTA',
    'أضعف قسم',
    'فكرة أصلية واحدة من الذكاء الاصطناعي',
    'قسمين على الأكثر من الأقسام الأقل ملاءمة',
    'الترتيب المقترح لعناوين H2',
    'مصفوفة مقارنة مختصرة',
    'صيغة النتيجة النهائية المباشرة',
    'analysisMarkdown سلسلة فارغة',
    'بطاقة patch مستقلة',
  ].forEach(requiredScope => assert.match(prompt, new RegExp(requiredScope)));
});

test('server workflow persists per-competitor maps without modifying content-writing modules', async () => {
  const [executor, migration, cleanupMigration, resumeMigration, resultsTab, aiContext, sidebar] = await Promise.all([
    readFile(new URL('../server/externalCompetitorComparisonExecutor.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260726020000_independent_competitor_engineering_analysis.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260726030000_comprehensive_competitor_command.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260726040000_competitor_analysis_resume_controls.sql', import.meta.url), 'utf8'),
    readFile(new URL('../components/ExternalAnalysisResultsTab.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../contexts/AIContext.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/RightSidebar.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(executor, /independent_per_competitor_ai_synthesis/);
  assert.match(executor, /ai_engineering_competitor_map_cache/);
  assert.match(executor, /buildCompetitorComparisonSynthesisPrompt/);
  assert.match(executor, /independentCompetitorResults: mapResults/);
  assert.match(executor, /analysisMarkdown: ''/);
  assert.doesNotMatch(executor, /contentWriting/i);
  assert.match(migration, /smartAnalysis\.competitorGapAnalysis/);
  assert.match(migration, /smartAnalysis\.combinedCommands/);
  assert.match(migration, /Historical completed results remain available/);
  assert.match(cleanupMigration, /Comprehensive competitor analysis/);
  assert.match(cleanupMigration, /returns table \(\s*catalog_order integer,/);
  assert.doesNotMatch(cleanupMigration, /returns table \(\s*sequence integer,/);
  assert.match(cleanupMigration, /- 'smartAnalysis\.competitorGapAnalysis'/);
  assert.match(cleanupMigration, /- 'smartAnalysis\.combinedCommands'/);
  assert.match(resumeMigration, /resume_external_analysis_job_now/);
  assert.match(resumeMigration, /status = 'queued'/);
  assert.match(resumeMigration, /source', 'manual_resume'/);
  assert.match(resultsTab, /نتيجة كل مقارنة مستقلة/);
  assert.match(resultsTab, /استئناف الآن/);
  assert.match(resultsTab, /COMPETITOR_COMPARISON_COMMAND_ID/);
  assert.match(aiContext, /runCompetitorComparisonReadyCommand/);
  assert.match(aiContext, /provider === 'chatgpt'/);
  assert.match(aiContext, /competitor_comparison_synthesis/);
  assert.match(sidebar, /isRetiredEngineeringCommandId/);
  assert.match(sidebar, /handleCompetitorComparisonAnalyze/);
});
