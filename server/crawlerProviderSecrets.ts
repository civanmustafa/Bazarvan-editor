import {
  CRAWLER_EXTERNAL_PROVIDERS,
  isCrawlerExternalProvider,
  type CrawlerExternalProvider,
} from '../constants/crawlerProviders.ts';
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
  type ProviderCredentialVaultRow,
} from './providerCredentialVault.ts';
import {
  resolveProviderCredentialPlan,
  saveCredentialGrant,
  type ProviderCredentialSource,
} from './providerAccessControl.ts';
import { resolveUserAiProviderKeys } from './userAiProviderSecrets.ts';

/**
 * Compatibility facade for the crawler product surfaces. Storage and
 * resolution are both delegated to the canonical provider credential vault.
 */
export type CrawlerCredentialSource = ProviderCredentialSource;

export type CrawlerProviderSecretStatus = {
  provider: CrawlerExternalProvider;
  configured: boolean;
  enabled: boolean;
  keySuffix: string | null;
  updatedAt: string | null;
  effectiveConfigured: boolean;
  activeSource: CrawlerCredentialSource | 'none';
};

export type CrawlerProviderSecretsOverview = {
  schemaAvailable: boolean;
  encryptionConfigured: boolean;
  providers: Record<CrawlerExternalProvider, CrawlerProviderSecretStatus>;
};

export type ResolvedCrawlerProviderCredential = {
  apiKey: string;
  source: CrawlerCredentialSource;
  keySuffix: string;
};

export class CrawlerProviderSecretError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'CRAWLER_PROVIDER_SECRET_ERROR') {
    super(message);
    this.name = 'CrawlerProviderSecretError';
    this.status = status;
    this.code = code;
  }
}

export const normalizeCrawlerExternalProvider = (
  value: unknown,
): CrawlerExternalProvider => {
  if (!isCrawlerExternalProvider(value)) {
    throw new CrawlerProviderSecretError(
      'Unsupported crawler provider.',
      400,
      'CRAWLER_PROVIDER_INVALID',
    );
  }
  return value;
};

const getAdminCrawlerVaultKey = (provider: CrawlerExternalProvider): string => (
  `legacy-admin-crawler:${provider}`
);

const normalizeApiKey = (value: unknown): string => {
  try {
    return normalizeProviderCredentialKeys(value, {
      minimumLength: 8,
      maximumKeys: 1,
    })[0];
  } catch {
    throw new CrawlerProviderSecretError(
      'The crawler API key must be one non-whitespace value between 8 and 512 characters.',
      400,
      'CRAWLER_SECRET_VALUE_INVALID',
    );
  }
};

const readSecretRow = async (
  provider: CrawlerExternalProvider,
): Promise<ProviderCredentialVaultRow | null> => {
  const row = await readProviderCredentialVaultRow(getAdminCrawlerVaultKey(provider));
  return row?.credential_type === 'shared' && row.provider === provider ? row : null;
};

export const isCrawlerSettingsEncryptionConfigured = (): boolean => (
  isProviderCredentialVaultEncryptionConfigured()
);

const emptyStatus = (
  provider: CrawlerExternalProvider,
): CrawlerProviderSecretStatus => ({
  provider,
  configured: false,
  enabled: false,
  keySuffix: null,
  updatedAt: null,
  effectiveConfigured: false,
  activeSource: 'none',
});

export const readCrawlerProviderSecretsOverview = async (
): Promise<CrawlerProviderSecretsOverview> => {
  try {
    const entries = await Promise.all(CRAWLER_EXTERNAL_PROVIDERS.map(async provider => {
      const [row, plan] = await Promise.all([
        readSecretRow(provider),
        resolveProviderCredentialPlan({ provider, purpose: 'default' }),
      ]);
      const keySuffixes = Array.isArray(row?.key_suffixes)
        ? row.key_suffixes.map(value => String(value || '').slice(-4)).filter(Boolean)
        : [];
      const firstTier = plan.tiers[0];
      const status: CrawlerProviderSecretStatus = {
        ...emptyStatus(provider),
        configured: Boolean(row && row.key_count > 0 && keySuffixes.length > 0),
        enabled: row?.enabled === true,
        keySuffix: keySuffixes[0] || null,
        updatedAt: row?.updated_at || null,
        effectiveConfigured: Boolean(firstTier?.keys.length),
        activeSource: firstTier?.source || 'none',
      };
      return [provider, status] as const;
    }));
    return {
      schemaAvailable: true,
      encryptionConfigured: isCrawlerSettingsEncryptionConfigured(),
      providers: Object.fromEntries(entries) as Record<
        CrawlerExternalProvider,
        CrawlerProviderSecretStatus
      >,
    };
  } catch (error) {
    if (
      error instanceof ProviderCredentialVaultError
      && error.code === 'PROVIDER_CREDENTIAL_VAULT_SCHEMA_MISSING'
    ) {
      return {
        schemaAvailable: false,
        encryptionConfigured: isCrawlerSettingsEncryptionConfigured(),
        providers: Object.fromEntries(
          CRAWLER_EXTERNAL_PROVIDERS.map(provider => [provider, emptyStatus(provider)]),
        ) as Record<CrawlerExternalProvider, CrawlerProviderSecretStatus>,
      };
    }
    throw error;
  }
};

export const resolveCrawlerProviderCredential = async (
  providerValue: unknown,
  userId?: string | null,
): Promise<ResolvedCrawlerProviderCredential | null> => {
  const provider = normalizeCrawlerExternalProvider(providerValue);
  const personalKeys = await resolveUserAiProviderKeys({
    actorUserId: userId,
    ownerUserId: userId,
    provider,
  });
  const plan = await resolveProviderCredentialPlan({
    userId,
    provider,
    personalKeys,
    purpose: 'default',
  });
  const firstTier = plan.tiers[0];
  const apiKey = firstTier?.keys[0]?.trim() || '';
  return apiKey
    ? {
        apiKey,
        source: firstTier.source,
        keySuffix: apiKey.slice(-4),
      }
    : null;
};

export const saveCrawlerProviderSecret = async (options: {
  provider: CrawlerExternalProvider;
  apiKey?: unknown;
  enabled?: unknown;
  updatedBy: string;
}): Promise<void> => {
  const provider = normalizeCrawlerExternalProvider(options.provider);
  const vaultKey = getAdminCrawlerVaultKey(provider);
  const existing = await readSecretRow(provider);
  const hasNewKey = options.apiKey !== undefined && String(options.apiKey || '').trim() !== '';
  if (!existing && !hasNewKey) {
    throw new CrawlerProviderSecretError(
      'Save an API key before enabling this crawler provider.',
      400,
      'CRAWLER_SECRET_VALUE_REQUIRED',
    );
  }
  const row = await saveProviderCredentialVaultRow({
    id: existing?.id,
    vaultKey,
    credentialType: 'shared',
    provider,
    purpose: 'default',
    label: existing?.label || `Administrator ${provider}`,
    ...(hasNewKey ? { apiKeys: [normalizeApiKey(options.apiKey)] } : {}),
    enabled: typeof options.enabled === 'boolean' ? options.enabled : existing?.enabled ?? true,
    updatedBy: options.updatedBy,
  });
  if (!existing) {
    await saveCredentialGrant({
      credentialId: row.id,
      scope: 'all',
      priority: 100,
      enabled: true,
      actorId: options.updatedBy,
    });
  }
};

export const deleteCrawlerProviderSecret = async (
  providerValue: unknown,
): Promise<void> => {
  const provider = normalizeCrawlerExternalProvider(providerValue);
  await deleteProviderCredentialVaultRow(getAdminCrawlerVaultKey(provider));
};

const encryptSecret = (
  providerValue: unknown,
  plaintext: string,
) => {
  const provider = normalizeCrawlerExternalProvider(providerValue);
  return encryptProviderCredentialKeys(
    getAdminCrawlerVaultKey(provider),
    [normalizeApiKey(plaintext)],
  );
};

const decryptSecret = (
  row: { provider: CrawlerExternalProvider } & Record<string, any>,
): string => {
  const provider = normalizeCrawlerExternalProvider(row.provider);
  const vaultKey = getAdminCrawlerVaultKey(provider);
  if (row.encryption_context !== getProviderCredentialVaultAad(vaultKey)) {
    throw new CrawlerProviderSecretError(
      'The stored crawler key could not be decrypted. Verify the provider credential vault key.',
      503,
      'CRAWLER_SECRET_DECRYPTION_FAILED',
    );
  }
  try {
    return decryptProviderCredentialKeys({
      ...row,
      vault_key: vaultKey,
    } as ProviderCredentialVaultRow)[0];
  } catch {
    throw new CrawlerProviderSecretError(
      'The stored crawler key could not be decrypted. Verify the provider credential vault key.',
      503,
      'CRAWLER_SECRET_DECRYPTION_FAILED',
    );
  }
};

export const __crawlerProviderSecretsTestUtils = {
  encryptSecret,
  decryptSecret,
  normalizeApiKey,
  getAdminCrawlerVaultKey,
};
