import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { Keywords } from '../types.ts';

const bundle = await build({ stdin: {
  contents: `export * from './utils/duplicateCleanup'; export * from './utils/duplicateCleanupSession'; export * from './utils/duplicateCleanupWorkflow'; export * from './server/duplicateCleanupJob'; export * from './utils/analysis/runDuplicateAnalysis'; export { Schema } from '@tiptap/pm/model'; export { Transform } from '@tiptap/pm/transform';`,
  resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts',
}, bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false });
const engine = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const schema = new engine.Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' },
  heading: { content: 'inline*', group: 'block' }, text: { group: 'inline' },
  hardBreak: { inline: true, group: 'inline' },
}, marks: { bold: {}, link: { attrs: { href: {} } } } });
const keywords: Keywords = { primary: '', secondaries: [], lsi: [], company: '' };
const makeDoc = (texts: string[]) => schema.node('doc', null, texts.map(text => schema.node('paragraph', null, text ? schema.text(text) : undefined)));
const phrase = 'من المهم أن نلاحظ';
const makeSnapshot = (doc: any, text = phrase, language = 'ar') => engine.collectCleanupSnapshot(doc, [{ text, count: 7, locations: [] }], text.split(' ').length, language);
const makeResponse = (snapshot: any, keep = 0) => JSON.stringify({
  edits: snapshot.occurrences.filter((_: unknown, i: number) => i !== keep).map((item: any, i: number) => ({ id: `e${i}`, unitId: item.unitIds[0], original: `${phrase} أن `, replacement: '', reason: 'حذف تمهيد دون فقد معلومة' })),
  decisions: snapshot.occurrences.map((item: any, i: number) => ({ occurrenceId: item.id, action: i === keep ? 'keep' : 'edit', reason: i === keep ? 'الأصعب تعديلًا' : 'حذف تمهيد' })),
});

const jobFor = (doc: any, snapshot: any, plan: any, status = 'completed') => ({
  id: 'job-1', status, updated_at: '2026-09-28T10:00:00Z', created_at: '2026-09-28T09:00:00Z',
  input_snapshot: { version: 1, document: doc.toJSON(), snapshot },
  result: status === 'completed' ? { cleanup: { ...plan, completed: 1, total: 1, errors: [] } } : null,
  progress: status !== 'completed' ? { cleanup: { ...plan, completed: 0, total: 1, errors: [] } } : {},
});

test('external generation reviews all occurrences and resumes without repeating completed batches', async () => {
  const doc = makeDoc(['التقرير متاح للتصدير.', 'الجدول يحتوي خمسة أعمدة.', 'المسودة تحفظ تلقائيًا.', 'الروابط تحتفظ بعناوينها.', 'القائمة مرتبة أبجديًا.', 'نتيجة البحث فورية.', 'الصور تعرض النص البديل.'].map(fact => `${phrase} أن ${fact}`));
  const snapshot = makeSnapshot(doc);
  const checkpoints: any[] = [];
  let calls = 0;
  const options = { doc, snapshot, keywords, title: 'اختبار', signal: new AbortController().signal,
    run: async (prompt: string) => { calls++; assert.ok(prompt.includes('p1-o7')); return makeResponse(snapshot, 3); },
    checkpoint: async (state: any) => { checkpoints.push(structuredClone(state)); } };
  const state = await engine.runCleanupWorkflow(options);
  assert.equal(state.patches.length, 6, state.errors.join('\n'));
  assert.equal(state.decisions.length, 7);
  assert.equal(checkpoints.at(-1).processed[0], 0);
  await engine.runCleanupWorkflow({ ...options, saved: state });
  assert.equal(calls, 1);
});

test('provider retries retain the successful batch checkpoint and resume only unfinished work', async () => {
  const doc = makeDoc(['Generally speaking reports export as PDF.', 'Generally speaking tables have five columns.', 'Furthermore note drafts save automatically.', 'Furthermore note images retain alternate text.']);
  const snapshot = engine.collectCleanupSnapshot(doc, [{ text: 'Generally speaking' }, { text: 'Furthermore note' }], 2, 'en');
  assert.equal(engine.batchCleanupSnapshot(snapshot).length, 2);
  let saved: any;
  const calls: number[] = [];
  const respond = async (prompt: string, index: number) => {
    calls.push(index);
    const data = JSON.parse(prompt.split('SOURCE_DATA=')[1]);
    const first = data.occurrences[0];
    return JSON.stringify({ edits: [{ unitId: first.unitIds[0], original: `${data.phrases[0].text} `, replacement: '', reason: 'Remove filler.' }],
      decisions: data.occurrences.map((item: any) => ({ occurrenceId: item.id, action: item.id === first.id ? 'edit' : 'keep', reason: 'Compared both contexts.' })) });
  };
  const options = { doc, snapshot, keywords, title: '', signal: new AbortController().signal,
    checkpoint: async (state: any) => { saved = structuredClone(state); } };
  await assert.rejects(engine.runCleanupWorkflow({ ...options, run: async (prompt: string, index: number) => {
    if (index > 1) throw new Error('Provider unavailable');
    return respond(prompt, index);
  } }), /Provider unavailable/);
  assert.deepEqual(saved.processed, [0]);
  assert.equal(saved.patches.length, 1);
  const result = await engine.runCleanupWorkflow({ ...options, saved, run: respond });
  assert.deepEqual(calls, [1, 3]);
  assert.equal(result.patches.length, 2);
  assert.equal(result.decisions.length, 4);
});

test('malformed external results are bounded, persisted as partial and never applied', async () => {
  const doc = makeDoc([`${phrase} أن أ مختلف.`, `${phrase} أن ب مختلف.`]);
  let calls = 0;
  const state = await engine.runCleanupWorkflow({ doc, snapshot: makeSnapshot(doc), keywords, title: '', signal: new AbortController().signal,
    run: async () => { calls++; return '{}'; }, checkpoint: async () => {} });
  assert.equal(calls, 2);
  assert.equal(state.errors.length, 1);
  assert.equal(state.patches.length, 0);
  assert.equal(state.processed.length, 1);
});

test('cancellation discards the current response and never checkpoints its patches', async () => {
  const doc = makeDoc([`${phrase} أن أ مختلف.`, `${phrase} أن ب مختلف.`]);
  const snapshot = makeSnapshot(doc);
  const abort = new AbortController();
  const checkpoints: any[] = [];
  await assert.rejects(engine.runCleanupWorkflow({ doc, snapshot, keywords, title: '', signal: abort.signal,
    run: async () => { abort.abort(); return makeResponse(snapshot); },
    checkpoint: async (state: any) => { checkpoints.push(structuredClone(state)); } }), /abort/i);
  assert.equal(checkpoints.at(-1).patches.length, 0);
});

test('server rebuilds safe snapshots and excludes protected phrases rather than trusting browser phrases', () => {
  const doc = makeDoc([`${phrase} أن أ مختلف.`, `${phrase} أن ب مختلف.`]);
  const input = { category: 4, language: 'ar', document: doc.toJSON(), keywords, title: 'اختبار' };
  const prepared = engine.prepareCleanupJobInput(input);
  assert.ok(prepared.snapshot.phrases.some((item: any) => item.text === phrase));
  const protectedInput = engine.prepareCleanupJobInput({ ...input, keywords: { ...keywords, primary: phrase } });
  assert.ok(!protectedInput.snapshot.phrases.some((item: any) => item.text === phrase));
  assert.throws(() => engine.prepareCleanupJobInput({ ...input, category: 9 }));
  assert.throws(() => engine.prepareCleanupJobInput({ ...input, document: { type: 'unknown' } }));
});

test('persisted proposals restore exact positions, but changed documents never use a string fallback', () => {
  const doc = makeDoc(Array.from({ length: 7 }, (_, i) => `${phrase} أن القياس ${i + 1} مختلف.`));
  const snapshot = makeSnapshot(doc);
  const plan = engine.parseCleanupPlan(makeResponse(snapshot, 3), snapshot);
  const job = jobFor(doc, snapshot, plan);
  const restored = engine.restoreCleanupJob(job, doc);
  assert.equal(restored.patches.filter((patch: any) => patch.status === 'pending').length, 6);
  const moved = new engine.Transform(doc).insert(1, schema.text('مقدمة. ')).doc;
  const stale = engine.restoreCleanupJob(job, moved);
  assert.equal(stale.patches.filter((patch: any) => patch.status === 'pending').length, 0);
  assert.ok(stale.patches.every((patch: any) => patch.status === 'stale'));
  assert.equal(engine.cleanupGenerationState(restored), 'completed');
  assert.equal(engine.cleanupGenerationState(stale), 'partial');
  assert.equal(engine.cleanupGenerationState(), 'not_started');
});

test('polling preserves applied and skipped patch states and keeps header completion honest', () => {
  const doc = makeDoc(Array.from({ length: 7 }, (_, i) => `${phrase} أن القياس ${i + 1} مختلف.`));
  const snapshot = makeSnapshot(doc);
  const plan = engine.parseCleanupPlan(makeResponse(snapshot, 3), snapshot);
  const job = jobFor(doc, snapshot, plan);
  const previous = engine.restoreCleanupJob(job, doc);
  previous.patches[0].status = 'applied'; previous.patches[1].status = 'skipped';
  const next = engine.restoreCleanupJob(job, doc, previous);
  assert.equal(next.patches[0].status, 'applied'); assert.equal(next.patches[1].status, 'skipped');
  const partial = engine.restoreCleanupJob(jobFor(doc, snapshot, { patches: plan.patches.slice(0, 2), decisions: plan.decisions.slice(0, 2) }, 'running'), doc);
  assert.equal(engine.cleanupGenerationState(partial), 'partial');
});

test('all seven occurrences are supplied; six exact local edits preserve the chosen hardest occurrence', () => {
  const doc = makeDoc(Array.from({ length: 7 }, (_, i) => `${phrase} أن القياس ${i + 1} مختلف.`));
  const snapshot = makeSnapshot(doc);
  assert.equal(snapshot.occurrences.length, 7);
  const prompt = engine.buildCleanupPrompt(snapshot, 'اختبار');
  assert.ok(prompt.includes('p1-o7'));
  const plan = engine.parseCleanupPlan(makeResponse(snapshot, 4), snapshot);
  assert.equal(plan.patches.length, 6);
  const after = engine.simulateCleanup(doc, plan.patches);
  assert.equal(engine.cleanupPhraseCounts(after, snapshot.phrases, 'ar').get('p1'), 1);
  assert.equal(after.child(4).textContent, doc.child(4).textContent);
  assert.equal(after.child(0).textContent, 'القياس 1 مختلف.');
  assert.equal(doc.child(0).textContent, `${phrase} أن القياس 1 مختلف.`);
});

test('identical paragraphs target the requested occurrence, never the first string match', () => {
  const doc = makeDoc(Array(7).fill(`${phrase} أن التقرير جاهز.`));
  const snapshot = makeSnapshot(doc);
  const plan = engine.parseCleanupPlan(makeResponse(snapshot, 0), snapshot);
  const after = engine.simulateCleanup(doc, [plan.patches[4]]);
  assert.equal(after.child(0).textContent, doc.child(0).textContent);
  assert.equal(after.child(5).textContent, 'التقرير جاهز.');
  assert.equal(after.child(6).textContent, doc.child(6).textContent);
});

test('missing an occurrence, contradictory decisions and multiple keeps are rejected', () => {
  const snapshot = makeSnapshot(makeDoc(Array(3).fill(`${phrase} أن التقرير جاهز.`)));
  const response = JSON.parse(makeResponse(snapshot));
  response.decisions.pop();
  assert.throws(() => engine.parseCleanupPlan(JSON.stringify(response), snapshot), /Missing decision/);
  const contradiction = JSON.parse(makeResponse(snapshot));
  contradiction.decisions[1].action = 'keep';
  assert.throws(() => engine.parseCleanupPlan(JSON.stringify(contradiction), snapshot), /does not match/);
  assert.throws(() => engine.parseCleanupPlan(JSON.stringify({ edits: [], decisions: snapshot.occurrences.map((o: any) => ({ occurrenceId: o.id, action: 'keep', reason: 'keep' })) }), snapshot), /Only one/);
});

test('normalization matches the analyzer for Arabic forms, punctuation and English plurals', () => {
  const doc = makeDoc(['أهمية هذه الخطوة واضحة.', 'اهمية، هذه الخطوة مؤكدة.']);
  const analysis = engine.runDuplicateAnalysis(doc.textBetween(0, doc.content.size, '\n\n'), keywords, 0, 'ar');
  const snapshot = engine.collectCleanupSnapshot(doc, analysis.duplicateAnalysis[3], 3, 'ar');
  assert.equal(snapshot.occurrences.length, 2);
  const english = makeSnapshot(makeDoc(['These useful tools work.', 'These useful tool designs.']), 'these useful tools', 'en');
  assert.equal(english.occurrences.length, 2);
});

test('sentences split across inline formatting retain exact ProseMirror offsets', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('من المهم ', [schema.mark('bold')]), schema.text('أن نلاحظ أن النتيجة واضحة.')]), schema.node('paragraph', null, schema.text(`${phrase} أن النتيجة مختلفة.`))]);
  const snapshot = makeSnapshot(doc);
  const plan = engine.parseCleanupPlan(makeResponse(snapshot, 1), snapshot);
  const after = engine.simulateCleanup(doc, plan.patches);
  assert.equal(after.child(0).textContent, 'النتيجة واضحة.');
  assert.equal(after.child(1).textContent, doc.child(1).textContent);
});

test('outside edits map target positions, inside edits invalidate them without searching elsewhere', () => {
  const doc = makeDoc(['مقدمة.', `${phrase} أن النتيجة واضحة.`, `${phrase} أن النتيجة مختلفة.`]);
  const snapshot = makeSnapshot(doc);
  const patch = engine.parseCleanupPlan(makeResponse(snapshot, 1), snapshot).patches[0];
  const transform = new engine.Transform(doc).insert(1, schema.text('إضافة '));
  const mapped = engine.mapCleanupRange(patch, transform.mapping);
  assert.ok(engine.cleanupRangeMatches(transform.doc, mapped, patch.original));
  const changed = new engine.Transform(doc).delete(patch.from, patch.to);
  assert.equal(engine.cleanupRangeMatches(changed.doc, engine.mapCleanupRange(patch, changed.mapping), patch.original), false);
});

test('cross-paragraph n-grams include every context without permitting paragraph rewrites', () => {
  const doc = makeDoc(['أول الكلام', 'نهاية الحديث.', 'ثاني الكلام', 'نهاية الحديث.']);
  const snapshot = makeSnapshot(doc, 'الكلام نهاية');
  assert.equal(snapshot.occurrences.length, 2);
  assert.equal(snapshot.occurrences[0].unitIds.length, 2);
  assert.equal(engine.batchCleanupSnapshot(snapshot)[0].occurrences.length, 2);
});

test('overlapping phrases are grouped and one deletion can resolve both', () => {
  const doc = makeDoc([`${phrase} أن التقرير جاهز.`, `${phrase} أن القياس مختلف.`]);
  const snapshot = engine.collectCleanupSnapshot(doc, [{ text: phrase }, { text: 'المهم أن نلاحظ أن' }], 4, 'ar');
  const batches = engine.batchCleanupSnapshot(snapshot);
  assert.equal(batches.length, 1);
  const response = { edits: [{ unitId: 'u1', original: `${phrase} أن `, replacement: '', reason: 'حذف' }], decisions: snapshot.occurrences.map((item: any) => ({ occurrenceId: item.id, action: item.ordinal === 1 ? 'edit' : 'keep', reason: 'سياق' })) };
  const plan = engine.parseCleanupPlan(JSON.stringify(response), snapshot);
  assert.equal(plan.patches.length, 1);
  assert.equal(plan.patches[0].occurrenceIds.length, 2);
});

test('new or increased repeated phrases are detected using the existing analyzer', () => {
  const before = makeDoc(['كلمات أولى مختلفة.', 'نص ثان مستقل.']);
  const after = makeDoc(['نص ثان مختلف.', 'نص ثان مستقل.']);
  const snapshot = makeSnapshot(before);
  assert.ok(engine.inspectCleanupImpact(before, after, snapshot, keywords).newDuplicates.some((item: any) => item.text === 'نص ثان'));
});

test('padding outside a phrase does not count as removal', () => {
  const doc = makeDoc([`${phrase} أن التقرير جاهز.`, `${phrase} أن القياس مختلف.`]);
  const snapshot = makeSnapshot(doc);
  const after = makeDoc([`أيضًا ${phrase} أن التقرير جاهز.`, `${phrase} أن القياس مختلف.`]);
  assert.equal(engine.inspectCleanupImpact(doc, after, snapshot, keywords).unresolved.length, 1);
});

test('sentence proposals are minimized and unrelated content is not replaced', () => {
  assert.deepEqual(engine.minimizeCleanupEdit('مقدمة عامة ومعلومة مفيدة.', 'مقدمة ومعلومة مفيدة.'), { start: 6, end: 11, original: 'عامة ', replacement: '' });
  const doc = makeDoc([`${phrase} أن التقرير جاهز. جملة أخرى.`, `${phrase} أن القياس مختلف.`]);
  const snapshot = makeSnapshot(doc);
  const response = JSON.parse(makeResponse(snapshot, 1));
  response.edits[0].original = doc.child(0).textContent;
  assert.throws(() => engine.parseCleanupPlan(JSON.stringify(response), snapshot), /Ambiguous source/);
});

test('edits touching links or inline objects are rejected', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text(`${phrase} أن التقرير جاهز.`, [schema.mark('link', { href: 'https://example.com' })])), schema.node('paragraph', null, schema.text(`${phrase} أن القياس مختلف.`))]);
  const snapshot = makeSnapshot(doc);
  const plan = engine.parseCleanupPlan(makeResponse(snapshot, 1), snapshot);
  assert.throws(() => engine.simulateCleanup(doc, plan.patches), /link/);
});

test('a phrase in a heading is retained while matching prose is repaired', () => {
  const doc = schema.node('doc', null, [
    schema.node('heading', null, schema.text(phrase)),
    schema.node('paragraph', null, schema.text(`${phrase} أن التقرير جاهز.`)),
    schema.node('paragraph', null, schema.text(`${phrase} أن الجدول مكتمل.`)),
  ]);
  const snapshot = makeSnapshot(doc);
  assert.deepEqual(snapshot.occurrences.map((item: any) => snapshot.units.find((unit: any) => unit.id === item.unitIds[0]).editable), [false, true, true]);
  const reply = {
    edits: snapshot.occurrences.slice(1).map((item: any) => ({ unitId: item.unitIds[0], original: `${phrase} أن `, replacement: '', reason: 'حذف التمهيد' })),
    decisions: snapshot.occurrences.map((item: any, index: number) => ({ occurrenceId: item.id, action: index ? 'edit' : 'keep', reason: index ? 'معالجة الفقرة' : 'العنوان محمي' })),
  };
  const plan = engine.parseCleanupPlan(JSON.stringify(reply), snapshot);
  const after = engine.simulateCleanup(doc, plan.patches);
  assert.equal(after.child(0).textContent, phrase);
  assert.equal(engine.cleanupPhraseCounts(after, snapshot.phrases, 'ar').get('p1'), 1);
  const headingEdit = { ...reply, edits: [{ unitId: snapshot.occurrences[0].unitIds[0], original: phrase, replacement: '', reason: 'حذف' }],
    decisions: snapshot.occurrences.map((item: any, index: number) => ({ occurrenceId: item.id, action: index ? 'keep' : 'edit', reason: 'اختبار' })) };
  assert.throws(() => engine.parseCleanupPlan(JSON.stringify(headingEdit), snapshot), /headings or tables/);
  assert.throws(() => engine.simulateCleanup(doc, [{ ...plan.patches[0], from: snapshot.occurrences[0].from,
    to: snapshot.occurrences[0].to, original: phrase }]), /headings or tables/);
  const oldPatch = { ...plan.patches[0], id: 'old-heading-edit', from: snapshot.occurrences[0].from,
    to: snapshot.occurrences[0].to, original: phrase, unitId: snapshot.occurrences[0].unitIds[0] };
  assert.equal(engine.restoreCleanupJob(jobFor(doc, snapshot, { patches: [oldPatch], decisions: reply.decisions }), doc).patches[0].status, 'stale');
  assert.match(engine.buildCleanupPrompt(snapshot, ''), /editable=false/);
});

test('table cells and headers remain immutable while prose occurrences can change', () => {
  const doc = engine.readCleanupDocument({ type: 'doc', content: [
    { type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: phrase }] }] },
      { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: phrase }] }] },
    ] }] },
    { type: 'paragraph', content: [{ type: 'text', text: `${phrase} أن التقرير جاهز.` }] },
  ] });
  const snapshot = makeSnapshot(doc);
  assert.deepEqual(snapshot.occurrences.map((item: any) => snapshot.units.find((unit: any) => unit.id === item.unitIds[0]).editable), [false, false, true]);
  const reply = { edits: [{ unitId: snapshot.occurrences[2].unitIds[0], original: `${phrase} أن `, replacement: '', reason: 'حذف' }],
    decisions: snapshot.occurrences.map((item: any, index: number) => ({ occurrenceId: item.id,
      action: index === 2 ? 'edit' : index === 0 ? 'keep' : 'unresolved', reason: 'الجدول محمي' })) };
  const plan = engine.parseCleanupPlan(JSON.stringify(reply), snapshot);
  const after = engine.simulateCleanup(doc, plan.patches);
  assert.equal(after.firstChild!.firstChild!.firstChild!.textContent, phrase);
  assert.equal(after.firstChild!.firstChild!.lastChild!.textContent, phrase);
  assert.equal(after.lastChild!.textContent, 'التقرير جاهز.');
  assert.throws(() => engine.simulateCleanup(doc, [{ ...plan.patches[0], from: snapshot.occurrences[1].from,
    to: snapshot.occurrences[1].to, original: phrase }]), /headings or tables/);
});

test('ambiguous substrings within a sentence are rejected', () => {
  const doc = makeDoc([`${phrase} أن ${phrase} أن النتيجة واضحة.`]);
  const snapshot = makeSnapshot(doc);
  assert.throws(() => engine.parseCleanupPlan(makeResponse(snapshot, 0), snapshot), /Ambiguous/);
});
