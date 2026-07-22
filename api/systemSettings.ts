import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  GEMINI_ANALYSIS_MODEL,
  GEMINI_FREE_MODEL_VALUES,
  GEMINI_PAID_ANALYSIS_MODEL,
  OPENAI_ANALYSIS_MODEL,
} from '../constants/modelRegistry';
import {
  SYSTEM_SETTING_KEYS,
  getDefaultSystemSettings,
  isSettingsRecord,
  normalizeSystemSettingsMap,
  normalizeSystemSettingsPatch,
  type SystemSettingKey,
} from '../constants/settingsRegistry';
import { deliverApiResult, getHeaderValue, readRequestBody, type ApiResult } from './http.ts';
import {
  getEnvironmentGeminiApiKeys,
  readAiProviderCredentialAvailability,
} from '../server/adminAiProviderSecrets';

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

class SettingsError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SettingsError';
    this.status = status;
  }
}

const SETTING_KEYS = new Set<SystemSettingKey>(SYSTEM_SETTING_KEYS);

const isRecord = isSettingsRecord;

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

const getAllowedGeminiFreeModels = (): string[] => (
  uniqueList([
    process.env.GEMINI_MODEL || GEMINI_ANALYSIS_MODEL,
    ...GEMINI_FREE_MODEL_VALUES,
    ...splitSecretList(process.env.GEMINI_ALLOWED_MODELS),
  ])
);

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

const getSecretStatus = async (req: any) => {
  const geminiKeys = getEnvironmentGeminiApiKeys('gemini');
  const credentialAvailability = await readAiProviderCredentialAvailability();
  const publicBaseUrl = getPublicBaseUrl(req);

  return {
    ai: {
      gemini: {
        configured: geminiKeys.length > 0,
        keyCount: geminiKeys.length,
        model: process.env.GEMINI_MODEL || GEMINI_ANALYSIS_MODEL,
        allowedModels: getAllowedGeminiFreeModels(),
      },
      geminiPaid: {
        configured: credentialAvailability.geminiPaid.configured,
        keyCount: credentialAvailability.geminiPaid.keyCount,
        model: process.env.GEMINI_PAID_MODEL || process.env.GEMINI_PRO_MODEL || GEMINI_PAID_ANALYSIS_MODEL,
      },
      openAi: {
        configured: credentialAvailability.openai.configured,
        keyCount: credentialAvailability.openai.keyCount,
        model: process.env.OPENAI_MODEL || OPENAI_ANALYSIS_MODEL,
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

    const storedSettings = (data || []).reduce<Record<string, unknown>>((settings, row) => {
      const key = String(row.key) as SystemSettingKey;
      if (SETTING_KEYS.has(key)) settings[key] = row.value;
      return settings;
    }, {});
    return normalizeSystemSettingsMap(storedSettings, {
      allowedGeminiModels: getAllowedGeminiFreeModels(),
    });
  } catch (error: any) {
    if (error?.code === '42P01') return getDefaultSystemSettings();
    throw error;
  }
};

const sanitizeSettingsPatch = (value: unknown): Partial<Record<SystemSettingKey, Record<string, unknown>>> => {
  if (!isRecord(value)) throw new SettingsError('settings must be an object.', 400);
  Object.entries(value).forEach(([key, settingValue]) => {
    if (SETTING_KEYS.has(key as SystemSettingKey) && !isRecord(settingValue)) {
      throw new SettingsError(`settings.${key} must be an object.`, 400);
    }
  });
  return normalizeSystemSettingsPatch(value, {
    allowedGeminiModels: getAllowedGeminiFreeModels(),
  });
};

const saveSettings = async (
  supabase: SupabaseAdmin,
  userId: string,
  patch: Partial<Record<SystemSettingKey, Record<string, unknown>>>,
) => {
  const keys = Object.keys(patch) as SystemSettingKey[];
  if (keys.length === 0) return;

  const { data: existingRows, error: readError } = await supabase
    .from('app_settings')
    .select('key,value')
    .in('key', keys);
  if (readError && readError.code !== '42P01') throw readError;

  const existing = (existingRows || []).reduce<Record<string, Record<string, unknown>>>((result, row) => {
    if (isRecord(row.value)) result[String(row.key)] = row.value;
    return result;
  }, {});
  const mergedSettings = normalizeSystemSettingsMap(
    Object.fromEntries(keys.map(key => [key, {
      ...(existing[key] || {}),
      ...(patch[key] || {}),
    }])),
    { allowedGeminiModels: getAllowedGeminiFreeModels() },
  );
  const rows = keys.map(key => ({
    key,
    value: mergedSettings[key],
    is_secret: false,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('app_settings')
    .upsert(rows, { onConflict: 'key' });

  if (error) throw error;
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
      secretStatus: await getSecretStatus(req),
    },
  };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    const result = await handleSettingsRequest(req);
    return deliverApiResult(result, res);
  } catch (error) {
    const status = error instanceof SettingsError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unknown settings error.';
    console.error('System settings request failed:', error);
    return deliverApiResult({ status, body: { ok: false, error: message } }, res);
  }
}
