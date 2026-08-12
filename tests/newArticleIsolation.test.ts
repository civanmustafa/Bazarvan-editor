import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  consumeNewEditorArticleRequest,
  peekNewEditorArticleRequest,
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

  assert.match(editorContext, /!isInitializingNewArticle \? readActiveArticleTitle\(\) : null/);
  assert.match(editorContext, /!isInitializingNewArticle \? readActiveArticleId\(\) : null/);
  assert.match(editorContext, /pendingInitialArticleRestoreRef\.current = null/);
  assert.match(editorContext, /pendingAutoDraftRestoreRef\.current = false/);
  assert.match(editorContext, /removeStorageValue\(AUTO_DRAFT_KEY\)/);
  assert.match(editorApp, /handleNewArticle\(requestedLanguage, \{ saveCurrentArticle: false \}\)/);
});
