import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { Keywords } from '../types.ts';

const bundle = await build({ stdin: {
  contents: `export * from './utils/duplicateCleanup'; export * from './utils/analysis/runDuplicateAnalysis'; export { Schema } from '@tiptap/pm/model'; export { Transform } from '@tiptap/pm/transform';`,
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

test('ambiguous substrings within a sentence are rejected', () => {
  const doc = makeDoc([`${phrase} أن ${phrase} أن النتيجة واضحة.`]);
  const snapshot = makeSnapshot(doc);
  assert.throws(() => engine.parseCleanupPlan(makeResponse(snapshot, 0), snapshot), /Ambiguous/);
});
