import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';

export const ARTICLE_QUOTA_MODES = ['inherit', 'custom', 'unlimited', 'blocked'] as const;
export type ArticleQuotaMode = typeof ARTICLE_QUOTA_MODES[number];

export type ArticleQuotaStatus = {
  userId: string;
  role: 'admin' | 'user';
  timezone: 'Europe/Istanbul';
  periodStart: string;
  resetAt: string;
  globalDefaultMonthlyLimit: number | null;
  mode: ArticleQuotaMode;
  customMonthlyLimit: number | null;
  effectiveMonthlyLimit: number | null;
  used: number;
  remaining: number | null;
  canCreate: boolean;
};

export type ArticleQuotaOverview = {
  schemaAvailable: boolean;
  timezone: 'Europe/Istanbul';
  globalDefaultMonthlyLimit: number | null;
  status: ArticleQuotaStatus | null;
};

export class ArticleQuotaError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'ARTICLE_QUOTA_ERROR') {
    super(message);
    this.name = 'ArticleQuotaError';
    this.status = status;
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GLOBAL_TABLE = 'article_quota_global_policy';

const normalizeUuid = (value: unknown, field: string): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(normalized)) {
    throw new ArticleQuotaError(`${field} must be a valid UUID.`, 400, 'ARTICLE_QUOTA_UUID_INVALID');
  }
  return normalized;
};

const isMissingSchemaError = (error: any): boolean => (
  ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(String(error?.code || ''))
);

const throwSaveError = (error: any, message: string): never => {
  const code = String(error?.code || '');
  if (isMissingSchemaError(error)) {
    throw new ArticleQuotaError(
      'Article quota migration has not been applied.',
      503,
      'ARTICLE_QUOTA_SCHEMA_MISSING',
    );
  }
  if (code === '42501') {
    throw new ArticleQuotaError(
      'An active administrator is required.',
      403,
      'ARTICLE_QUOTA_ADMIN_REQUIRED',
    );
  }
  if (code === 'P0002') {
    throw new ArticleQuotaError(
      'User was not found.',
      404,
      'ARTICLE_QUOTA_USER_NOT_FOUND',
    );
  }
  throw new ArticleQuotaError(
    `${message}: ${String(error?.message || 'unknown storage error')}`,
    503,
    'ARTICLE_QUOTA_SAVE_FAILED',
  );
};

const normalizeLimit = (
  value: unknown,
  options: { allowNull: boolean; allowZero: boolean },
): number | null => {
  if (value === null || value === undefined || value === '') {
    if (options.allowNull) return null;
    throw new ArticleQuotaError('A monthly article limit is required.', 400, 'ARTICLE_QUOTA_LIMIT_REQUIRED');
  }
  const limit = typeof value === 'number' ? value : Number(value);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isInteger(limit) || limit < minimum || limit > 1_000_000) {
    throw new ArticleQuotaError(
      `The monthly article limit must be an integer between ${minimum} and 1000000.`,
      400,
      'ARTICLE_QUOTA_LIMIT_INVALID',
    );
  }
  return limit;
};

export const normalizeArticleQuotaMode = (value: unknown): ArticleQuotaMode => {
  if (typeof value !== 'string' || !ARTICLE_QUOTA_MODES.includes(value as ArticleQuotaMode)) {
    throw new ArticleQuotaError('Unsupported article quota mode.', 400, 'ARTICLE_QUOTA_MODE_INVALID');
  }
  return value as ArticleQuotaMode;
};

const normalizeNullableNumber = (value: unknown): number | null => (
  value === null || value === undefined ? null : Number(value)
);

const normalizeStatus = (value: any): ArticleQuotaStatus => {
  if (!value || typeof value !== 'object') {
    throw new ArticleQuotaError('Article quota status is unavailable.', 503, 'ARTICLE_QUOTA_STATUS_INVALID');
  }
  const mode = normalizeArticleQuotaMode(value.mode);
  return {
    userId: normalizeUuid(value.userId, 'userId'),
    role: value.role === 'admin' ? 'admin' : 'user',
    timezone: 'Europe/Istanbul',
    periodStart: String(value.periodStart || ''),
    resetAt: String(value.resetAt || ''),
    globalDefaultMonthlyLimit: normalizeNullableNumber(value.globalDefaultMonthlyLimit),
    mode,
    customMonthlyLimit: normalizeNullableNumber(value.customMonthlyLimit),
    effectiveMonthlyLimit: normalizeNullableNumber(value.effectiveMonthlyLimit),
    used: Math.max(0, Number(value.used) || 0),
    remaining: normalizeNullableNumber(value.remaining),
    canCreate: value.canCreate === true,
  };
};

const readGlobalLimit = async (): Promise<{ schemaAvailable: boolean; limit: number | null }> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from(GLOBAL_TABLE)
    .select('default_monthly_limit')
    .eq('singleton', true)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return { schemaAvailable: false, limit: null };
    throw new ArticleQuotaError(`Could not read article quota settings: ${error.message}`, 503, 'ARTICLE_QUOTA_STORAGE_UNAVAILABLE');
  }
  return {
    schemaAvailable: true,
    limit: normalizeNullableNumber(data?.default_monthly_limit),
  };
};

export const readArticleQuotaOverview = async (
  userIdValue?: unknown,
): Promise<ArticleQuotaOverview> => {
  const global = await readGlobalLimit();
  if (!global.schemaAvailable) {
    return {
      schemaAvailable: false,
      timezone: 'Europe/Istanbul',
      globalDefaultMonthlyLimit: null,
      status: null,
    };
  }
  if (userIdValue === undefined || userIdValue === null || userIdValue === '') {
    return {
      schemaAvailable: true,
      timezone: 'Europe/Istanbul',
      globalDefaultMonthlyLimit: global.limit,
      status: null,
    };
  }
  const userId = normalizeUuid(userIdValue, 'userId');
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'get_article_monthly_quota_status',
    { p_user_id: userId },
  );
  if (error) {
    if (isMissingSchemaError(error)) {
      return {
        schemaAvailable: false,
        timezone: 'Europe/Istanbul',
        globalDefaultMonthlyLimit: null,
        status: null,
      };
    }
    const notFound = String(error.code || '') === 'P0002';
    throw new ArticleQuotaError(
      notFound ? 'User was not found.' : `Could not read article quota usage: ${error.message}`,
      notFound ? 404 : 503,
      notFound ? 'ARTICLE_QUOTA_USER_NOT_FOUND' : 'ARTICLE_QUOTA_STORAGE_UNAVAILABLE',
    );
  }
  const status = normalizeStatus(data);
  return {
    schemaAvailable: true,
    timezone: 'Europe/Istanbul',
    globalDefaultMonthlyLimit: status.globalDefaultMonthlyLimit,
    status,
  };
};

export const saveGlobalArticleQuota = async (options: {
  actorUserId: string;
  defaultMonthlyLimit: unknown;
}): Promise<void> => {
  const actorUserId = normalizeUuid(options.actorUserId, 'actorUserId');
  const defaultMonthlyLimit = normalizeLimit(options.defaultMonthlyLimit, { allowNull: true, allowZero: true });
  const current = await readGlobalLimit();
  if (!current.schemaAvailable) {
    throw new ArticleQuotaError('Article quota migration has not been applied.', 503, 'ARTICLE_QUOTA_SCHEMA_MISSING');
  }
  const { error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'set_article_quota_global_policy',
    {
      p_actor_user_id: actorUserId,
      p_default_monthly_limit: defaultMonthlyLimit,
    },
  );
  if (error) {
    throwSaveError(error, 'Could not save the default article quota');
  }
};

export const saveUserArticleQuota = async (options: {
  actorUserId: string;
  userId: unknown;
  mode: unknown;
  monthlyLimit?: unknown;
}): Promise<void> => {
  const actorUserId = normalizeUuid(options.actorUserId, 'actorUserId');
  const userId = normalizeUuid(options.userId, 'userId');
  const mode = normalizeArticleQuotaMode(options.mode);
  const monthlyLimit = mode === 'custom'
    ? normalizeLimit(options.monthlyLimit, { allowNull: false, allowZero: false })
    : null;
  const supabase = getExternalAnalysisSupabaseAdmin();
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) throw new ArticleQuotaError(`Could not verify the user: ${profileError.message}`, 503, 'ARTICLE_QUOTA_STORAGE_UNAVAILABLE');
  if (!profile) throw new ArticleQuotaError('User was not found.', 404, 'ARTICLE_QUOTA_USER_NOT_FOUND');

  const { error } = await supabase.rpc('set_user_article_quota_policy', {
    p_actor_user_id: actorUserId,
    p_user_id: userId,
    p_mode: mode,
    p_monthly_limit: monthlyLimit,
  });
  if (error) throwSaveError(error, 'Could not save the user article quota');
};

export const __articleQuotaTestUtils = {
  normalizeLimit,
  normalizeStatus,
};
