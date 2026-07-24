import {
  assertAllowedOrigin,
  authenticateApiRequest,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  toApiSecurityResult,
} from './apiSecurity';
import { deliverApiResult, type ApiResult } from './http.ts';
import { readPromptRegistrySettings } from '../server/promptRegistrySettings';

const withHeaders = (req: any, result: ApiResult): ApiResult => ({
  ...result,
  headers: {
    ...getCorsResponseHeaders(req),
    'Cache-Control': 'no-store',
    ...(result.headers || {}),
  },
});

const handlePromptRegistryRequest = async (req: any): Promise<ApiResult> => {
  assertAllowedOrigin(req);
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: getCorsPreflightHeaders(req, 'GET, OPTIONS'),
    };
  }
  if (req.method !== 'GET') {
    return { status: 405, body: { ok: false, error: 'Method not allowed. Use GET.' } };
  }

  await authenticateApiRequest(req);
  const registry = await readPromptRegistrySettings();
  return {
    status: 200,
    body: { ok: true, registry },
  };
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    return deliverApiResult(withHeaders(req, await handlePromptRegistryRequest(req)), res);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    if (securityResult) return deliverApiResult(withHeaders(req, securityResult), res);
    console.error('Prompt registry request failed:', error);
    return deliverApiResult(withHeaders(req, {
      status: 500,
      body: { ok: false, error: 'Could not load the prompt registry.' },
    }), res);
  }
}
