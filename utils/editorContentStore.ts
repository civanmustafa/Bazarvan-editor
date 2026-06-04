const DB_NAME = 'bazarvan-editor-content';
const STORE_NAME = 'editorContent';
const DB_VERSION = 1;
const INLINE_FALLBACK_MAX_CHARS = 1_200_000;
const LOCAL_CHUNK_PREFIX = 'bazarvan-editor-content-chunk:';
const LOCAL_TEXT_CHUNK_PREFIX = 'bazarvan-editor-content-text-chunk:';
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

let editorContentDbPromise: Promise<IDBDatabase> | null = null;

const canUseIndexedDb = (): boolean => (
  typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined'
);

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

export const saveEditorContent = async (key: string, content: any): Promise<void> => {
  const record: StoredEditorContent = {
    key,
    content,
    updatedAt: new Date().toISOString(),
  };

  await runEditorContentTransaction('readwrite', store => store.put(record));
};

export const saveEditorContentDurably = async (
  key: string,
  content: any,
  options: { saveLocalFallback?: boolean } = {},
): Promise<{ indexedDb: boolean; localChunkCount: number; localTextChunkCount: number }> => {
  const localTextChunkCount = options.saveLocalFallback ? saveEditorTextChunks(key, content) : 0;
  const localChunkCount = options.saveLocalFallback ? saveEditorContentChunks(key, content) : 0;
  let indexedDb = false;

  try {
    await saveEditorContent(key, content);
    indexedDb = true;
  } catch (error) {
    console.error(`Failed to save editor content in IndexedDB "${key}":`, error);
  }

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
