import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  DEFAULT_PROVIDER_CREDENTIAL_MODE,
  PROVIDER_ACCESS_MIGRATION,
  PROVIDER_ACCESS_PROVIDERS,
  isProviderAccessProvider,
  isProviderCredentialMode,
  type ProviderAccessProvider,
  type ProviderCredentialMode,
} from '../constants/providerAccessControl.ts';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';

export type ProviderCredentialSource =
  | 'user'
  | 'assigned_user'
  | 'assigned_all'
  | 'resume'
  | 'admin'
  | 'hostinger';

export type ProviderCredentialTier = {
  source: ProviderCredentialSource;
  keys: string[];
  credentialId?: string;
};

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

export type AdminProviderAccessOverview = {
  schemaAvailable: boolean;
  encryptionConfigured: boolean;
  globalPolicies: Record<ProviderAccessProvider, EffectiveProviderPolicy>;
  userPolicies: Partial<Record<ProviderAccessProvider, ProviderPolicyPatch>>;
  effectivePolicies: Record<ProviderAccessProvider, EffectiveProviderPolicy>;
  credentials: SharedProviderCredentialMetadata[];
  grants: ProviderCredentialGrantMetadata[];
  usage: Record<ProviderAccessProvider, ProviderUsageSummary>;
};

export type UserProviderAccessOverview = {
  schemaAvailable: boolean;
  policies: Record<ProviderAccessProvider, EffectiveProviderPolicy>;
  assignedCredentials: Array<SharedProviderCredentialMetadata & {
    scope: 'all' | 'user';
    priority: number;
  }>;
  usage: Record<ProviderAccessProvider, ProviderUsageSummary>;
};

type GlobalPolicyRow = {
  provider: string;
  enabled: boolean;
  allow_personal_keys: boolean;
  credential_mode: string;
  allow_shared_fallback: boolean;
  allow_provider_fallback: boolean;
  default_model: string | null;
  allowed_models: unknown;
  daily_request_limit: number | null;
  monthly_request_limit: number | null;
};

type UserPolicyRow = {
  user_id: string;
  provider: string;
  enabled_override: boolean | null;
  allow_personal_keys_override: boolean | null;
  credential_mode_override: string | null;
  allow_shared_fallback_override: boolean | null;
  allow_provider_fallback_override: boolean | null;
  default_model_override: string | null;
  allowed_models_override: unknown;
  daily_request_limit_override: number | null;
  monthly_request_limit_override: number | null;
};

type SharedCredentialRow = {
  id: string;
  provider: string;
  label: string;
  ciphertext: string;
  initialization_vector: string;
  authentication_tag: string;
  encryption_version: number;
  enabled: boolean;
  key_count: number;
  key_suffixes: unknown;
  expires_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type GrantRow = {
  id: string;
  credential_id: string;
  scope: string;
  user_id: string | null;
  priority: number;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const GLOBAL_POLICY_TABLE = 'provider_global_policies';
const USER_POLICY_TABLE = 'user_provider_policies';
const CREDENTIAL_TABLE = 'provider_shared_credentials';
const GRANT_TABLE = 'provider_credential_grants';
const USAGE_TABLE = 'provider_request_usage';
const AUDIT_TABLE = 'provider_security_audit_events';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_VERSION = 1;
const ENCRYPTION_KEY_BYTES = 32;
const IV_BYTES = 12;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProviderAccessError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'PROVIDER_ACCESS_ERROR') {
    super(message);
    this.name = 'ProviderAccessError';
    this.status = status;
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isMissingSchemaError = (error: { code?: string; message?: string } | null | undefined): boolean => (
  ['42P01', 'PGRST205', 'PGRST202', '42883'].includes(String(error?.code || ''))
  || /does not exist|schema cache/i.test(String(error?.message || ''))
);

const storageError = (error: { code?: string; message?: string }): ProviderAccessError => (
  isMissingSchemaError(error)
    ? new ProviderAccessError(
        `Apply migration ${PROVIDER_ACCESS_MIGRATION} before managing provider access.`,
        503,
        'PROVIDER_ACCESS_SCHEMA_MISSING',
      )
    : new ProviderAccessError(
        `Could not access provider permissions (${error.code || 'unknown'}).`,
        503,
        'PROVIDER_ACCESS_STORAGE_UNAVAILABLE',
      )
);

const normalizeProvider = (value: unknown): ProviderAccessProvider => {
  if (!isProviderAccessProvider(value)) {
    throw new ProviderAccessError('Unsupported provider.', 400, 'PROVIDER_INVALID');
  }
  return value;
};

const normalizeUuid = (value: unknown, fieldName: string): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(normalized)) {
    throw new ProviderAccessError(`${fieldName} must be a valid UUID.`, 400, 'UUID_INVALID');
  }
  return normalized;
};

const normalizeLabel = (value: unknown): string => {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > 120) {
    throw new ProviderAccessError(
      'Credential label must be between 1 and 120 characters.',
      400,
      'CREDENTIAL_LABEL_INVALID',
    );
  }
  return label;
};

const normalizeModel = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const model = typeof value === 'string' ? value.trim() : '';
  if (!model || model.length > 200 || /[\r\n]/.test(model)) {
    throw new ProviderAccessError('Model id is invalid.', 400, 'PROVIDER_MODEL_INVALID');
  }
  return model;
};

const normalizeModels = (value: unknown): string[] => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ProviderAccessError('allowedModels must be an array.', 400, 'ALLOWED_MODELS_INVALID');
  }
  const models = Array.from(new Set(value.map(normalizeModel).filter((item): item is string => Boolean(item))));
  if (models.length > 100) {
    throw new ProviderAccessError('At most 100 allowed models can be configured.', 400, 'ALLOWED_MODELS_INVALID');
  }
  return models;
};

const normalizeLimit = (value: unknown, maximum: number): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new ProviderAccessError(`Request limit must be between 1 and ${maximum}.`, 400, 'REQUEST_LIMIT_INVALID');
  }
  return limit;
};

const normalizeKeyList = (value: unknown): string[] => {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,;]+/)
      : [];
  const keys = Array.from(new Set(candidates.map(item => String(item || '').trim()).filter(Boolean)));
  if (keys.length < 1 || keys.length > 20) {
    throw new ProviderAccessError('Save between 1 and 20 API keys.', 400, 'CREDENTIAL_KEYS_INVALID');
  }
  if (keys.some(key => key.length < 8 || key.length > 512 || /\s/.test(key))) {
    throw new ProviderAccessError(
      'Each API key must be one non-whitespace value between 8 and 512 characters.',
      400,
      'CREDENTIAL_KEY_INVALID',
    );
  }
  return keys;
};

const toStringArray = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : []
);

const parseEncryptionKey = (): Buffer | null => {
  const raw = String(
    process.env.PROVIDER_ACCESS_ENCRYPTION_KEY
    || process.env.AI_SETTINGS_ENCRYPTION_KEY
    || process.env.CRAWLER_SETTINGS_ENCRYPTION_KEY
    || '',
  ).trim();
  if (!raw) return null;
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const base64 = raw.startsWith('base64:') ? raw.slice('base64:'.length) : raw;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const decoded = Buffer.from(base64, 'base64');
  return decoded.length === ENCRYPTION_KEY_BYTES ? decoded : null;
};

const requireEncryptionKey = (): Buffer => {
  const key = parseEncryptionKey();
  if (!key) {
    throw new ProviderAccessError(
      'PROVIDER_ACCESS_ENCRYPTION_KEY or AI_SETTINGS_ENCRYPTION_KEY must contain a 32-byte encryption key.',
      503,
      'PROVIDER_ACCESS_ENCRYPTION_KEY_MISSING',
    );
  }
  return key;
};

const credentialAad = (id: string, provider: ProviderAccessProvider): Buffer => (
  Buffer.from(`bazarvan:${CREDENTIAL_TABLE}:${id}:${provider}:v${ENCRYPTION_VERSION}`, 'utf8')
);

const encryptKeys = (id: string, provider: ProviderAccessProvider, keys: string[]) => {
  const initializationVector = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, requireEncryptionKey(), initializationVector);
  cipher.setAAD(credentialAad(id, provider));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(keys), 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    initialization_vector: initializationVector.toString('base64'),
    authentication_tag: cipher.getAuthTag().toString('base64'),
    encryption_version: ENCRYPTION_VERSION,
  };
};

const decryptKeys = (row: SharedCredentialRow): string[] => {
  const provider = normalizeProvider(row.provider);
  if (row.encryption_version !== ENCRYPTION_VERSION) {
    throw new ProviderAccessError(
      'The assigned credential uses an unsupported encryption version.',
      503,
      'CREDENTIAL_ENCRYPTION_VERSION_UNSUPPORTED',
    );
  }
  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      requireEncryptionKey(),
      Buffer.from(row.initialization_vector, 'base64'),
    );
    decipher.setAAD(credentialAad(row.id, provider));
    decipher.setAuthTag(Buffer.from(row.authentication_tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return normalizeKeyList(JSON.parse(plaintext));
  } catch (error) {
    if (error instanceof ProviderAccessError) throw error;
    throw new ProviderAccessError(
      'The assigned credential could not be decrypted. Verify the server encryption key.',
      503,
      'CREDENTIAL_DECRYPTION_FAILED',
    );
  }
};

const defaultPolicy = (provider: ProviderAccessProvider): EffectiveProviderPolicy => ({
  provider,
  enabled: true,
  allowPersonalKeys: true,
  credentialMode: DEFAULT_PROVIDER_CREDENTIAL_MODE,
  allowSharedFallback: true,
  allowProviderFallback: true,
  defaultModel: null,
  allowedModels: [],
  dailyRequestLimit: null,
  monthlyRequestLimit: null,
  customizedForUser: false,
});

const toGlobalPolicy = (
  provider: ProviderAccessProvider,
  row?: GlobalPolicyRow,
): EffectiveProviderPolicy => {
  if (!row) return defaultPolicy(provider);
  return {
    provider,
    enabled: row.enabled !== false,
    allowPersonalKeys: row.allow_personal_keys !== false,
    credentialMode: isProviderCredentialMode(row.credential_mode)
      ? row.credential_mode
      : DEFAULT_PROVIDER_CREDENTIAL_MODE,
    allowSharedFallback: row.allow_shared_fallback !== false,
    allowProviderFallback: row.allow_provider_fallback !== false,
    defaultModel: normalizeModel(row.default_model),
    allowedModels: normalizeModels(row.allowed_models),
    dailyRequestLimit: normalizeLimit(row.daily_request_limit, 1_000_000),
    monthlyRequestLimit: normalizeLimit(row.monthly_request_limit, 10_000_000),
    customizedForUser: false,
  };
};

const userPatchFromRow = (row: UserPolicyRow): ProviderPolicyPatch => ({
  enabled: row.enabled_override,
  allowPersonalKeys: row.allow_personal_keys_override,
  credentialMode: isProviderCredentialMode(row.credential_mode_override)
    ? row.credential_mode_override
    : null,
  allowSharedFallback: row.allow_shared_fallback_override,
  allowProviderFallback: row.allow_provider_fallback_override,
  defaultModel: row.default_model_override,
  allowedModels: row.allowed_models_override === null ? null : normalizeModels(row.allowed_models_override),
  dailyRequestLimit: row.daily_request_limit_override,
  monthlyRequestLimit: row.monthly_request_limit_override,
});

const mergePolicy = (
  globalPolicy: EffectiveProviderPolicy,
  row?: UserPolicyRow,
): EffectiveProviderPolicy => {
  if (!row) return globalPolicy;
  const patch = userPatchFromRow(row);
  const dailyOverride = patch.dailyRequestLimit ?? null;
  const monthlyOverride = patch.monthlyRequestLimit ?? null;
  // A user override may make a quota stricter, but never looser than a global ceiling.
  const effectiveLimit = (globalLimit: number | null, override: number | null): number | null => {
    if (override === null) return globalLimit;
    return globalLimit === null ? override : Math.min(globalLimit, override);
  };
  const globalModels = globalPolicy.allowedModels;
  const overrideModels = patch.allowedModels;
  const effectiveModels = overrideModels === null
      || overrideModels === undefined
      || overrideModels.length === 0
    ? globalModels
    : globalModels.length === 0
      ? overrideModels
      : overrideModels.filter(model => globalModels.includes(model));
  return {
    provider: globalPolicy.provider,
    // Explicit global denial is an emergency ceiling and cannot be overridden.
    enabled: globalPolicy.enabled && patch.enabled !== false,
    allowPersonalKeys: globalPolicy.allowPersonalKeys && patch.allowPersonalKeys !== false,
    credentialMode: globalPolicy.credentialMode === 'disabled'
      ? 'disabled'
      : patch.credentialMode || globalPolicy.credentialMode,
    allowSharedFallback: globalPolicy.allowSharedFallback && patch.allowSharedFallback !== false,
    allowProviderFallback: globalPolicy.allowProviderFallback && patch.allowProviderFallback !== false,
    defaultModel: patch.defaultModel || globalPolicy.defaultModel,
    allowedModels: effectiveModels,
    dailyRequestLimit: effectiveLimit(globalPolicy.dailyRequestLimit, dailyOverride),
    monthlyRequestLimit: effectiveLimit(globalPolicy.monthlyRequestLimit, monthlyOverride),
    customizedForUser: true,
  };
};

const toCredentialMetadata = (row: SharedCredentialRow): SharedProviderCredentialMetadata => ({
  id: row.id,
  provider: normalizeProvider(row.provider),
  label: row.label,
  enabled: row.enabled === true,
  keyCount: Number(row.key_count) || 0,
  keySuffixes: toStringArray(row.key_suffixes),
  expiresAt: row.expires_at || null,
  createdBy: row.created_by || null,
  updatedBy: row.updated_by || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toGrantMetadata = (row: GrantRow): ProviderCredentialGrantMetadata => ({
  id: row.id,
  credentialId: row.credential_id,
  scope: row.scope === 'user' ? 'user' : 'all',
  userId: row.user_id || null,
  priority: Number(row.priority) || 100,
  enabled: row.enabled === true,
  createdBy: row.created_by || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const emptyUsage = (): Record<ProviderAccessProvider, ProviderUsageSummary> => (
  Object.fromEntries(PROVIDER_ACCESS_PROVIDERS.map(provider => [
    provider,
    { dailyUsed: 0, monthlyUsed: 0 },
  ])) as Record<ProviderAccessProvider, ProviderUsageSummary>
);

const readGlobalPolicyRows = async (): Promise<{ rows: GlobalPolicyRow[]; schemaAvailable: boolean }> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(GLOBAL_POLICY_TABLE)
    .select('provider,enabled,allow_personal_keys,credential_mode,allow_shared_fallback,allow_provider_fallback,default_model,allowed_models,daily_request_limit,monthly_request_limit');
  if (error) {
    if (isMissingSchemaError(error)) return { rows: [], schemaAvailable: false };
    throw storageError(error);
  }
  return { rows: (data || []) as GlobalPolicyRow[], schemaAvailable: true };
};

const readUserPolicyRows = async (userId?: string): Promise<UserPolicyRow[]> => {
  if (!userId) return [];
  const normalizedUserId = normalizeUuid(userId, 'userId');
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(USER_POLICY_TABLE)
    .select('user_id,provider,enabled_override,allow_personal_keys_override,credential_mode_override,allow_shared_fallback_override,allow_provider_fallback_override,default_model_override,allowed_models_override,daily_request_limit_override,monthly_request_limit_override')
    .eq('user_id', normalizedUserId);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw storageError(error);
  }
  return (data || []) as UserPolicyRow[];
};

const readCredentialRows = async (): Promise<SharedCredentialRow[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(CREDENTIAL_TABLE)
    .select('id,provider,label,ciphertext,initialization_vector,authentication_tag,encryption_version,enabled,key_count,key_suffixes,expires_at,created_by,updated_by,created_at,updated_at');
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw storageError(error);
  }
  return (data || []) as SharedCredentialRow[];
};

const readGrantRows = async (): Promise<GrantRow[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(GRANT_TABLE)
    .select('id,credential_id,scope,user_id,priority,enabled,created_by,created_at,updated_at')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw storageError(error);
  }
  return (data || []) as GrantRow[];
};

const getIstanbulBoundary = (kind: 'day' | 'month'): Date => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map(part => [part.type, part.value]));
  const month = Number(parts.month) - 1;
  const day = kind === 'month' ? 1 : Number(parts.day);
  return new Date(Date.UTC(Number(parts.year), month, day, -3, 0, 0, 0));
};

const readUsage = async (userId?: string): Promise<Record<ProviderAccessProvider, ProviderUsageSummary>> => {
  const result = emptyUsage();
  if (!userId) return result;
  const normalizedUserId = normalizeUuid(userId, 'userId');
  const dayStart = getIstanbulBoundary('day');
  const monthStart = getIstanbulBoundary('month');
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(USAGE_TABLE)
    .select('provider,created_at')
    .eq('user_id', normalizedUserId)
    .gte('created_at', monthStart.toISOString())
    .limit(100000);
  if (error) {
    if (isMissingSchemaError(error)) return result;
    throw storageError(error);
  }
  (data || []).forEach(row => {
    if (!isProviderAccessProvider(row.provider)) return;
    result[row.provider].monthlyUsed += 1;
    if (new Date(row.created_at).getTime() >= dayStart.getTime()) {
      result[row.provider].dailyUsed += 1;
    }
  });
  return result;
};

const buildPolicyMaps = (globalRows: GlobalPolicyRow[], userRows: UserPolicyRow[]) => {
  const globalPolicies = Object.fromEntries(PROVIDER_ACCESS_PROVIDERS.map(provider => {
    const row = globalRows.find(item => item.provider === provider);
    return [provider, toGlobalPolicy(provider, row)];
  })) as Record<ProviderAccessProvider, EffectiveProviderPolicy>;
  const effectivePolicies = Object.fromEntries(PROVIDER_ACCESS_PROVIDERS.map(provider => {
    const userRow = userRows.find(item => item.provider === provider);
    return [provider, mergePolicy(globalPolicies[provider], userRow)];
  })) as Record<ProviderAccessProvider, EffectiveProviderPolicy>;
  const userPolicies = Object.fromEntries(userRows
    .filter(row => isProviderAccessProvider(row.provider))
    .map(row => [row.provider, userPatchFromRow(row)])) as Partial<Record<ProviderAccessProvider, ProviderPolicyPatch>>;
  return { globalPolicies, effectivePolicies, userPolicies };
};

export const readAdminProviderAccessOverview = async (
  userId?: string,
): Promise<AdminProviderAccessOverview> => {
  const normalizedUserId = userId ? normalizeUuid(userId, 'userId') : undefined;
  const [globalResult, userRows, credentialRows, grantRows, usage] = await Promise.all([
    readGlobalPolicyRows(),
    readUserPolicyRows(normalizedUserId),
    readCredentialRows(),
    readGrantRows(),
    readUsage(normalizedUserId),
  ]);
  const maps = buildPolicyMaps(globalResult.rows, userRows);
  return {
    schemaAvailable: globalResult.schemaAvailable,
    encryptionConfigured: parseEncryptionKey() !== null,
    ...maps,
    credentials: credentialRows.map(toCredentialMetadata),
    grants: grantRows.map(toGrantMetadata),
    usage,
  };
};

export const readUserProviderAccessOverview = async (
  userIdValue: unknown,
): Promise<UserProviderAccessOverview> => {
  const userId = normalizeUuid(userIdValue, 'userId');
  const overview = await readAdminProviderAccessOverview(userId);
  const credentialById = new Map(overview.credentials.map(item => [item.id, item]));
  const assignedCredentials = overview.grants
    .filter(grant => grant.enabled && (grant.scope === 'all' || grant.userId === userId))
    .map(grant => {
      const credential = credentialById.get(grant.credentialId);
      return credential ? { ...credential, scope: grant.scope, priority: grant.priority } : null;
    })
    .filter((item): item is SharedProviderCredentialMetadata & { scope: 'all' | 'user'; priority: number } => Boolean(item));
  return {
    schemaAvailable: overview.schemaAvailable,
    policies: overview.effectivePolicies,
    assignedCredentials,
    usage: overview.usage,
  };
};

export const resolveEffectiveProviderPolicy = async (
  userIdValue: string | null | undefined,
  providerValue: unknown,
): Promise<EffectiveProviderPolicy> => {
  const provider = normalizeProvider(providerValue);
  const userId = userIdValue ? normalizeUuid(userIdValue, 'userId') : undefined;
  const [globalResult, userRows] = await Promise.all([
    readGlobalPolicyRows(),
    readUserPolicyRows(userId),
  ]);
  const globalRow = globalResult.rows.find(row => row.provider === provider);
  const userRow = userRows.find(row => row.provider === provider);
  return mergePolicy(toGlobalPolicy(provider, globalRow), userRow);
};

const recordAudit = async (options: {
  actorUserId: string;
  targetUserId?: string | null;
  provider?: ProviderAccessProvider | null;
  action: string;
  subjectId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> => {
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(AUDIT_TABLE)
    .insert({
      actor_user_id: normalizeUuid(options.actorUserId, 'actorUserId'),
      target_user_id: options.targetUserId ? normalizeUuid(options.targetUserId, 'targetUserId') : null,
      provider: options.provider || null,
      action: options.action.slice(0, 120),
      subject_id: options.subjectId || null,
      metadata: options.metadata || {},
    });
  if (error && !isMissingSchemaError(error)) throw storageError(error);
};

export const saveProviderAccessPolicy = async (options: {
  scope: 'global' | 'user';
  userId?: string | null;
  provider: ProviderAccessProvider;
  patch: ProviderPolicyPatch;
  updatedBy: string;
}): Promise<void> => {
  const provider = normalizeProvider(options.provider);
  const actorId = normalizeUuid(options.updatedBy, 'updatedBy');
  const userId = options.scope === 'user'
    ? normalizeUuid(options.userId, 'userId')
    : null;
  const patch = options.patch || {};
  if (patch.credentialMode !== undefined && patch.credentialMode !== null
      && !isProviderCredentialMode(patch.credentialMode)) {
    throw new ProviderAccessError('Unsupported credential mode.', 400, 'CREDENTIAL_MODE_INVALID');
  }

  const now = new Date().toISOString();
  if (options.scope === 'global') {
    const { data: existing, error: readError } = await getExternalAnalysisSupabaseAdmin()
      .from(GLOBAL_POLICY_TABLE)
      .select('*')
      .eq('provider', provider)
      .maybeSingle();
    if (readError) throw storageError(readError);
    const current = toGlobalPolicy(provider, existing as GlobalPolicyRow | undefined);
    const payload = {
      provider,
      enabled: patch.enabled ?? current.enabled,
      allow_personal_keys: patch.allowPersonalKeys ?? current.allowPersonalKeys,
      credential_mode: patch.credentialMode ?? current.credentialMode,
      allow_shared_fallback: patch.allowSharedFallback ?? current.allowSharedFallback,
      allow_provider_fallback: patch.allowProviderFallback ?? current.allowProviderFallback,
      default_model: patch.defaultModel === undefined ? current.defaultModel : normalizeModel(patch.defaultModel),
      allowed_models: patch.allowedModels === undefined ? current.allowedModels : normalizeModels(patch.allowedModels),
      daily_request_limit: patch.dailyRequestLimit === undefined
        ? current.dailyRequestLimit
        : normalizeLimit(patch.dailyRequestLimit, 1_000_000),
      monthly_request_limit: patch.monthlyRequestLimit === undefined
        ? current.monthlyRequestLimit
        : normalizeLimit(patch.monthlyRequestLimit, 10_000_000),
      updated_by: actorId,
      updated_at: now,
    };
    const { error } = await getExternalAnalysisSupabaseAdmin()
      .from(GLOBAL_POLICY_TABLE)
      .upsert(payload, { onConflict: 'provider' });
    if (error) throw storageError(error);
  } else {
    const { data: existing, error: readError } = await getExternalAnalysisSupabaseAdmin()
      .from(USER_POLICY_TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('provider', provider)
      .maybeSingle();
    if (readError) throw storageError(readError);
    const current = existing ? userPatchFromRow(existing as UserPolicyRow) : {};
    const pick = <T>(next: T | undefined, previous: T | undefined): T | null => (
      next === undefined ? previous ?? null : next ?? null
    );
    const payload = {
      user_id: userId,
      provider,
      enabled_override: pick(patch.enabled, current.enabled),
      allow_personal_keys_override: pick(patch.allowPersonalKeys, current.allowPersonalKeys),
      credential_mode_override: pick(patch.credentialMode, current.credentialMode),
      allow_shared_fallback_override: pick(patch.allowSharedFallback, current.allowSharedFallback),
      allow_provider_fallback_override: pick(patch.allowProviderFallback, current.allowProviderFallback),
      default_model_override: patch.defaultModel === undefined
        ? current.defaultModel ?? null
        : normalizeModel(patch.defaultModel),
      allowed_models_override: patch.allowedModels === undefined
        ? current.allowedModels ?? null
        : patch.allowedModels === null ? null : normalizeModels(patch.allowedModels),
      daily_request_limit_override: patch.dailyRequestLimit === undefined
        ? current.dailyRequestLimit ?? null
        : normalizeLimit(patch.dailyRequestLimit, 1_000_000),
      monthly_request_limit_override: patch.monthlyRequestLimit === undefined
        ? current.monthlyRequestLimit ?? null
        : normalizeLimit(patch.monthlyRequestLimit, 10_000_000),
      updated_by: actorId,
      updated_at: now,
    };
    const { error } = await getExternalAnalysisSupabaseAdmin()
      .from(USER_POLICY_TABLE)
      .upsert(payload, { onConflict: 'user_id,provider' });
    if (error) throw storageError(error);
  }

  await recordAudit({
    actorUserId: actorId,
    targetUserId: userId,
    provider,
    action: options.scope === 'global' ? 'global_policy_updated' : 'user_policy_updated',
    metadata: { fields: Object.keys(patch) },
  });
};

const readCredentialById = async (idValue: unknown): Promise<SharedCredentialRow | null> => {
  const id = normalizeUuid(idValue, 'credentialId');
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(CREDENTIAL_TABLE)
    .select('id,provider,label,ciphertext,initialization_vector,authentication_tag,encryption_version,enabled,key_count,key_suffixes,expires_at,created_by,updated_by,created_at,updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw storageError(error);
  return data ? data as SharedCredentialRow : null;
};

export const saveSharedProviderCredential = async (options: {
  id?: string | null;
  provider: ProviderAccessProvider;
  label: string;
  apiKeys?: unknown;
  enabled?: boolean;
  expiresAt?: string | null;
  updatedBy: string;
}): Promise<SharedProviderCredentialMetadata> => {
  const provider = normalizeProvider(options.provider);
  const actorId = normalizeUuid(options.updatedBy, 'updatedBy');
  const id = options.id ? normalizeUuid(options.id, 'credentialId') : randomUUID();
  const existing = options.id ? await readCredentialById(id) : null;
  if (options.id && !existing) {
    throw new ProviderAccessError('Assigned credential was not found.', 404, 'CREDENTIAL_NOT_FOUND');
  }
  if (existing && existing.provider !== provider) {
    throw new ProviderAccessError('A credential provider cannot be changed.', 409, 'CREDENTIAL_PROVIDER_IMMUTABLE');
  }
  const hasNewKeys = options.apiKeys !== undefined && String(options.apiKeys || '').trim() !== '';
  if (!existing && !hasNewKeys) {
    throw new ProviderAccessError('API keys are required for a new credential.', 400, 'CREDENTIAL_KEYS_REQUIRED');
  }
  const keys = hasNewKeys ? normalizeKeyList(options.apiKeys) : null;
  const encrypted = keys ? encryptKeys(id, provider, keys) : existing;
  if (!encrypted) {
    throw new ProviderAccessError('API keys are required.', 400, 'CREDENTIAL_KEYS_REQUIRED');
  }
  let expiresAt: string | null = existing?.expires_at || null;
  if (options.expiresAt !== undefined) {
    if (options.expiresAt === null || options.expiresAt === '') {
      expiresAt = null;
    } else {
      const parsed = new Date(options.expiresAt);
      if (!Number.isFinite(parsed.getTime())) {
        throw new ProviderAccessError('Credential expiration date is invalid.', 400, 'CREDENTIAL_EXPIRY_INVALID');
      }
      expiresAt = parsed.toISOString();
    }
  }
  const now = new Date().toISOString();
  const payload = {
    id,
    provider,
    label: normalizeLabel(options.label || existing?.label),
    ciphertext: encrypted.ciphertext,
    initialization_vector: encrypted.initialization_vector,
    authentication_tag: encrypted.authentication_tag,
    encryption_version: encrypted.encryption_version,
    enabled: options.enabled ?? existing?.enabled ?? true,
    key_count: keys?.length ?? existing?.key_count,
    key_suffixes: keys?.map(key => key.slice(-4)) ?? existing?.key_suffixes,
    expires_at: expiresAt,
    created_by: existing?.created_by || actorId,
    updated_by: actorId,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(CREDENTIAL_TABLE)
    .upsert(payload, { onConflict: 'id' })
    .select('id,provider,label,ciphertext,initialization_vector,authentication_tag,encryption_version,enabled,key_count,key_suffixes,expires_at,created_by,updated_by,created_at,updated_at')
    .single();
  if (error) throw storageError(error);
  await recordAudit({
    actorUserId: actorId,
    provider,
    action: existing ? 'shared_credential_updated' : 'shared_credential_created',
    subjectId: id,
    metadata: {
      label: payload.label,
      keyCount: payload.key_count,
      keySuffixes: payload.key_suffixes,
      enabled: payload.enabled,
    },
  });
  return toCredentialMetadata(data as SharedCredentialRow);
};

export const deleteSharedProviderCredential = async (
  idValue: unknown,
  actorIdValue: unknown,
): Promise<void> => {
  const id = normalizeUuid(idValue, 'credentialId');
  const actorId = normalizeUuid(actorIdValue, 'actorUserId');
  const existing = await readCredentialById(id);
  if (!existing) return;
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(CREDENTIAL_TABLE)
    .delete()
    .eq('id', id);
  if (error) throw storageError(error);
  await recordAudit({
    actorUserId: actorId,
    provider: normalizeProvider(existing.provider),
    action: 'shared_credential_deleted',
    subjectId: id,
    metadata: { label: existing.label, keySuffixes: toStringArray(existing.key_suffixes) },
  });
};

export const saveCredentialGrant = async (options: {
  id?: string | null;
  credentialId: string;
  scope: 'all' | 'user';
  userId?: string | null;
  priority?: number;
  enabled?: boolean;
  actorId: string;
}): Promise<ProviderCredentialGrantMetadata> => {
  const actorId = normalizeUuid(options.actorId, 'actorUserId');
  const credentialId = normalizeUuid(options.credentialId, 'credentialId');
  const credential = await readCredentialById(credentialId);
  if (!credential) {
    throw new ProviderAccessError('Assigned credential was not found.', 404, 'CREDENTIAL_NOT_FOUND');
  }
  const scope = options.scope === 'user' ? 'user' : options.scope === 'all' ? 'all' : null;
  if (!scope) throw new ProviderAccessError('Grant scope must be all or user.', 400, 'GRANT_SCOPE_INVALID');
  const userId = scope === 'user' ? normalizeUuid(options.userId, 'userId') : null;
  const priority = options.priority === undefined ? 100 : Number(options.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 10000) {
    throw new ProviderAccessError('Grant priority must be between 0 and 10000.', 400, 'GRANT_PRIORITY_INVALID');
  }
  let existing: GrantRow | null = null;
  if (options.id) {
    const id = normalizeUuid(options.id, 'grantId');
    const { data, error } = await getExternalAnalysisSupabaseAdmin()
      .from(GRANT_TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw storageError(error);
    existing = data as GrantRow | null;
  } else {
    let query = getExternalAnalysisSupabaseAdmin()
      .from(GRANT_TABLE)
      .select('*')
      .eq('credential_id', credentialId)
      .eq('scope', scope);
    query = userId ? query.eq('user_id', userId) : query.is('user_id', null);
    const { data, error } = await query.maybeSingle();
    if (error) throw storageError(error);
    existing = data as GrantRow | null;
  }
  const id = existing?.id || randomUUID();
  const now = new Date().toISOString();
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(GRANT_TABLE)
    .upsert({
      id,
      credential_id: credentialId,
      scope,
      user_id: userId,
      priority,
      enabled: options.enabled ?? existing?.enabled ?? true,
      created_by: existing?.created_by || actorId,
      created_at: existing?.created_at || now,
      updated_at: now,
    }, { onConflict: 'id' })
    .select('id,credential_id,scope,user_id,priority,enabled,created_by,created_at,updated_at')
    .single();
  if (error) throw storageError(error);
  await recordAudit({
    actorUserId: actorId,
    targetUserId: userId,
    provider: normalizeProvider(credential.provider),
    action: existing ? 'credential_grant_updated' : 'credential_grant_created',
    subjectId: id,
    metadata: { credentialId, scope, priority, enabled: options.enabled ?? true },
  });
  return toGrantMetadata(data as GrantRow);
};

export const deleteCredentialGrant = async (
  idValue: unknown,
  actorIdValue: unknown,
): Promise<void> => {
  const id = normalizeUuid(idValue, 'grantId');
  const actorId = normalizeUuid(actorIdValue, 'actorUserId');
  const { data, error: readError } = await getExternalAnalysisSupabaseAdmin()
    .from(GRANT_TABLE)
    .select('id,credential_id,scope,user_id,priority,enabled,created_by,created_at,updated_at')
    .eq('id', id)
    .maybeSingle();
  if (readError) throw storageError(readError);
  if (!data) return;
  const credential = await readCredentialById(data.credential_id);
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from(GRANT_TABLE)
    .delete()
    .eq('id', id);
  if (error) throw storageError(error);
  await recordAudit({
    actorUserId: actorId,
    targetUserId: data.user_id,
    provider: credential ? normalizeProvider(credential.provider) : null,
    action: 'credential_grant_deleted',
    subjectId: id,
    metadata: { credentialId: data.credential_id, scope: data.scope },
  });
};

export const resolveAssignedProviderKeys = async (
  userIdValue: string | null | undefined,
  providerValue: unknown,
): Promise<{ user: ProviderCredentialTier[]; all: ProviderCredentialTier[] }> => {
  const provider = normalizeProvider(providerValue);
  const userId = userIdValue ? normalizeUuid(userIdValue, 'userId') : null;
  const [credentialRows, grantRows] = await Promise.all([readCredentialRows(), readGrantRows()]);
  const credentialById = new Map(credentialRows.map(row => [row.id, row]));
  const now = Date.now();
  const result: { user: ProviderCredentialTier[]; all: ProviderCredentialTier[] } = { user: [], all: [] };
  grantRows
    .filter(grant => grant.enabled && (
      grant.scope === 'all'
      || (userId && grant.scope === 'user' && grant.user_id === userId)
    ))
    .forEach(grant => {
      const credential = credentialById.get(grant.credential_id);
      if (!credential || credential.provider !== provider || !credential.enabled) return;
      if (credential.expires_at && new Date(credential.expires_at).getTime() <= now) return;
      const tier: ProviderCredentialTier = {
        source: grant.scope === 'user' ? 'assigned_user' : 'assigned_all',
        keys: decryptKeys(credential),
        credentialId: credential.id,
      };
      result[grant.scope === 'user' ? 'user' : 'all'].push(tier);
    });
  return result;
};

const uniqueTiers = (tiers: ProviderCredentialTier[]): ProviderCredentialTier[] => {
  const seen = new Set<string>();
  return tiers.map(tier => ({
    ...tier,
    keys: tier.keys.map(key => key.trim()).filter(key => {
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  })).filter(tier => tier.keys.length > 0);
};

export const resolveProviderCredentialPlan = async (options: {
  userId?: string | null;
  provider: ProviderAccessProvider;
  personalKeys?: string[];
  globalTiers?: ProviderCredentialTier[];
}): Promise<{
  policy: EffectiveProviderPolicy;
  tiers: ProviderCredentialTier[];
}> => {
  const provider = normalizeProvider(options.provider);
  const [policy, assigned] = await Promise.all([
    resolveEffectiveProviderPolicy(options.userId, provider),
    resolveAssignedProviderKeys(options.userId, provider),
  ]);
  if (!policy.enabled || policy.credentialMode === 'disabled') {
    return { policy, tiers: [] };
  }
  const personal: ProviderCredentialTier[] = policy.allowPersonalKeys && options.personalKeys?.length
    ? [{ source: 'user', keys: options.personalKeys }]
    : [];
  const assignedUser = assigned.user;
  const sharedAndServer = policy.allowSharedFallback
    ? [...assigned.all, ...(options.globalTiers || [])]
    : [];
  let tiers: ProviderCredentialTier[];
  switch (policy.credentialMode) {
    case 'assigned_first':
      tiers = [...assignedUser, ...assigned.all, ...personal, ...(policy.allowSharedFallback ? options.globalTiers || [] : [])];
      break;
    case 'assigned_only':
      tiers = [...assignedUser, ...assigned.all];
      break;
    case 'personal_only':
      tiers = personal;
      break;
    case 'global_only':
      tiers = [...assigned.all, ...(options.globalTiers || [])];
      break;
    case 'personal_first':
    default:
      tiers = [...personal, ...assignedUser, ...sharedAndServer];
      break;
  }
  return { policy, tiers: uniqueTiers(tiers) };
};

export const assertProviderModelAllowed = async (
  userId: string | null | undefined,
  provider: ProviderAccessProvider,
  modelValue: unknown,
): Promise<EffectiveProviderPolicy> => {
  const policy = await resolveEffectiveProviderPolicy(userId, provider);
  if (!policy.enabled || policy.credentialMode === 'disabled') {
    throw new ProviderAccessError('This provider is disabled for the user.', 403, 'PROVIDER_ACCESS_DENIED');
  }
  const model = normalizeModel(modelValue);
  if (model && policy.allowedModels.length > 0 && !policy.allowedModels.includes(model)) {
    throw new ProviderAccessError('This model is not allowed for the user.', 403, 'PROVIDER_MODEL_DENIED');
  }
  return policy;
};

export const reserveProviderRequest = async (options: {
  userId?: string | null;
  provider: ProviderAccessProvider;
  operation?: string;
  requestId?: string;
}): Promise<{
  allowed: boolean;
  duplicate: boolean;
  dailyUsed: number;
  monthlyUsed: number;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  schemaAvailable: boolean;
}> => {
  const provider = normalizeProvider(options.provider);
  if (!options.userId) {
    return {
      allowed: true,
      duplicate: false,
      dailyUsed: 0,
      monthlyUsed: 0,
      dailyLimit: null,
      monthlyLimit: null,
      schemaAvailable: true,
    };
  }
  const userId = normalizeUuid(options.userId, 'userId');
  const policy = await resolveEffectiveProviderPolicy(userId, provider);
  if (!policy.enabled || policy.credentialMode === 'disabled') {
    throw new ProviderAccessError('This provider is disabled for the user.', 403, 'PROVIDER_ACCESS_DENIED');
  }
  const requestId = options.requestId ? normalizeUuid(options.requestId, 'requestId') : randomUUID();
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc('reserve_provider_request', {
    p_request_id: requestId,
    p_user_id: userId,
    p_provider: provider,
    p_operation: String(options.operation || 'request').trim().slice(0, 120) || 'request',
    p_daily_limit: policy.dailyRequestLimit,
    p_monthly_limit: policy.monthlyRequestLimit,
  });
  if (error) {
    if (isMissingSchemaError(error)) {
      return {
        allowed: true,
        duplicate: false,
        dailyUsed: 0,
        monthlyUsed: 0,
        dailyLimit: policy.dailyRequestLimit,
        monthlyLimit: policy.monthlyRequestLimit,
        schemaAvailable: false,
      };
    }
    throw storageError(error);
  }
  const payload = isRecord(data) ? data : {};
  const result = {
    allowed: payload.allowed === true,
    duplicate: payload.duplicate === true,
    dailyUsed: Number(payload.dailyUsed) || 0,
    monthlyUsed: Number(payload.monthlyUsed) || 0,
    dailyLimit: payload.dailyLimit === null || payload.dailyLimit === undefined ? null : Number(payload.dailyLimit),
    monthlyLimit: payload.monthlyLimit === null || payload.monthlyLimit === undefined ? null : Number(payload.monthlyLimit),
    schemaAvailable: true,
  };
  if (!result.allowed) {
    throw new ProviderAccessError(
      'The provider request quota has been reached for this user.',
      429,
      'PROVIDER_REQUEST_QUOTA_EXCEEDED',
    );
  }
  return result;
};

export const __providerAccessControlTestUtils = {
  defaultPolicy,
  mergePolicy,
  normalizeKeyList,
  encryptKeys,
  decryptKeys,
  uniqueTiers,
};
