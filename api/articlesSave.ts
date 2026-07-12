import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ArticleStorageSnapshot } from '../utils/editorContentStore';

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

type SupabaseAdmin = SupabaseClient<any, 'public', any>;
type ArticleStatus = 'draft' | 'in_review' | 'published' | 'archived';
type ArticleLanguage = 'ar' | 'en';

class ArticleSaveError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ArticleSaveError';
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
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

const getHeaderValue = (req: any, headerName: string): string => {
  if (typeof req.headers?.get === 'function') {
    return req.headers.get(headerName) || '';
  }

  const directValue = req.headers?.[headerName.toLowerCase()] || req.headers?.[headerName];
  return Array.isArray(directValue) ? String(directValue[0] || '') : String(directValue || '');
};

const getBearerToken = (req: any): string => {
  const authorization = getHeaderValue(req, 'authorization');
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
};

const normalizeProjectUrl = (value: string): string => value
  .trim()
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const getSupabaseAdmin = (): SupabaseAdmin => {
  const supabaseUrl = normalizeProjectUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!supabaseUrl) throw new ArticleSaveError('SUPABASE_URL or VITE_SUPABASE_URL is not configured.', 503);
  if (!serviceRoleKey) throw new ArticleSaveError('SUPABASE_SERVICE_ROLE_KEY is not configured.', 503);

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
};

const normalizeTitle = (value: unknown): string => (
  typeof value === 'string' && value.trim() ? value.trim() : '(untitled)'
);

const normalizeLanguage = (value: unknown): ArticleLanguage => (
  value === 'en' ? 'en' : 'ar'
);

const normalizeStats = (snapshot: ArticleStorageSnapshot) => {
  const plainText = typeof snapshot.plainText === 'string' ? snapshot.plainText : '';
  const wordCount = Number.isFinite(snapshot.analysisSummary?.wordCount)
    ? Number(snapshot.analysisSummary?.wordCount)
    : plainText.trim()
      ? plainText.trim().split(/\s+/).filter(Boolean).length
      : 0;

  const compactNumber = (value: unknown): number => (
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  );

  return {
    wordCount,
    keywordViolations: compactNumber(snapshot.analysisSummary?.keywordViolations),
    violatingCriteriaCount: compactNumber(
      snapshot.analysisSummary?.structureViolations
        ?? snapshot.analysisSummary?.structureStats?.violatingCriteriaCount,
    ),
    totalDuplicates: compactNumber(
      snapshot.analysisSummary?.totalDuplicates
        ?? snapshot.analysisSummary?.duplicateStats?.totalDuplicates,
    ),
  };
};

const authenticateUser = async (supabase: SupabaseAdmin, req: any) => {
  const token = getBearerToken(req);
  if (!token) throw new ArticleSaveError('Authentication is required.', 401);

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user?.id) {
    throw new ArticleSaveError('Invalid Supabase session.', 401);
  }

  const user = userData.user;
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id,email,full_name,role,is_active')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) throw profileError;

  if (!profile) {
    const fullName = typeof user.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim()
      ? user.user_metadata.full_name.trim()
      : typeof user.user_metadata?.name === 'string' && user.user_metadata.name.trim()
        ? user.user_metadata.name.trim()
        : null;

    const { data: insertedProfile, error: insertError } = await supabase
      .from('profiles')
      .insert({
        id: user.id,
        email: user.email || null,
        full_name: fullName,
        role: 'user',
      })
      .select('id,email,full_name,role,is_active')
      .single();

    if (insertError) throw insertError;
    return { user, profile: insertedProfile };
  }

  if (profile.is_active === false) {
    throw new ArticleSaveError('User profile is inactive.', 403);
  }

  return { user, profile };
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
    attachments: value.attachments,
    savedAt: new Date().toISOString(),
  } as ArticleStorageSnapshot;
};

const canUpdateArticle = (article: Record<string, any>, profile: Record<string, any>): boolean => (
  profile.role === 'admin' ||
  article.owner_id === profile.id ||
  article.assigned_to === profile.id
);

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
});

const recordArticleVersion = async (
  supabase: SupabaseAdmin,
  articleId: string,
  snapshot: ArticleStorageSnapshot,
  userId: string,
  versionNumber: number,
  stats: Record<string, number>,
) => {
  const { error } = await supabase
    .from('article_versions')
    .insert({
      article_id: articleId,
      version_number: Math.max(1, versionNumber),
      created_by: userId,
      title: normalizeTitle(snapshot.title),
      content_json: snapshot.content || {},
      content_html: snapshot.contentHtml || null,
      plain_text: snapshot.plainText || '',
      keywords: snapshot.keywords || {},
      goal_context: snapshot.goalContext || {},
      analysis: null,
      stats,
      note: 'manual-save',
    });

  if (error) {
    console.error(`Failed to record article version "${articleId}" from API save:`, error);
  }
};

const saveArticle = async (
  supabase: SupabaseAdmin,
  snapshot: ArticleStorageSnapshot,
  profile: Record<string, any>,
  articleId?: string | null,
) => {
  const savedAt = new Date().toISOString();
  const stats = normalizeStats(snapshot);
  const title = normalizeTitle(snapshot.title);
  const email = typeof profile.email === 'string' ? profile.email.trim() : '';
  const fullName = typeof profile.full_name === 'string' ? profile.full_name.trim() : null;

  if (articleId) {
    const { data: currentRow, error: readError } = await supabase
      .from('articles')
      .select('id,owner_id,assigned_to,save_count,metadata')
      .eq('id', articleId)
      .single();

    if (readError || !currentRow) throw readError || new ArticleSaveError('Article was not found.', 404);
    if (!canUpdateArticle(currentRow, profile)) {
      throw new ArticleSaveError('You do not have permission to update this article.', 403);
    }

    const currentMetadata = isRecord(currentRow.metadata) ? currentRow.metadata : {};
    const nextSaveCount = Number(currentRow.save_count || 0) + 1;
    const { data, error } = await supabase
      .from('articles')
      .update({
        title,
        content_json: snapshot.content || {},
        content_html: snapshot.contentHtml || null,
        plain_text: snapshot.plainText || '',
        keywords: snapshot.keywords || {},
        goal_context: snapshot.goalContext || {},
        article_language: normalizeLanguage(snapshot.articleLanguage),
        analysis: null,
        stats,
        last_saved_at: savedAt,
        metadata: {
          ...currentMetadata,
          analysisSummary: stats,
          attachments: {
            ...(isRecord(currentMetadata.attachments) ? currentMetadata.attachments : {}),
            ...(isRecord(snapshot.attachments) ? snapshot.attachments : {}),
          },
        },
        save_count: nextSaveCount,
      })
      .eq('id', articleId)
      .select('*')
      .single();

    if (error) throw error;
    await recordArticleVersion(supabase, data.id, snapshot, profile.id, nextSaveCount, stats);
    return toRemoteArticleActivity(data);
  }

  const visibleTo = email
    ? [{ id: profile.id, email, fullName, role: 'editor' }]
    : [];
  const { data, error } = await supabase
    .from('articles')
    .insert({
      owner_id: profile.id,
      created_by: profile.id,
      assigned_to: profile.id,
      source: 'manual',
      visibility: 'private',
      status: 'draft' satisfies ArticleStatus,
      title,
      content_json: snapshot.content || {},
      content_html: snapshot.contentHtml || null,
      plain_text: snapshot.plainText || '',
      keywords: snapshot.keywords || {},
      goal_context: snapshot.goalContext || {},
      article_language: normalizeLanguage(snapshot.articleLanguage),
      analysis: null,
      stats,
      last_saved_at: savedAt,
      save_count: 1,
      time_spent_seconds: 0,
      metadata: {
        attachments: snapshot.attachments || null,
        analysisSummary: stats,
        n8nSettings: {
          visibility: 'private',
          accessRole: 'editor',
          visibleToEmailsCsv: email,
          articleLanguage: normalizeLanguage(snapshot.articleLanguage),
          status: 'draft',
        },
        visibleTo,
      },
    })
    .select('*')
    .single();

  if (error) throw error;
  await recordArticleVersion(supabase, data.id, snapshot, profile.id, 1, stats);
  return toRemoteArticleActivity(data);
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

const handleArticleSaveRequest = async (req: any): Promise<ApiResult> => {
  if (req.method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    };
  }

  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'Method not allowed. Use POST.' } };
  }

  const supabase = getSupabaseAdmin();
  const { profile } = await authenticateUser(supabase, req);
  const body = await readRequestBody(req);
  if (!isRecord(body)) throw new ArticleSaveError('JSON body must be an object.', 400);

  const snapshot = sanitizeSnapshot(body.snapshot);
  const articleId = typeof body.articleId === 'string' && body.articleId.trim()
    ? body.articleId.trim()
    : null;
  const article = await saveArticle(supabase, snapshot, profile, articleId);

  return {
    status: articleId ? 200 : 201,
    body: {
      ok: true,
      article,
    },
  };
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
    const status = error instanceof ArticleSaveError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unknown article save error.';
    console.error('Article save request failed:', error);
    const result = { status, body: { ok: false, error: message } };
    if (res) {
      sendNodeResponse(res, result);
      return;
    }
    return toWebResponse(result);
  }
}
