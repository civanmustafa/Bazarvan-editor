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
  deliverApiResult,
  getHeaderValue,
  isRecord,
  readRequestBody,
  type ApiResult,
} from './http.ts';
import {
  ArticleQuotaError,
  readArticleQuotaOverview,
  saveGlobalArticleQuota,
  saveUserArticleQuota,
} from '../server/articleQuota.ts';

const withCors = (req: any, result: ApiResult): ApiResult => {
  try {
    return {
      ...result,
      headers: {
        ...getCorsResponseHeaders(req),
        'Cache-Control': 'no-store',
        ...(result.headers || {}),
      },
    };
  } catch {
    return result;
  }
};

const queryUserId = (req: any): string | undefined => {
  try {
    return new URL(String(req?.url || ''), 'http://localhost').searchParams.get('userId')?.trim() || undefined;
  } catch {
    return undefined;
  }
};

const overviewResult = async (userId?: string): Promise<ApiResult> => ({
  status: 200,
  body: { ok: true, ...await readArticleQuotaOverview(userId) },
});

const handleAdminArticleQuotaRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: getCorsPreflightHeaders(req, 'GET, PUT, OPTIONS'),
    };
  }
  if (!['GET', 'PUT'].includes(req.method)) {
    return { status: 405, body: { error: 'Method not allowed. Use GET or PUT.' } };
  }
  const principal = await authenticateApiRequest(req);
  if (principal.role !== 'admin') {
    return { status: 403, body: { error: 'Administrator access is required.' } };
  }
  consumeApiRateLimit('admin:article-quota', principal.userId, 60);
  const userId = queryUserId(req);
  if (req.method === 'GET') return overviewResult(userId);

  assertRequestContentLength(req, 16_384);
  if (!getHeaderValue(req, 'content-type').includes('application/json')) {
    return { status: 415, body: { error: 'Content-Type must be application/json.' } };
  }
  const body = await readRequestBody(req);
  if (!isRecord(body)) return { status: 400, body: { error: 'A JSON request object is required.' } };
  const action = String(body.action || '').trim();
  if (action === 'save_global') {
    if (!Object.prototype.hasOwnProperty.call(body, 'defaultMonthlyLimit')) {
      return { status: 400, body: { error: 'defaultMonthlyLimit is required and may be null.' } };
    }
    await saveGlobalArticleQuota({
      actorUserId: principal.userId,
      defaultMonthlyLimit: body.defaultMonthlyLimit,
    });
    return overviewResult();
  }
  if (action === 'save_user') {
    await saveUserArticleQuota({
      actorUserId: principal.userId,
      userId: body.userId,
      mode: body.mode,
      monthlyLimit: body.monthlyLimit,
    });
    return overviewResult(String(body.userId || ''));
  }
  return { status: 400, body: { error: 'Unsupported article quota action.' } };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(withCors(req, await handleAdminArticleQuotaRequest(req)), res);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) return deliverApiResult(withCors(req, securityResult), res);
    const status = error instanceof ArticleQuotaError ? error.status : 500;
    const code = error instanceof ArticleQuotaError ? error.code : 'ARTICLE_QUOTA_REQUEST_FAILED';
    const message = error instanceof Error ? error.message : 'Could not manage article quotas.';
    console.error('Administrator article quota request failed:', { status, code, message });
    return deliverApiResult(withCors(req, {
      status,
      body: { ok: false, error: message, code },
    }), res);
  }
}
