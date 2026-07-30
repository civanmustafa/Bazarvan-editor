export const CRAWLER_EXTERNAL_PROVIDERS = ['firecrawl', 'browserless'] as const;
export type CrawlerExternalProvider = (typeof CRAWLER_EXTERNAL_PROVIDERS)[number];

export const CLIENT_SITE_CRAWL_PROVIDERS = [
  'auto',
  'local',
  ...CRAWLER_EXTERNAL_PROVIDERS,
] as const;
export type ClientSiteCrawlProvider = (typeof CLIENT_SITE_CRAWL_PROVIDERS)[number];

export const CRAWLER_PROVIDER_SECRETS_MIGRATION =
  '20260730010000_crawler_provider_secrets.sql';
export const CLIENT_CENTER_HYBRID_CRAWLER_MIGRATION =
  '20260730020000_hybrid_client_site_crawler.sql';
export const CRAWLER_PROVIDER_USAGE_REPORTS_MIGRATION =
  '20260730030000_crawler_provider_usage_reports.sql';

export const isCrawlerExternalProvider = (
  value: unknown,
): value is CrawlerExternalProvider => (
  typeof value === 'string'
  && CRAWLER_EXTERNAL_PROVIDERS.includes(value as CrawlerExternalProvider)
);

export const normalizeClientSiteCrawlProvider = (
  value: unknown,
): ClientSiteCrawlProvider => (
  typeof value === 'string'
  && CLIENT_SITE_CRAWL_PROVIDERS.includes(value as ClientSiteCrawlProvider)
    ? value as ClientSiteCrawlProvider
    : 'auto'
);
