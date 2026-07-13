import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ArticleStorageSnapshot } from '../utils/editorContentStore';
import {
  ApiSecurityError,
  assertAllowedOrigin,
  assertRequestContentLength,
  authenticateApiRequest,
  consumeApiRateLimit,
  getCorsPreflightHeaders,
  getCorsResponseHeaders,
  getHeaderValue,
  getPositiveIntegerEnv,
  toApiSecurityResult,
} from './apiSecurity';

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

type SupabaseUserClient = SupabaseClient<any, 'public', any>;
type ArticleLanguage = 'ar' | 'en';
type ArticleSaveReason = 'manual' | 'auto' | 'lifecycle' | 'recovery';

class ArticleSaveError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ArticleSaveError';
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const readNodeBody = async (req: any): Promise<unknown> => {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    return req.body;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

const readRequestBody = async (req: any): Promise<unknown> => {
  if (typeof req.json === 'function' && typeof req.headers?.get === 'function') {
    return req.json();
  }
  return readNodeBody(req);
};

const normalizeProjectUrl = (value: string): string => value
  .trim()
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const getBearerToken = (req: any): string => (
  getHeaderValue(req, 'authorization').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
);

const getSupabaseUserClient = (req: any): SupabaseUserClient => {
  const supabaseUrl = normalizeProjectUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '');
  const anonKey = String(
    process.env.SUPABASE_ANON_KEY
      || process.env.VITE_SUPABASE_ANON_KEY
      || '',
  ).trim();
  const token = getBearerToken(req);

  if (!supabaseUrl || !anonKey) {
    throw new ArticleSaveError('The authenticated Supabase save service is not configured.', 503);
  }
  if (!token) throw new ArticleSaveError('Authentication is required.', 401);

  return createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
};

const normalizeTitle = (value: unknown): string => (
  typeof value === 'string' && value.trim() ? value.trim() : '(untitled)'
);

const normalizeLanguage = (value: unknown): ArticleLanguage => (
  value === 'en' ? 'en' : 'ar'
);

const normalizeSaveReason = (value: unknown): ArticleSaveReason => {
  if (value === 'auto' || value === 'lifecycle' || value === 'recovery') return value;
  return 'manual';
};

const sanitizeSnapshot = (value: unknown): ArticleStorageSnapshot => {
  if (!isRecord(value)) throw new ArticleSaveError('snapshot is required.', 400);

  return {
    kind: 'articleSnapshot',
    version: 1,
    username: typeof value.username === 'string' ? value.username : '',
    title: normalizeTitle(value.title),
    content: value.content || {},
    contentHtml: typeof value.contentHtml === 'string' ? value.contentHtml : null,
    plainText: typeof value.plainText === 'string' ? value.plainText : '',
    keywords: isRecord(value.keywords) ? value.keywords : {},
    goalContext: isRecord(value.goalContext) ? value.goalContext : {},
    articleLanguage: normalizeLanguage(value.articleLanguage),
    analysisSummary: isRecord(value.analysisSummary) ? value.analysisSummary : undefined,
    attachments: isRecord(value.attachments) ? value.attachments : undefined,
    savedAt: typeof value.savedAt === 'string' && value.savedAt.trim()
      ? value.savedAt
      : new Date().toISOString(),
  } as ArticleStorageSnapshot;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{16,160}$/;

const normalizeArticleId = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const articleId = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(articleId)) throw new ArticleSaveError('articleId must be a valid UUID.', 400);
  return articleId;
};

const resolveIdempotencyKey = (
  value: unknown,
  fallbackSource: Record<string, unknown>,
): string => {
  if (typeof value === 'string' && value.trim()) {
    const key = value.trim();
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new ArticleSaveError('idempotencyKey has an invalid format.', 400);
    }
    return key;
  }

  const fingerprint = createHash('sha256')
    .update(JSON.stringify(fallbackSource))
    .digest('hex');
  return `legacy:${fingerprint}`;
};

const toRemoteArticleActivity = (row: Record<string, any>) => ({
  id: row.id,
  title: row.title,
  ownerId: row.owner_id,
  createdBy: row.created_by,
  assignedTo: row.assigned_to,
  source: row.source,
  visibility: row.visibility,
  status: row.status,
  plainText: row.plain_text || '',
  analysis: row.analysis || null,
  metadata: row.metadata || {},
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastSaved: row.last_saved_at,
  timeSpentSeconds: Number(row.time_spent_seconds || 0),
  saveCount: Number(row.save_count || 0),
  stats: row.stats || {},
  keywords: row.keywords || {},
  goalContext: row.goal_context || {},
  articleLanguage: row.article_language === 'en' ? 'en' : 'ar',
  content: {
    storage: 'supabase',
    key: row.id,
  },
});

const throwRpcError = (error: Record<string, any>): never => {
  const code = String(error.code || '');
  const message = typeof error.message === 'string' && error.message.trim()
    ? error.message.trim()
    : 'Article save transaction failed.';

  if (code === '42501') throw new ArticleSaveError(message, 403);
  if (code === 'P0002') throw new ArticleSaveError(message, 404);
  if (code === '22023' || code === '23514') throw new ArticleSaveError(message, 400);

  console.error('Atomic article save RPC failed:', {
    code,
    details: error.details,
    hint: error.hint,
  });
  throw new ArticleSaveError('The article save service is temporarily unavailable.', 503);
};

const handleArticleSaveRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: getCorsPreflightHeaders(req, 'POST, OPTIONS'),
    };
  }

  assertAllowedOrigin(req);
  const corsHeaders = getCorsResponseHeaders(req);
  if (req.method !== 'POST') {
    return {
      status: 405,
      body: { ok: false, error: 'Method not allowed. Use POST.' },
      headers: corsHeaders,
    };
  }

  const maximumBytes = getPositiveIntegerEnv('ARTICLE_SAVE_MAX_BYTES', 12 * 1024 * 1024, 25 * 1024 * 1024);
  assertRequestContentLength(req, maximumBytes);
  const principal = await authenticateApiRequest(req);
  consumeApiRateLimit(
    'articles:save',
    principal.userId,
    getPositiveIntegerEnv('ARTICLE_SAVE_RATE_LIMIT_PER_MINUTE', 120, 1_000),
  );

  if (!getHeaderValue(req, 'content-type').toLowerCase().includes('application/json')) {
    throw new ArticleSaveError('Content-Type must be application/json.', 415);
  }
  let body: unknown;
  try {
    body = await readRequestBody(req);
  } catch {
    throw new ArticleSaveError('Request body must contain valid JSON.', 400);
  }
  if (!isRecord(body)) throw new ArticleSaveError('JSON body must be an object.', 400);

  const snapshot = sanitizeSnapshot(body.snapshot);
  const articleId = normalizeArticleId(body.articleId);
  const saveReason = normalizeSaveReason(body.saveReason);
  const idempotencyKey = resolveIdempotencyKey(body.idempotencyKey, {
    userId: principal.userId,
    articleId,
    saveReason,
    snapshot: body.snapshot,
  });
  const supabase = getSupabaseUserClient(req);
  const { data, error } = await supabase.rpc('save_article_snapshot', {
    p_article_id: articleId,
    p_idempotency_key: idempotencyKey,
    p_snapshot: snapshot,
    p_save_reason: saveReason,
  });

  if (error) throwRpcError(error as Record<string, any>);
  if (!isRecord(data) || !isRecord(data.article)) {
    throw new ArticleSaveError('Article save transaction returned an invalid result.', 503);
  }

  const article = toRemoteArticleActivity(data.article);
  return {
    status: data.replayed === true || articleId ? 200 : 201,
    body: {
      ok: true,
      article,
      versionNumber: Number(data.versionNumber || article.saveCount || 1),
      replayed: data.replayed === true,
    },
    headers: corsHeaders,
  };
};

const toWebResponse = (result: ApiResult): Response => new Response(
  result.status === 204 ? null : JSON.stringify(result.body),
  {
    status: result.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(result.headers || {}),
    },
  },
);

const sendNodeResponse = (res: any, result: ApiResult) => {
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(result.headers || {}).forEach(([key, value]) => res.setHeader(key, value));
  res.end(result.status === 204 ? undefined : JSON.stringify(result.body));
};

export default async function handler(req: any, res?: any): Promise<Response | void> {
  try {
    const result = await handleArticleSaveRequest(req);
    if (res) {
      sendNodeResponse(res, result);
      return;
    }
    return toWebResponse(result);
  } catch (error) {
    const securityResult = toApiSecurityResult(error);
    const status = securityResult?.status
      ?? (error instanceof ArticleSaveError ? error.status : 500);
    const message = securityResult?.body.error
      ?? (error instanceof Error ? error.message : 'Unknown article save error.');
    if (!(error instanceof ApiSecurityError) && !(error instanceof ArticleSaveError)) {
      console.error('Article save request failed:', error);
    }
    const result: ApiResult = {
      status,
      body: { ok: false, error: message },
      headers: securityResult?.headers || (() => {
        try {
          return getCorsResponseHeaders(req);
        } catch {
          return undefined;
        }
      })(),
    };
    if (res) {
      sendNodeResponse(res, result);
      return;
    }
    return toWebResponse(result);
  }
}
