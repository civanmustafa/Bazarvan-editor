import assert from 'node:assert/strict';
import test from 'node:test';

const importPresentation = async (): Promise<any> => {
  process.env.NODE_ENV = 'test';
  return import(`../utils/contentWritingKnowledgePresentation.ts?test=${Date.now()}-${Math.random()}`);
};

test('competitor knowledge output is converted to a plain-language presentation without technical IDs', async () => {
  const { presentContentWritingKnowledge } = await importPresentation();
  const result = presentContentWritingKnowledge(JSON.stringify({
    processedChunkIds: ['C1-S001', 'C2-S001', 'C3-S001'],
    items: [{
      id: 'K001',
      topic: 'موضوع مشترك',
      detail: 'تفصيل مفهوم للمستخدم.',
      priority: 'high',
      sourceChunkIds: ['C1-S001', 'C2-S001'],
      competitorNumbers: [1, 2],
      originalityOpportunity: 'إضافة مثال عملي.',
    }],
    sourceAssessments: [{
      competitorNumber: 1,
      category: 'commercial',
      freshness: 'current',
      assessmentNotes: 'مصدر حديث لكنه تجاري.',
    }],
    claims: [{
      id: 'CL001',
      statement: 'ادعاء يحتاج إلى تحقق.',
      claimType: 'statistic',
      riskLevel: 'high',
      supportingSourceChunkIds: ['C3-S001'],
      conflicting: false,
      usageGuidance: 'استخدمه بعد التحقق من مصدر مستقل.',
    }],
  }));

  assert.ok(result);
  assert.equal(result.processedChunkCount, 3);
  assert.equal(result.competitorCount, 3);
  assert.deepEqual(result.items[0].competitorNumbers, [1, 2]);
  assert.deepEqual(result.claims[0].competitorNumbers, [3]);
  assert.equal('id' in result.items[0], false);
  assert.equal('sourceChunkIds' in result.items[0], false);
});

test('competitor knowledge presentation accepts fenced model JSON and rejects unusable text', async () => {
  const { presentContentWritingKnowledge } = await importPresentation();
  assert.equal(presentContentWritingKnowledge('not json'), null);
  assert.equal(
    presentContentWritingKnowledge('```json\n{\"items\":[{\"topic\":\"فكرة\",\"detail\":\"شرح\"}]}\n```')?.items.length,
    1,
  );
});
