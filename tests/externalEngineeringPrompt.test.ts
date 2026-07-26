import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildExternalEngineeringPrompt,
  getExternalEngineeringPromptMetrics,
  type ExternalEngineeringPromptInput,
} from '../server/externalEngineeringPrompt.ts';
import type { ExternalEngineeringCommand } from '../server/externalEngineeringCommands.ts';
import type { AiAnalysisOptions } from '../types.ts';
import { COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT } from '../utils/competitorContent.ts';
import { truncatePromptTextDistributed } from '../utils/promptText.ts';

const longText = (marker: string, length: number): string => (
  `${marker}\n${marker.repeat(Math.max(0, length - marker.length - 1))}`
);

const createInput = (): ExternalEngineeringPromptInput => ({
  title: 'عنوان اختبار فريد',
  plainText: `${longText('ARTICLE_START_', 28_000)}\nARTICLE_END_MARKER`,
  articleLanguage: 'ar',
  keywords: {
    primary: 'كلمة أساسية فريدة',
    secondaries: ['مرادف أول', 'مرادف ثان'],
    company: 'شركة اختبار فريدة',
    lsi: ['مصطلح دلالي أول', 'مصطلح دلالي ثان'],
  },
  goalContext: { objective: 'test-objective' },
  competitorUrls: Array.from({ length: 5 }, (_, index) => `https://example.com/${index + 1}`),
  competitorTexts: Array.from(
    { length: 5 },
    (_, index) => longText(`COMPETITOR_${index + 1}_`, 10_000),
  ),
});

const createCommand = (
  overrides: Partial<AiAnalysisOptions> = {},
  prompt = 'نفذ التحليل المطلوب.',
): ExternalEngineeringCommand => ({
  sequence: 1,
  id: 'smartAnalysis.test',
  label: 'أمر اختبار',
  prompt,
  options: {
    manualCommand: true,
    articleTitle: true,
    articleToc: false,
    currentConclusion: false,
    editorText: true,
    competitorContent: false,
    targetKeywords: true,
    companyName: false,
    goalContext: true,
    keywordCriteria: false,
    basicStructureCriteria: false,
    headingsSequenceCriteria: false,
    productPageCriteria: false,
    interactionCtaCriteria: false,
    conclusionCriteria: false,
    ...overrides,
  },
});

test('external engineering commands attach only the context selected by each command', () => {
  const input = createInput();
  const summaryCommand = createCommand({
    articleTitle: false,
    targetKeywords: false,
    goalContext: false,
  });

  const prompt = buildExternalEngineeringPrompt(summaryCommand, input);
  assert.match(prompt, /ARTICLE_START_/);
  assert.match(prompt, /ARTICLE_END_MARKER/);
  assert.doesNotMatch(prompt, /COMPETITOR_1_/);
  assert.doesNotMatch(prompt, /شركة اختبار فريدة/);
  assert.doesNotMatch(prompt, /test-objective/);
});

test('competitor context is capped and URL Context is only a missing-text fallback', () => {
  const input = createInput();
  const command = createCommand({ competitorContent: true });

  const prompt = buildExternalEngineeringPrompt(command, input);
  const metrics = getExternalEngineeringPromptMetrics(command, input, prompt);
  assert.ok(metrics.articleChars <= 20_100);
  assert.ok(metrics.competitorChars <= 32_500);
  assert.equal(metrics.usesUrlContextFallback, false);

  const urlOnlyInput: ExternalEngineeringPromptInput = { ...input, competitorTexts: [] };
  assert.equal(
    getExternalEngineeringPromptMetrics(command, urlOnlyInput).usesUrlContextFallback,
    true,
  );
});

test('external engineering excludes both text and URL for a dual extraction failure slot', () => {
  const input = createInput();
  input.competitorTexts[1] = COMPETITOR_DUAL_EXTRACTION_FAILURE_TEXT;
  input.competitorUrls[1] = 'https://failed-competitor.example/article';
  const command = createCommand({ competitorContent: true });

  const prompt = buildExternalEngineeringPrompt(command, input);
  assert.doesNotMatch(prompt, /\[تعذر استخراج محتوى المنافس\]/);
  assert.doesNotMatch(prompt, /failed-competitor\.example/);
  assert.match(prompt, /COMPETITOR_1_/);
  assert.match(prompt, /COMPETITOR_3_/);
});

test('a worst-case external engineering prompt stays below the bounded request budget', () => {
  const input = createInput();
  const command = createCommand({
    articleToc: true,
    currentConclusion: true,
    competitorContent: true,
    companyName: true,
  }, 'تعليمات مطولة.'.repeat(900));
  const size = buildExternalEngineeringPrompt(command, input).length;

  assert.ok(
    size < 80_000,
    `Worst-case external prompt was ${size} characters.`,
  );
});

test('competitor truncation preserves samples from the beginning, middle, and end', () => {
  const value = [
    'BEGINNING_MARKER',
    'أ'.repeat(12_000),
    'MIDDLE_MARKER',
    'ب'.repeat(12_000),
    'ENDING_MARKER',
  ].join('\n\n');
  const truncated = truncatePromptTextDistributed(value, 6_000);

  assert.equal(truncated.length, 6_000);
  assert.match(truncated, /BEGINNING_MARKER/);
  assert.match(truncated, /MIDDLE_MARKER/);
  assert.match(truncated, /ENDING_MARKER/);
});

test('smart analysis sends one unified output contract between 2,000 and 2,500 characters', async () => {
  const source = await readFile(
    new URL('../contexts/AIContext.tsx', import.meta.url),
    'utf8',
  );
  const contract = source.match(
    /const SMART_ANALYSIS_UNIFIED_OUTPUT_CONTRACT = `([\s\S]*?)`;/,
  )?.[1] || '';
  const builder = source.slice(
    source.indexOf('const buildSmartAnalysisFinalPrompt'),
    source.indexOf('const saveContentSummaryForCompetitors'),
  );

  assert.ok(contract.length >= 2_000 && contract.length <= 2_500);
  assert.match(builder, /SMART_ANALYSIS_UNIFIED_OUTPUT_CONTRACT/);
  assert.doesNotMatch(
    builder,
    /SMART_ANALYSIS_PATCH_OUTPUT_INSTRUCTION|SMART_ANALYSIS_INLINE_PATCH_OUTPUT_INSTRUCTION|READY_COMMAND_PATCH_CARD_REQUIREMENT/,
  );
});
