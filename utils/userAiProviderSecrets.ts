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

const requestUserAiProviderSecrets = async (options: {
  method?: 'GET' | 'PUT' | 'DELETE';
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
