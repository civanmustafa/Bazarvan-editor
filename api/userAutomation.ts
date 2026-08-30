import {
  ApiSecurityError, assertAllowedOrigin, authenticateApiRequest, consumeApiRateLimit,
  getCorsPreflightHeaders, getCorsResponseHeaders, toApiSecurityResult,
} from './apiSecurity.ts';
import { deliverApiResult, isRecord, readRequestBody, type ApiResult } from './http.ts';
import { normalizeUserAutomationPreferences, USER_AUTOMATION_BOOLEAN_KEYS } from '../constants/userAutomation.ts';
import { readOrSaveUserAutomationSettings } from '../server/userAutomationSettings.ts';

const withCors = (req: any, result: ApiResult): ApiResult => {
  try {
    return { ...result, headers: { ...getCorsResponseHeaders(req), 'Cache-Control': 'no-store', ...result.headers } };
  } catch { return result; }
};

const handleRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') return { status: 204, headers: getCorsPreflightHeaders(req, 'GET, PUT, OPTIONS') };
  if (req.method !== 'GET' && req.method !== 'PUT') return { status: 405, body: { error: 'Use GET or PUT.' } };
  const principal = await authenticateApiRequest(req);
  consumeApiRateLimit('user:automation', principal.userId, req.method === 'PUT' ? 30 : 90);
  let preferences;
  if (req.method === 'PUT') {
    const body = await readRequestBody(req);
    if (!isRecord(body) || Object.keys(body).some(key => key !== 'preferences') || !isRecord(body.preferences)
      || JSON.stringify(body).length > 16_384
      || !USER_AUTOMATION_BOOLEAN_KEYS.every(key => typeof body.preferences[key] === 'boolean')
      || !Array.isArray(body.preferences.externalAnalysisCommandIds)
      || body.preferences.externalAnalysisCommandIds.some((id: unknown) => typeof id !== 'string')) {
      throw new ApiSecurityError('أرسل إعدادات الأتمتة فقط، بصيغتها الصحيحة.', 400);
    }
    preferences = normalizeUserAutomationPreferences(body.preferences);
  }
  return { status: 200, body: { ok: true, ...await readOrSaveUserAutomationSettings(principal.userId, preferences) } };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try { return deliverApiResult(withCors(req, await handleRequest(req)), res); }
  catch (error) {
    const security = toApiSecurityResult(error);
    if (security) return deliverApiResult(withCors(req, security), res);
    console.error('User automation settings request failed:', error instanceof Error ? error.message : 'unknown error');
    return deliverApiResult(withCors(req, { status: error instanceof SyntaxError ? 400 : 503,
      body: { ok: false, error: 'تعذر تحميل أو حفظ إعدادات الأتمتة. أعد المحاولة.', code: 'USER_AUTOMATION_UNAVAILABLE' } }), res);
  }
}
