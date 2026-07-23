import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canPersistArticleDraft } from '../utils/articleSavePolicy.ts';

test('a titled article can be saved with an intentionally empty editor', () => {
  assert.equal(canPersistArticleDraft({
    title: 'مقالة جديدة',
    articleKey: '',
    articleId: null,
    plainText: '',
  }), true);
});

test('an existing article can be cleared and saved without losing its identity', () => {
  assert.equal(canPersistArticleDraft({
    title: '',
    articleKey: '',
    articleId: '2b2ee011-04aa-4c38-b508-a35885a59200',
    plainText: '',
  }), true);
});

test('a completely unidentified empty draft is not persisted', () => {
  assert.equal(canPersistArticleDraft({
    title: '   ',
    articleKey: '',
    articleId: null,
    plainText: '\n',
  }), false);
});

test('manual and automatic saves share the empty-editor eligibility policy', async () => {
  const editorContext = await readFile(
    new URL('../contexts/EditorContext.tsx', import.meta.url),
    'utf8',
  );

  assert.match(editorContext, /canPersistArticleDraft\(\{/);
  assert.match(editorContext, /performSaveDraft\(\{ reason, force: forceSave \}\)/);
  assert.match(editorContext, /handleSaveDraftRef\.current\(\{ reason: 'auto', force: false \}\)/);
  assert.doesNotMatch(
    editorContext,
    /currentTextTrimmed === '' && \(title\.trim\(\) \|\| articleKey\.trim\(\)\)/,
  );
});
