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

test('every multi-choice field has a common default that exists in its option list', async () => {
  const [{ getGoalContextFields }, { translations }, { INITIAL_GOAL_CONTEXT }] = await Promise.all([
    importWorkspaceModule('../utils/goalContext.ts'),
    importWorkspaceModule('../components/translations.ts'),
    importWorkspaceModule('../constants.ts'),
  ]);
  const multiChoiceFields = getGoalContextFields(translations.ar.goalTab)
    .filter((field: { kind: string }) => field.kind === 'multi-choice');

  for (const field of multiChoiceFields) {
    const defaultValues = String(INITIAL_GOAL_CONTEXT[field.key] || '').split(/\r?\n/).filter(Boolean);
    assert.ok(defaultValues.length > 0, `${field.key} must have a default value.`);
    assert.ok(
      defaultValues.every((value: string) => (
        field.options.some((option: { value: string }) => option.value === value)
      )),
      `${field.key} defaults must match visible options.`,
    );
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
  assert.match(source, /customValue/);
  assert.match(source, /event\.key === 'Enter'/);
  assert.match(source, /serializeGoalContextMultiValue/);
  assert.match(source, /multiChoiceSelect/);
});
