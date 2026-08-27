import {
  PROVIDER_ACCESS_PROVIDERS,
  type ProviderAccessProvider,
  type ProviderCredentialMode,
} from '../constants/providerAccessControl.ts';
import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi.ts';

export type EffectiveProviderPolicy = {
  provider: ProviderAccessProvider;
  enabled: boolean;
  allowPersonalKeys: boolean;
  credentialMode: ProviderCredentialMode;
  allowSharedFallback: boolean;
  allowProviderFallback: boolean;
  defaultModel: string | null;
  allowedModels: string[];
  dailyRequestLimit: number | null;
  monthlyRequestLimit: number | null;
  customizedForUser: boolean;
};

export type ProviderPolicyPatch = {
  enabled?: boolean | null;
  allowPersonalKeys?: boolean | null;
  credentialMode?: ProviderCredentialMode | null;
  allowSharedFallback?: boolean | null;
  allowProviderFallback?: boolean | null;
  defaultModel?: string | null;
  allowedModels?: string[] | null;
  dailyRequestLimit?: number | null;
  monthlyRequestLimit?: number | null;
};

export type SharedProviderCredentialMetadata = {
  id: string;
  provider: ProviderAccessProvider;
  label: string;
  enabled: boolean;
  keyCount: number;
  keySuffixes: string[];
  expiresAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderCredentialGrantMetadata = {
  id: string;
  credentialId: string;
  scope: 'all' | 'user';
  userId: string | null;
  priority: number;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderUsageSummary = {
  dailyUsed: number;
  monthlyUsed: number;
};

export type ProviderAccessProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: 'admin' | 'user';
  is_active: boolean;
  created_at: string;
  last_seen_at: string | null;
};

export type AdminProviderAccessResponse = {
  ok: true;
  schemaAvailable: boolean;
  encryptionConfigured: boolean;
  profile: ProviderAccessProfile | null;
  globalPolicies: Record<ProviderAccessProvider, EffectiveProviderPolicy>;
  userPolicies: Partial<Record<ProviderAccessProvider, ProviderPolicyPatch>>;
  effectivePolicies: Record<ProviderAccessProvider, EffectiveProviderPolicy>;
  credentials: SharedProviderCredentialMetadata[];
  grants: ProviderCredentialGrantMetadata[];
  usage: Record<ProviderAccessProvider, ProviderUsageSummary>;
};

export type UserProviderAccessResponse = {
  ok: true;
  schemaAvailable: boolean;
  policies: Record<ProviderAccessProvider, EffectiveProviderPolicy>;
  assignedCredentials: Array<SharedProviderCredentialMetadata & {
    scope: 'all' | 'user';
    priority: number;
  }>;
  usage: Record<ProviderAccessProvider, ProviderUsageSummary>;
};

const requestJson = async <T>(url: string, options: {
  method?: 'GET' | 'PUT' | 'DELETE';
  body?: Record<string, unknown>;
} = {}): Promise<T> => {
  const token = await getAuthenticatedApiToken();
  const method = options.method || 'GET';
  const response = await fetch(url, {
    method,
    headers: getAuthenticatedApiHeaders(
      token,
      method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    ),
    body: method === 'GET' ? undefined : JSON.stringify(options.body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string'
      ? payload.error
      : `Provider access request failed (${response.status}).`);
  }
  return payload as T;
};

export const loadAdminProviderAccess = (userId?: string): Promise<AdminProviderAccessResponse> => (
  requestJson(`/api/admin/provider-access${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`)
);

export const saveAdminProviderPolicy = (options: {
  scope: 'global' | 'user';
  userId?: string;
  provider: ProviderAccessProvider;
  patch: ProviderPolicyPatch;
}): Promise<AdminProviderAccessResponse> => requestJson('/api/admin/provider-access', {
  method: 'PUT',
  body: { action: 'save_policy', ...options },
});

export const saveAdminSharedCredential = (options: {
  id?: string;
  userId?: string;
  provider: ProviderAccessProvider;
  label: string;
  apiKeys?: string;
  enabled?: boolean;
  expiresAt?: string | null;
  scope?: 'all' | 'user';
  priority?: number;
}): Promise<AdminProviderAccessResponse> => requestJson('/api/admin/provider-access', {
  method: 'PUT',
  body: { action: 'save_credential', ...options },
});

export const saveAdminCredentialGrant = (options: {
  id?: string;
  credentialId: string;
  scope: 'all' | 'user';
  userId?: string;
  priority?: number;
  enabled?: boolean;
}): Promise<AdminProviderAccessResponse> => requestJson('/api/admin/provider-access', {
  method: 'PUT',
  body: { action: 'save_grant', ...options },
});

export const deleteAdminSharedCredential = (
  id: string,
  userId?: string,
): Promise<AdminProviderAccessResponse> => requestJson('/api/admin/provider-access', {
  method: 'DELETE',
  body: { action: 'credential', id, userId },
});

export const deleteAdminCredentialGrant = (
  id: string,
  userId?: string,
): Promise<AdminProviderAccessResponse> => requestJson('/api/admin/provider-access', {
  method: 'DELETE',
  body: { action: 'grant', id, userId },
});

export const updateAdminUserAccess = (options: {
  userId: string;
  role?: 'admin' | 'user';
  isActive?: boolean;
}): Promise<AdminProviderAccessResponse> => requestJson('/api/admin/provider-access', {
  method: 'PUT',
  body: { action: 'update_user', ...options },
});

export const loadUserProviderAccess = (): Promise<UserProviderAccessResponse> => (
  requestJson('/api/user/provider-access')
);

export const createEmptyUsageMap = (): Record<ProviderAccessProvider, ProviderUsageSummary> => (
  Object.fromEntries(PROVIDER_ACCESS_PROVIDERS.map(provider => [provider, {
    dailyUsed: 0,
    monthlyUsed: 0,
  }])) as Record<ProviderAccessProvider, ProviderUsageSummary>
);
