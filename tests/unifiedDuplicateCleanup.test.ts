import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundle = await build({ stdin: {
  contents: `export * from './utils/unifiedDuplicateCleanup'; export * from './server/duplicateCleanupJob'; export * from './utils/cleanupDocumentIdentity';`,
  resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts',
}, bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false });
const engine = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const keywords = { primary: '', company: '', secondaries: [] as string[], lsi: [] as string[] };
const makeDoc = (texts: string[]) => engine.readCleanupDocument({ type: 'doc', content: texts.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });
const prefix = 'As a matter of general observation ';
const doc = () => makeDoc([`${prefix}reports export PDF files.`, `${prefix}tables display five columns.`, `${prefix}drafts retain timestamps.`]);
const source = (prompt: string) => JSON.parse(prompt.split('SOURCE_DATA=')[1]);
const generation = (prompt: string) => {
  const data = source(prompt);
  const units = data.units.filter((unit: any) => data.blocks.find((block: any) => block.id === unit.blockId).text.slice(unit.start, unit.end).startsWith(prefix));
  const edited = units.slice(1).map((unit: any) => unit.id);
  return JSON.stringify({ edits: edited.map((unitId: string) => ({ unitId, original: prefix, replacement: '', reason: 'Remove empty introductory filler.' })),
    decisions: data.occurrences.map((item: any) => ({ occurrenceId: item.id, action: item.unitIds.some((id: string) => edited.includes(id)) ? 'edit' : 'unresolved', reason: 'Preserve substantive wording.' })) });
};
const quality = (prompt: string, approved = true) => JSON.stringify({ reviews: source(prompt).edits.map((edit: any) => ({ id: edit.id,
  preservesMeaning: approved, preservesFacts: approved, grammar: approved, coherence: approved, removesFiller: approved,
  safeShortPhrase: approved, reason: approved ? 'The facts remain intact.' : 'Meaning may change.' })) });

test('editor-only trailing paragraph and analysis highlight do not invalidate the saved article', () => {
  const saved = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Important text.' }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] }] }] };
  const live: any = structuredClone(saved);
  live.content.push({ type: 'paragraph' });
  live.content[0].content![0].marks = [{ type: 'highlight', attrs: { color: '#ffff00' } }];
  assert.equal(engine.cleanupDocumentIdentity(saved), engine.cleanupDocumentIdentity(live));
  live.content[0].content![0].text = 'Changed text.';
  assert.notEqual(engine.cleanupDocumentIdentity(saved), engine.cleanupDocumentIdentity(live));
});

test('all lengths are covered once by longer occurrences; independent short contexts remain targets', () => {
  const article = makeDoc([`${prefix}reports export PDF files.`, `${prefix}tables display columns.`,
    'In general reports are printable.', 'In general tables are sortable.']);
  const snapshot = engine.collectUnifiedCleanupSnapshot(article, keywords, 'en');
  const batches = engine.planUnifiedCleanupBatches(snapshot);
  assert.ok(batches.flatMap((batch: any) => batch.nested).length > 0);
  const sent = batches.flatMap((batch: any) => batch.phrases);
  assert.ok(sent.some((phrase: any) => phrase.key.startsWith('as a matter')));
  assert.ok(sent.some((phrase: any) => phrase.key.startsWith('in general')));
  assert.ok(sent.length < snapshot.phrases.length);
  for (const batch of batches) for (const phrase of batch.phrases) {
    assert.equal(batch.occurrences.filter((item: any) => item.phraseId === phrase.id).length, phrase.occurrenceIds.length);
  }
  const prompt = engine.buildUnifiedCleanupPrompt(batches[0], 'Article');
  const data = source(prompt);
  for (const unit of data.units) {
    assert.equal(data.blocks.find((block: any) => block.id === unit.blockId).text.slice(unit.start, unit.end), batches[0].units.find((item: any) => item.id === unit.id).text);
    assert.equal(unit.text, undefined);
  }
});

test('a partially nested phrase sends all its occurrences including the standalone one', () => {
  const article = makeDoc([`${prefix}reports export PDF files.`, `${prefix}tables show totals.`, 'General observation confirms the measured trend.']);
  const snapshot = engine.collectUnifiedCleanupSnapshot(article, keywords, 'en');
  const batches = engine.planUnifiedCleanupBatches(snapshot);
  const phrase = snapshot.phrases.find((item: any) => item.key === 'general observation');
  assert.equal(phrase.occurrenceIds.length, 3);
  assert.ok(batches.some((batch: any) => batch.phrases.some((item: any) => item.id === phrase.id)
    && batch.occurrences.filter((item: any) => item.phraseId === phrase.id).length === 3));
});

test('quality-gated workflow applies minimal edits, reanalyzes all categories and resumes without another AI call', async () => {
  let saved: any;
  let calls = 0;
  let commits = 0;
  const article = doc();
  const options = { doc: article, keywords, language: 'en', title: '', signal: new AbortController().signal,
    assertCurrent: async () => {}, checkpoint: async (value: any) => { saved = structuredClone(value); },
    commit: async (_before: any, after: any, value: any) => { commits++; saved = structuredClone(value); assert.ok(after.textContent.includes('tables display five columns.')); },
    run: async (prompt: string) => { calls++; return prompt.startsWith('Independently') ? quality(prompt) : generation(prompt); } };
  const state = await engine.runUnifiedCleanupWorkflow(options);
  assert.equal(state.appliedCount, 2);
  assert.equal(state.phase, 'completed');
  assert.equal(calls, 2);
  assert.equal(commits, 1);
  assert.ok(state.deferredOccurrences > 0);
  await engine.runUnifiedCleanupWorkflow({ ...options, saved });
  assert.equal(calls, 2);
});

test('rejected semantic review never applies and short phrases cannot be rewritten automatically', async () => {
  const article = doc();
  const state = await engine.runUnifiedCleanupWorkflow({ doc: article, keywords, language: 'en', title: '', signal: new AbortController().signal,
    assertCurrent: async () => {}, checkpoint: async () => {}, commit: async () => { assert.fail('Rejected edits were applied'); },
    run: async (prompt: string) => prompt.startsWith('Independently') ? quality(prompt, false) : generation(prompt) });
  assert.equal(state.appliedCount, 0);
  assert.equal(state.phase, 'partial');
  assert.ok(state.steps[0].review.every((item: any) => !item.approved));
  const shortDoc = makeDoc(['In general reports export files.', 'In general tables show columns.']);
  const snapshot = engine.collectUnifiedCleanupSnapshot(shortDoc, keywords, 'en');
  const unit = snapshot.units[0];
  assert.ok(engine.validateAutomaticCleanupPatch(shortDoc, { from: unit.from, to: unit.from + 10,
    unitId: unit.id, unitOffset: 0, original: 'In general', replacement: 'Usually', occurrenceIds: snapshot.phrases[0].occurrenceIds }, snapshot, keywords));
});

test('provider retry resumes at quality review and cancellation prevents any commit', async () => {
  let saved: any; let generated = 0; let fail = true;
  const controller = new AbortController();
  const options = { doc: doc(), keywords, language: 'en', title: '', signal: controller.signal,
    assertCurrent: async () => {}, checkpoint: async (state: any) => { saved = structuredClone(state); }, commit: async () => { assert.fail('Cancelled result applied'); },
    run: async (prompt: string) => {
      if (!prompt.startsWith('Independently')) { generated++; return generation(prompt); }
      if (fail) throw new Error('Provider temporarily unavailable');
      controller.abort(); return quality(prompt);
    } };
  await assert.rejects(engine.runUnifiedCleanupWorkflow(options), /temporarily/);
  assert.ok(saved.pending);
  fail = false;
  await assert.rejects(engine.runUnifiedCleanupWorkflow({ ...options, saved }), /abort/i);
  assert.equal(generated, 1);
});

test('serialization retains headings, tables, alignment, direction and links', () => {
  const json = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2, dir: 'rtl', textAlign: 'right' }, content: [{ type: 'text', text: 'عنوان محمي' }] },
    { type: 'paragraph', attrs: { dir: 'rtl', textAlign: 'right' }, content: [{ type: 'text', text: 'رابط', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'بيانات الجدول' }] }] }] }] },
  ] };
  const result = engine.serializeCleanupDocument(json);
  assert.match(result.html, /dir="rtl"/);
  assert.match(result.html, /text-align: right/);
  assert.match(result.html, /href="https:\/\/example.com"/);
  assert.match(result.html, /<table/);
  const protectedOnly = engine.readCleanupDocument({ type: 'doc', content: [json.content[0], json.content[0]] });
  assert.equal(engine.planUnifiedCleanupBatches(engine.collectUnifiedCleanupSnapshot(protectedOnly, keywords, 'ar')).length, 0);
});
