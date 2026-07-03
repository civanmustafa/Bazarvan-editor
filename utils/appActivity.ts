import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';

const SESSION_STORAGE_KEY = 'bazarvan-app-session-id';
const LAST_PATH_STORAGE_KEY = 'bazarvan-last-activity-path';

type ActivityEventInput = {
  eventType: string;
  entityType?: string;
  entityId?: string;
  path?: string;
  metadata?: Record<string, any>;
};

const canUseSessionStorage = (): boolean => (
  typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined'
);

const readSessionId = (): string | null => {
  if (!canUseSessionStorage()) return null;
  return sessionStorage.getItem(SESSION_STORAGE_KEY);
};

const writeSessionId = (sessionId: string) => {
  if (!canUseSessionStorage()) return;
  sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
};

const removeSessionId = () => {
  if (!canUseSessionStorage()) return;
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
};

export const getCurrentAppSessionId = (): string | null => readSessionId();

export const ensureAppSession = async (userId: string): Promise<string | null> => {
  if (!isSupabaseConfigured || !userId) return null;
  const supabase = getSupabaseClient();
  const existingSessionId = readSessionId();
  const path = typeof window !== 'undefined' ? window.location.pathname : '';

  if (existingSessionId) {
    const { error } = await supabase
      .from('app_sessions')
      .update({
        last_seen_at: new Date().toISOString(),
        path,
      })
      .eq('id', existingSessionId)
      .eq('user_id', userId);

    if (!error) return existingSessionId;
    if (error.code !== '42P01') {
      console.error('Failed to refresh app session:', error);
    }
  }

  const { data, error } = await supabase
    .from('app_sessions')
    .insert({
      user_id: userId,
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      path,
      metadata: {
        language: typeof navigator !== 'undefined' ? navigator.language : '',
      },
    })
    .select('id')
    .single();

  if (error) {
    if (error.code !== '42P01') {
      console.error('Failed to create app session:', error);
    }
    return null;
  }

  const sessionId = String(data.id);
  writeSessionId(sessionId);
  return sessionId;
};

export const endAppSession = async () => {
  if (!isSupabaseConfigured) return;
  const sessionId = readSessionId();
  if (!sessionId) return;

  try {
    const supabase = getSupabaseClient();
    await supabase
      .from('app_sessions')
      .update({
        ended_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', sessionId);
  } catch (error) {
    console.error('Failed to end app session:', error);
  } finally {
    removeSessionId();
  }
};

export const recordAppActivity = async (
  userId: string,
  input: ActivityEventInput,
): Promise<void> => {
  if (!isSupabaseConfigured || !userId) return;

  const sessionId = readSessionId() || await ensureAppSession(userId);
  const path = input.path || (typeof window !== 'undefined' ? window.location.pathname : '');

  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('app_activity_events')
      .insert({
        user_id: userId,
        session_id: sessionId,
        event_type: input.eventType,
        entity_type: input.entityType || null,
        entity_id: input.entityId || null,
        path,
        metadata: input.metadata || {},
      });

    if (error && error.code !== '42P01') {
      console.error('Failed to record app activity:', error);
    }
  } catch (error) {
    console.error('Failed to record app activity:', error);
  }
};

export const recordPathActivityIfChanged = async (userId: string, path: string): Promise<void> => {
  if (!canUseSessionStorage()) return;
  const previousPath = sessionStorage.getItem(LAST_PATH_STORAGE_KEY);
  if (previousPath === path) return;
  sessionStorage.setItem(LAST_PATH_STORAGE_KEY, path);
  await recordAppActivity(userId, {
    eventType: 'route_view',
    path,
  });
};
