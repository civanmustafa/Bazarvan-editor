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
import {
  getArticleAccessLevelForUser,
  requireArticleReadAccess,
  requireArticleWriteAccess,
  type ArticleAccessPolicyError,
} from './articleAccessPolicy';
import { deliverApiResult, getHeaderValue, isRecord, readRequestBody, type ApiResult } from './http.ts';
import { getExternalAnalysisSupabaseAdmin } from '../server/externalAnalysisQueue';
import {
  isContentWritingAutomationSchemaUnavailableError,
  readContentWritingAutomationSettings,
} from '../server/contentWritingAutomation';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ContentWritingAutomationApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'content_writing_automation_error') {
    super(message);
    this.name = 'ContentWritingAutomationApiError';
    this.status = status;
    this.code = code;
  }
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const requireUuid = (value: unknown, field: string): string => {
  const normalized = text(value);
  if (!UUID_PATTERN.test(normalized)) {
    throw new ContentWritingAutomationApiError(`${field} must be a valid UUID.`, 400, `${field}_invalid`);
  }
  return normalized;
};

const requireBody = async (req: any): Promise<Record<string, any>> => {
  assertRequestContentLength(req, 24_000);
  if (!getHeaderValue(req, 'content-type').includes('application/json')) {
    throw new ContentWritingAutomationApiError('Content-Type must be application/json.', 415, 'unsupported_content_type');
  }
  const body = await readRequestBody(req);
  if (!isRecord(body)) {
    throw new ContentWritingAutomationApiError('JSON body must be an object.', 400, 'invalid_json_body');
  }
  return body;
};

const firstRow = <T>(value: unknown): T | null => {
  if (Array.isArray(value)) return (value[0] as T | undefined) || null;
  return isRecord(value) ? value as T : null;
};

const publicItem = (value: unknown): Record<string, unknown> | null => {
  if (!isRecord(value) || !text(value.id) || !text(value.article_id)) return null;
  const article = firstRow<Record<string, any>>(value.articles) || {};
  const session = firstRow<Record<string, any>>(value.content_writing_sessions) || {};
  return {
    id: text(value.id),
    articleId: text(value.article_id),
    articleTitle: text(article.title),
    articleStatus: text(article.status),
    requestedBy: text(value.requested_by),
    status: text(value.status),
    readinessSignature: text(value.readiness_signature),
    usableCompetitorCount: Math.max(0, Number(value.usable_competitor_count) || 0),
    pendingCompetitorCount: Math.max(0, Number(value.pending_competitor_count) || 0),
    provider: text(value.provider),
    model: text(value.model),
    sessionId: text(value.content_writing_session_id) || null,
    sessionStatus: text(session.status) || null,
    qualityScore: typeof session.quality_score === 'number' && Number.isFinite(session.quality_score)
      ? session.quality_score
      : null,
    qualityPassed: isRecord(session.quality_report) ? session.quality_report.passed === true : null,
    attemptCount: Math.max(0, Number(value.attempt_count) || 0),
    maxAttempts: Math.max(1, Number(value.max_attempts) || 1),
    readyAt: text(value.ready_at),
    eligibleAt: text(value.eligible_at),
    startedAt: text(value.started_at) || null,
    completedAt: text(value.completed_at) || null,
    lastErrorCode: text(value.last_error_code) || null,
    lastError: text(value.last_error) || null,
    updatedAt: text(value.updated_at),
  };
};

const readItem = async (articleId: string): Promise<Record<string, unknown> | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('content_writing_automation_items')
    .select('*,articles(title,status),content_writing_sessions(status,quality_score,quality_report)')
    .eq('article_id', articleId)
    .maybeSingle();
  if (error) {
    if (isContentWritingAutomationSchemaUnavailableError(error)) return null;
    throw error;
  }
  return publicItem(data);
};

const readItemById = async (
  itemId: string,
  userId: string,
): Promise<Record<string, unknown> | null> => {
  if (!UUID_PATTERN.test(itemId)) return null;
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('content_writing_automation_items')
    .select('*,articles(title,status),content_writing_sessions(status,quality_score,quality_report)')
    .eq('id', itemId)
    .maybeSingle();
  if (error) {
    if (isContentWritingAutomationSchemaUnavailableError(error)) return null;
    throw error;
  }
  if (!data?.article_id) return null;
  const access = await getArticleAccessLevelForUser(
    getExternalAnalysisSupabaseAdmin(),
    String(data.article_id),
    userId,
  );
  if (access === 'none') return null;
  const item = publicItem(data);
  if (!item || !['blocked', 'cancelled', 'ready'].includes(String(item.status))) return item;
  // A later successful manual session resolves the old automatic failure.
  // Merely having some editor text (or an older successful session) does not.
  const failureAt = text(item.completedAt) || text(item.updatedAt);
  if (!Number.isFinite(Date.parse(failureAt))) return item;
  const { data: completed, error: completedError } = await getExternalAnalysisSupabaseAdmin()
    .from('content_writing_sessions')
    .select('id,completed_at')
    .eq('article_id', String(item.articleId))
    .eq('status', 'completed')
    .neq('result_text', '')
    .gt('completed_at', failureAt)
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (completedError) throw completedError;
  return completed ? { ...item, resolvedBySessionId: completed.id, resolvedAt: completed.completed_at } : item;
};

const readActiveItem = async (userId: string): Promise<Record<string, unknown> | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('content_writing_automation_items')
    .select('*,articles(title,status),content_writing_sessions(status,quality_score,quality_report)')
    .in('status', ['claiming', 'writing'])
    .order('started_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isContentWritingAutomationSchemaUnavailableError(error)) return null;
    throw error;
  }
  if (!data?.article_id) return null;
  const access = await getArticleAccessLevelForUser(
    getExternalAnalysisSupabaseAdmin(),
    String(data.article_id),
    userId,
  );
  return access === 'none' ? null : publicItem(data);
};

const readOverview = async (userId: string) => {
  const settings = await readContentWritingAutomationSettings();
  const supabase = getExternalAnalysisSupabaseAdmin();
  const [
    { data: candidates, error: candidateError },
    { data: state, error: stateError },
    active,
    { data: globalAutomation, error: globalAutomationError },
    { data: globalWriting, error: globalWritingError },
    { data: globalPipeline, error: globalPipelineError },
  ] = await Promise.all([
    supabase.rpc('list_content_writing_automation_candidates', {
      p_requested_by: userId,
      p_limit: 10,
      p_min_competitor_count: settings.minimumCompetitors,
      p_require_processing_complete: settings.requireCompetitorTerminalState,
    }),
    supabase
      .from('content_writing_automation_state')
      .select('next_allowed_at,last_item_id,last_session_id,last_article_id,last_outcome,updated_at')
      .eq('singleton', true)
      .maybeSingle(),
    readActiveItem(userId),
    supabase
      .from('content_writing_automation_items')
      .select('status')
      .in('status', ['claiming', 'writing'])
      .limit(1)
      .maybeSingle(),
    supabase
      .from('content_writing_sessions')
      .select('status')
      .eq('execution_mode', 'api')
      .in('status', ['queued', 'running', 'retry_scheduled'])
      .limit(1)
      .maybeSingle(),
    supabase
      .from('ai_external_analysis_jobs')
      .select('status')
      .eq('job_type', 'full_article_pipeline')
      .in('status', ['queued', 'running', 'retry_scheduled'])
      .limit(1)
      .maybeSingle(),
  ]);
  const schemaUnavailable = isContentWritingAutomationSchemaUnavailableError(candidateError)
    || isContentWritingAutomationSchemaUnavailableError(stateError)
    || isContentWritingAutomationSchemaUnavailableError(globalAutomationError);
  if (candidateError && !schemaUnavailable) throw candidateError;
  if (stateError && !schemaUnavailable) throw stateError;
  if (globalAutomationError && !schemaUnavailable) throw globalAutomationError;
  if (globalWritingError) throw globalWritingError;
  if (globalPipelineError) throw globalPipelineError;

  const stateLastItemId = isRecord(state) ? text(state.last_item_id) : '';
  const lastItem = stateLastItemId
    ? await readItemById(stateLastItemId, userId)
    : null;

  const cooldownAt = isRecord(state) ? text(state.next_allowed_at) : '';
  const cooldownActive = Boolean(cooldownAt && new Date(cooldownAt).getTime() > Date.now());
  const globalBlocker = !settings.enabled
    ? { kind: 'automation_disabled' }
    : schemaUnavailable
      ? { kind: 'schema_unavailable' }
      : cooldownActive
        ? { kind: 'cooldown', nextAllowedAt: cooldownAt }
        : isRecord(globalAutomation)
          ? { kind: 'automatic_writing_active', status: text(globalAutomation.status) }
          : isRecord(globalWriting)
            ? { kind: 'content_writing_active', status: text(globalWriting.status) }
            : isRecord(globalPipeline)
              ? { kind: 'full_pipeline_active', status: text(globalPipeline.status) }
              : null;

  return {
    schemaAvailable: !schemaUnavailable,
    settings,
    state: isRecord(state) ? {
      nextAllowedAt: cooldownAt,
      lastItemId: text(lastItem?.id) || null,
      lastSessionId: text(lastItem?.sessionId) || null,
      lastArticleId: text(lastItem?.articleId) || null,
      lastOutcome: lastItem ? text(state.last_outcome) || null : null,
      updatedAt: text(state.updated_at),
    } : null,
    globalBlocker,
    active,
    lastItem,
    candidates: Array.isArray(candidates) ? candidates.map((candidate, index) => {
      const source = isRecord(candidate) ? candidate : {};
      const readiness = isRecord(source.readiness) ? source.readiness : {};
      return {
        position: index + 1,
        articleId: text(source.article_id),
        articleTitle: text(source.article_title),
        articleStatus: text(source.article_status),
        articleUpdatedAt: text(source.article_updated_at),
        itemId: text(source.item_id) || null,
        itemStatus: text(source.item_status) || 'discovered_ready',
        eligibleAt: text(source.eligible_at) || null,
        readiness,
      };
    }) : [],
  };
};

const readArticleStatus = async (articleId: string) => {
  const supabase = getExternalAnalysisSupabaseAdmin();
  const [
    { data: readiness, error: readinessError },
    itemResult,
    { data: pipeline, error: pipelineError },
    { data: completedSession, error: completedSessionError },
  ] = await Promise.all([
    supabase.rpc('evaluate_content_writing_automation_readiness', { p_article_id: articleId }),
    readItem(articleId),
    supabase
      .from('ai_external_analysis_jobs')
      .select('id,status,progress,updated_at')
      .eq('article_id', articleId)
      .eq('job_type', 'full_article_pipeline')
      .in('status', ['waiting_for_prerequisites', 'queued', 'running', 'retry_scheduled', 'paused'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('content_writing_sessions')
      .select('id')
      .eq('article_id', articleId)
      .eq('status', 'completed')
      .limit(1)
      .maybeSingle(),
  ]);
  if (readinessError && !isContentWritingAutomationSchemaUnavailableError(readinessError)) throw readinessError;
  if (pipelineError) throw pipelineError;
  if (completedSessionError) throw completedSessionError;
  return {
    readiness: isRecord(readiness) ? readiness : null,
    item: itemResult,
    hasCompletedContentWritingSession: Boolean(completedSession?.id),
    activeFullPipeline: isRecord(pipeline) ? {
      id: text(pipeline.id),
      status: text(pipeline.status),
      progress: isRecord(pipeline.progress) ? pipeline.progress : {},
      updatedAt: text(pipeline.updated_at),
    } : null,
  };
};

const readArticleSummaries = async (
  articleIds: string[],
  minimumCompetitorCount: number,
): Promise<Record<string, unknown>[]> => {
  const supabase = getExternalAnalysisSupabaseAdmin();
  const [{ data: items, error: itemError }, { data: sessions, error: sessionError }] = await Promise.all([
    supabase
      .from('content_writing_automation_items')
      .select('article_id,status,content_writing_session_id,usable_competitor_count,pending_competitor_count,last_error_code,last_error,updated_at')
      .in('article_id', articleIds),
    supabase
      .from('content_writing_sessions')
      .select('id,article_id,status,quality_score,quality_report,applied_at,last_error_code,last_error,progress,created_at,updated_at')
      .in('article_id', articleIds)
      .order('created_at', { ascending: false })
      .limit(Math.min(500, articleIds.length * 20)),
  ]);
  if (itemError) throw itemError;
  if (sessionError) throw sessionError;

  const latestSessions = new Map<string, Record<string, any>>();
  for (const value of sessions || []) {
    if (!isRecord(value) || !text(value.article_id) || latestSessions.has(text(value.article_id))) continue;
    latestSessions.set(text(value.article_id), value);
  }
  const sessionIds = Array.from(latestSessions.values()).map(session => text(session.id)).filter(Boolean);
  const [fullDraftResult, partialStepsResult] = sessionIds.length > 0
    ? await Promise.all([
        supabase
          .from('content_writing_sessions')
          .select('id')
          .in('id', sessionIds)
          .not('result_text', 'is', null)
          .neq('result_text', ''),
        supabase
          .from('content_writing_steps')
          .select('session_id,step_type')
          .in('session_id', sessionIds)
          .eq('status', 'completed')
          .in('step_type', ['section', 'introduction', 'conclusion', 'call_to_action', 'faq', 'section_repair'])
          .not('output_text', 'is', null)
          .neq('output_text', ''),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (fullDraftResult.error) throw fullDraftResult.error;
  if (partialStepsResult.error) throw partialStepsResult.error;

  const fullDraftSessionIds = new Set((fullDraftResult.data || []).map(row => text(row.id)).filter(Boolean));
  const partialStepCounts = new Map<string, number>();
  for (const row of partialStepsResult.data || []) {
    const sessionId = text(row.session_id);
    if (sessionId) partialStepCounts.set(sessionId, (partialStepCounts.get(sessionId) || 0) + 1);
  }
  const itemsByArticle = new Map(
    (items || []).filter(isRecord).map(item => [text(item.article_id), item] as const),
  );

  return articleIds.flatMap(articleId => {
    const item = itemsByArticle.get(articleId) || null;
    const session = latestSessions.get(articleId) || null;
    if (!item && !session) return [];
    const sessionId = text(session?.id);
    const hasFullDraft = Boolean(sessionId && fullDraftSessionIds.has(sessionId));
    const partialStepCount = sessionId ? partialStepCounts.get(sessionId) || 0 : 0;
    const qualityReport = isRecord(session?.quality_report) ? session.quality_report : {};
    const qualityScore = typeof session?.quality_score === 'number' && Number.isFinite(session.quality_score)
      ? session.quality_score
      : null;
    const qualityMinimumScore = typeof qualityReport.minimumScore === 'number'
      && Number.isFinite(qualityReport.minimumScore)
      ? qualityReport.minimumScore
      : null;
    const qualityPassed = typeof qualityReport.passed === 'boolean' ? qualityReport.passed : null;
    const sessionStatus = text(session?.status);
    const itemStatus = text(item?.status);
    const errorCode = text(session?.last_error_code) || text(item?.last_error_code) || null;
    const errorMessage = text(session?.last_error) || text(item?.last_error) || null;
    const progress = isRecord(session?.progress) ? session.progress : {};
    let state = 'failed';
    if (text(session?.applied_at)) state = 'applied';
    else if (hasFullDraft && qualityPassed === false) state = 'written_quality_failed';
    else if (hasFullDraft && qualityPassed === true) state = 'written_quality_passed';
    else if (hasFullDraft) state = 'written';
    else if (partialStepCount > 0) state = 'partial';
    else if (['queued', 'retry_scheduled'].includes(sessionStatus) || itemStatus === 'ready' || itemStatus === 'claiming') state = 'queued';
    else if (sessionStatus === 'running' || itemStatus === 'writing') state = 'writing';
    else if (errorCode === 'content_writing_prerequisites_missing') state = 'waiting_prerequisites';
    else if (sessionStatus === 'cancelled' || itemStatus === 'cancelled') state = 'cancelled';

    return [{
      articleId,
      state,
      sessionId: sessionId || null,
      sessionStatus: sessionStatus || null,
      qualityScore,
      qualityMinimumScore,
      qualityPassed,
      hasFullDraft,
      partialStepCount,
      appliedAt: text(session?.applied_at) || null,
      automaticApplicationStatus: text(progress.automaticApplicationStatus) || null,
      usableCompetitorCount: Math.max(0, Number(item?.usable_competitor_count) || 0),
      minimumCompetitorCount,
      errorCode,
      errorMessage,
      updatedAt: text(session?.updated_at) || text(item?.updated_at),
    }];
  });
};

const handleRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return { status: 204, body: {}, headers: getCorsPreflightHeaders(req, 'POST, OPTIONS') };
  }
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'Method not allowed. Use POST.' } };
  }
  const principal = await authenticateApiRequest(req);
  const body = await requireBody(req);
  const action = text(body.action) || 'status';
  const supabase = getExternalAnalysisSupabaseAdmin();

  if (action === 'summaries') {
    consumeApiRateLimit(
      'content-writing-automation:summaries',
      principal.userId,
      getPositiveIntegerEnv('CONTENT_WRITING_AUTOMATION_STATUS_RATE_LIMIT_PER_MINUTE', 180),
    );
    const articleIds = Array.from(new Set(
      (Array.isArray(body.articleIds) ? body.articleIds : [])
        .map((value: unknown) => requireUuid(value, 'articleId')),
    ));
    if (articleIds.length === 0 || articleIds.length > 50) {
      throw new ContentWritingAutomationApiError(
        'articleIds must contain between 1 and 50 article identifiers.',
        400,
        'content_writing_article_ids_invalid',
      );
    }
    await Promise.all(articleIds.map(articleId => (
      requireArticleReadAccess(supabase, articleId, principal.userId)
    )));
    const settings = await readContentWritingAutomationSettings();
    return {
      status: 200,
      body: {
        ok: true,
        summaries: await readArticleSummaries(articleIds, settings.minimumCompetitors),
      },
    };
  }

  if (action === 'status') {
    consumeApiRateLimit(
      'content-writing-automation:status',
      principal.userId,
      getPositiveIntegerEnv('CONTENT_WRITING_AUTOMATION_STATUS_RATE_LIMIT_PER_MINUTE', 180),
    );
    const articleId = text(body.articleId);
    if (articleId) await requireArticleReadAccess(supabase, requireUuid(articleId, 'articleId'), principal.userId);
    const [overview, article] = await Promise.all([
      readOverview(principal.userId),
      articleId ? readArticleStatus(articleId) : Promise.resolve(null),
    ]);
    return { status: 200, body: { ok: true, overview, article } };
  }

  if (action === 'retry' || action === 'cancel') {
    consumeApiRateLimit(
      'content-writing-automation:mutation',
      principal.userId,
      getPositiveIntegerEnv('CONTENT_WRITING_AUTOMATION_MUTATION_RATE_LIMIT_PER_MINUTE', 30),
    );
    const itemId = requireUuid(body.itemId, 'itemId');
    const { data: existing, error: readError } = await supabase
      .from('content_writing_automation_items')
      .select('article_id')
      .eq('id', itemId)
      .maybeSingle();
    if (readError) throw readError;
    if (!existing?.article_id) {
      throw new ContentWritingAutomationApiError('Automatic-writing item was not found.', 404, 'automation_item_not_found');
    }
    await requireArticleWriteAccess(supabase, String(existing.article_id), principal.userId);
    const rpc = action === 'retry'
      ? 'reset_content_writing_automation_item'
      : 'cancel_content_writing_automation_item';
    const { data, error } = await supabase.rpc(rpc, {
      p_item_id: itemId,
      p_requested_by: principal.userId,
    });
    if (error) throw error;
    return {
      status: 200,
      body: {
        ok: true,
        action,
        item: publicItem(firstRow(data)),
        overview: await readOverview(principal.userId),
      },
    };
  }

  throw new ContentWritingAutomationApiError(
    'action must be status, summaries, retry, or cancel.',
    400,
    'content_writing_automation_action_invalid',
  );
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  let result: ApiResult;
  try {
    result = await handleRequest(req);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) {
      result = securityResult;
    } else {
      const status = error instanceof ContentWritingAutomationApiError
        || (error as ArticleAccessPolicyError)?.name === 'ArticleAccessPolicyError'
        ? Number((error as { status: number }).status) || 400
        : 500;
      const code = error instanceof ContentWritingAutomationApiError
        ? error.code
        : isRecord(error) && typeof error.code === 'string'
          ? error.code
          : 'content_writing_automation_failed';
      result = {
        status,
        body: {
          ok: false,
          code,
          error: error instanceof Error ? error.message : 'Automatic content-writing request failed.',
        },
      };
    }
  }
  try {
    result.headers = { ...getCorsResponseHeaders(req), ...(result.headers || {}) };
  } catch {
    // Origin validation failures intentionally omit CORS headers.
  }
  return deliverApiResult(result, res);
}
