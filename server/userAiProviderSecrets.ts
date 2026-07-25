import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';
import {
  USER_AI_PROVIDER_KEY_LIMIT,
  USER_AI_PROVIDER_SECRETS_MIGRATION,
  USER_AI_SECRET_PROVIDERS,
  type UserAiSecretProvider,
} from '../constants/userAiProviderSecrets.ts';

export { USER_AI_SECRET_PROVIDERS } from '../constants/userAiProviderSecrets.ts';
export type { UserAiSecretProvider } from '../constants/userAiProviderSecrets.ts';

type UserAiProviderSecretRow = {
  user_id: string;
  provider: UserAiSecretProvider;
  ciphertext: string;
  initialization_vector: string;
  authentication_tag: string;
  encryption_version: number;
  enabled: boolean;
  key_count: number;
  key_suffixes: unknown;
  created_at: string;
  updated_at: string;
};

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
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'USER_AI_PROVIDER_SECRET_ERROR') {
    super(message);
    this.name = 'UserAiProviderSecretError';
    this.status = status;
    this.code = code;
  }
}

const TABLE_NAME = 'user_ai_provider_secrets';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_VERSION = 1;
const ENCRYPTION_KEY_BYTES = 32;
const INITIALIZATION_VECTOR_BYTES = 12;

const isUserAiSecretProvider = (value: unknown): value is UserAiSecretProvider => (
  typeof value === 'string'
  && USER_AI_SECRET_PROVIDERS.includes(value as UserAiSecretProvider)
);

export const normalizeUserAiSecretProvider = (value: unknown): UserAiSecretProvider => {
  if (!isUserAiSecretProvider(value)) {
    throw new UserAiProviderSecretError(
      'Unsupported personal AI secret provider.',
      400,
      'USER_AI_SECRET_PROVIDER_INVALID',
    );
  }
  return value;
};

const normalizeUserId = (value: unknown): string => {
  const userId = typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new UserAiProviderSecretError('A valid user is required.', 400, 'USER_AI_SECRET_USER_INVALID');
  }
  return userId;
};

const parseEncryptionKey = (): Buffer | null => {
  const rawValue = String(process.env.AI_SETTINGS_ENCRYPTION_KEY || '').trim();
  if (!rawValue) return null;
  if (/^[a-f0-9]{64}$/i.test(rawValue)) return Buffer.from(rawValue, 'hex');

  const base64Value = rawValue.startsWith('base64:') ? rawValue.slice('base64:'.length) : rawValue;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Value)) return null;
  const decoded = Buffer.from(base64Value, 'base64');
  return decoded.length === ENCRYPTION_KEY_BYTES ? decoded : null;
};

const requireEncryptionKey = (): Buffer => {
  const key = parseEncryptionKey();
  if (!key) {
    throw new UserAiProviderSecretError(
      'AI_SETTINGS_ENCRYPTION_KEY must be configured before personal API keys can be used.',
      503,
      'USER_AI_SECRET_ENCRYPTION_KEY_MISSING',
    );
  }
  return key;
};

// AAD includes both owner and provider. Even a database administrator cannot
// copy encrypted keys to another user/provider row and have them decrypt there.
const getAdditionalAuthenticatedData = (
  userId: string,
  provider: UserAiSecretProvider,
): Buffer => Buffer.from(
  `bazarvan:${TABLE_NAME}:${userId}:${provider}:v${ENCRYPTION_VERSION}`,
  'utf8',
);

const encryptKeyList = (
  userId: string,
  provider: UserAiSecretProvider,
  apiKeys: string[],
): Pick<UserAiProviderSecretRow, 'ciphertext' | 'initialization_vector' | 'authentication_tag' | 'encryption_version'> => {
  const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, requireEncryptionKey(), initializationVector);
  cipher.setAAD(getAdditionalAuthenticatedData(userId, provider));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(apiKeys), 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    initialization_vector: initializationVector.toString('base64'),
    authentication_tag: cipher.getAuthTag().toString('base64'),
    encryption_version: ENCRYPTION_VERSION,
  };
};

const decryptKeyList = (row: UserAiProviderSecretRow): string[] => {
  if (row.encryption_version !== ENCRYPTION_VERSION) {
    throw new UserAiProviderSecretError(
      'The stored personal AI keys use an unsupported encryption version.',
      503,
      'USER_AI_SECRET_ENCRYPTION_VERSION_UNSUPPORTED',
    );
  }

  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      requireEncryptionKey(),
      Buffer.from(row.initialization_vector, 'base64'),
    );
    decipher.setAAD(getAdditionalAuthenticatedData(row.user_id, row.provider));
    decipher.setAuthTag(Buffer.from(row.authentication_tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return normalizeApiKeyList(JSON.parse(plaintext));
  } catch (error) {
    if (error instanceof UserAiProviderSecretError) throw error;
    throw new UserAiProviderSecretError(
      'The stored personal AI keys could not be decrypted. Verify AI_SETTINGS_ENCRYPTION_KEY.',
      503,
      'USER_AI_SECRET_DECRYPTION_FAILED',
    );
  }
};

export const normalizeApiKeyList = (value: unknown): string[] => {
  const candidates = Array.isArray(value)
    ? value.flatMap(item => typeof item === 'string' ? item.split(/[\n,;]+/) : [])
    : typeof value === 'string'
      ? value.split(/[\n,;]+/)
      : [];
  const keys = Array.from(new Set(candidates.map(key => key.trim()).filter(Boolean)));
  if (keys.length === 0) {
    throw new UserAiProviderSecretError(
      'Enter at least one API key.',
      400,
      'USER_AI_SECRET_VALUE_REQUIRED',
    );
  }
  if (keys.length > USER_AI_PROVIDER_KEY_LIMIT) {
    throw new UserAiProviderSecretError(
      `A maximum of ${USER_AI_PROVIDER_KEY_LIMIT} keys is allowed for each provider.`,
      400,
      'USER_AI_SECRET_LIMIT_EXCEEDED',
    );
  }
  for (const key of keys) {
    if (key.length < 20 || key.length > 512 || /\s/.test(key)) {
      throw new UserAiProviderSecretError(
        'Each API key must be one non-whitespace value between 20 and 512 characters.',
        400,
        'USER_AI_SECRET_VALUE_INVALID',
      );
    }
  }
  return keys;
};

const normalizeSuffixes = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
      .map(item => item.trim().slice(-4))
      .filter(item => item.length === 4)
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

const toStatus = (row: Partial<UserAiProviderSecretRow>): UserAiProviderSecretStatus => {
  const keySuffixes = normalizeSuffixes(row.key_suffixes);
  return {
    provider: normalizeUserAiSecretProvider(row.provider),
    configured: Number(row.key_count || 0) > 0 && keySuffixes.length > 0,
    enabled: row.enabled === true,
    keyCount: Math.max(0, Number(row.key_count || keySuffixes.length) || 0),
    keySuffixes,
    updatedAt: typeof row.updated_at === 'string' && row.updated_at ? row.updated_at : null,
  };
};

const isMissingTableError = (error: { code?: string } | null | undefined): boolean => error?.code === '42P01';

const toStorageError = (error: { code?: string }): UserAiProviderSecretError => (
  isMissingTableError(error)
    ? new UserAiProviderSecretError(
        `Apply migration ${USER_AI_PROVIDER_SECRETS_MIGRATION} before saving personal AI keys.`,
        503,
        'USER_AI_SECRET_SCHEMA_MISSING',
      )
    : new UserAiProviderSecretError(
        `Could not access encrypted personal AI settings (${error.code || 'unknown'}).`,
        503,
        'USER_AI_SECRET_STORAGE_UNAVAILABLE',
      )
);

const readSecretRow = async (
  userIdValue: unknown,
  providerValue: unknown,
): Promise<UserAiProviderSecretRow | null> => {
  const userId = normalizeUserId(userIdValue);
  const provider = normalizeUserAiSecretProvider(providerValue);
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .select('user_id,provider,ciphertext,initialization_vector,authentication_tag,encryption_version,enabled,key_count,key_suffixes,created_at,updated_at')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) {
    // A server can still use its shared keys before the new migration is applied.
    if (isMissingTableError(error)) return null;
    throw toStorageError(error);
  }
  return data ? data as UserAiProviderSecretRow : null;
};

export const readUserAiProviderSecretsOverview = async (
  userIdValue: unknown,
): Promise<UserAiProviderSecretsOverview> => {
  const userId = normalizeUserId(userIdValue);
  const providers = Object.fromEntries(
    USER_AI_SECRET_PROVIDERS.map(provider => [provider, emptyStatus(provider)]),
  ) as Record<UserAiSecretProvider, UserAiProviderSecretStatus>;
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .select('provider,enabled,key_count,key_suffixes,updated_at')
    .eq('user_id', userId);

  if (error) {
    if (isMissingTableError(error)) {
      return {
        schemaAvailable: false,
        encryptionConfigured: parseEncryptionKey() !== null,
        providers,
      };
    }
    throw toStorageError(error);
  }
  (data || []).forEach(row => {
    if (!isUserAiSecretProvider(row.provider)) return;
    providers[row.provider] = toStatus(row);
  });
  return {
    schemaAvailable: true,
    encryptionConfigured: parseEncryptionKey() !== null,
    providers,
  };
};

export const resolveUserAiProviderKeys = async (
  userId: string | null | undefined,
  provider: UserAiSecretProvider,
): Promise<string[]> => {
  if (!userId) return [];
  const row = await readSecretRow(userId, provider);
  if (!row?.enabled) return [];
  return decryptKeyList(row);
};

export const saveUserAiProviderKeys = async (options: {
  userId: string;
  provider: UserAiSecretProvider;
  apiKeys: unknown;
}): Promise<void> => {
  const userId = normalizeUserId(options.userId);
  const provider = normalizeUserAiSecretProvider(options.provider);
  const apiKeys = normalizeApiKeyList(options.apiKeys);
  const encrypted = encryptKeyList(userId, provider, apiKeys);
  const now = new Date().toISOString();
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .upsert({
      user_id: userId,
      provider,
      ...encrypted,
      enabled: true,
      key_count: apiKeys.length,
      key_suffixes: apiKeys.map(key => key.slice(-4)),
      updated_at: now,
    }, { onConflict: 'user_id,provider' });
  if (error) throw toStorageError(error);
};

export const deleteUserAiProviderKeys = async (
  userIdValue: unknown,
  providerValue: unknown,
): Promise<void> => {
  const userId = normalizeUserId(userIdValue);
  const provider = normalizeUserAiSecretProvider(providerValue);
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) throw toStorageError(error);
};

export const __userAiProviderSecretsTestUtils = {
  encryptKeyList,
  decryptKeyList,
  normalizeApiKeyList,
};
