import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';
import { isAiSettingsEncryptionConfigured } from './adminAiProviderSecrets.ts';
import {
  PROVIDER_EXPLICIT_GRANTS_MIGRATION,
} from '../constants/providerAccessControl.ts';
import {
  PROVIDER_CREDENTIAL_VAULT_MIGRATION,
  PROVIDER_CREDENTIAL_VAULT_TABLE,
} from './providerCredentialVault.ts';

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
    vaultSchema: boolean;
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
    vaultSchema: false,
    encryptionKey: isAiSettingsEncryptionConfigured(),
  };
  const failures: string[] = [];
  try {
    const client = options.client
      || getExternalAnalysisSupabaseAdmin() as unknown as AdminAiProviderSecretsReadinessClient;
    const { error } = await client
      .from(PROVIDER_CREDENTIAL_VAULT_TABLE)
      .select('id,vault_key,credential_type,provider,owner_user_id,enabled,key_count,key_suffixes,encryption_version')
      .limit(1);
    if (error) {
      failures.push(`vaultSchema: ${error.code || 'unknown'}: ${error.message || 'Unknown Supabase error.'}`);
    } else {
      checks.vaultSchema = true;
    }
  } catch (error) {
    failures.push(`vaultSchema: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!checks.encryptionKey) {
    failures.push('encryptionKey: the provider credential vault master key is missing or invalid.');
  }

  const ok = checks.vaultSchema && checks.encryptionKey;
  const result: AdminAiProviderSecretsReadinessResult = {
    ok,
    checkedAt: new Date().toISOString(),
    requiredMigration: PROVIDER_CREDENTIAL_VAULT_MIGRATION,
    requiredMigrations: [
      PROVIDER_CREDENTIAL_VAULT_MIGRATION,
      PROVIDER_EXPLICIT_GRANTS_MIGRATION,
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
