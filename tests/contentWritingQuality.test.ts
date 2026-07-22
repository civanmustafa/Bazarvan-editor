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
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'lastH2IsConclusion'));
  assert.ok(evaluation.report.criteria.some((criterion: any) => criterion.id === 'keyword.primary'));
});

test('repair prompt prioritizes machine-detected failures and includes the full draft', async () => {
  const { buildContentWritingRepairPrompt, evaluateContentWritingQuality } = await importQuality();
  const markdown = '# عنوان\n\nنص قصير جدًا.';
  const report = evaluateContentWritingQuality({ ...articleInput, markdown }).report;
  const prompt = buildContentWritingRepairPrompt({
    report,
    draft: markdown,
    qualityContract: '- عقد جودة تجريبي',
    language: 'ar',
  });

  assert.match(prompt, /Machine-detected issues/);
  assert.match(prompt, /عقد جودة تجريبي/);
  assert.match(prompt, /نص قصير جدًا/);
  assert.match(prompt, /blocking/);
});
