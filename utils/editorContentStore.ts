const DB_NAME = 'bazarvan-editor-content';
const STORE_NAME = 'editorContent';
const DB_VERSION = 1;

export type EditorContentReference = {
  storage: 'indexeddb';
  key: string;
};

type StoredEditorContent = {
  key: string;
  content: any;
  updatedAt: string;
};

const canUseIndexedDb = (): boolean => (
  typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined'
);

const openEditorContentDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (!canUseIndexedDb()) {
    reject(new Error('IndexedDB is not available.'));
    return;
  }

  const request = window.indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'key' });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
});

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
      db.close();
      resolve(request ? request.result : undefined);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error('IndexedDB transaction failed.'));
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error || new Error('IndexedDB transaction aborted.'));
    };

    request = action(store);
  });
};

export const createEditorContentReference = (key: string): EditorContentReference => ({
  storage: 'indexeddb',
  key,
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
  `article:${username}:${title.trim() || '(بدون عنوان)'}`
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

export const deleteEditorContent = async (key: string): Promise<void> => {
  await runEditorContentTransaction('readwrite', store => store.delete(key));
};
