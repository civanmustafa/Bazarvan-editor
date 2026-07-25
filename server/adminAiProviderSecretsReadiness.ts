import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';
import { isAiSettingsEncryptionConfigured } from './adminAiProviderSecrets.ts';
import { ADMIN_AI_PROVIDER_SECRETS_MIGRATION } from '../constants/adminAiProviderSecrets.ts';
import { USER_AI_PROVIDER_SECRETS_MIGRATION } from '../constants/userAiProviderSecrets.ts';

type ReadinessProbeResult = {
  error?: {
    code?: string;
    message?: string;
  } | null;
};

export type AdminAiProviderSecretsReadinessClient = {
  from: (table: string) => {
    select: (columns: string) => {
      limit: (count: number) => PromiseLike<ReadinessProbeResult>;
    };
  };
};

export type AdminAiProviderSecretsReadinessResult = {
  ok: boolean;
  checkedAt: string;
  requiredMigration: string;
  requiredMigrations: string[];
  checks: {
    schema: boolean;
    userSchema: boolean;
    encryptionKey: boolean;
  };
  code?: 'admin_ai_provider_secrets_unavailable';
  detail?: string;
};

type CachedReadiness = {
  expiresAt: number;
  result: AdminAiProviderSecretsReadinessResult;
};

let cachedReadiness: CachedReadiness | null = null;

export const checkAdminAiProviderSecretsReadiness = async (options: {
  client?: AdminAiProviderSecretsReadinessClient;
  force?: boolean;
} = {}): Promise<AdminAiProviderSecretsReadinessResult> => {
  const now = Date.now();
  if (!options.force && cachedReadiness && cachedReadiness.expiresAt > now) {
    return cachedReadiness.result;
  }

  const checks = {
    schema: false,
    userSchema: false,
    encryptionKey: isAiSettingsEncryptionConfigured(),
  };
  const failures: string[] = [];
  try {
    const client = options.client
      || getExternalAnalysisSupabaseAdmin() as unknown as AdminAiProviderSecretsReadinessClient;
    const { error } = await client
      .from('ai_provider_secrets')
      .select('provider,enabled,key_suffix,encryption_version')
      .limit(1);
    if (error) {
      failures.push(`schema: ${error.code || 'unknown'}: ${error.message || 'Unknown Supabase error.'}`);
    } else {
      checks.schema = true;
    }
    const { error: userSchemaError } = await client
      .from('user_ai_provider_secrets')
      .select('user_id,provider,enabled,key_count,key_suffixes,encryption_version')
      .limit(1);
    if (userSchemaError) {
      failures.push(`userSchema: ${userSchemaError.code || 'unknown'}: ${userSchemaError.message || 'Unknown Supabase error.'}`);
    } else {
      checks.userSchema = true;
    }
  } catch (error) {
    failures.push(`schema: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!checks.encryptionKey) {
    failures.push('encryptionKey: AI_SETTINGS_ENCRYPTION_KEY is missing or invalid.');
  }

  const ok = checks.schema && checks.userSchema && checks.encryptionKey;
  const result: AdminAiProviderSecretsReadinessResult = {
    ok,
    checkedAt: new Date().toISOString(),
    requiredMigration: USER_AI_PROVIDER_SECRETS_MIGRATION,
    requiredMigrations: [
      ADMIN_AI_PROVIDER_SECRETS_MIGRATION,
      USER_AI_PROVIDER_SECRETS_MIGRATION,
    ],
    checks,
    ...(!ok ? {
      code: 'admin_ai_provider_secrets_unavailable' as const,
      detail: failures.join(' | ').slice(0, 2_000),
    } : {}),
  };
  cachedReadiness = {
    expiresAt: now + (ok ? 30_000 : 5_000),
    result,
  };
  return result;
};

export const toPublicAdminAiProviderSecretsReadiness = (
  result: AdminAiProviderSecretsReadinessResult,
): Omit<AdminAiProviderSecretsReadinessResult, 'detail'> => ({
  ok: result.ok,
  checkedAt: result.checkedAt,
  requiredMigration: result.requiredMigration,
  requiredMigrations: result.requiredMigrations,
  checks: result.checks,
  ...(result.code ? { code: result.code } : {}),
});

export const __resetAdminAiProviderSecretsReadinessForTests = (): void => {
  cachedReadiness = null;
};
