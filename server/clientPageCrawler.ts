import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { CLIENT_LINK_AI_EXCERPT_MAX_CHARACTERS } from '../utils/clientLinkPhraseProfile.ts';

export type AllowedClientDomain = {
  hostname: string;
  includeSubdomains: boolean;
};

export type ExtractedClientPageLink = {
  targetUrl: string;
  anchorText: string;
  relNofollow: boolean;
  relSponsored: boolean;
  relUgc: boolean;
  crawlable: boolean;
  occurrenceCount: number;
};

export type ClientPageCrawlResult = {
  finalUrl: string;
  canonicalUrl: string;
  httpStatus: number;
  pageTitle: string;
  metaDescription: string;
  h1: string;
  h2: string[];
  h3: string[];
  slug: string;
  pageLanguage: string;
  robotsIndex: boolean;
  robotsFollow: boolean;
  contentHash: string;
  extractedTerms: string[];
  extractedPhrases: string[];
  contentExcerpt?: string;
  wordCount: number;
  responseContentType: string;
  redirectCount: number;
  crawlDurationMs: number;
  internalLinks: ExtractedClientPageLink[];
};

export class ClientPageCrawlerError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(options: {
    message: string;
    code: string;
    retryable?: boolean;
    status?: number;
  }) {
    super(options.message);
    this.name = 'ClientPageCrawlerError';
    this.code = options.code.slice(0, 120);
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? 502;
  }
}

const PRIVATE_HOST_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.aws.internal',
  'metadata.azure.internal',
]);

const TRACKING_QUERY_KEYS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
]);

const NON_HTML_PATH_EXTENSION = /\.(?:7z|avi|avif|bmp|csv|doc|docx|epub|gif|gz|ico|jpe?g|m4a|m4v|mov|mp3|mp4|mpeg|odp|ods|odt|pdf|png|ppt|pptx|rar|rss|svg|tar|tiff?|txt|wav|webm|webp|xls|xlsx|xml|zip)$/i;

const ARABIC_STOP_WORDS = new Set([
  'في', 'من', 'إلى', 'الى', 'على', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك', 'هو', 'هي', 'هم',
  'ثم', 'أو', 'او', 'و', 'ف', 'ب', 'ك', 'ل', 'التي', 'الذي', 'الذين', 'أن', 'ان', 'إن', 'كان',
  'كانت', 'يكون', 'يمكن', 'كل', 'كما', 'ما', 'لا', 'لم', 'لن', 'قد', 'بعد', 'قبل', 'بين', 'عند',
  'حتى', 'إذا', 'اذا', 'أكثر', 'اقل', 'أقل', 'أي', 'اي', 'عبر', 'ضمن', 'حول', 'هناك', 'هنا',
]);

const LATIN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'how', 'in',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'we', 'what', 'when',
  'where', 'which', 'who', 'will', 'with', 'you', 'your',
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
    || (first === 192 && second === 0)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
};

const isPrivateIpv6 = (value: string): boolean => {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1') return true;
  if (
    normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
  ) return true;
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
};

const isPrivateAddress = (value: string): boolean => (
  isIP(value) === 4 ? isPrivateIpv4(value) : isIP(value) === 6 ? isPrivateIpv6(value) : true
);

const isHostnameAllowed = (hostname: string, domains: AllowedClientDomain[]): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return domains.some(domain => {
    const allowed = domain.hostname.toLowerCase().replace(/\.$/, '');
    return normalized === allowed || (domain.includeSubdomains && normalized.endsWith(`.${allowed}`));
  });
};

export const sanitizeDiscoveredClientUrl = (
  value: string,
  fallback: string,
  domains: AllowedClientDomain[],
): string => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || !isHostnameAllowed(hostname, domains)
    ) {
      return fallback;
    }
    url.hash = '';
    url.hostname = hostname;
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().slice(0, 2_048);
  } catch {
    return fallback;
  }
};

export const validatePublicClientUrl = async (
  value: string,
  domains: AllowedClientDomain[],
): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClientPageCrawlerError({
      code: 'invalid_client_page_url',
      message: 'The client page URL is invalid.',
      status: 400,
    });
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ClientPageCrawlerError({
      code: 'unsafe_client_page_url',
      message: 'Only public HTTP and HTTPS client page URLs are allowed.',
      status: 400,
    });
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !isHostnameAllowed(hostname, domains)
    || PRIVATE_HOST_NAMES.has(hostname)
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
    || !hostname.includes('.')
  ) {
    throw new ClientPageCrawlerError({
      code: 'client_page_domain_not_allowed',
      message: 'The page URL is outside the registered active domains for this client.',
      status: 403,
    });
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new ClientPageCrawlerError({
        code: 'unsafe_client_page_address',
        message: 'Private and reserved network addresses are not allowed.',
        status: 400,
      });
    }
  } else {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new ClientPageCrawlerError({
        code: 'client_page_dns_failed',
        message: error instanceof Error ? error.message : 'Could not resolve the client page hostname.',
        status: 502,
        retryable: true,
      });
    }
    if (addresses.length === 0 || addresses.some(result => isPrivateAddress(result.address))) {
      throw new ClientPageCrawlerError({
        code: 'unsafe_client_page_address',
        message: 'The client page hostname resolves to a private or reserved network address.',
        status: 400,
      });
    }
  }

  url.hash = '';
  url.hostname = hostname;
  for (const key of Array.from(url.searchParams.keys())) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  return url;
};

const readBoundedBody = async (response: Response, maximumBytes: number): Promise<Uint8Array> => {
  const declaredLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ClientPageCrawlerError({
      code: 'client_page_too_large',
      message: `The page exceeds the ${maximumBytes} byte crawl limit.`,
      status: 413,
    });
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ClientPageCrawlerError({
          code: 'client_page_too_large',
          message: `The page exceeds the ${maximumBytes} byte crawl limit.`,
          status: 413,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(chunk => {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return body;
};

const decodeBody = (body: Uint8Array, contentType: string): string => {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.trim() || 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
};

const decodeHtmlEntities = (value: string): string => {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    laquo: '«',
    raquo: '»',
    ndash: '–',
    mdash: '—',
  };
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_match, code) => {
      const point = Number.parseInt(code, 16);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    })
    .replace(/&#(\d+);?/g, (_match, code) => {
      const point = Number.parseInt(code, 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    })
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
};

const cleanText = (value: string, maximum = 10_000): string => (
  decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
);

const extractTagValues = (
  html: string,
  tagName: 'title' | 'h1' | 'h2' | 'h3',
  maximumItems = 80,
): string[] => {
  const expression = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'gi');
  const values: string[] = [];
  for (const match of html.matchAll(expression)) {
    const value = cleanText(match[1] || '', tagName === 'title' ? 500 : 1_000);
    if (value && !values.includes(value)) values.push(value);
    if (values.length >= maximumItems) break;
  }
  return values;
};

const parseAttributes = (tag: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const expression = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of tag.matchAll(expression)) {
    const name = (match[1] || '').toLowerCase();
    if (!name || name.startsWith('<') || name === 'meta' || name === 'link' || name === 'html') continue;
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
};

const extractMetaContent = (html: string, names: string[]): string => {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const name = (attributes.name || attributes.property || '').toLowerCase();
    if (wanted.has(name)) return cleanText(attributes.content || '', 2_000);
  }
  return '';
};

const extractCanonicalUrl = (html: string, baseUrl: string): string => {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const relations = (attributes.rel || '').toLowerCase().split(/\s+/);
    if (!relations.includes('canonical') || !attributes.href) continue;
    try {
      const canonical = new URL(attributes.href, baseUrl);
      if (!['http:', 'https:'].includes(canonical.protocol) || canonical.username || canonical.password) return '';
      canonical.hash = '';
      return canonical.toString().slice(0, 2_048);
    } catch {
      return '';
    }
  }
  return '';
};

const extractHtmlLanguage = (html: string): string => {
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] || '';
  const value = parseAttributes(htmlTag).lang?.trim().toLowerCase() || '';
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(value) ? value : '';
};

const extractVisibleText = (html: string): string => cleanText(
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' '),
  500_000,
);

export const buildClientLinkAiContentExcerpt = (
  visibleText: string,
  maximumCharacters = CLIENT_LINK_AI_EXCERPT_MAX_CHARACTERS,
): string => {
  const maximum = Math.max(2_000, Math.min(maximumCharacters, 40_000));
  const normalized = visibleText.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maximum) return normalized;

  const separator = '\n\n[…]\n\n';
  const available = maximum - (separator.length * 2);
  const headLength = Math.floor(available * 0.5);
  const middleLength = Math.floor(available * 0.25);
  const tailLength = available - headLength - middleLength;
  const middleStart = Math.max(
    headLength,
    Math.floor((normalized.length - middleLength) / 2),
  );
  return [
    normalized.slice(0, headLength),
    normalized.slice(middleStart, middleStart + middleLength),
    normalized.slice(-tailLength),
  ].join(separator);
};

const normalizeToken = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[\u064b-\u065f\u0670\u06d6-\u06ed]/g, '')
  .replace(/[إأآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه')
  .trim();

const tokenize = (value: string): string[] => (
  value
    .match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]{1,49}/gu)
    ?.map(normalizeToken)
    .filter(token => (
      token.length >= 2
      && !ARABIC_STOP_WORDS.has(token)
      && !LATIN_STOP_WORDS.has(token)
      && !/^\d+$/.test(token)
    )) || []
);

const rankFrequent = (values: string[], maximum: number): string[] => {
  const counts = new Map<string, number>();
  values.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, maximum)
    .map(([value]) => value);
};

const extractTermsAndPhrases = (visibleText: string): {
  terms: string[];
  phrases: string[];
  wordCount: number;
} => {
  const rawWords = visibleText.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu) || [];
  const tokens = tokenize(visibleText);
  const phrases: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
    if (index < tokens.length - 2) phrases.push(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`);
  }
  return {
    terms: rankFrequent(tokens, 80),
    phrases: rankFrequent(phrases, 60),
    wordCount: rawWords.length,
  };
};

const inferLanguage = (visibleText: string): string => {
  const sample = visibleText.slice(0, 20_000);
  const arabicCount = (sample.match(/[\u0600-\u06ff]/g) || []).length;
  const latinCount = (sample.match(/[a-z]/gi) || []).length;
  if (arabicCount > latinCount * 0.25) return 'ar';
  if (latinCount > 0) return 'en';
  return '';
};

const parseRobots = (value: string): { index: boolean; follow: boolean } => {
  const directives = new Set(value.toLowerCase().split(/[\s,;]+/).filter(Boolean));
  return {
    index: !directives.has('noindex') && !directives.has('none'),
    follow: !directives.has('nofollow') && !directives.has('none'),
  };
};

export const extractClientPageLinksFromHtml = (options: {
  html: string;
  finalUrl: string;
  domains: AllowedClientDomain[];
  maximumLinks?: number;
}): ExtractedClientPageLink[] => {
  const maximumLinks = Math.max(1, Math.min(options.maximumLinks ?? 1_000, 2_000));
  const links = new Map<string, ExtractedClientPageLink>();
  const expression = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

  for (const match of options.html.matchAll(expression)) {
    const attributes = parseAttributes(`<a ${match[1] || ''}>`);
    const rawHref = attributes.href?.trim() || '';
    if (!rawHref || rawHref.startsWith('#')) continue;

    let resolvedUrl = '';
    try {
      resolvedUrl = sanitizeDiscoveredClientUrl(
        new URL(rawHref, options.finalUrl).toString(),
        '',
        options.domains,
      );
    } catch {
      continue;
    }
    if (!resolvedUrl) continue;

    const relations = new Set(
      (attributes.rel || '').toLowerCase().split(/[\s,]+/).filter(Boolean),
    );
    const anchorText = cleanText(match[2] || '', 500);
    const target = new URL(resolvedUrl);
    const crawlable = !NON_HTML_PATH_EXTENSION.test(target.pathname);
    const key = [
      resolvedUrl,
      anchorText,
      relations.has('nofollow') ? '1' : '0',
      relations.has('sponsored') ? '1' : '0',
      relations.has('ugc') ? '1' : '0',
    ].join('\n');
    const existing = links.get(key);
    if (existing) {
      existing.occurrenceCount = Math.min(10_000, existing.occurrenceCount + 1);
      continue;
    }

    links.set(key, {
      targetUrl: resolvedUrl,
      anchorText,
      relNofollow: relations.has('nofollow'),
      relSponsored: relations.has('sponsored'),
      relUgc: relations.has('ugc'),
      crawlable,
      occurrenceCount: 1,
    });
    if (links.size >= maximumLinks) break;
  }

  return [...links.values()];
};

export const extractClientPageMetadataFromHtml = (options: {
  html: string;
  finalUrl: string;
  httpStatus: number;
  responseContentType: string;
  redirectCount?: number;
  crawlDurationMs?: number;
}): ClientPageCrawlResult => {
  const finalUrl = new URL(options.finalUrl);
  const title = extractTagValues(options.html, 'title', 1)[0] || '';
  const h1 = extractTagValues(options.html, 'h1', 1)[0] || '';
  const h2 = extractTagValues(options.html, 'h2');
  const h3 = extractTagValues(options.html, 'h3');
  const visibleText = extractVisibleText(options.html);
  const terms = extractTermsAndPhrases(visibleText);
  const robots = parseRobots(extractMetaContent(options.html, ['robots', 'googlebot', 'bingbot']));
  const htmlLanguage = extractHtmlLanguage(options.html);
  const canonicalUrl = extractCanonicalUrl(options.html, finalUrl.toString()) || finalUrl.toString();
  let slug = finalUrl.pathname;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Keep the encoded path when a remote page contains malformed escape sequences.
  }

  return {
    finalUrl: finalUrl.toString().slice(0, 2_048),
    canonicalUrl,
    httpStatus: options.httpStatus,
    pageTitle: title,
    metaDescription: extractMetaContent(options.html, ['description', 'og:description', 'twitter:description']),
    h1,
    h2,
    h3,
    slug: slug.slice(0, 1_000),
    pageLanguage: htmlLanguage || inferLanguage(visibleText),
    robotsIndex: robots.index,
    robotsFollow: robots.follow,
    contentHash: createHash('sha256').update(visibleText).digest('hex'),
    extractedTerms: terms.terms,
    extractedPhrases: terms.phrases,
    contentExcerpt: buildClientLinkAiContentExcerpt(visibleText),
    wordCount: terms.wordCount,
    responseContentType: options.responseContentType.slice(0, 300),
    redirectCount: Math.max(0, Math.min(options.redirectCount || 0, 10)),
    crawlDurationMs: Math.max(0, options.crawlDurationMs || 0),
    internalLinks: [],
  };
};

const fetchClientPage = async (options: {
  url: string;
  domains: AllowedClientDomain[];
  signal?: AbortSignal;
  timeoutMs: number;
  maximumRedirects: number;
}): Promise<{
  response: Response;
  finalUrl: URL;
  redirects: number;
  cleanup: () => void;
}> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Client page crawl timed out.')), options.timeoutMs);
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromParent, { once: true });
  let handedOff = false;
  const cleanup = (): void => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromParent);
  };

  try {
    let currentUrl = await validatePublicClientUrl(options.url, options.domains);
    for (let redirects = 0; redirects <= options.maximumRedirects; redirects += 1) {
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
            'Accept-Language': 'ar,en;q=0.8',
            'User-Agent': process.env.CLIENT_PAGE_CRAWLER_USER_AGENT?.trim()
              || 'BazarvanClientCrawler/1.0 (+website metadata extraction)',
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ClientPageCrawlerError({
            code: options.signal?.aborted ? 'client_page_crawl_cancelled' : 'client_page_crawl_timeout',
            message: options.signal?.aborted ? 'The page crawl was cancelled.' : 'The page crawl timed out.',
            status: options.signal?.aborted ? 499 : 504,
            retryable: !options.signal?.aborted,
          });
        }
        throw new ClientPageCrawlerError({
          code: 'client_page_network_error',
          message: error instanceof Error ? error.message : 'Could not connect to the client page.',
          status: 502,
          retryable: true,
        });
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new ClientPageCrawlerError({
            code: 'client_page_redirect_missing_location',
            message: `The page returned HTTP ${response.status} without a redirect location.`,
            status: 502,
            retryable: false,
          });
        }
        if (redirects >= options.maximumRedirects) {
          throw new ClientPageCrawlerError({
            code: 'client_page_too_many_redirects',
            message: `The page exceeded the ${options.maximumRedirects} redirect limit.`,
            status: 508,
            retryable: false,
          });
        }
        currentUrl = await validatePublicClientUrl(new URL(location, currentUrl).toString(), options.domains);
        continue;
      }
      handedOff = true;
      return { response, finalUrl: currentUrl, redirects, cleanup };
    }
    throw new ClientPageCrawlerError({
      code: 'client_page_too_many_redirects',
      message: 'The page exceeded the redirect limit.',
      status: 508,
    });
  } finally {
    if (!handedOff) cleanup();
  }
};

export const crawlClientPage = async (options: {
  url: string;
  domains: AllowedClientDomain[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maximumBytes?: number;
}): Promise<ClientPageCrawlResult> => {
  const startedAt = Date.now();
  const maximumBytes = Math.max(100_000, Math.min(options.maximumBytes ?? 2_500_000, 5_000_000));
  const fetched = await fetchClientPage({
    url: options.url,
    domains: options.domains,
    signal: options.signal,
    timeoutMs: Math.max(5_000, Math.min(options.timeoutMs ?? 45_000, 120_000)),
    maximumRedirects: 5,
  });
  const { response, finalUrl, redirects } = fetched;
  try {
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      throw new ClientPageCrawlerError({
        code: `client_page_http_${response.status}`,
        message: `The client page returned retryable HTTP ${response.status}.`,
        status: response.status,
        retryable: true,
      });
    }

    const contentType = (response.headers.get('content-type') || '').slice(0, 300);
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new ClientPageCrawlerError({
        code: 'client_page_unsupported_content_type',
        message: `The URL did not return an HTML page (${contentType || 'unknown content type'}).`,
        status: 415,
      });
    }

    const body = await readBoundedBody(response, maximumBytes);
    const html = decodeBody(body, contentType);
    const extracted = extractClientPageMetadataFromHtml({
      html,
      finalUrl: finalUrl.toString(),
      httpStatus: response.status,
      responseContentType: contentType,
      redirectCount: redirects,
      crawlDurationMs: Date.now() - startedAt,
    });
    const headerRobots = parseRobots(response.headers.get('x-robots-tag') || '');
    return {
      ...extracted,
      canonicalUrl: sanitizeDiscoveredClientUrl(
        extracted.canonicalUrl,
        extracted.finalUrl,
        options.domains,
      ),
      robotsIndex: extracted.robotsIndex && headerRobots.index,
      robotsFollow: extracted.robotsFollow && headerRobots.follow,
      internalLinks: extractClientPageLinksFromHtml({
        html,
        finalUrl: finalUrl.toString(),
        domains: options.domains,
      }),
    };
  } finally {
    fetched.cleanup();
  }
};
