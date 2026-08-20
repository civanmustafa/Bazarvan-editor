import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { hasMeaningfulArticleContent } from '../utils/articleContent.ts';
import {
  canPersistArticleDraft,
  shouldClearPersistedArticleBody,
} from '../utils/articleSavePolicy.ts';

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

test('an existing article can still be saved with an empty editor when article metadata is present', () => {
  assert.equal(canPersistArticleDraft({
    title: '',
    articleKey: '',
    articleId: '2b2ee011-04aa-4c38-b508-a35885a59200',
    plainText: '',
    keywords: {
      primary: 'الكلمة الأساسية',
      secondaries: ['صيغة بديلة'],
      company: 'اسم الشركة',
      lsi: ['كلمة LSI'],
    },
    goalContext: {
      pageType: 'article',
      objective: 'educate',
      audienceScope: 'global',
      searchIntent: 'informational',
    },
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

test('only a deliberately emptied loaded article requests removal of its stored body', () => {
  const emptyDocument = { type: 'doc', content: [{ type: 'paragraph' }] };
  const baseInput = {
    articleId: '2b2ee011-04aa-4c38-b508-a35885a59200',
    editorChangedAfterLoad: true,
    content: emptyDocument,
    contentHtml: '<p></p>',
    plainText: '',
  };

  assert.equal(shouldClearPersistedArticleBody(baseInput), true);
  assert.equal(shouldClearPersistedArticleBody({
    ...baseInput,
    editorChangedAfterLoad: false,
  }), false);
  assert.equal(shouldClearPersistedArticleBody({
    ...baseInput,
    articleId: null,
  }), false);
  assert.equal(shouldClearPersistedArticleBody({
    ...baseInput,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'نص' }] }] },
    contentHtml: '<p>نص</p>',
    plainText: 'نص',
  }), false);
});

test('manual, automatic, and lifecycle saves still route through the same save guard', async () => {
  const editorContext = await readFile(
    new URL('../contexts/EditorContext.tsx', import.meta.url),
    'utf8',
  );

  assert.match(editorContext, /canPersistArticleDraft\(\{/);
  assert.match(editorContext, /performSaveDraft\(\{ reason, force: forceSave \}\)/);
  assert.match(editorContext, /handleSaveDraftRef\.current\(\{ reason: 'auto', force: false \}\)/);
  assert.match(editorContext, /handleSaveDraftRef\.current\(\{ reason: 'lifecycle', force: false \}\)/);
});
