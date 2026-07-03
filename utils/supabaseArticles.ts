import type { ArticleActivity } from '../hooks/useUserActivity';
import { normalizeKeywords } from '../hooks/useUserActivity';
import type { ArticleStorageSnapshot } from './editorContentStore';
import { getSupabaseClient } from './supabaseClient';
import { normalizeGoalContext } from './goalContext';

type ArticleStats = NonNullable<ArticleActivity['stats']>;

type ArticleRow = {
  id: string;
  owner_id: string | null;
  created_by: string | null;
  assigned_to: string | null;
  source: 'manual' | 'n8n' | 'import' | 'system';
  visibility: 'private' | 'public';
  status: 'draft' | 'in_review' | 'published' | 'archived';
  title: string;
  content_json: any;
  content_html: string | null;
  plain_text: string | null;
  keywords: any;
  goal_context: any;
  article_language: 'ar' | 'en';
  analysis: any;
  stats: any;
  time_spent_seconds: number | null;
  save_count: number | null;
  metadata: any;
  created_at: string;
  updated_at: string;
  last_saved_at: string;
};

type N8nIngestLogRow = {
  id: string;
  article_id: string | null;
  workflow_id: string | null;
  execution_id: string | null;
  external_id: string | null;
  status: 'received' | 'imported' | 'rejected' | 'failed';
  payload: any;
  error_message: string | null;
  created_at: string;
  processed_at: string | null;
};

type ArticleVersionRow = {
  id: string;
  article_id: string;
  version_number: number;
  created_by: string | null;
  title: string;
  content_json: any;
  content_html: string | null;
  plain_text: string;
  keywords: any;
  goal_context: any;
  analysis: any;
  stats: any;
  note: string | null;
  created_at: string;
};

type AppSessionRow = {
  id: string;
  user_id: string | null;
  user_agent: string | null;
  path: string | null;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  metadata: any;
};

type AppActivityEventRow = {
  id: string;
  user_id: string | null;
  session_id: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  path: string | null;
  metadata: any;
  created_at: string;
};

type CreatorArticleDefaults = {
  email: string;
  fullName: string | null;
  visibleTo: {
    id: string;
    email: string;
    fullName: string | null;
    role: RemoteArticleAccessRole;
  }[];
};

const ARTICLE_LIST_SELECT = [
  'id',
  'owner_id',
  'created_by',
  'assigned_to',
  'source',
  'visibility',
  'status',
  'title',
  'keywords',
  'goal_context',
  'article_language',
  'stats',
  'time_spent_seconds',
  'save_count',
  'metadata',
  'created_at',
  'updated_at',
  'last_saved_at',
].join(',');

const REMOTE_ARTICLE_CACHE_PREFIX = 'bazarvan:remote-article-list:';

export type RemoteArticleVisibility = ArticleRow['visibility'];
export type RemoteArticleStatus = ArticleRow['status'];
export type RemoteArticleLanguage = ArticleRow['article_language'];
export type RemoteArticleAccessRole = 'viewer' | 'editor';

export type RemoteArticleSettingsPatch = Partial<{
  visibility: RemoteArticleVisibility;
  status: RemoteArticleStatus;
  articleLanguage: RemoteArticleLanguage;
  accessRole: RemoteArticleAccessRole;
  visibleToEmailsCsv: string;
}>;

export type RemoteArticleTrashInfo = {
  deletedAt: string;
  deletedBy?: string;
  deletedScope?: 'global' | 'user';
};

export type RemoteN8nIngestLog = {
  id: string;
  articleId: string | null;
  workflowId: string | null;
  executionId: string | null;
  externalId: string | null;
  status: N8nIngestLogRow['status'];
  payload: any;
  errorMessage: string | null;
  createdAt: string;
  processedAt: string | null;
};

export type RemoteArticleVersion = {
  id: string;
  articleId: string;
  versionNumber: number;
  createdBy: string | null;
  title: string;
  plainText: string;
  keywords: any;
  goalContext: any;
  analysis: any;
  stats: any;
  note: string | null;
  createdAt: string;
};

export type RemoteAppSession = {
  id: string;
  userId: string | null;
  userAgent: string;
  path: string;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  metadata: any;
};

export type RemoteAppActivityEvent = {
  id: string;
  userId: string | null;
  sessionId: string | null;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  path: string;
  metadata: any;
  createdAt: string;
};

export type RemoteArticleAiResultPatch = {
  provider: 'geminiPaid';
  result: string;
  keyFingerprint?: string;
  model?: string;
  savedAt?: string;
};

export type RemoteProfile = {
  id: string;
  email: string | null;
  fullName: string | null;
  role: 'admin' | 'user';
  isActive: boolean;
  createdAt: string;
  lastSeenAt: string | null;
};

export type RemoteArticleActivity = ArticleActivity & {
  id: string;
  title: string;
  ownerId: string | null;
  createdBy: string | null;
  assignedTo: string | null;
  source: ArticleRow['source'];
  visibility: ArticleRow['visibility'];
  status: ArticleRow['status'];
  plainText: string;
  analysis: any;
  metadata: any;
  updatedAt: string;
  createdAt: string;
};

const DEFAULT_STATS: ArticleStats = {
  wordCount: 0,
  keywordViolations: 0,
  violatingCriteriaCount: 0,
  totalErrorsCount: 0,
  keywordDuplicatesCount: 0,
  totalDuplicates: 0,
  commonDuplicatesCount: 0,
  uniqueWordsPercentage: 0,
};

const isRecord = (value: unknown): value is Record<string, any> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const canUseLocalStorage = (): boolean => (
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
);

const withoutAiResultsMetadata = (metadata: Record<string, any>): Record<string, any> => (
  Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'aiResults'))
);

const lightweightArticleMetadata = (metadata: unknown): Record<string, any> => {
  if (!isRecord(metadata)) return {};
  const n8nSettings = isRecord(metadata.n8nSettings) ? metadata.n8nSettings : undefined;
  const visibleTo = Array.isArray(metadata.visibleTo) ? metadata.visibleTo : undefined;
  const trash = isRecord(metadata.trash) ? metadata.trash : undefined;
  const claim = isRecord(metadata.claim) ? metadata.claim : undefined;
  const importedAt = typeof metadata.importedAt === 'string' ? metadata.importedAt : undefined;
  const importedBy = typeof metadata.importedBy === 'string' ? metadata.importedBy : undefined;
  const workflowId = typeof metadata.workflowId === 'string' ? metadata.workflowId : undefined;
  const executionId = typeof metadata.executionId === 'string' ? metadata.executionId : undefined;
  const externalId = typeof metadata.externalId === 'string' ? metadata.externalId : undefined;

  return Object.fromEntries(Object.entries({
    n8nSettings,
    visibleTo,
    trash,
    claim,
    importedAt,
    importedBy,
    workflowId,
    executionId,
    externalId,
  }).filter(([, value]) => value !== undefined));
};

const toNumber = (value: unknown, fallback = 0): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const splitEmailCsv = (value: string): string[] => {
  const seen = new Set<string>();
  return value
    .split(/[\n\r,،;؛|]+/g)
    .map(email => email.trim().toLowerCase())
    .filter(email => {
      if (!email || seen.has(email)) return false;
      seen.add(email);
      return true;
    });
};

const normalizeEmailCsv = (value: string): string => splitEmailCsv(value).join(', ');

const normalizeStats = (value: unknown): ArticleStats => {
  const source = isRecord(value) ? value : {};
  return {
    wordCount: toNumber(source.wordCount),
    keywordViolations: toNumber(source.keywordViolations),
    violatingCriteriaCount: toNumber(source.violatingCriteriaCount),
    totalErrorsCount: toNumber(source.totalErrorsCount),
    keywordDuplicatesCount: toNumber(source.keywordDuplicatesCount),
    totalDuplicates: toNumber(source.totalDuplicates),
    commonDuplicatesCount: toNumber(source.commonDuplicatesCount),
    uniqueWordsPercentage: toNumber(source.uniqueWordsPercentage),
  };
};

const normalizeTitle = (title: string): string => title.trim() || '(untitled)';

const resolveCreatorArticleDefaults = async (
  userId: string,
): Promise<CreatorArticleDefaults> => {
  const supabase = getSupabaseClient();
  const { data: authData } = await supabase.auth.getUser().catch(() => ({ data: { user: null } as any }));
  const authEmail = authData.user?.id === userId && typeof authData.user.email === 'string'
    ? authData.user.email.trim()
    : '';

  const { data: profileData } = await supabase
    .from('profiles')
    .select('id,email,full_name')
    .eq('id', userId)
    .maybeSingle()
    .catch(() => ({ data: null }));

  const profile = isRecord(profileData) ? profileData : {};
  const email = normalizeEmailCsv(typeof profile.email === 'string' && profile.email.trim()
    ? profile.email
    : authEmail);
  const fullName = typeof profile.full_name === 'string' && profile.full_name.trim()
    ? profile.full_name.trim()
    : null;

  return {
    email,
    fullName,
    visibleTo: email
      ? [{
          id: userId,
          email,
          fullName,
          role: 'editor',
        }]
      : [],
  };
};

const toRemoteArticleActivity = (
  row: ArticleRow,
  options: { lightweightMetadata?: boolean } = {},
): RemoteArticleActivity => ({
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
  metadata: options.lightweightMetadata ? lightweightArticleMetadata(row.metadata) : row.metadata || {},
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  timeSpentSeconds: row.time_spent_seconds || 0,
  saveCount: row.save_count || 0,
  lastSaved: row.last_saved_at,
  content: {
    storage: 'supabase',
    key: row.id,
  },
  keywords: normalizeKeywords(row.keywords),
  goalContext: normalizeGoalContext(row.goal_context),
  articleLanguage: row.article_language === 'en' ? 'en' : 'ar',
  stats: normalizeStats(row.stats),
});

const toRemoteProfile = (row: any): RemoteProfile => ({
  id: row.id,
  email: row.email || null,
  fullName: row.full_name || null,
  role: row.role === 'admin' ? 'admin' : 'user',
  isActive: row.is_active !== false,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at || null,
});

const toRemoteN8nIngestLog = (row: N8nIngestLogRow): RemoteN8nIngestLog => ({
  id: row.id,
  articleId: row.article_id,
  workflowId: row.workflow_id,
  executionId: row.execution_id,
  externalId: row.external_id,
  status: row.status,
  payload: row.payload || {},
  errorMessage: row.error_message || null,
  createdAt: row.created_at,
  processedAt: row.processed_at || null,
});

const toRemoteArticleVersion = (row: ArticleVersionRow): RemoteArticleVersion => ({
  id: row.id,
  articleId: row.article_id,
  versionNumber: row.version_number,
  createdBy: row.created_by,
  title: row.title,
  plainText: row.plain_text || '',
  keywords: row.keywords || {},
  goalContext: row.goal_context || {},
  analysis: row.analysis || null,
  stats: row.stats || {},
  note: row.note || null,
  createdAt: row.created_at,
});

const toRemoteAppSession = (row: AppSessionRow): RemoteAppSession => ({
  id: row.id,
  userId: row.user_id,
  userAgent: row.user_agent || '',
  path: row.path || '',
  startedAt: row.started_at,
  lastSeenAt: row.last_seen_at,
  endedAt: row.ended_at || null,
  metadata: row.metadata || {},
});

const toRemoteAppActivityEvent = (row: AppActivityEventRow): RemoteAppActivityEvent => ({
  id: row.id,
  userId: row.user_id,
  sessionId: row.session_id,
  eventType: row.event_type,
  entityType: row.entity_type,
  entityId: row.entity_id,
  path: row.path || '',
  metadata: row.metadata || {},
  createdAt: row.created_at,
});

const buildStatsFromSnapshot = (snapshot: ArticleStorageSnapshot): ArticleStats => {
  const summary = snapshot.analysisSummary;
  const duplicateStats = summary?.duplicateStats;
  const structureStats = summary?.structureStats;
  const analysis = snapshot.analysis;
  const uniqueWordsPercentage = duplicateStats && duplicateStats.totalWords > 0
    ? (duplicateStats.uniqueWords / duplicateStats.totalWords) * 100
    : 0;

  return {
    ...DEFAULT_STATS,
    wordCount: summary?.wordCount ?? analysis?.wordCount ?? 0,
    keywordViolations: 0,
    violatingCriteriaCount: structureStats?.violatingCriteriaCount ?? analysis?.structureStats?.violatingCriteriaCount ?? 0,
    totalErrorsCount: structureStats?.totalErrorsCount ?? analysis?.structureStats?.totalErrorsCount ?? 0,
    keywordDuplicatesCount: duplicateStats?.keywordDuplicatesCount ?? analysis?.duplicateStats?.keywordDuplicatesCount ?? 0,
    totalDuplicates: duplicateStats?.totalDuplicates ?? analysis?.duplicateStats?.totalDuplicates ?? 0,
    commonDuplicatesCount: duplicateStats?.commonDuplicatesCount ?? analysis?.duplicateStats?.commonDuplicatesCount ?? 0,
    uniqueWordsPercentage,
  };
};

const recordArticleVersion = async (
  articleId: string,
  snapshot: ArticleStorageSnapshot,
  options: {
    userId: string;
    versionNumber: number;
    stats: ArticleStats;
  },
): Promise<void> => {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('article_versions')
    .insert({
      article_id: articleId,
      version_number: Math.max(1, options.versionNumber),
      created_by: options.userId,
      title: normalizeTitle(snapshot.title),
      content_json: snapshot.content || {},
      content_html: snapshot.contentHtml || null,
      plain_text: snapshot.plainText || '',
      keywords: snapshot.keywords || {},
      goal_context: snapshot.goalContext || {},
      analysis: snapshot.analysis || null,
      stats: options.stats,
      note: 'manual-save',
    });

  if (error) {
    console.error(`Failed to record article version "${articleId}":`, error);
  }
};

const getArticleListCacheKey = async (): Promise<string> => {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  return `${REMOTE_ARTICLE_CACHE_PREFIX}${data.session?.user.id || 'anonymous'}`;
};

const readCachedRemoteArticles = async (): Promise<RemoteArticleActivity[] | null> => {
  if (!canUseLocalStorage()) return null;

  try {
    const cacheKey = await getArticleListCacheKey();
    const rawValue = window.localStorage.getItem(cacheKey);
    if (!rawValue) return null;
    const parsed = JSON.parse(rawValue);
    if (!isRecord(parsed) || !Array.isArray(parsed.articles)) return null;
    return parsed.articles as RemoteArticleActivity[];
  } catch (error) {
    console.warn('Could not read cached Supabase article list:', error);
    return null;
  }
};

const writeCachedRemoteArticles = async (articles: RemoteArticleActivity[]): Promise<void> => {
  if (!canUseLocalStorage()) return;

  try {
    const cacheKey = await getArticleListCacheKey();
    window.localStorage.setItem(cacheKey, JSON.stringify({
      cachedAt: new Date().toISOString(),
      articles,
    }));
  } catch (error) {
    console.warn('Could not cache Supabase article list:', error);
  }
};

export const listRemoteArticles = async (): Promise<RemoteArticleActivity[]> => {
  const supabase = getSupabaseClient();
  try {
    const { data, error } = await supabase
      .from('articles')
      .select(ARTICLE_LIST_SELECT)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    const articles = ((data || []) as ArticleRow[]).map(row => toRemoteArticleActivity(row, { lightweightMetadata: true }));
    void writeCachedRemoteArticles(articles);
    return articles;
  } catch (error) {
    const cachedArticles = await readCachedRemoteArticles();
    if (cachedArticles) {
      console.warn('Using cached Supabase article list after load failure:', error);
      return cachedArticles;
    }
    throw error;
  }
};

export const getRemoteArticleById = async (articleId: string): Promise<RemoteArticleActivity> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('id', articleId)
    .single();

  if (error) throw error;
  return toRemoteArticleActivity(data as ArticleRow);
};

export const listRemoteProfiles = async (): Promise<RemoteProfile[]> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('id,email,full_name,role,is_active,created_at,last_seen_at')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []).map(toRemoteProfile);
};

export const listRemoteN8nIngestLogs = async (limit = 25): Promise<RemoteN8nIngestLog[]> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('n8n_ingest_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    if (error.code === '42P01') return [];
    throw error;
  }
  return ((data || []) as N8nIngestLogRow[]).map(toRemoteN8nIngestLog);
};

export const listRemoteArticleVersions = async (
  articleId: string,
  limit = 20,
): Promise<RemoteArticleVersion[]> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('article_versions')
    .select('*')
    .eq('article_id', articleId)
    .order('version_number', { ascending: false })
    .limit(limit);

  if (error) {
    if (error.code === '42P01') return [];
    throw error;
  }

  return ((data || []) as ArticleVersionRow[]).map(toRemoteArticleVersion);
};

export const listRemoteAppSessions = async (limit = 100): Promise<RemoteAppSession[]> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('app_sessions')
    .select('*')
    .order('last_seen_at', { ascending: false })
    .limit(limit);

  if (error) {
    if (error.code === '42P01') return [];
    throw error;
  }

  return ((data || []) as AppSessionRow[]).map(toRemoteAppSession);
};

export const getRemoteAppSessionById = async (sessionId: string): Promise<RemoteAppSession | null> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('app_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();

  if (error) {
    if (error.code === '42P01') return null;
    throw error;
  }

  return data ? toRemoteAppSession(data as AppSessionRow) : null;
};

export const listRemoteAppActivityEvents = async (
  options: {
    limit?: number;
    sessionId?: string;
    dateFrom?: string;
    dateTo?: string;
  } = {},
): Promise<RemoteAppActivityEvent[]> => {
  const supabase = getSupabaseClient();
  let query = supabase
    .from('app_activity_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(options.limit || 150);

  if (options.sessionId) {
    query = query.eq('session_id', options.sessionId);
  }
  if (options.dateFrom) {
    query = query.gte('created_at', options.dateFrom);
  }
  if (options.dateTo) {
    query = query.lte('created_at', options.dateTo);
  }

  const { data, error } = await query;

  if (error) {
    if (error.code === '42P01') return [];
    throw error;
  }

  return ((data || []) as AppActivityEventRow[]).map(toRemoteAppActivityEvent);
};

export const updateCurrentProfileLastSeen = async (userId: string): Promise<void> => {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('profiles')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) throw error;
};

export const loadRemoteArticleSnapshot = async (
  articleId: string,
  username: string,
): Promise<ArticleStorageSnapshot | null> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('id', articleId)
    .single();

  if (error) throw error;
  if (!data) return null;

  const row = data as ArticleRow;
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const aiResults = isRecord(metadata.aiResults) ? metadata.aiResults : {};
  const geminiPaidResults = isRecord(aiResults.geminiPaid) ? aiResults.geminiPaid : {};
  const geminiPaidLatest = isRecord(geminiPaidResults.latest) ? geminiPaidResults.latest : {};

  return {
    kind: 'articleSnapshot',
    version: 1,
    username,
    title: row.title,
    content: row.content_html || row.content_json || row.plain_text || '',
    contentHtml: row.content_html || undefined,
    plainText: row.plain_text || '',
    keywords: normalizeKeywords(row.keywords),
    goalContext: normalizeGoalContext(row.goal_context),
    articleLanguage: row.article_language === 'en' ? 'en' : 'ar',
    analysisSummary: metadata.analysisSummary,
    analysis: row.analysis || undefined,
    attachments: metadata.attachments,
    savedAiResults: {
      geminiPaid: typeof geminiPaidLatest.result === 'string' ? geminiPaidLatest.result : '',
    },
    savedAt: row.last_saved_at,
  };
};

export const saveRemoteArticleSnapshot = async (
  snapshot: ArticleStorageSnapshot,
  options: {
    articleId?: string | null;
    userId: string;
  },
): Promise<RemoteArticleActivity> => {
  const supabase = getSupabaseClient();
  const savedAt = new Date().toISOString();
  const stats = buildStatsFromSnapshot(snapshot);
  const creatorDefaults = await resolveCreatorArticleDefaults(options.userId);
  const payload = {
    owner_id: options.userId,
    created_by: options.userId,
    assigned_to: options.userId,
    source: 'manual',
    visibility: 'public',
    status: 'draft',
    title: normalizeTitle(snapshot.title),
    content_json: snapshot.content || {},
    content_html: snapshot.contentHtml || null,
    plain_text: snapshot.plainText || '',
    keywords: snapshot.keywords || {},
    goal_context: snapshot.goalContext || {},
    article_language: snapshot.articleLanguage,
    analysis: snapshot.analysis || null,
    stats,
    last_saved_at: savedAt,
    metadata: {
      attachments: snapshot.attachments || null,
      analysisSummary: snapshot.analysisSummary || null,
      n8nSettings: {
        visibility: 'public',
        accessRole: 'editor',
        visibleToEmailsCsv: creatorDefaults.email,
        articleLanguage: snapshot.articleLanguage,
        status: 'draft',
      },
      visibleTo: creatorDefaults.visibleTo,
    },
  };

  if (options.articleId) {
    const { data: currentRow, error: readError } = await supabase
      .from('articles')
      .select('save_count,metadata')
      .eq('id', options.articleId)
      .single();

    if (readError) throw readError;
    const currentMetadata = isRecord((currentRow as any)?.metadata) ? (currentRow as any).metadata : {};

    const nextSaveCount = (toNumber((currentRow as any)?.save_count) || 0) + 1;
    const { data, error } = await supabase
      .from('articles')
      .update({
        title: payload.title,
        content_json: payload.content_json,
        content_html: payload.content_html,
        plain_text: payload.plain_text,
        keywords: payload.keywords,
        goal_context: payload.goal_context,
        article_language: payload.article_language,
        analysis: payload.analysis,
        stats: payload.stats,
        last_saved_at: payload.last_saved_at,
        metadata: {
          ...currentMetadata,
          analysisSummary: payload.metadata.analysisSummary,
          attachments: {
            ...(isRecord(currentMetadata.attachments) ? currentMetadata.attachments : {}),
            ...(isRecord(payload.metadata.attachments) ? payload.metadata.attachments : {}),
          },
        },
        save_count: nextSaveCount,
      })
      .eq('id', options.articleId)
      .select('*')
      .single();

    if (error) throw error;
    await recordArticleVersion((data as ArticleRow).id, snapshot, {
      userId: options.userId,
      versionNumber: nextSaveCount,
      stats,
    });
    return toRemoteArticleActivity(data as ArticleRow);
  }

  const { data, error } = await supabase
    .from('articles')
    .insert({
      ...payload,
      save_count: 1,
      time_spent_seconds: 0,
    })
    .select('*')
    .single();

  if (error) throw error;
  await recordArticleVersion((data as ArticleRow).id, snapshot, {
    userId: options.userId,
    versionNumber: 1,
    stats,
  });
  return toRemoteArticleActivity(data as ArticleRow);
};

export const renameRemoteArticle = async (articleId: string, newTitle: string): Promise<RemoteArticleActivity> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('articles')
    .update({
      title: normalizeTitle(newTitle),
      last_saved_at: new Date().toISOString(),
    })
    .eq('id', articleId)
    .select('*')
    .single();

  if (error) throw error;
  return toRemoteArticleActivity(data as ArticleRow);
};

const updateArticleAccessRole = async (
  articleId: string,
  accessRole: RemoteArticleAccessRole,
): Promise<void> => {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('article_access')
    .update({ role: accessRole })
    .eq('article_id', articleId);

  if (error && error.code !== '42P01') throw error;
};

const lookupProfilesByEmails = async (emails: string[]): Promise<Pick<RemoteProfile, 'id' | 'email' | 'fullName'>[]> => {
  if (emails.length === 0) return [];

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('id,email,full_name')
    .in('email', emails);

  if (error) throw error;

  const profiles = (data || []).map(profile => ({
    id: String(profile.id),
    email: profile.email || null,
    fullName: profile.full_name || null,
  }));
  const foundEmails = new Set(profiles.map(profile => profile.email?.toLowerCase()).filter(Boolean));
  const missingEmails = emails.filter(email => !foundEmails.has(email));
  if (missingEmails.length > 0) {
    throw new Error(`Could not find Supabase profiles for: ${missingEmails.join(', ')}`);
  }

  return profiles;
};

const syncArticleAccessProfiles = async (
  articleId: string,
  profiles: Pick<RemoteProfile, 'id' | 'email' | 'fullName'>[],
  accessRole: RemoteArticleAccessRole,
): Promise<void> => {
  const supabase = getSupabaseClient();
  const { error: deleteError } = await supabase
    .from('article_access')
    .delete()
    .eq('article_id', articleId);

  if (deleteError) {
    if (deleteError.code === '42P01') return;
    throw deleteError;
  }

  if (profiles.length === 0) return;

  const { error } = await supabase
    .from('article_access')
    .insert(profiles.map(profile => ({
      article_id: articleId,
      user_id: profile.id,
      role: accessRole,
    })));

  if (error) throw error;
};

const updateRemoteArticleStatus = async (
  articleId: string,
  status: RemoteArticleStatus,
): Promise<RemoteArticleActivity> => {
  const supabase = getSupabaseClient();

  try {
    const { error: rpcError } = await supabase.rpc('update_article_dashboard_status', {
      target_article_id: articleId,
      next_status: status,
    });

    if (rpcError) throw rpcError;
  } catch (error: any) {
    if (error?.code !== 'PGRST202') throw error;

    const { data: currentRow, error: readError } = await supabase
      .from('articles')
      .select('metadata')
      .eq('id', articleId)
      .single();

    if (readError) throw readError;

    const currentMetadata = isRecord((currentRow as any)?.metadata) ? (currentRow as any).metadata : {};
    const currentSettings = isRecord(currentMetadata.n8nSettings) ? currentMetadata.n8nSettings : {};
    const nextMetadataBase = status === 'in_review'
      ? withoutAiResultsMetadata(currentMetadata)
      : currentMetadata;
    const { error: updateError } = await supabase
      .from('articles')
      .update({
        status,
        metadata: {
          ...nextMetadataBase,
          n8nSettings: {
            ...currentSettings,
            status,
          },
        },
      })
      .eq('id', articleId);

    if (updateError) throw updateError;
  }

  if (status === 'in_review') {
    await clearRemoteArticleAiResults(articleId).catch(error => {
      console.error(`Failed to clear saved AI results for ready article "${articleId}":`, error);
    });
  }

  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('id', articleId)
    .single();

  if (error) throw error;
  return toRemoteArticleActivity(data as ArticleRow);
};

export const updateRemoteArticleSettings = async (
  articleId: string,
  patch: RemoteArticleSettingsPatch,
): Promise<RemoteArticleActivity> => {
  const keys = Object.keys(patch).filter(key => (patch as Record<string, unknown>)[key] !== undefined);
  if (keys.length === 1 && patch.status) {
    return updateRemoteArticleStatus(articleId, patch.status);
  }

  const supabase = getSupabaseClient();
  const { data: currentRow, error: readError } = await supabase
    .from('articles')
    .select('metadata')
    .eq('id', articleId)
    .single();

  if (readError) throw readError;

  const currentMetadata = isRecord((currentRow as any)?.metadata) ? (currentRow as any).metadata : {};
  const currentSettings = isRecord(currentMetadata.n8nSettings) ? currentMetadata.n8nSettings : {};
  const n8nSettings = { ...currentSettings };
  const payload: Record<string, unknown> = {};
  const nextAccessRole: RemoteArticleAccessRole = patch.accessRole || (currentSettings.accessRole === 'editor' ? 'editor' : 'viewer');
  let nextVisibleProfiles: Pick<RemoteProfile, 'id' | 'email' | 'fullName'>[] | null = null;

  if (patch.visibility) {
    payload.visibility = patch.visibility;
    n8nSettings.visibility = patch.visibility;
  }
  if (patch.status) {
    payload.status = patch.status;
    n8nSettings.status = patch.status;
  }
  if (patch.articleLanguage) {
    payload.article_language = patch.articleLanguage;
    n8nSettings.articleLanguage = patch.articleLanguage;
  }
  if (patch.accessRole) {
    n8nSettings.accessRole = patch.accessRole;
  }
  if (patch.visibleToEmailsCsv !== undefined) {
    const normalizedCsv = normalizeEmailCsv(patch.visibleToEmailsCsv);
    nextVisibleProfiles = await lookupProfilesByEmails(splitEmailCsv(normalizedCsv));
    n8nSettings.visibleToEmailsCsv = normalizedCsv;
    n8nSettings.accessRole = nextAccessRole;
  }

  const nextMetadataBase = patch.status === 'in_review'
    ? withoutAiResultsMetadata(currentMetadata)
    : currentMetadata;

  payload.metadata = {
    ...nextMetadataBase,
    n8nSettings,
    ...(nextVisibleProfiles
      ? {
          visibleTo: nextVisibleProfiles.map(profile => ({
            id: profile.id,
            email: profile.email,
            fullName: profile.fullName,
            role: nextAccessRole,
          })),
        }
      : {}),
  };

  const { data, error } = await supabase
    .from('articles')
    .update(payload)
    .eq('id', articleId)
    .select('*')
    .single();

  if (error) throw error;

  if (nextVisibleProfiles) {
    await syncArticleAccessProfiles(articleId, nextVisibleProfiles, nextAccessRole);
  } else if (patch.accessRole) {
    await updateArticleAccessRole(articleId, patch.accessRole);
  }

  return toRemoteArticleActivity(data as ArticleRow);
};

export const claimRemoteArticle = async (articleId: string): Promise<RemoteArticleActivity> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('claim_available_article', {
    target_article_id: articleId,
  });

  if (error) throw error;
  return toRemoteArticleActivity(data as ArticleRow);
};

export const getArticleTrashInfo = (
  article: Pick<RemoteArticleActivity, 'metadata'>,
  userId?: string | null,
): RemoteArticleTrashInfo | null => {
  const metadata = isRecord(article.metadata) ? article.metadata : {};
  const trash = isRecord(metadata.trash) ? metadata.trash : {};
  const globalDeletedAt = typeof trash.deletedAt === 'string' ? trash.deletedAt : '';
  if (globalDeletedAt) {
    return {
      deletedAt: globalDeletedAt,
      deletedBy: typeof trash.deletedBy === 'string' ? trash.deletedBy : undefined,
      deletedScope: 'global',
    };
  }

  if (!userId) return null;
  const deletedFor = isRecord(trash.deletedFor) ? trash.deletedFor : {};
  const userTrash = isRecord(deletedFor[userId]) ? deletedFor[userId] : {};
  const userDeletedAt = typeof userTrash.deletedAt === 'string' ? userTrash.deletedAt : '';
  return userDeletedAt
    ? {
        deletedAt: userDeletedAt,
        deletedBy: typeof userTrash.deletedBy === 'string' ? userTrash.deletedBy : undefined,
        deletedScope: 'user',
      }
    : null;
};

const getCurrentArticleMetadata = async (articleId: string): Promise<Record<string, any>> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('articles')
    .select('metadata')
    .eq('id', articleId)
    .single();

  if (error) throw error;
  return isRecord((data as any)?.metadata) ? (data as any).metadata : {};
};

const updateArticleMetadataFallback = async (
  articleId: string,
  metadata: Record<string, any>,
): Promise<void> => {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('articles')
    .update({ metadata })
    .eq('id', articleId);

  if (error) throw error;
};

export const clearRemoteArticleAiResults = async (articleId: string): Promise<void> => {
  const metadata = await getCurrentArticleMetadata(articleId);
  if (!isRecord(metadata.aiResults)) return;
  await updateArticleMetadataFallback(articleId, withoutAiResultsMetadata(metadata));
};

export type AssignedArticleAutomationResult = {
  ok: boolean;
  articleId: string;
  semantic: 'generated' | 'skipped' | 'failed';
  geminiPaid: 'analyzed' | 'skipped' | 'failed';
  reasons: string[];
};

export const triggerAssignedArticleAutomation = async (
  articleId: string,
): Promise<AssignedArticleAutomationResult> => {
  const supabase = getSupabaseClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token || '';

  if (!accessToken) {
    throw new Error('Supabase session is required to run assigned article automation.');
  }

  const response = await fetch('/api/articles/assigned-automation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ articleId }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `Assigned automation failed (${response.status}).`);
  }

  return payload as AssignedArticleAutomationResult;
};

const getCurrentUserTrashContext = async (): Promise<{ userId: string; isAdmin: boolean }> => {
  const supabase = getSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user?.id) {
    throw userError || new Error('Authentication is required.');
  }

  const { data: isAdminData } = await supabase.rpc('is_admin');
  return {
    userId: userData.user.id,
    isAdmin: isAdminData === true,
  };
};

export const moveRemoteArticleToTrash = async (articleId: string): Promise<RemoteArticleActivity> => {
  const supabase = getSupabaseClient();

  try {
    const { error } = await supabase.rpc('move_article_to_dashboard_trash', {
      target_article_id: articleId,
    });
    if (error) throw error;
  } catch (error: any) {
    if (error?.code !== 'PGRST202') throw error;

    const { userId, isAdmin } = await getCurrentUserTrashContext();
    const metadata = await getCurrentArticleMetadata(articleId);
    const trash = isRecord(metadata.trash) ? metadata.trash : {};
    const deletedAt = new Date().toISOString();
    const deletedFor = isRecord(trash.deletedFor) ? trash.deletedFor : {};

    await updateArticleMetadataFallback(articleId, {
      ...metadata,
      trash: isAdmin
        ? {
            ...trash,
            deletedAt,
            deletedBy: userId,
            deletedScope: 'global',
          }
        : {
            ...trash,
            deletedFor: {
              ...deletedFor,
              [userId]: {
                deletedAt,
                deletedBy: userId,
                deletedScope: 'user',
              },
            },
          },
    });
  }

  return getRemoteArticleById(articleId);
};

export const restoreRemoteArticleFromTrash = async (articleId: string): Promise<RemoteArticleActivity> => {
  const supabase = getSupabaseClient();

  try {
    const { error } = await supabase.rpc('restore_article_from_dashboard_trash', {
      target_article_id: articleId,
    });
    if (error) throw error;
  } catch (error: any) {
    if (error?.code !== 'PGRST202') throw error;

    const { userId, isAdmin } = await getCurrentUserTrashContext();
    const metadata = await getCurrentArticleMetadata(articleId);
    const trash = isRecord(metadata.trash) ? metadata.trash : {};

    if (isAdmin) {
      const {
        deletedAt: _deletedAt,
        deletedBy: _deletedBy,
        deletedScope: _deletedScope,
        ...restTrash
      } = trash;
      const nextMetadata = Object.keys(restTrash).length > 0
        ? { ...metadata, trash: restTrash }
        : Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'trash'));
      await updateArticleMetadataFallback(articleId, nextMetadata);
    } else {
      const deletedFor = isRecord(trash.deletedFor) ? trash.deletedFor : {};
      const nextDeletedFor = Object.fromEntries(
        Object.entries(deletedFor).filter(([deletedUserId]) => deletedUserId !== userId),
      );
      const nextTrash = Object.keys(nextDeletedFor).length > 0
        ? { ...trash, deletedFor: nextDeletedFor }
        : Object.fromEntries(Object.entries(trash).filter(([key]) => key !== 'deletedFor'));
      const nextMetadata = Object.keys(nextTrash).length > 0
        ? { ...metadata, trash: nextTrash }
        : Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'trash'));
      await updateArticleMetadataFallback(articleId, nextMetadata);
    }
  }

  return getRemoteArticleById(articleId);
};

export const purgeExpiredRemoteArticleTrash = async (retentionDays = 30): Promise<number> => {
  const supabase = getSupabaseClient();
  try {
    const { data, error } = await supabase.rpc('purge_expired_dashboard_trash', {
      retention_days: retentionDays,
    });
    if (error) throw error;
    return typeof data === 'number' ? data : 0;
  } catch (error: any) {
    if (error?.code === 'PGRST202') return 0;
    throw error;
  }
};

export const saveRemoteArticleAiResult = async (
  articleId: string,
  patch: RemoteArticleAiResultPatch,
): Promise<RemoteArticleActivity> => {
  const metadata = await getCurrentArticleMetadata(articleId);
  const aiResults = isRecord(metadata.aiResults) ? metadata.aiResults : {};
  const providerResults = isRecord(aiResults[patch.provider]) ? aiResults[patch.provider] : {};
  const history = Array.isArray(providerResults.history) ? providerResults.history : [];
  const savedAt = patch.savedAt || new Date().toISOString();
  const entry = {
    result: patch.result,
    keyFingerprint: patch.keyFingerprint || '',
    model: patch.model || '',
    savedAt,
  };

  await updateArticleMetadataFallback(articleId, {
    ...metadata,
    aiResults: {
      ...aiResults,
      [patch.provider]: {
        ...providerResults,
        latest: entry,
        history: [entry, ...history].slice(0, 10),
      },
    },
  });

  return getRemoteArticleById(articleId);
};

export const deleteRemoteArticle = async (articleId: string): Promise<void> => {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('articles')
    .delete()
    .eq('id', articleId);

  if (error) throw error;
};

export const recordRemoteArticleTime = async (articleId: string, seconds: number): Promise<void> => {
  if (!articleId || seconds <= 0) return;

  const supabase = getSupabaseClient();
  const { data, error: readError } = await supabase
    .from('articles')
    .select('time_spent_seconds')
    .eq('id', articleId)
    .single();

  if (readError) throw readError;

  const nextSeconds = (toNumber((data as any)?.time_spent_seconds) || 0) + seconds;
  const { error } = await supabase
    .from('articles')
    .update({ time_spent_seconds: nextSeconds })
    .eq('id', articleId);

  if (error) throw error;
};
