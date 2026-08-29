import {
  ADMIN_AI_SECRET_PROVIDERS,
  type AdminAiSecretProvider,
} from '../constants/adminAiProviderSecrets.ts';
import type { ProviderAccessProvider } from '../constants/providerAccessControl.ts';
import type { UserAiSecretProvider } from '../constants/userAiProviderSecrets.ts';
import {
  decryptProviderCredentialKeys,
  deleteProviderCredentialVaultRow,
  encryptProviderCredentialKeys,
  getProviderCredentialVaultAad,
  isProviderCredentialVaultEncryptionConfigured,
  normalizeProviderCredentialKeys,
  readProviderCredentialVaultRow,
  saveProviderCredentialVaultRow,
  ProviderCredentialVaultError,
  type ProviderCredentialVaultPurpose,
  type ProviderCredentialVaultRow,
} from './providerCredentialVault.ts';
import {
  resolveProviderCredentialPlan,
} from './providerAccessControl.ts';
import { resolveUserAiProviderKeys } from './userAiProviderSecrets.ts';

export { ADMIN_AI_SECRET_PROVIDERS } from '../constants/adminAiProviderSecrets.ts';
export type { AdminAiSecretProvider } from '../constants/adminAiProviderSecrets.ts';

export type AiCredentialSource =
  | 'user'
  | 'assigned_user'
  | 'assigned_all'
  | 'resume'
  | 'admin'
  | 'none';
export type AiCredentialPurpose = 'standard' | 'content_writing_resume';

export type ResolvedAiCredentialTier = {
  source: AiCredentialSource;
  keys: string[];
};

export type AdminAiProviderSecretStatus = {
  provider: AdminAiSecretProvider;
  configured: boolean;
  enabled: boolean;
  keySuffix: string | null;
  updatedAt: string | null;
};

export type AdminAiProviderSecretsOverview = {
  schemaAvailable: boolean;
  encryptionConfigured: boolean;
  providers: Record<AdminAiSecretProvider, AdminAiProviderSecretStatus>;
};

export type ResolvedAiCredentialSet = {
  keys: string[];
  source: AiCredentialSource;
  tiers: ResolvedAiCredentialTier[];
};

export type AiProviderCredentialAvailability = {
  configured: boolean;
  keyCount: number;
  source: AiCredentialSource;
};

export class AdminAiProviderSecretError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'AI_PROVIDER_SECRET_ERROR') {
    super(message);
    this.name = 'AdminAiProviderSecretError';
    this.status = status;
    this.code = code;
  }
}

type AdminSecretVaultIdentity = {
  vaultKey: string;
  provider: ProviderAccessProvider;
  purpose: ProviderCredentialVaultPurpose;
  label: string;
};

const isAdminAiSecretProvider = (value: unknown): value is AdminAiSecretProvider => (
  typeof value === 'string'
  && ADMIN_AI_SECRET_PROVIDERS.includes(value as AdminAiSecretProvider)
);

export const normalizeAdminAiSecretProvider = (value: unknown): AdminAiSecretProvider => {
  if (!isAdminAiSecretProvider(value)) {
    throw new AdminAiProviderSecretError('Unsupported AI secret provider.', 400, 'AI_SECRET_PROVIDER_INVALID');
  }
  return value;
};

const getAdminSecretVaultIdentity = (
  providerValue: unknown,
): AdminSecretVaultIdentity => {
  const provider = normalizeAdminAiSecretProvider(providerValue);
  switch (provider) {
    case 'openai_latest':
      return {
        vaultKey: 'legacy-admin-ai:openai_latest',
        provider: 'openai',
        purpose: 'default',
        label: 'Administrator OpenAI',
      };
    case 'gemini_latest':
      return {
        vaultKey: 'legacy-admin-ai:gemini_latest',
        provider: 'gemini_paid',
        purpose: 'default',
        label: 'Administrator Gemini paid',
      };
    case 'content_writing_resume_gemini':
      return {
        vaultKey: `legacy-admin-ai:${provider}`,
        provider: 'gemini_free',
        purpose: 'content_writing_resume',
        label: 'Content-writing resume Gemini free',
      };
    case 'content_writing_resume_gemini_paid':
      return {
        vaultKey: `legacy-admin-ai:${provider}`,
        provider: 'gemini_paid',
        purpose: 'content_writing_resume',
        label: 'Content-writing resume Gemini paid',
      };
    case 'content_writing_resume_openai':
      return {
        vaultKey: `legacy-admin-ai:${provider}`,
        provider: 'openai',
        purpose: 'content_writing_resume',
        label: 'Content-writing resume OpenAI',
      };
  }
};

const toUserProvider = (provider: ProviderAccessProvider): UserAiSecretProvider => (
  provider
);

const normalizeApiKey = (value: unknown): string => {
  try {
    return normalizeProviderCredentialKeys(value, { minimumLength: 20, maximumKeys: 1 })[0];
  } catch {
    throw new AdminAiProviderSecretError(
      'The API key must be a single non-whitespace value between 20 and 512 characters.',
      400,
      'AI_SECRET_VALUE_INVALID',
    );
  }
};

export const isAiSettingsEncryptionConfigured = (): boolean => (
  isProviderCredentialVaultEncryptionConfigured()
);

const emptyStatus = (provider: AdminAiSecretProvider): AdminAiProviderSecretStatus => ({
  provider,
  configured: false,
  enabled: false,
  keySuffix: null,
  updatedAt: null,
});

const toStatus = (
  provider: AdminAiSecretProvider,
  row: ProviderCredentialVaultRow | null,
): AdminAiProviderSecretStatus => {
  const suffixes = Array.isArray(row?.key_suffixes)
    ? row.key_suffixes.map(value => String(value || '').slice(-4)).filter(Boolean)
    : [];
  return {
    provider,
    configured: Boolean(row && row.key_count > 0 && suffixes.length > 0),
    enabled: row?.enabled === true,
    keySuffix: suffixes[0] || null,
    updatedAt: row?.updated_at || null,
  };
};

const readSecretRow = async (
  provider: AdminAiSecretProvider,
): Promise<ProviderCredentialVaultRow | null> => {
  const identity = getAdminSecretVaultIdentity(provider);
  const row = await readProviderCredentialVaultRow(identity.vaultKey);
  return row?.credential_type === 'shared' ? row : null;
};

export const readAdminAiProviderSecretsOverview = async (): Promise<AdminAiProviderSecretsOverview> => {
  try {
    const providers = Object.fromEntries(await Promise.all(
      ADMIN_AI_SECRET_PROVIDERS.map(async provider => [
        provider,
        toStatus(provider, await readSecretRow(provider)),
      ] as const),
    )) as Record<AdminAiSecretProvider, AdminAiProviderSecretStatus>;
    return {
      schemaAvailable: true,
      encryptionConfigured: isAiSettingsEncryptionConfigured(),
      providers,
    };
  } catch (error) {
    if (
      error instanceof ProviderCredentialVaultError
      && error.code === 'PROVIDER_CREDENTIAL_VAULT_SCHEMA_MISSING'
    ) {
      return {
        schemaAvailable: false,
        encryptionConfigured: isAiSettingsEncryptionConfigured(),
        providers: Object.fromEntries(
          ADMIN_AI_SECRET_PROVIDERS.map(provider => [provider, emptyStatus(provider)]),
        ) as Record<AdminAiSecretProvider, AdminAiProviderSecretStatus>,
      };
    }
    throw error;
  }
};

const resolveCredentialSet = async (
  runtimeProvider: 'gemini' | 'geminiPaid' | 'openai',
  userId?: string,
  purpose: AiCredentialPurpose = 'standard',
): Promise<ResolvedAiCredentialSet> => {
  const provider: ProviderAccessProvider = runtimeProvider === 'openai'
    ? 'openai'
    : runtimeProvider === 'geminiPaid'
      ? 'gemini_paid'
      : 'gemini_free';
  const personalKeys = await resolveUserAiProviderKeys({
    actorUserId: userId,
    ownerUserId: userId,
    provider: toUserProvider(provider),
  });
  const plan = await resolveProviderCredentialPlan({
    userId,
    provider,
    personalKeys,
    purpose: purpose === 'content_writing_resume' ? 'content_writing_resume' : 'default',
  });
  const tiers = plan.tiers.map(tier => ({
    source: tier.source as AiCredentialSource,
    keys: tier.keys,
  }));
  return {
    keys: tiers.flatMap(tier => tier.keys),
    source: tiers[0]?.source || 'none',
    tiers,
  };
};

export const resolveOpenAiApiKeys = async (
  userId?: string,
  purpose: AiCredentialPurpose = 'standard',
): Promise<ResolvedAiCredentialSet> => resolveCredentialSet('openai', userId, purpose);

export const resolveGeminiApiKeys = async (
  provider: 'gemini' | 'geminiPaid',
  userId?: string,
  purpose: AiCredentialPurpose = 'standard',
): Promise<ResolvedAiCredentialSet> => resolveCredentialSet(provider, userId, purpose);

export const readAiProviderCredentialAvailability = async (userId?: string): Promise<{
  gemini: AiProviderCredentialAvailability;
  openai: AiProviderCredentialAvailability;
  geminiPaid: AiProviderCredentialAvailability;
}> => {
  const [gemini, openai, geminiPaid] = await Promise.all([
    resolveGeminiApiKeys('gemini', userId),
    resolveOpenAiApiKeys(userId),
    resolveGeminiApiKeys('geminiPaid', userId),
  ]);
  const toAvailability = (credentials: ResolvedAiCredentialSet): AiProviderCredentialAvailability => ({
    configured: credentials.keys.length > 0,
    keyCount: credentials.keys.length,
    source: credentials.source,
  });
  return {
    gemini: toAvailability(gemini),
    openai: toAvailability(openai),
    geminiPaid: toAvailability(geminiPaid),
  };
};

export const saveAdminAiProviderSecret = async (options: {
  provider: AdminAiSecretProvider;
  apiKey?: unknown;
  enabled?: unknown;
  updatedBy: string;
}): Promise<void> => {
  const provider = normalizeAdminAiSecretProvider(options.provider);
  const identity = getAdminSecretVaultIdentity(provider);
  const existing = await readProviderCredentialVaultRow(identity.vaultKey);
  const hasNewKey = options.apiKey !== undefined && String(options.apiKey || '').trim() !== '';
  if (!existing && !hasNewKey) {
    throw new AdminAiProviderSecretError(
      'Save an API key before enabling this administrator credential.',
      400,
      'AI_SECRET_VALUE_REQUIRED',
    );
  }
  await saveProviderCredentialVaultRow({
    id: existing?.id,
    vaultKey: identity.vaultKey,
    credentialType: 'shared',
    provider: identity.provider,
    purpose: identity.purpose,
    label: existing?.label || identity.label,
    ...(hasNewKey ? { apiKeys: [normalizeApiKey(options.apiKey)] } : {}),
    enabled: typeof options.enabled === 'boolean' ? options.enabled : existing?.enabled ?? true,
    updatedBy: options.updatedBy,
  });
};

export const deleteAdminAiProviderSecret = async (
  providerValue: unknown,
): Promise<void> => {
  await deleteProviderCredentialVaultRow(getAdminSecretVaultIdentity(providerValue).vaultKey);
};

const encryptSecret = (providerValue: unknown, plaintext: string) => {
  const identity = getAdminSecretVaultIdentity(providerValue);
  return encryptProviderCredentialKeys(identity.vaultKey, [normalizeApiKey(plaintext)]);
};

const decryptSecret = (row: { provider: AdminAiSecretProvider } & Record<string, any>): string => {
  const identity = getAdminSecretVaultIdentity(row.provider);
  if (row.encryption_context !== getProviderCredentialVaultAad(identity.vaultKey)) {
    throw new AdminAiProviderSecretError(
      'The stored AI key could not be decrypted. Verify the credential vault key.',
      503,
      'AI_SECRET_DECRYPTION_FAILED',
    );
  }
  try {
    return decryptProviderCredentialKeys({
      ...row,
      vault_key: identity.vaultKey,
    } as unknown as ProviderCredentialVaultRow)[0];
  } catch {
    throw new AdminAiProviderSecretError(
      'The stored AI key could not be decrypted. Verify the credential vault key.',
      503,
      'AI_SECRET_DECRYPTION_FAILED',
    );
  }
};

const buildResolvedCredentialSet = (
  adminKey: string | null,
  adminEnabled: boolean,
  userKeys: string[] = [],
  resumeKey: string | null = null,
): ResolvedAiCredentialSet => {
  const seen = new Set<string>();
  const unique = (values: string[]) => values.map(value => value.trim()).filter(value => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
  const tiers: ResolvedAiCredentialTier[] = [
    ...(resumeKey ? [{ source: 'resume' as const, keys: unique([resumeKey]) }] : []),
    ...(userKeys.length ? [{ source: 'user' as const, keys: unique(userKeys) }] : []),
    ...(adminEnabled && adminKey ? [{ source: 'admin' as const, keys: unique([adminKey]) }] : []),
  ].filter(tier => tier.keys.length > 0);
  return {
    keys: tiers.flatMap(tier => tier.keys),
    source: tiers[0]?.source || 'none',
    tiers,
  };
};

export const __adminAiProviderSecretsTestUtils = {
  buildResolvedCredentialSet,
  encryptSecret,
  decryptSecret,
  normalizeApiKey,
  getAdminSecretVaultIdentity,
};
