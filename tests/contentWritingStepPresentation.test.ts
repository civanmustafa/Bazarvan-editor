import assert from 'node:assert/strict';
import test from 'node:test';

const importPresentation = async (): Promise<any> => {
  process.env.NODE_ENV = 'test';
  return import(`../utils/contentWritingStepPresentation.ts?test=${Date.now()}-${Math.random()}`);
};

test('article outline presentation keeps the full dependency map for transparency', async () => {
  const { presentContentWritingOutline } = await importPresentation();
  const result = presentContentWritingOutline(JSON.stringify({
    sections: [{
      title: 'القسم الأول',
      brief: 'شرح واضح للقسم.',
      targetWords: 140,
      subheadings: ['عنوان فرعي'],
      requiredIdeaIds: ['K001'],
      requiredClaimIds: ['CL001'],
      sourceChunkIds: ['C1-S001'],
    }],
  }));
  assert.deepEqual(result, [{
    title: 'القسم الأول',
    brief: 'شرح واضح للقسم.',
    targetWords: 140,
    subheadings: ['عنوان فرعي'],
    requiredIdeaIds: ['K001'],
    requiredClaimIds: ['CL001'],
    sourceChunkIds: ['C1-S001'],
  }]);
});

test('coverage audit presentation keeps readable summaries and their exact evidence IDs', async () => {
  const { presentContentWritingCoverageAudit } = await importPresentation();
  const result = presentContentWritingCoverageAudit(JSON.stringify({
    missingIdeaIds: ['K001', 'K002'],
    weakIdeaIds: ['K003'],
    unsupportedClaimIds: ['CL001'],
    blockedClaimIds: [],
    duplicateTopics: ['موضوع مكرر'],
    repairs: [{
      sectionKey: 'section-02',
      instructions: 'أضف شرحًا عمليًا وأزل التكرار.',
      ideaIds: ['K001'],
      claimIds: ['CL001'],
      sourceChunkIds: ['C1-S001'],
    }],
  }));
  assert.ok(result);
  assert.equal(result.missingIdeaCount, 2);
  assert.deepEqual(result.missingIdeaIds, ['K001', 'K002']);
  assert.equal(result.repairs[0].instructions, 'أضف شرحًا عمليًا وأزل التكرار.');
  assert.deepEqual(result.repairs[0].ideaIds, ['K001']);
  assert.deepEqual(result.repairs[0].sourceChunkIds, ['C1-S001']);
});
