import {
  cancelContentWritingSession,
  getContentWritingSessionDetail,
  isContentWritingSessionActive,
  type ContentWritingSession,
  type ContentWritingSessionDetail,
} from './contentWritingSessions';
import {
  finishAiExecutionActivity,
  updateAiExecutionActivity,
} from './aiExecutionActivity';

type ContentWritingActivityOptions = {
  activityId: string;
  action?: string;
  articleId?: string;
  articleTitle?: string;
};

type ActiveMonitor = {
  activityId: string;
  token: string;
};

const activeMonitors = new Map<string, ActiveMonitor>();
const CONTENT_WRITING_ACTIVITY_POLL_MS = 2_500;
const CONTENT_WRITING_ACTIVITY_MAX_MS = 24 * 60 * 60 * 1_000;

export const getContentWritingActivityId = (
  sessionId: string,
  fallbackActivityId: string,
): string => activeMonitors.get(sessionId)?.activityId || fallbackActivityId;

export const syncContentWritingSessionActivity = (
  session: ContentWritingSession,
  steps: ContentWritingSessionDetail['steps'] = [],
  options: ContentWritingActivityOptions,
): void => {
  if (session.executionMode !== 'api') return;
  const payload = {
    status: session.status === 'completed'
      ? 200
      : session.status === 'failed'
        ? 500
        : session.status === 'cancelled'
          ? 499
          : undefined,
    keySuffix: session.keySuffix,
    responseMetadata: session.responseMetadata,
    result: steps.map(step => step.metadata),
  };
  const common = {
    provider: typeof session.progress.provider === 'string'
      ? session.progress.provider
      : session.provider,
    requestedProvider: session.provider,
    model: typeof session.progress.model === 'string'
      ? session.progress.model
      : session.model,
    requestedModel: typeof session.progress.requestedModel === 'string'
      ? session.progress.requestedModel
      : session.model,
    keySuffix: typeof session.progress.keySuffix === 'string'
      ? session.progress.keySuffix
      : session.keySuffix || undefined,
    progress: session.progress,
    payload,
    articleId: options.articleId || session.articleId,
    articleTitle: options.articleTitle,
    surface: 'content_writing',
    action: options.action,
    message: typeof session.progress.message === 'string'
      ? session.progress.message
      : session.lastError || undefined,
  };
  if (isContentWritingSessionActive(session)) {
    updateAiExecutionActivity(options.activityId, {
      ...common,
      stage: session.status,
      completed: false,
      cancel: async () => {
        await cancelContentWritingSession(session.id);
      },
    });
    return;
  }
  finishAiExecutionActivity(options.activityId, {
    ...common,
    stage: session.status,
    httpStatus: session.status === 'completed' ? 200 : session.status === 'cancelled' ? 499 : 500,
    outcome: session.status === 'completed'
      ? 'success'
      : session.status === 'cancelled'
        ? 'cancelled'
        : 'failed',
  });
};

export const monitorContentWritingSessionActivity = (
  sessionId: string,
  options: ContentWritingActivityOptions,
): void => {
  if (typeof window === 'undefined' || !sessionId.trim() || !options.activityId.trim()) return;
  const existing = activeMonitors.get(sessionId);
  if (existing?.activityId === options.activityId) return;

  const token = `${options.activityId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const startedAt = Date.now();
  activeMonitors.set(sessionId, { activityId: options.activityId, token });

  const poll = async (): Promise<void> => {
    const current = activeMonitors.get(sessionId);
    if (!current || current.token !== token) return;
    if (Date.now() - startedAt > CONTENT_WRITING_ACTIVITY_MAX_MS) {
      activeMonitors.delete(sessionId);
      finishAiExecutionActivity(options.activityId, {
        surface: 'content_writing',
        action: options.action,
        articleId: options.articleId,
        articleTitle: options.articleTitle,
        outcome: 'failed',
        stage: 'failed',
        message: 'تجاوزت متابعة جلسة الكتابة مدة 24 ساعة دون حالة نهائية.',
      });
      return;
    }

    try {
      const detail = await getContentWritingSessionDetail(sessionId);
      syncContentWritingSessionActivity(detail.session, detail.steps, options);
      if (!isContentWritingSessionActive(detail.session)) {
        activeMonitors.delete(sessionId);
        return;
      }
    } catch (error) {
      updateAiExecutionActivity(options.activityId, {
        surface: 'content_writing',
        action: options.action,
        articleId: options.articleId,
        articleTitle: options.articleTitle,
        completed: false,
        stage: 'reconnecting',
        message: error instanceof Error
          ? `تعذر تحديث الحالة مؤقتًا: ${error.message}`
          : 'تعذر تحديث حالة جلسة الكتابة مؤقتًا.',
      });
    }

    window.setTimeout((): void => {
      void poll();
    }, CONTENT_WRITING_ACTIVITY_POLL_MS);
  };

  window.setTimeout((): void => {
    void poll();
  }, CONTENT_WRITING_ACTIVITY_POLL_MS);
};
