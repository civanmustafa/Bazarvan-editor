import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

export type AuthenticatedApiPrincipal = {
  userId: string;
  email: string | null;
  role: string;
};

export class ApiSecurityError extends Error {
  status: number;
  headers: Record<string, string>;

  constructor(message: string, status: number, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiSecurityError';
    this.status = status;
    this.headers = headers;
  }
}

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type AuthenticationCacheEntry = {
  principal: AuthenticatedApiPrincipal;
  expiresAt: number;
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();
const authenticationCache = new Map<string, AuthenticationCacheEntry>();
let supabaseAdmin: SupabaseAdmin | null = null;

export const getHeaderValue = (req: any, headerName: string): string => {
  if (typeof req?.headers?.get === 'function') {
    return req.headers.get(headerName) || '';
  }

  const value = req?.headers?.[headerName.toLowerCase()] ?? req?.headers?.[headerName];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
};

const normalizeProjectUrl = (value: string): string => value
  .trim()
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const getSupabaseAdmin = (): SupabaseAdmin => {
  if (supabaseAdmin) return supabaseAdmin;

  const supabaseUrl = normalizeProjectUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new ApiSecurityError('Authentication service is not configured.', 503);
  }

  supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return supabaseAdmin;
};

const getBearerToken = (req: any): string => (
  getHeaderValue(req, 'authorization').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
);

export const authenticateApiRequest = async (req: any): Promise<AuthenticatedApiPrincipal> => {
  const token = getBearerToken(req);
  if (!token) throw new ApiSecurityError('Authentication is required.', 401);

  const now = Date.now();
  const tokenFingerprint = createHash('sha256').update(token).digest('hex');
  const cached = authenticationCache.get(tokenFingerprint);
  if (cached && cached.expiresAt > now) return cached.principal;
  if (cached) authenticationCache.delete(tokenFingerprint);

  const supabase = getSupabaseAdmin();
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  const user = userData.user;
  if (userError || !user?.id) {
    throw new ApiSecurityError('Invalid or expired Supabase session.', 401);
  }

  const { data: profileData, error: profileError } = await supabase
    .from('profiles')
    .select('role,is_active')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) {
    console.error('Could not validate API user profile:', {
      userId: user.id,
      code: profileError.code,
    });
    throw new ApiSecurityError('Could not validate the user profile.', 503);
  }
  let profile = profileData;
  if (!profile) {
    const fullName = typeof user.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim()
      ? user.user_metadata.full_name.trim()
      : typeof user.user_metadata?.name === 'string' && user.user_metadata.name.trim()
        ? user.user_metadata.name.trim()
        : null;
    const { data: insertedProfile, error: insertError } = await supabase
      .from('profiles')
      .insert({
        id: user.id,
        email: user.email || null,
        full_name: fullName,
        role: 'user',
      })
      .select('role,is_active')
      .maybeSingle();

    if (insertError && insertError.code !== '23505') {
      console.error('Could not create a missing API user profile:', {
        userId: user.id,
        code: insertError.code,
      });
      throw new ApiSecurityError('Could not initialize the user profile.', 503);
    }

    if (insertedProfile) {
      profile = insertedProfile;
    } else {
      const { data: concurrentProfile, error: concurrentReadError } = await supabase
        .from('profiles')
        .select('role,is_active')
        .eq('id', user.id)
        .maybeSingle();
      if (concurrentReadError || !concurrentProfile) {
        throw new ApiSecurityError('Could not initialize the user profile.', 503);
      }
      profile = concurrentProfile;
    }
  }
  if (profile?.is_active === false) {
    throw new ApiSecurityError('This user account is inactive.', 403);
  }

  const principal = {
    userId: user.id,
    email: user.email || null,
    role: typeof profile?.role === 'string' ? profile.role : 'user',
  };
  const cacheTtlSeconds = getPositiveIntegerEnv('API_AUTH_CACHE_TTL_SECONDS', 30, 300);
  authenticationCache.set(tokenFingerprint, {
    principal,
    expiresAt: now + (cacheTtlSeconds * 1000),
  });
  if (authenticationCache.size > 5_000) {
    for (const [key, entry] of authenticationCache.entries()) {
      if (entry.expiresAt <= now) authenticationCache.delete(key);
    }
    while (authenticationCache.size > 5_000) {
      const oldestKey = authenticationCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      authenticationCache.delete(oldestKey);
    }
  }
  return principal;
};

const normalizeOrigin = (value: string): string => {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
};

const getRequestOrigin = (req: any): string => {
  const requestUrl = String(req?.url || '');
  if (/^https?:\/\//i.test(requestUrl)) {
    return normalizeOrigin(requestUrl);
  }

  const host = getHeaderValue(req, 'x-forwarded-host') || getHeaderValue(req, 'host');
  if (!host) return '';
  const forwardedProto = getHeaderValue(req, 'x-forwarded-proto').split(',')[0]?.trim();
  const protocol = forwardedProto || req?.protocol || 'http';
  return normalizeOrigin(`${protocol}://${host}`);
};

const getConfiguredOrigins = (): Set<string> => new Set(
  [
    process.env.EDITOR_PUBLIC_URL,
    process.env.PUBLIC_EDITOR_URL,
    process.env.APP_BASE_URL,
    ...String(process.env.ALLOWED_API_ORIGINS || '').split(/[\n,;]+/),
  ]
    .map(value => normalizeOrigin(String(value || '').trim()))
    .filter(Boolean),
);

export const assertAllowedOrigin = (req: any): void => {
  const originHeader = getHeaderValue(req, 'origin').trim();
  if (!originHeader) return;

  const origin = normalizeOrigin(originHeader);
  const requestOrigin = getRequestOrigin(req);
  const configuredOrigins = getConfiguredOrigins();
  if (!origin || (origin !== requestOrigin && !configuredOrigins.has(origin))) {
    throw new ApiSecurityError('This request origin is not allowed.', 403);
  }
};

export const getCorsResponseHeaders = (req: any): Record<string, string> => {
  assertAllowedOrigin(req);
  const origin = normalizeOrigin(getHeaderValue(req, 'origin').trim());
  if (!origin) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
};

export const getCorsPreflightHeaders = (req: any, methods: string): Record<string, string> => ({
  ...getCorsResponseHeaders(req),
  'Access-Control-Allow-Methods': methods,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600',
});

export const getPositiveIntegerEnv = (name: string, fallback: number, maximum = 10_000): number => {
  const parsed = Number.parseInt(String(process.env[name] || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
};

export const consumeApiRateLimit = (
  bucketName: string,
  principalId: string,
  limit: number,
  windowMs = 60_000,
  now = Date.now(),
): void => {
  if (rateLimitBuckets.size > 5_000) {
    for (const [key, bucket] of rateLimitBuckets.entries()) {
      if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
    }
  }

  const key = `${bucketName}:${principalId}`;
  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (current.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    throw new ApiSecurityError('Too many requests. Please retry shortly.', 429, {
      'Retry-After': String(retryAfterSeconds),
    });
  }

  current.count += 1;
};

export const assertRequestContentLength = (req: any, maximumBytes: number): void => {
  const rawLength = getHeaderValue(req, 'content-length').trim();
  if (!rawLength) return;
  const contentLength = Number.parseInt(rawLength, 10);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new ApiSecurityError('The request body is too large.', 413);
  }
};

export const assertAiRequestPayload: (
  value: unknown,
) => asserts value is Record<string, unknown> = (value): asserts value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiSecurityError('A JSON request object is required.', 400);
  }

  const request = value as Record<string, unknown>;
  const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
  if (!prompt) throw new ApiSecurityError('The AI prompt is required.', 400);

  const maxPromptChars = getPositiveIntegerEnv('AI_MAX_PROMPT_CHARS', 500_000, 1_000_000);
  if (prompt.length > maxPromptChars) {
    throw new ApiSecurityError(`The AI prompt exceeds the ${maxPromptChars} character limit.`, 413);
  }

  if (request.history !== undefined && !Array.isArray(request.history)) {
    throw new ApiSecurityError('AI history must be an array.', 400);
  }
  if (Array.isArray(request.history)) {
    if (request.history.length > 50) {
      throw new ApiSecurityError('AI history exceeds the 50 message limit.', 413);
    }
    const historyChars = request.history.reduce((total, item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return total;
      const text = (item as Record<string, unknown>).text;
      return total + (typeof text === 'string' ? text.length : 0);
    }, 0);
    if (historyChars + prompt.length > maxPromptChars) {
      throw new ApiSecurityError('The AI prompt and history exceed the request limit.', 413);
    }
  }
};

export const toApiSecurityResult = (error: unknown): {
  status: number;
  body: { error: string };
  headers?: Record<string, string>;
} | null => {
  if (!(error instanceof ApiSecurityError)) return null;
  return {
    status: error.status,
    body: { error: error.message },
    headers: error.headers,
  };
};

export const __resetApiSecurityStateForTests = (): void => {
  rateLimitBuckets.clear();
  authenticationCache.clear();
  supabaseAdmin = null;
};
