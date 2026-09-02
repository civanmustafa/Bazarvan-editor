import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import { toPublicContentWritingSession } from './contentWritingPresenter';
import type { ContentWritingSession, ContentWritingSessionSummary } from './contentWritingSessionService';

export const presentContentWritingSessions = async (
  sessions: Array<ContentWritingSession | ContentWritingSessionSummary>,
  requestedBy: string,
  options: { includeResult?: boolean } = {},
): Promise<Array<Record<string, unknown>>> => {
  const ids = sessions.filter(session => ['queued', 'retry_scheduled', 'running'].includes(session.status)).map(session => session.id);
  const queues = new Map<string, Record<string, unknown>>();
  if (ids.length) {
    try {
      const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc('get_content_writing_queue_state', {
        p_session_ids: ids,
        p_requested_by: requestedBy,
      });
      if (error) throw error;
      for (const row of Array.isArray(data) ? data : []) {
        if (row.queue_state && typeof row.queue_state === 'object' && !Array.isArray(row.queue_state)) {
          queues.set(row.session_id, row.queue_state);
        }
      }
    } catch {
      // A diagnostic outage must not make an already accepted start look failed
      // (which could cause duplicate submissions). The UI shows an honest fallback.
      console.warn('Content writing queue diagnostics temporarily unavailable.');
    }
  }
  return sessions.map(session => toPublicContentWritingSession(session, { ...options, queueState: queues.get(session.id) }));
};

export const presentContentWritingSession = async (
  session: ContentWritingSession,
  requestedBy: string,
  options: { includeResult?: boolean } = {},
): Promise<Record<string, unknown>> => (await presentContentWritingSessions([session], requestedBy, options))[0];
