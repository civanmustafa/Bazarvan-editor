import type { CrawlerExternalProvider } from '../constants/crawlerProviders.ts';
import { ClientPageCrawlerError } from './clientPageCrawler.ts';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';

export type CrawlerUsagePolicy = {
  externalReuseDays: number;
  maxExternalRequestsPerRun: number;
  firecrawlMonthlyRequestLimit: number;
  browserlessMonthlyRequestLimit: number;
};

export type CrawlerProviderMonthlyUsage = {
  used: number;
  limit: number;
  remaining: number;
};

export const DEFAULT_CRAWLER_USAGE_POLICY: CrawlerUsagePolicy = {
  externalReuseDays: 14,
  maxExternalRequestsPerRun: 100,
  firecrawlMonthlyRequestLimit: 500,
  browserlessMonthlyRequestLimit: 500,
};

const integer = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
};

export const normalizeCrawlerUsagePolicy = (
  value: unknown,
): CrawlerUsagePolicy => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    externalReuseDays: integer(
      source.externalReuseDays,
      DEFAULT_CRAWLER_USAGE_POLICY.externalReuseDays,
      1,
      90,
    ),
    maxExternalRequestsPerRun: integer(
      source.maxExternalRequestsPerRun,
      DEFAULT_CRAWLER_USAGE_POLICY.maxExternalRequestsPerRun,
      1,
      2_000,
    ),
    firecrawlMonthlyRequestLimit: integer(
      source.firecrawlMonthlyRequestLimit,
      DEFAULT_CRAWLER_USAGE_POLICY.firecrawlMonthlyRequestLimit,
      1,
      1_000_000,
    ),
    browserlessMonthlyRequestLimit: integer(
      source.browserlessMonthlyRequestLimit,
      DEFAULT_CRAWLER_USAGE_POLICY.browserlessMonthlyRequestLimit,
      1,
      1_000_000,
    ),
  };
};

export const readCrawlerUsagePolicy = async (): Promise<CrawlerUsagePolicy> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('app_settings')
    .select('value')
    .eq('key', 'crawler')
    .maybeSingle();
  if (error) throw error;
  return normalizeCrawlerUsagePolicy(data?.value);
};

export const saveCrawlerUsagePolicy = async (options: {
  value: unknown;
  updatedBy: string;
}): Promise<CrawlerUsagePolicy> => {
  const value = normalizeCrawlerUsagePolicy(options.value);
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from('app_settings')
    .upsert({
      key: 'crawler',
      value,
      description:
        'Administrator-managed freshness and hard request budgets for external crawler providers.',
      is_secret: false,
      updated_by: options.updatedBy,
    }, { onConflict: 'key' });
  if (error) throw error;
  return value;
};

const monthStartIso = (): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
};

export const readCrawlerProviderMonthlyUsage = async (
  policyValue?: CrawlerUsagePolicy,
): Promise<Record<CrawlerExternalProvider, CrawlerProviderMonthlyUsage>> => {
  const policy = policyValue || await readCrawlerUsagePolicy();
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('crawler_provider_monthly_usage')
    .select('provider,reserved_attempts')
    .eq('month_start', monthStartIso());
  if (error && error.code !== '42P01' && error.code !== 'PGRST205') throw error;
  const used = new Map(
    (data || []).map(row => [
      String(row.provider),
      Math.max(0, Number(row.reserved_attempts) || 0),
    ]),
  );
  const create = (
    provider: CrawlerExternalProvider,
    limit: number,
  ): CrawlerProviderMonthlyUsage => {
    const providerUsed = used.get(provider) || 0;
    return {
      used: providerUsed,
      limit,
      remaining: Math.max(0, limit - providerUsed),
    };
  };
  return {
    firecrawl: create('firecrawl', policy.firecrawlMonthlyRequestLimit),
    browserless: create('browserless', policy.browserlessMonthlyRequestLimit),
  };
};

export const reserveCrawlerExternalRequest = async (options: {
  crawlRunId: string | null;
  provider: CrawlerExternalProvider;
}): Promise<void> => {
  if (!options.crawlRunId) {
    throw new ClientPageCrawlerError({
      code: 'crawler_external_run_required',
      message: 'An external crawler request must belong to a bounded site crawl.',
      status: 409,
      retryable: false,
    });
  }
  const policy = await readCrawlerUsagePolicy();
  const monthlyLimit = options.provider === 'firecrawl'
    ? policy.firecrawlMonthlyRequestLimit
    : policy.browserlessMonthlyRequestLimit;
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .rpc('reserve_crawler_external_request', {
      p_run_id: options.crawlRunId,
      p_provider: options.provider,
      p_monthly_limit: monthlyLimit,
    });
  if (error) {
    throw new ClientPageCrawlerError({
      code: 'crawler_external_budget_unavailable',
      message: [
        error.message,
        error.details,
        error.hint,
      ].filter(Boolean).join(' | ') || 'Could not reserve crawler provider usage.',
      status: 503,
      retryable: true,
    });
  }
  const result = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  if (result.allowed === true) return;

  const reason = String(result.reason || '');
  const monthly = reason === 'provider_monthly_request_limit_reached';
  throw new ClientPageCrawlerError({
    code: monthly
      ? 'crawler_provider_monthly_limit_reached'
      : 'crawler_run_external_limit_reached',
    message: monthly
      ? `The ${options.provider} monthly request budget has been reached.`
      : 'The external request budget for this crawl has been reached.',
    status: 429,
    retryable: false,
  });
};

export const __crawlerUsagePolicyTestUtils = {
  monthStartIso,
};
