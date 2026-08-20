import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importKnowledge = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/contentWritingKnowledge.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const importTransparency = async (): Promise<any> => {
  const entryPoints = [
    '../utils/contentWritingTransparency.ts',
    '../utils/contentWritingEvidence.ts',
  ];
  return Promise.all(entryPoints.map(async entryPoint => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(entryPoint, import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: false,
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  }));
};

test('competitor chunking preserves every source character with stable IDs', async () => {
  const {
    chunkContentWritingCompetitor,
    reconstructContentWritingCompetitor,
  } = await importKnowledge();
  const content = `${'فقرة عربية مفيدة.\n'.repeat(400)}END`;
  const chunks = chunkContentWritingCompetitor({
    competitorNumber: 2,
    title: 'Competitor',
    content,
    maximumCharacters: 500,
  });

  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].id, 'C2-S001');
  assert.equal(chunks.at(-1).id, `C2-S${String(chunks.length).padStart(3, '0')}`);
  assert.equal(reconstructContentWritingCompetitor(chunks), content);
});

test('source chunk normalization preserves competitors beyond the previous three-source limit', async () => {
  const { normalizeContentWritingSourceChunks } = await importKnowledge();
  const chunks = normalizeContentWritingSourceChunks([
    {
      id: 'C5-S001',
      competitorNumber: 5,
      title: 'Fifth competitor',
      url: 'https://example.com/five',
      text: 'A distinct fifth-competitor source.',
    },
  ]);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].competitorNumber, 5);
});

test('knowledge normalization deterministically covers chunks omitted by the model', async () => {
  const {
    chunkContentWritingCompetitor,
    normalizeContentWritingKnowledgeBase,
  } = await importKnowledge();
  const chunks = chunkContentWritingCompetitor({
    competitorNumber: 1,
    content: 'First source paragraph. '.repeat(150),
    maximumCharacters: 500,
  });
  const knowledge = normalizeContentWritingKnowledgeBase({
    processedChunkIds: [chunks[0].id],
    items: [{
      id: 'K001',
      topic: 'First idea',
      detail: 'Useful detail',
      sourceChunkIds: [chunks[0].id],
    }],
  }, chunks);

  assert.deepEqual(knowledge.processedChunkIds, chunks.map((chunk: { id: string }) => chunk.id));
  assert.equal(knowledge.fallbackChunkIds.length, chunks.length - 1);
  assert.equal(
    new Set(knowledge.items.flatMap((item: { sourceChunkIds: string[] }) => item.sourceChunkIds)).size,
    chunks.length,
  );
  const restored = normalizeContentWritingKnowledgeBase(knowledge, chunks);
  assert.deepEqual(restored.modelProcessedChunkIds, knowledge.modelProcessedChunkIds);
  assert.deepEqual(restored.fallbackChunkIds, knowledge.fallbackChunkIds);
});

test('transparency snapshot exposes the validated matrix, source policy, claims, and original excerpts', async () => {
  const modules = await importTransparency();
  const { buildContentWritingTransparencySnapshot } = modules.find((module: any) => (
    typeof module.buildContentWritingTransparencySnapshot === 'function'
  ));
  const chunks = [
    {
      id: 'C1-S001',
      competitorNumber: 1,
      title: 'Official source',
      url: 'https://example.com/official',
      text: 'Original supporting excerpt.',
    },
    {
      id: 'C2-S001',
      competitorNumber: 2,
      title: 'Commercial source',
      url: 'https://example.org/article',
      text: 'A second competitor excerpt.',
    },
  ];
  const snapshot = buildContentWritingTransparencySnapshot({
    competitorChunks: chunks,
    knowledgeValue: {
      processedChunkIds: chunks.map(chunk => chunk.id),
      items: [{
        id: 'K001',
        topic: 'Shared topic',
        detail: 'A reusable fact.',
        priority: 'high',
        sourceChunkIds: chunks.map(chunk => chunk.id),
      }],
      sourceAssessments: [
        { competitorNumber: 1, category: 'official', freshness: 'current' },
        { competitorNumber: 2, category: 'commercial', freshness: 'unknown' },
      ],
      claims: [{
        id: 'CL001',
        statement: 'A high-risk claim.',
        claimType: 'factual',
        riskLevel: 'high',
        knowledgeItemIds: ['K001'],
        supportingSourceChunkIds: ['C1-S001'],
      }],
    },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.chunks[0].text, 'Original supporting excerpt.');
  assert.equal(snapshot.knowledge.items[0].coverageLevel, 'all_competitors');
  assert.equal(snapshot.knowledge.sourceRegistry.sources[0].usePolicy, 'primary_support');
  assert.equal(snapshot.knowledge.sourceRegistry.sources[1].usePolicy, 'reference_only');
  assert.equal(snapshot.knowledge.claimLedger.claims[0].usagePolicy, 'qualify');
});

test('section evidence trace distinguishes available inputs from declared usage', async () => {
  const modules = await importTransparency();
  const { normalizeContentWritingEvidenceTrace, normalizeContentWritingSectionCoverage } = modules.find((module: any) => (
    typeof module.normalizeContentWritingEvidenceTrace === 'function'
  ));
  const trace = normalizeContentWritingEvidenceTrace({
    version: 1,
    sectionKey: 'section-01',
    sectionTitle: 'Section',
    knowledgeItems: [{
      id: 'K001',
      topic: 'Topic',
      detail: 'Detail',
      kind: 'topic',
      priority: 'high',
      sourceChunkIds: ['C1-S001'],
      competitorNumbers: [1],
      coverageLevel: 'single_competitor',
    }],
    claims: [],
    sourceChunks: [{
      id: 'C1-S001',
      competitorNumber: 1,
      title: 'Source',
      url: 'https://example.com',
      text: 'Exact excerpt.',
    }],
  });
  const usage = normalizeContentWritingSectionCoverage({
    coveredIdeaIds: ['K001'],
    usedSourceChunkIds: [],
    usedClaimIds: [],
  });

  assert.ok(trace);
  assert.equal(trace.sourceChunks[0].text, 'Exact excerpt.');
  assert.deepEqual(usage.coveredIdeaIds, ['K001']);
  assert.deepEqual(usage.usedSourceChunkIds, []);
});

test('competitor coverage matrix is derived from validated source chunks', async () => {
  const {
    contentWritingKnowledgeToPromptJson,
    normalizeContentWritingKnowledgeBase,
  } = await importKnowledge();
  const chunks = [
    { id: 'C1-S001', competitorNumber: 1, title: 'One', url: '', text: 'Shared idea from one.' },
    { id: 'C2-S001', competitorNumber: 2, title: 'Two', url: '', text: 'Shared idea from two.' },
    { id: 'C3-S001', competitorNumber: 3, title: 'Three', url: '', text: 'Shared idea from three.' },
  ];
  const knowledge = normalizeContentWritingKnowledgeBase({
    processedChunkIds: chunks.map(chunk => chunk.id),
    items: [
      {
        id: 'K001',
        topic: 'Shared idea',
        detail: 'Covered by every competitor.',
        priority: 'high',
        sourceChunkIds: chunks.map(chunk => chunk.id),
        competitorNumbers: [99],
        originalityOpportunity: 'Add a clearer actionable comparison.',
      },
      {
        id: 'K002',
        topic: 'Unique idea',
        detail: 'Covered by one competitor.',
        priority: 'medium',
        sourceChunkIds: ['C2-S001'],
        competitorNumbers: [1, 2, 3],
      },
    ],
  }, chunks);

  const shared = knowledge.items.find((item: { id: string }) => item.id === 'K001');
  const unique = knowledge.items.find((item: { id: string }) => item.id === 'K002');
  assert.deepEqual(shared.competitorNumbers, [1, 2, 3]);
  assert.equal(shared.coverageCount, 3);
  assert.equal(shared.coverageLevel, 'all_competitors');
  assert.deepEqual(unique.competitorNumbers, [2]);
  assert.equal(unique.coverageLevel, 'single_competitor');
  assert.deepEqual(knowledge.competitorCoverageMatrix.allCompetitorIdeaIds, ['K001']);
  assert.deepEqual(knowledge.competitorCoverageMatrix.singleCompetitorIdeaIds, ['K002']);
  assert.deepEqual(knowledge.competitorCoverageMatrix.originalityOpportunityIdeaIds, ['K001']);
  assert.deepEqual(
    knowledge.competitorCoverageMatrix.coverageByCompetitor.find(
      (item: { competitorNumber: number }) => item.competitorNumber === 2,
    ).knowledgeItemIds,
    ['K001', 'K002'],
  );

  const promptPayload = JSON.parse(contentWritingKnowledgeToPromptJson(knowledge));
  assert.deepEqual(promptPayload.competitorCoverageMatrix, knowledge.competitorCoverageMatrix);
  const restored = normalizeContentWritingKnowledgeBase(knowledge, chunks);
  assert.deepEqual(restored.competitorCoverageMatrix, knowledge.competitorCoverageMatrix);
});

test('knowledge ensemble summary exposes ideas contributed by the second reading alone', async () => {
  const {
    buildContentWritingKnowledgeEnsembleSummary,
    normalizeContentWritingKnowledgeBase,
  } = await importKnowledge();
  const chunks = [
    { id: 'C1-S001', competitorNumber: 1, title: 'One', url: '', text: 'Shared source detail.' },
    { id: 'C2-S001', competitorNumber: 2, title: 'Two', url: '', text: 'Unique payment condition.' },
  ];
  const firstPass = normalizeContentWritingKnowledgeBase({
    processedChunkIds: chunks.map(chunk => chunk.id),
    items: [{
      id: 'K001',
      topic: 'Shared topic',
      detail: 'Shared source detail.',
      sourceChunkIds: ['C1-S001'],
    }],
  }, chunks);
  const secondPass = normalizeContentWritingKnowledgeBase({
    processedChunkIds: chunks.map(chunk => chunk.id),
    items: [
      {
        id: 'K001',
        topic: 'Shared topic',
        detail: 'Shared source detail.',
        sourceChunkIds: ['C1-S001'],
      },
      {
        id: 'K002',
        topic: 'Payment condition',
        detail: 'A unique documented payment condition.',
        sourceChunkIds: ['C2-S001'],
      },
    ],
  }, chunks);
  const finalKnowledge = normalizeContentWritingKnowledgeBase({
    processedChunkIds: chunks.map(chunk => chunk.id),
    items: [
      {
        id: 'K001',
        topic: 'Shared topic',
        detail: 'Shared source detail.',
        sourceChunkIds: ['C1-S001'],
      },
      {
        id: 'K002',
        topic: 'Payment condition',
        detail: 'A unique documented payment condition.',
        sourceChunkIds: ['C2-S001'],
      },
    ],
  }, chunks);
  const summary = buildContentWritingKnowledgeEnsembleSummary({
    firstPass,
    secondPass,
    finalKnowledge,
    chunks,
  });

  assert.equal(summary.allChunksAccountedFor, true);
  assert.equal(summary.secondPassOnlyItemCount, 1);
  assert.equal(summary.sharedItemCount, 1);
});

test('section results and coverage audits accept only known persisted IDs', async () => {
  const {
    parseContentWritingCoverageAudit,
    parseContentWritingSectionResult,
  } = await importKnowledge();
  const section = parseContentWritingSectionResult(JSON.stringify({
    markdown: 'Useful section.',
    coveredIdeaIds: ['K001', 'UNKNOWN'],
    usedSourceChunkIds: ['C1-S001', 'UNKNOWN'],
    usedClaimIds: ['CL001', 'UNKNOWN'],
  }), ['K001'], ['C1-S001'], ['CL001']);
  assert.deepEqual(section.coverage, {
    coveredIdeaIds: ['K001'],
    usedSourceChunkIds: ['C1-S001'],
    usedClaimIds: ['CL001'],
    coveredEditorItemIds: [],
  });

  const audit = parseContentWritingCoverageAudit(JSON.stringify({
    missingIdeaIds: ['K001', 'UNKNOWN'],
    weakIdeaIds: [],
    unsupportedClaimIds: ['CL001', 'UNKNOWN'],
    blockedClaimIds: [],
    duplicateTopics: ['Repeated idea'],
    repairs: [{
      sectionKey: 'section-01',
      instructions: 'Add the missing supported explanation.',
      ideaIds: ['K001', 'UNKNOWN'],
      sourceChunkIds: ['C1-S001', 'UNKNOWN'],
      claimIds: ['CL001', 'UNKNOWN'],
    }],
  }), {
    validIdeaIds: ['K001'],
    validChunkIds: ['C1-S001'],
    validClaimIds: ['CL001'],
    validSectionKeys: ['section-01'],
  });

  assert.deepEqual(audit.missingIdeaIds, ['K001']);
  assert.deepEqual(audit.repairs[0].ideaIds, ['K001']);
  assert.deepEqual(audit.repairs[0].sourceChunkIds, ['C1-S001']);
  assert.deepEqual(audit.repairs[0].claimIds, ['CL001']);
  assert.deepEqual(audit.unsupportedClaimIds, ['CL001']);
});
