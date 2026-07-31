import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue.ts';

export type ProgrammaticCompetitorContent = {
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
  paragraphs: string[];
  listItems: string[];
  text: string;
  wordCount: number;
  contentHash: string;
  qualityScore: number;
  redirectCount: number;
  responseContentType: string;
  provider: 'programmatic';
  cacheHit: boolean;
  fetchedAt: string;
  expiresAt: string;
};

export class ProgrammaticCompetitorExtractionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    code: string;
    status?: number;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = 'ProgrammaticCompetitorExtractionError';
    this.code = options.code.slice(0, 120);
    this.status = options.status ?? 502;
    this.retryable = options.retryable ?? false;
  }
}

type ContentBlock = {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'li';
  text: string;
};

type CacheRow = {
  canonical_url: string;
  source_url: string;
  fetched_url: string;
  domain: string;
  title: string;
  description: string;
  headings: unknown;
  content_text: string;
  word_count: number;
  extraction_provider: string;
  fetched_at: string;
  expires_at: string;
};

const CACHE_TABLE = 'competitor_page_cache';
const CACHE_VERSION = 'programmatic-v1';
const CACHE_MAX_ITEMS = 100;
const CACHE_DEFAULT_HOURS = 24;
const MAX_CONTENT_TEXT_LENGTH = 120_000;
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
  'metadata.azure.internal',
]);
const NOISE_MARKER_PATTERN = /(^|[\s_-])(nav|navbar|menu|header|footer|sidebar|aside|widget|comment|comments|reply|share|social|breadcrumb|breadcrumbs|cookie|cookies|banner|advertisement|advert|ads|popup|modal|newsletter|subscribe|search|recent|popular|related|tagcloud|tags|category|categories|pagination|preloader|offcanvas|login|post-meta)([\s_-]|$)/i;
const BOILERPLATE_TEXT_PATTERN = /^(?:accept (?:all )?cookies?|cookie (?:settings|policy)|privacy policy|terms (?:of use|and conditions)|sign (?:in|up)|log in|subscribe|newsletter|share (?:this|on)|related (?:posts|articles)|read more|advertisement|إعدادات ملفات الارتباط|سياسة الخصوصية|الشروط والأحكام|تسجيل الدخول|اشترك|النشرة البريدية|شارك المقال|مقالات ذات صلة|اقرأ المزيد|إعلان)$/i;
const memoryCache = new Map<string, ProgrammaticCompetitorContent>();
let cacheWarningShown = false;

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
    hellip: '…',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
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

const normalizeText = (value: string, maximum = MAX_CONTENT_TEXT_LENGTH): string => (
  decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maximum)
);

const countWords = (value: string): number => (
  value.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu)?.length || 0
);

const parseAttributes = (tag: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const expression = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of tag.matchAll(expression)) {
    const name = (match[1] || '').toLowerCase();
    if (!name || name.startsWith('<')) continue;
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
};

const isPrivateIpv4 = (value: string): boolean => {
  const octets = value.split('.').map(part => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some(part => !Number.isFinite(part) || part < 0 || part > 255)) return true;
  const [first, second, third] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0 && third === 2)
    || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
    || (first === 203 && second === 0 && third === 113)
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
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8')
  ) return true;
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
};

export const isPrivateCompetitorAddress = (value: string): boolean => (
  isIP(value) === 4 ? isPrivateIpv4(value) : isIP(value) === 6 ? isPrivateIpv6(value) : true
);

export const normalizeProgrammaticCompetitorUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProgrammaticCompetitorExtractionError({
      code: 'invalid_competitor_url',
      message: 'The competitor URL is invalid.',
      status: 400,
    });
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || !hostname.includes('.')
    || PRIVATE_HOST_NAMES.has(hostname)
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
    || (isIP(hostname) > 0 && isPrivateCompetitorAddress(hostname))
  ) {
    throw new ProgrammaticCompetitorExtractionError({
      code: 'unsafe_competitor_url',
      message: 'Only public HTTP and HTTPS competitor URLs are allowed.',
      status: 400,
    });
  }
  url.hostname = hostname;
  url.hash = '';
  for (const key of Array.from(url.searchParams.keys())) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  return url.toString().slice(0, 2_048);
};

const validateResolvedPublicUrl = async (value: string): Promise<URL> => {
  const normalized = normalizeProgrammaticCompetitorUrl(value);
  const url = new URL(normalized);
  if (isIP(url.hostname)) return url;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new ProgrammaticCompetitorExtractionError({
      code: 'competitor_dns_failed',
      message: error instanceof Error ? error.message : 'Could not resolve the competitor hostname.',
      status: 502,
      retryable: true,
    });
  }
  if (addresses.length === 0 || addresses.some(result => isPrivateCompetitorAddress(result.address))) {
    throw new ProgrammaticCompetitorExtractionError({
      code: 'unsafe_competitor_address',
      message: 'The competitor hostname resolves to a private or reserved network address.',
      status: 400,
    });
  }
  return url;
};

const extractMetaContent = (html: string, names: string[]): string => {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const name = (attributes.name || attributes.property || '').toLowerCase();
    if (wanted.has(name)) return normalizeText(attributes.content || '', 2_000);
  }
  return '';
};

const extractCanonicalUrl = (html: string, fallbackUrl: string): string => {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const relations = (attributes.rel || '').toLowerCase().split(/\s+/);
    if (!relations.includes('canonical') || !attributes.href) continue;
    try {
      return normalizeProgrammaticCompetitorUrl(new URL(attributes.href, fallbackUrl).toString());
    } catch {
      return fallbackUrl;
    }
  }
  return fallbackUrl;
};

const extractLongestElementBody = (html: string, tagName: 'article' | 'main' | 'body'): string => {
  const candidates = [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'gi'))]
    .map(match => match[1] || '')
    .filter(Boolean);
  return candidates.sort((left, right) => normalizeText(right).length - normalizeText(left).length)[0] || '';
};

const stripNoiseElements = (value: string): string => {
  let html = value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(header|footer|nav|aside|form|dialog)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

  for (let pass = 0; pass < 4; pass += 1) {
    html = html.replace(/<(div|section|ul|ol)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, match => {
      const openingTag = match.match(/^<[^>]+>/)?.[0] || '';
      const attributes = parseAttributes(openingTag);
      const marker = [
        attributes.id || '',
        attributes.class || '',
        attributes.role || '',
        attributes['aria-label'] || '',
      ].join(' ');
      return NOISE_MARKER_PATTERN.test(marker) ? ' ' : match;
    });
  }
  return html;
};

const collectContentBlocks = (html: string): ContentBlock[] => {
  const blocks: ContentBlock[] = [];
  const seen = new Set<string>();
  const expression = /<(h1|h2|h3|p|li)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of html.matchAll(expression)) {
    const type = match[1].toLowerCase() as ContentBlock['type'];
    const raw = match[2] || '';
    const text = normalizeText(raw, type.startsWith('h') ? 1_000 : 12_000);
    if (!text || text.length < 2 || BOILERPLATE_TEXT_PATTERN.test(text)) continue;
    const words = countWords(text);
    if (type === 'p' && text.length < 24 && words < 5) continue;
    if (type === 'li' && text.length < 8 && words < 3) continue;
    const fullLength = Math.max(1, normalizeText(raw).length);
    const linkLength = [...raw.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)]
      .reduce((sum, link) => sum + normalizeText(link[1] || '').length, 0);
    if ((type === 'p' || type === 'li') && linkLength / fullLength > 0.65) continue;
    const duplicateKey = text.toLocaleLowerCase();
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    blocks.push({ type, text });
    if (blocks.length >= 240) break;
  }
  return blocks;
};

const findArticleBodyInJson = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    return value.map(findArticleBodyInJson).sort((a, b) => b.length - a.length)[0] || '';
  }
  const record = value as Record<string, unknown>;
  if (typeof record.articleBody === 'string' && normalizeText(record.articleBody).length >= 120) {
    return normalizeText(record.articleBody);
  }
  return Object.values(record).map(findArticleBodyInJson).sort((a, b) => b.length - a.length)[0] || '';
};

const extractJsonLdArticleBody = (html: string): string => {
  const bodies: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      const parsed = JSON.parse(decodeHtmlEntities(match[1] || '').trim());
      const body = findArticleBodyInJson(parsed);
      if (body) bodies.push(body);
    } catch {
      // Invalid structured data must not prevent extraction from visible HTML.
    }
  }
  return bodies.sort((left, right) => right.length - left.length)[0] || '';
};

const splitFallbackParagraphs = (value: string): string[] => (
  value
    .split(/\n{2,}|(?<=[.!?؟])\s+(?=[\p{Lu}\u0600-\u06ff])/gu)
    .map(item => normalizeText(item, 12_000))
    .filter(item => item.length >= 24 && countWords(item) >= 5)
    .slice(0, 120)
);

export const extractProgrammaticCompetitorContentFromHtml = (options: {
  html: string;
  sourceUrl: string;
  finalUrl?: string;
  responseContentType?: string;
  redirectCount?: number;
}): ProgrammaticCompetitorContent => {
  const sourceUrl = normalizeProgrammaticCompetitorUrl(options.sourceUrl);
  const fetchedUrl = normalizeProgrammaticCompetitorUrl(options.finalUrl || sourceUrl);
  const canonicalUrl = extractCanonicalUrl(options.html, fetchedUrl);
  const titleTag = options.html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '';
  const title = normalizeText(
    titleTag
    || extractMetaContent(options.html, ['og:title', 'twitter:title']),
    500,
  );
  const description = extractMetaContent(options.html, [
    'description',
    'og:description',
    'twitter:description',
  ]);
  const articleRoot = extractLongestElementBody(options.html, 'article');
  const mainRoot = extractLongestElementBody(options.html, 'main');
  const bodyRoot = extractLongestElementBody(options.html, 'body') || options.html;
  const selectedRoot = normalizeText(articleRoot).length >= 120
    ? articleRoot
    : normalizeText(mainRoot).length >= 120
      ? mainRoot
      : bodyRoot;
  let blocks = collectContentBlocks(stripNoiseElements(selectedRoot));
  const structuredBody = extractJsonLdArticleBody(options.html);
  const blockTextLength = blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (structuredBody.length > blockTextLength * 1.25) {
    const headingBlocks = blocks.filter(block => block.type.startsWith('h'));
    blocks = [
      ...headingBlocks,
      ...splitFallbackParagraphs(structuredBody).map(text => ({ type: 'p' as const, text })),
    ];
  }

  const headings = {
    h1: blocks.filter(block => block.type === 'h1').map(block => block.text).slice(0, 8),
    h2: blocks.filter(block => block.type === 'h2').map(block => block.text).slice(0, 40),
    h3: blocks.filter(block => block.type === 'h3').map(block => block.text).slice(0, 40),
  };
  const paragraphs = blocks.filter(block => block.type === 'p').map(block => block.text).slice(0, 120);
  const listItems = blocks.filter(block => block.type === 'li').map(block => block.text).slice(0, 120);
  const text = blocks.map(block => block.text).join('\n\n').slice(0, MAX_CONTENT_TEXT_LENGTH).trim();
  const wordCount = countWords(text);
  if (wordCount < 25 || text.length < 120 || paragraphs.length === 0) {
    throw new ProgrammaticCompetitorExtractionError({
      code: 'programmatic_content_not_found',
      message: 'No sufficiently clear editorial content was found in the downloaded HTML.',
      status: 422,
    });
  }
  const qualityScore = Math.max(1, Math.min(100, Math.round(
    Math.min(wordCount / 5, 45)
    + Math.min(paragraphs.length * 3, 20)
    + Math.min((headings.h1.length + headings.h2.length + headings.h3.length) * 4, 15)
    + (title ? 10 : 0)
    + (description ? 10 : 0),
  )));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_DEFAULT_HOURS * 60 * 60 * 1000);

  return {
    url: sourceUrl,
    canonicalUrl,
    fetchedUrl,
    domain: new URL(canonicalUrl).hostname,
    title: title || headings.h1[0] || '',
    description,
    headings,
    paragraphs,
    listItems,
    text,
    wordCount,
    contentHash: createHash('sha256').update(text).digest('hex'),
    qualityScore,
    redirectCount: Math.max(0, Math.min(options.redirectCount || 0, 10)),
    responseContentType: (options.responseContentType || 'text/html').slice(0, 300),
    provider: 'programmatic',
    cacheHit: false,
    fetchedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
};

const readBoundedBody = async (response: Response, maximumBytes: number): Promise<Uint8Array> => {
  const declaredLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ProgrammaticCompetitorExtractionError({
      code: 'competitor_page_too_large',
      message: `The competitor page exceeds the ${maximumBytes} byte extraction limit.`,
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
        throw new ProgrammaticCompetitorExtractionError({
          code: 'competitor_page_too_large',
          message: `The competitor page exceeds the ${maximumBytes} byte extraction limit.`,
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

export type ProgrammaticHtmlDocument = {
  html: string;
  finalUrl: string;
  contentType: string;
  redirects: number;
};

export const fetchProgrammaticHtml = async (options: {
  url: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
}): Promise<ProgrammaticHtmlDocument> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Programmatic competitor extraction timed out.')),
    options.timeoutMs,
  );
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    let currentUrl = await validateResolvedPublicUrl(options.url);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
            'Accept-Language': 'ar,en;q=0.8',
            'User-Agent': process.env.COMPETITOR_PROGRAMMATIC_USER_AGENT?.trim()
              || 'BazarvanCompetitorExtractor/1.0 (+editorial content extraction)',
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ProgrammaticCompetitorExtractionError({
            code: options.signal?.aborted ? 'programmatic_extraction_cancelled' : 'programmatic_extraction_timeout',
            message: options.signal?.aborted
              ? 'Programmatic competitor extraction was cancelled.'
              : 'Programmatic competitor extraction timed out.',
            status: options.signal?.aborted ? 499 : 504,
            retryable: !options.signal?.aborted,
          });
        }
        throw new ProgrammaticCompetitorExtractionError({
          code: 'programmatic_extraction_network_error',
          message: error instanceof Error ? error.message : 'Could not connect to the competitor page.',
          status: 502,
          retryable: true,
        });
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects >= 5) {
          throw new ProgrammaticCompetitorExtractionError({
            code: location ? 'programmatic_extraction_too_many_redirects' : 'programmatic_extraction_redirect_missing',
            message: location
              ? 'The competitor page exceeded the redirect limit.'
              : 'The competitor page returned a redirect without a destination.',
            status: location ? 508 : 502,
          });
        }
        currentUrl = await validateResolvedPublicUrl(new URL(location, currentUrl).toString());
        continue;
      }
      if (!response.ok) {
        throw new ProgrammaticCompetitorExtractionError({
          code: `programmatic_extraction_http_${response.status}`,
          message: `The competitor page returned HTTP ${response.status}.`,
          status: response.status,
          retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
        });
      }
      const contentType = (response.headers.get('content-type') || '').slice(0, 300);
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        throw new ProgrammaticCompetitorExtractionError({
          code: 'programmatic_extraction_unsupported_content_type',
          message: `The competitor URL did not return an HTML page (${contentType || 'unknown content type'}).`,
          status: 415,
        });
      }
      const body = await readBoundedBody(response, options.maximumBytes);
      return {
        html: decodeBody(body, contentType),
        finalUrl: currentUrl.toString(),
        contentType,
        redirects,
      };
    }
    throw new ProgrammaticCompetitorExtractionError({
      code: 'programmatic_extraction_too_many_redirects',
      message: 'The competitor page exceeded the redirect limit.',
      status: 508,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
};

const cacheKeyForUrl = (url: string): string => (
  createHash('sha256').update(`${CACHE_VERSION}:${url}`).digest('hex')
);

const getCacheHours = (): number => {
  const parsed = Number.parseInt(process.env.COMPETITOR_PROGRAMMATIC_CACHE_HOURS || '', 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 168)) : CACHE_DEFAULT_HOURS;
};

const toHeadings = (value: unknown): ProgrammaticCompetitorContent['headings'] => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const list = (items: unknown, maximum: number): string[] => (
    Array.isArray(items)
      ? items.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean).slice(0, maximum)
      : []
  );
  return {
    h1: list(source.h1, 8),
    h2: list(source.h2, 40),
    h3: list(source.h3, 40),
  };
};

const rowToContent = (row: CacheRow): ProgrammaticCompetitorContent => {
  const text = row.content_text || '';
  const headings = toHeadings(row.headings);
  return {
    url: row.source_url,
    canonicalUrl: row.canonical_url,
    fetchedUrl: row.fetched_url,
    domain: row.domain,
    title: row.title || '',
    description: row.description || '',
    headings,
    paragraphs: text.split(/\n{2,}/).map(item => item.trim()).filter(Boolean).slice(0, 120),
    listItems: [],
    text,
    wordCount: Math.max(0, Number(row.word_count) || countWords(text)),
    contentHash: createHash('sha256').update(text).digest('hex'),
    qualityScore: Math.max(1, Math.min(100, Math.round(
      Math.min((Number(row.word_count) || 0) / 5, 65)
      + Math.min((headings.h1.length + headings.h2.length + headings.h3.length) * 4, 15)
      + (row.title ? 10 : 0)
      + (row.description ? 10 : 0),
    ))),
    redirectCount: 0,
    responseContentType: 'text/html',
    provider: 'programmatic',
    cacheHit: true,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  };
};

const readCachedContent = async (url: string): Promise<ProgrammaticCompetitorContent | null> => {
  const key = cacheKeyForUrl(url);
  const memory = memoryCache.get(key);
  if (memory && Date.parse(memory.expiresAt) > Date.now()) {
    memoryCache.delete(key);
    memoryCache.set(key, memory);
    return { ...memory, cacheHit: true };
  }
  if (memory) memoryCache.delete(key);
  try {
    const { data, error } = await getExternalAnalysisSupabaseAdmin()
      .from(CACHE_TABLE)
      .select('canonical_url,source_url,fetched_url,domain,title,description,headings,content_text,word_count,extraction_provider,fetched_at,expires_at')
      .eq('cache_key', key)
      .eq('extraction_provider', 'programmatic')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error || !data) {
      if (error && !cacheWarningShown && error.code !== '42P01' && error.code !== 'PGRST205') {
        cacheWarningShown = true;
        console.warn('[programmatic-competitor-cache] read failed; continuing without persistent cache.', {
          code: error.code || 'unknown',
        });
      }
      return null;
    }
    const content = rowToContent(data as CacheRow);
    memoryCache.set(key, content);
    return content;
  } catch {
    return null;
  }
};

const saveCachedContent = async (
  requestUrl: string,
  content: ProgrammaticCompetitorContent,
): Promise<void> => {
  const key = cacheKeyForUrl(requestUrl);
  memoryCache.set(key, content);
  while (memoryCache.size > CACHE_MAX_ITEMS) {
    const oldestKey = memoryCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    memoryCache.delete(oldestKey);
  }
  try {
    const { error } = await getExternalAnalysisSupabaseAdmin()
      .from(CACHE_TABLE)
      .upsert({
        cache_key: key,
        canonical_url: content.canonicalUrl,
        source_url: content.url,
        fetched_url: content.fetchedUrl,
        domain: content.domain,
        title: content.title.slice(0, 500),
        description: content.description.slice(0, 2_000),
        headings: content.headings,
        content_text: content.text.slice(0, MAX_CONTENT_TEXT_LENGTH),
        word_count: content.wordCount,
        extraction_provider: 'programmatic',
        provider_key_suffix: 'local-v1',
        fetched_at: content.fetchedAt,
        expires_at: content.expiresAt,
      }, { onConflict: 'cache_key' });
    if (error && !cacheWarningShown && error.code !== '42P01' && error.code !== 'PGRST205') {
      cacheWarningShown = true;
      console.warn('[programmatic-competitor-cache] write failed; continuing with memory cache.', {
        code: error.code || 'unknown',
      });
    }
  } catch {
    // A cache failure must never turn a successful extraction into a user-visible failure.
  }
};

export const getProgrammaticCompetitorContent = async (options: {
  url: string;
  signal?: AbortSignal;
  forceRefresh?: boolean;
  timeoutMs?: number;
  maximumBytes?: number;
}): Promise<ProgrammaticCompetitorContent> => {
  const sourceUrl = normalizeProgrammaticCompetitorUrl(options.url);
  if (!options.forceRefresh) {
    const cached = await readCachedContent(sourceUrl);
    if (cached) return cached;
  }
  const fetched = await fetchProgrammaticHtml({
    url: sourceUrl,
    signal: options.signal,
    timeoutMs: Math.max(5_000, Math.min(options.timeoutMs ?? 35_000, 90_000)),
    maximumBytes: Math.max(100_000, Math.min(options.maximumBytes ?? 3_000_000, 5_000_000)),
  });
  const extracted = extractProgrammaticCompetitorContentFromHtml({
    html: fetched.html,
    sourceUrl,
    finalUrl: fetched.finalUrl,
    responseContentType: fetched.contentType,
    redirectCount: fetched.redirects,
  });
  extracted.expiresAt = new Date(Date.now() + getCacheHours() * 60 * 60 * 1000).toISOString();
  await saveCachedContent(sourceUrl, extracted);
  return extracted;
};
