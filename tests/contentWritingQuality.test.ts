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
  assert.ok(!evaluation.report.criteria.some((criterion: any) => criterion.id === 'lastH2IsConclusion'));
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'keyword.primary'));
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

test('minimum score is the authoritative quality gate for new and persisted reports', async () => {
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

  assert.equal(normalized?.passed, true);
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
