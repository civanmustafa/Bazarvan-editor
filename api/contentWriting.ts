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
  ArticleAccessPolicyError,
  requireArticleReadAccess,
  requireArticleWriteAccess,
} from './articleAccessPolicy';
import { deliverApiResult, getHeaderValue, isRecord, readRequestBody, type ApiResult } from './http.ts';
import {
  ContentWritingEngineError,
  prepareContentWritingConversation,
  queueContentWritingSession,
} from '../server/contentWritingEngine';
import {
  cancelContentWritingSession,
  getContentWritingMessages,
  getContentWritingSession,
  getContentWritingSteps,
  listContentWritingSessions,
  recordContentWritingApplication,
  resumeContentWritingSession,
  type ContentWritingProvider,
  type ContentWritingSession,
  type ContentWritingStep,
} from '../server/contentWritingSessionService';
import { getExternalAnalysisSupabaseAdmin } from '../server/externalAnalysisQueue';
import { toPublicContentWritingSession } from '../server/contentWritingPresenter';
import {
  evaluateContentWritingQuality,
  normalizeContentWritingQualityReport,
  type ContentWritingQualityReport,
} from '../utils/contentWritingQuality';
import { normalizeContentWritingQualityConfiguration } from '../constants/contentWritingQuality';
import { normalizeGoalContext } from '../utils/goalContext';
import type { Keywords } from '../types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{16,160}$/;

class ContentWritingApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(options: { message: string; status?: number; code?: string; details?: Record<string, unknown> }) {
    super(options.message);
    this.name = 'ContentWritingApiError';
    this.status = options.status || 400;
    this.code = options.code || 'content_writing_api_error';
    this.details = options.details;
  }
}

const toText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const toTextList = (value: unknown): string[] => Array.isArray(value)
  ? value.map(toText).filter(Boolean)
  : [];

const resolveSessionQualityReport = async (
  session: ContentWritingSession,
): Promise<ContentWritingQualityReport | null> => {
  const persisted = normalizeContentWritingQualityReport(session.quality_report)
    || normalizeContentWritingQualityReport(session.response_metadata?.qualityReport);
  if (persisted) return persisted;
  const qualityInput = isRecord(session.context_snapshot?.qualityInput)
    ? session.context_snapshot.qualityInput
    : null;
  const article = isRecord(session.context_snapshot?.article)
    ? session.context_snapshot.article
    : {};
  if (!qualityInput || !toText(session.result_text)) return null;
  const keywordSource = isRecord(qualityInput.keywords) ? qualityInput.keywords : {};
  const keywords: Keywords = {
    primary: toText(keywordSource.primary),
    secondaries: toTextList(keywordSource.secondaries),
    company: toText(keywordSource.company),
    lsi: toTextList(keywordSource.lsi),
  };
  if (!keywords.primary) return null;
  const report = evaluateContentWritingQuality({
    markdown: session.result_text || '',
    articleTitle: toText(article.title),
    keywords,
    goalContext: normalizeGoalContext(isRecord(qualityInput.goalContext) ? qualityInput.goalContext : {}),
    articleLanguage: toText(article.language) === 'en' ? 'en' : 'ar',
    configuration: normalizeContentWritingQualityConfiguration(
      isRecord(session.context_snapshot?.qualityConfiguration)
        ? session.context_snapshot.qualityConfiguration
        : {},
    ),
  }).report;
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from('content_writing_sessions')
    .update({
      quality_policy_version: report.policyVersion,
      quality_score: report.score,
      quality_report: report,
      quality_repair_count: report.repairPasses,
      response_metadata: {
        ...(isRecord(session.response_metadata) ? session.response_metadata : {}),
        qualityReport: report,
      },
    })
    .eq('id', session.id);
  if (error) {
    throw new ContentWritingApiError({
      message: 'The content quality report could not be persisted.',
      status: 500,
      code: 'content_writing_quality_report_save_failed',
    });
  }
  return report;
};

const requireUuid = (value: unknown, field: string): string => {
  const normalized = toText(value);
  if (!UUID_PATTERN.test(normalized)) {
    throw new ContentWritingApiError({
      message: `${field} must be a valid UUID.`,
      code: `${field.replace(/[A-Z]/g, match => `_${match.toLowerCase()}`)}_invalid`,
    });
  }
  return normalized;
};

const requireJsonRequest = async (req: any): Promise<Record<string, any>> => {
  assertRequestContentLength(req, 32_000);
  if (!getHeaderValue(req, 'content-type').includes('application/json')) {
    throw new ContentWritingApiError({
      message: 'Content-Type must be application/json.',
      status: 415,
      code: 'unsupported_content_type',
    });
  }
  const body = await readRequestBody(req);
  if (!isRecord(body)) {
    throw new ContentWritingApiError({ message: 'JSON body must be an object.', code: 'invalid_json_body' });
  }
  return body;
};

const toPublicStep = (
  step: ContentWritingStep,
  options: { includeContent?: boolean } = {},
): Record<string, unknown> => ({
  id: step.id,
  sessionId: step.session_id,
  stepKey: step.step_key,
  stepType: step.step_type,
  ordinal: step.ordinal,
  title: step.title,
  status: step.status,
  ...(options.includeContent ? {
    promptText: step.prompt_text || '',
    outputText: step.output_text || null,
  } : {}),
  metadata: step.metadata,
  attemptCount: step.attempt_count,
  lastErrorCode: step.last_error_code,
  lastError: step.last_error,
  startedAt: step.started_at,
  completedAt: step.completed_at,
  createdAt: step.created_at,
  updatedAt: step.updated_at,
});

const getSessionOrThrow = async (sessionId: string): Promise<ContentWritingSession> => {
  const session = await getContentWritingSession(sessionId);
  if (!session) {
    throw new ContentWritingApiError({
      message: 'Content writing session was not found.',
      status: 404,
      code: 'content_writing_session_not_found',
    });
  }
  return session;
};

const handleContentWritingRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return { status: 204, body: {}, headers: getCorsPreflightHeaders(req, 'POST, OPTIONS') };
  }
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'Method not allowed. Use POST.' } };
  }

  const principal = await authenticateApiRequest(req);
  const body = await requireJsonRequest(req);
  const action = toText(body.action);
  const supabase = getExternalAnalysisSupabaseAdmin();

  if (action === 'start') {
    consumeApiRateLimit(
      'content-writing:start',
      principal.userId,
      getPositiveIntegerEnv('CONTENT_WRITING_START_RATE_LIMIT_PER_MINUTE', 6),
    );
    const articleId = requireUuid(body.articleId, 'articleId');
    await requireArticleWriteAccess(supabase, articleId, principal.userId);
    const provider = toText(body.provider) as ContentWritingProvider;
    if (!['gemini', 'geminiPaid', 'openai'].includes(provider)) {
      throw new ContentWritingApiError({
        message: 'provider must be gemini, geminiPaid, or openai.',
        code: 'content_writing_provider_invalid',
      });
    }
    const idempotencyKey = toText(body.idempotencyKey);
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new ContentWritingApiError({
        message: 'idempotencyKey must contain 16-160 letters, numbers, colons, underscores, or hyphens.',
        code: 'content_writing_idempotency_key_invalid',
      });
    }
    const queued = await queueContentWritingSession({
      articleId,
      createdBy: principal.userId,
      provider,
      model: toText(body.model) || undefined,
      idempotencyKey,
    });
    return {
      status: queued.created ? 202 : 200,
      body: {
        ok: true,
        accepted: true,
        created: queued.created,
        reusedActive: queued.reusedActive === true,
        session: toPublicContentWritingSession(queued.session),
      },
    };
  }

  if (action === 'prepareExternal') {
    consumeApiRateLimit(
      'content-writing:prepare-external',
      principal.userId,
      getPositiveIntegerEnv('CONTENT_WRITING_EXTERNAL_RATE_LIMIT_PER_MINUTE', 20),
    );
    const articleId = requireUuid(body.articleId, 'articleId');
    await requireArticleWriteAccess(supabase, articleId, principal.userId);
    const conversation = await prepareContentWritingConversation(articleId);
    return {
      status: 200,
      body: {
        ok: true,
        conversation: {
          articleId: conversation.article.id,
          articleTitle: conversation.article.title,
          articleLanguage: conversation.article.language,
          articleUpdatedAt: conversation.article.updatedAt,
          inputHash: conversation.inputHash,
          templateRegistryVersion: conversation.templateRegistryVersion,
          estimatedInputTokens: conversation.estimatedInputTokens,
          maxInputTokens: conversation.maxInputTokens,
          qualityConfiguration: conversation.qualityConfiguration,
          qualityContract: conversation.qualityContract,
          messages: conversation.messages.map((message, index) => ({
            sequenceNumber: index + 1,
            stage: message.stage === 'articleContext'
              ? 'article_context'
              : message.stage === 'generationRequest'
                ? 'generation_request'
                : 'instructions',
            role: message.role,
            content: message.content,
          })),
        },
      },
    };
  }

  if (action === 'get') {
    consumeApiRateLimit(
      'content-writing:read',
      principal.userId,
      getPositiveIntegerEnv('CONTENT_WRITING_READ_RATE_LIMIT_PER_MINUTE', 120),
    );
    const session = await getSessionOrThrow(requireUuid(body.sessionId, 'sessionId'));
    await requireArticleReadAccess(supabase, session.article_id, principal.userId);
    const messages = body.includeMessages === false ? undefined : await getContentWritingMessages(session.id);
    const includeStepContent = body.includeStepContent === true;
    const steps = body.includeSteps === false
      ? undefined
      : await getContentWritingSteps(session.id, {
        includeContent: includeStepContent,
        includeMetadata: includeStepContent,
      });
    return {
      status: 200,
      body: {
        ok: true,
        session: toPublicContentWritingSession(session, { includeResult: true }),
        ...(messages ? {
          messages: messages.map(message => ({
            id: message.id,
            sequenceNumber: message.sequence_number,
            stage: message.stage,
            role: message.role,
            content: message.content,
            createdAt: message.created_at,
          })),
        } : {}),
        ...(steps ? {
          steps: steps.map(step => toPublicStep(step, { includeContent: includeStepContent })),
        } : {}),
      },
    };
  }

  if (action === 'list') {
    consumeApiRateLimit(
      'content-writing:read',
      principal.userId,
      getPositiveIntegerEnv('CONTENT_WRITING_READ_RATE_LIMIT_PER_MINUTE', 120),
    );
    const articleId = requireUuid(body.articleId, 'articleId');
    await requireArticleReadAccess(supabase, articleId, principal.userId);
    const limit = Math.max(1, Math.min(Number(body.limit) || 20, 50));
    const sessions = await listContentWritingSessions({ articleId, limit });
    return { status: 200, body: { ok: true, sessions: sessions.map(session => toPublicContentWritingSession(session)) } };
  }

  if (action === 'cancel') {
    consumeApiRateLimit(
      'content-writing:cancel',
      principal.userId,
      getPositiveIntegerEnv('CONTENT_WRITING_CANCEL_RATE_LIMIT_PER_MINUTE', 30),
    );
    const session = await getSessionOrThrow(requireUuid(body.sessionId, 'sessionId'));
    await requireArticleWriteAccess(supabase, session.article_id, principal.userId);
    if (session.created_by !== principal.userId && principal.role !== 'admin') {
      throw new ContentWritingApiError({
        message: 'Only the session creator or an administrator can cancel this content writing session.',
        status: 403,
        code: 'content_writing_cancel_forbidden',
      });
    }
    const cancelled = await cancelContentWritingSession({
      sessionId: session.id,
      requestedBy: principal.userId,
    });
    return {
      status: 200,
      body: { ok: true, session: toPublicContentWritingSession(cancelled || session), alreadyTerminal: !cancelled },
    };
  }

  if (action === 'resume') {
    consumeApiRateLimit(
      'content-writing:resume',
      principal.userId,
      getPositiveIntegerEnv('CONTENT_WRITING_RESUME_RATE_LIMIT_PER_MINUTE', 12),
    );
    const session = await getSessionOrThrow(requireUuid(body.sessionId, 'sessionId'));
    await requireArticleWriteAccess(supabase, session.article_id, principal.userId);
    if (session.created_by !== principal.userId && principal.role !== 'admin') {
      throw new ContentWritingApiError({
        message: 'Only the session creator or an administrator can resume this content writing session.',
        status: 403,
        code: 'content_writing_resume_forbidden',
      });
    }
    if (!['failed', 'cancelled'].includes(session.status)) {
      throw new ContentWritingApiError({
        message: 'Only a failed or cancelled content writing session can be resumed.',
        status: 409,
        code: 'content_writing_resume_conflict',
      });
    }
    const resumed = await resumeContentWritingSession({
      sessionId: session.id,
      requestedBy: principal.userId,
    });
    if (!resumed) {
      throw new ContentWritingApiError({
        message: 'The content writing session could not be resumed.',
        status: 409,
        code: 'content_writing_resume_conflict',
      });
    }
    return { status: 202, body: { ok: true, accepted: true, session: toPublicContentWritingSession(resumed) } };
  }

  if (action === 'recordApplication') {
    consumeApiRateLimit(
      'content-writing:apply',
      principal.userId,
      getPositiveIntegerEnv('CONTENT_WRITING_APPLY_RATE_LIMIT_PER_MINUTE', 30),
    );
    const session = await getSessionOrThrow(requireUuid(body.sessionId, 'sessionId'));
    await requireArticleWriteAccess(supabase, session.article_id, principal.userId);
    if (session.created_by !== principal.userId && principal.role !== 'admin') {
      throw new ContentWritingApiError({
        message: 'Only the session creator or an administrator can apply this content writing result.',
        status: 403,
        code: 'content_writing_apply_forbidden',
      });
    }
    if (session.status !== 'completed' || !toText(session.result_text)) {
      throw new ContentWritingApiError({
        message: 'Only a completed content writing result can be applied.',
        status: 409,
        code: 'content_writing_apply_conflict',
      });
    }
    const qualityReport = await resolveSessionQualityReport(session);
    const qualityOverrideReason = toText(body.qualityOverrideReason).slice(0, 500);
    if (qualityReport && !qualityReport.passed) {
      if (principal.role !== 'admin') {
        throw new ContentWritingApiError({
          message: 'The article has not passed the configured content quality gate.',
          status: 409,
          code: 'content_writing_quality_gate_failed',
          details: { qualityReport },
        });
      }
      if (qualityOverrideReason.length < 8) {
        throw new ContentWritingApiError({
          message: 'An administrator override reason of at least 8 characters is required.',
          status: 422,
          code: 'content_writing_quality_override_reason_required',
          details: { qualityReport },
        });
      }
    }
    const applied = await recordContentWritingApplication({
      sessionId: session.id,
      appliedBy: principal.userId,
      qualityOverrideReason: qualityReport && !qualityReport.passed
        ? qualityOverrideReason
        : undefined,
    });
    if (!applied) {
      throw new ContentWritingApiError({
        message: 'The content writing application could not be recorded.',
        status: 409,
        code: 'content_writing_apply_conflict',
      });
    }
    return { status: 200, body: { ok: true, session: toPublicContentWritingSession(applied, { includeResult: true }) } };
  }

  throw new ContentWritingApiError({
    message: 'action must be start, prepareExternal, get, list, cancel, resume, or recordApplication.',
    code: 'content_writing_action_invalid',
  });
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  let result: ApiResult;
  try {
    result = await handleContentWritingRequest(req);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) {
      result = securityResult;
    } else {
      const known = error instanceof ContentWritingApiError
        || error instanceof ContentWritingEngineError
        || error instanceof ArticleAccessPolicyError;
      const status = known && 'status' in error ? Number(error.status) : 500;
      const code = error instanceof ContentWritingApiError || error instanceof ContentWritingEngineError
        ? error.code
        : error instanceof ArticleAccessPolicyError
          ? 'article_access_denied'
          : 'content_writing_request_failed';
      const details = error instanceof ContentWritingApiError || error instanceof ContentWritingEngineError
        ? error.details
        : undefined;
      console.error('Content writing API error:', error);
      result = {
        status,
        body: {
          ok: false,
          code,
          error: error instanceof Error ? error.message : 'Unknown content writing API error.',
          ...(details || {}),
        },
      };
    }
  }

  try {
    result.headers = { ...getCorsResponseHeaders(req), ...(result.headers || {}) };
  } catch {
    // Origin validation errors intentionally omit CORS headers.
  }
  return deliverApiResult(result, res);
}
