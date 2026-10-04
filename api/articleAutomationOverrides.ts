import {
  ARTICLE_AUTOMATION_CAPABILITIES,
  isArticleAutomationRunningBehavior,
  isArticleWritingMode,
  normalizeArticleAutomationOverrides,
} from '../constants/articleAutomationOverrides';
import { getExternalAnalysisSupabaseAdmin } from '../server/externalAnalysisQueue';
import {
  readArticleAutomationOverrides,
  saveArticleAutomationOverrides,
} from '../server/articleAutomationOverrides';
import { readArticleAutomationPolicy } from '../server/articleAutomationPolicy';
import {
  ApiSecurityError,
  assertAllowedOrigin,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  toApiSecurityResult,
} from './apiSecurity';
import { ArticleAccessPolicyError, requireArticleWriteAccess } from './articleAccessPolicy';
import { deliverApiResult, isRecord, readRequestBody, type ApiResult } from './http';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_SET = new Set<string>(ARTICLE_AUTOMATION_CAPABILITIES);

const withCors = (req: any, result: ApiResult): ApiResult => {
  try {
    return {
      ...result,
      headers: { ...getCorsResponseHeaders(req), 'Cache-Control': 'no-store', ...result.headers },
    };
  } catch {
    return result;
  }
};

const readArticleId = (req: any, body?: Record<string, unknown>): string => {
  const queryId = typeof req?.query?.articleId === 'string' ? req.query.articleId.trim() : '';
  const urlId = new URL(String(req?.url || ''), 'http://localhost')
    .searchParams.get('articleId')?.trim() || '';
  const bodyId = typeof body?.articleId === 'string' ? body.articleId.trim() : '';
  const articleId = bodyId || queryId || urlId;
  if (!UUID_PATTERN.test(articleId)) throw new ApiSecurityError('articleId must be a valid UUID.', 400);
  return articleId;
};

const handleRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return { status: 204, headers: getCorsPreflightHeaders(req, 'GET, PUT, OPTIONS') };
  }
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return { status: 405, body: { error: 'Use GET or PUT.' } };
  }
  const principal = await authenticateApiRequest(req);
  consumeApiRateLimit('article:automation-overrides', principal.userId, req.method === 'PUT' ? 30 : 90);
  const body = req.method === 'PUT' ? await readRequestBody(req) : undefined;
  if (body !== undefined && (!isRecord(body) || JSON.stringify(body).length > 20_000)) {
    throw new ApiSecurityError('Invalid article automation overrides payload.', 400);
  }
  const articleId = readArticleId(req, isRecord(body) ? body : undefined);
  await requireArticleWriteAccess(getExternalAnalysisSupabaseAdmin(), articleId, principal.userId);

  let overrides = await readArticleAutomationOverrides(articleId);
  let impact;
  if (req.method === 'PUT') {
    if (!isRecord(body)
      || Object.keys(body).some(key => !['articleId', 'disabledCapabilities', 'writingMode', 'excludedExternalCommandIds', 'reason', 'runningBehavior'].includes(key))
      || !Array.isArray(body.disabledCapabilities)
      || body.disabledCapabilities.some(value => typeof value !== 'string' || !CAPABILITY_SET.has(value))
      || !isArticleWritingMode(body.writingMode)
      || !Array.isArray(body.excludedExternalCommandIds)
      || body.excludedExternalCommandIds.some(value => typeof value !== 'string' || value.length > 240)
      || (body.reason !== undefined && typeof body.reason !== 'string')
      || (body.runningBehavior !== undefined && !isArticleAutomationRunningBehavior(body.runningBehavior))) {
      throw new ApiSecurityError('أرسل استثناءات المقالة بصيغتها الصحيحة فقط.', 400);
    }
    const saved = await saveArticleAutomationOverrides({
      articleId,
      userId: principal.userId,
      overrides: normalizeArticleAutomationOverrides(body),
      runningBehavior: isArticleAutomationRunningBehavior(body.runningBehavior)
        ? body.runningBehavior
        : 'stop',
    });
    overrides = saved.overrides;
    impact = saved.impact;
  }
  return {
    status: 200,
    body: {
      ok: true,
      articleId,
      overrides,
      impact,
      effectivePolicy: await readArticleAutomationPolicy(articleId),
    },
  };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(withCors(req, await handleRequest(req)), res);
  } catch (error) {
    const security = toApiSecurityResult(error);
    if (security) return deliverApiResult(withCors(req, security), res);
    const status = (error as ArticleAccessPolicyError)?.name === 'ArticleAccessPolicyError'
      ? Number((error as ArticleAccessPolicyError).status) || 403
      : 503;
    console.error('Article automation overrides request failed:', error);
    return deliverApiResult(withCors(req, {
      status,
      body: {
        ok: false,
        code: 'ARTICLE_AUTOMATION_OVERRIDES_UNAVAILABLE',
        error: status === 403
          ? 'لا تملك صلاحية تعديل أتمتة هذه المقالة.'
          : 'تعذر تحميل أو حفظ استثناءات أتمتة المقالة.',
      },
    }), res);
  }
}
