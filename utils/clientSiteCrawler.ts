import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi';
import type { ClientSiteCrawlProvider } from '../constants/crawlerProviders';

export type { ClientSiteCrawlProvider } from '../constants/crawlerProviders';

export type ClientSiteCrawlStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'cancelled';

export type ClientSiteCrawlRun = {
  id: string;
  clientId: string;
  startedBy: string | null;
  startUrl: string;
  status: ClientSiteCrawlStatus;
  provider: ClientSiteCrawlProvider;
  maxPages: number;
  maxDepth: number;
  followNofollow: boolean;
  pagesDiscovered: number;
  pagesQueued: number;
  pagesCompleted: number;
  pagesFailed: number;
  pagesReused: number;
  externalRequestsUsed: number;
  maxExternalRequests: number;
  externalReuseDays: number;
  forceExternalRefresh: boolean;
  limitReached: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClientInternalLink = {
  id: string;
  sourcePageId: string;
  targetPageId: string | null;
  targetUrl: string;
  anchorText: string;
  relNofollow: boolean;
  relSponsored: boolean;
  relUgc: boolean;
  crawlable: boolean;
  occurrenceCount: number;
  lastSeenAt: string;
};

export type ClientSiteCrawlState = {
  runs: ClientSiteCrawlRun[];
  activeInternalLinkCount: number;
  providerAvailability: Record<ClientSiteCrawlProvider, boolean>;
  usagePolicy: {
    externalReuseDays: number;
    maxExternalRequestsPerRun: number;
    firecrawlMonthlyRequestLimit: number;
    browserlessMonthlyRequestLimit: number;
  };
  monthlyUsage: Record<'firecrawl' | 'browserless', {
    used: number;
    limit: number;
    remaining: number;
  }>;
  links: ClientInternalLink[];
};

export type ClientSiteCrawlEstimate = {
  knownPages: number;
  reusablePages: number;
  estimatedExternalRequests: number;
  maximumExternalRequests: number;
  unknownCapacity: number;
  externalReuseDays: number;
  maxExternalRequestsPerRun: number;
  monthlyRemaining: number;
  provider: ClientSiteCrawlProvider;
  forceExternalRefresh: boolean;
};

const text = (value: unknown): string => typeof value === 'string' ? value : '';

const mapRun = (row: any): ClientSiteCrawlRun => ({
  id: text(row.id),
  clientId: text(row.client_id),
  startedBy: typeof row.started_by === 'string' ? row.started_by : null,
  startUrl: text(row.start_url),
  status: text(row.status) as ClientSiteCrawlStatus || 'queued',
  provider: text(row.provider) as ClientSiteCrawlProvider || 'auto',
  maxPages: Number(row.max_pages) || 0,
  maxDepth: Number(row.max_depth) || 0,
  followNofollow: row.follow_nofollow === true,
  pagesDiscovered: Number(row.pages_discovered) || 0,
  pagesQueued: Number(row.pages_queued) || 0,
  pagesCompleted: Number(row.pages_completed) || 0,
  pagesFailed: Number(row.pages_failed) || 0,
  pagesReused: Number(row.pages_reused) || 0,
  externalRequestsUsed: Number(row.external_requests_used) || 0,
  maxExternalRequests: Number(row.max_external_requests) || 0,
  externalReuseDays: Number(row.external_reuse_days) || 14,
  forceExternalRefresh: row.force_external_refresh === true,
  limitReached: row.limit_reached === true,
  startedAt: typeof row.started_at === 'string' ? row.started_at : null,
  finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
});

const mapLink = (row: any): ClientInternalLink => ({
  id: text(row.id),
  sourcePageId: text(row.source_page_id),
  targetPageId: typeof row.target_page_id === 'string' ? row.target_page_id : null,
  targetUrl: text(row.target_url),
  anchorText: text(row.anchor_text),
  relNofollow: row.rel_nofollow === true,
  relSponsored: row.rel_sponsored === true,
  relUgc: row.rel_ugc === true,
  crawlable: row.crawlable !== false,
  occurrenceCount: Math.max(1, Number(row.occurrence_count) || 1),
  lastSeenAt: text(row.last_seen_at),
});

const requestClientSiteCrawler = async (
  clientId: string,
  options: {
    method?: 'GET' | 'POST';
    body?: Record<string, unknown>;
    includeLinks?: boolean;
  } = {},
): Promise<any> => {
  const token = await getAuthenticatedApiToken();
  const method = options.method || 'GET';
  const query = new URLSearchParams({ clientId });
  if (options.includeLinks) query.set('includeLinks', 'true');
  const response = await fetch(`/api/client-site-crawl?${query.toString()}`, {
    method,
    headers: getAuthenticatedApiHeaders(
      token,
      method === 'POST' ? { 'Content-Type': 'application/json' } : {},
    ),
    body: method === 'POST' ? JSON.stringify(options.body || {}) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Site crawler request failed (${response.status}).`,
    );
  }
  return payload;
};

export const loadClientSiteCrawlState = async (
  clientId: string,
  includeLinks = false,
): Promise<ClientSiteCrawlState> => {
  const payload = await requestClientSiteCrawler(clientId, { includeLinks });
  return {
    runs: Array.isArray(payload.runs) ? payload.runs.map(mapRun) : [],
    activeInternalLinkCount: Number(payload.activeInternalLinkCount) || 0,
    providerAvailability: {
      auto: true,
      local: true,
      firecrawl: payload.providerAvailability?.firecrawl === true,
      browserless: payload.providerAvailability?.browserless === true,
    },
    usagePolicy: {
      externalReuseDays: Number(payload.usagePolicy?.externalReuseDays) || 14,
      maxExternalRequestsPerRun:
        Number(payload.usagePolicy?.maxExternalRequestsPerRun) || 100,
      firecrawlMonthlyRequestLimit:
        Number(payload.usagePolicy?.firecrawlMonthlyRequestLimit) || 500,
      browserlessMonthlyRequestLimit:
        Number(payload.usagePolicy?.browserlessMonthlyRequestLimit) || 500,
    },
    monthlyUsage: {
      firecrawl: {
        used: Number(payload.monthlyUsage?.firecrawl?.used) || 0,
        limit: Number(payload.monthlyUsage?.firecrawl?.limit) || 0,
        remaining: Number(payload.monthlyUsage?.firecrawl?.remaining) || 0,
      },
      browserless: {
        used: Number(payload.monthlyUsage?.browserless?.used) || 0,
        limit: Number(payload.monthlyUsage?.browserless?.limit) || 0,
        remaining: Number(payload.monthlyUsage?.browserless?.remaining) || 0,
      },
    },
    links: Array.isArray(payload.links) ? payload.links.map(mapLink) : [],
  };
};

export const startClientSiteCrawl = async (input: {
  clientId: string;
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  followNofollow?: boolean;
  provider?: ClientSiteCrawlProvider;
  forceExternalRefresh?: boolean;
  confirmFullExternalRefresh?: boolean;
}): Promise<ClientSiteCrawlRun> => {
  const payload = await requestClientSiteCrawler(input.clientId, {
    method: 'POST',
    body: {
      action: 'start',
      ...input,
    },
  });
  return mapRun(payload.run);
};

export const estimateClientSiteCrawl = async (input: {
  clientId: string;
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  followNofollow?: boolean;
  provider?: ClientSiteCrawlProvider;
  forceExternalRefresh?: boolean;
}): Promise<ClientSiteCrawlEstimate> => {
  const payload = await requestClientSiteCrawler(input.clientId, {
    method: 'POST',
    body: {
      action: 'estimate',
      ...input,
    },
  });
  const estimate = payload.estimate || {};
  return {
    knownPages: Number(estimate.knownPages) || 0,
    reusablePages: Number(estimate.reusablePages) || 0,
    estimatedExternalRequests: Number(estimate.estimatedExternalRequests) || 0,
    maximumExternalRequests: Number(estimate.maximumExternalRequests) || 0,
    unknownCapacity: Number(estimate.unknownCapacity) || 0,
    externalReuseDays: Number(estimate.externalReuseDays) || 14,
    maxExternalRequestsPerRun: Number(estimate.maxExternalRequestsPerRun) || 100,
    monthlyRemaining: Number(estimate.monthlyRemaining) || 0,
    provider: estimate.provider as ClientSiteCrawlProvider || 'auto',
    forceExternalRefresh: estimate.forceExternalRefresh === true,
  };
};

export const cancelClientSiteCrawl = async (
  clientId: string,
  runId: string,
): Promise<ClientSiteCrawlRun> => {
  const payload = await requestClientSiteCrawler(clientId, {
    method: 'POST',
    body: {
      action: 'cancel',
      runId,
    },
  });
  return mapRun(payload.run);
};
