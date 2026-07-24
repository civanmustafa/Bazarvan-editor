import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import {
  CLIENT_CENTER_REQUIRED_MIGRATION,
  CLIENT_CENTER_SCHEMA_PROBES,
} from '../constants/clientCenter';

type ProbeResult = {
  error?: {
    code?: string;
    message?: string;
  } | null;
};

export type ClientCenterReadinessClient = {
  from: (table: string) => {
    select: (columns: string) => {
      limit: (count: number) => PromiseLike<ProbeResult>;
    };
  };
};

export type ClientCenterReadinessResult = {
  ok: boolean;
  checkedAt: string;
  requiredMigration: string;
  checks: Record<(typeof CLIENT_CENTER_SCHEMA_PROBES)[number]['id'], boolean>;
  code?: 'client_center_schema_unavailable';
  detail?: string;
};

type CachedReadiness = {
  expiresAt: number;
  result: ClientCenterReadinessResult;
};

let cachedReadiness: CachedReadiness | null = null;

const withTimeout = async <T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> => {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Client Center schema probe timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const checkClientCenterReadiness = async (options: {
  client?: ClientCenterReadinessClient;
  timeoutMs?: number;
  force?: boolean;
} = {}): Promise<ClientCenterReadinessResult> => {
  const now = Date.now();
  if (!options.force && cachedReadiness && cachedReadiness.expiresAt > now) {
    return cachedReadiness.result;
  }

  const checks = Object.fromEntries(
    CLIENT_CENTER_SCHEMA_PROBES.map(probe => [probe.id, false]),
  ) as ClientCenterReadinessResult['checks'];
  const failures: string[] = [];
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs || 5_000, 15_000));

  let client: ClientCenterReadinessClient;
  try {
    client = options.client
      || getExternalAnalysisSupabaseAdmin() as unknown as ClientCenterReadinessClient;
  } catch (error) {
    failures.push(`client: ${error instanceof Error ? error.message : String(error)}`);
    const result: ClientCenterReadinessResult = {
      ok: false,
      checkedAt: new Date().toISOString(),
      requiredMigration: CLIENT_CENTER_REQUIRED_MIGRATION,
      checks,
      code: 'client_center_schema_unavailable',
      detail: failures[0].slice(0, 1_000),
    };
    cachedReadiness = { expiresAt: now + 5_000, result };
    return result;
  }

  await Promise.all(CLIENT_CENTER_SCHEMA_PROBES.map(async probe => {
    try {
      const result = await withTimeout(
        client.from(probe.table).select(probe.columns).limit(1),
        timeoutMs,
      );
      if (result.error) {
        const code = result.error.code || 'unknown';
        const message = result.error.message || 'Unknown Supabase error.';
        failures.push(`${probe.id}: ${code}: ${message}`.slice(0, 1_000));
        return;
      }
      checks[probe.id] = true;
    } catch (error) {
      failures.push(`${probe.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000));
    }
  }));

  const ok = failures.length === 0;
  const result: ClientCenterReadinessResult = {
    ok,
    checkedAt: new Date().toISOString(),
    requiredMigration: CLIENT_CENTER_REQUIRED_MIGRATION,
    checks,
    ...(!ok ? {
      code: 'client_center_schema_unavailable' as const,
      detail: failures.join(' | ').slice(0, 3_000),
    } : {}),
  };
  cachedReadiness = {
    expiresAt: now + (ok ? 30_000 : 5_000),
    result,
  };
  return result;
};

export const toPublicClientCenterReadiness = (
  result: ClientCenterReadinessResult,
): Omit<ClientCenterReadinessResult, 'detail'> => ({
  ok: result.ok,
  checkedAt: result.checkedAt,
  requiredMigration: result.requiredMigration,
  checks: result.checks,
  ...(result.code ? { code: result.code } : {}),
});

export const __resetClientCenterReadinessForTests = (): void => {
  cachedReadiness = null;
};
