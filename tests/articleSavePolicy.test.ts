import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { hasMeaningfulArticleContent } from '../utils/articleContent.ts';
import { canPersistArticleDraft } from '../utils/articleSavePolicy.ts';

test('an empty TipTap document and <p></p> are not article content', () => {
  assert.equal(hasMeaningfulArticleContent('<p></p>'), false);
  assert.equal(hasMeaningfulArticleContent({
    type: 'doc',
    content: [{ type: 'paragraph' }],
  }), false);
  assert.equal(hasMeaningfulArticleContent('<h2>عنوان</h2><p>نص المقالة</p>'), true);
});

test('a titled article can be saved with an intentionally empty editor', () => {
  assert.equal(canPersistArticleDraft({
    title: 'مقالة جديدة',
    articleKey: '',
    articleId: null,
    plainText: '',
  }), true);
});

test('an existing article cannot be overwritten by an empty editor', () => {
  assert.equal(canPersistArticleDraft({
    title: '',
    articleKey: '',
    articleId: '2b2ee011-04aa-4c38-b508-a35885a59200',
    plainText: '',
  }), false);
});

test('a completely unidentified empty draft is not persisted', () => {
  assert.equal(canPersistArticleDraft({
    title: '   ',
    articleKey: '',
    articleId: null,
    plainText: '\n',
  }), false);
});

test('manual, automatic, and lifecycle saves share the empty-editor protection', async () => {
  const editorContext = await readFile(
    new URL('../contexts/EditorContext.tsx', import.meta.url),
    'utf8',
  );

  assert.match(editorContext, /canPersistArticleDraft\(\{/);
  assert.match(editorContext, /performSaveDraft\(\{ reason, force: forceSave \}\)/);
  assert.match(editorContext, /handleSaveDraftRef\.current\(\{ reason: 'auto', force: false \}\)/);
  assert.match(editorContext, /handleSaveDraftRef\.current\(\{ reason: 'lifecycle', force: false \}\)/);
});
