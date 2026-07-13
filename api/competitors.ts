import type { SupabaseClient } from '@supabase/supabase-js';
import {
  COMPETITOR_SEARCH_RESULT_LIMIT,
  MAX_ARTICLE_COMPETITORS,
  type CompetitorSearchMode,
} from '../constants/competitors';
import {
  canonicalizeCompetitorUrl,
  FirecrawlCompetitorError,
  isFirecrawlConfigured,
  searchCompetitorWeb,
  type CompetitorSearchResult,
} from '../server/firecrawlCompetitorService';
import { getCompetitorPreview } from '../server/competitorPreviewCache';
import { getExternalAnalysisSupabaseAdmin } from '../server/externalAnalysisQueue';
import {
  ArticleAccessPolicyError,
  requireArticleReadAccess,
  requireArticleWriteAccess,
} from './articleAccessPolicy';
import {
  ApiSecurityError,
  assertAllowedOrigin,
  assertRequestContentLength,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  toApiSecurityResult,
} from './apiSecurity';
import { deliverApiResult, isRecord, readRequestBody, type ApiResult } from './http.ts';

type SupabaseAdmin = SupabaseClient<any, 'public', any>;

const ACTIVE_JOB_STATUSES = [
  'waiting_for_prerequisites',
  'queued',
  'running',
  'retry_scheduled',
  'paused',
];

class CompetitorApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(options: {
    message: string;
    status?: number;
    code?: string;
    details?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = 'CompetitorApiError';
    this.status = options.status ?? 400;
    this.code = options.code ?? 'competitor_request_failed';
    this.details = options.details;
  }
}

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeSearchMode = (value: unknown): CompetitorSearchMode => (
  value === 'primary_keyword' ? 'primary_keyword' : 'title'
);

const readJsonBody = async (req: any): Promise<Record<string, any>> => {
  try {
    const body = await readRequestBody(req);
    if (!isRecord(body)) throw new Error('not_an_object');
    return body;
  } catch {
    throw new CompetitorApiError({
      message: 'Request body must contain a valid JSON object.',
      code: 'invalid_json',
    });
  }
};

const requireArticleId = (body: Record<string, any>): string => {
  const articleId = toText(body.articleId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(articleId)) {
    throw new CompetitorApiError({
      message: 'A valid articleId is required.',
      code: 'article_id_required',
    });
  }
  return articleId;
};

const listCompetitors = async (
  supabase: SupabaseAdmin,
  articleId: string,
  includeContent: boolean,
) => {
  const competitorColumns = [
    'id,article_id,position,query_type,query_text,source_url,canonical_url,domain,title,description,headings',
    includeContent ? 'content_text' : '',
    'word_count,status,extraction_provider,error_code,error_message,fetched_at,selected_by,created_at,updated_at',
  ].filter(Boolean).join(',');
  const [competitorsResult, activeJobResult, latestJobResult] = await Promise.all([
    supabase
      .from('article_competitors')
      .select(competitorColumns)
      .eq('article_id', articleId)
      .order('position', { ascending: true }),
    supabase
      .from('ai_external_analysis_jobs')
      .select('id,article_id,job_type,status,progress,last_error,last_error_code,attempt_count,retry_count,next_attempt_at,created_at,updated_at')
      .eq('article_id', articleId)
      .eq('job_type', 'competitor_extraction')
      .in('status', ACTIVE_JOB_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('ai_external_analysis_jobs')
      .select('id,article_id,job_type,status,progress,last_error,last_error_code,attempt_count,retry_count,next_attempt_at,completed_at,created_at,updated_at')
      .eq('article_id', articleId)
      .eq('job_type', 'competitor_extraction')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (competitorsResult.error) throw competitorsResult.error;
  if (activeJobResult.error) throw activeJobResult.error;
  if (latestJobResult.error) throw latestJobResult.error;
  return {
    competitors: competitorsResult.data || [],
    activeJob: activeJobResult.data || null,
    latestJob: latestJobResult.data || null,
  };
};

const normalizeSelectedResults = (value: unknown): CompetitorSearchResult[] => {
  if (!Array.isArray(value)) {
    throw new CompetitorApiError({
      message: 'Select at least one competitor result.',
      code: 'competitor_selection_required',
    });
  }
  const normalized: CompetitorSearchResult[] = [];
  const seenUrls = new Set<string>();
  const seenDomains = new Set<string>();

  value.slice(0, MAX_ARTICLE_COMPETITORS + 1).forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const sourceUrl = toText(entry.url) || toText(entry.canonicalUrl);
    if (!sourceUrl) return;
    const canonicalUrl = canonicalizeCompetitorUrl(sourceUrl);
    const domain = new URL(canonicalUrl).hostname.replace(/^www\./i, '');
    if (seenUrls.has(canonicalUrl) || seenDomains.has(domain)) return;
    seenUrls.add(canonicalUrl);
    seenDomains.add(domain);
    normalized.push({
      url: canonicalUrl,
      canonicalUrl,
      domain,
      title: (toText(entry.title) || domain).slice(0, 500),
      description: toText(entry.description).slice(0, 2_000),
      position: Number.isFinite(Number(entry.position)) ? Number(entry.position) : index + 1,
    });
  });

  if (normalized.length === 0) {
    throw new CompetitorApiError({
      message: 'Select at least one valid competitor result.',
      code: 'competitor_selection_required',
    });
  }
  if (normalized.length > MAX_ARTICLE_COMPETITORS || value.length > MAX_ARTICLE_COMPETITORS) {
    throw new CompetitorApiError({
      message: `No more than ${MAX_ARTICLE_COMPETITORS} competitors can be selected.`,
      code: 'competitor_selection_limit',
    });
  }
  return normalized;
};

const enqueueExtraction = async (
  supabase: SupabaseAdmin,
  options: {
    articleId: string;
    userId: string;
    queryType: CompetitorSearchMode;
    queryText: string;
    results: CompetitorSearchResult[];
  },
) => {
  const sources = options.results.map(result => ({
    url: result.url,
    canonicalUrl: result.canonicalUrl,
    domain: result.domain,
    title: result.title,
    description: result.description,
    searchPosition: result.position,
  }));
  const { data, error } = await supabase.rpc('enqueue_competitor_extraction_job', {
    p_article_id: options.articleId,
    p_requested_by: options.userId,
    p_query_type: options.queryType,
    p_query_text: options.queryText,
    p_sources: sources,
  });
  if (error?.code === 'P0001' && /active/i.test(error.message || '')) {
    throw new CompetitorApiError({
      message: 'A competitor extraction task is already active for this article.',
      status: 409,
      code: 'competitor_extraction_already_active',
    });
  }
  if (error) throw error;
  return data;
};

const cancelExtraction = async (
  supabase: SupabaseAdmin,
  articleId: string,
  userId: string,
) => {
  const { data: activeJob, error: readError } = await supabase
    .from('ai_external_analysis_jobs')
    .select('id,status')
    .eq('article_id', articleId)
    .eq('job_type', 'competitor_extraction')
    .in('status', ACTIVE_JOB_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readError) throw readError;
  if (!activeJob) return { cancelled: false, job: null };

  const { data, error } = await supabase.rpc('request_external_analysis_job_cancel', {
    p_job_id: activeJob.id,
    p_requested_by: userId,
  });
  if (error) throw error;
  const { error: competitorError } = await supabase
    .from('article_competitors')
    .update({ status: 'cancelled', error_code: 'cancelled_by_user', error_message: 'Extraction cancelled by the user.' })
    .eq('article_id', articleId)
    .in('status', ['queued', 'extracting', 'retry_scheduled']);
  if (competitorError) throw competitorError;
  return { cancelled: true, job: Array.isArray(data) ? data[0] || activeJob : data || activeJob };
};

const removeCompetitor = async (
  supabase: SupabaseAdmin,
  articleId: string,
  competitorId: string,
) => {
  const { data, error } = await supabase
    .from('article_competitors')
    .delete()
    .eq('id', competitorId)
    .eq('article_id', articleId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new CompetitorApiError({
      message: 'Competitor source was not found.',
      status: 404,
      code: 'competitor_not_found',
    });
  }
  const { error: syncError } = await supabase.rpc('sync_article_competitors_metadata', {
    p_article_id: articleId,
  });
  if (syncError) throw syncError;
};

const handleCompetitorsRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === 'OPTIONS') {
    return { status: 204, headers: getCorsPreflightHeaders(req, 'POST, OPTIONS') };
  }
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'Method not allowed. Use POST.' } };
  }
  assertAllowedOrigin(req);
  assertRequestContentLength(req, 96 * 1024);
  const body = await readJsonBody(req);
  const action = toText(body.action);
  const articleId = requireArticleId(body);
  const principal = await authenticateApiRequest(req);
  const supabase = getExternalAnalysisSupabaseAdmin() as SupabaseAdmin;

  if (action === 'list') {
    consumeApiRateLimit('competitors-list', principal.userId, 120);
    await requireArticleReadAccess(supabase, articleId, principal.userId);
    const state = await listCompetitors(supabase, articleId, body.includeContent !== false);
    return {
      status: 200,
      body: { ok: true, action, providerConfigured: isFirecrawlConfigured(), ...state },
      headers: getCorsResponseHeaders(req),
    };
  }

  await requireArticleWriteAccess(supabase, articleId, principal.userId);
  if (action === 'search') {
    consumeApiRateLimit('competitors-search', principal.userId, 20);
    const query = toText(body.query);
    const results = await searchCompetitorWeb({
      query,
      limit: COMPETITOR_SEARCH_RESULT_LIMIT,
    });
    return {
      status: 200,
      body: { ok: true, action, query, results },
      headers: getCorsResponseHeaders(req),
    };
  }
  if (action === 'preview') {
    consumeApiRateLimit('competitors-preview', principal.userId, 15);
    const preview = await getCompetitorPreview({ url: toText(body.url) });
    return {
      status: 200,
      body: {
        ok: true,
        action,
        preview: {
          url: preview.url,
          canonicalUrl: preview.canonicalUrl,
          fetchedUrl: preview.fetchedUrl,
          domain: preview.domain,
          title: preview.title,
          description: preview.description,
          headings: preview.headings,
          text: preview.text,
          wordCount: preview.wordCount,
          provider: preview.provider,
          cacheHit: preview.cacheHit,
          fetchedAt: preview.fetchedAt,
          expiresAt: preview.expiresAt,
        },
      },
      headers: getCorsResponseHeaders(req),
    };
  }
  if (action === 'extract') {
    consumeApiRateLimit('competitors-extract', principal.userId, 10);
    if (!isFirecrawlConfigured()) {
      throw new CompetitorApiError({
        message: 'FIRECRAWL_API_KEY is not configured on the server.',
        status: 503,
        code: 'firecrawl_not_configured',
      });
    }
    const queryText = toText(body.query);
    const results = normalizeSelectedResults(body.results);
    const queued = await enqueueExtraction(supabase, {
      articleId,
      userId: principal.userId,
      queryType: normalizeSearchMode(body.queryType),
      queryText,
      results,
    });
    return {
      status: 202,
      body: { ok: true, action, queued },
      headers: getCorsResponseHeaders(req),
    };
  }
  if (action === 'cancel') {
    consumeApiRateLimit('competitors-cancel', principal.userId, 30);
    const result = await cancelExtraction(supabase, articleId, principal.userId);
    return {
      status: 200,
      body: { ok: true, action, ...result },
      headers: getCorsResponseHeaders(req),
    };
  }
  if (action === 'remove') {
    consumeApiRateLimit('competitors-remove', principal.userId, 30);
    const competitorId = toText(body.competitorId);
    if (!competitorId) {
      throw new CompetitorApiError({ message: 'competitorId is required.', code: 'competitor_id_required' });
    }
    await removeCompetitor(supabase, articleId, competitorId);
    return {
      status: 200,
      body: { ok: true, action },
      headers: getCorsResponseHeaders(req),
    };
  }

  throw new CompetitorApiError({
    message: 'action must be list, search, preview, extract, cancel, or remove.',
    code: 'invalid_action',
  });
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(await handleCompetitorsRequest(req), res);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) return deliverApiResult(securityResult, res);

    const status = error instanceof CompetitorApiError
      || error instanceof ArticleAccessPolicyError
      || error instanceof FirecrawlCompetitorError
      ? error.status
      : error instanceof ApiSecurityError
        ? error.status
        : 500;
    const code = error instanceof CompetitorApiError || error instanceof FirecrawlCompetitorError
      ? error.code
      : error instanceof ArticleAccessPolicyError
        ? 'article_access_denied'
        : 'competitor_request_failed';
    const details = error instanceof CompetitorApiError ? error.details : undefined;
    const message = error instanceof Error ? error.message : 'Unknown competitor request error.';
    if (status >= 500) console.error('Competitor request failed:', error);
    return deliverApiResult({
      status,
      body: { ok: false, code, error: message, ...(details || {}) },
    }, res);
  }
}
