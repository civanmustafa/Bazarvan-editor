import { getSupabaseClient } from './supabaseClient';

export type SystemSettingKey = 'ai' | 'n8n' | 'articles' | 'roles' | 'system';

export type SystemSettingsMap = Record<SystemSettingKey, Record<string, any>>;

export type SecretStatus = {
  ai: {
    gemini: {
      configured: boolean;
      keyCount: number;
      model: string;
      allowedModels: string[];
    };
    geminiPaid: {
      configured: boolean;
      keyCount: number;
      model: string;
    };
    openAi: {
      configured: boolean;
      keyCount: number;
      model: string;
    };
  };
  n8n: {
    tokenConfigured: boolean;
    serviceRoleConfigured: boolean;
    ingestUrl: string;
    publicEditorUrl: string;
  };
};

export type SystemSettingsResponse = {
  settings: SystemSettingsMap;
  secretStatus: SecretStatus;
};

const getAccessToken = async (): Promise<string> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw error || new Error('Supabase session is required.');
  }
  return data.session.access_token;
};

const requestSystemSettings = async (
  options: {
    method?: 'GET' | 'PUT';
    settings?: Partial<SystemSettingsMap>;
  } = {},
): Promise<SystemSettingsResponse> => {
  const accessToken = await getAccessToken();
  const response = await fetch('/api/system/settings', {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.method === 'PUT' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.method === 'PUT'
      ? JSON.stringify({ settings: options.settings || {} })
      : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `System settings failed (${response.status}).`);
  }

  return {
    settings: payload.settings,
    secretStatus: payload.secretStatus,
  } as SystemSettingsResponse;
};

export const loadSystemSettings = (): Promise<SystemSettingsResponse> => (
  requestSystemSettings()
);

export const saveSystemSettings = (
  settings: Partial<SystemSettingsMap>,
): Promise<SystemSettingsResponse> => (
  requestSystemSettings({ method: 'PUT', settings })
);
