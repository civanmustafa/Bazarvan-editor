import { createHash } from 'node:crypto';
import {
  getProgrammaticCompetitorContent,
  normalizeProgrammaticCompetitorUrl,
} from './programmaticCompetitorExtractor.ts';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';

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

type SourceRow = {
  id: string;
  article_id: string;
  source_type: ContentWritingSourceType;
  source_role: ContentWritingSourceRole;
  title: string | null;
  source_url: string | null;
  content_text: string | null;
  focus_instructions: string | null;
  status: ContentWritingSourceStatus;
  extraction_method: 'raw' | 'programmatic' | null;
  content_hash: string | null;
  word_count: number | null;
  enabled: boolean;
  last_error: string | null;
  fetched_at: string | null;
  created_at: string;
  updated_at: string;
};

const SOURCE_COLUMNS = 'id,article_id,source_type,source_role,title,source_url,content_text,focus_instructions,status,extraction_method,content_hash,word_count,enabled,last_error,fetched_at,created_at,updated_at';
const MAX_SOURCES_PER_ARTICLE = 10;
const MAX_SOURCE_TEXT_CHARS = 120_000;

export class ContentWritingSourceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'content_writing_source_invalid') {
    super(message);
    this.name = 'ContentWritingSourceError';
    this.status = status;
    this.code = code;
  }
}

const text = (value: unknown, maximum: number): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const countWords = (value: string): number => (
  value.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu)?.length || 0
);

const hashText = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const toSource = (row: SourceRow): ContentWritingSource => ({
  id: row.id,
  articleId: row.article_id,
  sourceType: row.source_type,
  sourceRole: row.source_role === 'supporting' ? 'supporting' : 'primary',
  title: row.title || '',
  sourceUrl: row.source_url || null,
  contentText: row.content_text || '',
  focusInstructions: row.focus_instructions || '',
  status: row.status,
  extractionMethod: row.extraction_method || null,
  contentHash: row.content_hash || null,
  wordCount: Math.max(0, Number(row.word_count) || 0),
  enabled: row.enabled !== false,
  lastError: row.last_error || null,
  fetchedAt: row.fetched_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const readSourceRow = async (sourceId: string, articleId: string): Promise<SourceRow> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_writing_sources')
    .select(SOURCE_COLUMNS)
    .eq('id', sourceId)
    .eq('article_id', articleId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ContentWritingSourceError('Writing source was not found.', 404, 'content_writing_source_not_found');
  return data as SourceRow;
};

export const listArticleWritingSources = async (articleId: string): Promise<ContentWritingSource[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_writing_sources')
    .select(SOURCE_COLUMNS)
    .eq('article_id', articleId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(row => toSource(row as SourceRow));
};

export const readReadyArticleWritingSources = async (articleId: string): Promise<ContentWritingSource[]> => (
  (await listArticleWritingSources(articleId)).filter(source => (
    source.enabled && source.status === 'ready' && Boolean(source.contentText.trim())
  ))
);

const ensureSourceCapacity = async (articleId: string): Promise<void> => {
  const { count, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_writing_sources')
    .select('id', { count: 'exact', head: true })
    .eq('article_id', articleId);
  if (error) throw error;
  if ((count || 0) >= MAX_SOURCES_PER_ARTICLE) {
    throw new ContentWritingSourceError(
      `An article can have at most ${MAX_SOURCES_PER_ARTICLE} writing sources.`,
      422,
      'content_writing_source_limit_reached',
    );
  }
};

const persistExtractionFailure = async (
  sourceId: string,
  articleId: string,
  userId: string,
  error: unknown,
): Promise<ContentWritingSource> => {
  const message = text(error instanceof Error ? error.message : 'Source extraction failed.', 2_000);
  const { data, error: updateError } = await getExternalAnalysisSupabaseAdmin()
    .from('article_writing_sources')
    .update({
      status: 'failed',
      last_error: message,
      updated_by: userId,
    })
    .eq('id', sourceId)
    .eq('article_id', articleId)
    .select(SOURCE_COLUMNS)
    .single();
  if (updateError) throw updateError;
  return toSource(data as SourceRow);
};

export const refreshArticleWritingSource = async (options: {
  articleId: string;
  sourceId: string;
  userId: string;
}): Promise<ContentWritingSource> => {
  const row = await readSourceRow(options.sourceId, options.articleId);
  if (row.source_type !== 'url' || !row.source_url) {
    throw new ContentWritingSourceError('Only URL sources can be refreshed.', 422, 'content_writing_source_refresh_not_supported');
  }
  await getExternalAnalysisSupabaseAdmin()
    .from('article_writing_sources')
    .update({ status: 'extracting', last_error: null, updated_by: options.userId })
    .eq('id', options.sourceId)
    .eq('article_id', options.articleId);
  try {
    const extracted = await getProgrammaticCompetitorContent({
      url: row.source_url,
      forceRefresh: true,
      timeoutMs: 35_000,
      maximumBytes: 3_000_000,
    });
    const contentText = extracted.text.slice(0, MAX_SOURCE_TEXT_CHARS).trim();
    const { data, error } = await getExternalAnalysisSupabaseAdmin()
      .from('article_writing_sources')
      .update({
        title: row.title?.trim() || extracted.title.slice(0, 500),
        source_url: extracted.canonicalUrl,
        content_text: contentText,
        status: 'ready',
        extraction_method: 'programmatic',
        content_hash: hashText(contentText),
        word_count: countWords(contentText),
        last_error: null,
        fetched_at: extracted.fetchedAt,
        updated_by: options.userId,
      })
      .eq('id', options.sourceId)
      .eq('article_id', options.articleId)
      .select(SOURCE_COLUMNS)
      .single();
    if (error) throw error;
    return toSource(data as SourceRow);
  } catch (error) {
    return persistExtractionFailure(options.sourceId, options.articleId, options.userId, error);
  }
};

export const createArticleWritingSource = async (options: {
  articleId: string;
  userId: string;
  sourceType: ContentWritingSourceType;
  sourceRole?: ContentWritingSourceRole;
  title?: string;
  url?: string;
  rawText?: string;
  focusInstructions?: string;
}): Promise<ContentWritingSource> => {
  await ensureSourceCapacity(options.articleId);
  const sourceRole = options.sourceRole === 'supporting' ? 'supporting' : 'primary';
  const title = text(options.title, 500);
  const focusInstructions = text(options.focusInstructions, 2_000);
  if (options.sourceType === 'raw') {
    const contentText = text(options.rawText, MAX_SOURCE_TEXT_CHARS);
    if (countWords(contentText) < 5) {
      throw new ContentWritingSourceError('Raw writing source must contain at least five words.', 422, 'content_writing_source_text_too_short');
    }
    const { data, error } = await getExternalAnalysisSupabaseAdmin()
      .from('article_writing_sources')
      .insert({
        article_id: options.articleId,
        source_type: 'raw',
        source_role: sourceRole,
        title: title || 'نص خام',
        source_url: null,
        content_text: contentText,
        focus_instructions: focusInstructions,
        status: 'ready',
        extraction_method: 'raw',
        content_hash: hashText(contentText),
        word_count: countWords(contentText),
        enabled: true,
        fetched_at: new Date().toISOString(),
        created_by: options.userId,
        updated_by: options.userId,
      })
      .select(SOURCE_COLUMNS)
      .single();
    if (error) throw error;
    return toSource(data as SourceRow);
  }

  const sourceUrl = normalizeProgrammaticCompetitorUrl(text(options.url, 2_048));
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_writing_sources')
    .insert({
      article_id: options.articleId,
      source_type: 'url',
      source_role: sourceRole,
      title,
      source_url: sourceUrl,
      content_text: '',
      focus_instructions: focusInstructions,
      status: 'extracting',
      enabled: true,
      created_by: options.userId,
      updated_by: options.userId,
    })
    .select(SOURCE_COLUMNS)
    .single();
  if (error) throw error;
  return refreshArticleWritingSource({
    articleId: options.articleId,
    sourceId: String(data.id),
    userId: options.userId,
  });
};

export const updateArticleWritingSource = async (options: {
  articleId: string;
  sourceId: string;
  userId: string;
  sourceRole?: ContentWritingSourceRole;
  title?: string;
  focusInstructions?: string;
  enabled?: boolean;
}): Promise<ContentWritingSource> => {
  await readSourceRow(options.sourceId, options.articleId);
  const patch: Record<string, unknown> = { updated_by: options.userId };
  if (options.sourceRole !== undefined) {
    patch.source_role = options.sourceRole === 'supporting' ? 'supporting' : 'primary';
  }
  if (options.title !== undefined) patch.title = text(options.title, 500);
  if (options.focusInstructions !== undefined) {
    patch.focus_instructions = text(options.focusInstructions, 2_000);
  }
  if (options.enabled !== undefined) patch.enabled = options.enabled === true;
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_writing_sources')
    .update(patch)
    .eq('id', options.sourceId)
    .eq('article_id', options.articleId)
    .select(SOURCE_COLUMNS)
    .single();
  if (error) throw error;
  return toSource(data as SourceRow);
};

export const deleteArticleWritingSource = async (articleId: string, sourceId: string): Promise<void> => {
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from('article_writing_sources')
    .delete()
    .eq('id', sourceId)
    .eq('article_id', articleId);
  if (error) throw error;
};
