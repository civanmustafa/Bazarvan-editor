import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importWorkspaceModule = async (relativePath: string): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

test('smart brief keeps four core selectors and exposes nine reduced multi-choice fields', async () => {
  const [{ getGoalContextFields }, { translations }] = await Promise.all([
    importWorkspaceModule('../utils/goalContext.ts'),
    importWorkspaceModule('../components/translations.ts'),
  ]);
  const fields = getGoalContextFields(translations.ar.goalTab);
  const coreSelectors = fields
    .filter((field: { kind: string }) => field.kind === 'select')
    .map((field: { key: string }) => field.key);
  const multiChoiceFields = fields
    .filter((field: { kind: string }) => field.kind === 'multi-choice');

  assert.deepEqual(coreSelectors, ['pageType', 'objective', 'audienceScope', 'searchIntent']);
  assert.deepEqual(
    multiChoiceFields.map((field: { key: string }) => field.key),
    [
      'targetAudience',
      'audienceKnowledgeLevel',
      'audienceNeeds',
      'readerOutcome',
      'marketingStage',
      'uniqueAngle',
      'evidenceRequirements',
      'brandVoice',
      'topicSensitivity',
    ],
  );
  assert.ok(multiChoiceFields.every((field: { options: unknown[] }) => field.options.length >= 5));
  assert.ok(!fields.some((field: { key: string }) => field.key === 'desiredAction'));
  assert.ok(!fields.some((field: { key: string }) => field.key === 'freshnessRequirements'));
});

test('the smart brief starts empty while every multi-choice field keeps its options', async () => {
  const [{ getGoalContextFields }, { translations }, { INITIAL_GOAL_CONTEXT }] = await Promise.all([
    importWorkspaceModule('../utils/goalContext.ts'),
    importWorkspaceModule('../components/translations.ts'),
    importWorkspaceModule('../constants.ts'),
  ]);
  const multiChoiceFields = getGoalContextFields(translations.ar.goalTab)
    .filter((field: { kind: string }) => field.kind === 'multi-choice');

  assert.ok(Object.values(INITIAL_GOAL_CONTEXT).every(value => value === ''));
  assert.ok(multiChoiceFields.every((field: { options: unknown[] }) => field.options.length >= 5));
});

test('only the four core brief fields are required and optional defaults can be cleared', async () => {
  const {
    getSmartContentBriefMissingKeys,
    normalizeGoalContext,
    SMART_CONTENT_BRIEF_REQUIRED_KEYS,
    updateGoalContextField,
  } = await importWorkspaceModule('../utils/goalContext.ts');

  assert.deepEqual(
    SMART_CONTENT_BRIEF_REQUIRED_KEYS,
    ['pageType', 'objective', 'audienceScope', 'searchIntent'],
  );
  const initial = normalizeGoalContext();
  assert.deepEqual(getSmartContentBriefMissingKeys(initial), SMART_CONTENT_BRIEF_REQUIRED_KEYS);
  const completeCore = normalizeGoalContext({
    pageType: 'article',
    objective: 'educate',
    audienceScope: 'global',
    searchIntent: 'informational',
  });
  const withoutMarketingStage = updateGoalContextField(completeCore, 'marketingStage', '');
  const withoutKnowledgeLevel = updateGoalContextField(
    withoutMarketingStage,
    'audienceKnowledgeLevel',
    '',
  );

  assert.equal(withoutKnowledgeLevel.marketingStage, '');
  assert.equal(withoutKnowledgeLevel.audienceKnowledgeLevel, '');
  assert.equal(normalizeGoalContext(withoutKnowledgeLevel).marketingStage, '');
  assert.equal(normalizeGoalContext(withoutKnowledgeLevel).audienceKnowledgeLevel, '');
  assert.deepEqual(getSmartContentBriefMissingKeys(withoutKnowledgeLevel), []);
});

test('page objective and search intent use distinct perspectives and labels', async () => {
  const [{ getGoalContextFields, getGoalContextPresetOptions }, { translations }] = await Promise.all([
    importWorkspaceModule('../utils/goalContext.ts'),
    importWorkspaceModule('../components/translations.ts'),
  ]);

  for (const locale of ['ar', 'en'] as const) {
    const fields = getGoalContextFields(translations[locale].goalTab);
    const objective = fields.find((field: { key: string }) => field.key === 'objective');
    const searchIntent = fields.find((field: { key: string }) => field.key === 'searchIntent');
    assert.ok(objective && searchIntent);
    assert.ok(objective.kind === 'select' && searchIntent.kind === 'select');
    assert.ok(objective.helpText);
    assert.ok(searchIntent.helpText);

    const objectiveLabels = objective.options.map((option: { label: string }) => option.label);
    const intentLabels = searchIntent.options.map((option: { label: string }) => option.label);
    assert.equal(new Set(objectiveLabels).size, objectiveLabels.length);
    assert.equal(new Set(intentLabels).size, intentLabels.length);
    assert.deepEqual(
      objectiveLabels.filter((label: string) => intentLabels.includes(label)),
      [],
    );

    const presetLabels = getGoalContextPresetOptions(translations[locale].goalTab)
      .map((option: { label: string }) => option.label);
    assert.ok(presetLabels.every((label: string) => (
      locale === 'ar'
        ? label.includes('هدف:') && label.includes('نية:')
        : label.includes('Goal:') && label.includes('Intent:')
    )));
  }
});

test('multi-choice storage supports multiple selections, custom text, and case-insensitive deduplication', async () => {
  const {
    parseGoalContextMultiValue,
    serializeGoalContextMultiValue,
  } = await importWorkspaceModule('../utils/goalContext.ts');
  const serialized = serializeGoalContextMultiValue([
    'beginner',
    'احتياج مخصص يكتبه المستخدم',
    'BEGINNER',
    '  احتياج مخصص يكتبه المستخدم  ',
  ]);

  assert.equal(serialized, 'beginner\nاحتياج مخصص يكتبه المستخدم');
  assert.deepEqual(
    parseGoalContextMultiValue(serialized),
    ['beginner', 'احتياج مخصص يكتبه المستخدم'],
  );
});

test('legacy outcome/action and evidence/freshness values are merged without data loss', async () => {
  const {
    normalizeGoalContext,
    updateGoalContextField,
  } = await importWorkspaceModule('../utils/goalContext.ts');
  const normalized = normalizeGoalContext({
    readerOutcome: 'فهم الموضوع',
    desiredAction: 'طلب استشارة',
    evidenceRequirements: 'مصادر رسمية',
    freshnessRequirements: 'بيانات هذا العام',
  });

  assert.equal(normalized.readerOutcome, 'فهم الموضوع\nطلب استشارة');
  assert.equal(normalized.desiredAction, normalized.readerOutcome);
  assert.equal(normalized.evidenceRequirements, 'مصادر رسمية\nبيانات هذا العام');
  assert.equal(normalized.freshnessRequirements, normalized.evidenceRequirements);

  const updatedOutcome = updateGoalContextField(normalized, 'readerOutcome', 'اتخاذ قرار');
  const updatedEvidence = updateGoalContextField(normalized, 'evidenceRequirements', 'مصادر أولية');
  assert.equal(updatedOutcome.desiredAction, 'اتخاذ قرار');
  assert.equal(updatedEvidence.freshnessRequirements, 'مصادر أولية');
});

test('smart brief UI contains checkbox multi-select and a manual Enter-to-add input', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../components/GoalContextFields.tsx', import.meta.url)),
    'utf8',
  );

  assert.match(source, /type="checkbox"/);
  assert.match(source, /<option value="" disabled>/);
  assert.match(source, /selectPlaceholder/);
  assert.match(source, /customValue/);
  assert.match(source, /event\.key === 'Enter'/);
  assert.match(source, /serializeGoalContextMultiValue/);
  assert.match(source, /multiChoiceSelect/);
});

test('generated smart brief is stored in an independent editable card without replacing manual choices', async () => {
  const [goalTab, aiContext] = await Promise.all([
    readFile(fileURLToPath(new URL('../components/GoalTab.tsx', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../contexts/AIContext.tsx', import.meta.url)), 'utf8'),
  ]);

  assert.match(goalTab, /id="generated-content-brief"/);
  assert.match(goalTab, /value=\{goalContext\.generatedBrief\}/);
  assert.match(goalTab, /generatedBrief: result\.briefText/);
  assert.doesNotMatch(goalTab, /setGoalContext\(result\.context\)/);
  assert.match(aiContext, /Promise<\{ briefText\?: string/);
  assert.match(aiContext, /manual_choices_json/);
  assert.match(aiContext, /existing_generated_brief/);
  assert.match(aiContext, /return \{ briefText \}/);
  assert.doesNotMatch(aiContext, /normalizeGeneratedGoalContext/);
});

test('generated brief persists with the article but is excluded from reusable client defaults', async () => {
  const {
    normalizeClientGoalContexts,
    normalizeGoalContext,
  } = await importWorkspaceModule('../utils/goalContext.ts');
  const articleContext = normalizeGoalContext({
    pageType: 'article',
    objective: 'educate',
    audienceScope: 'global',
    searchIntent: 'informational',
    generatedBrief: '  موجز المقالة القابل للتحرير  ',
  });

  assert.equal(articleContext.generatedBrief, 'موجز المقالة القابل للتحرير');
  assert.equal(
    normalizeGoalContext({ contentBrief: 'موجز قديم' } as any).generatedBrief,
    'موجز قديم',
  );
  assert.equal(
    normalizeClientGoalContexts({ 'اسم العميل': articleContext })['اسم العميل'].generatedBrief,
    '',
  );
});
