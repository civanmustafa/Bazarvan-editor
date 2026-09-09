import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi';
import type { UserAiSecretProvider } from '../constants/userAiProviderSecrets';

export type { UserAiSecretProvider } from '../constants/userAiProviderSecrets';

export type UserAiProviderSecretStatus = {
  provider: UserAiSecretProvider;
  configured: boolean;
  enabled: boolean;
  keyCount: number;
  keySuffixes: string[];
  updatedAt: string | null;
};

export type UserAiProviderSecretsResponse = {
  schemaAvailable: boolean;
  encryptionConfigured: boolean;
  providers: Record<UserAiSecretProvider, UserAiProviderSecretStatus>;
};

export type UserAiProviderKeyTestResult = {
  keySuffix: string;
  status: 'valid' | 'quota_exhausted' | 'invalid' | 'unavailable';
  httpStatus: number | null;
};

export type UserAiProviderKeyTestResponse = UserAiProviderSecretsResponse & {
  tests: UserAiProviderKeyTestResult[];
};

const requestUserAiProviderSecrets = async (options: {
  method?: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';
  body?: Record<string, unknown>;
} = {}): Promise<UserAiProviderSecretsResponse> => {
  const accessToken = await getAuthenticatedApiToken();
  const method = options.method || 'GET';
  const response = await fetch('/api/user/ai-provider-secrets', {
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
      : `Personal AI provider secret request failed (${response.status}).`);
  }
  return payload as UserAiProviderSecretsResponse;
};

export const loadUserAiProviderSecrets = (): Promise<UserAiProviderSecretsResponse> => (
  requestUserAiProviderSecrets()
);

export const saveUserAiProviderKeys = (
  provider: UserAiSecretProvider,
  apiKeys: string,
): Promise<UserAiProviderSecretsResponse> => requestUserAiProviderSecrets({
  method: 'PUT',
  body: { provider, apiKeys },
});

export const clearUserAiProviderKeys = (
  provider: UserAiSecretProvider,
): Promise<UserAiProviderSecretsResponse> => requestUserAiProviderSecrets({
  method: 'DELETE',
  body: { provider },
});

export const setUserAiProviderKeysEnabled = (
  provider: UserAiSecretProvider,
  enabled: boolean,
): Promise<UserAiProviderSecretsResponse> => requestUserAiProviderSecrets({
  method: 'PATCH',
  body: { provider, enabled },
});

export const testUserAiProviderKeys = async (
  provider: UserAiSecretProvider,
  apiKeys?: string,
): Promise<UserAiProviderKeyTestResponse> => requestUserAiProviderSecrets({
  method: 'POST',
  body: { provider, ...(apiKeys?.trim() ? { apiKeys } : {}) },
}) as Promise<UserAiProviderKeyTestResponse>;
