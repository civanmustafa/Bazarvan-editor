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
import {
  readUserAiProviderSecretsOverview,
  resolveUserAiProviderKeys,
  type UserAiSecretProvider,
} from './userAiProviderSecrets.ts';
import { getContentWritingResumeSecretProvider } from '../constants/contentWritingResume.ts';

export { ADMIN_AI_SECRET_PROVIDERS } from '../constants/adminAiProviderSecrets.ts';
export type { AdminAiSecretProvider } from '../constants/adminAiProviderSecrets.ts';
export type AiCredentialSource = 'resume' | 'user' | 'admin' | 'hostinger';
export type AiCredentialPurpose = 'standard' | 'content_writing_resume';

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
  userKeys: string[] = [],
  resumeKey: string | null = null,
): ResolvedAiCredentialSet => {
  const normalizedUserKeys = Array.from(new Set(userKeys.map(key => key.trim()).filter(Boolean)));
  const normalizedAdminKey = adminEnabled && adminKey ? adminKey.trim() : '';
  const normalizedResumeKey = resumeKey?.trim() || '';
  const keysBeforeHostinger = new Set([
    ...(normalizedResumeKey ? [normalizedResumeKey] : []),
    ...normalizedUserKeys,
    ...(normalizedAdminKey ? [normalizedAdminKey] : []),
  ]);
  const normalizedFallbackKeys = Array.from(new Set(
    fallbackKeys.map(key => key.trim()).filter(key => key && !keysBeforeHostinger.has(key)),
  ));
  const userKeysWithoutResume = normalizedUserKeys.filter(key => key !== normalizedResumeKey);
  const adminKeys = normalizedAdminKey
    && normalizedAdminKey !== normalizedResumeKey
    && !normalizedUserKeys.includes(normalizedAdminKey)
    ? [normalizedAdminKey]
    : [];
  const tiers: ResolvedAiCredentialTier[] = [
    ...(normalizedResumeKey ? [{ source: 'resume' as const, keys: [normalizedResumeKey] }] : []),
    ...(userKeysWithoutResume.length > 0 ? [{ source: 'user' as const, keys: userKeysWithoutResume }] : []),
    ...(adminKeys.length > 0 ? [{ source: 'admin' as const, keys: adminKeys }] : []),
    ...(normalizedFallbackKeys.length > 0 ? [{ source: 'hostinger' as const, keys: normalizedFallbackKeys }] : []),
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
  userId?: string,
  userProvider?: UserAiSecretProvider,
  purpose: AiCredentialPurpose = 'standard',
  runtimeProvider?: 'gemini' | 'geminiPaid' | 'openai',
): Promise<ResolvedAiCredentialSet> => {
  const [row, userKeys, resumeRow] = await Promise.all([
    readSecretRow(provider),
    userProvider ? resolveUserAiProviderKeys(userId, userProvider) : Promise.resolve([]),
    purpose === 'content_writing_resume' && runtimeProvider
      ? readSecretRow(getContentWritingResumeSecretProvider(runtimeProvider))
      : Promise.resolve(null),
  ]);
  const adminKey = row?.enabled ? normalizeApiKey(decryptSecret(row)) : null;
  const resumeKey = resumeRow?.enabled ? normalizeApiKey(decryptSecret(resumeRow)) : null;
  return buildResolvedCredentialSet(
    adminKey,
    row?.enabled === true,
    fallbackKeys,
    userKeys,
    resumeKey,
  );
};

export const resolveOpenAiApiKeys = async (
  userId?: string,
  purpose: AiCredentialPurpose = 'standard',
): Promise<ResolvedAiCredentialSet> => (
  resolveCredentialSet(
    'openai_latest',
    getEnvironmentOpenAiApiKeys(),
    userId,
    'openai_paid',
    purpose,
    'openai',
  )
);

export const resolveGeminiApiKeys = async (
  provider: 'gemini' | 'geminiPaid',
  userId?: string,
  purpose: AiCredentialPurpose = 'standard',
): Promise<ResolvedAiCredentialSet> => {
  const fallbackKeys = getEnvironmentGeminiApiKeys(provider);
  if (provider === 'gemini') {
    const [userKeys, resumeRow] = await Promise.all([
      resolveUserAiProviderKeys(userId, 'gemini_free'),
      purpose === 'content_writing_resume'
        ? readSecretRow(getContentWritingResumeSecretProvider(provider))
        : Promise.resolve(null),
    ]);
    const resumeKey = resumeRow?.enabled ? normalizeApiKey(decryptSecret(resumeRow)) : null;
    return buildResolvedCredentialSet(null, false, fallbackKeys, userKeys, resumeKey);
  }
  return resolveCredentialSet(
    'gemini_latest',
    fallbackKeys,
    userId,
    'gemini_paid',
    purpose,
    provider,
  );
};

export const readAiProviderCredentialAvailability = async (userId?: string): Promise<{
  gemini: AiProviderCredentialAvailability;
  openai: AiProviderCredentialAvailability;
  geminiPaid: AiProviderCredentialAvailability;
}> => {
  const [adminOverview, userOverview] = await Promise.all([
    readAdminAiProviderSecretsOverview(),
    userId ? readUserAiProviderSecretsOverview(userId) : Promise.resolve(null),
  ]);
  const toAvailability = (options: {
    userProvider: UserAiSecretProvider;
    adminProvider?: AdminAiSecretProvider;
    fallbackKeys: string[];
  }): AiProviderCredentialAvailability => {
    const userStatus = userOverview?.providers[options.userProvider];
    const userKeyCount = userOverview?.encryptionConfigured
      && userStatus?.enabled
      && userStatus.configured
      ? userStatus.keyCount
      : 0;
    const adminStatus = options.adminProvider
      ? adminOverview.providers[options.adminProvider]
      : null;
    const adminKeyCount = adminOverview.encryptionConfigured
      && adminStatus?.enabled
      && adminStatus.configured
      ? 1
      : 0;
    const fallbackKeyCount = options.fallbackKeys.length;
    return {
      configured: userKeyCount + adminKeyCount + fallbackKeyCount > 0,
      keyCount: userKeyCount + adminKeyCount + fallbackKeyCount,
      source: userKeyCount > 0 ? 'user' : adminKeyCount > 0 ? 'admin' : 'hostinger',
    };
  };

  return {
    gemini: toAvailability({
      userProvider: 'gemini_free',
      fallbackKeys: getEnvironmentGeminiApiKeys('gemini'),
    }),
    openai: toAvailability({
      userProvider: 'openai_paid',
      adminProvider: 'openai_latest',
      fallbackKeys: getEnvironmentOpenAiApiKeys(),
    }),
    geminiPaid: toAvailability({
      userProvider: 'gemini_paid',
      adminProvider: 'gemini_latest',
      fallbackKeys: getEnvironmentGeminiApiKeys('geminiPaid'),
    }),
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
