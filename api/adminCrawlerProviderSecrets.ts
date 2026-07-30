import {
  assertAllowedOrigin,
  assertRequestContentLength,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  toApiSecurityResult,
} from './apiSecurity';
import {
  deliverApiResult,
  getHeaderValue,
  readRequestBody,
  type ApiResult,
} from './http';
import {
  CrawlerProviderSecretError,
  deleteCrawlerProviderSecret,
  normalizeCrawlerExternalProvider,
  readCrawlerProviderSecretsOverview,
  saveCrawlerProviderSecret,
} from '../server/crawlerProviderSecrets';
import {
  readCrawlerProviderMonthlyUsage,
  readCrawlerUsagePolicy,
  saveCrawlerUsagePolicy,
} from '../server/crawlerUsagePolicy';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

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

const readOverview = async (): Promise<ApiResult> => {
  const [secrets, usagePolicy] = await Promise.all([
    readCrawlerProviderSecretsOverview(),
    readCrawlerUsagePolicy(),
  ]);
  return {
    status: 200,
    body: {
      ok: true,
      ...secrets,
      usagePolicy,
      monthlyUsage: await readCrawlerProviderMonthlyUsage(usagePolicy),
    },
  };
};

const handleRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: getCorsPreflightHeaders(req, 'GET, PUT, DELETE, OPTIONS'),
    };
  }
  if (!['GET', 'PUT', 'DELETE'].includes(req.method)) {
    return {
      status: 405,
      body: { error: 'Method not allowed. Use GET, PUT, or DELETE.' },
    };
  }

  const principal = await authenticateApiRequest(req);
  if (principal.role !== 'admin') {
    return { status: 403, body: { error: 'Administrator access is required.' } };
  }
  consumeApiRateLimit('admin:crawler-provider-secrets', principal.userId, 30);
  if (req.method === 'GET') return readOverview();

  assertRequestContentLength(req, 4_096);
  if (!getHeaderValue(req, 'content-type').includes('application/json')) {
    return { status: 415, body: { error: 'Content-Type must be application/json.' } };
  }
  const body = await readRequestBody(req);
  if (!isRecord(body)) {
    return { status: 400, body: { error: 'A JSON request object is required.' } };
  }
  if (req.method === 'PUT' && body.action === 'save_usage_policy') {
    await saveCrawlerUsagePolicy({
      value: body.usagePolicy,
      updatedBy: principal.userId,
    });
    return readOverview();
  }
  const provider = normalizeCrawlerExternalProvider(body.provider);
  if (req.method === 'DELETE') {
    await deleteCrawlerProviderSecret(provider);
    return readOverview();
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return { status: 400, body: { error: 'enabled must be a boolean.' } };
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
    return { status: 400, body: { error: 'apiKey must be a string.' } };
  }

  await saveCrawlerProviderSecret({
    provider,
    apiKey: body.apiKey,
    enabled: body.enabled,
    updatedBy: principal.userId,
  });
  return readOverview();
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(withCors(req, await handleRequest(req)), res);
  } catch (error) {
    const security = toApiSecurityResult(error);
    if (security) return deliverApiResult(withCors(req, security), res);

    const status = error instanceof CrawlerProviderSecretError ? error.status : 500;
    const code = error instanceof CrawlerProviderSecretError
      ? error.code
      : 'CRAWLER_SECRET_REQUEST_FAILED';
    const message = error instanceof Error
      ? error.message
      : 'Could not update encrypted crawler settings.';
    if (status >= 500) {
      console.error('Administrator crawler secret request failed:', { status, code, message });
    }
    return deliverApiResult(withCors(req, {
      status,
      body: { ok: false, error: message, code },
    }), res);
  }
}
