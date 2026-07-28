import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ContentWritingKnowledgeBase } from '../utils/contentWritingKnowledge';
import type { ContentWritingQualityReport } from '../utils/contentWritingQuality';

const importRevision = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/contentWritingRevision.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const outline = {
  sections: [
    { title: 'القسم الأول', brief: 'الأول' },
    { title: 'القسم الثاني', brief: 'الثاني' },
    { title: 'القسم الثالث', brief: 'الثالث' },
    { title: 'القسم الرابع', brief: 'الرابع' },
  ],
};

const markdown = [
  '# عنوان المقالة',
  '',
  'مقدمة أولى سليمة.',
  '',
  'مقدمة ثانية سليمة.',
  '',
  '## القسم الأول',
  '',
  'فقرة أولى تحتاج تعديلًا.',
  '',
  'فقرة ثانية يجب أن تبقى كما هي.',
  '',
  '## القسم الثاني',
  '',
  'نص القسم الثاني السليم.',
  '',
  '## القسم الثالث',
  '',
  'نص القسم الثالث السليم.',
  '',
  '## القسم الرابع',
  '',
  'نص القسم الرابع السليم.',
  '',
  '## الأسئلة الشائعة',
  '',
  'إجابة سليمة.',
  '',
  '## الخاتمة',
  '',
  'خاتمة سليمة.',
].join('\n');

const report = (
  score: number,
  statuses: Record<string, 'pass' | 'warn' | 'fail'>,
): ContentWritingQualityReport => ({
  policyVersion: 1,
  minimumScore: 80,
  score,
  passed: score >= 80,
  blockingFailureCount: Object.values(statuses).filter(status => status === 'fail').length,
  failedCount: Object.values(statuses).filter(status => status === 'fail').length,
  warningCount: Object.values(statuses).filter(status => status === 'warn').length,
  passedCount: Object.values(statuses).filter(status => status === 'pass').length,
  wordCount: 1_200,
  repairPasses: 0,
  criteria: Object.entries(statuses).map(([id, status]) => ({
    id,
    title: id,
    status,
    severity: 'important',
    weight: 1,
    current: 1,
    required: 1,
    violationCount: status === 'fail' ? 1 : 0,
    messages: [] as string[],
  })),
  generatedAt: new Date(0).toISOString(),
});

const knowledge: ContentWritingKnowledgeBase = {
  version: 3,
  items: [
    {
      id: 'K001',
      topic: 'الفكرة الأولى',
      detail: 'تفصيل',
      kind: 'fact',
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
      detail: 'تفصيل',
      kind: 'fact',
      priority: 'high',
      sourceChunkIds: ['C1-S002'],
      competitorNumbers: [1],
      coverageCount: 1,
      coverageLevel: 'single_competitor',
      originalityOpportunity: '',
    },
  ],
  competitorCoverageMatrix: {
    competitorNumbers: [1],
    rows: [],
    coverageByCompetitor: [],
    allCompetitorIdeaIds: [],
    multipleCompetitorIdeaIds: [],
    singleCompetitorIdeaIds: ['K001', 'K002'],
    originalityOpportunityIdeaIds: [],
  },
  sourceRegistry: {
    version: 1,
    sources: [],
    primarySourceIds: [],
    contextualSourceIds: [],
    referenceOnlySourceIds: [],
  },
  claimLedger: {
    version: 1,
    claims: [{
      id: 'CL-BLOCKED',
      statement: 'هذا ادعاء محظور لا يجوز إدخاله',
      claimType: 'factual',
      riskLevel: 'high',
      knowledgeItemIds: ['K001'],
      supportingSourceChunkIds: [],
      supportingSourceIds: [],
      competitorNumbers: [1],
      supportLevel: 'single_competitor',
      verificationStatus: 'requires_external_verification',
      usagePolicy: 'blocked',
      usageGuidance: 'احذفه',
    }],
    allowedClaimIds: [],
    qualifiedClaimIds: [],
    blockedClaimIds: ['CL-BLOCKED'],
    externallyVerifiableClaimIds: ['CL-BLOCKED'],
    claimsByKnowledgeItem: [],
  },
  processedChunkIds: ['C1-S001', 'C1-S002'],
  modelProcessedChunkIds: ['C1-S001', 'C1-S002'],
  fallbackChunkIds: [],
};

test('service revision documents expose the final CTA as a stable targeted region', async () => {
  const { buildContentWritingRevisionDocument } = await importRevision();
  const serviceMarkdown = markdown
    .replace('## الخاتمة\n\nخاتمة سليمة.', [
      '## اطلب خدمات التحول الرقمي الآن',
      '',
      'دعوة إجراء سليمة.',
    ].join('\n'));
  const document = buildContentWritingRevisionDocument({
    markdown: serviceMarkdown,
    outline,
    goalContext: { pageType: 'service' },
  });
  const target = document.targets.find((item: { id: string }) => item.id === 'call-to-action');

  assert.equal(target?.kind, 'call_to_action');
  assert.match(target?.markdown || '', /اطلب خدمات التحول الرقمي/);
});

test('targeted revision applies only the selected paragraph and preserves every healthy region', async () => {
  const {
    applyContentWritingRevisionEdits,
    buildContentWritingRevisionDocument,
    parseContentWritingRevisionEdits,
    parseContentWritingRevisionPlan,
  } = await importRevision();
  const document = buildContentWritingRevisionDocument({ markdown, outline });
  const plan = parseContentWritingRevisionPlan({
    operations: [{
      id: 'R001',
      scope: 'local',
      action: 'replace',
      targetId: 'section-01:block-01',
      instructions: 'أصلح الفقرة فقط.',
    }],
  }, document);
  const edits = parseContentWritingRevisionEdits({
    edits: [{
      operationId: 'R001',
      replacementMarkdown: 'فقرة أولى مصححة دون لمس غيرها.',
      coveredIdeaIds: ['K001'],
      usedSourceChunkIds: ['C1-S001'],
      usedClaimIds: [],
    }],
  }, plan);
  const application = applyContentWritingRevisionEdits(document, edits);

  assert.deepEqual(application.errors, []);
  assert.equal(application.appliedEdits.length, 1);
  assert.match(application.candidateMarkdown, /فقرة أولى مصححة دون لمس غيرها/);
  assert.doesNotMatch(application.candidateMarkdown, /فقرة أولى تحتاج تعديلًا/);
  assert.match(application.candidateMarkdown, /فقرة ثانية يجب أن تبقى كما هي/);
  assert.match(application.candidateMarkdown, /نص القسم الرابع السليم/);
  assert.match(application.candidateMarkdown, /خاتمة سليمة/);
});

test('revision plan rejects article-wide and structurally unsafe local targets', async () => {
  const {
    buildContentWritingRevisionDocument,
    parseContentWritingRevisionPlan,
  } = await importRevision();
  const document = buildContentWritingRevisionDocument({ markdown, outline });
  const plan = parseContentWritingRevisionPlan({
    operations: [
      {
        id: 'R001',
        scope: 'global',
        action: 'replace',
        targetId: 'article',
        instructions: 'أعد كتابة المقالة.',
      },
      {
        id: 'R002',
        scope: 'local',
        action: 'replace',
        targetId: 'section-01',
        instructions: 'أعد كتابة القسم.',
      },
    ],
  }, document);

  assert.deepEqual(plan.operations, []);
});

test('quality guard rejects lower scores and any newly regressed criterion', async () => {
  const { compareContentWritingQualityReports } = await importRevision();
  const before = report(88, { paragraphLength: 'fail', punctuation: 'pass' });
  const worse = report(87, { paragraphLength: 'pass', punctuation: 'fail' });
  const improved = report(90, { paragraphLength: 'pass', punctuation: 'pass' });

  const rejected = compareContentWritingQualityReports(before, worse);
  assert.equal(rejected.accepted, false);
  assert.deepEqual(rejected.newFailureIds, ['punctuation']);
  assert.ok(rejected.reasons.includes('quality_score_decreased'));
  assert.ok(rejected.reasons.includes('quality_criterion_regressed'));

  const accepted = compareContentWritingQualityReports(before, improved);
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.reasons, []);
});

test('knowledge and claim guards reject lost ideas and blocked claims after a section replacement', async () => {
  const {
    applyContentWritingRevisionEdits,
    buildContentWritingRevisionDocument,
    evaluateContentWritingRevisionKnowledge,
    parseContentWritingRevisionEdits,
    parseContentWritingRevisionPlan,
  } = await importRevision();
  const document = buildContentWritingRevisionDocument({ markdown, outline });
  const plan = parseContentWritingRevisionPlan({
    operations: [{
      id: 'R001',
      scope: 'structural',
      action: 'replace',
      targetId: 'section-01',
      instructions: 'استبدل القسم مع المحافظة على أفكاره.',
      requiredIdeaIds: ['K001', 'K002'],
    }],
  }, document);
  const edits = parseContentWritingRevisionEdits({
    edits: [{
      operationId: 'R001',
      replacementMarkdown: '## القسم الأول\n\nهذا ادعاء محظور لا يجوز إدخاله.',
      coveredIdeaIds: ['K001'],
      usedSourceChunkIds: ['C1-S001'],
      usedClaimIds: ['CL-BLOCKED'],
    }],
  }, plan);
  const application = applyContentWritingRevisionEdits(document, edits);
  const guard = evaluateContentWritingRevisionKnowledge({
    beforeMarkdown: markdown,
    candidateMarkdown: application.candidateMarkdown,
    document,
    application,
    knowledge,
    sectionCoverages: new Map([[
      'section-01',
      {
        coveredIdeaIds: ['K001', 'K002'],
        usedSourceChunkIds: ['C1-S001', 'C1-S002'],
        usedClaimIds: [],
      },
    ]]),
  });

  assert.equal(guard.accepted, false);
  assert.deepEqual(guard.lostIdeaIds, ['K002']);
  assert.deepEqual(guard.blockedClaimIds, ['CL-BLOCKED']);
  assert.ok(guard.reasons.includes('knowledge_coverage_decreased'));
  assert.ok(guard.reasons.includes('blocked_claim_introduced'));
});
