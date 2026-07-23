import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';
import {
  ADMIN_AI_SECRET_PROVIDERS,
  type AdminAiSecretProvider,
} from '../constants/adminAiProviderSecrets.ts';

export { ADMIN_AI_SECRET_PROVIDERS } from '../constants/adminAiProviderSecrets.ts';
export type { AdminAiSecretProvider } from '../constants/adminAiProviderSecrets.ts';
export type AiCredentialSource = 'admin' | 'hostinger';

export type ResolvedAiCredentialTier = {
  source: AiCredentialSource;
  keys: string[];
};

type AiProviderSecretRow = {
  provider: AdminAiSecretProvider;
  ciphertext: string;
  initialization_vector: string;
  authentication_tag: string;
  encryption_version: number;
  enabled: boolean;
  key_suffix: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
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
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'AI_PROVIDER_SECRET_ERROR') {
    super(message);
    this.name = 'AdminAiProviderSecretError';
    this.status = status;
    this.code = code;
  }
}

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_VERSION = 1;
const ENCRYPTION_KEY_BYTES = 32;
const INITIALIZATION_VECTOR_BYTES = 12;
const TABLE_NAME = 'ai_provider_secrets';

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

const splitSecretList = (...values: Array<string | undefined>): string[] => (
  Array.from(new Set(
    values
      .flatMap(value => String(value || '').split(/[\n,;]+/))
      .map(value => value.trim())
      .filter(Boolean),
  ))
);

export const getEnvironmentOpenAiApiKeys = (): string[] => splitSecretList(
  process.env.OPENAI_API_KEYS,
  process.env.OPENAI_API_KEY,
);

export const getEnvironmentGeminiApiKeys = (
  provider: 'gemini' | 'geminiPaid',
): string[] => provider === 'geminiPaid'
  ? splitSecretList(
      process.env.GEMINI_PAID_API_KEYS,
      process.env.GEMINI_PAID_API_KEY,
      process.env.GEMINI_PRO_API_KEYS,
      process.env.GEMINI_PRO_API_KEY,
    )
  : splitSecretList(
      process.env.GEMINI_API_KEYS,
      process.env.GEMINI_API_KEY,
      process.env.API_KEY,
    );

const parseEncryptionKey = (): Buffer | null => {
  const rawValue = String(process.env.AI_SETTINGS_ENCRYPTION_KEY || '').trim();
  if (!rawValue) return null;

  if (/^[a-f0-9]{64}$/i.test(rawValue)) {
    return Buffer.from(rawValue, 'hex');
  }

  const base64Value = rawValue.startsWith('base64:') ? rawValue.slice('base64:'.length) : rawValue;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Value)) return null;
  const decoded = Buffer.from(base64Value, 'base64');
  return decoded.length === ENCRYPTION_KEY_BYTES ? decoded : null;
};

export const isAiSettingsEncryptionConfigured = (): boolean => parseEncryptionKey() !== null;

const requireEncryptionKey = (): Buffer => {
  const key = parseEncryptionKey();
  if (!key) {
    throw new AdminAiProviderSecretError(
      'AI_SETTINGS_ENCRYPTION_KEY must be a 32-byte Base64 value or a 64-character hexadecimal value.',
      503,
      'AI_SECRET_ENCRYPTION_KEY_MISSING',
    );
  }
  return key;
};

const getAdditionalAuthenticatedData = (provider: AdminAiSecretProvider): Buffer => (
  Buffer.from(`bazarvan:${TABLE_NAME}:${provider}:v${ENCRYPTION_VERSION}`, 'utf8')
);

const encryptSecret = (
  provider: AdminAiSecretProvider,
  plaintext: string,
): Pick<AiProviderSecretRow, 'ciphertext' | 'initialization_vector' | 'authentication_tag' | 'encryption_version'> => {
  const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, requireEncryptionKey(), initializationVector);
  cipher.setAAD(getAdditionalAuthenticatedData(provider));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString('base64'),
    initialization_vector: initializationVector.toString('base64'),
    authentication_tag: cipher.getAuthTag().toString('base64'),
    encryption_version: ENCRYPTION_VERSION,
  };
};

const decryptSecret = (row: AiProviderSecretRow): string => {
  if (row.encryption_version !== ENCRYPTION_VERSION) {
    throw new AdminAiProviderSecretError(
      'The stored AI key uses an unsupported encryption version.',
      503,
      'AI_SECRET_ENCRYPTION_VERSION_UNSUPPORTED',
    );
  }

  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      requireEncryptionKey(),
      Buffer.from(row.initialization_vector, 'base64'),
    );
    decipher.setAAD(getAdditionalAuthenticatedData(row.provider));
    decipher.setAuthTag(Buffer.from(row.authentication_tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof AdminAiProviderSecretError) throw error;
    throw new AdminAiProviderSecretError(
      'The stored AI key could not be decrypted. Verify AI_SETTINGS_ENCRYPTION_KEY.',
      503,
      'AI_SECRET_DECRYPTION_FAILED',
    );
  }
};

const normalizeApiKey = (value: unknown): string => {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length < 20 || key.length > 512 || /[\s,;]/.test(key)) {
    throw new AdminAiProviderSecretError(
      'The API key must be a single non-whitespace value between 20 and 512 characters.',
      400,
      'AI_SECRET_VALUE_INVALID',
    );
  }
  return key;
};

const emptyStatus = (provider: AdminAiSecretProvider): AdminAiProviderSecretStatus => ({
  provider,
  configured: false,
  enabled: false,
  keySuffix: null,
  updatedAt: null,
});

const toStatus = (row: Partial<AiProviderSecretRow>): AdminAiProviderSecretStatus => ({
  provider: normalizeAdminAiSecretProvider(row.provider),
  configured: Boolean(row.key_suffix),
  enabled: row.enabled === true,
  keySuffix: typeof row.key_suffix === 'string' && row.key_suffix ? row.key_suffix : null,
  updatedAt: typeof row.updated_at === 'string' && row.updated_at ? row.updated_at : null,
});

const isMissingTableError = (error: { code?: string } | null | undefined): boolean => (
  error?.code === '42P01'
);

const toSchemaError = (error: { code?: string; message?: string }): AdminAiProviderSecretError => (
  isMissingTableError(error)
    ? new AdminAiProviderSecretError(
        'Apply migration 20260722050000_admin_ai_provider_secrets.sql before configuring administrator AI keys.',
        503,
        'AI_SECRET_SCHEMA_MISSING',
      )
    : new AdminAiProviderSecretError(
        `Could not access encrypted AI settings (${error.code || 'unknown'}).`,
        503,
        'AI_SECRET_STORAGE_UNAVAILABLE',
      )
);

export const readAdminAiProviderSecretsOverview = async (): Promise<AdminAiProviderSecretsOverview> => {
  const providers = Object.fromEntries(
    ADMIN_AI_SECRET_PROVIDERS.map(provider => [provider, emptyStatus(provider)]),
  ) as Record<AdminAiSecretProvider, AdminAiProviderSecretStatus>;
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .select('provider,enabled,key_suffix,updated_at');

  if (error) {
    if (isMissingTableError(error)) {
      return {
        schemaAvailable: false,
        encryptionConfigured: isAiSettingsEncryptionConfigured(),
        providers,
      };
    }
    throw toSchemaError(error);
  }

  (data || []).forEach(row => {
    if (!isAdminAiSecretProvider(row.provider)) return;
    providers[row.provider] = toStatus(row);
  });

  return {
    schemaAvailable: true,
    encryptionConfigured: isAiSettingsEncryptionConfigured(),
    providers,
  };
};

const readSecretRow = async (provider: AdminAiSecretProvider): Promise<AiProviderSecretRow | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .select('provider,ciphertext,initialization_vector,authentication_tag,encryption_version,enabled,key_suffix,updated_by,created_at,updated_at')
    .eq('provider', provider)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) return null;
    throw toSchemaError(error);
  }
  return data ? data as AiProviderSecretRow : null;
};

const buildResolvedCredentialSet = (
  adminKey: string | null,
  adminEnabled: boolean,
  fallbackKeys: string[],
): ResolvedAiCredentialSet => {
  const normalizedFallbackKeys = Array.from(new Set(
    fallbackKeys.map(key => key.trim()).filter(Boolean),
  ));
  const normalizedAdminKey = adminEnabled && adminKey ? adminKey.trim() : '';
  const hostingerKeys = normalizedAdminKey
    ? normalizedFallbackKeys.filter(key => key !== normalizedAdminKey)
    : normalizedFallbackKeys;
  const tiers: ResolvedAiCredentialTier[] = [
    ...(normalizedAdminKey ? [{ source: 'admin' as const, keys: [normalizedAdminKey] }] : []),
    ...(hostingerKeys.length > 0 ? [{ source: 'hostinger' as const, keys: hostingerKeys }] : []),
  ];
  return {
    keys: tiers.flatMap(tier => tier.keys),
    source: tiers[0]?.source || 'hostinger',
    tiers,
  };
};

const resolveCredentialSet = async (
  provider: AdminAiSecretProvider,
  fallbackKeys: string[],
): Promise<ResolvedAiCredentialSet> => {
  const row = await readSecretRow(provider);
  const adminKey = row?.enabled ? normalizeApiKey(decryptSecret(row)) : null;
  return buildResolvedCredentialSet(adminKey, row?.enabled === true, fallbackKeys);
};

export const resolveOpenAiApiKeys = async (): Promise<ResolvedAiCredentialSet> => (
  resolveCredentialSet('openai_latest', getEnvironmentOpenAiApiKeys())
);

export const resolveGeminiApiKeys = async (
  provider: 'gemini' | 'geminiPaid',
): Promise<ResolvedAiCredentialSet> => {
  const fallbackKeys = getEnvironmentGeminiApiKeys(provider);
  if (provider === 'gemini') return buildResolvedCredentialSet(null, false, fallbackKeys);
  return resolveCredentialSet('gemini_latest', fallbackKeys);
};

export const readAiProviderCredentialAvailability = async (): Promise<{
  openai: AiProviderCredentialAvailability;
  geminiPaid: AiProviderCredentialAvailability;
}> => {
  const overview = await readAdminAiProviderSecretsOverview();
  const openAiFallbackKeys = getEnvironmentOpenAiApiKeys();
  const geminiFallbackKeys = getEnvironmentGeminiApiKeys('geminiPaid');
  const toAvailability = (
    status: AdminAiProviderSecretStatus,
    fallbackKeys: string[],
  ): AiProviderCredentialAvailability => {
    if (!status.enabled) {
      return {
        configured: fallbackKeys.length > 0,
        keyCount: fallbackKeys.length,
        source: 'hostinger',
      };
    }
    const configured = status.configured && overview.encryptionConfigured;
    return {
      configured,
      keyCount: configured ? 1 : 0,
      source: 'admin',
    };
  };

  return {
    openai: toAvailability(overview.providers.openai_latest, openAiFallbackKeys),
    geminiPaid: toAvailability(overview.providers.gemini_latest, geminiFallbackKeys),
  };
};

export const saveAdminAiProviderSecret = async (options: {
  provider: AdminAiSecretProvider;
  apiKey?: unknown;
  enabled?: unknown;
  updatedBy: string;
}): Promise<void> => {
  const provider = normalizeAdminAiSecretProvider(options.provider);
  const existing = await readSecretRow(provider);
  const hasNewKey = options.apiKey !== undefined && String(options.apiKey || '').trim() !== '';
  const newApiKey = hasNewKey ? normalizeApiKey(options.apiKey) : null;
  if (!existing && !hasNewKey) {
    throw new AdminAiProviderSecretError(
      'Save an API key before enabling this administrator override.',
      400,
      'AI_SECRET_VALUE_REQUIRED',
    );
  }

  const encrypted = newApiKey
    ? encryptSecret(provider, newApiKey)
    : existing;
  if (!encrypted) {
    throw new AdminAiProviderSecretError('An API key is required.', 400, 'AI_SECRET_VALUE_REQUIRED');
  }

  const enabled = typeof options.enabled === 'boolean'
    ? options.enabled
    : existing?.enabled ?? true;
  if (enabled) {
    requireEncryptionKey();
    if (!newApiKey && existing) normalizeApiKey(decryptSecret(existing));
  }
  const now = new Date().toISOString();
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .upsert({
      provider,
      ciphertext: encrypted.ciphertext,
      initialization_vector: encrypted.initialization_vector,
      authentication_tag: encrypted.authentication_tag,
      encryption_version: encrypted.encryption_version,
      enabled,
      key_suffix: newApiKey ? newApiKey.slice(-4) : existing?.key_suffix,
      updated_by: options.updatedBy,
      updated_at: now,
      ...(!existing ? { created_at: now } : {}),
    }, { onConflict: 'provider' });

  if (error) throw toSchemaError(error);
};

export const deleteAdminAiProviderSecret = async (
  providerValue: unknown,
): Promise<void> => {
  const provider = normalizeAdminAiSecretProvider(providerValue);
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .delete()
    .eq('provider', provider);
  if (error) throw toSchemaError(error);
};

export const __adminAiProviderSecretsTestUtils = {
  buildResolvedCredentialSet,
  encryptSecret,
  decryptSecret,
  normalizeApiKey,
};
