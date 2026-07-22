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
    'outline',
    'section-01',
    'section-02',
    'section-03',
    'section-04',
    'introduction',
    'faq',
    'conclusion',
    'final-review',
  ]);
  assert.deepEqual(steps.map((step: { ordinal: number }) => step.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('structured writing rejects incomplete or duplicate outlines', async () => {
  const { normalizeContentWritingOutline } = await importWorkflow();
  assert.equal(normalizeContentWritingOutline({ sections: ['One', 'Two', 'Three'] }), null);
  assert.equal(normalizeContentWritingOutline({ sections: ['One', 'One', 'Two', 'Three'] }), null);
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
