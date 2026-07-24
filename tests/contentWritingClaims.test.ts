import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importClaims = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/contentWritingClaims.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const chunks = [
  { id: 'C1-S001', competitorNumber: 1, title: 'Official', url: 'https://official.example', text: 'Official fact.' },
  { id: 'C2-S001', competitorNumber: 2, title: 'Commercial', url: 'https://commercial.example', text: 'Commercial statistic.' },
  { id: 'C3-S001', competitorNumber: 3, title: 'Community', url: 'https://community.example', text: 'Conflicting comparison.' },
];

const items = [
  {
    id: 'K001',
    topic: 'Fact',
    detail: 'A supported fact.',
    kind: 'claim',
    priority: 'high',
    sourceChunkIds: ['C1-S001', 'C2-S001'],
    competitorNumbers: [1, 2],
    coverageCount: 2,
    coverageLevel: 'multiple_competitors',
    originalityOpportunity: '',
  },
  {
    id: 'K002',
    topic: 'Statistic',
    detail: 'A statistic needing verification.',
    kind: 'evidence',
    priority: 'medium',
    sourceChunkIds: ['C2-S001'],
    competitorNumbers: [2],
    coverageCount: 1,
    coverageLevel: 'single_competitor',
    originalityOpportunity: '',
  },
];

test('source and claim engine derives safe policies from validated evidence links', async () => {
  const { normalizeContentWritingSourceClaims } = await importClaims();
  const normalized = normalizeContentWritingSourceClaims({
    value: {
      sourceAssessments: [
        { competitorNumber: 1, category: 'official', freshness: 'current' },
        { competitorNumber: 2, category: 'commercial', freshness: 'current' },
        { competitorNumber: 99, category: 'government', freshness: 'current' },
      ],
      claims: [
        {
          id: 'CL001',
          statement: 'A low-risk fact supported by two competitors.',
          claimType: 'factual',
          riskLevel: 'low',
          knowledgeItemIds: ['K001'],
          supportingSourceChunkIds: ['C1-S001', 'C2-S001'],
        },
        {
          id: 'CL002',
          statement: 'A statistic from one commercial reference.',
          claimType: 'statistic',
          riskLevel: 'medium',
          knowledgeItemIds: ['K002'],
          supportingSourceChunkIds: ['C2-S001'],
        },
        {
          id: 'CL003',
          statement: 'A legal claim remains high impact.',
          claimType: 'legal',
          riskLevel: 'low',
          knowledgeItemIds: ['K001'],
          supportingSourceChunkIds: ['C1-S001'],
        },
        {
          id: 'CL004',
          statement: 'The available references conflict.',
          claimType: 'comparison',
          riskLevel: 'medium',
          knowledgeItemIds: ['K001'],
          supportingSourceChunkIds: ['C2-S001', 'C3-S001'],
          conflicting: true,
        },
      ],
    },
    items,
    chunks,
  });

  assert.equal(normalized.sourceRegistry.sources.length, 3);
  assert.deepEqual(normalized.sourceRegistry.primarySourceIds, ['SRC1']);
  assert.deepEqual(normalized.sourceRegistry.referenceOnlySourceIds, ['SRC2', 'SRC3']);
  assert.equal(normalized.claimLedger.claims[0].supportLevel, 'multiple_competitors');
  assert.equal(normalized.claimLedger.claims[0].usagePolicy, 'allowed');
  assert.equal(normalized.claimLedger.claims[1].verificationStatus, 'requires_external_verification');
  assert.equal(normalized.claimLedger.claims[1].usagePolicy, 'blocked');
  assert.equal(normalized.claimLedger.claims[2].usagePolicy, 'blocked');
  assert.equal(normalized.claimLedger.claims[3].verificationStatus, 'conflicting');
  assert.deepEqual(normalized.claimLedger.blockedClaimIds, ['CL002', 'CL003', 'CL004']);
  assert.deepEqual(
    normalized.sourceRegistry.sources.find(
      (source: { id: string }) => source.id === 'SRC2',
    ).supportedClaimIds,
    ['CL001', 'CL002', 'CL004'],
  );
});

test('claim selection and usage summaries accept only persisted claim IDs', async () => {
  const {
    normalizeContentWritingSourceClaims,
    selectContentWritingClaims,
    summarizeContentWritingClaimUsage,
  } = await importClaims();
  const normalized = normalizeContentWritingSourceClaims({
    value: {
      claims: [{
        id: 'CL001',
        statement: 'A persisted claim.',
        claimType: 'factual',
        riskLevel: 'low',
        knowledgeItemIds: ['K001'],
        supportingSourceChunkIds: ['C1-S001', 'C2-S001'],
      }],
    },
    items,
    chunks,
  });

  assert.deepEqual(
    selectContentWritingClaims({
      claimLedger: normalized.claimLedger,
      knowledgeItemIds: ['K001'],
    }).map((claim: { id: string }) => claim.id),
    ['CL001'],
  );
  assert.deepEqual(
    summarizeContentWritingClaimUsage({
      claimLedger: normalized.claimLedger,
      usedClaimIds: ['CL001', 'UNKNOWN'],
    }),
    {
      usedClaimIds: ['CL001'],
      allowedClaimIds: ['CL001'],
      qualifiedClaimIds: [],
      blockedClaimIds: [],
    },
  );
});
