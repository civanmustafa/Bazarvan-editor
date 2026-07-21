import {
  assertAiRequestPayload,
  assertAllowedOrigin,
  assertRequestContentLength,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  getPositiveIntegerEnv,
  toApiSecurityResult,
} from './apiSecurity';
import { normalizeAiExecutionTelemetryContext } from '../server/aiExecutionEngine';
import { executeOpenAiRequest } from '../server/openAiExecutionEngine';
import { deliverApiResult, getHeaderValue, readRequestBody, type ApiResult } from './http.ts';

const withCorsResponseHeaders = (req: any, result: ApiResult): ApiResult => {
  try {
    return {
      ...result,
      headers: { ...getCorsResponseHeaders(req), ...(result.headers || {}) },
    };
  } catch {
    return result;
  }
};

const toOptionalText = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const handleChatGptRequest = async (req: any): Promise<ApiResult> => {
  try {
    assertAllowedOrigin(req);
  } catch (error) {
    return toApiSecurityResult(error) || { status: 403, body: { error: 'Request origin is not allowed.' } };
  }

  if (req.method === 'OPTIONS') {
    return { status: 204, body: {}, headers: getCorsPreflightHeaders(req, 'POST, OPTIONS') };
  }
  if (req.method !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed.' } };
  }

  try {
    const principal = await authenticateApiRequest(req);
    consumeApiRateLimit(
      'openai:start',
      principal.userId,
      getPositiveIntegerEnv('OPENAI_START_RATE_LIMIT_PER_MINUTE', 20),
    );
    assertRequestContentLength(req, 1_500_000);
    if (!getHeaderValue(req, 'content-type').includes('application/json')) {
      return { status: 415, body: { error: 'Content-Type must be application/json.' } };
    }

    const requestBody = await readRequestBody(req) as Record<string, any>;
    assertAiRequestPayload(requestBody);
    return executeOpenAiRequest(
      {
        prompt: String(requestBody.prompt || ''),
        model: toOptionalText(requestBody.model),
        conversationId: toOptionalText(requestBody.conversationId),
        requestId: toOptionalText(requestBody.requestId),
      },
      {
        telemetry: normalizeAiExecutionTelemetryContext(requestBody.telemetry, {
          userId: principal.userId,
          email: principal.email,
        }),
      },
    );
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) return securityResult;
    console.error('ChatGPT API Error:', error);
    return {
      status: error instanceof SyntaxError ? 400 : 500,
      body: { error: error instanceof Error ? error.message : 'Unknown ChatGPT API error.' },
    };
  }
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  const result = withCorsResponseHeaders(req, await handleChatGptRequest(req));
  return deliverApiResult(result, res);
}
