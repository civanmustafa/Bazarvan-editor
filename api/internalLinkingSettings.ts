import {
  ApiSecurityError,
  assertAllowedOrigin,
  authenticateApiRequest,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  toApiSecurityResult,
} from './apiSecurity';
import { deliverApiResult, type ApiResult } from './http.ts';
import { readInternalLinkAutomationSettings } from '../server/internalLinkingSettings';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const readArticleId = (req: any): string => {
  const fromQuery = typeof req?.query?.articleId === 'string' ? req.query.articleId.trim() : '';
  const fromUrl = new URL(String(req?.url || ''), 'http://localhost')
    .searchParams.get('articleId')?.trim() || '';
  const articleId = fromQuery || fromUrl;
  if (!UUID_PATTERN.test(articleId)) {
    throw new ApiSecurityError('articleId must be a valid UUID.', 400);
  }
  return articleId;
};

const withCorsResponseHeaders = (req: any, result: ApiResult): ApiResult => {
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

const handleInternalLinkingSettingsRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: getCorsPreflightHeaders(req, 'GET, OPTIONS'),
    };
  }
  if (req.method !== 'GET') {
    return { status: 405, body: { error: 'Method not allowed. Use GET.' } };
  }

  const principal = await authenticateApiRequest(req);
  const articleId = readArticleId(req);
  return {
    status: 200,
    body: {
      ok: true,
      settings: await readInternalLinkAutomationSettings({
        articleId,
        userId: principal.userId,
      }),
    },
  };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(
      withCorsResponseHeaders(req, await handleInternalLinkingSettingsRequest(req)),
      res,
    );
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) {
      return deliverApiResult(withCorsResponseHeaders(req, securityResult), res);
    }
    console.error('Internal-link runtime settings request failed:', error);
    return deliverApiResult(withCorsResponseHeaders(req, {
      status: 500,
      body: { ok: false, error: 'Could not load internal-link automation settings.' },
    }), res);
  }
}
