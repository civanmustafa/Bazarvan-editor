import assert from 'node:assert/strict';
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

test('manual word ranges accept every supported separator and Arabic digits', async () => {
  const { parseContentWritingTargetWordRange } = await importWorkspaceModule(
    '../utils/contentWritingTargets.ts',
  );
  [
    '1200-1800',
    '1200.1800',
    '1200_1800',
    '1200*1800',
    '1200/1800',
    '1200،1800',
    '١٢٠٠-١٨٠٠',
    '۱۸۰۰/۱۲۰۰',
  ].forEach(value => {
    assert.deepEqual(parseContentWritingTargetWordRange(value), {
      min: 1_200,
      max: 1_800,
    });
  });
  assert.equal(parseContentWritingTargetWordRange('1200 words'), null);
  assert.equal(parseContentWritingTargetWordRange(''), null);
});

test('automatic target uses the largest actual competitor text times 1.20 with ten percent tolerance', async () => {
  const {
    CONTENT_WRITING_AUTOMATIC_WORD_MULTIPLIER,
    CONTENT_WRITING_AUTOMATIC_WORD_TOLERANCE,
    resolveContentWritingLengthTarget,
  } = await importWorkspaceModule('../utils/contentWritingTargets.ts');
  const words = (count: number, prefix: string): string => Array.from(
    { length: count },
    (_, index) => `${prefix}${index}`,
  ).join(' ');
  const target = resolveContentWritingLengthTarget({
    manualRange: '',
    competitors: [
      { position: 1, title: 'Short', url: 'https://one.example', content: words(700, 'a') },
      { position: 2, title: 'Largest', url: 'https://two.example', content: words(1_000, 'b') },
      { position: 3, title: 'Medium', url: 'https://three.example', content: words(850, 'c') },
    ],
  });

  assert.equal(CONTENT_WRITING_AUTOMATIC_WORD_MULTIPLIER, 1.2);
  assert.equal(CONTENT_WRITING_AUTOMATIC_WORD_TOLERANCE, 0.1);
  assert.equal(target.mode, 'automatic');
  assert.equal(target.baselineCompetitor.position, 2);
  assert.equal(target.baselineCompetitor.wordCount, 1_000);
  assert.equal(target.centerWords, 1_200);
  assert.deepEqual(target.targetWords, { min: 1_080, max: 1_320 });
  assert.equal(target.automaticTolerancePercent, 10);
});

test('manual range remains authoritative while section limits grow dynamically', async () => {
  const {
    deriveContentWritingOutlineSections,
    resolveContentWritingLengthTarget,
  } = await importWorkspaceModule('../utils/contentWritingTargets.ts');
  const manual = resolveContentWritingLengthTarget({
    manualRange: '1200/1800',
    competitors: [{ position: 1, content: 'competitor text '.repeat(2_000) }],
  });
  const shorter = deriveContentWritingOutlineSections({ min: 800, max: 1_000 });
  const longer = deriveContentWritingOutlineSections({ min: 2_400, max: 3_000 });

  assert.equal(manual.mode, 'manual');
  assert.deepEqual(manual.targetWords, { min: 1_200, max: 1_800 });
  assert.deepEqual(manual.outlineSections, { min: 5, max: 8, preferred: 6 });
  assert.ok(longer.preferred > shorter.preferred);
  assert.ok(longer.max > 5);
});

test('runtime quality configuration and body section budgets use the resolved target', async () => {
  const [
    {
      applyContentWritingLengthTargetToQualityConfiguration,
      resolveContentWritingLengthTarget,
    },
    {
      normalizeContentWritingQualityConfiguration,
    },
    {
      balanceContentWritingOutlineWordTargets,
    },
  ] = await Promise.all([
    importWorkspaceModule('../utils/contentWritingTargets.ts'),
    importWorkspaceModule('../constants/contentWritingQuality.ts'),
    importWorkspaceModule('../utils/contentWritingWorkflow.ts'),
  ]);
  const target = resolveContentWritingLengthTarget({
    manualRange: '1200-1800',
    competitors: [{ position: 1, content: 'text '.repeat(900) }],
  });
  const runtime = applyContentWritingLengthTargetToQualityConfiguration(
    normalizeContentWritingQualityConfiguration(),
    target,
  );
  const roundTripped = normalizeContentWritingQualityConfiguration(runtime);
  const outline = balanceContentWritingOutlineWordTargets({
    sections: Array.from({ length: 6 }, (_, index) => ({
      title: `Section ${index + 1}`,
      brief: `Brief ${index + 1}`,
      requiredIdeaIds: Array.from({ length: index === 0 ? 5 : 1 }, (__, ideaIndex) => (
        `K${index}-${ideaIndex}`
      )),
    })),
  }, target.targetWords);
  const bodyTarget = outline.sections.reduce(
    (sum: number, section: { targetWords: number }) => sum + section.targetWords,
    0,
  );

  assert.deepEqual(roundTripped.policy.targetWords, { min: 1_200, max: 1_800 });
  assert.deepEqual(roundTripped.policy.outlineSections, { min: 5, max: 8 });
  assert.equal(bodyTarget, 1_150);
  assert.ok(outline.sections.every((section: { targetWords: number }) => (
    section.targetWords >= 80 && section.targetWords <= 300
  )));
  assert.ok(outline.sections[0].targetWords > outline.sections[1].targetWords);
});

test('editor standards use the manual word range as a strict pass/fail criterion', async () => {
  const { checkWordCount } = await importWorkspaceModule(
    '../utils/analysis/rules/checkWordCount.ts',
  );
  const baseContext = {
    analysisGoal: '',
    goalContext: { targetWordRange: '1200*1800' },
    uiLanguage: 'ar',
    t: {
      structureAnalysis: {
        'عدد الكلمات': {
          title: 'عدد الكلمات',
          description: '',
          required: '',
        },
      },
      common: {
        range: (min: number, max: number) => `${min}-${max}`,
      },
    },
  };

  const inside = checkWordCount({ ...baseContext, totalWordCount: 1_500 });
  const below = checkWordCount({ ...baseContext, totalWordCount: 1_199 });
  const above = checkWordCount({ ...baseContext, totalWordCount: 1_801 });

  assert.equal(inside.status, 'pass');
  assert.equal(inside.required, '1200-1800');
  assert.equal(below.status, 'fail');
  assert.equal(above.status, 'fail');
});

test('editor H2 standard follows the dynamic section range for a manual target', async () => {
  const { checkH2Count } = await importWorkspaceModule(
    '../utils/analysis/rules/checkH2Count.ts',
  );
  const heading = (index: number) => ({
    level: 2,
    text: `Section ${index + 1}`,
    pos: index,
    nodeSize: 1,
  });
  const baseContext = {
    totalWordCount: 1_500,
    goalContext: { targetWordRange: '1200-1800' },
    uiLanguage: 'en',
    t: {
      structureAnalysis: {
        'عدد H2': {
          title: 'H2 count',
          description: '',
          required: '',
        },
      },
      common: {
        range: (min: number, max: number) => `${min}-${max}`,
      },
      violationMessages: {
        h2Count: (current: number, required: string) => `${current}/${required}`,
      },
    },
  };

  const inside = checkH2Count({
    ...baseContext,
    headings: Array.from({ length: 7 }, (_, index) => heading(index)),
  });
  const outside = checkH2Count({
    ...baseContext,
    headings: Array.from({ length: 11 }, (_, index) => heading(index)),
  });

  assert.equal(inside.status, 'pass');
  assert.equal(inside.required, '7-10');
  assert.equal(outside.status, 'fail');
});
