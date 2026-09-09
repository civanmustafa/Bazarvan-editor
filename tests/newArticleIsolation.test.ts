import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  consumeNewEditorArticleRequest,
  getArticleSaveRouteBlockReason,
  peekNewEditorArticleRequest,
  type AppRoute,
} from '../utils/appRoutes.ts';

const NEW_ARTICLE_REQUEST_KEY = 'bazarvan:new-article-request';

class MemoryStorage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

test('a queued new article can be detected before the editor consumes it', () => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage,
  });

  try {
    storage.setItem(NEW_ARTICLE_REQUEST_KEY, JSON.stringify({
      language: 'en',
      requestedAt: Date.now(),
    }));

    assert.equal(peekNewEditorArticleRequest(), 'en');
    assert.equal(peekNewEditorArticleRequest(), 'en');
    assert.equal(consumeNewEditorArticleRequest(), 'en');
    assert.equal(peekNewEditorArticleRequest(), null);
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, 'sessionStorage', previousDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  }
});

test('new article initialization cannot restore or save the previous article', async () => {
  const [editorContext, editorApp] = await Promise.all([
    readFile(new URL('../contexts/EditorContext.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/EditorApp.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(editorContext, /shouldStartWithIsolatedDocument = isInitializingNewArticle \|\| shouldIsolateRoutedArticle/);
  assert.match(editorContext, /!shouldStartWithIsolatedDocument \? readActiveArticleTitle\(\) : null/);
  assert.match(editorContext, /!shouldStartWithIsolatedDocument \? storedActiveArticleIdRef\.current : null/);
  assert.match(editorContext, /pendingInitialArticleRestoreRef\.current = null/);
  assert.match(editorContext, /pendingAutoDraftRestoreRef\.current = false/);
  assert.match(editorContext, /removeStorageValue\(AUTO_DRAFT_KEY\)/);
  assert.match(editorApp, /handleNewArticle\(requestedLanguage, \{ saveCurrentArticle: false \}\)/);
});

test('an article save is fenced to the current editor route', () => {
  const articleId = '01f8aa15-019e-4b53-9469-e622b2f0e8ad';
  assert.equal(getArticleSaveRouteBlockReason({
    route: { name: 'editor', articleId },
    activeArticleId: articleId,
    isArticleContentLoading: false,
    newArticleCreationAuthorized: false,
  }), null);
  assert.equal(getArticleSaveRouteBlockReason({
    route: { name: 'editor', articleId },
    activeArticleId: null,
    isArticleContentLoading: false,
    newArticleCreationAuthorized: false,
  }), 'article_route_mismatch');
  assert.equal(getArticleSaveRouteBlockReason({
    route: { name: 'editor', articleId },
    activeArticleId: articleId,
    isArticleContentLoading: true,
    newArticleCreationAuthorized: false,
  }), 'article_loading');
});

test('a null article id creates a row only after an explicit new-article action', () => {
  const route: AppRoute = { name: 'editor', articleId: null };
  assert.equal(getArticleSaveRouteBlockReason({
    route,
    activeArticleId: null,
    isArticleContentLoading: false,
    newArticleCreationAuthorized: false,
  }), 'new_article_intent_required');
  assert.equal(getArticleSaveRouteBlockReason({
    route,
    activeArticleId: null,
    isArticleContentLoading: false,
    newArticleCreationAuthorized: true,
  }), null);
  assert.equal(getArticleSaveRouteBlockReason({
    route: { name: 'dashboard' },
    activeArticleId: null,
    isArticleContentLoading: false,
    newArticleCreationAuthorized: true,
  }), 'not_editor_route');
});
