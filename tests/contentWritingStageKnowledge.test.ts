import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importStageKnowledge = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/contentWritingStageKnowledge.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const snapshot: any = {
  knowledge: {
    version: 3,
    items: [
      {
        id: 'K001',
        topic: 'الفكرة الأولى',
        detail: 'تفصيل الفكرة الأولى',
        kind: 'topic',
        priority: 'high',
        sourceChunkIds: ['C1-S001'],
        competitorNumbers: [1],
        coverageCount: 1,
        coverageLevel: 'single_competitor',
        originalityOpportunity: '',
      },
      {
        id: 'K002',
        topic: 'الفكرة الثانية',
        detail: 'تفصيل الفكرة الثانية',
        kind: 'topic',
        priority: 'medium',
        sourceChunkIds: ['C2-S001'],
        competitorNumbers: [2],
        coverageCount: 1,
        coverageLevel: 'single_competitor',
        originalityOpportunity: '',
      },
    ],
    competitorCoverageMatrix: {
      competitorNumbers: [1, 2],
      rows: [],
      coverageByCompetitor: [],
      allCompetitorIdeaIds: [],
      multipleCompetitorIdeaIds: [],
      singleCompetitorIdeaIds: ['K001', 'K002'],
      originalityOpportunityIdeaIds: [],
    },
    sourceRegistry: {
      version: 1,
      sources: [
        {
          id: 'SRC1',
          competitorNumber: 1,
          title: 'المصدر الأول',
          url: 'https://example.com/1',
          chunkIds: ['C1-S001'],
          category: 'industry',
          freshness: 'current',
          usePolicy: 'primary_support',
          assessmentNotes: '',
          supportedClaimIds: ['CL001'],
        },
        {
          id: 'SRC2',
          competitorNumber: 2,
          title: 'المصدر الثاني',
          url: 'https://example.com/2',
          chunkIds: ['C2-S001'],
          category: 'commercial',
          freshness: 'unknown',
          usePolicy: 'contextual_support',
          assessmentNotes: '',
          supportedClaimIds: ['CL002'],
        },
      ],
      primarySourceIds: ['SRC1'],
      contextualSourceIds: ['SRC2'],
      referenceOnlySourceIds: [],
    },
    claimLedger: {
      version: 1,
      claims: [
        {
          id: 'CL001',
          statement: 'الادعاء الأول',
          claimType: 'factual',
          riskLevel: 'low',
          knowledgeItemIds: ['K001'],
          supportingSourceChunkIds: ['C1-S001'],
          supportingSourceIds: ['SRC1'],
          competitorNumbers: [1],
          supportLevel: 'single_competitor',
          verificationStatus: 'single_competitor_reference',
          usagePolicy: 'allowed',
          usageGuidance: '',
        },
        {
          id: 'CL002',
          statement: 'الادعاء الثاني',
          claimType: 'factual',
          riskLevel: 'medium',
          knowledgeItemIds: ['K002'],
          supportingSourceChunkIds: ['C2-S001'],
          supportingSourceIds: ['SRC2'],
          competitorNumbers: [2],
          supportLevel: 'single_competitor',
          verificationStatus: 'single_competitor_reference',
          usagePolicy: 'qualify',
          usageGuidance: '',
        },
      ],
      blockedClaimIds: [],
      qualifiedClaimIds: ['CL002'],
      allowedClaimIds: ['CL001'],
    },
    processedChunkIds: ['C1-S001', 'C2-S001'],
    modelProcessedChunkIds: ['C1-S001', 'C2-S001'],
    fallbackChunkIds: [],
  },
  chunks: [
    {
      id: 'C1-S001',
      competitorNumber: 1,
      title: 'المصدر الأول',
      url: 'https://example.com/1',
      text: 'النص الأول',
    },
    {
      id: 'C2-S001',
      competitorNumber: 2,
      title: 'المصدر الثاني',
      url: 'https://example.com/2',
      text: 'النص الثاني',
    },
  ],
};

const step = (overrides: Record<string, unknown>): any => ({
  id: 'step-1',
  sessionId: 'session-1',
  stepKey: 'outline',
  stepType: 'outline',
  ordinal: 2,
  title: 'Outline',
  status: 'completed',
  promptText: '',
  outputText: '',
  metadata: {},
  attemptCount: 1,
  lastErrorCode: null,
  lastError: null,
  startedAt: null,
  completedAt: null,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

test('outline transparency distinguishes complete registries from the items selected by the plan', async () => {
  const { buildContentWritingStageKnowledgeUsage } = await importStageKnowledge();
  const usage = buildContentWritingStageKnowledgeUsage({
    step: step({
      outputText: JSON.stringify({
        sections: [{
          title: 'القسم الأول',
          brief: 'تفصيل القسم',
          requiredIdeaIds: ['K001'],
          requiredClaimIds: ['CL001'],
          sourceChunkIds: ['C1-S001'],
        }],
      }),
    }),
    snapshot,
  });

  assert.equal(usage.scope, 'complete');
  assert.equal(usage.referenceKind, 'planned');
  assert.deepEqual(usage.sentKnowledgeItemIds, ['K001', 'K002']);
  assert.deepEqual(usage.sentSourceChunkIds, []);
  assert.deepEqual(usage.referencedKnowledgeItemIds, ['K001']);
  assert.deepEqual(usage.referencedClaimIds, ['CL001']);
  assert.deepEqual(usage.referencedSourceIds, ['SRC1']);
});

test('section transparency records both targeted attachments and declared use', async () => {
  const { buildContentWritingStageKnowledgeUsage } = await importStageKnowledge();
  const usage = buildContentWritingStageKnowledgeUsage({
    step: step({
      stepKey: 'section-01',
      stepType: 'section',
      metadata: {
        sectionCoverage: {
          coveredIdeaIds: ['K001'],
          usedClaimIds: ['CL001'],
          usedSourceChunkIds: ['C1-S001'],
        },
      },
    }),
    snapshot,
    evidenceTrace: {
      version: 1,
      sectionKey: 'section-01',
      sectionTitle: 'القسم الأول',
      knowledgeItems: [snapshot.knowledge.items[0]],
      claims: [snapshot.knowledge.claimLedger.claims[0]],
      sourceChunks: [snapshot.chunks[0]],
    },
  });

  assert.equal(usage.scope, 'targeted');
  assert.equal(usage.referenceKind, 'declared_used');
  assert.deepEqual(usage.sentKnowledgeItemIds, ['K001', 'K002']);
  assert.deepEqual(usage.sentClaimIds, ['CL001', 'CL002']);
  assert.deepEqual(usage.sentSourceChunkIds, ['C1-S001']);
  assert.deepEqual(usage.referencedSourceIds, ['SRC1']);
});

test('free-form final stages expose the complete registries without inventing exact use', async () => {
  const { buildContentWritingStageKnowledgeUsage } = await importStageKnowledge();
  const usage = buildContentWritingStageKnowledgeUsage({
    step: step({
      stepKey: 'final-review',
      stepType: 'final_review',
    }),
    snapshot,
  });

  assert.equal(usage.scope, 'complete');
  assert.equal(usage.referenceKind, 'not_declared');
  assert.deepEqual(usage.sentKnowledgeItemIds, ['K001', 'K002']);
  assert.deepEqual(usage.sentSourceIds, ['SRC1', 'SRC2']);
  assert.deepEqual(usage.sentClaimIds, ['CL001', 'CL002']);
  assert.deepEqual(usage.sentSourceChunkIds, []);
  assert.deepEqual(usage.referencedKnowledgeItemIds, []);
});

test('structured revision stages distinguish planned evidence from evidence declared by applied edits', async () => {
  const { buildContentWritingStageKnowledgeUsage } = await importStageKnowledge();
  const revisionPlan = {
    operations: [{
      id: 'R001',
      requiredIdeaIds: ['K001'],
      requiredClaimIds: ['CL001'],
    }],
  };
  const planned = buildContentWritingStageKnowledgeUsage({
    step: step({
      stepKey: 'final-review',
      stepType: 'final_review',
      metadata: {
        revisionPhase: 'plan',
        revisionPlan,
      },
    }),
    snapshot,
  });
  const applied = buildContentWritingStageKnowledgeUsage({
    step: step({
      stepKey: 'final-review-apply',
      stepType: 'final_review',
      metadata: {
        revisionPhase: 'apply',
        revisionPlan,
        revisionEdits: [{
          coveredIdeaIds: ['K001'],
          usedClaimIds: ['CL001'],
          usedSourceChunkIds: ['C1-S001'],
        }],
      },
    }),
    snapshot,
  });

  assert.equal(planned.referenceKind, 'planned');
  assert.deepEqual(planned.referencedKnowledgeItemIds, ['K001']);
  assert.deepEqual(planned.referencedClaimIds, ['CL001']);
  assert.equal(applied.referenceKind, 'declared_used');
  assert.deepEqual(applied.referencedKnowledgeItemIds, ['K001']);
  assert.deepEqual(applied.referencedClaimIds, ['CL001']);
  assert.deepEqual(applied.referencedSourceChunkIds, ['C1-S001']);
  assert.deepEqual(applied.referencedSourceIds, ['SRC1']);
});
