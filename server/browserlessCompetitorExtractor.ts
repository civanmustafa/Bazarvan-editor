import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  ClientPageCrawlerError,
} from './clientPageCrawler.ts';
import {
  resolveCrawlerProviderCredential,
  type CrawlerCredentialSource,
  type ResolvedCrawlerProviderCredential,
} from './crawlerProviderSecrets.ts';
import {
  extractProgrammaticCompetitorContentFromHtml,
  isPrivateCompetitorAddress,
  normalizeProgrammaticCompetitorUrl,
  ProgrammaticCompetitorExtractionError,
  type ProgrammaticCompetitorContent,
} from './programmaticCompetitorExtractor.ts';
import {
  ProviderAccessError,
  reserveProviderRequest,
} from './providerAccessControl.ts';

export class BrowserlessCompetitorExtractionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly keySuffix: string;
  readonly credentialSource: CrawlerCredentialSource | null;

  constructor(options: {
    message: string;
    code: string;
    status?: number;
    retryable?: boolean;
    keySuffix?: string;
    credentialSource?: CrawlerCredentialSource | null;
  }) {
    super(options.message.slice(0, 2_000));
    this.name = 'BrowserlessCompetitorExtractionError';
    this.code = options.code.slice(0, 120);
    this.status = options.status ?? 502;
    this.retryable = options.retryable ?? false;
    this.keySuffix = options.keySuffix || '';
    this.credentialSource = options.credentialSource ?? null;
  }
}

export type BrowserlessRestrictedPageReason = 'captcha' | 'authentication';

type BrowserlessDependencies = {
  fetchImpl: typeof fetch;
  resolveCredential: (
    provider: 'browserless',
    userId?: string | null,
  ) => Promise<ResolvedCrawlerProviderCredential | null>;
  reserveRequest: typeof reserveProviderRequest;
  validateTargetUrl: (value: string) => Promise<string>;
};

const defaultDependencies: BrowserlessDependencies = {
  fetchImpl: globalThis.fetch,
  resolveCredential: resolveCrawlerProviderCredential,
  reserveRequest: reserveProviderRequest,
  validateTargetUrl: async value => {
    const normalized = normalizeProgrammaticCompetitorUrl(value);
    const url = new URL(normalized);
    if (isIP(url.hostname)) return normalized;
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(url.hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new BrowserlessCompetitorExtractionError({
        code: 'browserless_competitor_dns_failed',
        message: error instanceof Error
          ? error.message
          : 'Could not resolve the competitor hostname.',
        status: 502,
        retryable: true,
      });
    }
    if (
      addresses.length === 0
      || addresses.some(result => isPrivateCompetitorAddress(result.address))
    ) {
      throw new BrowserlessCompetitorExtractionError({
        code: 'unsafe_competitor_address',
        message: 'The competitor hostname resolves to a private or reserved network address.',
        status: 400,
      });
    }
    return normalized;
  },
};

const toRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const toTextList = (value: unknown, maximum: number): string[] => (
  Array.isArray(value)
    ? value.map(toText).filter(Boolean).slice(0, maximum)
    : []
);

/**
 * Browserless' `/function` endpoint gives us a Puppeteer page, which lets the
 * renderer enforce the same public-network boundary during navigation instead
 * of validating only the first URL on our server. The function intentionally
 * does not use Browserless' CAPTCHA or stealth helpers.
 */
const BROWSERLESS_SAFE_RENDER_FUNCTION = String.raw`
export default async ({ page, context }) => {
  const observedUrls = new Set();
  const navigationUrls = new Set();
  const remoteAddresses = new Set();
  const blockedUrls = new Set();

  const privateIpv4 = (hostname) => {
    const parts = hostname.split('.').map(part => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part) || part < 0 || part > 255)) return true;
    const [first, second, third] = parts;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
      || (first === 203 && second === 0 && third === 113)
      || first >= 224;
  };
  const unsafeHostname = (value) => {
    const hostname = String(value || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.lan')) return true;
    if (/^\d+(?:\.\d+){3}$/.test(hostname)) return privateIpv4(hostname);
    if (hostname.includes(':')) {
      return hostname === '::' || hostname === '::1' || hostname.startsWith('::ffff:')
        || /^(?:fc|fd|fe[89ab-cdef]|ff)/i.test(hostname)
        || /^2001:(?:0:|db8:)/i.test(hostname);
    }
    return !hostname.includes('.');
  };
  const safeRequestUrl = (value) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') return true;
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return !parsed.username && !parsed.password && !unsafeHostname(parsed.hostname);
    } catch {
      return false;
    }
  };

  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const requestUrl = request.url();
    observedUrls.add(requestUrl);
    if (request.isNavigationRequest()) navigationUrls.add(requestUrl);
    if (!safeRequestUrl(requestUrl)) {
      blockedUrls.add(requestUrl);
      void request.abort('blockedbyclient').catch(() => {});
      return;
    }
    void request.continue().catch(() => {});
  });
  page.on('response', response => {
    try {
      observedUrls.add(response.url());
      const remote = response.remoteAddress();
      if (remote && remote.ip) remoteAddresses.add(remote.ip);
    } catch {
      // A response may disappear while the page is navigating; safety is
      // checked again from the URLs and addresses that remain observable.
    }
  });

  let navigationError = '';
  let status = 0;
  let contentType = 'text/html; charset=utf-8';
  try {
    const response = await page.goto(context.url, {
      waitUntil: 'networkidle2',
      timeout: context.navigationTimeoutMs,
    });
    status = response ? response.status() : 0;
    const headers = response ? response.headers() : {};
    contentType = headers['content-type'] || contentType;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error || 'Navigation failed.');
  }

  const finalUrl = page.url();
  if (finalUrl) {
    observedUrls.add(finalUrl);
    navigationUrls.add(finalUrl);
  }
  let html = '';
  try {
    html = await page.content();
  } catch (error) {
    navigationError ||= error instanceof Error ? error.message : String(error || 'Could not read rendered HTML.');
  }
  return {
    data: {
      html,
      finalUrl,
      status,
      contentType,
      navigationError,
      observedUrls: Array.from(observedUrls).slice(0, 500),
      navigationUrls: Array.from(navigationUrls).slice(0, 30),
      remoteAddresses: Array.from(remoteAddresses).slice(0, 200),
      blockedUrls: Array.from(blockedUrls).slice(0, 50),
    },
    type: 'application/json',
  };
};
`;

const normalizeVisibleText = (html: string): string => html
  .replace(/<!--[^]*?-->/g, ' ')
  .replace(/<(script|style|noscript|template|svg|canvas)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(?:nbsp|#160);/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 50_000);

const extractDocumentTitle = (html: string): string => normalizeVisibleText(
  html.match(/<title\b[^>]*>([^]*?)<\/title\s*>/i)?.[1] || '',
).slice(0, 500);

/**
 * Browserless only renders the public page. If the rendered result is a
 * challenge or an authentication wall, the extractor stops instead of trying
 * to solve, submit, or otherwise bypass it.
 */
export const classifyBrowserlessRestrictedPage = (options: {
  html: string;
  url: string;
}): BrowserlessRestrictedPageReason | null => {
  const title = extractDocumentTitle(options.html);
  const visibleText = normalizeVisibleText(options.html);
  const titleAndLead = `${title}\n${visibleText.slice(0, 8_000)}`;
  const challengeTitle = /^(?:just a moment|attention required|security check|human verification|التحقق الأمني|لحظة من فضلك)\b/i
    .test(title);
  const challengeMarkup = /(?:id|class|src|action)\s*=\s*["'][^"']*(?:cf-chl|challenge-form|cf-turnstile|g-recaptcha|h-captcha|captcha)[^"']*["']/i
    .test(options.html);
  const challengeText = /(?:verify (?:that )?you are human|confirm you are human|complete the security check|enable javascript and cookies to continue|i am not a robot|captcha|تحقق من أنك (?:إنسان|انسان)|أثبت أنك (?:إنسان|انسان)|أنا لست روبوت|اكمل التحقق الأمني)/i
    .test(titleAndLead);
  if (challengeTitle || (challengeMarkup && challengeText)) return 'captcha';

  const passwordInput = /<input\b[^>]*\btype\s*=\s*(?:["']password["']|password\b)/i
    .test(options.html);
  if (!passwordInput) return null;
  let pathname = '';
  try {
    pathname = new URL(options.url).pathname;
  } catch {
    // URL safety is checked independently before the provider request.
  }
  const loginRoute = /\/(?:login|log-in|signin|sign-in|auth|account)(?:\/|$)/i.test(pathname);
  const loginTitle = /^(?:login|log in|sign in|member login|تسجيل الدخول|دخول الأعضاء)(?:\s|[-|–—:].*)?$/i
    .test(title);
  const loginForm = /<form\b[^>]*(?:action|id|class)\s*=\s*["'][^"']*(?:login|log-in|signin|sign-in|auth)[^"']*["'][^>]*>[^]*?<input\b[^>]*\btype\s*=\s*(?:["']password["']|password\b)/i
    .test(options.html);
  const hasEditorialContainer = /<(?:article|main)\b/i.test(options.html);
  return loginRoute || loginTitle || (loginForm && !hasEditorialContainer)
    ? 'authentication'
    : null;
};

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => (
  Number.isFinite(value)
    ? Math.max(minimum, Math.min(Math.round(value as number), maximum))
    : fallback
);

const responseBody = async (
  response: Response,
  maximumBytes: number,
): Promise<string> => {
  const declaredLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new BrowserlessCompetitorExtractionError({
      code: 'browserless_response_too_large',
      message: `The rendered page exceeds the ${maximumBytes} byte extraction limit.`,
      status: 413,
    });
  }
  if (!response.body) return '';
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
        throw new BrowserlessCompetitorExtractionError({
          code: 'browserless_response_too_large',
          message: `The rendered page exceeds the ${maximumBytes} byte extraction limit.`,
          status: 413,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(chunk => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
};

const redactSecret = (value: string, apiKey: string): string => {
  let redacted = String(value || '');
  if (apiKey) {
    const representations = new Set([
      apiKey,
      encodeURIComponent(apiKey),
      encodeURI(apiKey),
    ]);
    representations.forEach(secret => {
      if (secret) redacted = redacted.split(secret).join('[redacted]');
    });
  }
  return redacted.replace(/([?&]token=)[^\s&#"'<>]+/gi, '$1[redacted]');
};

const providerMessage = (body: string, apiKey: string): string => {
  let message = body;
  try {
    const payload = toRecord(JSON.parse(body));
    message = toText(payload.message)
      || toText(payload.error)
      || toText(toRecord(payload.error).message)
      || body;
  } catch {
    // Browserless may return a bounded plain-text provider error.
  }
  return redactSecret(message, apiKey).slice(0, 1_000);
};

const normalizeError = (
  error: unknown,
  credential?: ResolvedCrawlerProviderCredential | null,
): BrowserlessCompetitorExtractionError => {
  const sanitize = (message: string): string => redactSecret(message, credential?.apiKey || '');
  if (error instanceof BrowserlessCompetitorExtractionError) {
    return new BrowserlessCompetitorExtractionError({
      code: error.code,
      message: sanitize(error.message),
      status: error.status,
      retryable: error.retryable,
      keySuffix: error.keySuffix || credential?.keySuffix,
      credentialSource: error.credentialSource || credential?.source,
    });
  }
  if (error instanceof ProviderAccessError) {
    return new BrowserlessCompetitorExtractionError({
      code: error.code.toLowerCase(),
      message: sanitize(error.message),
      status: error.status,
      // A depleted user quota is terminal for this run. Provider-policy storage
      // outages and other 5xx access failures remain retryable.
      retryable: error.status >= 500 || error.status === 408 || error.status === 425,
      keySuffix: credential?.keySuffix,
      credentialSource: credential?.source,
    });
  }
  if (
    error instanceof ProgrammaticCompetitorExtractionError
    || error instanceof ClientPageCrawlerError
  ) {
    return new BrowserlessCompetitorExtractionError({
      code: error.code,
      message: sanitize(error.message),
      status: error.status,
      retryable: error.retryable,
      keySuffix: credential?.keySuffix,
      credentialSource: credential?.source,
    });
  }
  const metadata = error && typeof error === 'object'
    ? error as { code?: unknown; status?: unknown; retryable?: unknown; message?: unknown }
    : {};
  const metadataStatus = Number(metadata.status);
  if (toText(metadata.code) && Number.isFinite(metadataStatus)) {
    return new BrowserlessCompetitorExtractionError({
      code: toText(metadata.code).toLowerCase(),
      message: sanitize(toText(metadata.message) || 'Browserless credential access failed.'),
      status: metadataStatus,
      retryable: typeof metadata.retryable === 'boolean'
        ? metadata.retryable
        : metadataStatus >= 500 || metadataStatus === 408 || metadataStatus === 425 || metadataStatus === 429,
      keySuffix: credential?.keySuffix,
      credentialSource: credential?.source,
    });
  }
  return new BrowserlessCompetitorExtractionError({
    code: 'browserless_competitor_extraction_failed',
    message: sanitize(error instanceof Error ? error.message : 'Browserless competitor extraction failed.'),
    status: 502,
    retryable: true,
    keySuffix: credential?.keySuffix,
    credentialSource: credential?.source,
  });
};

const abortable = <T>(
  promise: Promise<T>,
  signal: AbortSignal,
  errorFactory: () => BrowserlessCompetitorExtractionError,
): Promise<T> => new Promise<T>((resolve, reject) => {
  if (signal.aborted) {
    reject(errorFactory());
    return;
  }
  let settled = false;
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    callback();
  };
  const onAbort = () => finish(() => reject(errorFactory()));
  signal.addEventListener('abort', onAbort, { once: true });
  promise.then(
    value => finish(() => resolve(value)),
    error => finish(() => reject(error)),
  );
});

type BrowserlessRenderedDocument = {
  html: string;
  finalUrl: string;
  status: number;
  contentType: string;
  navigationError: string;
  observedUrls: string[];
  navigationUrls: string[];
  remoteAddresses: string[];
  blockedUrls: string[];
};

const parseRenderedDocument = (
  body: string,
  credential: ResolvedCrawlerProviderCredential,
): BrowserlessRenderedDocument => {
  let payload: Record<string, unknown>;
  try {
    payload = toRecord(JSON.parse(body));
  } catch {
    throw new BrowserlessCompetitorExtractionError({
      code: 'browserless_function_response_invalid',
      message: 'Browserless did not return the expected rendered-page JSON payload.',
      status: 502,
      retryable: true,
      keySuffix: credential.keySuffix,
      credentialSource: credential.source,
    });
  }
  let nested = toRecord(payload.data);
  if (typeof payload.data === 'string') {
    try {
      nested = toRecord(JSON.parse(payload.data));
    } catch {
      nested = {};
    }
  }
  const data = Object.keys(nested).length > 0 ? nested : payload;
  return {
    html: toText(data.html),
    finalUrl: toText(data.finalUrl),
    status: Math.max(0, Math.min(599, Math.round(Number(data.status) || 0))),
    contentType: toText(data.contentType) || 'text/html; charset=utf-8',
    navigationError: redactSecret(toText(data.navigationError), credential.apiKey).slice(0, 1_000),
    observedUrls: toTextList(data.observedUrls, 500),
    navigationUrls: toTextList(data.navigationUrls, 30),
    remoteAddresses: toTextList(data.remoteAddresses, 200),
    blockedUrls: toTextList(data.blockedUrls, 50),
  };
};

const normalizedRemoteAddress = (value: string): string => value
  .trim()
  .replace(/^\[|\]$/g, '')
  .replace(/%.+$/, '');

const mappedIpv4Address = (value: string): string => {
  const normalized = normalizedRemoteAddress(value).toLowerCase();
  const dotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return dotted;
  const hexadecimal = normalized.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexadecimal) return '';
  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
};

const isUnsafeRenderedRemoteAddress = (value: string): boolean => {
  const normalized = normalizedRemoteAddress(value).toLowerCase();
  const mapped = mappedIpv4Address(normalized);
  if (mapped) return isPrivateCompetitorAddress(mapped);
  if (isIP(normalized) === 0) return true;
  return isPrivateCompetitorAddress(normalized)
    || /^fe[c-f]/i.test(normalized)
    || /^(?:64:ff9b(?::|$)|2002:|2001:0:)/i.test(normalized);
};

const assertObservedUrlSafe = (value: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserlessCompetitorExtractionError({
      code: 'unsafe_competitor_address',
      message: 'Browserless observed an invalid network destination while rendering the competitor page.',
      status: 400,
    });
  }
  if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) return;
  try {
    normalizeProgrammaticCompetitorUrl(value);
  } catch {
    throw new BrowserlessCompetitorExtractionError({
      code: 'unsafe_competitor_address',
      message: 'Browserless observed a private, reserved, or unsupported network destination.',
      status: 400,
    });
  }
};

const assertRenderedDocumentSafe = async (options: {
  rendered: BrowserlessRenderedDocument;
  validateTargetUrl: BrowserlessDependencies['validateTargetUrl'];
  awaitOperation: <T>(promise: Promise<T>) => Promise<T>;
}): Promise<string> => {
  if (options.rendered.blockedUrls.length > 0) {
    throw new BrowserlessCompetitorExtractionError({
      code: 'unsafe_competitor_address',
      message: 'Browserless blocked a private, reserved, or unsupported destination during rendering.',
      status: 400,
    });
  }
  options.rendered.observedUrls.forEach(assertObservedUrlSafe);
  if (!options.rendered.finalUrl) {
    throw new BrowserlessCompetitorExtractionError({
      code: 'browserless_final_url_missing',
      message: 'Browserless did not report the final rendered-page URL.',
      status: 502,
      retryable: true,
    });
  }
  const navigationUrls = Array.from(new Set([
    ...options.rendered.navigationUrls,
    options.rendered.finalUrl,
  ].filter(Boolean)));
  if (options.rendered.remoteAddresses.length === 0) {
    throw new BrowserlessCompetitorExtractionError({
      code: 'browserless_remote_address_missing',
      message: 'Browserless did not report the remote address used for the rendered page.',
      status: 502,
      retryable: true,
    });
  }
  for (const navigationUrl of navigationUrls) {
    assertObservedUrlSafe(navigationUrl);
    await options.awaitOperation(options.validateTargetUrl(navigationUrl));
  }
  const unsafeRemoteAddress = options.rendered.remoteAddresses.find(isUnsafeRenderedRemoteAddress);
  if (unsafeRemoteAddress) {
    throw new BrowserlessCompetitorExtractionError({
      code: 'unsafe_competitor_address',
      message: 'Browserless resolved a rendered-page request to a private or reserved network address.',
      status: 400,
    });
  }
  return options.rendered.finalUrl;
};

export const getBrowserlessCompetitorContent = async (options: {
  url: string;
  signal?: AbortSignal;
  userId?: string | null;
  timeoutMs?: number;
  maximumBytes?: number;
  dependencies?: Partial<BrowserlessDependencies>;
}): Promise<ProgrammaticCompetitorContent> => {
  if (options.signal?.aborted) {
    throw new BrowserlessCompetitorExtractionError({
      code: 'competitor_extraction_cancelled',
      message: 'Browserless competitor extraction was cancelled.',
      status: 499,
    });
  }
  if (!toText(options.userId)) {
    throw new BrowserlessCompetitorExtractionError({
      code: 'browserless_user_identity_required',
      message: 'An authenticated user identity is required before reserving a Browserless request.',
      status: 403,
      retryable: false,
    });
  }
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const timeoutMs = boundedInteger(options.timeoutMs, 70_000, 5_000, 120_000);
  const maximumBytes = boundedInteger(options.maximumBytes, 3_000_000, 100_000, 5_000_000);
  let credential: ResolvedCrawlerProviderCredential | null = null;
  let targetUrl = '';
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Browserless competitor extraction timed out.')),
    timeoutMs,
  );
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromParent, { once: true });
  if (options.signal?.aborted) abortFromParent();
  const abortError = (): BrowserlessCompetitorExtractionError => new BrowserlessCompetitorExtractionError({
    code: options.signal?.aborted
      ? 'competitor_extraction_cancelled'
      : 'browserless_competitor_timeout',
    message: options.signal?.aborted
      ? 'Browserless competitor extraction was cancelled.'
      : 'Browserless competitor extraction timed out.',
    status: options.signal?.aborted ? 499 : 504,
    retryable: !options.signal?.aborted,
    keySuffix: credential?.keySuffix,
    credentialSource: credential?.source,
  });
  const awaitOperation = <T>(promise: Promise<T>): Promise<T> => (
    abortable(promise, controller.signal, abortError)
  );
  try {
    targetUrl = await awaitOperation(dependencies.validateTargetUrl(options.url));
    credential = await awaitOperation(dependencies.resolveCredential('browserless', options.userId));
    if (!credential) {
      throw new BrowserlessCompetitorExtractionError({
        code: 'browserless_not_configured',
        message: 'No authorized Browserless key is available for this user.',
        status: 503,
        retryable: false,
      });
    }
    await awaitOperation(dependencies.reserveRequest({
      userId: options.userId,
      provider: 'browserless',
      operation: 'competitor_rendered_scrape',
    }));
    const baseUrl = String(
      process.env.BROWSERLESS_API_URL || 'https://production-sfo.browserless.io',
    ).trim().replace(/\/+$/, '');
    const endpoint = `${baseUrl}/function?token=${encodeURIComponent(credential.apiKey)}`;
    let response: Response;
    try {
      response = await awaitOperation(dependencies.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: BROWSERLESS_SAFE_RENDER_FUNCTION,
          context: {
            url: targetUrl,
            navigationTimeoutMs: Math.max(5_000, timeoutMs - 2_000),
          },
        }),
        signal: controller.signal,
      }));
    } catch (error) {
      if (error instanceof BrowserlessCompetitorExtractionError) throw error;
      throw new BrowserlessCompetitorExtractionError({
        code: 'browserless_competitor_network_error',
        message: redactSecret(
          error instanceof Error ? error.message : 'Could not connect to Browserless.',
          credential.apiKey,
        ),
        status: 502,
        retryable: true,
        keySuffix: credential.keySuffix,
        credentialSource: credential.source,
      });
    }
    const maximumResponseBytes = Math.min(11_000_000, maximumBytes * 2 + 256_000);
    const body = await awaitOperation(responseBody(response, maximumResponseBytes));
    if (!response.ok) {
      throw new BrowserlessCompetitorExtractionError({
        code: response.status === 429
          ? 'browserless_quota_exceeded'
          : `browserless_http_${response.status || 502}`,
        message: providerMessage(body, credential.apiKey)
          || `Browserless returned HTTP ${response.status || 502}.`,
        status: response.status || 502,
        retryable: response.status === 408
          || response.status === 425
          || response.status === 429
          || response.status >= 500,
        keySuffix: credential.keySuffix,
        credentialSource: credential.source,
      });
    }
    const rendered = parseRenderedDocument(body, credential);
    const finalUrl = await assertRenderedDocumentSafe({
      rendered,
      validateTargetUrl: dependencies.validateTargetUrl,
      awaitOperation,
    });
    const htmlBytes = new TextEncoder().encode(rendered.html).byteLength;
    if (htmlBytes > maximumBytes) {
      throw new BrowserlessCompetitorExtractionError({
        code: 'browserless_response_too_large',
        message: `The rendered page exceeds the ${maximumBytes} byte extraction limit.`,
        status: 413,
        keySuffix: credential.keySuffix,
        credentialSource: credential.source,
      });
    }
    if (!/<html\b|<!doctype\s+html/i.test(rendered.html)) {
      throw new BrowserlessCompetitorExtractionError({
        code: 'browserless_rendered_html_empty',
        message: 'Browserless did not return a rendered HTML document.',
        status: 422,
        keySuffix: credential.keySuffix,
        credentialSource: credential.source,
      });
    }
    if (rendered.status >= 400) {
      throw new BrowserlessCompetitorExtractionError({
        code: `browserless_target_http_${rendered.status}`,
        message: `The rendered competitor page returned HTTP ${rendered.status}.`,
        status: rendered.status,
        retryable: rendered.status === 408 || rendered.status === 425 || rendered.status === 429 || rendered.status >= 500,
        keySuffix: credential.keySuffix,
        credentialSource: credential.source,
      });
    }
    if (rendered.navigationError && !rendered.html) {
      throw new BrowserlessCompetitorExtractionError({
        code: 'browserless_navigation_failed',
        message: rendered.navigationError,
        status: 502,
        retryable: true,
        keySuffix: credential.keySuffix,
        credentialSource: credential.source,
      });
    }
    const restricted = classifyBrowserlessRestrictedPage({ html: rendered.html, url: finalUrl });
    if (restricted) {
      throw new BrowserlessCompetitorExtractionError({
        code: restricted === 'captcha'
          ? 'browserless_captcha_required'
          : 'browserless_authentication_required',
        message: restricted === 'captcha'
          ? 'The competitor page requires a CAPTCHA or human verification; it was not bypassed.'
          : 'The competitor page requires authentication; no login was attempted.',
        status: restricted === 'captcha' ? 422 : 401,
        retryable: false,
        keySuffix: credential.keySuffix,
        credentialSource: credential.source,
      });
    }
    try {
      return extractProgrammaticCompetitorContentFromHtml({
        html: rendered.html,
        sourceUrl: targetUrl,
        finalUrl,
        responseContentType: `${rendered.contentType}; renderer=browserless`,
        redirectCount: Math.max(0, new Set(rendered.navigationUrls).size - 1),
      });
    } catch (error) {
      if (!(error instanceof ProgrammaticCompetitorExtractionError)) throw error;
      throw new BrowserlessCompetitorExtractionError({
        code: error.code === 'programmatic_content_not_found'
          ? 'browserless_content_not_found'
          : error.code,
        message: error.message,
        status: error.status,
        retryable: error.retryable,
        keySuffix: credential.keySuffix,
        credentialSource: credential.source,
      });
    }
  } catch (error) {
    throw normalizeError(error, credential);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
};
