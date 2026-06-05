import type { DuplicateStats, GoalContext, Keywords, StructureStats } from '../types';

const LOCAL_CONTENT_PREFIX = 'bazarvan-editor-content:';
const LOCAL_HTML_PREFIX = 'bazarvan-editor-html:';
const LOCAL_TEXT_PREFIX = 'bazarvan-editor-text:';
const LOCAL_ARTICLE_META_PREFIX = 'bazarvan-article-meta:';
const LEGACY_CONTENT_PREFIX = 'bazarvan-editor-content-chunk:';
const LEGACY_TEXT_PREFIX = 'bazarvan-editor-content-text-chunk:';
const LEGACY_SNAPSHOT_PREFIX = 'bazarvan-article-snapshot-chunk:';
const LOCAL_CHUNK_SIZE = 180_000;
const INLINE_FALLBACK_MAX_CHARS = 300_000;

export type EditorContentReference = {
  storage: 'localStorage' | 'indexeddb';
  key: string;
  fallbackContent?: any;
  fallbackStorage?: 'localStorageChunks';
  fallbackKey?: string;
  chunkCount?: number;
  fallbackTextKey?: string;
  textChunkCount?: number;
  updatedAt?: string;
};

type StoredChunkIndex = {
  chunkCount: number;
  saveId?: string;
  updatedAt?: string;
};

type ResolveEditorContentOptions = {
  allowUnreferencedLocalFallback?: boolean;
};

type SaveEditorContentOptions = {
  saveLocalFallback?: boolean;
  saveLocalContentFallback?: boolean;
  saveLocalTextFallback?: boolean;
  textFallback?: string;
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
  contentHtml?: string;
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

type ArticleStorageMeta = Omit<ArticleStorageSnapshot, 'content' | 'contentHtml' | 'plainText'> & {
  contentKey: string;
};

const canUseLocalStorage = (): boolean => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const createSaveId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const getIndexKey = (prefix: string, key: string): string => `${prefix}${key}:index`;
const getChunkKey = (prefix: string, key: string, index: number, saveId?: string): string => (
  saveId ? `${prefix}${key}:${saveId}:${index}` : `${prefix}${key}:${index}`
);

const readIndex = (prefix: string, key: string): StoredChunkIndex | null => {
  if (!canUseLocalStorage()) return null;

  try {
    const raw = window.localStorage.getItem(getIndexKey(prefix, key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.chunkCount === 'number' && Number.isFinite(parsed.chunkCount)
      ? {
          chunkCount: parsed.chunkCount,
          saveId: typeof parsed.saveId === 'string' ? parsed.saveId : undefined,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
        }
      : null;
  } catch {
    return null;
  }
};

const removeChunksForIndex = (prefix: string, key: string, index: StoredChunkIndex | null): void => {
  if (!canUseLocalStorage() || !index) return;

  for (let chunkIndex = 0; chunkIndex < index.chunkCount; chunkIndex += 1) {
    window.localStorage.removeItem(getChunkKey(prefix, key, chunkIndex, index.saveId));
  }
};

const deleteStorageChunks = (prefix: string, key: string): void => {
  if (!canUseLocalStorage()) return;

  try {
    const index = readIndex(prefix, key);
    removeChunksForIndex(prefix, key, index);
    window.localStorage.removeItem(getIndexKey(prefix, key));

    // Legacy chunks did not include a save id. Remove a reasonable tail as cleanup.
    for (let chunkIndex = 0; chunkIndex < 200; chunkIndex += 1) {
      window.localStorage.removeItem(getChunkKey(prefix, key, chunkIndex));
    }
  } catch (error) {
    console.error(`Failed to delete local chunks "${key}":`, error);
  }
};

const saveStorageChunks = (prefix: string, key: string, serializedContent: string): number => {
  if (!canUseLocalStorage()) return 0;

  const chunks = serializedContent.match(new RegExp(`.{1,${LOCAL_CHUNK_SIZE}}`, 'gs')) || [''];
  const previousIndex = readIndex(prefix, key);
  const saveId = createSaveId();

  try {
    removeChunksForIndex(prefix, key, previousIndex);
    chunks.forEach((chunk, index) => {
      window.localStorage.setItem(getChunkKey(prefix, key, index, saveId), chunk);
    });
    window.localStorage.setItem(getIndexKey(prefix, key), JSON.stringify({
      chunkCount: chunks.length,
      saveId,
      updatedAt: new Date().toISOString(),
    }));
    return chunks.length;
  } catch (error) {
    for (let index = 0; index < chunks.length; index += 1) {
      window.localStorage.removeItem(getChunkKey(prefix, key, index, saveId));
    }
    console.error(`Failed to save local chunks "${key}":`, error);
    return 0;
  }
};

const loadStorageChunks = (prefix: string, key: string): string | null => {
  if (!canUseLocalStorage()) return null;

  try {
    const index = readIndex(prefix, key);
    if (!index || index.chunkCount <= 0) return null;

    const chunks: string[] = [];
    for (let chunkIndex = 0; chunkIndex < index.chunkCount; chunkIndex += 1) {
      const chunk = window.localStorage.getItem(getChunkKey(prefix, key, chunkIndex, index.saveId));
      if (chunk === null) return null;
      chunks.push(chunk);
    }

    return chunks.join('');
  } catch (error) {
    console.error(`Failed to load local chunks "${key}":`, error);
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
    const blockTypes = new Set(['doc', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableCell', 'tableHeader']);
    const separator = blockTypes.has(value.type) ? '\n' : '';
    return value.content.map(extractPlainTextFromEditorContent).filter(Boolean).join(separator);
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

const getSerializedLength = (content: any): number | null => {
  try {
    return JSON.stringify(content).length;
  } catch {
    return null;
  }
};

export const getAutoDraftContentKey = (username?: string | null, title?: string | null) => {
  const normalizedTitle = title?.trim();
  return username && normalizedTitle
    ? `draft:auto:${username}:${normalizedTitle}`
    : 'draft:auto';
};

export const getManualDraftContentKey = () => 'draft:manual';

export const getArticleContentKey = (username: string, title: string) => (
  `article:${username}:${title.trim() || '(untitled)'}`
);

export const getArticleSnapshotKey = (username: string, title: string) => (
  `articleSnapshot:${username}:${title.trim() || '(untitled)'}`
);

export const createEditorContentReference = (key: string): EditorContentReference => ({
  storage: 'localStorage',
  key,
});

export const createEditorContentReferenceWithFallback = (
  key: string,
  content: any,
  maxSerializedChars = INLINE_FALLBACK_MAX_CHARS,
): EditorContentReference => {
  const reference = createEditorContentReference(key);
  const serializedLength = getSerializedLength(content);
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
  storage: 'localStorage',
  key,
  fallbackStorage: 'localStorageChunks',
  fallbackKey: key,
  chunkCount,
  fallbackTextKey: key,
  textChunkCount,
  updatedAt: new Date().toISOString(),
});

export const isEditorContentReference = (value: unknown): value is EditorContentReference => (
  isRecord(value) &&
  (value.storage === 'localStorage' || value.storage === 'indexeddb') &&
  typeof value.key === 'string' &&
  value.key.trim().length > 0
);

export const saveEditorContentChunks = (key: string, content: any): number => {
  try {
    return saveStorageChunks(LOCAL_CONTENT_PREFIX, key, JSON.stringify(content));
  } catch (error) {
    console.error(`Failed to serialize editor content "${key}":`, error);
    return 0;
  }
};

export const saveEditorPlainTextChunks = (key: string, text: string): number => (
  saveStorageChunks(LOCAL_TEXT_PREFIX, key, text)
);

export const saveEditorTextChunks = (key: string, content: any): number => (
  saveEditorPlainTextChunks(key, extractPlainTextFromEditorContent(content))
);

export const saveEditorHtmlChunks = (key: string, html: string): number => (
  saveStorageChunks(LOCAL_HTML_PREFIX, key, html)
);

export const loadEditorContentChunks = (key: string): any | null => {
  const serializedContent = loadStorageChunks(LOCAL_CONTENT_PREFIX, key) ??
    loadStorageChunks(LEGACY_CONTENT_PREFIX, key);
  if (serializedContent === null) return null;

  try {
    return JSON.parse(serializedContent);
  } catch (error) {
    console.error(`Failed to parse editor content "${key}":`, error);
    return null;
  }
};

const loadEditorPlainText = (key: string): string | null => (
  loadStorageChunks(LOCAL_TEXT_PREFIX, key) ?? loadStorageChunks(LEGACY_TEXT_PREFIX, key)
);

const loadEditorHtml = (key: string): string | null => (
  loadStorageChunks(LOCAL_HTML_PREFIX, key)
);

export const loadEditorTextChunks = (key: string): any | null => {
  const text = loadEditorPlainText(key);
  return text === null ? null : createEditorContentFromPlainText(text);
};

export const deleteEditorContentChunks = (key: string): void => {
  deleteStorageChunks(LOCAL_CONTENT_PREFIX, key);
  deleteStorageChunks(LEGACY_CONTENT_PREFIX, key);
};

export const deleteEditorTextChunks = (key: string): void => {
  deleteStorageChunks(LOCAL_TEXT_PREFIX, key);
  deleteStorageChunks(LEGACY_TEXT_PREFIX, key);
};

export const deleteEditorHtmlChunks = (key: string): void => {
  deleteStorageChunks(LOCAL_HTML_PREFIX, key);
};

export const deleteArticleSnapshotChunks = (key: string): void => {
  deleteStorageChunks(LEGACY_SNAPSHOT_PREFIX, key);
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

const readArticleMeta = (snapshotKey: string): ArticleStorageMeta | null => {
  if (!canUseLocalStorage()) return null;

  try {
    const raw = window.localStorage.getItem(`${LOCAL_ARTICLE_META_PREFIX}${snapshotKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isRecord(parsed) &&
      parsed.kind === 'articleSnapshot' &&
      parsed.version === 1 &&
      typeof parsed.username === 'string' &&
      typeof parsed.title === 'string' &&
      typeof parsed.contentKey === 'string' &&
      (parsed.articleLanguage === 'ar' || parsed.articleLanguage === 'en')
        ? parsed as ArticleStorageMeta
        : null;
  } catch (error) {
    console.error(`Failed to read article meta "${snapshotKey}":`, error);
    return null;
  }
};

const writeArticleMeta = (snapshotKey: string, meta: ArticleStorageMeta): boolean => {
  if (!canUseLocalStorage()) return false;

  try {
    window.localStorage.setItem(`${LOCAL_ARTICLE_META_PREFIX}${snapshotKey}`, JSON.stringify(meta));
    return true;
  } catch (error) {
    console.error(`Failed to save article meta "${snapshotKey}":`, error);
    return false;
  }
};

const deleteArticleMeta = (snapshotKey: string): void => {
  if (!canUseLocalStorage()) return;
  window.localStorage.removeItem(`${LOCAL_ARTICLE_META_PREFIX}${snapshotKey}`);
};

const loadLegacyArticleSnapshotChunks = (key: string): ArticleStorageSnapshot | null => {
  const serializedSnapshot = loadStorageChunks(LEGACY_SNAPSHOT_PREFIX, key);
  if (serializedSnapshot === null) return null;

  try {
    const parsed = JSON.parse(serializedSnapshot);
    return isArticleStorageSnapshot(parsed) ? parsed : null;
  } catch (error) {
    console.error(`Failed to parse legacy article snapshot "${key}":`, error);
    return null;
  }
};

export const loadArticleSnapshotChunks = loadLegacyArticleSnapshotChunks;

export const createArticleSnapshotReference = (username: string, title: string): EditorContentReference => (
  createEditorContentReference(getArticleSnapshotKey(username, title))
);

export const saveArticleSnapshotDurably = async (
  snapshot: ArticleStorageSnapshot,
): Promise<{ indexedDb: boolean; localChunkCount: number; reference: EditorContentReference }> => {
  const snapshotKey = getArticleSnapshotKey(snapshot.username, snapshot.title);
  const contentKey = getArticleContentKey(snapshot.username, snapshot.title);
  const contentChunkCount = saveEditorContentChunks(contentKey, snapshot.content);
  const htmlChunkCount = snapshot.contentHtml ? saveEditorHtmlChunks(contentKey, snapshot.contentHtml) : 0;
  const textChunkCount = saveEditorPlainTextChunks(contentKey, snapshot.plainText);
  const { content: _content, contentHtml: _contentHtml, plainText: _plainText, ...metaSource } = snapshot;
  const metaSaved = writeArticleMeta(snapshotKey, {
    ...metaSource,
    contentKey,
  });

  return {
    indexedDb: false,
    localChunkCount: metaSaved && (contentChunkCount > 0 || htmlChunkCount > 0 || textChunkCount > 0)
      ? Math.max(contentChunkCount, htmlChunkCount, textChunkCount)
      : 0,
    reference: createArticleSnapshotReference(snapshot.username, snapshot.title),
  };
};

export const loadArticleSnapshot = async (username: string, title: string): Promise<ArticleStorageSnapshot | null> => {
  const snapshotKey = getArticleSnapshotKey(username, title);
  const meta = readArticleMeta(snapshotKey);

  if (meta) {
    const content = loadEditorContentChunks(meta.contentKey);
    const contentHtml = loadEditorHtml(meta.contentKey) || undefined;
    const plainText = loadEditorPlainText(meta.contentKey) || extractPlainTextFromEditorContent(content);
    if (contentHtml || content || plainText.trim()) {
      return {
        ...meta,
        content: contentHtml || content || createEditorContentFromPlainText(plainText),
        contentHtml,
        plainText,
      };
    }
  }

  const legacySnapshot = loadLegacyArticleSnapshotChunks(snapshotKey);
  if (legacySnapshot) return legacySnapshot;

  const contentKey = getArticleContentKey(username, title);
  const content = loadEditorContentChunks(contentKey);
  const contentHtml = loadEditorHtml(contentKey) || undefined;
  const plainText = loadEditorPlainText(contentKey) || extractPlainTextFromEditorContent(content);
  if (!contentHtml && !content && !plainText.trim()) return null;

  return {
    kind: 'articleSnapshot',
    version: 1,
    username,
    title,
    content: contentHtml || content || createEditorContentFromPlainText(plainText),
    contentHtml,
    plainText,
    keywords: {
      primary: '',
      secondaries: ['', '', '', ''],
      company: '',
      lsi: [],
    },
    articleLanguage: 'ar',
    savedAt: new Date().toISOString(),
  };
};

export const deleteArticleSnapshot = async (username: string, title: string): Promise<void> => {
  const snapshotKey = getArticleSnapshotKey(username, title);
  const contentKey = getArticleContentKey(username, title);
  deleteArticleMeta(snapshotKey);
  deleteEditorContentChunks(contentKey);
  deleteEditorHtmlChunks(contentKey);
  deleteEditorTextChunks(contentKey);
  deleteArticleSnapshotChunks(snapshotKey);
};

export const renameArticleSnapshot = async (username: string, oldTitle: string, newTitle: string): Promise<void> => {
  const snapshot = await loadArticleSnapshot(username, oldTitle);
  if (!snapshot) return;

  await saveArticleSnapshotDurably({
    ...snapshot,
    title: newTitle.trim() || '(untitled)',
    savedAt: new Date().toISOString(),
  });
  await deleteArticleSnapshot(username, oldTitle);
};

export const saveEditorContentDurably = async (
  key: string,
  content: any,
  options: SaveEditorContentOptions = {},
): Promise<{ indexedDb: boolean; localChunkCount: number; localTextChunkCount: number }> => {
  const localChunkCount = saveEditorContentChunks(key, content);
  const shouldSaveText = options.saveLocalTextFallback ?? options.saveLocalFallback ?? true;
  const localTextChunkCount = shouldSaveText
    ? saveEditorPlainTextChunks(key, options.textFallback ?? extractPlainTextFromEditorContent(content))
    : 0;

  return {
    indexedDb: false,
    localChunkCount,
    localTextChunkCount,
  };
};

export const loadEditorContent = async (key: string): Promise<any | null> => (
  loadEditorContentChunks(key)
);

export const resolveEditorContentReference = async (
  reference: EditorContentReference,
  options: ResolveEditorContentOptions = {},
): Promise<any | null> => {
  const key = reference.fallbackKey || reference.key;
  const content = loadEditorContentChunks(key);
  if (content !== null && content !== undefined) return content;

  if ((reference.textChunkCount || 0) > 0 || options.allowUnreferencedLocalFallback) {
    const textContent = loadEditorTextChunks(reference.fallbackTextKey || key);
    if (textContent !== null && textContent !== undefined) return textContent;
  }

  if (reference.key.startsWith('articleSnapshot:')) {
    const meta = readArticleMeta(reference.key);
    if (meta) {
      const snapshot = await loadArticleSnapshot(meta.username, meta.title);
      if (snapshot?.content) return snapshot.content;
    }
  }

  return reference.fallbackContent ?? null;
};

export const deleteEditorContent = async (key: string): Promise<void> => {
  deleteEditorContentChunks(key);
  deleteEditorTextChunks(key);
};
