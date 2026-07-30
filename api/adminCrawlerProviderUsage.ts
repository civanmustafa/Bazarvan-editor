import {
  assertAllowedOrigin,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  toApiSecurityResult,
} from './apiSecurity';
import {
  deliverApiResult,
  type ApiResult,
} from './http';
import {
  listCrawlerProviderUsageEvents,
} from '../server/crawlerProviderUsage';

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

const requestUrl = (req: any): URL => {
  const raw = typeof req?.url === 'string'
    ? req.url
    : typeof req?.originalUrl === 'string'
      ? req.originalUrl
      : '/api/admin/crawler-provider-usage';
  return new URL(raw, 'http://local.bazarvan');
};

const parseDate = (
  value: string | null,
  fallback: Date,
): Date => {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
};

const handleRequest = async (req: any): Promise<ApiResult> => {
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
  if (principal.role !== 'admin') {
    return { status: 403, body: { error: 'Administrator access is required.' } };
  }
  consumeApiRateLimit('admin:crawler-provider-usage', principal.userId, 60);

  const url = requestUrl(req);
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const from = parseDate(url.searchParams.get('from'), defaultFrom);
  const to = parseDate(url.searchParams.get('to'), now);
  if (from.getTime() > to.getTime()) {
    return { status: 400, body: { error: 'from must be before to.' } };
  }
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 2_000))
    : 1_000;
  const report = await listCrawlerProviderUsageEvents({
    from: from.toISOString(),
    to: to.toISOString(),
    limit,
  });
  return {
    status: 200,
    body: {
      ok: true,
      ...report,
    },
  };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(withCors(req, await handleRequest(req)), res);
  } catch (error) {
    const security = toApiSecurityResult(error);
    if (security) return deliverApiResult(withCors(req, security), res);

    const message = error instanceof Error
      ? error.message
      : 'Could not load crawler provider usage.';
    console.error('Administrator crawler provider usage request failed:', message);
    return deliverApiResult(withCors(req, {
      status: 500,
      body: {
        ok: false,
        error: message,
        code: 'CRAWLER_PROVIDER_USAGE_REQUEST_FAILED',
      },
    }), res);
  }
}
