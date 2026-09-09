import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import {
  normalizeArticleEditorPresence,
  type ArticleEditorPresence,
} from './articleEditorPresenceState';

export {
  groupArticleEditorPresence,
  normalizeArticleEditorPresence,
  type ArticleEditorPresence,
  type ArticleEditorPresenceMap,
} from './articleEditorPresenceState';

export const ARTICLE_EDITOR_PRESENCE_HEARTBEAT_MS = 20_000;
export const ARTICLE_EDITOR_PRESENCE_REFRESH_MS = 10_000;

let browserTabPresenceId: string | null = null;

const createFallbackUuid = (): string => {
  const randomValues = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(randomValues);
  } else {
    for (let index = 0; index < randomValues.length; index += 1) {
      randomValues[index] = Math.floor(Math.random() * 256);
    }
  }
  randomValues[6] = (randomValues[6] & 0x0f) | 0x40;
  randomValues[8] = (randomValues[8] & 0x3f) | 0x80;
  const hexadecimal = Array.from(randomValues, value => value.toString(16).padStart(2, '0')).join('');
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
};

export const getArticleEditorPresenceId = (): string => {
  if (browserTabPresenceId) return browserTabPresenceId;
  browserTabPresenceId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : createFallbackUuid();
  return browserTabPresenceId;
};

const normalizeArticleIds = (articleIds: string[]): string[] => Array.from(new Set(
  articleIds.map(articleId => articleId.trim()).filter(Boolean),
)).slice(0, 50);

export const listArticleEditorPresence = async (
  articleIds: string[],
): Promise<ArticleEditorPresence[]> => {
  const normalizedIds = normalizeArticleIds(articleIds);
  if (!isSupabaseConfigured || normalizedIds.length === 0) return [];

  const { data, error } = await getSupabaseClient().rpc('list_article_editor_presence', {
    p_article_ids: normalizedIds,
  });
  if (error) throw error;
  return normalizeArticleEditorPresence(data);
};

export const heartbeatArticleEditorPresence = async (
  articleId: string,
  presenceId = getArticleEditorPresenceId(),
): Promise<ArticleEditorPresence[]> => {
  if (!isSupabaseConfigured || !articleId) return [];

  const { data, error } = await getSupabaseClient().rpc('heartbeat_article_editor_presence', {
    p_article_id: articleId,
    p_presence_id: presenceId,
  });
  if (error) throw error;
  return normalizeArticleEditorPresence(data);
};

export const leaveArticleEditorPresence = async (
  articleId: string,
  presenceId = getArticleEditorPresenceId(),
): Promise<void> => {
  if (!isSupabaseConfigured || !articleId) return;

  const { error } = await getSupabaseClient().rpc('leave_article_editor_presence', {
    p_article_id: articleId,
    p_presence_id: presenceId,
  });
  if (error) throw error;
};
