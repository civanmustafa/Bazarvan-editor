import {
  assertAllowedOrigin,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  toApiSecurityResult,
} from './apiSecurity.ts';
import { deliverApiResult, type ApiResult } from './http.ts';
import { ArticleQuotaError, readArticleQuotaOverview } from '../server/articleQuota.ts';

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

const handleUserArticleQuotaRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return { status: 204, body: {}, headers: getCorsPreflightHeaders(req, 'GET, OPTIONS') };
  }
  if (req.method !== 'GET') {
    return { status: 405, body: { error: 'Method not allowed. Use GET.' } };
  }
  const principal = await authenticateApiRequest(req);
  consumeApiRateLimit('user:article-quota', principal.userId, 60);
  return {
    status: 200,
    body: { ok: true, ...await readArticleQuotaOverview(principal.userId) },
  };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(withCors(req, await handleUserArticleQuotaRequest(req)), res);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) return deliverApiResult(withCors(req, securityResult), res);
    const status = error instanceof ArticleQuotaError ? error.status : 500;
    const code = error instanceof ArticleQuotaError ? error.code : 'USER_ARTICLE_QUOTA_REQUEST_FAILED';
    const message = error instanceof Error ? error.message : 'Could not load the article quota.';
    console.error('User article quota request failed:', { status, code, message });
    return deliverApiResult(withCors(req, {
      status,
      body: { ok: false, error: message, code },
    }), res);
  }
}
