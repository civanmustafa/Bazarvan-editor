import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  CRAWLER_EXTERNAL_PROVIDERS,
  CRAWLER_PROVIDER_SECRETS_MIGRATION,
  isCrawlerExternalProvider,
  type CrawlerExternalProvider,
} from '../constants/crawlerProviders.ts';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';

type CrawlerProviderSecretRow = {
  provider: CrawlerExternalProvider;
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

export type CrawlerCredentialSource = 'admin' | 'hostinger';

export type CrawlerProviderSecretStatus = {
  provider: CrawlerExternalProvider;
  configured: boolean;
  enabled: boolean;
  keySuffix: string | null;
  updatedAt: string | null;
  fallbackConfigured: boolean;
  effectiveConfigured: boolean;
  activeSource: CrawlerCredentialSource;
};

export type CrawlerProviderSecretsOverview = {
  schemaAvailable: boolean;
  encryptionConfigured: boolean;
  providers: Record<CrawlerExternalProvider, CrawlerProviderSecretStatus>;
};

export type ResolvedCrawlerProviderCredential = {
  apiKey: string;
  source: CrawlerCredentialSource;
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

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_VERSION = 1;
const ENCRYPTION_KEY_BYTES = 32;
const INITIALIZATION_VECTOR_BYTES = 12;
const TABLE_NAME = 'crawler_provider_secrets';

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

export const getEnvironmentCrawlerApiKey = (
  provider: CrawlerExternalProvider,
): string => {
  const value = provider === 'firecrawl'
    ? process.env.FIRECRAWL_API_KEY
    : process.env.BROWSERLESS_API_KEY || process.env.BROWSERLESS_TOKEN;
  return String(value || '').trim();
};

const parseEncryptionKey = (): Buffer | null => {
  const rawValue = String(
    process.env.CRAWLER_SETTINGS_ENCRYPTION_KEY
    || process.env.AI_SETTINGS_ENCRYPTION_KEY
    || '',
  ).trim();
  if (!rawValue) return null;
  if (/^[a-f0-9]{64}$/i.test(rawValue)) return Buffer.from(rawValue, 'hex');

  const base64Value = rawValue.startsWith('base64:')
    ? rawValue.slice('base64:'.length)
    : rawValue;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Value)) return null;
  const decoded = Buffer.from(base64Value, 'base64');
  return decoded.length === ENCRYPTION_KEY_BYTES ? decoded : null;
};

export const isCrawlerSettingsEncryptionConfigured = (): boolean => (
  parseEncryptionKey() !== null
);

const requireEncryptionKey = (): Buffer => {
  const key = parseEncryptionKey();
  if (!key) {
    throw new CrawlerProviderSecretError(
      'CRAWLER_SETTINGS_ENCRYPTION_KEY or AI_SETTINGS_ENCRYPTION_KEY must contain 32 bytes encoded as Base64 or 64 hexadecimal characters.',
      503,
      'CRAWLER_SECRET_ENCRYPTION_KEY_MISSING',
    );
  }
  return key;
};

const additionalAuthenticatedData = (provider: CrawlerExternalProvider): Buffer => (
  Buffer.from(`bazarvan:${TABLE_NAME}:${provider}:v${ENCRYPTION_VERSION}`, 'utf8')
);

const normalizeApiKey = (value: unknown): string => {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length < 8 || key.length > 512 || /[\s,;]/.test(key)) {
    throw new CrawlerProviderSecretError(
      'The crawler API key must be one non-whitespace value between 8 and 512 characters.',
      400,
      'CRAWLER_SECRET_VALUE_INVALID',
    );
  }
  return key;
};

const encryptSecret = (
  provider: CrawlerExternalProvider,
  plaintext: string,
): Pick<
  CrawlerProviderSecretRow,
  'ciphertext' | 'initialization_vector' | 'authentication_tag' | 'encryption_version'
> => {
  const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES);
  const cipher = createCipheriv(
    ENCRYPTION_ALGORITHM,
    requireEncryptionKey(),
    initializationVector,
  );
  cipher.setAAD(additionalAuthenticatedData(provider));
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

const decryptSecret = (row: CrawlerProviderSecretRow): string => {
  if (row.encryption_version !== ENCRYPTION_VERSION) {
    throw new CrawlerProviderSecretError(
      'The stored crawler key uses an unsupported encryption version.',
      503,
      'CRAWLER_SECRET_ENCRYPTION_VERSION_UNSUPPORTED',
    );
  }
  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      requireEncryptionKey(),
      Buffer.from(row.initialization_vector, 'base64'),
    );
    decipher.setAAD(additionalAuthenticatedData(row.provider));
    decipher.setAuthTag(Buffer.from(row.authentication_tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof CrawlerProviderSecretError) throw error;
    throw new CrawlerProviderSecretError(
      'The stored crawler key could not be decrypted. Verify the crawler encryption key.',
      503,
      'CRAWLER_SECRET_DECRYPTION_FAILED',
    );
  }
};

const isMissingTableError = (
  error: { code?: string } | null | undefined,
): boolean => error?.code === '42P01';

const storageError = (
  error: { code?: string; message?: string },
): CrawlerProviderSecretError => (
  isMissingTableError(error)
    ? new CrawlerProviderSecretError(
        `Apply migration ${CRAWLER_PROVIDER_SECRETS_MIGRATION} before saving crawler API keys.`,
        503,
        'CRAWLER_SECRET_SCHEMA_MISSING',
      )
    : new CrawlerProviderSecretError(
        `Could not access encrypted crawler settings (${error.code || 'unknown'}).`,
        503,
        'CRAWLER_SECRET_STORAGE_UNAVAILABLE',
      )
);

const readSecretRow = async (
  provider: CrawlerExternalProvider,
): Promise<CrawlerProviderSecretRow | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .select('provider,ciphertext,initialization_vector,authentication_tag,encryption_version,enabled,key_suffix,updated_by,created_at,updated_at')
    .eq('provider', provider)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    throw storageError(error);
  }
  return data ? data as CrawlerProviderSecretRow : null;
};

const emptyStatus = (
  provider: CrawlerExternalProvider,
): CrawlerProviderSecretStatus => {
  const fallbackConfigured = Boolean(getEnvironmentCrawlerApiKey(provider));
  return {
    provider,
    configured: false,
    enabled: false,
    keySuffix: null,
    updatedAt: null,
    fallbackConfigured,
    effectiveConfigured: fallbackConfigured,
    activeSource: 'hostinger',
  };
};

export const readCrawlerProviderSecretsOverview =
async (): Promise<CrawlerProviderSecretsOverview> => {
  const providers = Object.fromEntries(
    CRAWLER_EXTERNAL_PROVIDERS.map(provider => [provider, emptyStatus(provider)]),
  ) as Record<CrawlerExternalProvider, CrawlerProviderSecretStatus>;
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .select('provider,enabled,key_suffix,updated_at');
  if (error) {
    if (isMissingTableError(error)) {
      return {
        schemaAvailable: false,
        encryptionConfigured: isCrawlerSettingsEncryptionConfigured(),
        providers,
      };
    }
    throw storageError(error);
  }

  (data || []).forEach(row => {
    if (!isCrawlerExternalProvider(row.provider)) return;
    const fallbackConfigured = Boolean(getEnvironmentCrawlerApiKey(row.provider));
    const customUsable = row.enabled === true
      && Boolean(row.key_suffix)
      && isCrawlerSettingsEncryptionConfigured();
    providers[row.provider] = {
      provider: row.provider,
      configured: Boolean(row.key_suffix),
      enabled: row.enabled === true,
      keySuffix: typeof row.key_suffix === 'string' ? row.key_suffix : null,
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
      fallbackConfigured,
      effectiveConfigured: customUsable || fallbackConfigured,
      activeSource: customUsable ? 'admin' : 'hostinger',
    };
  });

  return {
    schemaAvailable: true,
    encryptionConfigured: isCrawlerSettingsEncryptionConfigured(),
    providers,
  };
};

export const resolveCrawlerProviderCredential = async (
  providerValue: unknown,
): Promise<ResolvedCrawlerProviderCredential | null> => {
  const provider = normalizeCrawlerExternalProvider(providerValue);
  const row = await readSecretRow(provider);
  if (row?.enabled) {
    return {
      apiKey: normalizeApiKey(decryptSecret(row)),
      source: 'admin',
    };
  }
  const fallback = getEnvironmentCrawlerApiKey(provider);
  return fallback ? { apiKey: fallback, source: 'hostinger' } : null;
};

export const saveCrawlerProviderSecret = async (options: {
  provider: CrawlerExternalProvider;
  apiKey?: unknown;
  enabled?: unknown;
  updatedBy: string;
}): Promise<void> => {
  const provider = normalizeCrawlerExternalProvider(options.provider);
  const existing = await readSecretRow(provider);
  const hasNewKey = options.apiKey !== undefined
    && String(options.apiKey || '').trim() !== '';
  const newApiKey = hasNewKey ? normalizeApiKey(options.apiKey) : null;
  if (!existing && !newApiKey) {
    throw new CrawlerProviderSecretError(
      'Save an API key before enabling this crawler provider.',
      400,
      'CRAWLER_SECRET_VALUE_REQUIRED',
    );
  }

  const encrypted = newApiKey ? encryptSecret(provider, newApiKey) : existing;
  if (!encrypted) {
    throw new CrawlerProviderSecretError(
      'A crawler API key is required.',
      400,
      'CRAWLER_SECRET_VALUE_REQUIRED',
    );
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
  if (error) throw storageError(error);
};

export const deleteCrawlerProviderSecret = async (
  providerValue: unknown,
): Promise<void> => {
  const provider = normalizeCrawlerExternalProvider(providerValue);
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(TABLE_NAME)
    .delete()
    .eq('provider', provider);
  if (error) throw storageError(error);
};

export const __crawlerProviderSecretsTestUtils = {
  encryptSecret,
  decryptSecret,
  normalizeApiKey,
};
