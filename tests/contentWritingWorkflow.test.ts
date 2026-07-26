import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const importWorkflow = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/contentWritingWorkflow.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const outlineJson = JSON.stringify({
  sections: [
    { title: 'First topic', brief: 'First coverage brief' },
    { title: 'Second topic', brief: 'Second coverage brief' },
    { title: 'Third topic', brief: 'Third coverage brief' },
    { title: 'Fourth topic', brief: 'Fourth coverage brief' },
  ],
});

test('structured writing parses a bounded outline and creates deterministic sequential steps', async () => {
  const {
    parseContentWritingOutline,
    createContentWritingWorkflowSteps,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(`\`\`\`json\n${outlineJson}\n\`\`\``);
  const steps = createContentWritingWorkflowSteps(outline);

  assert.equal(outline.sections.length, 4);
  assert.deepEqual(steps.map((step: { key: string }) => step.key), [
    'competitor-index',
    'outline',
    'section-01',
    'section-02',
    'section-03',
    'section-04',
    'introduction',
    'faq',
    'conclusion',
    'coverage-audit',
    'final-review',
  ]);
  assert.deepEqual(steps.map((step: { ordinal: number }) => step.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('structured writing rejects incomplete or duplicate outlines', async () => {
  const { normalizeContentWritingOutline } = await importWorkflow();
  assert.equal(normalizeContentWritingOutline({ sections: ['One', 'Two', 'Three'] }), null);
  assert.equal(normalizeContentWritingOutline({ sections: ['One', 'One', 'Two', 'Three'] }), null);
});

test('outline coverage assigns usable claims and excludes blocked claims', async () => {
  const {
    ensureContentWritingOutlineKnowledgeCoverage,
    parseContentWritingOutline,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(outlineJson);
  const covered = ensureContentWritingOutlineKnowledgeCoverage(outline, {
    items: [{
      id: 'K001',
      topic: 'First topic',
      detail: 'A useful fact.',
      sourceChunkIds: ['C1-S001'],
    }],
    claimLedger: {
      claims: [
        {
          id: 'CL001',
          statement: 'A usable fact.',
          knowledgeItemIds: ['K001'],
          supportingSourceChunkIds: ['C1-S001'],
          usagePolicy: 'allowed',
        },
        {
          id: 'CL002',
          statement: 'A blocked statistic.',
          knowledgeItemIds: ['K001'],
          supportingSourceChunkIds: ['C1-S001'],
          usagePolicy: 'blocked',
        },
      ],
    },
  });

  assert.deepEqual(
    covered.sections.flatMap((section: { requiredClaimIds?: string[] }) => section.requiredClaimIds || []),
    ['CL001'],
  );
  assert.equal(
    covered.sections.some(
      (section: { requiredClaimIds?: string[] }) => section.requiredClaimIds?.includes('CL002'),
    ),
    false,
  );
});

test('competitor analysis prompt appends the editable source and claim ledger command', async () => {
  const { buildContentWritingCompetitorIndexPrompt } = await importWorkflow();
  const prompt = buildContentWritingCompetitorIndexPrompt({
    language: 'ar',
    chunks: [{
      id: 'C1-S001',
      competitorNumber: 1,
      title: 'Source',
      url: 'https://example.com',
      text: 'Source text.',
    }],
  });

  assert.match(prompt, /sourceAssessments/);
  assert.match(prompt, /claims/);
  assert.match(prompt, /محرك المصادر وسجل الادعاءات/);
  assert.match(prompt, /لا تعتبر تكرار الادعاء تحققًا نهائيًا/);
});

test('structured writing assembles one markdown draft without duplicate section headings', async () => {
  const {
    parseContentWritingOutline,
    assembleContentWritingDraft,
  } = await importWorkflow();
  const outline = parseContentWritingOutline(outlineJson);
  const draft = assembleContentWritingDraft({
    articleTitle: 'A useful guide',
    language: 'en',
    outline,
    outputs: {
      introduction: '# Introduction\n\nOpening text.',
      'section-01': '## First topic\n\nFirst body.',
      'section-02': 'Second body.',
      'section-03': 'Third body.',
      'section-04': 'Fourth body.',
      conclusion: 'Closing text.',
      faq: '### What matters?\n\nA clear answer.',
    },
  });

  assert.match(draft, /^# A useful guide/);
  assert.equal((draft.match(/## First topic/g) || []).length, 1);
  assert.match(draft, /## Conclusion/);
  assert.match(draft, /## Frequently asked questions/);
  assert.match(draft, /### What matters\?/);
  assert.ok(
    draft.indexOf('## Frequently asked questions') < draft.indexOf('## Conclusion'),
    'FAQ must appear before the conclusion so the conclusion remains the final H2.',
  );
});

test('generated writing removes bold formatting and normalizes Arabic list markers', async () => {
  const { normalizeFinalContentWritingResult } = await importWorkflow();
  const normalized = normalizeFinalContentWritingResult([
    '**مصطلح أساسي** و__جملة مهمة__ مع <strong>نص ظاهر</strong>.',
    '',
    '١. **العنصر الأول**',
    '۲) العنصر الثاني',
    '• العنصر الثالث',
  ].join('\n'));

  assert.doesNotMatch(normalized, /\*\*|__|<\/?(?:strong|b)\b/i);
  assert.match(normalized, /مصطلح أساسي وجملة مهمة مع نص ظاهر/);
  assert.match(normalized, /^1\. العنصر الأول$/m);
  assert.match(normalized, /^2\. العنصر الثاني$/m);
  assert.match(normalized, /^- العنصر الثالث$/m);
});

test('stopped writing recovers only completed prose stages as an importable partial draft', async () => {
  const { recoverContentWritingDraft } = await importWorkflow();
  const recovered = recoverContentWritingDraft({
    articleTitle: 'A useful guide',
    language: 'en',
    steps: [
      {
        stepKey: 'competitor-index',
        stepType: 'competitor_index',
        ordinal: 1,
        status: 'completed',
        outputText: 'RAW COMPETITOR ANALYSIS',
      },
      {
        stepKey: 'outline',
        stepType: 'outline',
        ordinal: 2,
        status: 'completed',
        outputText: outlineJson,
        metadata: { outline: JSON.parse(outlineJson) },
      },
      {
        stepKey: 'section-01',
        stepType: 'section',
        ordinal: 3,
        status: 'completed',
        outputText: 'Original first section.',
      },
      {
        stepKey: 'section-02',
        stepType: 'section',
        ordinal: 4,
        status: 'completed',
        outputText: 'Completed second section.',
      },
      {
        stepKey: 'section-03',
        stepType: 'section',
        ordinal: 5,
        status: 'failed',
        outputText: 'INVALID FAILED OUTPUT',
      },
      {
        stepKey: 'section-repair-01',
        stepType: 'section_repair',
        ordinal: 12,
        status: 'completed',
        outputText: 'Repaired first section.',
        metadata: { repairedSectionKey: 'section-01' },
      },
    ],
  });

  assert.ok(recovered);
  assert.equal(recovered.source, 'assembled_steps');
  assert.equal(recovered.includedStepCount, 3);
  assert.match(recovered.markdown, /^# A useful guide/);
  assert.match(recovered.markdown, /## First topic[\s\S]*Repaired first section\./);
  assert.match(recovered.markdown, /## Second topic[\s\S]*Completed second section\./);
  assert.doesNotMatch(recovered.markdown, /Original first section|RAW COMPETITOR|INVALID FAILED/);
  assert.doesNotMatch(recovered.markdown, /## Third topic|## Fourth topic/);
});

test('stopped writing prefers the latest completed full-draft review over assembled stages', async () => {
  const { recoverContentWritingDraft } = await importWorkflow();
  const recovered = recoverContentWritingDraft({
    articleTitle: 'Saved title',
    language: 'en',
    steps: [
      {
        stepKey: 'outline',
        stepType: 'outline',
        ordinal: 2,
        status: 'completed',
        outputText: outlineJson,
      },
      {
        stepKey: 'final-review',
        stepType: 'final_review',
        ordinal: 11,
        status: 'completed',
        outputText: '# Saved title\n\nFinal reviewed body.',
      },
      {
        stepKey: 'quality-repair-01',
        stepType: 'quality_repair',
        ordinal: 12,
        status: 'failed',
        outputText: '# Saved title\n\nInvalid failed repair.',
      },
    ],
  });

  assert.ok(recovered);
  assert.equal(recovered.source, 'review_step');
  assert.equal(recovered.markdown, '# Saved title\n\nFinal reviewed body.');
});

test('final review prompts receive the complete assembled draft', async () => {
  const { buildContentWritingFinalReviewPrompt } = await importWorkflow();
  const marker = `START-${'complete body '.repeat(1_000)}-END`;
  const prompt = buildContentWritingFinalReviewPrompt({
    articleTitle: 'Article title',
    draft: marker,
  });

  assert.match(prompt, /START-/);
  assert.match(prompt, /-END/);
  assert.equal(prompt.includes(marker), true);
});

test('editor preparation removes only the generated leading H1 from the article body', async () => {
  const {
    prepareContentWritingResultForEditor,
    contentWritingMarkdownToPlainText,
  } = await importWorkflow();
  const prepared = prepareContentWritingResultForEditor(
    '```markdown\n# A useful guide\n\nOpening **text**.\n\n## First topic\n\nBody.\n```',
    'A useful guide',
  );

  assert.equal(prepared.leadingTitle, 'A useful guide');
  assert.equal(prepared.titleMatchesArticle, true);
  assert.doesNotMatch(prepared.markdown, /^#\s/m);
  assert.match(prepared.markdown, /^## First topic/m);
  assert.equal(contentWritingMarkdownToPlainText(prepared.markdown), 'Opening text. First topic Body.');
});

test('editor preparation flags a generated title that differs from the saved article title', async () => {
  const { prepareContentWritingResultForEditor } = await importWorkflow();
  const prepared = prepareContentWritingResultForEditor('# Different title\n\nBody.', 'Saved title');

  assert.equal(prepared.leadingTitle, 'Different title');
  assert.equal(prepared.titleMatchesArticle, false);
  assert.equal(prepared.markdown, 'Body.');
});
