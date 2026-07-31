import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importCandidates = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/contentWritingCandidates.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

test('candidate evaluation treats missing ideas and blocked claims as hard gates', async () => {
  const { evaluateContentWritingCandidate } = await importCandidates();
  const evaluation = evaluateContentWritingCandidate({
    candidateIndex: 1,
    outputText: '## قسم مفيد\n\nنص موثق لكنه لم يغط كل الأفكار المطلوبة.',
    metadata: {
      sectionCoverage: {
        coveredIdeaIds: ['K001'],
        usedClaimIds: ['CL-BLOCKED'],
      },
    },
    requiredIdeaIds: ['K001', 'K002'],
    requiredClaimIds: ['CL001'],
    blockedClaimIds: ['CL-BLOCKED'],
    targetWordRange: { min: 8, max: 30 },
  });

  assert.equal(evaluation.passedHardGates, false);
  assert.ok(evaluation.hardFailures.includes('candidate_missing_required_ideas'));
  assert.ok(evaluation.hardFailures.includes('candidate_uses_blocked_claim'));
  assert.equal(evaluation.metrics.ideaCoveragePercent, 50);
  assert.equal(evaluation.metrics.blockedClaimCount, 1);
});
test('candidate selection prefers a hard-gate pass over a higher raw score failure', async () => {
  const {
    evaluateContentWritingCandidate,
    selectBestContentWritingCandidate,
  } = await importCandidates();
  const failed = evaluateContentWritingCandidate({
    candidateIndex: 1,
    outputText: 'Short polished text.',
    metadata: { sectionCoverage: { coveredIdeaIds: [] } },
    requiredIdeaIds: ['K001'],
  });
  const passed = evaluateContentWritingCandidate({
    candidateIndex: 2,
    outputText: 'Complete supported text that covers the required idea.',
    metadata: { sectionCoverage: { coveredIdeaIds: ['K001'] } },
    requiredIdeaIds: ['K001'],
  });
  const selected = selectBestContentWritingCandidate([
    { id: 'failed', evaluation: { ...failed, score: 99 } },
    { id: 'passed', evaluation: { ...passed, score: 70 } },
  ]);

  assert.equal(selected.id, 'passed');
});

test('candidate prompts enforce independent strategies without changing the output contract', async () => {
  const {
    buildContentWritingCandidatePrompt,
    getContentWritingCandidateStrategy,
  } = await importCandidates();
  const first = buildContentWritingCandidatePrompt({
    prompt: 'Return JSON only.',
    candidateIndex: 1,
    stageLabel: 'Section',
  });
  const second = buildContentWritingCandidatePrompt({
    prompt: 'Return JSON only.',
    candidateIndex: 2,
    stageLabel: 'Section',
  });

  assert.match(first, /منهج تغطية مباشر/);
  assert.match(first, /الكتابة المركّزة الشاملة/);
  assert.match(second, /مرشحًا مستقلًا حقًا/);
  assert.match(second, /الكتابة العميقة الاستقصائية/);
  assert.match(second, /لا تغيّر JSON أو Markdown المطلوب/);
  assert.notEqual(first, second);

  assert.equal(getContentWritingCandidateStrategy(1).key, 'focused_comprehensive');
  assert.equal(getContentWritingCandidateStrategy(2).key, 'deep_investigative');
});

test('single-candidate mode uses an explicit balanced writing strategy', async () => {
  const {
    buildContentWritingCandidatePrompt,
    getContentWritingCandidateStrategy,
  } = await importCandidates();
  const balanced = buildContentWritingCandidatePrompt({
    prompt: 'Return Markdown only.',
    candidateIndex: 0,
    stageLabel: 'Introduction',
  });

  assert.equal(getContentWritingCandidateStrategy(0).key, 'balanced');
  assert.match(balanced, /الكتابة المتوازنة/);
  assert.match(balanced, /حصر جميع الأفكار والأدلة والشروط المطلوبة/);
  assert.match(balanced, /لا تغيّر JSON أو Markdown المطلوب/);
});
