import {
  USER_AI_PROVIDER_KEY_LIMIT,
  USER_AI_SECRET_PROVIDERS,
  type UserAiSecretProvider,
} from '../constants/userAiProviderSecrets.ts';
import type { ProviderAccessProvider } from '../constants/providerAccessControl.ts';
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

export { USER_AI_SECRET_PROVIDERS } from '../constants/userAiProviderSecrets.ts';
export type { UserAiSecretProvider } from '../constants/userAiProviderSecrets.ts';

export type UserAiProviderSecretStatus = {
  provider: UserAiSecretProvider;
  configured: boolean;
  enabled: boolean;
  keyCount: number;
  keySuffixes: string[];
  updatedAt: string | null;
};

export type UserAiProviderSecretsOverview = {
  schemaAvailable: boolean;
  encryptionConfigured: boolean;
  providers: Record<UserAiSecretProvider, UserAiProviderSecretStatus>;
};

export class UserAiProviderSecretError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'USER_AI_PROVIDER_SECRET_ERROR') {
    super(message);
    this.name = 'UserAiProviderSecretError';
    this.status = status;
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUserAiSecretProvider = (value: unknown): value is UserAiSecretProvider => (
  typeof value === 'string'
  && USER_AI_SECRET_PROVIDERS.includes(value as UserAiSecretProvider)
);

export const normalizeUserAiSecretProvider = (value: unknown): UserAiSecretProvider => {
  if (!isUserAiSecretProvider(value)) {
    throw new UserAiProviderSecretError(
      'Unsupported personal provider.',
      400,
      'USER_AI_SECRET_PROVIDER_INVALID',
    );
  }
  return value;
};

const normalizeUserId = (value: unknown): string => {
  const userId = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(userId)) {
    throw new UserAiProviderSecretError('A valid user is required.', 400, 'USER_AI_SECRET_USER_INVALID');
  }
  return userId;
};

export const assertPersonalCredentialOwner = (
  actorUserIdValue: unknown,
  ownerUserIdValue: unknown,
): string => {
  const actorUserId = normalizeUserId(actorUserIdValue);
  const ownerUserId = normalizeUserId(ownerUserIdValue);
  if (actorUserId !== ownerUserId) {
    throw new UserAiProviderSecretError(
      'Personal API keys may only be used by their owner.',
      403,
      'USER_AI_SECRET_OWNER_MISMATCH',
    );
  }
  return ownerUserId;
};

const toVaultProvider = (provider: UserAiSecretProvider): ProviderAccessProvider => (
  provider === 'openai_paid' ? 'openai' : provider
);

const getPersonalVaultKey = (
  userIdValue: unknown,
  providerValue: unknown,
): string => {
  const userId = normalizeUserId(userIdValue);
  const provider = normalizeUserAiSecretProvider(providerValue);
  return `personal:${userId}:${toVaultProvider(provider)}`;
};

export const normalizeApiKeyList = (value: unknown): string[] => {
  try {
    return normalizeProviderCredentialKeys(value, {
      minimumLength: 20,
      maximumKeys: USER_AI_PROVIDER_KEY_LIMIT,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'VAULT_KEY_COUNT_INVALID') {
      const candidates = Array.isArray(value) ? value : String(value || '').split(/[\n,;]+/);
      const count = candidates.map(item => String(item || '').trim()).filter(Boolean).length;
      if (count > USER_AI_PROVIDER_KEY_LIMIT) {
        throw new UserAiProviderSecretError(
          `A maximum of ${USER_AI_PROVIDER_KEY_LIMIT} keys is allowed for each provider.`,
          400,
          'USER_AI_SECRET_LIMIT_EXCEEDED',
        );
      }
      throw new UserAiProviderSecretError(
        'Enter at least one API key.',
        400,
        'USER_AI_SECRET_VALUE_REQUIRED',
      );
    }
    throw new UserAiProviderSecretError(
      'Each API key must be one non-whitespace value between 20 and 512 characters.',
      400,
      'USER_AI_SECRET_VALUE_INVALID',
    );
  }
};

const normalizeSuffixes = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(item => String(item || '').trim().slice(-4)).filter(item => item.length === 4)
    : []
);

const emptyStatus = (provider: UserAiSecretProvider): UserAiProviderSecretStatus => ({
  provider,
  configured: false,
  enabled: false,
  keyCount: 0,
  keySuffixes: [],
  updatedAt: null,
});

const toStatus = (
  provider: UserAiSecretProvider,
  row: ProviderCredentialVaultRow | null,
): UserAiProviderSecretStatus => {
  const keySuffixes = normalizeSuffixes(row?.key_suffixes);
  return {
    provider,
    configured: Boolean(row && row.key_count > 0 && keySuffixes.length > 0),
    enabled: row?.enabled === true,
    keyCount: Math.max(0, Number(row?.key_count || keySuffixes.length) || 0),
    keySuffixes,
    updatedAt: row?.updated_at || null,
  };
};

const readSecretRow = async (
  userIdValue: unknown,
  providerValue: unknown,
): Promise<ProviderCredentialVaultRow | null> => {
  const userId = normalizeUserId(userIdValue);
  const provider = normalizeUserAiSecretProvider(providerValue);
  const row = await readProviderCredentialVaultRow(getPersonalVaultKey(userId, provider));
  return row?.credential_type === 'personal' && row.owner_user_id === userId ? row : null;
};

export const readUserAiProviderSecretsOverview = async (options: {
  actorUserId: unknown;
  ownerUserId: unknown;
}): Promise<UserAiProviderSecretsOverview> => {
  const userId = assertPersonalCredentialOwner(options.actorUserId, options.ownerUserId);
  try {
    const providers = Object.fromEntries(await Promise.all(
      USER_AI_SECRET_PROVIDERS.map(async provider => [
        provider,
        toStatus(provider, await readSecretRow(userId, provider)),
      ] as const),
    )) as Record<UserAiSecretProvider, UserAiProviderSecretStatus>;
    return {
      schemaAvailable: true,
      encryptionConfigured: isProviderCredentialVaultEncryptionConfigured(),
      providers,
    };
  } catch (error) {
    if (
      error instanceof ProviderCredentialVaultError
      && error.code === 'PROVIDER_CREDENTIAL_VAULT_SCHEMA_MISSING'
    ) {
      return {
        schemaAvailable: false,
        encryptionConfigured: isProviderCredentialVaultEncryptionConfigured(),
        providers: Object.fromEntries(
          USER_AI_SECRET_PROVIDERS.map(provider => [provider, emptyStatus(provider)]),
        ) as Record<UserAiSecretProvider, UserAiProviderSecretStatus>,
      };
    }
    throw error;
  }
};

export const resolveUserAiProviderKeys = async (options: {
  actorUserId: string | null | undefined;
  ownerUserId: string | null | undefined;
  provider: UserAiSecretProvider;
}): Promise<string[]> => {
  if (!options.actorUserId && !options.ownerUserId) return [];
  const ownerUserId = assertPersonalCredentialOwner(options.actorUserId, options.ownerUserId);
  const row = await readSecretRow(ownerUserId, options.provider);
  if (!row?.enabled) return [];
  return decryptProviderCredentialKeys(row);
};

export const saveUserAiProviderKeys = async (options: {
  actorUserId: string;
  ownerUserId: string;
  provider: UserAiSecretProvider;
  apiKeys: unknown;
}): Promise<void> => {
  const userId = assertPersonalCredentialOwner(options.actorUserId, options.ownerUserId);
  const provider = normalizeUserAiSecretProvider(options.provider);
  const apiKeys = normalizeApiKeyList(options.apiKeys);
  await saveProviderCredentialVaultRow({
    vaultKey: getPersonalVaultKey(userId, provider),
    credentialType: 'personal',
    provider: toVaultProvider(provider),
    purpose: 'default',
    ownerUserId: userId,
    label: `Personal ${provider}`,
    apiKeys,
    enabled: true,
    updatedBy: userId,
  });
};

export const deleteUserAiProviderKeys = async (options: {
  actorUserId: unknown;
  ownerUserId: unknown;
  provider: unknown;
}): Promise<void> => {
  const userId = assertPersonalCredentialOwner(options.actorUserId, options.ownerUserId);
  const provider = normalizeUserAiSecretProvider(options.provider);
  await deleteProviderCredentialVaultRow(getPersonalVaultKey(userId, provider));
};

const encryptKeyList = (
  userIdValue: unknown,
  providerValue: unknown,
  apiKeys: string[],
) => {
  const vaultKey = getPersonalVaultKey(userIdValue, providerValue);
  return encryptProviderCredentialKeys(vaultKey, normalizeApiKeyList(apiKeys));
};

const decryptKeyList = (row: {
  user_id: string;
  provider: UserAiSecretProvider;
} & Record<string, any>): string[] => {
  const vaultKey = getPersonalVaultKey(row.user_id, row.provider);
  if (row.encryption_context !== getProviderCredentialVaultAad(vaultKey)) {
    throw new UserAiProviderSecretError(
      'The stored personal keys could not be decrypted. Verify the credential vault key.',
      503,
      'USER_AI_SECRET_DECRYPTION_FAILED',
    );
  }
  try {
    return decryptProviderCredentialKeys({
      ...row,
      vault_key: vaultKey,
    } as unknown as ProviderCredentialVaultRow);
  } catch {
    throw new UserAiProviderSecretError(
      'The stored personal keys could not be decrypted. Verify the credential vault key.',
      503,
      'USER_AI_SECRET_DECRYPTION_FAILED',
    );
  }
};

export const __userAiProviderSecretsTestUtils = {
  encryptKeyList,
  decryptKeyList,
  normalizeApiKeyList,
  getPersonalVaultKey,
};
