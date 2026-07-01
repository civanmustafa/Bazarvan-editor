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
  visibility: 'private' | 'shared' | 'team' | 'public';
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

const toNumber = (value: unknown, fallback = 0): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

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

const toRemoteArticleActivity = (row: ArticleRow): RemoteArticleActivity => ({
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

export const listRemoteArticles = async (): Promise<RemoteArticleActivity[]> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .order('last_saved_at', { ascending: false });

  if (error) throw error;
  return ((data || []) as ArticleRow[]).map(toRemoteArticleActivity);
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
  const payload = {
    owner_id: options.userId,
    created_by: options.userId,
    source: 'manual',
    visibility: 'private',
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
          ...payload.metadata,
          attachments: {
            ...(isRecord(currentMetadata.attachments) ? currentMetadata.attachments : {}),
            ...(isRecord(payload.metadata.attachments) ? payload.metadata.attachments : {}),
          },
        },
        save_count: (toNumber((currentRow as any)?.save_count) || 0) + 1,
      })
      .eq('id', options.articleId)
      .select('*')
      .single();

    if (error) throw error;
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
