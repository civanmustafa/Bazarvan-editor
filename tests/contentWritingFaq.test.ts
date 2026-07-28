import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importFaq = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/contentWritingFaq.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const chunks: any[] = [
  {
    id: 'C1-S001',
    competitorNumber: 1,
    title: 'دليل المنتج',
    url: 'https://example.com/product',
    text: [
      'People Also Ask',
      'هل يناسب المنتج الاستخدام اليومي؟',
      'كيف يتم تتبع الشحنة؟',
      'تفاصيل أخرى موثقة عن اختيار المقاس والضمان.',
    ].join('\n'),
  },
  {
    id: 'C2-S001',
    competitorNumber: 2,
    title: 'سياسة الدفع',
    url: 'https://example.com/payment',
    text: 'يتم تأكيد الطلب بعد اكتمال عملية الدفع وفق الوسيلة المختارة.',
  },
];

const knowledge: any = {
  version: 3,
  items: [
    {
      id: 'K001',
      topic: 'قاعدة اختيار المقاس',
      detail: 'يُختار المقاس وفق عدد المستخدمين وطبيعة الاستخدام، وليس وفق الاسم وحده.',
      kind: 'selection',
      priority: 'high',
      sourceChunkIds: ['C1-S001'],
      competitorNumbers: [1],
      coverageCount: 1,
      coverageLevel: 'single_competitor',
      originalityOpportunity: '',
    },
    {
      id: 'K002',
      topic: 'تأكيد الدفع',
      detail: 'يرتبط تأكيد الطلب باكتمال عملية الدفع.',
      kind: 'payment',
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
    sources: [],
    primarySourceIds: [],
    contextualSourceIds: [],
    referenceOnlySourceIds: [],
  },
  claimLedger: {
    version: 1,
    claims: [
      {
        id: 'CL001',
        statement: 'اختيار المقاس يعتمد على عدد المستخدمين.',
        claimType: 'recommendation',
        riskLevel: 'low',
        knowledgeItemIds: ['K001'],
        supportingSourceChunkIds: ['C1-S001'],
        supportingSourceIds: [],
        competitorNumbers: [1],
        supportLevel: 'single_competitor',
        verificationStatus: 'single_competitor_reference',
        usagePolicy: 'allowed',
        usageGuidance: '',
      },
      {
        id: 'CL002',
        statement: 'ادعاء محظور للاختبار.',
        claimType: 'factual',
        riskLevel: 'high',
        knowledgeItemIds: ['K002'],
        supportingSourceChunkIds: ['C2-S001'],
        supportingSourceIds: [],
        competitorNumbers: [2],
        supportLevel: 'single_competitor',
        verificationStatus: 'requires_external_verification',
        usagePolicy: 'blocked',
        usageGuidance: '',
      },
    ],
    allowedClaimIds: ['CL001'],
    qualifiedClaimIds: [],
    blockedClaimIds: ['CL002'],
    externallyVerifiableClaimIds: ['CL002'],
    claimsByKnowledgeItem: [],
  },
  processedChunkIds: ['C1-S001', 'C2-S001'],
  modelProcessedChunkIds: ['C1-S001', 'C2-S001'],
  fallbackChunkIds: [],
};

test('FAQ intent blueprints change with the page goal', async () => {
  const { getContentWritingFaqIntentBlueprints } = await importFaq();
  const product = getContentWritingFaqIntentBlueprints({ pageType: 'product' });
  const news = getContentWritingFaqIntentBlueprints({ pageType: 'news' });

  assert.ok(product.some((item: any) => item.intent === 'payment'));
  assert.ok(product.some((item: any) => item.intent === 'warranty'));
  assert.ok(!product.some((item: any) => item.intent === 'implications'));
  assert.ok(news.some((item: any) => item.intent === 'implications'));
  assert.ok(news.some((item: any) => item.intent === 'timing'));
  assert.ok(!news.some((item: any) => item.intent === 'payment'));
});

test('question discovery only labels explicitly sourced questions as People Also Ask', async () => {
  const { extractContentWritingFaqQuestionSeeds } = await importFaq();
  const seeds = extractContentWritingFaqQuestionSeeds({
    knowledge,
    chunks,
    goalContext: {
      pageType: 'product',
      generatedBrief: 'هل توجد خدمة تركيب؟',
    },
  });

  assert.equal(seeds.find((item: any) => item.question.includes('الاستخدام اليومي'))?.sourceType, 'people_also_ask');
  assert.equal(seeds.find((item: any) => item.question.includes('تتبع الشحنة'))?.sourceType, 'people_also_ask');
  assert.equal(seeds.find((item: any) => item.question.includes('خدمة تركيب'))?.sourceType, 'page_context');
});

test('FAQ audit keeps only diverse evidence-backed questions with new information', async () => {
  const {
    contentWritingFaqAuditToMarkdown,
    normalizeContentWritingFaqAudit,
  } = await importFaq();
  const draft = [
    '# المنتج',
    '',
    '## طرق الدفع المتاحة',
    '',
    'يتم تأكيد الطلب بعد اكتمال عملية الدفع وفق الوسيلة المختارة.',
    '',
    '## المواصفات',
    '',
    'يوضح الجدول أسماء المقاسات المتاحة دون تقديم قاعدة للاختيار بينها.',
  ].join('\n');
  const audit = normalizeContentWritingFaqAudit({
    value: {
      candidates: [
        {
          id: 'FAQC001',
          question: 'كيف أختار المقاس الملائم لعدد المستخدمين؟',
          answer: 'ابدأ بعدد الأشخاص وطبيعة الاستخدام المتكرر، ثم قارن السعة الفعلية لكل مقاس بدل الاعتماد على اسمه. تساعد هذه القاعدة على تضييق الخيارات قبل مراجعة بقية المواصفات المرتبطة بمكان الاستخدام.',
          intent: 'selection',
          sourceType: 'people_also_ask',
          decision: 'accepted',
          decisionReason: 'يحوّل الجدول إلى قاعدة قرار غير موجودة في المتن.',
          newInformation: ['قاعدة اختيار تربط المقاس بعدد المستخدمين.'],
          nearestArticleExcerpt: 'أسماء المقاسات المتاحة.',
          informationGainScore: 0.9,
          bodySimilarityScore: 0.2,
          faqSimilarityScore: 0,
          evidenceIdeaIds: ['K001'],
          usedClaimIds: ['CL001'],
          sourceChunkIds: ['C1-S001'],
        },
        {
          id: 'FAQC002',
          question: 'أي مقاس هو الأفضل للعائلة؟',
          answer: 'اختر المقاس وفق عدد أفراد العائلة وطبيعة الاستخدام.',
          intent: 'selection',
          sourceType: 'goal_based_extension',
          decision: 'accepted',
          decisionReason: 'قاعدة اختيار.',
          newInformation: ['اختيار المقاس للعائلة.'],
          nearestArticleExcerpt: 'أسماء المقاسات.',
          informationGainScore: 0.8,
          bodySimilarityScore: 0.2,
          faqSimilarityScore: 0.2,
          evidenceIdeaIds: ['K001'],
          usedClaimIds: ['CL001'],
          sourceChunkIds: ['C1-S001'],
        },
        {
          id: 'FAQC003',
          question: 'متى يتم تأكيد الطلب بعد الدفع؟',
          answer: 'يتم تأكيد الطلب بعد اكتمال عملية الدفع وفق الوسيلة المختارة.',
          intent: 'payment',
          sourceType: 'knowledge_matrix',
          decision: 'accepted',
          decisionReason: 'معلومة دفع.',
          newInformation: ['توقيت تأكيد الطلب.'],
          nearestArticleExcerpt: 'يتم تأكيد الطلب بعد اكتمال عملية الدفع.',
          informationGainScore: 0.8,
          bodySimilarityScore: 0.9,
          faqSimilarityScore: 0,
          evidenceIdeaIds: ['K002'],
          usedClaimIds: [],
          sourceChunkIds: ['C2-S001'],
        },
        {
          id: 'FAQC004',
          question: 'هل يوجد ضمان إضافي غير معلن؟',
          answer: 'يوجد ضمان إضافي.',
          intent: 'warranty',
          sourceType: 'goal_based_extension',
          decision: 'accepted',
          decisionReason: 'سؤال ضمان.',
          newInformation: ['ضمان إضافي.'],
          nearestArticleExcerpt: '',
          informationGainScore: 0.9,
          bodySimilarityScore: 0,
          faqSimilarityScore: 0,
          evidenceIdeaIds: ['K002'],
          usedClaimIds: ['CL002'],
          sourceChunkIds: ['C2-S001'],
        },
      ],
    },
    draft,
    knowledge,
    chunks,
    goalContext: { pageType: 'product' },
  });

  assert.equal(audit.acceptedCount, 1);
  assert.equal(audit.candidates[0].decision, 'accepted');
  assert.equal(audit.candidates[0].sourceType, 'goal_based_extension');
  assert.ok(audit.candidates[1].guardReasons.includes('duplicate_intent'));
  assert.ok(audit.candidates[2].guardReasons.includes('duplicates_article_body'));
  assert.ok(audit.candidates[3].guardReasons.includes('blocked_claim'));
  const markdown = contentWritingFaqAuditToMarkdown(audit);
  assert.match(markdown, /كيف أختار المقاس/);
  assert.doesNotMatch(markdown, /متى يتم تأكيد الطلب/);
  assert.doesNotMatch(markdown, /ضمان إضافي/);
});

test('revision guard rejects new FAQ questions that did not pass the audit', async () => {
  const { evaluateContentWritingFaqRevision } = await importFaq();
  const before = [
    '# المنتج',
    '',
    '## تفاصيل المنتج',
    '',
    'يعرض هذا القسم وصفًا عامًا للمنتج ومزاياه الأساسية.',
    '',
    '## الأسئلة الشائعة',
    '',
    '### كيف أختار المقاس الملائم؟',
    '',
    'اربط الاختيار بعدد المستخدمين ومكان الاستخدام، ثم قارن السعة العملية لكل خيار. بهذه الطريقة يتحول جدول المواصفات إلى قرار يناسب احتياجك بدل الاكتفاء باسم المقاس.',
    '',
    '## اطلب المنتج',
    '',
    'اتخذ الخطوة المناسبة.',
  ].join('\n');
  const candidate = before.replace(
    '\n## اطلب المنتج',
    '\n\n### هل يوجد دفع بالتقسيط؟\n\nتحتاج هذه الإجابة إلى معلومات موثقة قبل النشر.\n\n## اطلب المنتج',
  );
  const guard = evaluateContentWritingFaqRevision({
    beforeMarkdown: before,
    candidateMarkdown: candidate,
    audit: {
      candidates: [{
        decision: 'accepted',
        question: 'كيف أختار المقاس الملائم؟',
      }],
    },
  });

  assert.equal(guard.accepted, false);
  assert.ok(guard.reasons.includes('unaudited_faq_question_added'));
  assert.deepEqual(guard.addedQuestions, ['هل يوجد دفع بالتقسيط؟']);
});
