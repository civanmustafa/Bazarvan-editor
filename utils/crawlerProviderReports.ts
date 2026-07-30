import type {
  ClientSiteCrawlProvider,
  CrawlerExternalProvider,
} from '../constants/crawlerProviders';
import {
  getAuthenticatedApiHeaders,
  getAuthenticatedApiToken,
} from './authenticatedApi';

export type CrawlerProviderReportEvent = {
  id: string;
  crawlJobId: string | null;
  crawlRunId: string | null;
  clientId: string;
  clientName: string;
  pageId: string | null;
  pageTitle: string;
  requestedBy: string | null;
  requestedByName: string;
  jobAttempt: number;
  requestedProvider: ClientSiteCrawlProvider;
  provider: 'local' | CrawlerExternalProvider;
  credentialSource: 'admin' | 'hostinger' | null;
  keySuffix: string | null;
  status: 'completed' | 'failed';
  targetUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  durationMs: number;
  wordCount: number | null;
  internalLinkCount: number | null;
  responseContentType: string | null;
  fallbackReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean | null;
  startedAt: string;
  completedAt: string;
  createdAt: string;
};

export type CrawlerProviderReportResponse = {
  schemaAvailable: boolean;
  events: CrawlerProviderReportEvent[];
};

export const listCrawlerProviderReportEvents = async (options: {
  from: string;
  to: string;
  limit?: number;
}): Promise<CrawlerProviderReportResponse> => {
  const accessToken = await getAuthenticatedApiToken();
  const query = new URLSearchParams({
    from: options.from,
    to: options.to,
    limit: String(Math.max(1, Math.min(options.limit || 1_000, 2_000))),
  });
  const response = await fetch(`/api/admin/crawler-provider-usage?${query}`, {
    method: 'GET',
    headers: getAuthenticatedApiHeaders(accessToken),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Crawler provider usage request failed (${response.status}).`,
    );
  }
  return {
    schemaAvailable: payload.schemaAvailable === true,
    events: Array.isArray(payload.events)
      ? payload.events as CrawlerProviderReportEvent[]
      : [],
  };
};
