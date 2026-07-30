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
  links: ClientInternalLink[];
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
