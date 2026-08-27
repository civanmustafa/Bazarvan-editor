import type { SupabaseClient } from '@supabase/supabase-js';
import {
  COMPETITOR_CONTENT_MAX_CHARS,
  COMPETITOR_SEARCH_CANDIDATE_LIMIT,
  COMPETITOR_SEARCH_RESULT_LIMIT,
  MAX_ARTICLE_COMPETITORS,
  type CompetitorSearchMode,
} from '../constants/competitors';
import {
  getUsableCompetitorText,
  isCompetitorExtractionFailureText,
} from '../utils/competitorContent';
import {
  canonicalizeCompetitorUrl,
  FirecrawlCompetitorError,
  isFirecrawlConfigured,
  searchCompetitorWeb,
  type CompetitorSearchResult,
} from '../server/firecrawlCompetitorService';
import {
  analyzeAndSelectCompetitors,
  extractCompetitorOwnDomains,
  isCompetitorOwnDomain,
  isCompetitorLanguageCompatible,
  resolveCompetitorCountryCode,
} from '../server/competitorSelectionEngine.ts';
import { loadArticleClientOwnDomains } from '../server/clientCompetitorExclusions.ts';
import { getCompetitorPreview } from '../server/competitorPreviewCache';
import {
  getProgrammaticCompetitorContent,
  ProgrammaticCompetitorExtractionError,
} from '../server/programmaticCompetitorExtractor';
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
  const [competitorsResult, activeJobResult, latestJobResult, discoveryStateResult, discoveryJobsResult] = await Promise.all([
    supabase
      .from('article_competitors')
      .select(`${competitorColumns},discovery_signature`)
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
    supabase
      .from('ai_external_analysis_article_state')
      .select('competitor_discovery_ready,competitor_discovery_missing_fields,competitor_discovery_signature')
      .eq('article_id', articleId)
      .maybeSingle(),
    supabase
      .from('ai_external_analysis_jobs')
      .select('id,article_id,job_type,origin,status,readiness_signature,input_snapshot,result,progress,last_error,last_error_code,attempt_count,retry_count,next_attempt_at,completed_at,created_at,updated_at')
      .eq('article_id', articleId)
      .eq('job_type', 'competitor_discovery')
      .order('created_at', { ascending: false })
      .limit(10),
  ]);
  if (competitorsResult.error) throw competitorsResult.error;
  if (activeJobResult.error) throw activeJobResult.error;
  if (latestJobResult.error) throw latestJobResult.error;
  if (discoveryStateResult.error) throw discoveryStateResult.error;
  if (discoveryJobsResult.error) throw discoveryJobsResult.error;
  const discoveryState = discoveryStateResult.data || null;
  const discoverySignature = toText(discoveryState?.competitor_discovery_signature);
  const discoveryJobs = discoveryJobsResult.data || [];
  const discoveryJob = discoveryJobs.find(job => (
    !discoverySignature || job.readiness_signature === discoverySignature
  )) || discoveryJobs[0] || null;
  return {
    competitors: competitorsResult.data || [],
    activeJob: activeJobResult.data || null,
    latestJob: latestJobResult.data || null,
    discoveryState,
    discoveryJob,
  };
};

const readCompetitorDiscoveryState = async (
  supabase: SupabaseAdmin,
  articleId: string,
) => {
  const { data, error } = await supabase
    .from('ai_external_analysis_article_state')
    .select('competitor_discovery_ready,competitor_discovery_missing_fields,competitor_discovery_signature')
    .eq('article_id', articleId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const readArticleLanguage = async (
  supabase: SupabaseAdmin,
  articleId: string,
): Promise<'ar' | 'en'> => {
  const { data, error } = await supabase
    .from('articles')
    .select('article_language')
    .eq('id', articleId)
    .single();
  if (error) throw error;
  return data?.article_language === 'en' ? 'en' : 'ar';
};

const persistCompetitorDiscoveryResult = async (
  supabase: SupabaseAdmin,
  options: {
    articleId: string;
    userId: string;
    inputSnapshot: Record<string, unknown>;
    result: Record<string, unknown>;
  },
) => {
  const { data, error } = await supabase.rpc('save_competitor_discovery_result', {
    p_article_id: options.articleId,
    p_requested_by: options.userId,
    p_input_snapshot: options.inputSnapshot,
    p_result: options.result,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : data || null;
};

const markCompetitorSelectionAccepted = async (
  supabase: SupabaseAdmin,
  options: {
    articleId: string;
    userId: string;
    discoverySignature: string;
    selectedUrls: string[];
  },
): Promise<void> => {
  if (!options.discoverySignature) return;
  const { data: job, error: readError } = await supabase
    .from('ai_external_analysis_jobs')
    .select('id,result')
    .eq('article_id', options.articleId)
    .eq('job_type', 'competitor_discovery')
    .eq('readiness_signature', options.discoverySignature)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readError) throw readError;
  if (!job) return;
  const result = isRecord(job.result) ? job.result : {};
  const { error: updateError } = await supabase
    .from('ai_external_analysis_jobs')
    .update({
      result: {
        ...result,
        reviewStatus: 'accepted',
        reviewedBy: options.userId,
        reviewedAt: new Date().toISOString(),
        selectedUrls: options.selectedUrls,
      },
      progress: {
        stage: 'selection_accepted',
        selectedCount: options.selectedUrls.length,
        updatedAt: new Date().toISOString(),
      },
    })
    .eq('id', job.id);
  if (updateError) throw updateError;
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
    let canonicalUrl = '';
    try {
      canonicalUrl = canonicalizeCompetitorUrl(sourceUrl);
    } catch (error) {
      if (error instanceof FirecrawlCompetitorError && error.code === 'unsupported_competitor_file') return;
      throw error;
    }
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

const cancelCompetitorJob = async (
  supabase: SupabaseAdmin,
  articleId: string,
  userId: string,
  jobType: 'competitor_discovery' | 'competitor_extraction',
) => {
  const { data: activeJob, error: readError } = await supabase
    .from('ai_external_analysis_jobs')
    .select('id,status')
    .eq('article_id', articleId)
    .eq('job_type', jobType)
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
  if (jobType === 'competitor_extraction') {
    const { error: competitorError } = await supabase
      .from('article_competitors')
      .update({ status: 'cancelled', error_code: 'cancelled_by_user', error_message: 'Extraction cancelled by the user.' })
      .eq('article_id', articleId)
      .in('status', ['queued', 'extracting', 'retry_scheduled']);
    if (competitorError) throw competitorError;
  }
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

const saveManualCompetitorText = async (
  supabase: SupabaseAdmin,
  articleId: string,
  position: number,
  rawContentText: unknown,
) => {
  if (!Number.isInteger(position) || position < 1 || position > MAX_ARTICLE_COMPETITORS) {
    throw new CompetitorApiError({
      message: 'Competitor position is invalid.',
      code: 'competitor_position_invalid',
    });
  }
  const contentText = getUsableCompetitorText(rawContentText);
  if (!contentText || isCompetitorExtractionFailureText(rawContentText)) {
    throw new CompetitorApiError({
      message: 'Manual competitor text is required.',
      code: 'competitor_manual_text_required',
    });
  }
  if (contentText.length > COMPETITOR_CONTENT_MAX_CHARS) {
    throw new CompetitorApiError({
      message: `Manual competitor text exceeds ${COMPETITOR_CONTENT_MAX_CHARS} characters.`,
      status: 413,
      code: 'competitor_manual_text_too_large',
    });
  }

  const { data, error } = await supabase
    .from('article_competitors')
    .update({
      content_text: contentText,
      word_count: contentText.split(/\s+/u).filter(Boolean).length,
      status: 'completed',
      extraction_provider: 'manual',
      error_code: null,
      error_message: null,
      fetched_at: new Date().toISOString(),
    })
    .eq('article_id', articleId)
    .eq('position', position)
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
  // Manual Arabic text can consume several UTF-8 bytes per character. Keep the
  // transport ceiling aligned with COMPETITOR_CONTENT_MAX_CHARS while retaining
  // one bounded limit for every action handled by this endpoint.
  assertRequestContentLength(req, (COMPETITOR_CONTENT_MAX_CHARS * 4) + (32 * 1024));
  const body = await readJsonBody(req);
  const action = toText(body.action);
  const principal = await authenticateApiRequest(req);
  const supabase = getExternalAnalysisSupabaseAdmin() as SupabaseAdmin;

  if (action === 'programmatic_extract') {
    consumeApiRateLimit('competitors-programmatic-extract', principal.userId, 20);
    const controller = new AbortController();
    const requestSignal = req?.signal && typeof req.signal.addEventListener === 'function'
      ? req.signal as AbortSignal
      : null;
    const abortFromRequest = () => controller.abort(requestSignal?.reason);
    const abortFromNodeRequest = () => controller.abort(new Error('The request was aborted by the user.'));
    requestSignal?.addEventListener('abort', abortFromRequest, { once: true });
    if (typeof req?.once === 'function') req.once('aborted', abortFromNodeRequest);
    try {
      const content = await getProgrammaticCompetitorContent({
        url: toText(body.url),
        signal: controller.signal,
        forceRefresh: body.forceRefresh === true,
      });
      return {
        status: 200,
        body: { ok: true, action, content },
        headers: getCorsResponseHeaders(req),
      };
    } finally {
      requestSignal?.removeEventListener('abort', abortFromRequest);
      if (typeof req?.off === 'function') req.off('aborted', abortFromNodeRequest);
    }
  }

  const articleId = requireArticleId(body);
  if (action === 'list') {
    consumeApiRateLimit('competitors-list', principal.userId, 120);
    await requireArticleReadAccess(supabase, articleId, principal.userId);
    const state = await listCompetitors(supabase, articleId, body.includeContent !== false);
    return {
      status: 200,
      body: { ok: true, action, providerConfigured: await isFirecrawlConfigured(principal.userId), ...state },
      headers: getCorsResponseHeaders(req),
    };
  }

  await requireArticleWriteAccess(supabase, articleId, principal.userId);
  if (action === 'save_manual_text') {
    consumeApiRateLimit('competitors-save-manual-text', principal.userId, 60);
    await saveManualCompetitorText(
      supabase,
      articleId,
      Number(body.position),
      body.contentText,
    );
    return {
      status: 200,
      body: { ok: true, action },
      headers: getCorsResponseHeaders(req),
    };
  }
  if (action === 'ensure_discovery') {
    consumeApiRateLimit('competitors-ensure-discovery', principal.userId, 30);
    const { data: jobId, error: enqueueError } = await supabase.rpc(
      'enqueue_competitor_discovery_job',
      {
        p_article_id: articleId,
        p_requested_by: principal.userId,
        p_origin: 'manual',
      },
    );
    if (enqueueError) throw enqueueError;
    const normalizedJobId = toText(Array.isArray(jobId) ? jobId[0] : jobId);
    if (!normalizedJobId) {
      const state = await readCompetitorDiscoveryState(supabase, articleId);
      throw new CompetitorApiError({
        message: 'Competitor discovery prerequisites are incomplete.',
        status: 409,
        code: 'competitor_discovery_prerequisites_missing',
        details: {
          missingFields: Array.isArray(state?.competitor_discovery_missing_fields)
            ? state.competitor_discovery_missing_fields
            : [],
        },
      });
    }
    const { data: job, error: jobError } = await supabase
      .from('ai_external_analysis_jobs')
      .select('id,article_id,job_type,origin,status,readiness_signature,input_snapshot,result,progress,last_error,last_error_code,attempt_count,retry_count,next_attempt_at,completed_at,created_at,updated_at')
      .eq('id', normalizedJobId)
      .single();
    if (jobError) throw jobError;
    return {
      status: ACTIVE_JOB_STATUSES.includes(String(job.status)) ? 202 : 200,
      body: { ok: true, action, job },
      headers: getCorsResponseHeaders(req),
    };
  }
  if (action === 'search') {
    consumeApiRateLimit('competitors-search', principal.userId, 20);
    const query = toText(body.query);
    const queryType = normalizeSearchMode(body.queryType);
    const articleTitle = toText(body.articleTitle).slice(0, 500);
    const primaryKeyword = toText(body.primaryKeyword).slice(0, 500);
    const language = await readArticleLanguage(supabase, articleId);
    const pageType = toText(body.pageType).slice(0, 100);
    const searchIntent = toText(body.searchIntent).slice(0, 100);
    const audienceScope = toText(body.audienceScope).slice(0, 100);
    const targetCountry = toText(body.targetCountry).slice(0, 160);
    const companyName = toText(body.companyName).slice(0, 500);
    const ownDomains = extractCompetitorOwnDomains(
      companyName,
      ...(await loadArticleClientOwnDomains(supabase, articleId, companyName)),
    );
    const candidates = await searchCompetitorWeb({
      query,
      limit: COMPETITOR_SEARCH_CANDIDATE_LIMIT,
      country: resolveCompetitorCountryCode(targetCountry),
      location: targetCountry,
      excludeDomains: ownDomains,
      userId: principal.userId,
    });
    const selection = analyzeAndSelectCompetitors({
      context: {
        query,
        queryType,
        articleTitle,
        primaryKeyword,
        language,
        pageType,
        searchIntent,
        audienceScope,
        targetCountry,
        companyName,
        ownDomains,
      },
      candidates,
      maxResults: COMPETITOR_SEARCH_RESULT_LIMIT,
      maxSelected: MAX_ARTICLE_COMPETITORS,
    });
    const inputSnapshot = {
      queryType,
      queryText: query,
      articleTitle,
      primaryKeyword,
      companyName,
      articleLanguage: language,
      pageType,
      searchIntent,
      audienceScope,
      targetCountry,
    };
    const discoveryJob = await persistCompetitorDiscoveryResult(supabase, {
      articleId,
      userId: principal.userId,
      inputSnapshot,
      result: {
        status: selection.results.length > 0 ? 'awaiting_review' : 'no_results',
        query,
        queryType,
        results: selection.results,
        selection: selection.summary,
        discoveredAt: new Date().toISOString(),
      },
    });
    return {
      status: 200,
      body: {
        ok: true,
        action,
        query,
        queryType,
        results: selection.results,
        selection: selection.summary,
        discoveryJob,
      },
      headers: getCorsResponseHeaders(req),
    };
  }
  if (action === 'preview') {
    consumeApiRateLimit('competitors-preview', principal.userId, 15);
    const preview = await getCompetitorPreview({
      url: toText(body.url),
      userId: principal.userId,
    });
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
    if (!(await isFirecrawlConfigured(principal.userId))) {
      throw new CompetitorApiError({
        message: 'Firecrawl API key is not configured in administrator crawler settings or the server environment.',
        status: 503,
        code: 'firecrawl_not_configured',
      });
    }
    const queryText = toText(body.query);
    const ownDomains = await loadArticleClientOwnDomains(
      supabase,
      articleId,
      toText(body.companyName),
    );
    const articleLanguage = await readArticleLanguage(supabase, articleId);
    const normalizedResults = normalizeSelectedResults(body.results);
    const languageFilteredCount = articleLanguage === 'ar'
      ? normalizedResults.filter(result => !isCompetitorLanguageCompatible(
          'ar',
          `${result.title} ${result.description}`,
        )).length
      : 0;
    const results = normalizedResults
      .filter(result => articleLanguage !== 'ar' || isCompetitorLanguageCompatible(
        'ar',
        `${result.title} ${result.description}`,
      ))
      .filter(result => !isCompetitorOwnDomain(result.domain, ownDomains));
    if (results.length === 0) {
      if (languageFilteredCount > 0) {
        throw new CompetitorApiError({
          message: 'لا يمكن اعتماد صفحة لاتينية كمنافس لمقالة عربية. اختر نتائج عربية ثم أعد المحاولة.',
          code: 'competitor_language_mismatch',
          details: { languageFilteredCount },
        });
      }
      throw new CompetitorApiError({
        message: 'The selected URL belongs to the client domain and cannot be added as a competitor.',
        code: 'client_domain_not_a_competitor',
      });
    }
    const discoveryState = await readCompetitorDiscoveryState(supabase, articleId);
    const discoverySignature = toText(discoveryState?.competitor_discovery_signature);
    const queued = await enqueueExtraction(supabase, {
      articleId,
      userId: principal.userId,
      queryType: normalizeSearchMode(body.queryType),
      queryText,
      results,
    });
    if (discoverySignature) {
      const queuedJob = isRecord(queued) && isRecord(queued.job) ? queued.job : {};
      const extractionJobId = toText(queuedJob.id);
      if (extractionJobId) {
        const { error: jobSignatureError } = await supabase
          .from('ai_external_analysis_jobs')
          .update({
            readiness_signature: discoverySignature,
            input_snapshot: {
              ...(isRecord(queuedJob.input_snapshot) ? queuedJob.input_snapshot : {}),
              discoverySignature,
            },
          })
          .eq('id', extractionJobId);
        if (jobSignatureError) throw jobSignatureError;
      }
      const { error: signatureError } = await supabase
        .from('article_competitors')
        .update({ discovery_signature: discoverySignature })
        .eq('article_id', articleId);
      if (signatureError) throw signatureError;
      await markCompetitorSelectionAccepted(supabase, {
        articleId,
        userId: principal.userId,
        discoverySignature,
        selectedUrls: results.map(result => result.canonicalUrl),
      });
    }
    return {
      status: 202,
      body: { ok: true, action, queued },
      headers: getCorsResponseHeaders(req),
    };
  }
  if (action === 'cancel') {
    consumeApiRateLimit('competitors-cancel', principal.userId, 30);
    const result = await cancelCompetitorJob(
      supabase,
      articleId,
      principal.userId,
      'competitor_extraction',
    );
    return {
      status: 200,
      body: { ok: true, action, ...result },
      headers: getCorsResponseHeaders(req),
    };
  }
  if (action === 'cancel_discovery') {
    consumeApiRateLimit('competitors-cancel-discovery', principal.userId, 30);
    const result = await cancelCompetitorJob(
      supabase,
      articleId,
      principal.userId,
      'competitor_discovery',
    );
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
    message: 'action must be list, ensure_discovery, search, preview, programmatic_extract, save_manual_text, extract, cancel, cancel_discovery, or remove.',
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
      || error instanceof ProgrammaticCompetitorExtractionError
      ? error.status
      : error instanceof ApiSecurityError
        ? error.status
        : 500;
    const code = error instanceof CompetitorApiError
      || error instanceof FirecrawlCompetitorError
      || error instanceof ProgrammaticCompetitorExtractionError
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
