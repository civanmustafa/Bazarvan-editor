import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assertAllowedOrigin,
  assertRequestContentLength,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  getPositiveIntegerEnv,
  toApiSecurityResult,
} from './apiSecurity';
import { deliverApiResult, isRecord, readRequestBody, type ApiResult } from './http';
import { getExternalAnalysisSupabaseAdmin } from '../server/externalAnalysisQueue';
import {
  sanitizeDiscoveredClientUrl,
  type AllowedClientDomain,
} from '../server/clientPageCrawler';
import {
  normalizeClientSiteCrawlProvider,
} from '../constants/crawlerProviders';
import { readCrawlerProviderSecretsOverview } from '../server/crawlerProviderSecrets';

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

class ClientSiteCrawlerApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'client_site_crawl_request_failed') {
    super(message);
    this.name = 'ClientSiteCrawlerApiError';
    this.status = status;
    this.code = code;
  }
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const integer = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
};

const getRequestUrl = (req: any): URL => {
  const raw = String(req?.url || '/api/client-site-crawl');
  return new URL(raw, 'http://local.bazarvan');
};

const assertClientAccess = async (
  supabase: SupabaseAdmin,
  clientId: string,
  userId: string,
  write = false,
): Promise<void> => {
  const { data, error } = await supabase.rpc('client_access_level_for_user', {
    target_client_id: clientId,
    target_user_id: userId,
  });
  if (error) throw error;
  const access = text(Array.isArray(data) ? data[0] : data);
  if (!access || (write && access !== 'admin' && access !== 'editor')) {
    throw new ClientSiteCrawlerApiError(
      write ? 'Client editor access is required.' : 'Client access is required.',
      403,
      'client_access_denied',
    );
  }
};

const loadAllowedDomains = async (
  supabase: SupabaseAdmin,
  clientId: string,
): Promise<AllowedClientDomain[]> => {
  const { data, error } = await supabase
    .from('client_domains')
    .select('hostname,include_subdomains')
    .eq('client_id', clientId)
    .eq('is_active', true);
  if (error) throw error;
  return (data || []).map(row => ({
    hostname: text(row.hostname).toLowerCase(),
    includeSubdomains: row.include_subdomains === true,
  })).filter(domain => domain.hostname);
};

const normalizeStartUrl = (
  value: unknown,
  domains: AllowedClientDomain[],
): string => {
  const raw = text(value);
  if (!raw) {
    throw new ClientSiteCrawlerApiError(
      'A start URL is required.',
      400,
      'client_site_crawl_start_url_required',
    );
  }

  let normalized = raw;
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  const url = sanitizeDiscoveredClientUrl(normalized, '', domains);
  if (!url) {
    throw new ClientSiteCrawlerApiError(
      'The start URL must belong to an approved active client domain.',
      400,
      'client_site_crawl_domain_not_allowed',
    );
  }
  return url;
};

const listCrawlState = async (
  supabase: SupabaseAdmin,
  clientId: string,
  includeLinks: boolean,
): Promise<ApiResult> => {
  const [runsResult, linksCountResult, providerOverview] = await Promise.all([
    supabase
      .from('client_site_crawl_runs')
      .select('id,client_id,started_by,start_url,status,provider,max_pages,max_depth,follow_nofollow,pages_discovered,pages_queued,pages_completed,pages_failed,limit_reached,started_at,finished_at,created_at,updated_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('client_internal_links')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('is_active', true),
    readCrawlerProviderSecretsOverview(),
  ]);
  if (runsResult.error) throw runsResult.error;
  if (linksCountResult.error) throw linksCountResult.error;

  let links: unknown[] = [];
  if (includeLinks) {
    const { data, error } = await supabase
      .from('client_internal_links')
      .select('id,source_page_id,target_page_id,target_url,anchor_text,rel_nofollow,rel_sponsored,rel_ugc,crawlable,occurrence_count,last_seen_at')
      .eq('client_id', clientId)
      .eq('is_active', true)
      .order('last_seen_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    links = data || [];
  }

  return {
    status: 200,
    body: {
      ok: true,
      runs: runsResult.data || [],
      activeInternalLinkCount: linksCountResult.count || 0,
      providerAvailability: {
        auto: true,
        local: true,
        firecrawl: providerOverview.providers.firecrawl.effectiveConfigured,
        browserless: providerOverview.providers.browserless.effectiveConfigured,
      },
      links,
    },
  };
};

const startCrawl = async (
  supabase: SupabaseAdmin,
  userId: string,
  body: Record<string, unknown>,
): Promise<ApiResult> => {
  const clientId = text(body.clientId);
  if (!clientId) {
    throw new ClientSiteCrawlerApiError(
      'clientId is required.',
      400,
      'client_id_required',
    );
  }
  await assertClientAccess(supabase, clientId, userId, true);
  const domains = await loadAllowedDomains(supabase, clientId);
  if (domains.length === 0) {
    throw new ClientSiteCrawlerApiError(
      'The client has no approved active domain.',
      409,
      'client_domain_missing',
    );
  }

  const startUrl = normalizeStartUrl(body.startUrl, domains);
  const maxPages = integer(body.maxPages, 250, 1, 2_000);
  const maxDepth = integer(body.maxDepth, 6, 0, 20);
  const followNofollow = body.followNofollow === true;
  const provider = normalizeClientSiteCrawlProvider(body.provider);
  if (provider === 'firecrawl' || provider === 'browserless') {
    const overview = await readCrawlerProviderSecretsOverview();
    if (!overview.providers[provider].effectiveConfigured) {
      throw new ClientSiteCrawlerApiError(
        `${provider} is not configured by an administrator.`,
        409,
        'crawler_provider_not_configured',
      );
    }
  }
  const { data, error } = await supabase.rpc('start_client_site_crawl', {
    p_client_id: clientId,
    p_started_by: userId,
    p_start_url: startUrl,
    p_max_pages: maxPages,
    p_max_depth: maxDepth,
    p_follow_nofollow: followNofollow,
    p_provider: provider,
  });
  if (error) {
    const activeConflict = /active site crawl|duplicate key|unique/i.test(error.message || '');
    throw new ClientSiteCrawlerApiError(
      activeConflict
        ? 'An active site crawl already exists for this client.'
        : error.message || 'Could not start the site crawl.',
      activeConflict ? 409 : 400,
      activeConflict ? 'client_site_crawl_already_active' : 'client_site_crawl_start_failed',
    );
  }

  return {
    status: 202,
    body: {
      ok: true,
      run: Array.isArray(data) ? data[0] : data,
    },
  };
};

const cancelCrawl = async (
  supabase: SupabaseAdmin,
  userId: string,
  body: Record<string, unknown>,
): Promise<ApiResult> => {
  const runId = text(body.runId);
  if (!runId) {
    throw new ClientSiteCrawlerApiError('runId is required.', 400, 'crawl_run_id_required');
  }

  const { data: run, error: runError } = await supabase
    .from('client_site_crawl_runs')
    .select('client_id')
    .eq('id', runId)
    .maybeSingle();
  if (runError) throw runError;
  if (!run) {
    throw new ClientSiteCrawlerApiError('The site crawl was not found.', 404, 'crawl_run_not_found');
  }
  await assertClientAccess(supabase, text(run.client_id), userId, true);

  const { data, error } = await supabase.rpc('cancel_client_site_crawl', {
    p_run_id: runId,
    p_requested_by: userId,
  });
  if (error) throw error;
  return {
    status: 200,
    body: {
      ok: true,
      run: Array.isArray(data) ? data[0] : data,
    },
  };
};

const handleRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      headers: getCorsPreflightHeaders(req, 'GET, POST, OPTIONS'),
    };
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return {
      status: 405,
      body: { ok: false, error: 'Method not allowed. Use GET or POST.' },
      headers: { Allow: 'GET, POST, OPTIONS' },
    };
  }

  assertAllowedOrigin(req);
  assertRequestContentLength(req, 32_000);
  const principal = await authenticateApiRequest(req);
  consumeApiRateLimit(
    'client-site-crawl',
    principal.userId,
    getPositiveIntegerEnv('CLIENT_SITE_CRAWL_API_RATE_LIMIT', 30, 300),
  );
  const supabase = getExternalAnalysisSupabaseAdmin();

  if (req.method === 'GET') {
    const url = getRequestUrl(req);
    const clientId = text(url.searchParams.get('clientId'));
    if (!clientId) {
      throw new ClientSiteCrawlerApiError('clientId is required.', 400, 'client_id_required');
    }
    await assertClientAccess(supabase, clientId, principal.userId);
    const result = await listCrawlState(
      supabase,
      clientId,
      url.searchParams.get('includeLinks') === 'true',
    );
    return { ...result, headers: getCorsResponseHeaders(req) };
  }

  const body = await readRequestBody(req);
  if (!isRecord(body)) {
    throw new ClientSiteCrawlerApiError('A JSON request object is required.');
  }
  const action = text(body.action) || 'start';
  const result = action === 'cancel'
    ? await cancelCrawl(supabase, principal.userId, body)
    : action === 'start'
      ? await startCrawl(supabase, principal.userId, body)
      : (() => {
        throw new ClientSiteCrawlerApiError(
          'Unsupported action. Use start or cancel.',
          400,
          'unsupported_client_site_crawl_action',
        );
      })();
  return { ...result, headers: getCorsResponseHeaders(req) };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(await handleRequest(req), res);
  } catch (error) {
    const security = toApiSecurityResult(error);
    const status = security?.status
      ?? (error instanceof ClientSiteCrawlerApiError ? error.status : 500);
    const code = error instanceof ClientSiteCrawlerApiError
      ? error.code
      : 'client_site_crawl_api_error';
    const message = security?.body.error
      ?? (error instanceof Error ? error.message : 'Unknown site crawler error.');
    if (status >= 500) console.error('Client site crawler API failed:', error);
    return deliverApiResult({
      status,
      body: { ok: false, error: message, code },
      headers: security?.headers,
    }, res);
  }
}
