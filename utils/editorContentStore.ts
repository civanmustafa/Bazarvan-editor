import type { DuplicateStats, GoalContext, Keywords, StructureStats } from '../types';

const DB_NAME = 'bazarvan-editor-content';
const STORE_NAME = 'editorContent';
const DB_VERSION = 1;
const INLINE_FALLBACK_MAX_CHARS = 1_200_000;
const LOCAL_CONTENT_FALLBACK_MAX_CHARS = 2_000_000;
const LOCAL_CHUNK_PREFIX = 'bazarvan-editor-content-chunk:';
const LOCAL_TEXT_CHUNK_PREFIX = 'bazarvan-editor-content-text-chunk:';
const LOCAL_ARTICLE_SNAPSHOT_CHUNK_PREFIX = 'bazarvan-article-snapshot-chunk:';
const LOCAL_CHUNK_SIZE = 200_000;

export type EditorContentReference = {
  storage: 'indexeddb';
  key: string;
  fallbackContent?: any;
  fallbackStorage?: 'localStorageChunks';
  fallbackKey?: string;
  chunkCount?: number;
  fallbackTextKey?: string;
  textChunkCount?: number;
  updatedAt?: string;
};

type StoredEditorContent = {
  key: string;
  content: any;
  updatedAt: string;
};

type ResolveEditorContentOptions = {
  allowUnreferencedLocalFallback?: boolean;
};

type SaveEditorContentOptions = {
  saveLocalFallback?: boolean;
  saveLocalContentFallback?: boolean;
  saveLocalTextFallback?: boolean;
  textFallback?: string;
  maxLocalContentChars?: number;
};

export type ArticleCompetitorSnapshot = {
  urls: string[];
  htmls: string[];
  texts: string[];
};

export type ArticleStorageSnapshot = {
  kind: 'articleSnapshot';
  version: 1;
  username: string;
  title: string;
  content: any;
  plainText: string;
  keywords: Keywords;
  goalContext?: GoalContext;
  articleLanguage: 'ar' | 'en';
  analysisSummary?: {
    wordCount: number;
    structureStats?: StructureStats;
    duplicateStats?: DuplicateStats;
  };
  attachments?: {
    competitors?: ArticleCompetitorSnapshot;
    contentSummary?: any;
  };
  savedAt: string;
};

let editorContentDbPromise: Promise<IDBDatabase> | null = null;
let persistentStoragePromise: Promise<boolean> | null = null;

const canUseIndexedDb = (): boolean => (
  typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined'
);

const requestPersistentEditorStorage = async (): Promise<boolean> => {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return false;
  }

  if (!persistentStoragePromise) {
    persistentStoragePromise = navigator.storage.persisted()
      .then(isPersisted => (isPersisted ? true : navigator.storage.persist()))
      .catch(error => {
        console.error('Failed to request persistent editor storage:', error);
        return false;
      });
  }

  return persistentStoragePromise;
};

const openEditorContentDb = (): Promise<IDBDatabase> => {
  if (!canUseIndexedDb()) {
    return Promise.reject(new Error('IndexedDB is not available.'));
  }

  if (editorContentDbPromise) {
    return editorContentDbPromise;
  }

  editorContentDbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        editorContentDbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      editorContentDbPromise = null;
      reject(request.error || new Error('Failed to open IndexedDB.'));
    };

    request.onblocked = () => {
      editorContentDbPromise = null;
      reject(new Error('IndexedDB open request was blocked.'));
    };
  });

  return editorContentDbPromise;
};

const runEditorContentTransaction = async <T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> => {
  const db = await openEditorContentDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let request: IDBRequest<T> | void;

    transaction.oncomplete = () => {
      resolve(request ? request.result : undefined);
    };
    transaction.onerror = () => {
      reject(transaction.error || new Error('IndexedDB transaction failed.'));
    };
    transaction.onabort = () => {
      reject(transaction.error || new Error('IndexedDB transaction aborted.'));
    };

    request = action(store);
  });
};

const getSerializedContentLength = (content: any): number | null => {
  try {
    return JSON.stringify(content).length;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const extractPlainTextFromEditorContent = (value: any): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractPlainTextFromEditorContent).filter(Boolean).join('\n');
  }
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (value.type === 'hardBreak') return '\n';
  if (Array.isArray(value.content)) {
    const childText = value.content.map(extractPlainTextFromEditorContent).filter(Boolean);
    const blockContainerTypes = new Set(['doc', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableCell', 'tableHeader']);
    const separator = blockContainerTypes.has(value.type) ? '\n' : '';
    return childText.join(separator);
  }
  return '';
};

const createEditorContentFromPlainText = (text: string): any | null => {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  return {
    type: 'doc',
    content: lines.map(line => ({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    })),
  };
};

const getStorageChunkIndexKey = (prefix: string, key: string): string => `${prefix}${key}:index`;
const getStorageChunkKey = (prefix: string, key: string, index: number): string => `${prefix}${key}:${index}`;

const canUseLocalStorage = (): boolean => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const readStoredChunkCountWithPrefix = (prefix: string, key: string): number => {
  if (!canUseLocalStorage()) return 0;

  try {
    const indexRaw = window.localStorage.getItem(getStorageChunkIndexKey(prefix, key));
    if (!indexRaw) return 0;
    const parsed = JSON.parse(indexRaw);
    return typeof parsed.chunkCount === 'number' && Number.isFinite(parsed.chunkCount)
      ? parsed.chunkCount
      : 0;
  } catch {
    return 0;
  }
};

const deleteStorageChunks = (prefix: string, key: string, label: string): void => {
  if (!canUseLocalStorage()) return;

  try {
    const chunkCount = readStoredChunkCountWithPrefix(prefix, key);
    for (let index = 0; index < chunkCount; index += 1) {
      window.localStorage.removeItem(getStorageChunkKey(prefix, key, index));
    }
    window.localStorage.removeItem(getStorageChunkIndexKey(prefix, key));
  } catch (error) {
    console.error(`Failed to delete local ${label} chunks "${key}":`, error);
  }
};

export const deleteEditorContentChunks = (key: string): void => {
  deleteStorageChunks(LOCAL_CHUNK_PREFIX, key, 'editor content');
};

export const deleteEditorTextChunks = (key: string): void => {
  deleteStorageChunks(LOCAL_TEXT_CHUNK_PREFIX, key, 'editor text');
};

export const deleteArticleSnapshotChunks = (key: string): void => {
  deleteStorageChunks(LOCAL_ARTICLE_SNAPSHOT_CHUNK_PREFIX, key, 'article snapshot');
};

const saveStorageChunks = (prefix: string, key: string, serializedContent: string, label: string): number => {
  if (!canUseLocalStorage()) return 0;

  const chunks = serializedContent.match(new RegExp(`.{1,${LOCAL_CHUNK_SIZE}}`, 'gs')) || [''];

  try {
    deleteStorageChunks(prefix, key, label);
    chunks.forEach((chunk, index) => {
      window.localStorage.setItem(getStorageChunkKey(prefix, key, index), chunk);
    });
    window.localStorage.setItem(getStorageChunkIndexKey(prefix, key), JSON.stringify({
      chunkCount: chunks.length,
      updatedAt: new Date().toISOString(),
    }));
    return chunks.length;
  } catch (error) {
    deleteStorageChunks(prefix, key, label);
    console.error(`Failed to save local ${label} chunks "${key}":`, error);
    return 0;
  }
};

const loadStorageChunks = (prefix: string, key: string, label: string): string | null => {
  if (!canUseLocalStorage()) return null;

  try {
    const chunkCount = readStoredChunkCountWithPrefix(prefix, key);
    if (chunkCount <= 0) return null;

    const chunks: string[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = window.localStorage.getItem(getStorageChunkKey(prefix, key, index));
      if (chunk === null) return null;
      chunks.push(chunk);
    }

    return chunks.join('');
  } catch (error) {
    console.error(`Failed to load local ${label} chunks "${key}":`, error);
    return null;
  }
};

export const saveEditorContentChunks = (key: string, content: any): number => {
  try {
    return saveStorageChunks(LOCAL_CHUNK_PREFIX, key, JSON.stringify(content), 'editor content');
  } catch (error) {
    deleteEditorContentChunks(key);
    console.error(`Failed to serialize editor content chunks "${key}":`, error);
    return 0;
  }
};

export const saveEditorTextChunks = (key: string, content: any): number => (
  saveStorageChunks(LOCAL_TEXT_CHUNK_PREFIX, key, extractPlainTextFromEditorContent(content), 'editor text')
);

export const saveEditorPlainTextChunks = (key: string, text: string): number => (
  saveStorageChunks(LOCAL_TEXT_CHUNK_PREFIX, key, text, 'editor text')
);

export const loadEditorContentChunks = (key: string): any | null => {
  const serializedContent = loadStorageChunks(LOCAL_CHUNK_PREFIX, key, 'editor content');
  if (serializedContent === null) return null;

  try {
    return JSON.parse(serializedContent);
  } catch (error) {
    console.error(`Failed to parse local editor content chunks "${key}":`, error);
    return null;
  }
};

export const loadEditorTextChunks = (key: string): any | null => {
  const textContent = loadStorageChunks(LOCAL_TEXT_CHUNK_PREFIX, key, 'editor text');
  return textContent === null ? null : createEditorContentFromPlainText(textContent);
};

export const saveArticleSnapshotChunks = (key: string, snapshot: ArticleStorageSnapshot): number => {
  try {
    return saveStorageChunks(LOCAL_ARTICLE_SNAPSHOT_CHUNK_PREFIX, key, JSON.stringify(snapshot), 'article snapshot');
  } catch (error) {
    deleteArticleSnapshotChunks(key);
    console.error(`Failed to serialize article snapshot chunks "${key}":`, error);
    return 0;
  }
};

export const loadArticleSnapshotChunks = (key: string): ArticleStorageSnapshot | null => {
  const serializedSnapshot = loadStorageChunks(LOCAL_ARTICLE_SNAPSHOT_CHUNK_PREFIX, key, 'article snapshot');
  if (serializedSnapshot === null) return null;

  try {
    const parsed = JSON.parse(serializedSnapshot);
    return isArticleStorageSnapshot(parsed) ? parsed : null;
  } catch (error) {
    console.error(`Failed to parse local article snapshot chunks "${key}":`, error);
    return null;
  }
};

export const createEditorContentReference = (key: string): EditorContentReference => ({
  storage: 'indexeddb',
  key,
});

export const createEditorContentReferenceWithFallback = (
  key: string,
  content: any,
  maxSerializedChars = INLINE_FALLBACK_MAX_CHARS,
): EditorContentReference => {
  const reference = createEditorContentReference(key);
  const serializedLength = getSerializedContentLength(content);

  if (serializedLength !== null && serializedLength <= maxSerializedChars) {
    reference.fallbackContent = content;
    reference.updatedAt = new Date().toISOString();
  }

  return reference;
};

export const createEditorContentReferenceWithChunkFallback = (
  key: string,
  chunkCount: number,
  textChunkCount = 0,
): EditorContentReference => ({
  storage: 'indexeddb',
  key,
  ...((chunkCount > 0 || textChunkCount > 0) ? {
    fallbackStorage: 'localStorageChunks' as const,
    ...(chunkCount > 0 ? {
      fallbackKey: key,
      chunkCount,
    } : {}),
    ...(textChunkCount > 0 ? {
      fallbackTextKey: key,
      textChunkCount,
    } : {}),
    updatedAt: new Date().toISOString(),
  } : {}),
});

export const isEditorContentReference = (value: unknown): value is EditorContentReference => (
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (value as EditorContentReference).storage === 'indexeddb' &&
  typeof (value as EditorContentReference).key === 'string' &&
  (value as EditorContentReference).key.trim().length > 0
);

export const getAutoDraftContentKey = () => 'draft:auto';
export const getManualDraftContentKey = () => 'draft:manual';
export const getArticleContentKey = (username: string, title: string) => (
  `article:${username}:${title.trim() || '(untitled)'}`
);
export const getArticleSnapshotKey = (username: string, title: string) => (
  `articleSnapshot:${username}:${title.trim() || '(untitled)'}`
);

export const saveEditorContent = async (key: string, content: any): Promise<void> => {
  const record: StoredEditorContent = {
    key,
    content,
    updatedAt: new Date().toISOString(),
  };

  await runEditorContentTransaction('readwrite', store => store.put(record));
};

export const isArticleStorageSnapshot = (value: unknown): value is ArticleStorageSnapshot => (
  isRecord(value) &&
  value.kind === 'articleSnapshot' &&
  value.version === 1 &&
  typeof value.username === 'string' &&
  typeof value.title === 'string' &&
  typeof value.plainText === 'string' &&
  (value.articleLanguage === 'ar' || value.articleLanguage === 'en') &&
  Object.prototype.hasOwnProperty.call(value, 'content')
);

export const createArticleSnapshotReference = (username: string, title: string): EditorContentReference => (
  createEditorContentReference(getArticleSnapshotKey(username, title))
);

export const saveArticleSnapshotDurably = async (
  snapshot: ArticleStorageSnapshot,
  options: { saveLocalFallback?: boolean } = {},
): Promise<{ indexedDb: boolean; localChunkCount: number; reference: EditorContentReference }> => {
  const key = getArticleSnapshotKey(snapshot.username, snapshot.title);
  let indexedDb = false;

  try {
    await requestPersistentEditorStorage();
    await saveEditorContent(key, snapshot);
    indexedDb = true;
  } catch (error) {
    console.error(`Failed to save unified article snapshot "${key}":`, error);
  }

  const localChunkCount = options.saveLocalFallback ? saveArticleSnapshotChunks(key, snapshot) : 0;

  return {
    indexedDb,
    localChunkCount,
    reference: createArticleSnapshotReference(snapshot.username, snapshot.title),
  };
};

export const loadArticleSnapshot = async (username: string, title: string): Promise<ArticleStorageSnapshot | null> => {
  const key = getArticleSnapshotKey(username, title);

  try {
    const storedSnapshot = await loadEditorContent(key);
    if (isArticleStorageSnapshot(storedSnapshot)) {
      return storedSnapshot;
    }
  } catch (error) {
    console.error(`Failed to load unified article snapshot "${key}":`, error);
  }

  return loadArticleSnapshotChunks(key);
};

export const deleteArticleSnapshot = async (username: string, title: string): Promise<void> => {
  const key = getArticleSnapshotKey(username, title);
  try {
    await runEditorContentTransaction('readwrite', store => store.delete(key));
  } catch (error) {
    console.error(`Failed to delete unified article snapshot "${key}":`, error);
  } finally {
    deleteArticleSnapshotChunks(key);
  }
};

export const renameArticleSnapshot = async (username: string, oldTitle: string, newTitle: string): Promise<void> => {
  const snapshot = await loadArticleSnapshot(username, oldTitle);
  if (!snapshot) return;

  await saveArticleSnapshotDurably({
    ...snapshot,
    title: newTitle.trim() || '(untitled)',
    savedAt: new Date().toISOString(),
  }, { saveLocalFallback: true });
  await deleteArticleSnapshot(username, oldTitle);
};

export const saveEditorContentDurably = async (
  key: string,
  content: any,
  options: SaveEditorContentOptions = {},
): Promise<{ indexedDb: boolean; localChunkCount: number; localTextChunkCount: number }> => {
  let indexedDb = false;

  try {
    await requestPersistentEditorStorage();
    await saveEditorContent(key, content);
    indexedDb = true;
  } catch (error) {
    console.error(`Failed to save editor content in IndexedDB "${key}":`, error);
  }

  const saveLocalTextFallback = options.saveLocalTextFallback ?? options.saveLocalFallback ?? false;
  const saveLocalContentFallback = options.saveLocalContentFallback ?? options.saveLocalFallback ?? false;
  const serializedLength = saveLocalContentFallback ? getSerializedContentLength(content) : null;
  const maxLocalContentChars = options.maxLocalContentChars ?? LOCAL_CONTENT_FALLBACK_MAX_CHARS;
  const canSaveLocalContent = saveLocalContentFallback &&
    serializedLength !== null &&
    serializedLength <= maxLocalContentChars;
  const localTextChunkCount = saveLocalTextFallback
    ? saveEditorPlainTextChunks(key, options.textFallback ?? extractPlainTextFromEditorContent(content))
    : 0;
  const localChunkCount = canSaveLocalContent ? saveEditorContentChunks(key, content) : 0;

  return { indexedDb, localChunkCount, localTextChunkCount };
};

export const loadEditorContent = async (key: string): Promise<any | null> => {
  const record = await runEditorContentTransaction<StoredEditorContent>('readonly', store => store.get(key));
  return record?.content ?? null;
};

export const resolveEditorContentReference = async (
  reference: EditorContentReference,
  options: ResolveEditorContentOptions = {},
): Promise<any | null> => {
  try {
    const storedContent = await loadEditorContent(reference.key);
    if (storedContent !== null && storedContent !== undefined) {
      if (isArticleStorageSnapshot(storedContent)) {
        const snapshotContentText = extractPlainTextFromEditorContent(storedContent.content).trim();
        if (snapshotContentText.length > 0) {
          return storedContent.content;
        }
        if (storedContent.plainText.trim().length > 0) {
          return createEditorContentFromPlainText(storedContent.plainText);
        }
      }

      const storedText = extractPlainTextFromEditorContent(storedContent).trim();
      if (storedText.length > 0) {
        return storedContent;
      }
    }
  } catch (error) {
    console.error(`Failed to load editor content backup "${reference.key}":`, error);
  }

  if ((reference.chunkCount || 0) > 0 || options.allowUnreferencedLocalFallback) {
    const chunkContent = loadEditorContentChunks(reference.fallbackKey || reference.key);
    if (chunkContent !== null && chunkContent !== undefined) {
      return chunkContent;
    }
  }

  if ((reference.textChunkCount || 0) > 0 || options.allowUnreferencedLocalFallback) {
    const textChunkContent = loadEditorTextChunks(reference.fallbackTextKey || reference.key);
    if (textChunkContent !== null && textChunkContent !== undefined) {
      return textChunkContent;
    }
  }

  return reference.fallbackContent ?? null;
};

export const deleteEditorContent = async (key: string): Promise<void> => {
  await runEditorContentTransaction('readwrite', store => store.delete(key));
  deleteEditorContentChunks(key);
  deleteEditorTextChunks(key);
};
