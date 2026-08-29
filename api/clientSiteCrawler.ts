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
import { resolveCrawlerProviderCredential } from '../server/crawlerProviderSecrets';
import {
  readCrawlerProviderMonthlyUsage,
  readCrawlerUsagePolicy,
} from '../server/crawlerUsagePolicy';

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
): Promise<string> => {
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
  return access;
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
  userId: string,
): Promise<ApiResult> => {
  const [
    runsResult,
    linksCountResult,
    firecrawlCredential,
    browserlessCredential,
    usagePolicy,
  ] = await Promise.all([
    supabase
      .from('client_site_crawl_runs')
      .select('id,client_id,started_by,start_url,status,provider,max_pages,max_depth,follow_nofollow,pages_discovered,pages_queued,pages_completed,pages_failed,pages_reused,external_requests_used,max_external_requests,external_reuse_days,force_external_refresh,limit_reached,started_at,finished_at,created_at,updated_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('client_internal_links')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('is_active', true),
    resolveCrawlerProviderCredential('firecrawl', userId),
    resolveCrawlerProviderCredential('browserless', userId),
    readCrawlerUsagePolicy(),
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
        firecrawl: Boolean(firecrawlCredential),
        browserless: Boolean(browserlessCredential),
      },
      usagePolicy,
      monthlyUsage: await readCrawlerProviderMonthlyUsage(usagePolicy),
      links,
    },
  };
};

const isFreshReusablePage = (
  page: Record<string, unknown>,
  reuseDays: number,
  activeLinkSources: Set<string>,
): boolean => {
  const lastSuccess = Date.parse(text(page.last_success_at));
  const ageLimit = Date.now() - reuseDays * 86_400_000;
  const status = text(page.crawl_status);
  const httpStatus = Number(page.http_status) || 0;
  return page.is_enabled === true
    && ['ready', 'needs_review', 'redirected', 'noindex'].includes(status)
    && httpStatus >= 200
    && httpStatus <= 399
    && Number.isFinite(lastSuccess)
    && lastSuccess >= ageLimit
    && (
      Number(page.word_count) >= 40
      || activeLinkSources.has(text(page.id))
    );
};

const estimateCrawl = async (
  supabase: SupabaseAdmin,
  userId: string,
  body: Record<string, unknown>,
): Promise<ApiResult> => {
  const clientId = text(body.clientId);
  if (!clientId) {
    throw new ClientSiteCrawlerApiError('clientId is required.', 400, 'client_id_required');
  }
  await assertClientAccess(supabase, clientId, userId);
  const domains = await loadAllowedDomains(supabase, clientId);
  const startUrl = normalizeStartUrl(body.startUrl, domains);
  const maxPages = integer(body.maxPages, 250, 1, 2_000);
  const maxDepth = integer(body.maxDepth, 6, 0, 20);
  const followNofollow = body.followNofollow === true;
  const provider = normalizeClientSiteCrawlProvider(body.provider);
  const forceExternalRefresh = body.forceExternalRefresh === true;
  const policy = await readCrawlerUsagePolicy();
  const [pagesResult, linksResult, monthlyUsage] = await Promise.all([
    supabase
      .from('client_pages')
      .select('id,input_url,final_url,canonical_url,crawl_status,http_status,word_count,robots_follow,last_success_at,is_enabled')
      .eq('client_id', clientId)
      .eq('is_enabled', true)
      .limit(2_000),
    supabase
      .from('client_internal_links')
      .select('source_page_id,target_page_id,target_url,rel_nofollow,crawlable')
      .eq('client_id', clientId)
      .eq('is_active', true)
      .limit(20_000),
    readCrawlerProviderMonthlyUsage(policy),
  ]);
  if (pagesResult.error) throw pagesResult.error;
  if (linksResult.error) throw linksResult.error;

  const pages = (pagesResult.data || []) as Array<Record<string, unknown>>;
  const links = (linksResult.data || []) as Array<Record<string, unknown>>;
  const pagesById = new Map(pages.map(page => [text(page.id), page]));
  const pagesByUrl = new Map<string, string>();
  pages.forEach(page => {
    for (const value of [page.input_url, page.final_url, page.canonical_url]) {
      const url = text(value);
      if (url) pagesByUrl.set(url, text(page.id));
    }
  });
  const linksBySource = new Map<string, Array<Record<string, unknown>>>();
  const activeLinkSources = new Set<string>();
  links.forEach(link => {
    const sourceId = text(link.source_page_id);
    if (!sourceId) return;
    activeLinkSources.add(sourceId);
    const current = linksBySource.get(sourceId) || [];
    current.push(link);
    linksBySource.set(sourceId, current);
  });

  const startPageId = pagesByUrl.get(startUrl) || '';
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = startPageId
    ? [{ id: startPageId, depth: 0 }]
    : [];
  while (queue.length > 0 && visited.size < maxPages) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    const currentPage = pagesById.get(current.id);
    if (!currentPage) continue;
    visited.add(current.id);
    if (
      current.depth >= maxDepth
      || (currentPage.robots_follow === false && !followNofollow)
    ) continue;
    for (const link of linksBySource.get(current.id) || []) {
      if (
        link.crawlable === false
        || (link.rel_nofollow === true && !followNofollow)
      ) continue;
      const targetId = text(link.target_page_id)
        || pagesByUrl.get(text(link.target_url))
        || '';
      if (targetId && !visited.has(targetId)) {
        queue.push({ id: targetId, depth: current.depth + 1 });
      }
    }
  }

  const knownPages = startPageId ? visited.size : 1;
  const directExternal = provider === 'firecrawl' || provider === 'browserless';
  const reusablePages = directExternal && !forceExternalRefresh
    ? [...visited].filter(id => {
      const page = pagesById.get(id);
      return page
        ? isFreshReusablePage(page, policy.externalReuseDays, activeLinkSources)
        : false;
    }).length
    : 0;
  const providerRemaining = directExternal
    ? monthlyUsage[provider].remaining
    : provider === 'auto'
      ? monthlyUsage.firecrawl.remaining + monthlyUsage.browserless.remaining
      : 0;
  const maximumExternalRequests = directExternal || provider === 'auto'
    ? Math.min(
        maxPages,
        policy.maxExternalRequestsPerRun,
        providerRemaining,
      )
    : 0;
  const estimatedExternalRequests = directExternal
    ? Math.min(
        Math.max(startPageId ? knownPages - reusablePages : 1, 0),
        maximumExternalRequests,
      )
    : 0;

  return {
    status: 200,
    body: {
      ok: true,
      estimate: {
        knownPages,
        reusablePages,
        estimatedExternalRequests,
        maximumExternalRequests,
        unknownCapacity: Math.max(0, maxPages - knownPages),
        externalReuseDays: policy.externalReuseDays,
        maxExternalRequestsPerRun: policy.maxExternalRequestsPerRun,
        monthlyRemaining: directExternal ? monthlyUsage[provider].remaining : providerRemaining,
        provider,
        forceExternalRefresh,
      },
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
  const access = await assertClientAccess(supabase, clientId, userId, true);
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
  const forceExternalRefresh = body.forceExternalRefresh === true;
  if (forceExternalRefresh && access !== 'admin') {
    throw new ClientSiteCrawlerApiError(
      'Only administrators can force a full external refresh.',
      403,
      'full_external_refresh_admin_required',
    );
  }
  if (forceExternalRefresh && body.confirmFullExternalRefresh !== true) {
    throw new ClientSiteCrawlerApiError(
      'A full external refresh requires explicit confirmation.',
      400,
      'full_external_refresh_confirmation_required',
    );
  }
  if (
    forceExternalRefresh
    && provider !== 'firecrawl'
    && provider !== 'browserless'
  ) {
    throw new ClientSiteCrawlerApiError(
      'A full external refresh requires Firecrawl or Browserless.',
      400,
      'full_external_refresh_provider_required',
    );
  }
  const usagePolicy = await readCrawlerUsagePolicy();
  if (provider === 'firecrawl' || provider === 'browserless') {
    const credential = await resolveCrawlerProviderCredential(provider, userId);
    if (!credential) {
      throw new ClientSiteCrawlerApiError(
        `${provider} has no credential available for this user.`,
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
    p_external_reuse_days: usagePolicy.externalReuseDays,
    p_force_external_refresh: forceExternalRefresh,
    p_max_external_requests: usagePolicy.maxExternalRequestsPerRun,
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
      principal.userId,
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
    : action === 'estimate'
      ? await estimateCrawl(supabase, principal.userId, body)
    : action === 'start'
      ? await startCrawl(supabase, principal.userId, body)
      : (() => {
        throw new ClientSiteCrawlerApiError(
          'Unsupported action. Use start, estimate, or cancel.',
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
