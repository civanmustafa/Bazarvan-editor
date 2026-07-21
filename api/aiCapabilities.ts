import {
  assertAllowedOrigin,
  authenticateApiRequest,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  toApiSecurityResult,
} from './apiSecurity';
import { deliverApiResult, type ApiResult } from './http.ts';
import { readAiProviderCapabilities } from '../server/aiProviderCapabilities';

const withCorsResponseHeaders = (req: any, result: ApiResult): ApiResult => {
  try {
    return {
      ...result,
      headers: {
        ...getCorsResponseHeaders(req),
        'Cache-Control': 'no-store',
        ...(result.headers || {}),
      },
    };
  } catch {
    return result;
  }
};

const handleAiCapabilitiesRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: getCorsPreflightHeaders(req, 'GET, OPTIONS'),
    };
  }
  if (req.method !== 'GET') {
    return { status: 405, body: { error: 'Method not allowed. Use GET.' } };
  }

  await authenticateApiRequest(req);
  const capabilities = await readAiProviderCapabilities();
  return {
    status: 200,
    body: { ok: true, capabilities },
  };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(withCorsResponseHeaders(req, await handleAiCapabilitiesRequest(req)), res);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) {
      return deliverApiResult(withCorsResponseHeaders(req, securityResult), res);
    }
    console.error('AI capabilities request failed:', error);
    return deliverApiResult(withCorsResponseHeaders(req, {
      status: 500,
      body: { ok: false, error: 'Could not load AI provider capabilities.' },
    }), res);
  }
}
