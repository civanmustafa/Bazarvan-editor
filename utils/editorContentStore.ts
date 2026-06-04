const DB_NAME = 'bazarvan-editor-content';
const STORE_NAME = 'editorContent';
const DB_VERSION = 1;
const INLINE_FALLBACK_MAX_CHARS = 1_200_000;

export type EditorContentReference = {
  storage: 'indexeddb';
  key: string;
  fallbackContent?: any;
  updatedAt?: string;
};

type StoredEditorContent = {
  key: string;
  content: any;
  updatedAt: string;
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

export const loadEditorContent = async (key: string): Promise<any | null> => {
  const record = await runEditorContentTransaction<StoredEditorContent>('readonly', store => store.get(key));
  return record?.content ?? null;
};

export const resolveEditorContentReference = async (reference: EditorContentReference): Promise<any | null> => {
  try {
    const storedContent = await loadEditorContent(reference.key);
    if (storedContent !== null && storedContent !== undefined) {
      return storedContent;
    }
  } catch (error) {
    console.error(`Failed to load editor content backup "${reference.key}":`, error);
  }

  return reference.fallbackContent ?? null;
};

export const deleteEditorContent = async (key: string): Promise<void> => {
  await runEditorContentTransaction('readwrite', store => store.delete(key));
};
