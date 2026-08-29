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
  UserAiProviderSecretError,
  deleteUserAiProviderKeys,
  normalizeUserAiSecretProvider,
  readUserAiProviderSecretsOverview,
  saveUserAiProviderKeys,
} from '../server/userAiProviderSecrets';
import {
  ProviderAccessError,
  resolveEffectiveProviderPolicy,
} from '../server/providerAccessControl.ts';
import type { ProviderAccessProvider } from '../constants/providerAccessControl.ts';

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

const readOverviewResult = async (userId: string): Promise<ApiResult> => ({
  status: 200,
  body: {
    ok: true,
    ...await readUserAiProviderSecretsOverview({
      actorUserId: userId,
      ownerUserId: userId,
    }),
  },
});

const handleUserAiProviderSecretsRequest = async (req: any): Promise<ApiResult> => {
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
  consumeApiRateLimit('user:ai-provider-secrets', principal.userId, 40);
  if (req.method === 'GET') return readOverviewResult(principal.userId);

  assertRequestContentLength(req, 16_384);
  if (!getHeaderValue(req, 'content-type').includes('application/json')) {
    return { status: 415, body: { error: 'Content-Type must be application/json.' } };
  }
  const body = await readRequestBody(req);
  if (!isRecord(body)) return { status: 400, body: { error: 'A JSON request object is required.' } };
  const provider = normalizeUserAiSecretProvider(body.provider);

  if (req.method === 'DELETE') {
    await deleteUserAiProviderKeys({
      actorUserId: principal.userId,
      ownerUserId: principal.userId,
      provider,
    });
    return readOverviewResult(principal.userId);
  }
  const accessProvider: ProviderAccessProvider = provider;
  const policy = await resolveEffectiveProviderPolicy(principal.userId, accessProvider);
  if (!policy.enabled
      || !policy.allowPersonalKeys
      || ['assigned_only', 'global_only', 'disabled'].includes(policy.credentialMode)) {
    throw new ProviderAccessError(
      'Personal keys are disabled for this provider by the administrator.',
      403,
      'PERSONAL_PROVIDER_KEYS_DENIED',
    );
  }
  if (body.apiKeys === undefined || (
    typeof body.apiKeys !== 'string'
    && (!Array.isArray(body.apiKeys) || body.apiKeys.some(item => typeof item !== 'string'))
  )) {
    return { status: 400, body: { error: 'apiKeys must be a string or a string array.' } };
  }
  await saveUserAiProviderKeys({
    actorUserId: principal.userId,
    ownerUserId: principal.userId,
    provider,
    apiKeys: body.apiKeys,
  });
  return readOverviewResult(principal.userId);
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(
      withCorsResponseHeaders(req, await handleUserAiProviderSecretsRequest(req)),
      res,
    );
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) {
      return deliverApiResult(withCorsResponseHeaders(req, securityResult), res);
    }
    const status = error instanceof UserAiProviderSecretError || error instanceof ProviderAccessError
      ? error.status
      : 500;
    const code = error instanceof UserAiProviderSecretError || error instanceof ProviderAccessError
      ? error.code
      : 'USER_AI_SECRET_REQUEST_FAILED';
    const message = error instanceof Error
      ? error.message
      : 'Could not update encrypted personal AI settings.';
    console.error('Personal AI secret request failed:', { status, code, message });
    return deliverApiResult(withCorsResponseHeaders(req, {
      status,
      body: { ok: false, error: message, code },
    }), res);
  }
}
