import type { CrawlerExternalProvider } from '../constants/crawlerProviders';
import {
  getAuthenticatedApiHeaders,
  getAuthenticatedApiToken,
} from './authenticatedApi';

export type CrawlerProviderSecretStatus = {
  provider: CrawlerExternalProvider;
  configured: boolean;
  enabled: boolean;
  keySuffix: string | null;
  updatedAt: string | null;
  fallbackConfigured: boolean;
  effectiveConfigured: boolean;
  activeSource: 'admin' | 'hostinger';
};

export type CrawlerProviderSecretsResponse = {
  schemaAvailable: boolean;
  encryptionConfigured: boolean;
  providers: Record<CrawlerExternalProvider, CrawlerProviderSecretStatus>;
  usagePolicy: CrawlerUsagePolicy;
  monthlyUsage: Record<CrawlerExternalProvider, CrawlerProviderMonthlyUsage>;
};

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

const requestCrawlerProviderSecrets = async (options: {
  method?: 'GET' | 'PUT' | 'DELETE';
  body?: Record<string, unknown>;
} = {}): Promise<CrawlerProviderSecretsResponse> => {
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
        : `Crawler provider secret request failed (${response.status}).`,
    );
  }
  return payload as CrawlerProviderSecretsResponse;
};

export const loadCrawlerProviderSecrets =
(): Promise<CrawlerProviderSecretsResponse> => requestCrawlerProviderSecrets();

export const saveAndEnableCrawlerProviderSecret = (
  provider: CrawlerExternalProvider,
  apiKey: string,
): Promise<CrawlerProviderSecretsResponse> => requestCrawlerProviderSecrets({
  method: 'PUT',
  body: { provider, apiKey, enabled: true },
});

export const setCrawlerProviderSecretEnabled = (
  provider: CrawlerExternalProvider,
  enabled: boolean,
): Promise<CrawlerProviderSecretsResponse> => requestCrawlerProviderSecrets({
  method: 'PUT',
  body: { provider, enabled },
});

export const clearCrawlerProviderSecret = (
  provider: CrawlerExternalProvider,
): Promise<CrawlerProviderSecretsResponse> => requestCrawlerProviderSecrets({
  method: 'DELETE',
  body: { provider },
});

export const saveCrawlerUsagePolicy = (
  usagePolicy: CrawlerUsagePolicy,
): Promise<CrawlerProviderSecretsResponse> => requestCrawlerProviderSecrets({
  method: 'PUT',
  body: {
    action: 'save_usage_policy',
    usagePolicy,
  },
});
