import {
  collectAiKeyUsageEntries,
  normalizeAiKeySuffix,
  type AiKeyUsageEntry,
  type AiKeyUsageOutcome,
} from './aiKeyUsageFeedback.ts';

export const AI_EXECUTION_ACTIVITY_EVENT = 'bazarvan:ai-execution-activity';

export type AiExecutionState = 'running' | 'success' | 'failed' | 'cancelled';
export type AiCredentialTier = 'free' | 'paid' | 'unknown';

export type AiExecutionActivity = {
  id: string;
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
  entries: AiKeyUsageEntry[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

type AiExecutionActivityInput = {
  id?: string;
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
};

const activityStore = new Map<string, AiExecutionActivity>();
const MAX_STORED_ACTIVITIES = 24;

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
  return value || 'AI';
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
    if (activity) activityStore.delete(activity.id);
  }
};

const publishActivity = (activity: AiExecutionActivity): AiExecutionActivity => {
  activityStore.set(activity.id, activity);
  pruneActivityStore();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AiExecutionActivity>(AI_EXECUTION_ACTIVITY_EVENT, {
      detail: activity,
    }));
  }
  return activity;
};

const createInitialActivity = (
  id: string,
  input: AiExecutionActivityInput,
): AiExecutionActivity => {
  const now = new Date().toISOString();
  const provider = toText(input.provider) || 'AI';
  return {
    id,
    provider,
    requestedProvider: toText(input.requestedProvider) || provider,
    model: toText(input.model),
    requestedModel: toText(input.requestedModel) || toText(input.model),
    credentialTier: input.credentialTier || resolveAiCredentialTier(provider),
    state: input.state || 'running',
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
    entries: input.entries || [],
    startedAt: toText(input.startedAt) || now,
    updatedAt: now,
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
  const current = activityStore.get(id);
  if (current) {
    return updateAiExecutionActivity(id, {
      ...input,
      state: input.state || 'running',
      completed: false,
    });
  }
  return publishActivity(createInitialActivity(id, {
    ...input,
    state: input.state || 'running',
  }));
};

export const updateAiExecutionActivity = (
  id: string,
  input: AiExecutionActivityInput,
): AiExecutionActivity => {
  const normalizedId = toText(id) || createActivityId();
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
  const stage = toText(mergedInput.stage) || current.stage;
  const payload = mergedInput.payload ?? mergedInput.progress;
  const defaultOutcome = getDefaultOutcome(mergedInput, stage);
  const payloadEntries = collectAiKeyUsageEntries(payload, defaultOutcome);
  const entries = mergeEntries(
    current.entries,
    mergeEntries(mergedInput.entries || [], payloadEntries),
  );
  const now = new Date().toISOString();
  const state = getActivityState(current.state, mergedInput, stage);
  const keySuffix = normalizeAiKeySuffix(mergedInput.keySuffix)
    || findLatestSuccessfulKeySuffix(entries)
    || normalizeAiKeySuffix(current.keySuffix);
  const activity: AiExecutionActivity = {
    ...current,
    provider,
    requestedProvider: toText(mergedInput.requestedProvider) || current.requestedProvider || provider,
    model: toText(mergedInput.model) || current.model,
    requestedModel: toText(mergedInput.requestedModel) || current.requestedModel,
    credentialTier: mergedInput.credentialTier || resolveAiCredentialTier(provider),
    state,
    stage,
    surface: toText(mergedInput.surface) || current.surface,
    action: toText(mergedInput.action) || current.action,
    message: toText(mergedInput.message) || current.message,
    keySuffix,
    ...(toPositiveNumber(mergedInput.currentKeyIndex) ? { currentKeyIndex: toPositiveNumber(mergedInput.currentKeyIndex) } : {}),
    ...(toPositiveNumber(mergedInput.keyCount) ? { keyCount: toPositiveNumber(mergedInput.keyCount) } : {}),
    ...(toPositiveNumber(mergedInput.attemptedKeyCount) ? { attemptedKeyCount: toPositiveNumber(mergedInput.attemptedKeyCount) } : {}),
    ...(toPositiveNumber(mergedInput.currentModelIndex) ? { currentModelIndex: toPositiveNumber(mergedInput.currentModelIndex) } : {}),
    ...(toPositiveNumber(mergedInput.modelCount) ? { modelCount: toPositiveNumber(mergedInput.modelCount) } : {}),
    ...(toPositiveNumber(mergedInput.totalAttemptCount) ? { totalAttemptCount: toPositiveNumber(mergedInput.totalAttemptCount) } : {}),
    ...(toPositiveNumber(mergedInput.httpStatus) ? { httpStatus: toPositiveNumber(mergedInput.httpStatus) } : {}),
    entries,
    updatedAt: now,
    ...(state !== 'running' ? { completedAt: current.completedAt || now } : { completedAt: undefined }),
  };
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

export const resetAiExecutionActivitiesForTests = (): void => {
  activityStore.clear();
};
