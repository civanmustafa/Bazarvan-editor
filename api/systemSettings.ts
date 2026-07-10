import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

type SettingKey = 'ai' | 'n8n' | 'articles' | 'roles' | 'system';

class SettingsError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SettingsError';
    this.status = status;
  }
}

const SETTING_KEYS = new Set<SettingKey>(['ai', 'n8n', 'articles', 'roles', 'system']);
const DEFAULT_GEMINI_FREE_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
];

const DEFAULT_SETTINGS: Record<SettingKey, Record<string, unknown>> = {
  ai: {
    geminiFreeEnabled: true,
    geminiProEnabled: true,
    openAiEnabled: false,
    defaultProvider: 'gemini',
    defaultGeminiModel: 'gemini-2.5-flash',
    geminiFreeModelFallbackEnabled: false,
    defaultGeminiPaidModel: 'gemini-2.5-pro',
    defaultOpenAiModel: 'gpt-4.1-mini',
  },
  n8n: {
    enabled: true,
    defaultVisibility: 'public',
    defaultAccessRole: 'editor',
    autoRunAssignedAutomation: true,
  },
  articles: {
    defaultStatus: 'draft',
    defaultVisibility: 'public',
    defaultLanguage: 'ar',
    trashRetentionDays: 30,
  },
  roles: {
    adminCanSeeAll: true,
    usersCanClaimPublicArticles: true,
    usersCanSeeOnlyAssignedAfterClaim: true,
  },
  system: {
    timezone: 'Europe/Istanbul',
    publicEditorUrl: '',
    dailyReportEnabled: true,
    activityTrackingEnabled: true,
  },
};

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

  if (!supabaseUrl) throw new SettingsError('SUPABASE_URL or VITE_SUPABASE_URL is not configured.', 503);
  if (!serviceRoleKey) throw new SettingsError('SUPABASE_SERVICE_ROLE_KEY is not configured.', 503);

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
};

const assertAdmin = async (supabase: SupabaseAdmin, req: any): Promise<string> => {
  const token = getBearerToken(req);
  if (!token) throw new SettingsError('Authentication is required.', 401);

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user?.id) {
    throw new SettingsError('Invalid Supabase session.', 401);
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id,role,is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError) throw profileError;
  if (!profile || profile.role !== 'admin' || profile.is_active === false) {
    throw new SettingsError('Admin access is required.', 403);
  }

  return userData.user.id;
};

const splitSecretList = (value: string | undefined): string[] => (
  String(value || '')
    .split(/[\n,;]+/)
    .map(item => item.trim())
    .filter(Boolean)
);

const uniqueList = (items: string[]): string[] => (
  Array.from(new Set(items.map(item => item.trim()).filter(Boolean)))
);

const collectSecretList = (...values: Array<string | undefined>): string[] => (
  uniqueList(values.flatMap(value => splitSecretList(value)))
);

const getAllowedGeminiFreeModels = (): string[] => (
  uniqueList([
    process.env.GEMINI_MODEL || DEFAULT_GEMINI_FREE_MODELS[0],
    ...DEFAULT_GEMINI_FREE_MODELS,
    ...splitSecretList(process.env.GEMINI_ALLOWED_MODELS),
  ])
);

const normalizeGeminiFreeModel = (value: unknown): string => {
  const allowedModels = getAllowedGeminiFreeModels();
  const requestedModel = typeof value === 'string' ? value.trim() : '';
  return allowedModels.includes(requestedModel)
    ? requestedModel
    : allowedModels[0] || DEFAULT_GEMINI_FREE_MODELS[0];
};

const hasEnvValue = (...keys: string[]): boolean => keys.some(key => Boolean(process.env[key]?.trim()));

const getPublicBaseUrl = (req: any): string => {
  const configuredUrl = String(
    process.env.EDITOR_PUBLIC_URL ||
    process.env.PUBLIC_EDITOR_URL ||
    process.env.APP_BASE_URL ||
    ''
  ).trim().replace(/\/+$/, '');
  if (configuredUrl) return configuredUrl;

  const host = getHeaderValue(req, 'x-forwarded-host') || getHeaderValue(req, 'host');
  const protocol = getHeaderValue(req, 'x-forwarded-proto') || 'https';
  return host ? `${protocol.split(',')[0].trim()}://${host.split(',')[0].trim()}` : '';
};

const getSecretStatus = (req: any) => {
  const geminiKeys = collectSecretList(
    process.env.GEMINI_API_KEYS,
    process.env.GEMINI_API_KEY,
    process.env.API_KEY,
  );
  const geminiPaidKeys = collectSecretList(
    process.env.GEMINI_PAID_API_KEYS,
    process.env.GEMINI_PAID_API_KEY,
    process.env.GEMINI_PRO_API_KEYS,
    process.env.GEMINI_PRO_API_KEY,
  );
  const openAiKeys = collectSecretList(process.env.OPENAI_API_KEYS, process.env.OPENAI_API_KEY);
  const publicBaseUrl = getPublicBaseUrl(req);

  return {
    ai: {
      gemini: {
        configured: geminiKeys.length > 0,
        keyCount: geminiKeys.length,
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        allowedModels: getAllowedGeminiFreeModels(),
      },
      geminiPaid: {
        configured: geminiPaidKeys.length > 0,
        keyCount: geminiPaidKeys.length,
        model: process.env.GEMINI_PAID_MODEL || process.env.GEMINI_PRO_MODEL || 'gemini-2.5-pro',
      },
      openAi: {
        configured: openAiKeys.length > 0,
        keyCount: openAiKeys.length,
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      },
    },
    n8n: {
      tokenConfigured: hasEnvValue('N8N_INGEST_TOKEN'),
      serviceRoleConfigured: hasEnvValue('SUPABASE_SERVICE_ROLE_KEY'),
      ingestUrl: publicBaseUrl ? `${publicBaseUrl}/api/n8n/articles` : '/api/n8n/articles',
      publicEditorUrl: publicBaseUrl,
    },
  };
};

const readSettings = async (supabase: SupabaseAdmin) => {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('key,value,description,updated_by,updated_at')
      .eq('is_secret', false);

    if (error) throw error;

    return (data || []).reduce<Record<string, unknown>>((settings, row) => {
      settings[String(row.key)] = isRecord(row.value) ? row.value : {};
      return settings;
    }, { ...DEFAULT_SETTINGS });
  } catch (error: any) {
    if (error?.code === '42P01') return { ...DEFAULT_SETTINGS };
    throw error;
  }
};

const sanitizeSettingsPatch = (value: unknown): Partial<Record<SettingKey, Record<string, unknown>>> => {
  if (!isRecord(value)) throw new SettingsError('settings must be an object.', 400);

  return Object.entries(value).reduce<Partial<Record<SettingKey, Record<string, unknown>>>>((patch, [key, settingValue]) => {
    if (!SETTING_KEYS.has(key as SettingKey)) return patch;
    if (!isRecord(settingValue)) throw new SettingsError(`settings.${key} must be an object.`, 400);
    patch[key as SettingKey] = key === 'ai'
      ? {
          ...settingValue,
          defaultGeminiModel: normalizeGeminiFreeModel(settingValue.defaultGeminiModel),
        }
      : settingValue;
    return patch;
  }, {});
};

const saveSettings = async (
  supabase: SupabaseAdmin,
  userId: string,
  patch: Partial<Record<SettingKey, Record<string, unknown>>>,
) => {
  const rows = Object.entries(patch).map(([key, value]) => ({
    key,
    value,
    is_secret: false,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) return;

  const { error } = await supabase
    .from('app_settings')
    .upsert(rows, { onConflict: 'key' });

  if (error) throw error;
};

const toWebResponse = (result: ApiResult): Response => new Response(
  JSON.stringify(result.body),
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
  res.end(JSON.stringify(result.body));
};

const handleSettingsRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    };
  }

  if (req.method !== 'GET' && req.method !== 'PUT') {
    return { status: 405, body: { error: 'Method not allowed. Use GET or PUT.' } };
  }

  const supabase = getSupabaseAdmin();
  const userId = await assertAdmin(supabase, req);

  if (req.method === 'PUT') {
    const body = await readRequestBody(req);
    if (!isRecord(body)) throw new SettingsError('JSON body must be an object.', 400);
    await saveSettings(supabase, userId, sanitizeSettingsPatch(body.settings));
  }

  const settings = await readSettings(supabase);

  return {
    status: 200,
    body: {
      ok: true,
      settings,
      secretStatus: getSecretStatus(req),
    },
  };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    const result = await handleSettingsRequest(req);
    if (res) {
      sendNodeResponse(res, result);
      return;
    }
    return toWebResponse(result);
  } catch (error) {
    const status = error instanceof SettingsError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unknown settings error.';
    console.error('System settings request failed:', error);
    const result = { status, body: { ok: false, error: message } };
    if (res) {
      sendNodeResponse(res, result);
      return;
    }
    return toWebResponse(result);
  }
}
