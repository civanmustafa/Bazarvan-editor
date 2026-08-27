import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi.ts';

export type ArticleQuotaMode = 'inherit' | 'custom' | 'unlimited' | 'blocked';

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

export type ArticleQuotaResponse = {
  ok: true;
  schemaAvailable: boolean;
  timezone: 'Europe/Istanbul';
  globalDefaultMonthlyLimit: number | null;
  status: ArticleQuotaStatus | null;
};

const requestArticleQuota = async (
  url: string,
  options: { method?: 'GET' | 'PUT'; body?: Record<string, unknown> } = {},
): Promise<ArticleQuotaResponse> => {
  const token = await getAuthenticatedApiToken();
  const method = options.method || 'GET';
  const response = await fetch(url, {
    method,
    headers: getAuthenticatedApiHeaders(
      token,
      method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    ),
    body: method === 'GET' ? undefined : JSON.stringify(options.body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof payload.error === 'string'
      ? payload.error
      : `Article quota request failed (${response.status}).`) as Error & { code?: string };
    if (typeof payload.code === 'string') error.code = payload.code;
    throw error;
  }
  return payload as ArticleQuotaResponse;
};

export const loadAdminArticleQuota = (userId?: string): Promise<ArticleQuotaResponse> => (
  requestArticleQuota(`/api/admin/article-quota${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`)
);

export const saveGlobalArticleQuota = (defaultMonthlyLimit: number | null): Promise<ArticleQuotaResponse> => (
  requestArticleQuota('/api/admin/article-quota', {
    method: 'PUT',
    body: { action: 'save_global', defaultMonthlyLimit },
  })
);

export const saveUserArticleQuota = (options: {
  userId: string;
  mode: ArticleQuotaMode;
  monthlyLimit?: number | null;
}): Promise<ArticleQuotaResponse> => requestArticleQuota('/api/admin/article-quota', {
  method: 'PUT',
  body: { action: 'save_user', ...options },
});

export const loadUserArticleQuota = (): Promise<ArticleQuotaResponse> => (
  requestArticleQuota('/api/user/article-quota')
);
