import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi';

export type ArticleImportMode = 'new' | 'replace' | 'insert';

export type ArticleImportPreview = {
  sourceUrl: string;
  canonicalUrl: string;
  fetchedUrl: string;
  title: string;
  description: string;
  author: string;
  publishedAt: string;
  language: 'ar' | 'en';
  contentHtml: string;
  plainText: string;
  wordCount: number;
  skippedImageCount: number;
  counts: {
    headings: number;
    paragraphs: number;
    lists: number;
    links: number;
    tables: number;
  };
  contentHash: string;
  extractionProvider: 'rich_html' | 'programmatic_text_fallback';
  fetchedAt: string;
  warnings: string[];
};

const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => typeof value === 'string' ? value : '';

const parsePreview = (value: unknown): ArticleImportPreview | null => {
  if (!isRecord(value) || !toText(value.contentHtml).trim() || !toText(value.plainText).trim()) return null;
  const counts = isRecord(value.counts) ? value.counts : {};
  const language = value.language === 'en' ? 'en' : 'ar';
  const extractionProvider = value.extractionProvider === 'programmatic_text_fallback'
    ? 'programmatic_text_fallback'
    : 'rich_html';
  return {
    sourceUrl: toText(value.sourceUrl),
    canonicalUrl: toText(value.canonicalUrl),
    fetchedUrl: toText(value.fetchedUrl),
    title: toText(value.title),
    description: toText(value.description),
    author: toText(value.author),
    publishedAt: toText(value.publishedAt),
    language,
    contentHtml: toText(value.contentHtml),
    plainText: toText(value.plainText),
    wordCount: Math.max(0, Number(value.wordCount) || 0),
    skippedImageCount: Math.max(0, Number(value.skippedImageCount) || 0),
    counts: {
      headings: Math.max(0, Number(counts.headings) || 0),
      paragraphs: Math.max(0, Number(counts.paragraphs) || 0),
      lists: Math.max(0, Number(counts.lists) || 0),
      links: Math.max(0, Number(counts.links) || 0),
      tables: Math.max(0, Number(counts.tables) || 0),
    },
    contentHash: toText(value.contentHash),
    extractionProvider,
    fetchedAt: toText(value.fetchedAt),
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((item): item is string => typeof item === 'string')
      : [],
  };
};

export class ArticleImportRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, payload: Record<string, any>) {
    super(toText(payload.error) || `Article import failed (${status}).`);
    this.name = 'ArticleImportRequestError';
    this.code = toText(payload.code) || 'article_import_failed';
    this.status = status;
  }
}

export const fetchArticleImportPreview = async (
  url: string,
  options: { signal?: AbortSignal } = {},
): Promise<ArticleImportPreview> => {
  const token = await getAuthenticatedApiToken();
  const response = await fetch('/api/articles/import-preview', {
    method: 'POST',
    headers: getAuthenticatedApiHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ url }),
    signal: options.signal,
  });
  const payload = await response.json().catch(() => ({}));
  const normalized = isRecord(payload) ? payload : {};
  if (!response.ok) throw new ArticleImportRequestError(response.status, normalized);
  const preview = parsePreview(normalized.preview);
  if (!preview) throw new Error('Article import preview response was invalid.');
  return preview;
};
