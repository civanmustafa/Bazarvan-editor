import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi';
import type { AdminAiSecretProvider } from '../constants/adminAiProviderSecrets';

export type { AdminAiSecretProvider } from '../constants/adminAiProviderSecrets';

export type AdminAiProviderSecretStatus = {
  provider: AdminAiSecretProvider;
  configured: boolean;
  enabled: boolean;
  keySuffix: string | null;
  updatedAt: string | null;
  fallbackConfigured: boolean;
  fallbackKeyCount: number;
  effectiveConfigured: boolean;
  activeSource: 'admin' | 'hostinger';
};

export type AdminAiProviderSecretsResponse = {
  schemaAvailable: boolean;
  encryptionConfigured: boolean;
  providers: Record<AdminAiSecretProvider, AdminAiProviderSecretStatus>;
};

const requestAdminAiProviderSecrets = async (options: {
  method?: 'GET' | 'PUT' | 'DELETE';
  body?: Record<string, unknown>;
} = {}): Promise<AdminAiProviderSecretsResponse> => {
  const accessToken = await getAuthenticatedApiToken();
  const method = options.method || 'GET';
  const response = await fetch('/api/admin/ai-provider-secrets', {
    method,
    headers: getAuthenticatedApiHeaders(
      accessToken,
      method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    ),
    body: method === 'GET' ? undefined : JSON.stringify(options.body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string'
      ? payload.error
      : `AI provider secret request failed (${response.status}).`);
  }
  return payload as AdminAiProviderSecretsResponse;
};

export const loadAdminAiProviderSecrets = (): Promise<AdminAiProviderSecretsResponse> => (
  requestAdminAiProviderSecrets()
);

export const saveAndEnableAdminAiProviderSecret = (
  provider: AdminAiSecretProvider,
  apiKey: string,
): Promise<AdminAiProviderSecretsResponse> => requestAdminAiProviderSecrets({
  method: 'PUT',
  body: { provider, apiKey, enabled: true },
});

export const setAdminAiProviderSecretEnabled = (
  provider: AdminAiSecretProvider,
  enabled: boolean,
): Promise<AdminAiProviderSecretsResponse> => requestAdminAiProviderSecrets({
  method: 'PUT',
  body: { provider, enabled },
});

export const clearAdminAiProviderSecret = (
  provider: AdminAiSecretProvider,
): Promise<AdminAiProviderSecretsResponse> => requestAdminAiProviderSecrets({
  method: 'DELETE',
  body: { provider },
});
