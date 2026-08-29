import type { CrawlerExternalProvider } from '../constants/crawlerProviders';
import {
  getAuthenticatedApiHeaders,
  getAuthenticatedApiToken,
} from './authenticatedApi';

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

export type CrawlerUsagePolicyResponse = {
  usagePolicy: CrawlerUsagePolicy;
  monthlyUsage: Record<CrawlerExternalProvider, CrawlerProviderMonthlyUsage>;
};

const requestCrawlerUsagePolicy = async (options: {
  method?: 'GET' | 'PUT';
  body?: Record<string, unknown>;
} = {}): Promise<CrawlerUsagePolicyResponse> => {
  const accessToken = await getAuthenticatedApiToken();
  const method = options.method || 'GET';
  const response = await fetch('/api/admin/crawler-provider-secrets', {
    method,
    headers: getAuthenticatedApiHeaders(
      accessToken,
      method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    ),
    body: method === 'GET' ? undefined : JSON.stringify(options.body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Crawler usage policy request failed (${response.status}).`,
    );
  }
  return payload as CrawlerUsagePolicyResponse;
};

export const loadCrawlerUsagePolicy = (): Promise<CrawlerUsagePolicyResponse> => (
  requestCrawlerUsagePolicy()
);

export const saveCrawlerUsagePolicy = (
  usagePolicy: CrawlerUsagePolicy,
): Promise<CrawlerUsagePolicyResponse> => requestCrawlerUsagePolicy({
  method: 'PUT',
  body: { action: 'save_usage_policy', usagePolicy },
});
