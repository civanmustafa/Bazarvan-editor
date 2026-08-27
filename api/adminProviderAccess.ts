import {
  assertAllowedOrigin,
  assertRequestContentLength,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  invalidateApiAuthenticationCache,
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
  ProviderAccessError,
  deleteCredentialGrant,
  deleteSharedProviderCredential,
  readAdminProviderAccessOverview,
  saveCredentialGrant,
  saveProviderAccessPolicy,
  saveSharedProviderCredential,
} from '../server/providerAccessControl.ts';
import {
  isProviderAccessProvider,
  isProviderCredentialMode,
  type ProviderCredentialMode,
} from '../constants/providerAccessControl.ts';
import { getExternalAnalysisSupabaseAdmin } from '../server/externalAnalysisQueue.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

const getQueryParameter = (req: any, name: string): string => {
  try {
    const requestUrl = String(req?.url || '');
    return new URL(requestUrl, 'http://localhost').searchParams.get(name)?.trim() || '';
  } catch {
    return '';
  }
};

const normalizeOptionalUuid = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(normalized)) {
    throw new ProviderAccessError(`${field} must be a valid UUID.`, 400, 'UUID_INVALID');
  }
  return normalized;
};

const readOverviewResult = async (userId?: string): Promise<ApiResult> => {
  let profile: Record<string, unknown> | null = null;
  if (userId) {
    const { data, error } = await getExternalAnalysisSupabaseAdmin()
      .from('profiles')
      .select('id,email,full_name,role,is_active,created_at,last_seen_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ProviderAccessError('User was not found.', 404, 'USER_NOT_FOUND');
    profile = data;
  }
  return {
    status: 200,
    body: {
      ok: true,
      profile,
      ...await readAdminProviderAccessOverview(userId),
    },
  };
};

const normalizePolicyPatch = (body: Record<string, any>) => {
  const source = isRecord(body.patch) ? body.patch : body;
  const credentialMode = source.credentialMode;
  if (credentialMode !== undefined && credentialMode !== null && !isProviderCredentialMode(credentialMode)) {
    throw new ProviderAccessError('Unsupported credential mode.', 400, 'CREDENTIAL_MODE_INVALID');
  }
  const booleanOrNull = (value: unknown, field: string): boolean | null | undefined => {
    if (value === undefined || value === null) return value as null | undefined;
    if (typeof value !== 'boolean') {
      throw new ProviderAccessError(`${field} must be a boolean or null.`, 400, 'POLICY_VALUE_INVALID');
    }
    return value;
  };
  return {
    enabled: booleanOrNull(source.enabled, 'enabled'),
    allowPersonalKeys: booleanOrNull(source.allowPersonalKeys, 'allowPersonalKeys'),
    credentialMode: credentialMode as ProviderCredentialMode | null | undefined,
    allowSharedFallback: booleanOrNull(source.allowSharedFallback, 'allowSharedFallback'),
    allowProviderFallback: booleanOrNull(source.allowProviderFallback, 'allowProviderFallback'),
    defaultModel: source.defaultModel,
    allowedModels: source.allowedModels,
    dailyRequestLimit: source.dailyRequestLimit,
    monthlyRequestLimit: source.monthlyRequestLimit,
  };
};

const updateUser = async (options: {
  actorId: string;
  userId: string;
  role?: unknown;
  isActive?: unknown;
}): Promise<void> => {
  const userId = normalizeOptionalUuid(options.userId, 'userId');
  if (!userId) throw new ProviderAccessError('userId is required.', 400, 'USER_ID_REQUIRED');
  if (options.role !== undefined && !['admin', 'user'].includes(String(options.role))) {
    throw new ProviderAccessError('role must be admin or user.', 400, 'USER_ROLE_INVALID');
  }
  if (options.isActive !== undefined && typeof options.isActive !== 'boolean') {
    throw new ProviderAccessError('isActive must be a boolean.', 400, 'USER_ACTIVE_INVALID');
  }
  if (options.role === undefined && options.isActive === undefined) {
    throw new ProviderAccessError('role or isActive is required.', 400, 'USER_UPDATE_EMPTY');
  }
  if (userId === options.actorId && options.isActive === false) {
    throw new ProviderAccessError('You cannot deactivate your own administrator account.', 409, 'SELF_DEACTIVATION_DENIED');
  }

  const supabase = getExternalAnalysisSupabaseAdmin();
  const { data: current, error: readError } = await supabase
    .from('profiles')
    .select('id,role,is_active')
    .eq('id', userId)
    .maybeSingle();
  if (readError) throw readError;
  if (!current) throw new ProviderAccessError('User was not found.', 404, 'USER_NOT_FOUND');

  const removingActiveAdmin = current.role === 'admin'
    && current.is_active !== false
    && (options.role === 'user' || options.isActive === false);
  if (removingActiveAdmin) {
    const { count, error: countError } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('is_active', true);
    if (countError) throw countError;
    if ((count || 0) <= 1) {
      throw new ProviderAccessError('The last active administrator cannot be demoted or disabled.', 409, 'LAST_ADMIN_PROTECTED');
    }
  }

  // Banning at the authentication layer prevents refresh-token renewal. The
  // profile check still blocks any already-issued access token immediately.
  if (options.isActive !== undefined) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      ban_duration: options.isActive ? 'none' : '876000h',
    });
    if (authError) {
      throw new ProviderAccessError(`Could not update the authentication account: ${authError.message}`, 503, 'AUTH_USER_UPDATE_FAILED');
    }
  }

  const profilePatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (options.role !== undefined) profilePatch.role = options.role;
  if (options.isActive !== undefined) profilePatch.is_active = options.isActive;
  const { error } = await supabase.from('profiles').update(profilePatch).eq('id', userId);
  if (error) throw error;

  const { error: auditError } = await supabase.from('provider_security_audit_events').insert({
    actor_user_id: options.actorId,
    target_user_id: userId,
    action: 'user_access_updated',
    metadata: {
      role: options.role ?? current.role,
      isActive: options.isActive ?? current.is_active,
    },
  });
  if (auditError && !['42P01', 'PGRST205'].includes(String(auditError.code || ''))) throw auditError;
  invalidateApiAuthenticationCache();
};

const handlePut = async (
  body: Record<string, any>,
  actorId: string,
): Promise<string | undefined> => {
  const action = String(body.action || '').trim();
  if (action === 'save_policy') {
    if (!isProviderAccessProvider(body.provider)) {
      throw new ProviderAccessError('Unsupported provider.', 400, 'PROVIDER_INVALID');
    }
    const scope = body.scope === 'global' ? 'global' : body.scope === 'user' ? 'user' : null;
    if (!scope) throw new ProviderAccessError('Policy scope must be global or user.', 400, 'POLICY_SCOPE_INVALID');
    const userId = scope === 'user' ? normalizeOptionalUuid(body.userId, 'userId') : undefined;
    await saveProviderAccessPolicy({
      scope,
      userId,
      provider: body.provider,
      patch: normalizePolicyPatch(body),
      updatedBy: actorId,
    });
    return userId;
  }
  if (action === 'save_credential') {
    if (!isProviderAccessProvider(body.provider)) {
      throw new ProviderAccessError('Unsupported provider.', 400, 'PROVIDER_INVALID');
    }
    const credential = await saveSharedProviderCredential({
      id: normalizeOptionalUuid(body.id, 'credentialId'),
      provider: body.provider,
      label: body.label,
      apiKeys: body.apiKeys,
      enabled: body.enabled,
      expiresAt: body.expiresAt,
      updatedBy: actorId,
    });
    const userId = normalizeOptionalUuid(body.userId, 'userId');
    if (body.scope === 'all' || body.scope === 'user') {
      await saveCredentialGrant({
        credentialId: credential.id,
        scope: body.scope,
        userId: body.scope === 'user' ? userId : undefined,
        priority: body.priority,
        enabled: true,
        actorId,
      });
    }
    return userId;
  }
  if (action === 'save_grant') {
    const overviewUserId = normalizeOptionalUuid(body.userId, 'userId');
    const grantUserId = body.scope === 'user' ? overviewUserId : undefined;
    await saveCredentialGrant({
      id: normalizeOptionalUuid(body.id, 'grantId'),
      credentialId: body.credentialId,
      scope: body.scope,
      userId: grantUserId,
      priority: body.priority,
      enabled: body.enabled,
      actorId,
    });
    return overviewUserId;
  }
  if (action === 'update_user') {
    const userId = normalizeOptionalUuid(body.userId, 'userId');
    if (!userId) throw new ProviderAccessError('userId is required.', 400, 'USER_ID_REQUIRED');
    await updateUser({
      actorId,
      userId,
      role: body.role,
      isActive: body.isActive,
    });
    return userId;
  }
  throw new ProviderAccessError('Unsupported provider access action.', 400, 'ACTION_INVALID');
};

const handleDelete = async (
  body: Record<string, any>,
  actorId: string,
): Promise<string | undefined> => {
  const action = String(body.action || '').trim();
  if (action === 'credential') {
    await deleteSharedProviderCredential(body.id, actorId);
  } else if (action === 'grant') {
    await deleteCredentialGrant(body.id, actorId);
  } else {
    throw new ProviderAccessError('Delete action must be credential or grant.', 400, 'DELETE_ACTION_INVALID');
  }
  return normalizeOptionalUuid(body.userId, 'userId');
};

const handleAdminProviderAccessRequest = async (req: any): Promise<ApiResult> => {
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
  consumeApiRateLimit('admin:provider-access', principal.userId, 60);
  if (req.method === 'GET') {
    return readOverviewResult(normalizeOptionalUuid(getQueryParameter(req, 'userId'), 'userId'));
  }

  assertRequestContentLength(req, 48_000);
  if (!getHeaderValue(req, 'content-type').includes('application/json')) {
    return { status: 415, body: { error: 'Content-Type must be application/json.' } };
  }
  const rawBody = await readRequestBody(req);
  if (!isRecord(rawBody)) return { status: 400, body: { error: 'A JSON request object is required.' } };
  const userId = req.method === 'PUT'
    ? await handlePut(rawBody, principal.userId)
    : await handleDelete(rawBody, principal.userId);
  return readOverviewResult(userId);
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(withCors(req, await handleAdminProviderAccessRequest(req)), res);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) return deliverApiResult(withCors(req, securityResult), res);
    const status = error instanceof ProviderAccessError ? error.status : 500;
    const code = error instanceof ProviderAccessError ? error.code : 'PROVIDER_ACCESS_REQUEST_FAILED';
    const message = error instanceof Error ? error.message : 'Could not manage provider access.';
    console.error('Administrator provider access request failed:', { status, code, message });
    return deliverApiResult(withCors(req, {
      status,
      body: { ok: false, error: message, code },
    }), res);
  }
}
