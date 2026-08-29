import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi';

export type ContentWritingSourceType = 'url' | 'raw';
export type ContentWritingSourceRole = 'primary' | 'supporting';
export type ContentWritingSourceStatus = 'pending' | 'extracting' | 'ready' | 'failed';

export type ContentWritingSource = {
  id: string;
  articleId: string;
  sourceType: ContentWritingSourceType;
  sourceRole: ContentWritingSourceRole;
  title: string;
  sourceUrl: string | null;
  contentText: string;
  focusInstructions: string;
  status: ContentWritingSourceStatus;
  extractionMethod: 'raw' | 'programmatic' | null;
  contentHash: string | null;
  wordCount: number;
  enabled: boolean;
  lastError: string | null;
  fetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class ContentWritingSourcesRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(response: Response, payload: Record<string, unknown>) {
    super(typeof payload.error === 'string' ? payload.error : 'Writing source request failed.');
    this.name = 'ContentWritingSourcesRequestError';
    this.code = typeof payload.code === 'string' ? payload.code : 'content_writing_sources_failed';
    this.status = response.status;
  }
}

const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const normalizeSource = (value: unknown): ContentWritingSource | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.articleId !== 'string') return null;
  return {
    id: value.id,
    articleId: value.articleId,
    sourceType: value.sourceType === 'url' ? 'url' : 'raw',
    sourceRole: value.sourceRole === 'supporting' ? 'supporting' : 'primary',
    title: typeof value.title === 'string' ? value.title : '',
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : null,
    contentText: typeof value.contentText === 'string' ? value.contentText : '',
    focusInstructions: typeof value.focusInstructions === 'string' ? value.focusInstructions : '',
    status: ['pending', 'extracting', 'ready', 'failed'].includes(value.status)
      ? value.status as ContentWritingSourceStatus
      : 'failed',
    extractionMethod: value.extractionMethod === 'raw' || value.extractionMethod === 'programmatic'
      ? value.extractionMethod
      : null,
    contentHash: typeof value.contentHash === 'string' ? value.contentHash : null,
    wordCount: Math.max(0, Number(value.wordCount) || 0),
    enabled: value.enabled !== false,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    fetchedAt: typeof value.fetchedAt === 'string' ? value.fetchedAt : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  };
};

const request = async (body: Record<string, unknown>): Promise<Record<string, any>> => {
  const token = await getAuthenticatedApiToken();
  const response = await fetch('/api/content-writing/sources', {
    method: 'POST',
    headers: getAuthenticatedApiHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  const normalized = isRecord(payload) ? payload : {};
  if (!response.ok) throw new ContentWritingSourcesRequestError(response, normalized);
  return normalized;
};

export const listContentWritingSources = async (articleId: string): Promise<ContentWritingSource[]> => {
  const payload = await request({ action: 'list', articleId });
  return Array.isArray(payload.sources)
    ? payload.sources.map(normalizeSource).filter((source): source is ContentWritingSource => Boolean(source))
    : [];
};

export const createContentWritingSource = async (input: {
  articleId: string;
  sourceType: ContentWritingSourceType;
  sourceRole?: ContentWritingSourceRole;
  title?: string;
  url?: string;
  rawText?: string;
  focusInstructions?: string;
}): Promise<ContentWritingSource> => {
  const payload = await request({ action: 'create', sourceRole: 'primary', ...input });
  const source = normalizeSource(payload.source);
  if (!source) throw new Error('The writing source response is invalid.');
  return source;
};

export const updateContentWritingSource = async (input: {
  articleId: string;
  sourceId: string;
  sourceRole?: ContentWritingSourceRole;
  title?: string;
  focusInstructions?: string;
  enabled?: boolean;
}): Promise<ContentWritingSource> => {
  const payload = await request({ action: 'update', ...input });
  const source = normalizeSource(payload.source);
  if (!source) throw new Error('The writing source response is invalid.');
  return source;
};

export const refreshContentWritingSource = async (
  articleId: string,
  sourceId: string,
): Promise<ContentWritingSource> => {
  const payload = await request({ action: 'refresh', articleId, sourceId });
  const source = normalizeSource(payload.source);
  if (!source) throw new Error('The writing source response is invalid.');
  return source;
};

export const deleteContentWritingSource = async (articleId: string, sourceId: string): Promise<void> => {
  await request({ action: 'delete', articleId, sourceId });
};
