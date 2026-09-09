import { useEffect, useMemo, useState } from 'react';
import {
  ARTICLE_EDITOR_PRESENCE_HEARTBEAT_MS,
  ARTICLE_EDITOR_PRESENCE_REFRESH_MS,
  getArticleEditorPresenceId,
  groupArticleEditorPresence,
  heartbeatArticleEditorPresence,
  leaveArticleEditorPresence,
  listArticleEditorPresence,
  type ArticleEditorPresence,
  type ArticleEditorPresenceMap,
} from '../utils/articleEditorPresence';

export type ArticlePresenceLoadStatus = 'loading' | 'ready' | 'error';

export const useDashboardArticleEditorPresence = (
  articleIds: string[],
  enabled: boolean,
): {
  presenceByArticleId: ArticleEditorPresenceMap;
  status: ArticlePresenceLoadStatus;
} => {
  const articleIdsKey = articleIds.join('|');
  const stableArticleIds = useMemo(
    () => articleIdsKey.split('|').map(articleId => articleId.trim()).filter(Boolean),
    [articleIdsKey],
  );
  const [presenceByArticleId, setPresenceByArticleId] = useState<ArticleEditorPresenceMap>({});
  const [status, setStatus] = useState<ArticlePresenceLoadStatus>('loading');

  useEffect(() => {
    if (!enabled || stableArticleIds.length === 0) {
      setPresenceByArticleId({});
      setStatus('ready');
      return;
    }

    let cancelled = false;
    let requestInFlight = false;
    setStatus('loading');

    const refresh = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const presence = await listArticleEditorPresence(stableArticleIds);
        if (!cancelled) {
          setPresenceByArticleId(groupArticleEditorPresence(presence));
          setStatus('ready');
        }
      } catch (error) {
        console.error('Failed to monitor dashboard article presence:', error);
        if (!cancelled) setStatus('error');
      } finally {
        requestInFlight = false;
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };

    void refresh();
    const intervalId = window.setInterval(() => { void refresh(); }, ARTICLE_EDITOR_PRESENCE_REFRESH_MS);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [enabled, articleIdsKey]);

  return { presenceByArticleId, status };
};

export const useActiveArticleEditorPresence = (
  articleId: string | null,
  currentUserId: string | null,
): {
  otherEditors: ArticleEditorPresence[];
  status: ArticlePresenceLoadStatus;
} => {
  const [presence, setPresence] = useState<ArticleEditorPresence[]>([]);
  const [status, setStatus] = useState<ArticlePresenceLoadStatus>('loading');

  useEffect(() => {
    if (!articleId || !currentUserId) {
      setPresence([]);
      setStatus('ready');
      return;
    }

    const presenceId = getArticleEditorPresenceId();
    let cancelled = false;
    let requestInFlight = false;
    setPresence([]);
    setStatus('loading');

    const heartbeat = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const nextPresence = await heartbeatArticleEditorPresence(articleId, presenceId);
        if (!cancelled) {
          setPresence(nextPresence);
          setStatus('ready');
        }
      } catch (error) {
        console.error(`Failed to monitor editor presence for article "${articleId}":`, error);
        if (!cancelled) setStatus('error');
      } finally {
        requestInFlight = false;
      }
    };

    const heartbeatWhenVisible = () => {
      if (document.visibilityState === 'visible') void heartbeat();
    };

    void heartbeat();
    const intervalId = window.setInterval(() => { void heartbeat(); }, ARTICLE_EDITOR_PRESENCE_HEARTBEAT_MS);
    window.addEventListener('focus', heartbeatWhenVisible);
    document.addEventListener('visibilitychange', heartbeatWhenVisible);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', heartbeatWhenVisible);
      document.removeEventListener('visibilitychange', heartbeatWhenVisible);
      void leaveArticleEditorPresence(articleId, presenceId).catch(error => {
        console.warn(`Could not immediately clear editor presence for article "${articleId}":`, error);
      });
    };
  }, [articleId, currentUserId]);

  return {
    otherEditors: presence.filter(item => item.userId !== currentUserId),
    status,
  };
};
