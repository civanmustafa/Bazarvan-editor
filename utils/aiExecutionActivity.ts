import {
  collectAiKeyUsageEntries,
  normalizeAiKeySuffix,
  type AiKeyUsageEntry,
  type AiKeyUsageOutcome,
} from './aiKeyUsageFeedback.ts';

export const AI_EXECUTION_ACTIVITY_EVENT = 'bazarvan:ai-execution-activity';
export const AI_EXECUTION_ACTIVITY_REMOVED_EVENT = 'bazarvan:ai-execution-activity-removed';

export type AiExecutionState = 'running' | 'success' | 'failed' | 'cancelled';
export type AiCredentialTier = 'free' | 'paid' | 'unknown';
export type AiExecutionCancelHandler = () => void | Promise<void>;

export type AiExecutionActivity = {
  id: string;
  articleId: string;
  articleTitle: string;
  articleKey: string;
  commandId: string;
  provider: string;
  requestedProvider: string;
  model: string;
  requestedModel: string;
  credentialTier: AiCredentialTier;
  state: AiExecutionState;
  stage: string;
  surface: string;
  action: string;
  message: string;
  keySuffix: string;
  currentKeyIndex?: number;
  keyCount?: number;
  attemptedKeyCount?: number;
  currentModelIndex?: number;
  modelCount?: number;
  totalAttemptCount?: number;
  httpStatus?: number;
  cancellable: boolean;
  entries: AiKeyUsageEntry[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type AiExecutionModelAttemptSummary = {
  model: string;
  successCount: number;
  failureCount: number;
  isCurrent: boolean;
};

type AiExecutionActivityInput = {
  id?: string;
  articleId?: string;
  articleTitle?: string;
  articleKey?: string;
  commandId?: string;
  provider?: string;
  requestedProvider?: string;
  model?: string;
  requestedModel?: string;
  credentialTier?: AiCredentialTier;
  state?: AiExecutionState;
  stage?: string;
  surface?: string;
  action?: string;
  message?: string;
  keySuffix?: string;
  currentKeyIndex?: number;
  keyCount?: number;
  attemptedKeyCount?: number;
  currentModelIndex?: number;
  modelCount?: number;
  totalAttemptCount?: number;
  httpStatus?: number;
  entries?: AiKeyUsageEntry[];
  payload?: unknown;
  progress?: unknown;
  completed?: boolean;
  outcome?: AiKeyUsageOutcome | 'cancelled';
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  cancel?: AiExecutionCancelHandler | null;
};

const activityStore = new Map<string, AiExecutionActivity>();
const retiredActivityStore = new Map<string, AiExecutionActivity>();
const activityCancelHandlers = new Map<string, AiExecutionCancelHandler>();
const cancellationRequests = new Set<string>();
const manuallyCancelledActivities = new Set<string>();
const MAX_STORED_ACTIVITIES = 24;

const rememberRetiredActivity = (activity: AiExecutionActivity): void => {
  retiredActivityStore.delete(activity.id);
  retiredActivityStore.set(activity.id, activity);
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const toPositiveNumber = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
};

const createActivityId = (): string => (
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
);

const firstText = (
  sources: Record<string, unknown>[],
  keys: string[],
): string => {
  for (const source of sources) {
    for (const key of keys) {
      const value = toText(source[key]);
      if (value) return value;
    }
  }
  return '';
};

const firstNumber = (
  sources: Record<string, unknown>[],
  keys: string[],
): number | undefined => {
  for (const source of sources) {
    for (const key of keys) {
      const value = toPositiveNumber(source[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
};

const getProgressSources = (value: unknown): Record<string, unknown>[] => {
  if (!isRecord(value)) return [];
  const progress = isRecord(value.progress) ? value.progress : null;
  const directGemini = isRecord(value.gemini) ? value.gemini : null;
  const progressGemini = progress && isRecord(progress.gemini) ? progress.gemini : null;
  return [
    progressGemini,
    directGemini,
    progress,
    value,
  ].filter((source): source is Record<string, unknown> => Boolean(source));
};

const normalizeProviderToken = (provider: unknown): string => (
  toText(provider).toLowerCase().replace(/[\s_-]+/g, '')
);

export const resolveAiCredentialTier = (provider: unknown): AiCredentialTier => {
  const token = normalizeProviderToken(provider);
  if (!token) return 'unknown';
  if (
    token === 'gemini'
    || token.includes('geminifree')
    || token.includes('geminiالمجاني')
    || token.includes('مجاني')
    || token.includes('free')
  ) {
    return 'free';
  }
  if (
    token.includes('geminipaid')
    || token.includes('geminipro')
    || token.includes('openai')
    || token.includes('chatgpt')
    || token.includes('مدفوع')
    || token.includes('paid')
  ) {
    return 'paid';
  }
  return 'unknown';
};

export const formatAiProviderName = (provider: unknown): string => {
  const value = toText(provider);
  const token = normalizeProviderToken(value);
  if (token === 'geminipaid' || token === 'geminipro') return 'Gemini Pro';
  if (token === 'gemini' || token === 'geminifree') return 'Gemini';
  if (token === 'openai' || token === 'chatgpt') return 'OpenAI';
  if (token === 'crawler') return 'Crawler';
  if (token === 'firecrawl') return 'Firecrawl';
  if (token === 'programmatic') return 'Programmatic';
  return value || 'AI';
};

export const summarizeAiExecutionModelAttempts = (
  activity: Pick<AiExecutionActivity, 'model' | 'requestedModel' | 'entries'>,
): AiExecutionModelAttemptSummary[] => {
  const orderedModels: string[] = [];
  const addModel = (value: unknown): void => {
    const model = toText(value);
    if (model && !orderedModels.includes(model)) orderedModels.push(model);
  };
  addModel(activity.requestedModel);
  activity.entries.forEach(entry => addModel(entry.model));
  addModel(activity.model);

  return orderedModels.map(model => {
    const entries = activity.entries.filter(entry => toText(entry.model) === model);
    return {
      model,
      successCount: entries.filter(entry => entry.outcome === 'success').length,
      failureCount: entries.filter(entry => entry.outcome === 'failed').length,
      isCurrent: model === toText(activity.model),
    };
  });
};

export const getVisibleAiExecutionMessage = (
  activity: AiExecutionActivity,
  surfaceLabel: string,
  sourceLabel: string,
): string => {
  const message = activity.message.trim();
  if (!message) return '';
  const normalized = message
    .toLocaleLowerCase()
    .replace(/[،,:؛;.!؟?()[\]{}…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalizedSurface = surfaceLabel.toLocaleLowerCase().trim();
  const normalizedSource = sourceLabel.toLocaleLowerCase().trim();
  if (normalized === normalizedSurface || normalized === normalizedSource) return '';
  if (activity.state !== 'running') return message;

  const isKeyAttemptMessage = (
    /(تجربة|تجريب|trying|attempting)/i.test(normalized)
    && /(المفتاح|key)/i.test(normalized)
    && (
      /(نموذج|موديل|model)/i.test(normalized)
      || Boolean(activity.keySuffix && normalized.includes(activity.keySuffix.toLocaleLowerCase()))
    )
  );
  return isKeyAttemptMessage ? '' : message;
};

const mergeEntries = (
  current: AiKeyUsageEntry[],
  incoming: AiKeyUsageEntry[],
): AiKeyUsageEntry[] => {
  const merged: AiKeyUsageEntry[] = [];
  const seen = new Set<string>();
  [...current, ...incoming].forEach(entry => {
    const key = [
      normalizeAiKeySuffix(entry.keySuffix),
      entry.outcome,
      entry.status || '',
      toText(entry.model),
    ].join(':');
    if (!normalizeAiKeySuffix(entry.keySuffix) || seen.has(key)) return;
    seen.add(key);
    merged.push({
      ...entry,
      keySuffix: normalizeAiKeySuffix(entry.keySuffix),
    });
  });
  return merged.slice(-40);
};

const findLatestSuccessfulKeySuffix = (entries: AiKeyUsageEntry[]): string => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].outcome === 'success') return entries[index].keySuffix;
  }
  return '';
};

const getDefaultOutcome = (
  input: AiExecutionActivityInput,
  stage: string,
): AiKeyUsageOutcome | undefined => {
  if (input.outcome === 'success') return 'success';
  if (input.outcome === 'failed') return 'failed';
  const normalizedStage = stage.toLowerCase();
  if (['success', 'completed'].includes(normalizedStage)) return 'success';
  if (['failed', 'failed-key', 'error', 'blocked'].includes(normalizedStage)) return 'failed';
  return undefined;
};

const getActivityState = (
  current: AiExecutionState,
  input: AiExecutionActivityInput,
  stage: string,
): AiExecutionState => {
  if (input.state) return input.state;
  if (input.outcome === 'cancelled') return 'cancelled';
  if (input.outcome === 'success') return 'success';
  if (input.outcome === 'failed') return 'failed';
  if (input.completed === false) return 'running';
  const normalizedStage = stage.toLowerCase();
  if (normalizedStage === 'cancelled' || input.httpStatus === 499) return 'cancelled';
  if (input.completed === true) {
    if (['success', 'completed'].includes(normalizedStage)) return 'success';
    if (['failed', 'error', 'blocked'].includes(normalizedStage)) return 'failed';
    if (input.httpStatus && input.httpStatus >= 200 && input.httpStatus < 300) return 'success';
    if (input.httpStatus && input.httpStatus >= 400) return 'failed';
  }
  return current;
};

const pruneActivityStore = (): void => {
  if (activityStore.size <= MAX_STORED_ACTIVITIES) return;
  const oldestTerminal = Array.from(activityStore.values())
    .filter(activity => activity.state !== 'running')
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  while (activityStore.size > MAX_STORED_ACTIVITIES && oldestTerminal.length > 0) {
    const activity = oldestTerminal.shift();
    if (activity) {
      activityStore.delete(activity.id);
      activityCancelHandlers.delete(activity.id);
      cancellationRequests.delete(activity.id);
      manuallyCancelledActivities.delete(activity.id);
    }
  }
};

const publishActivity = (activity: AiExecutionActivity): AiExecutionActivity => {
  const publishedActivity: AiExecutionActivity = {
    ...activity,
    cancellable: activity.state === 'running' && activityCancelHandlers.has(activity.id),
  };
  activityStore.set(publishedActivity.id, publishedActivity);
  pruneActivityStore();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AiExecutionActivity>(AI_EXECUTION_ACTIVITY_EVENT, {
      detail: publishedActivity,
    }));
  }
  return publishedActivity;
};

const syncCancelHandler = (
  id: string,
  input: AiExecutionActivityInput,
  state: AiExecutionState,
): void => {
  if (state !== 'running') {
    activityCancelHandlers.delete(id);
    cancellationRequests.delete(id);
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'cancel')) return;
  if (typeof input.cancel === 'function') {
    activityCancelHandlers.set(id, input.cancel);
    return;
  }
  activityCancelHandlers.delete(id);
};

const createInitialActivity = (
  id: string,
  input: AiExecutionActivityInput,
): AiExecutionActivity => {
  const now = new Date().toISOString();
  const provider = toText(input.provider) || 'AI';
  const state = input.state || 'running';
  const updatedAt = toText(input.updatedAt) || now;
  return {
    id,
    articleId: toText(input.articleId),
    articleTitle: toText(input.articleTitle),
    articleKey: toText(input.articleKey),
    commandId: toText(input.commandId),
    provider,
    requestedProvider: toText(input.requestedProvider) || provider,
    model: toText(input.model),
    requestedModel: toText(input.requestedModel) || toText(input.model),
    credentialTier: input.credentialTier || resolveAiCredentialTier(provider),
    state,
    stage: toText(input.stage) || 'queued',
    surface: toText(input.surface),
    action: toText(input.action),
    message: toText(input.message),
    keySuffix: normalizeAiKeySuffix(input.keySuffix),
    ...(toPositiveNumber(input.currentKeyIndex) ? { currentKeyIndex: toPositiveNumber(input.currentKeyIndex) } : {}),
    ...(toPositiveNumber(input.keyCount) ? { keyCount: toPositiveNumber(input.keyCount) } : {}),
    ...(toPositiveNumber(input.attemptedKeyCount) ? { attemptedKeyCount: toPositiveNumber(input.attemptedKeyCount) } : {}),
    ...(toPositiveNumber(input.currentModelIndex) ? { currentModelIndex: toPositiveNumber(input.currentModelIndex) } : {}),
    ...(toPositiveNumber(input.modelCount) ? { modelCount: toPositiveNumber(input.modelCount) } : {}),
    ...(toPositiveNumber(input.totalAttemptCount) ? { totalAttemptCount: toPositiveNumber(input.totalAttemptCount) } : {}),
    ...(toPositiveNumber(input.httpStatus) ? { httpStatus: toPositiveNumber(input.httpStatus) } : {}),
    cancellable: false,
    entries: input.entries || [],
    startedAt: toText(input.startedAt) || now,
    updatedAt,
    ...(state !== 'running' ? {
      completedAt: toText(input.completedAt) || updatedAt,
    } : {}),
  };
};

const readProgressInput = (value: unknown): AiExecutionActivityInput => {
  const sources = getProgressSources(value);
  if (sources.length === 0) return {};
  const root = isRecord(value) ? value : {};
  const completed = sources.some(source => source.completed === true)
    ? true
    : sources.some(source => source.completed === false)
      ? false
      : undefined;
  return {
    provider: firstText(sources, ['provider']),
    model: firstText(sources, ['model']),
    requestedModel: firstText(sources, ['requestedModel', 'requested_model']),
    stage: firstText(sources, ['stage', 'status']),
    message: firstText([...sources].reverse(), ['message', 'detail', 'reason']),
    keySuffix: firstText(sources, ['keySuffix', 'key_suffix']),
    currentKeyIndex: firstNumber(sources, ['currentKeyIndex', 'current_key_index']),
    keyCount: firstNumber(sources, ['keyCount', 'key_count']),
    attemptedKeyCount: firstNumber(sources, ['attemptedKeyCount', 'attempted_key_count']),
    currentModelIndex: firstNumber(sources, ['currentModelIndex', 'current_model_index']),
    modelCount: firstNumber(sources, ['modelCount', 'model_count']),
    totalAttemptCount: firstNumber(sources, ['totalAttemptCount', 'attemptCount', 'attempt_count']),
    httpStatus: firstNumber(sources, ['status', 'httpStatus', 'http_status']),
    payload: root,
    completed,
  };
};

export const beginAiExecutionActivity = (
  input: AiExecutionActivityInput,
): AiExecutionActivity => {
  const id = toText(input.id) || createActivityId();
  retiredActivityStore.delete(id);
  manuallyCancelledActivities.delete(id);
  cancellationRequests.delete(id);
  const current = activityStore.get(id);
  if (current) {
    return updateAiExecutionActivity(id, {
      ...input,
      state: input.state || 'running',
      completed: false,
    });
  }
  const initial = createInitialActivity(id, {
    ...input,
    state: input.state || 'running',
  });
  syncCancelHandler(id, input, initial.state);
  return publishActivity(initial);
};

export const updateAiExecutionActivity = (
  id: string,
  input: AiExecutionActivityInput,
): AiExecutionActivity => {
  const normalizedId = toText(id) || createActivityId();
  const retiredActivity = retiredActivityStore.get(normalizedId);
  if (!activityStore.has(normalizedId) && retiredActivity) return retiredActivity;
  const progressInput = readProgressInput(input.progress);
  const payloadInput = readProgressInput(input.payload);
  const mergedInput: AiExecutionActivityInput = {
    ...payloadInput,
    ...progressInput,
    ...input,
  };
  const current = activityStore.get(normalizedId)
    || createInitialActivity(normalizedId, mergedInput);
  const provider = toText(mergedInput.provider) || current.provider;
  let stage = toText(mergedInput.stage) || current.stage;
  const payload = mergedInput.payload ?? mergedInput.progress;
  const defaultOutcome = getDefaultOutcome(mergedInput, stage);
  const payloadEntries = collectAiKeyUsageEntries(payload, defaultOutcome);
  const entries = mergeEntries(
    current.entries,
    mergeEntries(mergedInput.entries || [], payloadEntries),
  );
  const now = new Date().toISOString();
  const observedUpdatedAt = toText(mergedInput.updatedAt);
  let state = getActivityState(current.state, mergedInput, stage);
  let message = toText(mergedInput.message) || current.message;
  if (
    manuallyCancelledActivities.has(normalizedId)
    && current.state === 'cancelled'
    && mergedInput.completed === false
  ) {
    state = 'cancelled';
    stage = current.stage;
    message = current.message;
  }
  const keySuffix = normalizeAiKeySuffix(mergedInput.keySuffix)
    || findLatestSuccessfulKeySuffix(entries)
    || normalizeAiKeySuffix(current.keySuffix);
  const activity: AiExecutionActivity = {
    ...current,
    articleId: toText(mergedInput.articleId) || current.articleId,
    articleTitle: toText(mergedInput.articleTitle) || current.articleTitle,
    articleKey: toText(mergedInput.articleKey) || current.articleKey,
    commandId: toText(mergedInput.commandId) || current.commandId,
    provider,
    requestedProvider: toText(mergedInput.requestedProvider) || current.requestedProvider || provider,
    model: toText(mergedInput.model) || current.model,
    requestedModel: toText(mergedInput.requestedModel) || current.requestedModel,
    credentialTier: mergedInput.credentialTier || resolveAiCredentialTier(provider),
    state,
    stage,
    surface: toText(mergedInput.surface) || current.surface,
    action: toText(mergedInput.action) || current.action,
    message,
    keySuffix,
    ...(toPositiveNumber(mergedInput.currentKeyIndex) ? { currentKeyIndex: toPositiveNumber(mergedInput.currentKeyIndex) } : {}),
    ...(toPositiveNumber(mergedInput.keyCount) ? { keyCount: toPositiveNumber(mergedInput.keyCount) } : {}),
    ...(toPositiveNumber(mergedInput.attemptedKeyCount) ? { attemptedKeyCount: toPositiveNumber(mergedInput.attemptedKeyCount) } : {}),
    ...(toPositiveNumber(mergedInput.currentModelIndex) ? { currentModelIndex: toPositiveNumber(mergedInput.currentModelIndex) } : {}),
    ...(toPositiveNumber(mergedInput.modelCount) ? { modelCount: toPositiveNumber(mergedInput.modelCount) } : {}),
    ...(toPositiveNumber(mergedInput.totalAttemptCount) ? { totalAttemptCount: toPositiveNumber(mergedInput.totalAttemptCount) } : {}),
    ...(toPositiveNumber(mergedInput.httpStatus) ? { httpStatus: toPositiveNumber(mergedInput.httpStatus) } : {}),
    entries,
    startedAt: toText(mergedInput.startedAt) || current.startedAt,
    updatedAt: observedUpdatedAt || now,
    ...(state !== 'running' ? {
      completedAt: toText(mergedInput.completedAt)
        || current.completedAt
        || observedUpdatedAt
        || now,
    } : { completedAt: undefined }),
  };
  syncCancelHandler(normalizedId, mergedInput, state);
  return publishActivity(activity);
};

export const finishAiExecutionActivity = (
  id: string,
  input: AiExecutionActivityInput,
): AiExecutionActivity => {
  const outcome = input.outcome
    || (input.httpStatus === 499
      ? 'cancelled'
      : input.httpStatus && input.httpStatus >= 200 && input.httpStatus < 300
        ? 'success'
        : 'failed');
  return updateAiExecutionActivity(id, {
    ...input,
    outcome,
    completed: true,
    stage: toText(input.stage) || outcome,
  });
};

export const getAiExecutionActivities = (): AiExecutionActivity[] => (
  Array.from(activityStore.values())
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
);

export const removeAiExecutionActivity = (id: string): boolean => {
  const normalizedId = toText(id);
  if (!normalizedId) return false;

  const currentActivity = activityStore.get(normalizedId);
  const removed = activityStore.delete(normalizedId);
  if (currentActivity) rememberRetiredActivity(currentActivity);
  activityCancelHandlers.delete(normalizedId);
  cancellationRequests.delete(normalizedId);
  manuallyCancelledActivities.delete(normalizedId);
  if (removed && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<string>(AI_EXECUTION_ACTIVITY_REMOVED_EVENT, {
      detail: normalizedId,
    }));
  }
  return removed;
};

export const clearAiExecutionActivities = (): number => {
  const activityIds = Array.from(activityStore.keys());
  activityIds.forEach(activityId => removeAiExecutionActivity(activityId));
  return activityIds.length;
};

export const getAiExecutionActivitiesForArticle = (
  activities: readonly AiExecutionActivity[],
  articleId: string | null,
  articleKey = '',
): AiExecutionActivity[] => {
  const normalizedArticleId = toText(articleId);
  if (normalizedArticleId) {
    return activities.filter(activity => activity.articleId === normalizedArticleId);
  }

  const normalizedArticleKey = toText(articleKey);
  return activities.filter(activity => (
    !activity.articleId
    && (!normalizedArticleKey || activity.articleKey === normalizedArticleKey)
  ));
};

export const getRunningAiExecutionActivities = (
  activities: readonly AiExecutionActivity[],
): AiExecutionActivity[] => activities.filter(activity => activity.state === 'running');

export const requestAiExecutionActivityCancel = async (
  id: string,
): Promise<AiExecutionActivity> => {
  const normalizedId = toText(id);
  const current = activityStore.get(normalizedId);
  const cancel = activityCancelHandlers.get(normalizedId);
  if (!current || current.state !== 'running') {
    throw new Error('هذه العملية ليست نشطة الآن.');
  }
  if (!cancel) {
    throw new Error('لا تدعم هذه العملية الإيقاف من نافذة الحالة.');
  }
  if (cancellationRequests.has(normalizedId)) return current;

  cancellationRequests.add(normalizedId);
  updateAiExecutionActivity(normalizedId, {
    stage: 'cancelling',
    completed: false,
    message: 'جار إرسال طلب الإيقاف إلى المهمة الأصلية...',
  });
  try {
    await cancel();
    manuallyCancelledActivities.add(normalizedId);
    return finishAiExecutionActivity(normalizedId, {
      stage: 'cancelled',
      outcome: 'cancelled',
      httpStatus: 499,
      message: 'تم إيقاف العملية يدويًا من نافذة حالة الذكاء الاصطناعي.',
    });
  } catch (error) {
    cancellationRequests.delete(normalizedId);
    updateAiExecutionActivity(normalizedId, {
      stage: 'cancellation_failed',
      completed: false,
      message: error instanceof Error
        ? `تعذر إيقاف العملية: ${error.message}`
        : 'تعذر إيقاف العملية بسبب خطأ غير معروف.',
    });
    throw error;
  }
};

export const resetAiExecutionActivitiesForTests = (): void => {
  activityStore.clear();
  retiredActivityStore.clear();
  activityCancelHandlers.clear();
  cancellationRequests.clear();
  manuallyCancelledActivities.clear();
};
