import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import { CONTENT_WRITING_REQUIRED_MIGRATIONS } from '../constants/contentWritingRelease';

export const CONTENT_WRITING_SCHEMA_PROBES = [
  {
    id: 'sessions',
    table: 'content_writing_sessions',
    columns: 'id,execution_mode,applied_at,application_count,quality_guard_version,quality_policy_version,quality_score,quality_report,quality_repair_count',
  },
  {
    id: 'messages',
    table: 'content_writing_messages',
    columns: 'id,session_id,sequence_number,stage,role',
  },
  {
    id: 'steps',
    table: 'content_writing_steps',
    columns: 'id,session_id,step_key,step_type,status,ordinal',
  },
] as const;

type ProbeResult = {
  error?: {
    code?: string;
    message?: string;
  } | null;
};

export type ContentWritingReadinessClient = {
  from: (table: string) => {
    select: (columns: string) => {
      limit: (count: number) => PromiseLike<ProbeResult>;
    };
  };
};

export type ContentWritingReadinessResult = {
  ok: boolean;
  checkedAt: string;
  requiredMigrationCount: number;
  checks: Record<(typeof CONTENT_WRITING_SCHEMA_PROBES)[number]['id'], boolean>;
  code?: 'content_writing_schema_unavailable';
  detail?: string;
};

type CachedReadiness = {
  expiresAt: number;
  result: ContentWritingReadinessResult;
};

let cachedReadiness: CachedReadiness | null = null;

const withTimeout = async <T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> => {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Supabase readiness probe timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const describeProbeFailure = (probeId: string, error: ProbeResult['error']): string => {
  const code = typeof error?.code === 'string' ? error.code : 'unknown';
  const message = typeof error?.message === 'string' ? error.message : 'Unknown Supabase error.';
  return `${probeId}: ${code}: ${message}`.slice(0, 1_000);
};

export const checkContentWritingReadiness = async (options: {
  client?: ContentWritingReadinessClient;
  timeoutMs?: number;
  force?: boolean;
} = {}): Promise<ContentWritingReadinessResult> => {
  const now = Date.now();
  if (!options.force && cachedReadiness && cachedReadiness.expiresAt > now) {
    return cachedReadiness.result;
  }

  const timeoutMs = Math.max(500, Math.min(options.timeoutMs || 5_000, 15_000));
  const checks = Object.fromEntries(
    CONTENT_WRITING_SCHEMA_PROBES.map(probe => [probe.id, false]),
  ) as ContentWritingReadinessResult['checks'];
  const failures: string[] = [];
  let client: ContentWritingReadinessClient;
  try {
    client = options.client || getExternalAnalysisSupabaseAdmin() as unknown as ContentWritingReadinessClient;
  } catch (error) {
    failures.push(`client: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000));
    const result: ContentWritingReadinessResult = {
      ok: false,
      checkedAt: new Date().toISOString(),
      requiredMigrationCount: CONTENT_WRITING_REQUIRED_MIGRATIONS.length,
      checks,
      code: 'content_writing_schema_unavailable',
      detail: failures[0],
    };
    cachedReadiness = { expiresAt: now + 5_000, result };
    return result;
  }

  await Promise.all(CONTENT_WRITING_SCHEMA_PROBES.map(async probe => {
    try {
      const result = await withTimeout(
        client.from(probe.table).select(probe.columns).limit(1),
        timeoutMs,
      );
      if (result.error) {
        failures.push(describeProbeFailure(probe.id, result.error));
        return;
      }
      checks[probe.id] = true;
    } catch (error) {
      failures.push(`${probe.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000));
    }
  }));

  const ok = failures.length === 0;
  const result: ContentWritingReadinessResult = {
    ok,
    checkedAt: new Date().toISOString(),
    requiredMigrationCount: CONTENT_WRITING_REQUIRED_MIGRATIONS.length,
    checks,
    ...(!ok ? {
      code: 'content_writing_schema_unavailable' as const,
      detail: failures.join(' | ').slice(0, 3_000),
    } : {}),
  };
  cachedReadiness = {
    expiresAt: now + (ok ? 30_000 : 5_000),
    result,
  };
  return result;
};

export const toPublicContentWritingReadiness = (
  result: ContentWritingReadinessResult,
): Omit<ContentWritingReadinessResult, 'detail'> => ({
  ok: result.ok,
  checkedAt: result.checkedAt,
  requiredMigrationCount: result.requiredMigrationCount,
  checks: result.checks,
  ...(result.code ? { code: result.code } : {}),
});

export const __resetContentWritingReadinessForTests = (): void => {
  cachedReadiness = null;
};
