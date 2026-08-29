import {
  assertAllowedOrigin,
  assertRequestContentLength,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  toApiSecurityResult,
} from './apiSecurity.ts';
import {
  ArticleAccessPolicyError,
  requireArticleReadAccess,
  requireArticleWriteAccess,
} from './articleAccessPolicy.ts';
import { deliverApiResult, isRecord, readRequestBody, type ApiResult } from './http.ts';
import { getExternalAnalysisSupabaseAdmin } from '../server/externalAnalysisQueue.ts';
import {
  ContentWritingSourceError,
  createArticleWritingSource,
  deleteArticleWritingSource,
  listArticleWritingSources,
  refreshArticleWritingSource,
  updateArticleWritingSource,
  type ContentWritingSourceRole,
  type ContentWritingSourceType,
} from '../server/contentWritingSources.ts';
import { ProgrammaticCompetitorExtractionError } from '../server/programmaticCompetitorExtractor.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ContentWritingSourcesApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'content_writing_sources_invalid') {
    super(message);
    this.name = 'ContentWritingSourcesApiError';
    this.status = status;
    this.code = code;
  }
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const uuid = (value: unknown, field: string): string => {
  const normalized = text(value);
  if (!UUID_PATTERN.test(normalized)) {
    throw new ContentWritingSourcesApiError(`${field} must be a valid UUID.`, 400, `${field}_invalid`);
  }
  return normalized;
};

const handleContentWritingSourcesRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === 'OPTIONS') {
    return { status: 204, headers: getCorsPreflightHeaders(req, 'POST, OPTIONS') };
  }
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, code: 'method_not_allowed', error: 'Method not allowed. Use POST.' } };
  }
  assertAllowedOrigin(req);
  assertRequestContentLength(req, 256 * 1024);
  const principal = await authenticateApiRequest(req);
  consumeApiRateLimit('content-writing-sources', principal.userId, 60);
  const body = await readRequestBody(req);
  if (!isRecord(body)) {
    throw new ContentWritingSourcesApiError('JSON body must be an object.');
  }
  const action = text(body.action) || 'list';
  const articleId = uuid(body.articleId, 'article_id');
  const supabase = getExternalAnalysisSupabaseAdmin();

  if (action === 'list') {
    await requireArticleReadAccess(supabase, articleId, principal.userId);
    const sources = await listArticleWritingSources(articleId);
    return { status: 200, body: { ok: true, sources } };
  }

  await requireArticleWriteAccess(supabase, articleId, principal.userId);
  if (action === 'create') {
    const sourceType = text(body.sourceType) as ContentWritingSourceType;
    if (sourceType !== 'url' && sourceType !== 'raw') {
      throw new ContentWritingSourcesApiError('sourceType must be url or raw.', 400, 'content_writing_source_type_invalid');
    }
    const sourceRole = (text(body.sourceRole) === 'supporting' ? 'supporting' : 'primary') as ContentWritingSourceRole;
    const source = await createArticleWritingSource({
      articleId,
      userId: principal.userId,
      sourceType,
      sourceRole,
      title: text(body.title),
      url: text(body.url),
      rawText: typeof body.rawText === 'string' ? body.rawText : '',
      focusInstructions: text(body.focusInstructions),
    });
    return { status: 200, body: { ok: true, source } };
  }

  const sourceId = uuid(body.sourceId, 'source_id');
  if (action === 'update') {
    const source = await updateArticleWritingSource({
      articleId,
      sourceId,
      userId: principal.userId,
      ...(body.sourceRole !== undefined
        ? { sourceRole: text(body.sourceRole) === 'supporting' ? 'supporting' : 'primary' }
        : {}),
      ...(body.title !== undefined ? { title: text(body.title) } : {}),
      ...(body.focusInstructions !== undefined
        ? { focusInstructions: text(body.focusInstructions) }
        : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
    });
    return { status: 200, body: { ok: true, source } };
  }
  if (action === 'refresh') {
    consumeApiRateLimit('content-writing-sources-extract', principal.userId, 15);
    const source = await refreshArticleWritingSource({ articleId, sourceId, userId: principal.userId });
    return { status: 200, body: { ok: true, source } };
  }
  if (action === 'delete') {
    await deleteArticleWritingSource(articleId, sourceId);
    return { status: 200, body: { ok: true } };
  }
  throw new ContentWritingSourcesApiError(
    'action must be list, create, update, refresh, or delete.',
    400,
    'content_writing_sources_action_invalid',
  );
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    const result = await handleContentWritingSourcesRequest(req);
    result.headers = { ...getCorsResponseHeaders(req), ...(result.headers || {}) };
    return deliverApiResult(result, res);
  } catch (error) {
    const security = toApiSecurityResult(error);
    if (security) return deliverApiResult(security, res);
    const known = error instanceof ContentWritingSourcesApiError
      || error instanceof ContentWritingSourceError
      || error instanceof ProgrammaticCompetitorExtractionError
      || error instanceof ArticleAccessPolicyError;
    const status = known && 'status' in error ? Number(error.status) : 500;
    const code = error instanceof ContentWritingSourcesApiError
      || error instanceof ContentWritingSourceError
      || error instanceof ProgrammaticCompetitorExtractionError
      ? error.code
      : error instanceof ArticleAccessPolicyError
        ? 'article_access_denied'
        : (error as { code?: string })?.code === '23505'
          ? 'content_writing_source_duplicate'
          : 'content_writing_sources_failed';
    if (status >= 500) console.error('Content writing sources API failed:', error);
    return deliverApiResult({
      status: code === 'content_writing_source_duplicate' ? 409 : status,
      body: {
        ok: false,
        code,
        error: error instanceof Error ? error.message : 'Writing source request failed.',
      },
      headers: getCorsResponseHeaders(req),
    }, res);
  }
}
