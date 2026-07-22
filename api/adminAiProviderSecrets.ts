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
} from './http.ts';
import {
  AdminAiProviderSecretError,
  deleteAdminAiProviderSecret,
  getEnvironmentGeminiApiKeys,
  getEnvironmentOpenAiApiKeys,
  normalizeAdminAiSecretProvider,
  readAdminAiProviderSecretsOverview,
  saveAdminAiProviderSecret,
  type AdminAiProviderSecretsOverview,
  type AdminAiSecretProvider,
} from '../server/adminAiProviderSecrets';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

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

const getPublicOverview = (overview: AdminAiProviderSecretsOverview) => {
  const openAiFallbackCount = getEnvironmentOpenAiApiKeys().length;
  const geminiFallbackCount = getEnvironmentGeminiApiKeys('geminiPaid').length;
  const enrich = (provider: AdminAiSecretProvider, fallbackKeyCount: number) => {
    const status = overview.providers[provider];
    const customUsable = status.enabled && status.configured && overview.encryptionConfigured;
    return {
      ...status,
      fallbackConfigured: fallbackKeyCount > 0,
      fallbackKeyCount,
      effectiveConfigured: status.enabled ? customUsable : fallbackKeyCount > 0,
      activeSource: status.enabled ? 'admin' : 'hostinger',
    };
  };

  return {
    schemaAvailable: overview.schemaAvailable,
    encryptionConfigured: overview.encryptionConfigured,
    providers: {
      openai_latest: enrich('openai_latest', openAiFallbackCount),
      gemini_latest: enrich('gemini_latest', geminiFallbackCount),
    },
  };
};

const readOverviewResult = async (): Promise<ApiResult> => ({
  status: 200,
  body: {
    ok: true,
    ...getPublicOverview(await readAdminAiProviderSecretsOverview()),
  },
});

const handleAdminAiProviderSecretsRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: getCorsPreflightHeaders(req, 'GET, PUT, DELETE, OPTIONS'),
    };
  }
  if (!['GET', 'PUT', 'DELETE'].includes(req.method)) {
    return { status: 405, body: { error: 'Method not allowed. Use GET, PUT, or DELETE.' } };
  }

  const principal = await authenticateApiRequest(req);
  if (principal.role !== 'admin') {
    return { status: 403, body: { error: 'Administrator access is required.' } };
  }
  consumeApiRateLimit('admin:ai-provider-secrets', principal.userId, 30);

  if (req.method === 'GET') return readOverviewResult();

  assertRequestContentLength(req, 4_096);
  if (!getHeaderValue(req, 'content-type').includes('application/json')) {
    return { status: 415, body: { error: 'Content-Type must be application/json.' } };
  }
  const body = await readRequestBody(req);
  if (!isRecord(body)) return { status: 400, body: { error: 'A JSON request object is required.' } };
  const provider = normalizeAdminAiSecretProvider(body.provider);

  if (req.method === 'DELETE') {
    await deleteAdminAiProviderSecret(provider);
    return readOverviewResult();
  }

  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return { status: 400, body: { error: 'enabled must be a boolean.' } };
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
    return { status: 400, body: { error: 'apiKey must be a string.' } };
  }
  await saveAdminAiProviderSecret({
    provider,
    apiKey: body.apiKey,
    enabled: body.enabled,
    updatedBy: principal.userId,
  });
  return readOverviewResult();
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(
      withCorsResponseHeaders(req, await handleAdminAiProviderSecretsRequest(req)),
      res,
    );
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) {
      return deliverApiResult(withCorsResponseHeaders(req, securityResult), res);
    }
    const status = error instanceof AdminAiProviderSecretError ? error.status : 500;
    const code = error instanceof AdminAiProviderSecretError ? error.code : 'AI_SECRET_REQUEST_FAILED';
    const message = error instanceof Error ? error.message : 'Could not update encrypted AI settings.';
    console.error('Administrator AI secret request failed:', { status, code, message });
    return deliverApiResult(withCorsResponseHeaders(req, {
      status,
      body: { ok: false, error: message, code },
    }), res);
  }
}
