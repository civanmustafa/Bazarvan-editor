import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  buildContentWritingEditorSourceLedger,
  evaluateContentWritingEditorSourceCoverage,
} from '../utils/contentWritingEditorSource.ts';

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

const importCandidates = async (): Promise<any> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../utils/contentWritingCandidates.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

test('editor text becomes a complete mandatory source ledger without dropping orphan headings', () => {
  const ledger = buildContentWritingEditorSourceLedger([
    'اختيار الشريك المناسب',
    'يجب مراجعة خبرة الشركة في السوق المحلي قبل التعاقد.',
    '- اطلب أمثلة عملية ومراجع من مشروعات سابقة',
    'توصية أخيرة بلا شرح',
    'سؤال منفصل؟',
  ].join('\n'));

  assert.equal(ledger.enabled, true);
  assert.equal(ledger.itemCount, 4);
  assert.equal(ledger.items[0].heading, 'اختيار الشريك المناسب');
  assert.equal(ledger.items[0].kind, 'recommendation');
  assert.equal(ledger.items[1].kind, 'procedure');
  assert.equal(ledger.items[2].text, 'توصية أخيرة بلا شرح');
  assert.equal(ledger.items[3].kind, 'question');
  assert.ok(ledger.items.every(item => item.mandatory));
  assert.ok(ledger.fingerprint.startsWith('fnv1a-'));
});

test('every editor-source item is deterministically assigned to exactly one outline section', async () => {
  const { ensureContentWritingOutlineEditorSourceCoverage } = await importWorkflow();
  const ledger = buildContentWritingEditorSourceLedger([
    'اختيار شركة البراندنج',
    'يجب مراجعة خبرة الشركة وسابقة أعمالها قبل التعاقد.',
    'خطوات تنفيذ الهوية',
    'ابدأ بتحديد استراتيجية العلامة ثم انتقل إلى تصميم الهوية البصرية.',
    'احرص على قياس اتساق الهوية بعد الإطلاق.',
  ].join('\n'));
  const outline = {
    sections: [
      { title: 'كيفية اختيار شركة البراندنج', brief: 'الخبرة وسابقة الأعمال' },
      { title: 'مراحل بناء الهوية البصرية', brief: 'الاستراتيجية والتصميم والإطلاق' },
      { title: 'تكلفة خدمات البراندنج', brief: 'عوامل التسعير' },
      { title: 'نتائج الاستثمار في البراندنج', brief: 'القياس والتحسين' },
    ],
  };
  const assigned = ensureContentWritingOutlineEditorSourceCoverage(outline, ledger);
  const ids = assigned.sections.flatMap((section: { requiredEditorItemIds?: string[] }) => (
    section.requiredEditorItemIds || []
  ));
  assert.deepEqual([...ids].sort(), ledger.items.map(item => item.id).sort());
  assert.equal(new Set(ids).size, ids.length);
});

test('editor-source coverage requires declared meaning evidence and becomes a candidate hard gate', async () => {
  const { evaluateContentWritingCandidate } = await importCandidates();
  const ledger = buildContentWritingEditorSourceLedger([
    'يجب مراجعة خبرة الشركة في السوق المحلي قبل التعاقد.',
    'ينبغي طلب أمثلة عملية من مشروعات سابقة.',
  ].join('\n'));
  const complete = evaluateContentWritingEditorSourceCoverage({
    outputText: 'قبل التعاقد، راجع خبرة الشركة داخل السوق المحلي واطلب أمثلة عملية من مشروعاتها السابقة.',
    items: ledger.items,
    declaredItemIds: ledger.items.map(item => item.id),
  });
  assert.equal(complete.coveragePercent, 100);
  assert.deepEqual(complete.missingItemIds, []);

  const evaluation = evaluateContentWritingCandidate({
    candidateIndex: 1,
    outputText: 'راجع خبرة الشركة في السوق المحلي.',
    requiredEditorItemIds: ledger.items.map(item => item.id),
    metadata: {
      sectionCoverage: {
        coveredIdeaIds: [],
        usedSourceChunkIds: [],
        usedClaimIds: [],
        coveredEditorItemIds: [ledger.items[0].id],
      },
    },
  });
  assert.equal(evaluation.passedHardGates, false);
  assert.ok(evaluation.hardFailures.includes('candidate_missing_required_editor_source'));
  assert.equal(evaluation.metrics.editorSourceCoveragePercent, 50);
});

test('section prompt attaches only assigned editor items and requires coverage ids', async () => {
  const { buildContentWritingSectionPrompt } = await importWorkflow();
  const ledger = buildContentWritingEditorSourceLedger(
    'يجب مراجعة خبرة الشركة في السوق المحلي قبل التعاقد.',
  );
  const outline = {
    sections: [
      { title: 'القسم الأول', brief: 'الخبرة', requiredEditorItemIds: [ledger.items[0].id] },
      { title: 'القسم الثاني', brief: 'التنفيذ' },
      { title: 'القسم الثالث', brief: 'القياس' },
      { title: 'القسم الرابع', brief: 'النتائج' },
    ],
  };
  const prompt = buildContentWritingSectionPrompt({
    outline,
    section: outline.sections[0],
    sectionIndex: 0,
    knowledgeItems: [],
    claims: [],
    sourceChunks: [],
    editorSourceItems: ledger.items,
    coverageLedger: { coveredIdeaIds: [], usedClaimIds: [], previousSectionSummaries: [] },
  });
  assert.match(prompt, /mandatory_editor_source_items_json/);
  assert.match(prompt, /coveredEditorItemIds/);
  assert.match(prompt, /E001/);
});

test('both article-writing buttons save first and converge on the same mandatory session snapshot', async () => {
  const [panel, fullControl, engine, workflow] = await Promise.all([
    readFile(new URL('../components/ContentWritingPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/FullArticlePipelineControl.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../server/contentWritingEngine.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/contentWritingWorkflow.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(panel, /handleSaveDraft\(\{ reason: 'manual', force: true \}\)/);
  assert.match(fullControl, /onBeforeStart/);
  assert.match(engine, /buildContentWritingEditorSourceLedger\(articleSource\.input\.articleText\)/);
  assert.match(engine, /editorSourcePolicy/);
  assert.match(workflow, /content_writing_editor_source_coverage_incomplete/);
  assert.match(workflow, /editor_source_coverage_decreased/);
});
