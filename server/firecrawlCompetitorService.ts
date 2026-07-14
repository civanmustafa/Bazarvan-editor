import { isIP } from 'node:net';
import {
  COMPETITOR_CONTENT_MAX_CHARS,
  COMPETITOR_SEARCH_CANDIDATE_LIMIT,
  COMPETITOR_SEARCH_RESULT_LIMIT,
} from '../constants/competitors.ts';

export type CompetitorSearchResult = {
  url: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  description: string;
  position: number;
};

export type ScrapedCompetitorContent = {
  url: string;
  canonicalUrl: string;
  fetchedUrl: string;
  domain: string;
  title: string;
  description: string;
  headings: {
    h1: string[];
    h2: string[];
    h3: string[];
  };
  text: string;
  wordCount: number;
};

export class FirecrawlCompetitorError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    status?: number;
    code?: string;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = 'FirecrawlCompetitorError';
    this.status = options.status ?? 502;
    this.code = options.code ?? 'firecrawl_request_failed';
    this.retryable = options.retryable ?? (
      this.status === 408 || this.status === 429 || this.status >= 500
    );
  }
}

const TRACKING_QUERY_KEYS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
]);

const PRIVATE_HOST_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.aws.internal',
]);

const isPrivateIpv4 = (value: string): boolean => {
  const octets = value.split('.').map(part => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some(part => !Number.isFinite(part) || part < 0 || part > 255)) return true;
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
};

const isPrivateIpv6 = (value: string): boolean => {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
};

export const canonicalizeCompetitorUrl = (value: string): string => {
  const raw = value.trim();
  if (!raw || raw.length > 2_048) {
    throw new FirecrawlCompetitorError({
      message: 'Competitor URL is empty or too long.',
      status: 400,
      code: 'invalid_competitor_url',
      retryable: false,
    });
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FirecrawlCompetitorError({
      message: 'Competitor URL is invalid.',
      status: 400,
      code: 'invalid_competitor_url',
      retryable: false,
    });
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new FirecrawlCompetitorError({
      message: 'Only public HTTP and HTTPS competitor URLs are allowed.',
      status: 400,
      code: 'unsafe_competitor_url',
      retryable: false,
    });
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const ipVersion = isIP(hostname);
  const privateAddress = ipVersion === 4
    ? isPrivateIpv4(hostname)
    : ipVersion === 6
      ? isPrivateIpv6(hostname)
      : false;
  const privateName = PRIVATE_HOST_NAMES.has(hostname)
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
    || !hostname.includes('.');
  if (privateAddress || privateName) {
    throw new FirecrawlCompetitorError({
      message: 'Private or local competitor URLs are not allowed.',
      status: 400,
      code: 'unsafe_competitor_url',
      retryable: false,
    });
  }

  url.hash = '';
  url.hostname = hostname;
  url.searchParams.forEach((_, key) => {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  });
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
};

const toRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const getFirecrawlConfiguration = (): { apiKey: string; baseUrl: string } => {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || '').trim();
  if (!apiKey) {
    throw new FirecrawlCompetitorError({
      message: 'FIRECRAWL_API_KEY is not configured on the server.',
      status: 503,
      code: 'firecrawl_not_configured',
      retryable: true,
    });
  }
  const baseUrl = String(process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev')
    .trim()
    .replace(/\/+$/, '');
  return { apiKey, baseUrl };
};

export const isFirecrawlConfigured = (): boolean => Boolean(process.env.FIRECRAWL_API_KEY?.trim());

const firecrawlRequest = async (
  path: string,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> => {
  const { apiKey, baseUrl } = getFirecrawlConfiguration();
  const controller = new AbortController();
  const timeoutMs = Math.max(5_000, Math.min(options.timeoutMs ?? 70_000, 120_000));
  const timeout = setTimeout(() => controller.abort(new Error('Firecrawl request timed out.')), timeoutMs);
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromParent, { once: true });

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    const normalized = toRecord(payload);
    if (!response.ok || normalized.success === false) {
      const providerMessage = toText(normalized.error)
        || toText(toRecord(normalized.error).message)
        || toText(normalized.message)
        || `Firecrawl request failed with HTTP ${response.status}.`;
      throw new FirecrawlCompetitorError({
        message: providerMessage.slice(0, 1_000),
        status: response.status || 502,
        code: response.status === 429 ? 'firecrawl_quota_exceeded' : `firecrawl_http_${response.status || 502}`,
      });
    }
    return normalized;
  } catch (error) {
    if (error instanceof FirecrawlCompetitorError) throw error;
    if (controller.signal.aborted) {
      throw new FirecrawlCompetitorError({
        message: options.signal?.aborted ? 'Competitor extraction was cancelled.' : 'Firecrawl request timed out.',
        status: options.signal?.aborted ? 499 : 504,
        code: options.signal?.aborted ? 'competitor_extraction_cancelled' : 'firecrawl_timeout',
        retryable: !options.signal?.aborted,
      });
    }
    throw new FirecrawlCompetitorError({
      message: error instanceof Error ? error.message.slice(0, 1_000) : 'Could not connect to Firecrawl.',
      status: 502,
      code: 'firecrawl_network_error',
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
};

const readSearchItems = (payload: Record<string, unknown>): unknown[] => {
  const data = payload.data;
  if (Array.isArray(data)) return data;
  const dataRecord = toRecord(data);
  if (Array.isArray(dataRecord.web)) return dataRecord.web;
  if (Array.isArray(payload.web)) return payload.web;
  return [];
};

export const searchCompetitorWeb = async (options: {
  query: string;
  limit?: number;
  country?: string;
  location?: string;
  excludeDomains?: string[];
  signal?: AbortSignal;
}): Promise<CompetitorSearchResult[]> => {
  const query = options.query.trim();
  if (query.length < 2 || query.length > 300) {
    throw new FirecrawlCompetitorError({
      message: 'Search query must contain between 2 and 300 characters.',
      status: 400,
      code: 'invalid_competitor_query',
      retryable: false,
    });
  }
  const limit = Math.max(1, Math.min(
    options.limit ?? COMPETITOR_SEARCH_RESULT_LIMIT,
    COMPETITOR_SEARCH_CANDIDATE_LIMIT,
  ));
  const country = /^[a-z]{2}$/i.test(options.country?.trim() || '')
    ? options.country!.trim().toUpperCase()
    : '';
  const location = options.location?.trim().slice(0, 160) || '';
  const excludeDomains = Array.from(new Set((options.excludeDomains || [])
    .map(domain => domain.trim().toLowerCase().replace(/^www\./, ''))
    .filter(domain => /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(domain))))
    .slice(0, 20);
  const payload = await firecrawlRequest('/v2/search', {
    query,
    limit,
    sources: ['web'],
    timeout: 45_000,
    ignoreInvalidURLs: true,
    ...(country ? { country } : {}),
    ...(location ? { location } : {}),
    ...(excludeDomains.length > 0 ? { excludeDomains } : {}),
  }, { signal: options.signal, timeoutMs: 45_000 });

  const seenUrls = new Set<string>();
  const seenDomains = new Set<string>();
  const results: CompetitorSearchResult[] = [];
  readSearchItems(payload).forEach((item, index) => {
    const row = toRecord(item);
    const rawUrl = toText(row.url) || toText(row.link);
    if (!rawUrl) return;
    try {
      const canonicalUrl = canonicalizeCompetitorUrl(rawUrl);
      if (new URL(canonicalUrl).pathname.toLowerCase().endsWith('.pdf')) return;
      const domain = new URL(canonicalUrl).hostname.replace(/^www\./i, '');
      if (seenUrls.has(canonicalUrl) || seenDomains.has(domain)) return;
      seenUrls.add(canonicalUrl);
      seenDomains.add(domain);
      results.push({
        url: rawUrl,
        canonicalUrl,
        domain,
        title: (toText(row.title) || domain).slice(0, 500),
        description: (toText(row.description) || toText(row.snippet)).slice(0, 2_000),
        position: Number.isFinite(Number(row.position)) ? Number(row.position) : index + 1,
      });
    } catch {
      // Search providers can return unsupported schemes or local URLs; omit them.
    }
  });
  return results.slice(0, limit);
};

const markdownHeadings = (markdown: string, level: 1 | 2 | 3): string[] => {
  const expression = new RegExp(`^#{${level}}(?!#)\\s+(.+)$`, 'gm');
  return Array.from(markdown.matchAll(expression))
    .map(match => (match[1] || '').replace(/[*_`~]/g, '').trim())
    .filter(Boolean)
    .slice(0, 80);
};

export const markdownToCompetitorText = (markdown: string): string => markdown
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^\s*[-*+]\s+/gm, '')
  .replace(/^\s*\d+[.)]\s+/gm, '')
  .replace(/[>*_`~|]/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
  .slice(0, COMPETITOR_CONTENT_MAX_CHARS);

export const scrapeCompetitorWeb = async (options: {
  url: string;
  signal?: AbortSignal;
}): Promise<ScrapedCompetitorContent> => {
  const canonicalUrl = canonicalizeCompetitorUrl(options.url);
  const payload = await firecrawlRequest('/v2/scrape', {
    url: canonicalUrl,
    formats: ['markdown'],
    onlyMainContent: true,
    maxAge: 172_800_000,
    timeout: 60_000,
    parsers: [],
  }, { signal: options.signal, timeoutMs: 75_000 });
  const data = toRecord(payload.data);
  const metadata = toRecord(data.metadata);
  const markdown = toText(data.markdown) || toText(data.content);
  const text = markdownToCompetitorText(markdown);
  if (!text) {
    throw new FirecrawlCompetitorError({
      message: 'The selected page did not return readable main content.',
      status: 422,
      code: 'competitor_content_empty',
      retryable: false,
    });
  }
  const fetchedRaw = toText(metadata.sourceURL) || toText(metadata.url) || canonicalUrl;
  let fetchedUrl = canonicalUrl;
  try {
    fetchedUrl = canonicalizeCompetitorUrl(fetchedRaw);
  } catch {
    fetchedUrl = canonicalUrl;
  }
  return {
    url: canonicalUrl,
    canonicalUrl,
    fetchedUrl,
    domain: new URL(canonicalUrl).hostname.replace(/^www\./i, ''),
    title: (toText(metadata.title) || new URL(canonicalUrl).hostname).slice(0, 500),
    description: toText(metadata.description).slice(0, 2_000),
    headings: {
      h1: markdownHeadings(markdown, 1),
      h2: markdownHeadings(markdown, 2),
      h3: markdownHeadings(markdown, 3),
    },
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
};
