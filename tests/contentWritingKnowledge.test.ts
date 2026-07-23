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

test('section results and coverage audits accept only known persisted IDs', async () => {
  const {
    parseContentWritingCoverageAudit,
    parseContentWritingSectionResult,
  } = await importKnowledge();
  const section = parseContentWritingSectionResult(JSON.stringify({
    markdown: 'Useful section.',
    coveredIdeaIds: ['K001', 'UNKNOWN'],
    usedSourceChunkIds: ['C1-S001', 'UNKNOWN'],
  }), ['K001'], ['C1-S001']);
  assert.deepEqual(section.coverage, {
    coveredIdeaIds: ['K001'],
    usedSourceChunkIds: ['C1-S001'],
  });

  const audit = parseContentWritingCoverageAudit(JSON.stringify({
    missingIdeaIds: ['K001', 'UNKNOWN'],
    weakIdeaIds: [],
    duplicateTopics: ['Repeated idea'],
    repairs: [{
      sectionKey: 'section-01',
      instructions: 'Add the missing supported explanation.',
      ideaIds: ['K001', 'UNKNOWN'],
      sourceChunkIds: ['C1-S001', 'UNKNOWN'],
    }],
  }), {
    validIdeaIds: ['K001'],
    validChunkIds: ['C1-S001'],
    validSectionKeys: ['section-01'],
  });

  assert.deepEqual(audit.missingIdeaIds, ['K001']);
  assert.deepEqual(audit.repairs[0].ideaIds, ['K001']);
  assert.deepEqual(audit.repairs[0].sourceChunkIds, ['C1-S001']);
});
