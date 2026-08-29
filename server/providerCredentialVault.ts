import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { ProviderAccessProvider } from '../constants/providerAccessControl.ts';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';

export const PROVIDER_CREDENTIAL_VAULT_TABLE = 'provider_credentials_vault';
export const PROVIDER_CREDENTIAL_VAULT_MIGRATION =
  '20260829030000_provider_credential_vault.sql';

export type ProviderCredentialVaultType = 'personal' | 'shared';
export type ProviderCredentialVaultPurpose = 'default' | 'content_writing_resume';
export type ProviderCredentialVaultPayloadFormat = 'json_list' | 'single';
export type ProviderCredentialVaultKeySource =
  | 'vault'
  | 'legacy_ai_settings'
  | 'legacy_crawler_settings'
  | 'legacy_provider_access';

export type ProviderCredentialVaultRow = {
  id: string;
  vault_key: string;
  credential_type: ProviderCredentialVaultType;
  provider: ProviderAccessProvider;
  purpose: ProviderCredentialVaultPurpose;
  owner_user_id: string | null;
  label: string;
  ciphertext: string;
  initialization_vector: string;
  authentication_tag: string;
  encryption_version: number;
  encryption_context: string;
  encryption_key_source: ProviderCredentialVaultKeySource;
  payload_format: ProviderCredentialVaultPayloadFormat;
  enabled: boolean;
  key_count: number;
  key_suffixes: unknown;
  expires_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  legacy_source_table: string | null;
  legacy_source_key: string | null;
  created_at: string;
  updated_at: string;
};

export type ProviderCredentialVaultMetadata = {
  id: string;
  vaultKey: string;
  credentialType: ProviderCredentialVaultType;
  provider: ProviderAccessProvider;
  purpose: ProviderCredentialVaultPurpose;
  ownerUserId: string | null;
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

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_VERSION = 1;
const ENCRYPTION_KEY_BYTES = 32;
const INITIALIZATION_VECTOR_BYTES = 12;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set<ProviderAccessProvider>([
  'gemini_free',
  'gemini_paid',
  'openai',
  'firecrawl',
  'browserless',
]);

export class ProviderCredentialVaultError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'PROVIDER_CREDENTIAL_VAULT_ERROR') {
    super(message);
    this.name = 'ProviderCredentialVaultError';
    this.status = status;
    this.code = code;
  }
}

export const isProviderCredentialVaultSchemaError = (
  error: { code?: string; message?: string } | null | undefined,
): boolean => (
  ['42P01', 'PGRST205', 'PGRST202'].includes(String(error?.code || ''))
  || /does not exist|schema cache/i.test(String(error?.message || ''))
);

const storageError = (
  error: { code?: string; message?: string },
): ProviderCredentialVaultError => (
  isProviderCredentialVaultSchemaError(error)
    ? new ProviderCredentialVaultError(
        `Apply migration ${PROVIDER_CREDENTIAL_VAULT_MIGRATION} before managing provider credentials.`,
        503,
        'PROVIDER_CREDENTIAL_VAULT_SCHEMA_MISSING',
      )
    : new ProviderCredentialVaultError(
        `Could not access the provider credential vault (${error.code || 'unknown'}).`,
        503,
        'PROVIDER_CREDENTIAL_VAULT_STORAGE_UNAVAILABLE',
      )
);

const parseEncryptionKeyValue = (value: unknown): Buffer | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const base64 = raw.startsWith('base64:') ? raw.slice('base64:'.length) : raw;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const decoded = Buffer.from(base64, 'base64');
  return decoded.length === ENCRYPTION_KEY_BYTES ? decoded : null;
};

const uniqueBuffers = (values: Array<Buffer | null>): Buffer[] => {
  const seen = new Set<string>();
  return values.filter((value): value is Buffer => Boolean(value)).filter(value => {
    const fingerprint = value.toString('hex');
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
};

const getVaultEncryptionKey = (): Buffer | null => (
  parseEncryptionKeyValue(process.env.PROVIDER_CREDENTIAL_VAULT_KEY)
  || parseEncryptionKeyValue(process.env.PROVIDER_ACCESS_ENCRYPTION_KEY)
  || parseEncryptionKeyValue(process.env.AI_SETTINGS_ENCRYPTION_KEY)
  || parseEncryptionKeyValue(process.env.CRAWLER_SETTINGS_ENCRYPTION_KEY)
);

const getLegacyCrawlerDerivedKey = (): Buffer | null => {
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!serviceRoleKey) return null;
  return createHash('sha256')
    .update('bazarvan:crawler-provider-secrets:service-role-derived:v1\0', 'utf8')
    .update(serviceRoleKey, 'utf8')
    .digest();
};

const getDecryptionKeyCandidates = (row: Pick<
  ProviderCredentialVaultRow,
  'encryption_key_source'
>): Buffer[] => {
  const vaultKey = getVaultEncryptionKey();
  const aiKey = parseEncryptionKeyValue(process.env.AI_SETTINGS_ENCRYPTION_KEY);
  const crawlerKey = parseEncryptionKeyValue(process.env.CRAWLER_SETTINGS_ENCRYPTION_KEY);
  const providerAccessKey = parseEncryptionKeyValue(process.env.PROVIDER_ACCESS_ENCRYPTION_KEY);
  switch (row.encryption_key_source) {
    case 'legacy_ai_settings':
      return uniqueBuffers([aiKey, vaultKey]);
    case 'legacy_crawler_settings':
      return uniqueBuffers([crawlerKey, aiKey, getLegacyCrawlerDerivedKey(), vaultKey]);
    case 'legacy_provider_access':
      return uniqueBuffers([providerAccessKey, aiKey, crawlerKey, vaultKey]);
    case 'vault':
    default:
      return uniqueBuffers([vaultKey]);
  }
};

export const isProviderCredentialVaultEncryptionConfigured = (): boolean => (
  getVaultEncryptionKey() !== null
);

const requireVaultEncryptionKey = (): Buffer => {
  const key = getVaultEncryptionKey();
  if (!key) {
    throw new ProviderCredentialVaultError(
      'PROVIDER_CREDENTIAL_VAULT_KEY (or the existing AI/provider encryption key) must contain 32 bytes.',
      503,
      'PROVIDER_CREDENTIAL_VAULT_ENCRYPTION_KEY_MISSING',
    );
  }
  return key;
};

const normalizeProvider = (value: unknown): ProviderAccessProvider => {
  if (typeof value !== 'string' || !PROVIDERS.has(value as ProviderAccessProvider)) {
    throw new ProviderCredentialVaultError('Unsupported credential provider.', 400, 'VAULT_PROVIDER_INVALID');
  }
  return value as ProviderAccessProvider;
};

const normalizeVaultKey = (value: unknown): string => {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > 240 || /[\r\n]/.test(key)) {
    throw new ProviderCredentialVaultError('Credential vault key is invalid.', 400, 'VAULT_KEY_INVALID');
  }
  return key;
};

const normalizeUuid = (value: unknown, fieldName: string): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(normalized)) {
    throw new ProviderCredentialVaultError(`${fieldName} must be a valid UUID.`, 400, 'VAULT_UUID_INVALID');
  }
  return normalized;
};

const normalizeSuffixes = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(item => String(item || '').trim().slice(-4)).filter(item => item.length === 4)
    : []
);

export const normalizeProviderCredentialKeys = (
  value: unknown,
  options: { minimumLength?: number; maximumKeys?: number } = {},
): string[] => {
  const candidates = Array.isArray(value)
    ? value.flatMap(item => typeof item === 'string' ? item.split(/[\n,;]+/) : [])
    : typeof value === 'string'
      ? value.split(/[\n,;]+/)
      : [];
  const keys = Array.from(new Set(candidates.map(key => key.trim()).filter(Boolean)));
  const minimumLength = options.minimumLength ?? 8;
  const maximumKeys = options.maximumKeys ?? 20;
  if (keys.length < 1 || keys.length > maximumKeys) {
    throw new ProviderCredentialVaultError(
      `Save between 1 and ${maximumKeys} API keys.`,
      400,
      'VAULT_KEY_COUNT_INVALID',
    );
  }
  if (keys.some(key => key.length < minimumLength || key.length > 512 || /\s/.test(key))) {
    throw new ProviderCredentialVaultError(
      `Each API key must be one non-whitespace value between ${minimumLength} and 512 characters.`,
      400,
      'VAULT_KEY_VALUE_INVALID',
    );
  }
  return keys;
};

export const getProviderCredentialVaultAad = (vaultKeyValue: unknown): string => (
  `bazarvan:${PROVIDER_CREDENTIAL_VAULT_TABLE}:${normalizeVaultKey(vaultKeyValue)}:v${ENCRYPTION_VERSION}`
);

export const encryptProviderCredentialKeys = (
  vaultKeyValue: unknown,
  keysValue: unknown,
): Pick<
  ProviderCredentialVaultRow,
  | 'ciphertext'
  | 'initialization_vector'
  | 'authentication_tag'
  | 'encryption_version'
  | 'encryption_context'
  | 'encryption_key_source'
  | 'payload_format'
> => {
  const vaultKey = normalizeVaultKey(vaultKeyValue);
  const keys = normalizeProviderCredentialKeys(keysValue);
  const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES);
  const encryptionContext = getProviderCredentialVaultAad(vaultKey);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, requireVaultEncryptionKey(), initializationVector);
  cipher.setAAD(Buffer.from(encryptionContext, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(keys), 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    initialization_vector: initializationVector.toString('base64'),
    authentication_tag: cipher.getAuthTag().toString('base64'),
    encryption_version: ENCRYPTION_VERSION,
    encryption_context: encryptionContext,
    encryption_key_source: 'vault',
    payload_format: 'json_list',
  };
};

export const decryptProviderCredentialKeys = (
  row: Pick<
    ProviderCredentialVaultRow,
    | 'vault_key'
    | 'ciphertext'
    | 'initialization_vector'
    | 'authentication_tag'
    | 'encryption_version'
    | 'encryption_context'
    | 'encryption_key_source'
    | 'payload_format'
  >,
): string[] => {
  if (row.encryption_version !== ENCRYPTION_VERSION) {
    throw new ProviderCredentialVaultError(
      'The stored credential uses an unsupported encryption version.',
      503,
      'VAULT_ENCRYPTION_VERSION_UNSUPPORTED',
    );
  }
  if (
    row.encryption_key_source === 'vault'
    && row.encryption_context !== getProviderCredentialVaultAad(row.vault_key)
  ) {
    throw new ProviderCredentialVaultError(
      'The stored credential authentication context does not match its vault identity.',
      503,
      'VAULT_ENCRYPTION_CONTEXT_MISMATCH',
    );
  }
  const candidates = getDecryptionKeyCandidates(row);
  for (const key of candidates) {
    try {
      const decipher = createDecipheriv(
        ENCRYPTION_ALGORITHM,
        key,
        Buffer.from(row.initialization_vector, 'base64'),
      );
      decipher.setAAD(Buffer.from(row.encryption_context, 'utf8'));
      decipher.setAuthTag(Buffer.from(row.authentication_tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const parsed = row.payload_format === 'single' ? [plaintext] : JSON.parse(plaintext);
      return normalizeProviderCredentialKeys(parsed);
    } catch {
      // A legacy row may have been encrypted with a former, provider-specific
      // master key. Try only the finite, documented compatibility candidates.
    }
  }
  throw new ProviderCredentialVaultError(
    'The stored credential could not be decrypted. Verify the provider credential vault key.',
    503,
    'VAULT_DECRYPTION_FAILED',
  );
};

const VAULT_SELECT = [
  'id',
  'vault_key',
  'credential_type',
  'provider',
  'purpose',
  'owner_user_id',
  'label',
  'ciphertext',
  'initialization_vector',
  'authentication_tag',
  'encryption_version',
  'encryption_context',
  'encryption_key_source',
  'payload_format',
  'enabled',
  'key_count',
  'key_suffixes',
  'expires_at',
  'created_by',
  'updated_by',
  'legacy_source_table',
  'legacy_source_key',
  'created_at',
  'updated_at',
].join(',');

export const readProviderCredentialVaultRow = async (
  vaultKeyValue: unknown,
): Promise<ProviderCredentialVaultRow | null> => {
  const vaultKey = normalizeVaultKey(vaultKeyValue);
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(PROVIDER_CREDENTIAL_VAULT_TABLE)
    .select(VAULT_SELECT)
    .eq('vault_key', vaultKey)
    .maybeSingle();
  if (error) throw storageError(error);
  return data ? data as unknown as ProviderCredentialVaultRow : null;
};

export const readProviderCredentialVaultRowById = async (
  idValue: unknown,
): Promise<ProviderCredentialVaultRow | null> => {
  const id = normalizeUuid(idValue, 'credentialId');
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(PROVIDER_CREDENTIAL_VAULT_TABLE)
    .select(VAULT_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw storageError(error);
  return data ? data as unknown as ProviderCredentialVaultRow : null;
};

export const listProviderCredentialVaultRows = async (options: {
  credentialType?: ProviderCredentialVaultType;
  ownerUserId?: string | null;
  provider?: ProviderAccessProvider;
  purpose?: ProviderCredentialVaultPurpose;
} = {}): Promise<ProviderCredentialVaultRow[]> => {
  let query: any = getExternalAnalysisSupabaseAdmin()
    .from(PROVIDER_CREDENTIAL_VAULT_TABLE)
    .select(VAULT_SELECT);
  if (options.credentialType) query = query.eq('credential_type', options.credentialType);
  if (options.ownerUserId !== undefined) {
    query = options.ownerUserId
      ? query.eq('owner_user_id', normalizeUuid(options.ownerUserId, 'ownerUserId'))
      : query.is('owner_user_id', null);
  }
  if (options.provider) query = query.eq('provider', normalizeProvider(options.provider));
  if (options.purpose) query = query.eq('purpose', options.purpose);
  const { data, error } = await query.order('created_at', { ascending: true });
  if (error) throw storageError(error);
  return (data || []) as ProviderCredentialVaultRow[];
};

export const saveProviderCredentialVaultRow = async (options: {
  id?: string | null;
  vaultKey: string;
  credentialType: ProviderCredentialVaultType;
  provider: ProviderAccessProvider;
  purpose?: ProviderCredentialVaultPurpose;
  ownerUserId?: string | null;
  label: string;
  apiKeys?: unknown;
  enabled?: boolean;
  expiresAt?: string | null;
  updatedBy?: string | null;
}): Promise<ProviderCredentialVaultRow> => {
  const vaultKey = normalizeVaultKey(options.vaultKey);
  const provider = normalizeProvider(options.provider);
  const existing = await readProviderCredentialVaultRow(vaultKey);
  const id = options.id
    ? normalizeUuid(options.id, 'credentialId')
    : existing?.id || randomUUID();
  if (existing && options.id && existing.id !== id) {
    throw new ProviderCredentialVaultError('Credential vault identity mismatch.', 409, 'VAULT_ID_CONFLICT');
  }
  const credentialType = options.credentialType;
  const ownerUserId = credentialType === 'personal'
    ? normalizeUuid(options.ownerUserId, 'ownerUserId')
    : null;
  const purpose = options.purpose || 'default';
  const label = String(options.label || existing?.label || '').trim();
  if (!label || label.length > 160) {
    throw new ProviderCredentialVaultError('Credential label is invalid.', 400, 'VAULT_LABEL_INVALID');
  }
  const hasNewKeys = options.apiKeys !== undefined
    && (Array.isArray(options.apiKeys) || String(options.apiKeys || '').trim() !== '');
  if (!existing && !hasNewKeys) {
    throw new ProviderCredentialVaultError('API keys are required.', 400, 'VAULT_KEYS_REQUIRED');
  }
  const keys = hasNewKeys ? normalizeProviderCredentialKeys(options.apiKeys) : null;
  const encrypted = keys ? encryptProviderCredentialKeys(vaultKey, keys) : existing;
  if (!encrypted) {
    throw new ProviderCredentialVaultError('API keys are required.', 400, 'VAULT_KEYS_REQUIRED');
  }
  let expiresAt = existing?.expires_at || null;
  if (options.expiresAt !== undefined) {
    if (options.expiresAt === null || options.expiresAt === '') {
      expiresAt = null;
    } else {
      const parsed = new Date(options.expiresAt);
      if (!Number.isFinite(parsed.getTime())) {
        throw new ProviderCredentialVaultError('Credential expiration is invalid.', 400, 'VAULT_EXPIRY_INVALID');
      }
      expiresAt = parsed.toISOString();
    }
  }
  const actorId = options.updatedBy ? normalizeUuid(options.updatedBy, 'updatedBy') : null;
  const now = new Date().toISOString();
  const payload = {
    id,
    vault_key: vaultKey,
    credential_type: credentialType,
    provider,
    purpose,
    owner_user_id: ownerUserId,
    label,
    ciphertext: encrypted.ciphertext,
    initialization_vector: encrypted.initialization_vector,
    authentication_tag: encrypted.authentication_tag,
    encryption_version: encrypted.encryption_version,
    encryption_context: encrypted.encryption_context,
    encryption_key_source: encrypted.encryption_key_source,
    payload_format: encrypted.payload_format,
    enabled: options.enabled ?? existing?.enabled ?? true,
    key_count: keys?.length ?? existing?.key_count,
    key_suffixes: keys?.map(key => key.slice(-4)) ?? existing?.key_suffixes,
    expires_at: expiresAt,
    created_by: existing?.created_by || actorId,
    updated_by: actorId,
    legacy_source_table: existing?.legacy_source_table || null,
    legacy_source_key: existing?.legacy_source_key || null,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(PROVIDER_CREDENTIAL_VAULT_TABLE)
    .upsert(payload, { onConflict: 'vault_key' })
    .select(VAULT_SELECT)
    .single();
  if (error) throw storageError(error);
  return data as unknown as ProviderCredentialVaultRow;
};

export const deleteProviderCredentialVaultRow = async (
  vaultKeyValue: unknown,
): Promise<void> => {
  const vaultKey = normalizeVaultKey(vaultKeyValue);
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(PROVIDER_CREDENTIAL_VAULT_TABLE)
    .delete()
    .eq('vault_key', vaultKey);
  if (error) throw storageError(error);
};

export const toProviderCredentialVaultMetadata = (
  row: ProviderCredentialVaultRow,
): ProviderCredentialVaultMetadata => ({
  id: row.id,
  vaultKey: row.vault_key,
  credentialType: row.credential_type,
  provider: normalizeProvider(row.provider),
  purpose: row.purpose,
  ownerUserId: row.owner_user_id || null,
  label: row.label,
  enabled: row.enabled === true,
  keyCount: Math.max(0, Number(row.key_count) || 0),
  keySuffixes: normalizeSuffixes(row.key_suffixes),
  expiresAt: row.expires_at || null,
  createdBy: row.created_by || null,
  updatedBy: row.updated_by || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const __providerCredentialVaultTestUtils = {
  parseEncryptionKeyValue,
  normalizeProviderCredentialKeys,
  encryptProviderCredentialKeys,
  decryptProviderCredentialKeys,
};
