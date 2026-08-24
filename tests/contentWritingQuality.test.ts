import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importQuality = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/contentWritingQuality.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const importQualityContract = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../constants/contentWritingQuality.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const articleInput = {
  articleTitle: 'دليل التحول الرقمي للشركات الحديثة',
  keywords: {
    primary: 'التحول الرقمي',
    secondaries: ['خدمات التحول الرقمي'],
    company: 'بازارفان',
    lsi: ['الأتمتة', 'التقنية'],
  },
  goalContext: {
    pageType: 'service',
    objective: 'educate',
    audienceScope: 'global',
    targetCountry: '',
    targetAudience: 'أصحاب الشركات',
    searchIntent: 'informational',
  },
  articleLanguage: 'ar' as const,
};

test('quality document uses the saved article title as the canonical H1', async () => {
  const { createContentWritingAnalysisDocument } = await importQuality();
  const document = createContentWritingAnalysisDocument(
    '# عنوان مختلف\n\nمقدمة المقالة.\n\n## قسم تجريبي طويل وواضح للمستخدم المستهدف\n\nنص القسم.',
    articleInput.articleTitle,
  );

  assert.equal(document.nodes[0].type, 'heading');
  assert.equal(document.nodes[0].level, 1);
  assert.equal(document.nodes[0].text, articleInput.articleTitle);
  assert.equal(document.nodes.filter((node: any) => node.level === 1).length, 1);
});

test('deterministic quality evaluation returns a versioned blocking report', async () => {
  const { evaluateContentWritingQuality } = await importQuality();
  const evaluation = evaluateContentWritingQuality({
    ...articleInput,
    markdown: '# دليل التحول الرقمي للشركات الحديثة\n\nمقدمة قصيرة.\n\n## ما التحول الرقمي؟\n\nإجابة قصيرة.',
  });

  assert.equal(evaluation.report.policyVersion, 1);
  assert.equal(evaluation.report.passed, false);
  assert.ok(evaluation.report.blockingFailureCount > 0);
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'quality.targetWordRange'));
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'quality.totalH2Count'));
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'callToActionHeading'));
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'callToActionWordCount'));
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'callToActionParagraphsSentences'));
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'callToActionBulletList'));
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'callToActionFinalSentence'));
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'ctaWords'));
  assert.ok(!evaluation.report.criteria.some((criterion: any) => criterion.id === 'lastH2IsConclusion'));
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'keyword.primary'));
});

test('additional source criteria are merged and the quality score is recalculated', async () => {
  const { addContentWritingQualityCriteria } = await importQuality();
  const report = {
    policyVersion: 1,
    minimumScore: 90,
    score: 100,
    passed: true,
    blockingFailureCount: 0,
    failedCount: 0,
    warningCount: 0,
    passedCount: 1,
    wordCount: 100,
    repairPasses: 0,
    criteria: [{
      id: 'existing',
      title: 'Existing',
      status: 'pass',
      severity: 'important',
      weight: 10,
      current: 1,
      required: 1,
      violationCount: 0,
      messages: [] as string[],
    }],
    generatedAt: new Date(0).toISOString(),
  };
  const updated = addContentWritingQualityCriteria(report, [{
    id: 'source.exactPrices',
    title: 'Price source',
    status: 'fail',
    severity: 'blocking',
    weight: 10,
    current: 'unsupported',
    required: 'current primary source',
    violationCount: 1,
    messages: ['Missing source'],
  }]);

  assert.equal(updated.score, 50);
  assert.equal(updated.passed, false);
  assert.equal(updated.blockingFailureCount, 1);
  assert.equal(updated.failedCount, 1);
});

test('quality gate treats a paraphrased body answer in FAQ as a blocking independence failure', async () => {
  const { evaluateContentWritingQuality } = await importQuality();
  const repeatedAnswer = 'يتم تأكيد الطلب بعد اكتمال عملية الدفع وفق الوسيلة المختارة، ثم ينتقل مباشرة إلى مرحلة التجهيز.';
  const evaluation = evaluateContentWritingQuality({
    ...articleInput,
    markdown: [
      '# دليل التحول الرقمي للشركات الحديثة',
      '',
      'مقدمة تمهد للموضوع وتوضح للقارئ ما الذي سيجده في الصفحة.',
      '',
      '## كيف تعمل آلية الدفع وتجهيز الطلب؟',
      '',
      repeatedAnswer,
      '',
      '## الأسئلة الشائعة',
      '',
      '### متى يتم تأكيد الطلب؟',
      '',
      repeatedAnswer,
      '',
      '## اطلب استشارة التحول الرقمي المناسبة لشركتك',
      '',
      'ابدأ بطلب الاستشارة المناسبة لمراجعة احتياجاتك وتحديد الخطوة التالية.',
    ].join('\n'),
  });
  const criterion = evaluation.report.criteria.find(
    (item: any) => item.id === 'quality.faqIndependence',
  );

  assert.equal(criterion?.severity, 'blocking');
  assert.equal(criterion?.status, 'fail');
  assert.ok(criterion?.messages.some((message: string) => message.includes('يعيد معلومة')));
});

test('service quality analysis requires CTA section and hides conclusion criteria', async () => {
  const { evaluateContentWritingQuality } = await importQuality();
  const markdown = [
    '# دليل التحول الرقمي للشركات الحديثة',
    '',
    'مقدمة قصيرة تمهد للموضوع.',
    '',
    '## اطلب استشارة التحول الرقمي المناسبة لشركتك',
    '',
    'تمنحك هذه الخطوة رؤية واضحة لما تحتاجه شركتك قبل البدء، وتساعدك على اختيار مسار عملي يوازن بين التكلفة والنتائج. عندما تراجع احتياجاتك مع فريق متخصص، يصبح قرار التحول أكثر دقة وأقرب إلى واقع أعمالك.',
    '',
    'هذه أبرز المكاسب التي تساعدك على الانتقال بثقة:',
    '',
    '- تحديد أولويات التطوير حسب أثرها المباشر على العمليات',
    '- اختيار الأدوات التي تناسب حجم العمل والميزانية',
    '- بناء خطة تنفيذ قابلة للقياس والمتابعة الشهرية',
    '- تدريب الفريق على استخدام الحلول الجديدة بكفاءة',
    '',
    'ابدأ الآن بطلب استشارة سريعة لتعرف أفضل مسار يناسب شركتك قبل الاستثمار.',
  ].join('\n');

  const evaluation = evaluateContentWritingQuality({ ...articleInput, markdown });
  const criterion = (id: string) => evaluation.report.criteria.find((item: any) => item.id === id);

  assert.equal(criterion('callToActionHeading')?.status, 'pass');
  assert.equal(criterion('callToActionWordCount')?.status, 'pass');
  assert.equal(criterion('callToActionParagraphsSentences')?.status, 'pass');
  assert.equal(criterion('callToActionBulletList')?.status, 'pass');
  assert.equal(criterion('callToActionFinalSentence')?.status, 'pass');
  assert.equal(criterion('ctaWords')?.status, 'pass');
  assert.equal(criterion('lastH2IsConclusion'), undefined);
  assert.equal(criterion('paragraphLength')?.status, 'pass');
});

test('product quality uses CTA and product criteria while rejecting a separate conclusion', async () => {
  const [{ evaluateContentWritingQuality }, {
    buildContentWritingQualityContract,
    normalizeContentWritingQualityConfiguration,
  }] = await Promise.all([importQuality(), importQualityContract()]);
  const goalContext = {
    ...articleInput.goalContext,
    pageType: 'product',
    objective: 'convert',
    searchIntent: 'transactional',
  };
  const contract = buildContentWritingQualityContract({
    configuration: normalizeContentWritingQualityConfiguration({}),
    language: 'en',
    goalContext,
  });
  const evaluation = evaluateContentWritingQuality({
    articleTitle: 'Professional camera for commercial photography',
    keywords: {
      primary: 'professional camera',
      secondaries: [],
      company: 'Bazarvan',
      lsi: [],
    },
    goalContext,
    articleLanguage: 'en',
    markdown: [
      '# Professional camera for commercial photography',
      '',
      'A short product introduction.',
      '',
      '## Order your professional camera from Bazarvan today',
      '',
      'Choose the product that fits your work. Contact us to review the available options.',
      '',
      '## Conclusion',
      '',
      'A separate conclusion that must not be accepted on a product page.',
    ].join('\n'),
  });
  const criterion = (id: string) => evaluation.report.criteria.find((item: any) => item.id === id);

  assert.match(contract, /instead of a conclusion/i);
  assert.match(contract, /usage and specifications headings/i);
  assert.match(contract, /warranty content/i);
  assert.match(contract, /at least 2 tables/i);
  assert.equal(criterion('callToActionHeading')?.status, 'fail');
  assert.equal(criterion('productUsageHeading')?.status, 'fail');
  assert.equal(criterion('productTechnicalSpecsHeading')?.status, 'fail');
  assert.equal(criterion('productWarrantyContent')?.status, 'fail');
  assert.equal(criterion('tablesCount')?.status, 'fail');
  assert.equal(criterion('lastH2IsConclusion'), undefined);
});

test('session word range is the single authoritative word-count criterion', async () => {
  const { evaluateContentWritingQuality } = await importQuality();
  const body = Array.from({ length: 150 }, (_, index) => `word${index}`).join(' ');
  const evaluation = evaluateContentWritingQuality({
    ...articleInput,
    markdown: body,
    configuration: {
      policy: {
        targetWords: { min: 120, max: 180 },
        outlineSections: { min: 4, max: 6 },
      },
    },
  });
  const targetCriterion = evaluation.report.criteria.find(
    (criterion: any) => criterion.id === 'quality.targetWordRange',
  );

  assert.equal(evaluation.report.wordCount, 150);
  assert.equal(targetCriterion?.status, 'pass');
  assert.equal(targetCriterion?.required, '120-180');
  assert.ok(!evaluation.report.criteria.some((criterion: any) => criterion.id === 'wordCount'));
});

test('quality analysis detects the second introduction paragraph and Arabic numbered conclusion list', async () => {
  const { createContentWritingAnalysisDocument, evaluateContentWritingQuality } = await importQuality();
  const sentence = (prefix: string, count: number): string => (
    Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(' ')
  );
  const firstParagraph = `${sentence('مقدمة', 15)}. ${sentence('تمهيد', 15)}.`;
  const secondParagraph = `${sentence('تفصيل', 20)}. ${sentence('توضيح', 20)}.`;
  const conclusionParagraph = `في الختام ${sentence('خلاصة', 25)}.`;
  const listIntroduction = `${sentence('خطوة', 15)}:`;
  const listItems = [
    `١. ${sentence('أول', 10)}`,
    `٢. ${sentence('ثان', 10)}`,
    `٣. ${sentence('ثالث', 10)}`,
  ].join('\n');
  const markdown = [
    firstParagraph,
    '',
    secondParagraph,
    '',
    '## الخاتمة',
    '',
    conclusionParagraph,
    '',
    listIntroduction,
    '',
    listItems,
  ].join('\n');

  const document = createContentWritingAnalysisDocument(markdown, articleInput.articleTitle);
  assert.equal(
    document.nodes
      .slice(0, document.nodes.findIndex((node: any) => node.type === 'heading' && node.level === 2))
      .filter((node: any) => node.type === 'paragraph').length,
    2,
  );
  assert.equal(document.nodes.filter((node: any) => node.type === 'orderedList').length, 1);

  const evaluation = evaluateContentWritingQuality({
    ...articleInput,
    goalContext: { ...articleInput.goalContext, pageType: 'article' },
    markdown,
  });
  const criterion = (id: string) => evaluation.report.criteria.find((item: any) => item.id === id);
  assert.equal(criterion('secondParagraph')?.status, 'pass');
  assert.equal(criterion('conclusionHasNumber')?.status, 'pass');
  assert.equal(criterion('conclusionHasList')?.status, 'pass');
  assert.equal(criterion('callToActionHeading'), undefined);
  assert.equal(criterion('callToActionWordCount'), undefined);
  assert.equal(criterion('callToActionParagraphsSentences'), undefined);
  assert.equal(criterion('callToActionBulletList'), undefined);
  assert.equal(criterion('callToActionFinalSentence'), undefined);
  assert.equal(criterion('ctaWords'), undefined);
});

test('quality analysis treats consecutive visible Markdown lines as separate introduction paragraphs', async () => {
  const { createContentWritingAnalysisDocument, evaluateContentWritingQuality } = await importQuality();
  const sentence = (prefix: string, count: number): string => (
    Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(' ')
  );
  const firstParagraph = `${sentence('مقدمة', 15)}. ${sentence('تمهيد', 15)}.`;
  const secondParagraph = `${sentence('تفصيل', 20)}. ${sentence('توضيح', 20)}.`;
  const markdown = [
    firstParagraph,
    secondParagraph,
    '## قسم تجريبي طويل وواضح للمستخدم المستهدف',
    'نص القسم.',
  ].join('\n');

  const document = createContentWritingAnalysisDocument(markdown, articleInput.articleTitle);
  const firstH2Index = document.nodes.findIndex(
    (node: any) => node.type === 'heading' && node.level === 2,
  );
  assert.equal(
    document.nodes.slice(0, firstH2Index).filter((node: any) => node.type === 'paragraph').length,
    2,
  );

  const evaluation = evaluateContentWritingQuality({ ...articleInput, markdown });
  const secondParagraphCriterion = evaluation.report.criteria.find(
    (item: any) => item.id === 'secondParagraph',
  );
  assert.notEqual(secondParagraphCriterion?.current, 0);
  assert.equal(secondParagraphCriterion?.status, 'pass');
});

test('a blocking failure vetoes a high score for new and persisted reports', async () => {
  const { normalizeContentWritingQualityReport } = await importQuality();
  const normalized = normalizeContentWritingQualityReport({
    policyVersion: 1,
    minimumScore: 80,
    score: 81,
    passed: false,
    blockingFailureCount: 1,
    failedCount: 1,
    warningCount: 0,
    passedCount: 10,
    wordCount: 1_200,
    repairPasses: 2,
    criteria: [{
      id: 'secondParagraph',
      title: 'الفقرة الثانية',
      status: 'fail',
      severity: 'blocking',
      weight: 2,
      current: 0,
      required: '40-80 كلمة, 2-4 جمل',
      violationCount: 1,
      messages: [],
    }],
    generatedAt: new Date(0).toISOString(),
  });

  assert.equal(normalized?.passed, false);
  assert.equal(normalized?.score, 0);
  assert.equal(normalized?.blockingFailureCount, 1);
});

test('external review patches require unique literal targets and anchors', async () => {
  const { applyExternalReviewPatchesToContentWritingMarkdown } = await importQuality();
  const result = applyExternalReviewPatchesToContentWritingMarkdown({
    markdown: [
      '# العنوان',
      '',
      'فقرة فريدة قابلة للاستبدال.',
      '',
      '## قسم مكرر',
      '',
      'نص.',
      '',
      '## قسم مكرر',
      '',
      'نص.',
    ].join('\n'),
    patches: [
      {
        marker: 'replace_unique',
        operation: 'replace_block',
        targetText: 'فقرة فريدة قابلة للاستبدال.',
        contentMarkdown: 'فقرة بديلة موثقة وآمنة.',
      },
      {
        marker: 'insert_ambiguous',
        operation: 'insert_after_heading',
        anchorText: '## قسم مكرر',
        contentMarkdown: 'إضافة غير آمنة.',
      },
      {
        marker: 'append_without_anchor',
        operation: 'append_to_article',
        contentMarkdown: 'إضافة بلا مرساة.',
      },
    ],
  });

  assert.deepEqual(result.applied.map((item: any) => item.marker), ['replace_unique']);
  assert.deepEqual(result.rejected.map((item: any) => item.reason), [
    'anchor_not_unique',
    'missing_anchor_text',
  ]);
  assert.match(result.markdown, /فقرة بديلة موثقة وآمنة/);
  assert.doesNotMatch(result.markdown, /إضافة غير آمنة|إضافة بلا مرساة/);
});

test('external review patch application is atomic when merge-delete preflight fails', async () => {
  const { applyExternalReviewPatchesToContentWritingMarkdown } = await importQuality();
  const markdown = 'فقرة الهدف.\n\nفقرة الدمج.\n\nفقرة الدمج.';
  const result = applyExternalReviewPatchesToContentWritingMarkdown({
    markdown,
    patches: [{
      operation: 'replace_block',
      targetText: 'فقرة الهدف.',
      contentMarkdown: 'بديل يجب ألا يطبق جزئيًا.',
      mergeDeleteTargetText: 'فقرة الدمج.',
    }],
  });

  assert.equal(result.changed, false);
  assert.equal(result.markdown, markdown);
  assert.equal(result.rejected[0]?.reason, 'merge_target_not_unique');
});

test('quality is re-evaluated from the safely patched Markdown', async () => {
  const { reevaluateContentWritingQualityAfterExternalReview } = await importQuality();
  const result = reevaluateContentWritingQualityAfterExternalReview({
    ...articleInput,
    markdown: '# عنوان\n\nنص قصير.',
    patches: [{
      operation: 'append_to_article',
      anchorText: '# عنوان',
      contentMarkdown: '## قسم إضافي\n\n' + Array.from({ length: 120 }, (_, index) => `كلمة${index}`).join(' '),
    }],
  });

  assert.equal(result.patchApplication.applied.length, 1);
  assert.ok(result.evaluation.report.wordCount > 100);
});

test('external review reuses the frozen session quality configuration', async () => {
  const { reevaluateContentWritingQualityAfterExternalReview } = await importQuality();
  const markdown = Array.from({ length: 150 }, () => 'كلمة').join(' ');
  const result = reevaluateContentWritingQualityAfterExternalReview({
    ...articleInput,
    markdown,
    patches: [],
    configuration: {
      minimumScore: 55,
      policy: {
        targetWords: { min: 120, max: 180 },
        outlineSections: { min: 1, max: 3 },
      },
    },
  });
  const targetWords = result.evaluation.report.criteria.find(
    (criterion: any) => criterion.id === 'quality.targetWordRange',
  );

  assert.equal(result.evaluation.report.minimumScore, 55);
  assert.equal(targetWords?.required, '120-180');
  assert.equal(targetWords?.status, 'pass');
});

test('each exact value must match its own used, current-primary claim', async () => {
  const {
    auditContentWritingSourceAccuracy,
    reevaluateContentWritingQualityAfterExternalReview,
  } = await importQuality();
  const knowledge = {
    sourceRegistry: {
      primarySourceIds: ['SRC1'],
      sources: [{ id: 'SRC1', freshness: 'current' }],
    },
    claimLedger: {
      claims: [
        {
          id: 'CL-RATE',
          statement: 'بلغ المعدل الموثق 42%.',
          claimType: 'statistic',
          usagePolicy: 'allowed',
          supportingSourceIds: ['SRC1'],
        },
        {
          id: 'CL-PRICE',
          statement: 'السعر الرسمي هو 750 USD.',
          claimType: 'financial',
          usagePolicy: 'allowed',
          supportingSourceIds: ['SRC1'],
        },
      ],
    },
  };
  const sourceAccuracy = {
    knowledge,
    usedClaimIds: ['CL-RATE', 'CL-PRICE'],
  };
  const audit = auditContentWritingSourceAccuracy({
    markdown: 'القيمة الموثقة ٤٢٪، لكن الإضافة تزعم 73% وسعرًا قدره 900 USD في 2025. أفضل 5 أجهزة تشمل GPX 5000.',
    sourceAccuracy,
  });

  assert.deepEqual(audit.supportedNumericValues.sort(), ['percent:42', 'price:750:USD']);
  assert.deepEqual(audit.unsupportedNumericValues.sort(), ['percent:73', 'price:900:USD', 'year:2025']);
  assert.deepEqual(audit.unsupportedPriceValues, ['price:900:USD']);
  assert.ok(!audit.numericValues.some((value: string) => /(?:^|:)5(?:$|:)|5000/.test(value)));

  const categoryMismatch = auditContentWritingSourceAccuracy({
    markdown: 'النتيجة غير الموثقة 20%.',
    sourceAccuracy: {
      knowledge: {
        ...knowledge,
        claimLedger: {
          claims: [{
            id: 'CL-DURATION',
            statement: 'تستمر الخدمة 20 سنة.',
            claimType: 'statistic',
            usagePolicy: 'allowed',
            supportingSourceIds: ['SRC1'],
          }],
        },
      },
      usedClaimIds: ['CL-DURATION'],
    },
  });
  assert.deepEqual(categoryMismatch.supportedNumericValues, ['duration:20:year']);
  assert.deepEqual(categoryMismatch.unsupportedNumericValues, ['percent:20']);

  const reviewed = reevaluateContentWritingQualityAfterExternalReview({
    ...articleInput,
    markdown: '# عنوان\n\nبلغ المعدل الموثق 42%.',
    patches: [{
      marker: 'unsupported-exact-values',
      operation: 'insert_after_heading',
      anchorText: '# عنوان',
      contentMarkdown: 'أضافت المراجعة نسبة 73% وسعرًا قدره 900 USD.',
    }],
    sourceAccuracy: {
      ...sourceAccuracy,
      baselineMarkdown: '# عنوان\n\nبلغ المعدل الموثق 42%.',
    },
  });
  const numericCriterion = reviewed.evaluation.report.criteria.find(
    (criterion: any) => criterion.id === 'source.numericClaims',
  );
  const priceCriterion = reviewed.evaluation.report.criteria.find(
    (criterion: any) => criterion.id === 'source.exactPrices',
  );

  assert.equal(reviewed.patchApplication.applied.length, 1);
  assert.equal(numericCriterion?.status, 'fail');
  assert.equal(numericCriterion?.violationCount, 2);
  assert.equal(priceCriterion?.status, 'fail');
  assert.equal(priceCriterion?.violationCount, 1);
  assert.equal(reviewed.evaluation.report.passed, false);
});

test('an older review session blocks only numeric values newly introduced by patches', async () => {
  const { reevaluateContentWritingQualityAfterExternalReview } = await importQuality();
  const baselineMarkdown = '# عنوان\n\nالقيمة القديمة 42%.';
  const reviewed = reevaluateContentWritingQualityAfterExternalReview({
    ...articleInput,
    markdown: baselineMarkdown,
    patches: [{
      operation: 'insert_after_heading',
      anchorText: '# عنوان',
      contentMarkdown: 'قيمة جديدة غير موثقة 73%.',
    }],
    sourceAccuracy: { baselineMarkdown },
  });
  const criterion = reviewed.evaluation.report.criteria.find(
    (item: any) => item.id === 'source.numericClaims',
  );

  assert.equal(criterion?.status, 'fail');
  assert.equal(criterion?.current, '73%');
});

test('repair planning prompt classifies failures and reads the full draft without rewriting it', async () => {
  const { buildContentWritingRepairPrompt, evaluateContentWritingQuality } = await importQuality();
  const markdown = '# عنوان\n\nنص قصير جدًا.';
  const report = evaluateContentWritingQuality({ ...articleInput, markdown }).report;
  const prompt = buildContentWritingRepairPrompt({
    report,
    draft: markdown,
    qualityContract: '- عقد جودة تجريبي',
    language: 'ar',
  });

  assert.match(prompt, /المخالفات المرتبة/);
  assert.match(prompt, /عقد جودة تجريبي/);
  assert.match(prompt, /نص قصير جدًا/);
  assert.match(prompt, /blocking/);
  assert.match(prompt, /"scope": "global"/);
  assert.match(prompt, /لا تُرجع المقالة ولا النصوص البديلة/);
});
