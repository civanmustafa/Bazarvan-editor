import {
  normalizeClientSiteCrawlProvider,
  type ClientSiteCrawlProvider,
  type CrawlerExternalProvider,
} from '../constants/crawlerProviders.ts';
import {
  ClientPageCrawlerError,
  crawlClientPage,
  extractClientPageLinksFromHtml,
  extractClientPageMetadataFromHtml,
  sanitizeDiscoveredClientUrl,
  validatePublicClientUrl,
  type AllowedClientDomain,
  type ClientPageCrawlResult,
} from './clientPageCrawler.ts';
import {
  resolveCrawlerProviderCredential,
  type CrawlerCredentialSource,
} from './crawlerProviderSecrets.ts';
import type {
  CrawlerProviderAttemptTelemetry,
} from './crawlerProviderUsage.ts';
import {
  ProviderAccessError,
  reserveProviderRequest,
} from './providerAccessControl.ts';

export type ClientPageProviderCrawlResult = {
  page: ClientPageCrawlResult;
  provider: 'local' | CrawlerExternalProvider;
  credentialSource: CrawlerCredentialSource | null;
  fallbackReason: string | null;
};

type ProviderAttemptReporter = (
  attempt: CrawlerProviderAttemptTelemetry,
) => void | Promise<void>;

type ExternalProviderAttemptGuard = (
  provider: CrawlerExternalProvider,
) => void | Promise<void>;

const toRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const emitProviderAttempt = async (
  reporter: ProviderAttemptReporter | undefined,
  attempt: CrawlerProviderAttemptTelemetry,
): Promise<void> => {
  if (!reporter) return;
  try {
    await reporter(attempt);
  } catch (error) {
    console.warn(
      '[client-page-crawler] Could not persist provider usage telemetry:',
      error instanceof Error ? error.message : error,
    );
  }
};

const attemptErrorDetails = (error: unknown): {
  errorCode: string;
  errorMessage: string;
  httpStatus: number | null;
  retryable: boolean;
} => {
  if (error instanceof ClientPageCrawlerError) {
    return {
      errorCode: error.code,
      errorMessage: error.message.slice(0, 2_000),
      httpStatus: error.status >= 100 && error.status <= 599 ? error.status : null,
      retryable: error.retryable,
    };
  }
  return {
    errorCode: 'client_page_crawl_provider_error',
    errorMessage: error instanceof Error
      ? error.message.slice(0, 2_000)
      : String(error).slice(0, 2_000),
    httpStatus: null,
    retryable: true,
  };
};

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
};

const autoMinimumWordCount = (): number => boundedInteger(
  process.env.CLIENT_PAGE_CRAWLER_AUTO_MIN_WORDS,
  40,
  0,
  2_000,
);

const readBoundedResponseText = async (
  response: Response,
  maximumBytes: number,
): Promise<string> => {
  const declaredLength = Number.parseInt(
    response.headers.get('content-length') || '',
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ClientPageCrawlerError({
      code: 'crawler_provider_response_too_large',
      message: `The crawler provider response exceeds ${maximumBytes} bytes.`,
      status: 413,
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new ClientPageCrawlerError({
      code: 'crawler_provider_response_too_large',
      message: `The crawler provider response exceeds ${maximumBytes} bytes.`,
      status: 413,
    });
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
};

const requestWithTimeout = async (options: {
  url: string;
  init: RequestInit;
  signal?: AbortSignal;
  timeoutMs: number;
  provider: CrawlerExternalProvider;
}): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${options.provider} request timed out.`)),
    options.timeoutMs,
  );
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    return await fetch(options.url, {
      ...options.init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ClientPageCrawlerError({
        code: options.signal?.aborted
          ? 'client_page_crawl_cancelled'
          : `${options.provider}_crawl_timeout`,
        message: options.signal?.aborted
          ? 'The page crawl was cancelled.'
          : `${options.provider} did not respond before the crawl timeout.`,
        status: options.signal?.aborted ? 499 : 504,
        retryable: !options.signal?.aborted,
      });
    }
    throw new ClientPageCrawlerError({
      code: `${options.provider}_network_error`,
      message: error instanceof Error
        ? error.message
        : `Could not connect to ${options.provider}.`,
      status: 502,
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
};

const providerHttpError = (
  provider: CrawlerExternalProvider,
  status: number,
  message: string,
): ClientPageCrawlerError => new ClientPageCrawlerError({
  code: `${provider}_http_${status || 502}`,
  message: message.slice(0, 1_000)
    || `${provider} returned HTTP ${status || 502}.`,
  status: status || 502,
  retryable: status === 408 || status === 425 || status === 429 || status >= 500,
});

const buildResultFromHtml = (options: {
  html: string;
  requestedUrl: string;
  finalUrl?: string;
  httpStatus?: number;
  responseContentType?: string;
  domains: AllowedClientDomain[];
  startedAt: number;
}): ClientPageCrawlResult => {
  const finalUrl = sanitizeDiscoveredClientUrl(
    options.finalUrl || options.requestedUrl,
    options.requestedUrl,
    options.domains,
  );
  const result = extractClientPageMetadataFromHtml({
    html: options.html,
    finalUrl,
    httpStatus: options.httpStatus || 200,
    responseContentType: options.responseContentType || 'text/html; rendered=true',
    crawlDurationMs: Date.now() - options.startedAt,
  });
  return {
    ...result,
    canonicalUrl: sanitizeDiscoveredClientUrl(
      result.canonicalUrl,
      result.finalUrl,
      options.domains,
    ),
    internalLinks: extractClientPageLinksFromHtml({
      html: options.html,
      finalUrl,
      domains: options.domains,
    }),
  };
};

const crawlWithFirecrawl = async (options: {
  url: string;
  domains: AllowedClientDomain[];
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
}): Promise<ClientPageCrawlResult> => {
  const startedAt = Date.now();
  const baseUrl = String(
    process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev',
  ).trim().replace(/\/+$/, '');
  const response = await requestWithTimeout({
    provider: 'firecrawl',
    url: `${baseUrl}/v2/scrape`,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: options.url,
        formats: ['html'],
        onlyMainContent: false,
        timeout: Math.max(5_000, options.timeoutMs - 2_000),
        parsers: [],
      }),
    },
  });
  const rawPayload = await readBoundedResponseText(
    response,
    Math.max(1_000_000, Math.min(options.maximumBytes * 4, 20_000_000)),
  );
  let payload: Record<string, unknown> = {};
  try {
    payload = toRecord(JSON.parse(rawPayload));
  } catch {
    throw providerHttpError(
      'firecrawl',
      response.status,
      'Firecrawl returned an invalid JSON response.',
    );
  }
  const data = toRecord(payload.data);
  if (!response.ok || payload.success === false) {
    const error = toRecord(payload.error);
    throw providerHttpError(
      'firecrawl',
      response.status,
      toText(payload.error)
        || toText(error.message)
        || toText(payload.message),
    );
  }
  const html = toText(data.html) || toText(data.rawHtml);
  if (!html) {
    throw new ClientPageCrawlerError({
      code: 'firecrawl_rendered_html_empty',
      message: 'Firecrawl did not return rendered HTML for the page.',
      status: 422,
    });
  }
  const metadata = toRecord(data.metadata);
  return buildResultFromHtml({
    html,
    requestedUrl: options.url,
    finalUrl: toText(metadata.sourceURL) || toText(metadata.url),
    httpStatus: Number(metadata.statusCode) || 200,
    responseContentType: toText(metadata.contentType) || 'text/html; provider=firecrawl',
    domains: options.domains,
    startedAt,
  });
};

const crawlWithBrowserless = async (options: {
  url: string;
  domains: AllowedClientDomain[];
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
}): Promise<ClientPageCrawlResult> => {
  const startedAt = Date.now();
  const baseUrl = String(
    process.env.BROWSERLESS_API_URL || 'https://production-sfo.browserless.io',
  ).trim().replace(/\/+$/, '');
  const response = await requestWithTimeout({
    provider: 'browserless',
    url: `${baseUrl}/content?token=${encodeURIComponent(options.apiKey)}`,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: options.url,
        gotoOptions: {
          waitUntil: 'networkidle2',
          timeout: Math.max(5_000, options.timeoutMs - 2_000),
        },
        waitForTimeout: 750,
        bestAttempt: true,
      }),
    },
  });
  const body = await readBoundedResponseText(response, options.maximumBytes);
  if (!response.ok) {
    let message = body;
    try {
      const payload = toRecord(JSON.parse(body));
      message = toText(payload.message) || toText(payload.error) || body;
    } catch {
      // Browserless can return a plain-text provider error.
    }
    throw providerHttpError('browserless', response.status, message);
  }
  if (!/<html\b|<!doctype\s+html/i.test(body)) {
    throw new ClientPageCrawlerError({
      code: 'browserless_rendered_html_empty',
      message: 'Browserless did not return rendered HTML for the page.',
      status: 422,
    });
  }
  return buildResultFromHtml({
    html: body,
    requestedUrl: options.url,
    httpStatus: 200,
    responseContentType: response.headers.get('content-type')
      || 'text/html; provider=browserless',
    domains: options.domains,
    startedAt,
  });
};

const crawlExternalProvider = async (options: {
  provider: CrawlerExternalProvider;
  requestedProvider: ClientSiteCrawlProvider;
  url: string;
  domains: AllowedClientDomain[];
  signal?: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
  fallbackReason: string | null;
  onAttempt?: ProviderAttemptReporter;
  beforeExternalAttempt?: ExternalProviderAttemptGuard;
  requestedBy?: string | null;
}): Promise<ClientPageProviderCrawlResult> => {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let credentialSource: CrawlerCredentialSource | null = null;
  let keySuffix: string | null = null;
  let requestReserved = false;
  try {
    await validatePublicClientUrl(options.url, options.domains);
    const credential = await resolveCrawlerProviderCredential(options.provider, options.requestedBy);
    if (!credential) {
      throw new ClientPageCrawlerError({
        code: `${options.provider}_not_configured`,
        message: `${options.provider} is not configured by an administrator.`,
        status: 503,
        retryable: false,
      });
    }
    credentialSource = credential.source;
    keySuffix = credential.keySuffix;
    try {
      await reserveProviderRequest({
        userId: options.requestedBy,
        provider: options.provider,
        operation: 'client_page_crawl',
      });
    } catch (error) {
      if (!(error instanceof ProviderAccessError)) throw error;
      throw new ClientPageCrawlerError({
        code: error.code.toLowerCase(),
        message: error.message,
        status: error.status,
        retryable: false,
      });
    }
    await options.beforeExternalAttempt?.(options.provider);
    requestReserved = true;
    const page = options.provider === 'firecrawl'
      ? await crawlWithFirecrawl({ ...options, apiKey: credential.apiKey })
      : await crawlWithBrowserless({ ...options, apiKey: credential.apiKey });
    const completedAt = new Date().toISOString();
    await emitProviderAttempt(options.onAttempt, {
      requestedProvider: options.requestedProvider,
      provider: options.provider,
      credentialSource,
      keySuffix,
      status: 'completed',
      targetUrl: options.url,
      finalUrl: page.finalUrl,
      httpStatus: page.httpStatus,
      durationMs: Date.now() - startedAtMs,
      wordCount: page.wordCount,
      internalLinkCount: page.internalLinks.length,
      responseContentType: page.responseContentType,
      fallbackReason: options.fallbackReason,
      errorCode: null,
      errorMessage: null,
      retryable: null,
      startedAt,
      completedAt,
    });
    return {
      page,
      provider: options.provider,
      credentialSource,
      fallbackReason: options.fallbackReason,
    };
  } catch (error) {
    const details = attemptErrorDetails(error);
    if (requestReserved) {
      await emitProviderAttempt(options.onAttempt, {
        requestedProvider: options.requestedProvider,
        provider: options.provider,
        credentialSource,
        keySuffix,
        status: 'failed',
        targetUrl: options.url,
        finalUrl: null,
        httpStatus: details.httpStatus,
        durationMs: Date.now() - startedAtMs,
        wordCount: null,
        internalLinkCount: null,
        responseContentType: null,
        fallbackReason: options.fallbackReason,
        errorCode: details.errorCode,
        errorMessage: details.errorMessage,
        retryable: details.retryable,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
};

const localResultNeedsExternalFallback = (
  page: ClientPageCrawlResult,
): boolean => (
  page.wordCount < autoMinimumWordCount()
  && page.internalLinks.length === 0
);

const localErrorAllowsExternalFallback = (error: unknown): boolean => {
  if (!(error instanceof ClientPageCrawlerError)) return true;
  return error.retryable
    && ![
      'client_page_crawl_cancelled',
      'client_page_domain_not_allowed',
      'unsafe_client_page_url',
      'unsafe_client_page_address',
      'invalid_client_page_url',
    ].includes(error.code);
};

const crawlLocalProvider = async (options: {
  requestedProvider: ClientSiteCrawlProvider;
  url: string;
  domains: AllowedClientDomain[];
  signal?: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
  onAttempt?: ProviderAttemptReporter;
}): Promise<ClientPageCrawlResult> => {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  try {
    const page = await crawlClientPage(options);
    const fallbackReason = options.requestedProvider === 'auto'
      && localResultNeedsExternalFallback(page)
      ? 'local_rendered_content_sparse'
      : null;
    await emitProviderAttempt(options.onAttempt, {
      requestedProvider: options.requestedProvider,
      provider: 'local',
      credentialSource: null,
      keySuffix: null,
      status: 'completed',
      targetUrl: options.url,
      finalUrl: page.finalUrl,
      httpStatus: page.httpStatus,
      durationMs: Date.now() - startedAtMs,
      wordCount: page.wordCount,
      internalLinkCount: page.internalLinks.length,
      responseContentType: page.responseContentType,
      fallbackReason,
      errorCode: null,
      errorMessage: null,
      retryable: null,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    return page;
  } catch (error) {
    const details = attemptErrorDetails(error);
    await emitProviderAttempt(options.onAttempt, {
      requestedProvider: options.requestedProvider,
      provider: 'local',
      credentialSource: null,
      keySuffix: null,
      status: 'failed',
      targetUrl: options.url,
      finalUrl: null,
      httpStatus: details.httpStatus,
      durationMs: Date.now() - startedAtMs,
      wordCount: null,
      internalLinkCount: null,
      responseContentType: null,
      fallbackReason: null,
      errorCode: details.errorCode,
      errorMessage: details.errorMessage,
      retryable: details.retryable,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
};

const tryAutomaticExternalFallback = async (options: {
  url: string;
  domains: AllowedClientDomain[];
  signal?: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
  fallbackReason: string;
  onAttempt?: ProviderAttemptReporter;
  beforeExternalAttempt?: ExternalProviderAttemptGuard;
}): Promise<ClientPageProviderCrawlResult | null> => {
  for (const provider of ['firecrawl', 'browserless'] as const) {
    try {
      return await crawlExternalProvider({
        ...options,
        provider,
        requestedProvider: 'auto',
      });
    } catch (error) {
      if (
        error instanceof ClientPageCrawlerError
        && error.code === 'client_page_crawl_cancelled'
      ) {
        throw error;
      }
      if (
        error instanceof ClientPageCrawlerError
        && (
          error.code === 'crawler_provider_monthly_limit_reached'
          || error.code === 'crawler_run_external_limit_reached'
        )
      ) {
        throw error;
      }
      if (
        error instanceof ClientPageCrawlerError
        && error.code !== `${provider}_not_configured`
      ) {
        console.warn(
          `[client-page-crawler] Auto fallback ${provider} failed: ${error.code}.`,
        );
        // One URL gets at most one billable external attempt in automatic mode.
        return null;
      }
    }
  }
  return null;
};

export const crawlClientPageWithProvider = async (options: {
  provider?: ClientSiteCrawlProvider | string;
  url: string;
  domains: AllowedClientDomain[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maximumBytes?: number;
  onAttempt?: ProviderAttemptReporter;
  beforeExternalAttempt?: ExternalProviderAttemptGuard;
  requestedBy?: string | null;
}): Promise<ClientPageProviderCrawlResult> => {
  const provider = normalizeClientSiteCrawlProvider(options.provider);
  const timeoutMs = Math.max(5_000, Math.min(options.timeoutMs ?? 45_000, 120_000));
  const maximumBytes = Math.max(
    100_000,
    Math.min(options.maximumBytes ?? 2_500_000, 5_000_000),
  );
  const shared = {
    url: options.url,
    domains: options.domains,
    signal: options.signal,
    timeoutMs,
    maximumBytes,
    requestedProvider: provider,
    onAttempt: options.onAttempt,
    beforeExternalAttempt: options.beforeExternalAttempt,
    requestedBy: options.requestedBy,
  };

  if (provider === 'firecrawl' || provider === 'browserless') {
    return crawlExternalProvider({
      ...shared,
      provider,
      fallbackReason: null,
    });
  }

  if (provider === 'local') {
    return {
      page: await crawlLocalProvider(shared),
      provider: 'local',
      credentialSource: null,
      fallbackReason: null,
    };
  }

  let localPage: ClientPageCrawlResult | null = null;
  let localError: unknown = null;
  try {
    localPage = await crawlLocalProvider(shared);
    if (!localResultNeedsExternalFallback(localPage)) {
      return {
        page: localPage,
        provider: 'local',
        credentialSource: null,
        fallbackReason: null,
      };
    }
  } catch (error) {
    localError = error;
    if (!localErrorAllowsExternalFallback(error)) throw error;
  }

  const fallbackReason = localPage
    ? 'local_rendered_content_sparse'
    : localError instanceof ClientPageCrawlerError
      ? localError.code
      : 'local_crawl_failed';
  const external = await tryAutomaticExternalFallback({
    ...shared,
    fallbackReason,
  });
  if (external) return external;
  if (localPage) {
    return {
      page: localPage,
      provider: 'local',
      credentialSource: null,
      fallbackReason: null,
    };
  }
  throw localError;
};

export const __clientPageCrawlerProvidersTestUtils = {
  localResultNeedsExternalFallback,
  localErrorAllowsExternalFallback,
};
