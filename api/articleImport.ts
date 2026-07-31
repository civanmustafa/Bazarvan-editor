import {
  ArticleImportExtractionError,
  getArticleImportPreview,
} from '../server/articleImportService.ts';
import { ProgrammaticCompetitorExtractionError } from '../server/programmaticCompetitorExtractor.ts';
import { deliverApiResult, isRecord, readRequestBody, type ApiResult } from './http.ts';
import {
  assertAllowedOrigin,
  assertRequestContentLength,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  toApiSecurityResult,
} from './apiSecurity.ts';

const handleArticleImportRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      headers: getCorsPreflightHeaders(req, 'POST, OPTIONS'),
    };
  }
  if (req.method !== 'POST') {
    return {
      status: 405,
      body: { ok: false, code: 'method_not_allowed', error: 'Method not allowed. Use POST.' },
    };
  }

  assertAllowedOrigin(req);
  assertRequestContentLength(req, 32 * 1024);
  const principal = await authenticateApiRequest(req);
  consumeApiRateLimit('articles:import-preview', principal.userId, 15);
  let body: unknown;
  try {
    body = await readRequestBody(req);
  } catch {
    return {
      status: 400,
      body: { ok: false, code: 'invalid_json', error: 'Request body must contain valid JSON.' },
      headers: getCorsResponseHeaders(req),
    };
  }
  if (!isRecord(body)) {
    return {
      status: 400,
      body: { ok: false, code: 'invalid_request', error: 'JSON body must be an object.' },
      headers: getCorsResponseHeaders(req),
    };
  }
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) {
    return {
      status: 400,
      body: { ok: false, code: 'article_import_url_required', error: 'Article URL is required.' },
      headers: getCorsResponseHeaders(req),
    };
  }

  const controller = new AbortController();
  const requestSignal = req?.signal && typeof req.signal.addEventListener === 'function'
    ? req.signal as AbortSignal
    : null;
  const abortFromRequest = () => controller.abort(requestSignal?.reason);
  const abortFromNodeRequest = () => controller.abort(new Error('The request was aborted by the user.'));
  requestSignal?.addEventListener('abort', abortFromRequest, { once: true });
  if (typeof req?.once === 'function') req.once('aborted', abortFromNodeRequest);

  try {
    const preview = await getArticleImportPreview({
      url,
      signal: controller.signal,
    });
    return {
      status: 200,
      body: { ok: true, preview },
      headers: getCorsResponseHeaders(req),
    };
  } finally {
    requestSignal?.removeEventListener('abort', abortFromRequest);
    if (typeof req?.off === 'function') req.off('aborted', abortFromNodeRequest);
  }
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(await handleArticleImportRequest(req), res);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) return deliverApiResult(securityResult, res);

    const knownError = error instanceof ArticleImportExtractionError
      || error instanceof ProgrammaticCompetitorExtractionError;
    const status = knownError ? error.status : 500;
    const code = knownError ? error.code : 'article_import_failed';
    const message = error instanceof Error ? error.message : 'Article import failed.';
    if (status >= 500) console.error('Article import preview failed:', error);
    return deliverApiResult({
      status,
      body: { ok: false, code, error: message },
      headers: getCorsResponseHeaders(req),
    }, res);
  }
}
