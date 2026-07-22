import {
  assertAllowedOrigin,
  assertRequestContentLength,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  getPositiveIntegerEnv,
  toApiSecurityResult,
} from './apiSecurity';
import {
  ArticleAccessPolicyError,
  requireArticleWriteAccess,
} from './articleAccessPolicy';
import { deliverApiResult, getHeaderValue, isRecord, readRequestBody, type ApiResult } from './http';
import {
  ContentWritingEngineError,
  recordExternalContentWritingResult,
} from '../server/contentWritingEngine';
import { getExternalAnalysisSupabaseAdmin } from '../server/externalAnalysisQueue';
import { toPublicContentWritingSession } from '../server/contentWritingPresenter';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{16,160}$/;
const INPUT_HASH_PATTERN = /^[a-f0-9]{64}$/;

class ExternalContentWritingApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'external_content_writing_request_invalid') {
    super(message);
    this.name = 'ExternalContentWritingApiError';
    this.status = status;
    this.code = code;
  }
}

const toText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const handleExternalContentWritingResult = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return { status: 204, body: {}, headers: getCorsPreflightHeaders(req, 'POST, OPTIONS') };
  }
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'Method not allowed. Use POST.' } };
  }

  const principal = await authenticateApiRequest(req);
  consumeApiRateLimit(
    'content-writing:external-result',
    principal.userId,
    getPositiveIntegerEnv('CONTENT_WRITING_EXTERNAL_RESULT_RATE_LIMIT_PER_MINUTE', 12),
  );
  assertRequestContentLength(
    req,
    getPositiveIntegerEnv('CONTENT_WRITING_EXTERNAL_RESULT_MAX_BYTES', 4_000_000, 8_000_000),
  );
  if (!getHeaderValue(req, 'content-type').includes('application/json')) {
    throw new ExternalContentWritingApiError('Content-Type must be application/json.', 415, 'unsupported_content_type');
  }
  const body = await readRequestBody(req);
  if (!isRecord(body)) {
    throw new ExternalContentWritingApiError('JSON body must be an object.', 400, 'invalid_json_body');
  }

  const articleId = toText(body.articleId);
  if (!UUID_PATTERN.test(articleId)) {
    throw new ExternalContentWritingApiError('articleId must be a valid UUID.', 400, 'article_id_invalid');
  }
  const externalProvider = toText(body.externalProvider);
  if (!['chatgpt', 'gemini'].includes(externalProvider)) {
    throw new ExternalContentWritingApiError(
      'externalProvider must be chatgpt or gemini.',
      400,
      'external_provider_invalid',
    );
  }
  const idempotencyKey = toText(body.idempotencyKey);
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new ExternalContentWritingApiError(
      'idempotencyKey must contain 16-160 letters, numbers, colons, underscores, or hyphens.',
      400,
      'content_writing_idempotency_key_invalid',
    );
  }
  const preparedInputHash = toText(body.preparedInputHash);
  if (!INPUT_HASH_PATTERN.test(preparedInputHash)) {
    throw new ExternalContentWritingApiError(
      'preparedInputHash must be a SHA-256 hash.',
      400,
      'content_writing_input_hash_invalid',
    );
  }
  const resultText = typeof body.resultText === 'string' ? body.resultText.trim() : '';
  if (!resultText) {
    throw new ExternalContentWritingApiError(
      'The external content writing result cannot be empty.',
      422,
      'content_writing_external_result_empty',
    );
  }
  if (resultText.length > 1_000_000) {
    throw new ExternalContentWritingApiError(
      'The external content writing result is too large.',
      413,
      'content_writing_external_result_too_large',
    );
  }

  const supabase = getExternalAnalysisSupabaseAdmin();
  await requireArticleWriteAccess(supabase, articleId, principal.userId);
  const recorded = await recordExternalContentWritingResult({
    articleId,
    createdBy: principal.userId,
    externalProvider: externalProvider as 'chatgpt' | 'gemini',
    idempotencyKey,
    preparedInputHash,
    resultText,
  });
  return {
    status: recorded.created ? 201 : 200,
    body: {
      ok: true,
      created: recorded.created,
      session: toPublicContentWritingSession(recorded.session),
    },
  };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  let result: ApiResult;
  try {
    result = await handleExternalContentWritingResult(req);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) {
      result = securityResult;
    } else {
      const known = error instanceof ExternalContentWritingApiError
        || error instanceof ContentWritingEngineError
        || error instanceof ArticleAccessPolicyError;
      const status = known && 'status' in error ? Number(error.status) : 500;
      const code = error instanceof ExternalContentWritingApiError || error instanceof ContentWritingEngineError
        ? error.code
        : error instanceof ArticleAccessPolicyError
          ? 'article_access_denied'
          : 'external_content_writing_request_failed';
      console.error('External content writing result API error:', error);
      result = {
        status,
        body: {
          ok: false,
          code,
          error: error instanceof Error ? error.message : 'Unknown external content writing error.',
        },
      };
    }
  }

  try {
    result.headers = { ...getCorsResponseHeaders(req), ...(result.headers || {}) };
  } catch {
    // Origin validation errors intentionally omit CORS headers.
  }
  return deliverApiResult(result, res);
}
