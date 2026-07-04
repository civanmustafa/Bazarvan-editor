import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

type SupabaseAdmin = SupabaseClient<any, 'public', any>;
type UserRole = 'admin' | 'user';

class AdminUsersError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AdminUsersError';
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const readNodeBody = async (req: any): Promise<unknown> => {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    return req.body;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

const readRequestBody = async (req: any): Promise<unknown> => {
  if (typeof req.json === 'function' && typeof req.headers?.get === 'function') {
    return req.json();
  }
  return readNodeBody(req);
};

const getHeaderValue = (req: any, headerName: string): string => {
  if (typeof req.headers?.get === 'function') {
    return req.headers.get(headerName) || '';
  }

  const directValue = req.headers?.[headerName.toLowerCase()] || req.headers?.[headerName];
  return Array.isArray(directValue) ? String(directValue[0] || '') : String(directValue || '');
};

const getBearerToken = (req: any): string => {
  const authorization = getHeaderValue(req, 'authorization');
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
};

const normalizeProjectUrl = (value: string): string => value
  .trim()
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const getSupabaseAdmin = (): SupabaseAdmin => {
  const supabaseUrl = normalizeProjectUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!supabaseUrl) throw new AdminUsersError('SUPABASE_URL or VITE_SUPABASE_URL is not configured.', 503);
  if (!serviceRoleKey) throw new AdminUsersError('SUPABASE_SERVICE_ROLE_KEY is not configured.', 503);

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
};

const assertAdmin = async (supabase: SupabaseAdmin, req: any): Promise<string> => {
  const token = getBearerToken(req);
  if (!token) throw new AdminUsersError('Authentication is required.', 401);

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user?.id) {
    throw new AdminUsersError('Invalid Supabase session.', 401);
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id,role,is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError) throw profileError;
  if (!profile || profile.role !== 'admin' || profile.is_active === false) {
    throw new AdminUsersError('Admin access is required.', 403);
  }

  return userData.user.id;
};

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeEmail = (value: unknown): string => toTrimmedString(value).toLowerCase();

const normalizeRole = (value: unknown): UserRole => (
  toTrimmedString(value) === 'admin' ? 'admin' : 'user'
);

const sanitizeCreateUserBody = (body: unknown) => {
  if (!isRecord(body)) throw new AdminUsersError('JSON body must be an object.', 400);

  const email = normalizeEmail(body.email);
  const password = toTrimmedString(body.password);
  const fullName = toTrimmedString(body.fullName || body.full_name);
  const role = normalizeRole(body.role);
  const isActive = body.isActive !== false && body.is_active !== false;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AdminUsersError('Valid email is required.', 400);
  }
  if (password.length < 8) {
    throw new AdminUsersError('Password must be at least 8 characters.', 400);
  }

  return { email, password, fullName, role, isActive };
};

const createAdminUser = async (supabase: SupabaseAdmin, body: unknown) => {
  const payload = sanitizeCreateUserBody(body);

  const { data: createdUser, error: createError } = await supabase.auth.admin.createUser({
    email: payload.email,
    password: payload.password,
    email_confirm: true,
    user_metadata: {
      full_name: payload.fullName,
      name: payload.fullName,
    },
  });

  if (createError || !createdUser.user?.id) {
    throw new AdminUsersError(createError?.message || 'Could not create Supabase Auth user.', 400);
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .upsert({
      id: createdUser.user.id,
      email: payload.email,
      full_name: payload.fullName || null,
      role: payload.role,
      is_active: payload.isActive,
      last_seen_at: null,
    }, { onConflict: 'id' })
    .select('id,email,full_name,role,is_active,created_at,last_seen_at')
    .single();

  if (profileError) throw profileError;

  return profile;
};

const toWebResponse = (result: ApiResult): Response => new Response(
  result.status === 204 ? null : JSON.stringify(result.body),
  {
    status: result.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(result.headers || {}),
    },
  },
);

const sendNodeResponse = (res: any, result: ApiResult) => {
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(result.headers || {}).forEach(([key, value]) => res.setHeader(key, value));
  res.end(result.status === 204 ? undefined : JSON.stringify(result.body));
};

const handleAdminUsersRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    };
  }

  if (req.method !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed. Use POST.' } };
  }

  const supabase = getSupabaseAdmin();
  await assertAdmin(supabase, req);
  const body = await readRequestBody(req);
  const profile = await createAdminUser(supabase, body);

  return {
    status: 201,
    body: {
      ok: true,
      profile,
    },
  };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    const result = await handleAdminUsersRequest(req);
    if (res) {
      sendNodeResponse(res, result);
      return;
    }
    return toWebResponse(result);
  } catch (error) {
    const status = error instanceof AdminUsersError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unknown admin users error.';
    console.error('Admin users request failed:', error);
    const result = { status, body: { ok: false, error: message } };
    if (res) {
      sendNodeResponse(res, result);
      return;
    }
    return toWebResponse(result);
  }
}
