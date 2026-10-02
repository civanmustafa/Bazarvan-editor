import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi';
import { normalizeContentWritingMinimumCompetitors } from '../constants/competitors';

export type ContentWritingAutomationItemStatus =
  | 'ready'
  | 'claiming'
  | 'writing'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export type ContentWritingAutomationSettings = {
  enabled: boolean;
  intervalMinutes: number;
  provider: 'gemini' | 'geminiPaid' | 'openai';
  model: string;
  minimumCompetitors: number;
  requireCompetitorTerminalState: boolean;
  maxAttempts: number;
  retryMinutes: number;
  autoApplyPassedContent: boolean;
};

export type ContentWritingAutomationReadiness = {
  ready: boolean;
  missingFields: string[];
  signature: string;
  usableCompetitorCount: number;
  pendingCompetitorCount: number;
  processingComplete: boolean;
  articleTitle: string;
  articleStatus: string;
  articleUpdatedAt: string;
};

export type ContentWritingAutomationItem = {
  id: string;
  articleId: string;
  articleTitle: string;
  articleStatus: string;
  requestedBy: string;
  status: ContentWritingAutomationItemStatus;
  readinessSignature: string;
  usableCompetitorCount: number;
  pendingCompetitorCount: number;
  provider: string;
  model: string;
  sessionId: string | null;
  sessionStatus: string | null;
  qualityScore: number | null;
  qualityPassed: boolean | null;
  attemptCount: number;
  maxAttempts: number;
  readyAt: string;
  eligibleAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  failureClass: 'transient' | 'waiting_input' | 'terminal' | null;
  recoveryCount: number;
  nextRecoveryAt: string | null;
  updatedAt: string;
  resolvedBySessionId?: string | null;
  resolvedAt?: string | null;
};

export type ContentWritingAutomationCandidate = {
  position: number;
  articleId: string;
  articleTitle: string;
  articleStatus: string;
  articleUpdatedAt: string;
  itemId: string | null;
  itemStatus: string;
  eligibleAt: string | null;
  readiness: ContentWritingAutomationReadiness;
};

export type ContentWritingAutomationGlobalBlocker = {
  type: string;
  articleId: string | null;
  articleTitle: string;
  status: string;
  message: string;
};

export type AutomaticArticleFocus = {
  articleId: string | null;
  articleTitle: string;
  articleVisible: boolean;
  state: 'idle' | 'active' | 'waiting_retry' | 'needs_attention';
  currentStage: string | null;
  acquiredAt: string | null;
  lastProgressAt: string | null;
  nextRetryAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  attemptMetric?: 'gemini_execution' | 'writing_execution' | 'worker_execution';
  recoveryCount?: number;
  maxRecoveries?: number;
  lastErrorCode: string | null;
  lastError: string | null;
  generation: number;
  lastArticleId: string | null;
  lastArticleTitle: string;
  lastReleaseReason: string | null;
  releasedAt: string | null;
  canResume: boolean;
};

export type ContentWritingAutomationOverview = {
  schemaAvailable: boolean;
  settings: ContentWritingAutomationSettings;
  state: {
    nextAllowedAt: string;
    lastItemId: string | null;
    lastSessionId: string | null;
    lastArticleId: string | null;
    lastOutcome: string | null;
    updatedAt: string;
  } | null;
  active: ContentWritingAutomationItem | null;
  lastItem: ContentWritingAutomationItem | null;
  globalBlocker: ContentWritingAutomationGlobalBlocker | null;
  focus?: AutomaticArticleFocus | null;
  candidates: ContentWritingAutomationCandidate[];
};

export type AutomaticRecoverySchedule = {
  available: boolean;
  enabled: boolean;
  checkIntervalSeconds: number;
  pendingCount: number;
  dueCount: number;
  nextRecoveryAt: string | null;
};

export type AutomationTaskStatus = 'running' | 'scheduled' | 'ready' | 'unscheduled' | 'failed';

export type AutomationTaskRequirement = {
  code: string;
  state: 'complete' | 'missing' | 'running' | 'scheduled' | 'blocked';
  current: number | null;
  required: number | null;
  articleId: string | null;
  articleTitle: string | null;
  stage: string | null;
};

export type AutomationTaskInventoryItem = {
  taskId: string;
  operationKey: string;
  articleId: string;
  articleTitle: string;
  articleStatus?: string;
  status: AutomationTaskStatus;
  scheduled: boolean;
  scheduleAt: string | null;
  startedAt: string | null;
  readyAt: string | null;
  updatedAt: string;
  sourceType: string;
  sourceId: string | null;
  priorityRank: number;
  reasonCode: string | null;
  reason: string | null;
  attemptCount: number;
  maxAttempts: number;
  attemptMetric?: 'gemini_execution' | 'writing_execution' | 'worker_execution';
  missingFields: string[];
  usableCompetitorCount: number;
  minimumCompetitorCount: number;
  recoveryCount: number;
  maxRecoveries: number;
  manualReview: boolean;
  runnable: boolean;
  currentBlocker?: boolean | null;
  blockerCategory?: 'waiting_prerequisite' | 'transient' | 'permanent' | 'resolved' | null;
  rootOperationKey?: string | null;
  historicalErrorCode?: string | null;
  historicalError?: string | null;
  historicalResolvedAt?: string | null;
  requirements?: AutomationTaskRequirement[];
  blockedByArticleId?: string | null;
  blockedByArticleTitle?: string | null;
  blockedByStage?: string | null;
  blockedByState?: string | null;
  upstreamStage?: string | null;
  upstreamState?: string | null;
};

export type ContentWritingAutomationStatus = {
  overview: ContentWritingAutomationOverview;
  taskInventory: AutomationTaskInventoryItem[];
  taskScope: 'system' | 'accessible';
  automaticRecovery: AutomaticRecoverySchedule;
  article: {
    readiness: ContentWritingAutomationReadiness | null;
    item: ContentWritingAutomationItem | null;
    activeFullPipeline: {
      id: string;
      status: string;
      progress: Record<string, unknown>;
      updatedAt: string;
    } | null;
    hasCompletedContentWritingSession: boolean;
  } | null;
};

const normalizeAutomaticRecoverySchedule = (value: unknown): AutomaticRecoverySchedule => {
  const source = isRecord(value) ? value : {};
  return {
    available: source.available === true,
    enabled: source.enabled !== false,
    checkIntervalSeconds: Math.max(1, integer(source.checkIntervalSeconds, 60)),
    pendingCount: Math.max(0, integer(source.pendingCount)),
    dueCount: Math.max(0, integer(source.dueCount)),
    nextRecoveryAt: nullableText(source.nextRecoveryAt),
  };
};

export type ContentWritingArticleSummaryState =
  | 'queued'
  | 'writing'
  | 'waiting_prerequisites'
  | 'partial'
  | 'written'
  | 'written_quality_failed'
  | 'written_quality_passed'
  | 'applied'
  | 'failed'
  | 'cancelled';

export type ContentWritingWorkReadinessState =
  | 'awaiting_writing'
  | 'waiting_cleanup'
  | 'cleaning'
  | 'auditing'
  | 'ready'
  | 'partial'
  | 'needs_attention';

export type ContentWritingArticleSummary = {
  articleId: string;
  state: ContentWritingArticleSummaryState;
  sessionId: string | null;
  sessionStatus: string | null;
  qualityScore: number | null;
  qualityMinimumScore: number | null;
  qualityPassed: boolean | null;
  hasFullDraft: boolean;
  partialStepCount: number;
  appliedAt: string | null;
  automaticApplicationStatus: string | null;
  workReadiness: {
    state: ContentWritingWorkReadinessState;
    ready: boolean;
    cleanupCurrent: boolean;
    cleanupActive: boolean;
    cleanupFailed: boolean;
    requiredAuditCount: number;
    completedAuditCount: number;
    activeAuditCount: number;
    failedAuditCount: number;
  } | null;
  usableCompetitorCount: number;
  minimumCompetitorCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
};

const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const nullableText = (value: unknown): string | null => text(value) || null;
const integer = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
};

const normalizeSettings = (value: unknown): ContentWritingAutomationSettings => {
  const source = isRecord(value) ? value : {};
  const provider = source.provider === 'geminiPaid' || source.provider === 'openai'
    ? source.provider
    : 'gemini';
  return {
    enabled: source.enabled === true,
    intervalMinutes: Math.max(1, integer(source.intervalMinutes, 15)),
    provider,
    model: text(source.model),
    minimumCompetitors: normalizeContentWritingMinimumCompetitors(source.minimumCompetitors),
    requireCompetitorTerminalState: source.requireCompetitorTerminalState !== false,
    maxAttempts: Math.max(1, integer(source.maxAttempts, 3)),
    retryMinutes: Math.max(1, integer(source.retryMinutes, 30)),
    autoApplyPassedContent: source.autoApplyPassedContent === true,
  };
};

const normalizeReadiness = (value: unknown): ContentWritingAutomationReadiness | null => {
  const source = isRecord(value) ? value : null;
  if (!source) return null;
  return {
    ready: source.ready === true,
    missingFields: Array.isArray(source.missingFields)
      ? source.missingFields.map(text).filter(Boolean)
      : [],
    signature: text(source.signature),
    usableCompetitorCount: integer(source.usableCompetitorCount),
    pendingCompetitorCount: integer(source.pendingCompetitorCount),
    processingComplete: source.processingComplete === true,
    articleTitle: text(source.articleTitle),
    articleStatus: text(source.articleStatus),
    articleUpdatedAt: text(source.articleUpdatedAt),
  };
};

const normalizeItem = (value: unknown): ContentWritingAutomationItem | null => {
  const source = isRecord(value) ? value : null;
  const status = text(source?.status) as ContentWritingAutomationItemStatus;
  if (!source || !text(source.id) || !text(source.articleId)
      || !['ready', 'claiming', 'writing', 'completed', 'blocked', 'cancelled'].includes(status)) {
    return null;
  }
  return {
    id: text(source.id),
    articleId: text(source.articleId),
    articleTitle: text(source.articleTitle),
    articleStatus: text(source.articleStatus),
    requestedBy: text(source.requestedBy),
    status,
    readinessSignature: text(source.readinessSignature),
    usableCompetitorCount: integer(source.usableCompetitorCount),
    pendingCompetitorCount: integer(source.pendingCompetitorCount),
    provider: text(source.provider),
    model: text(source.model),
    sessionId: nullableText(source.sessionId),
    sessionStatus: nullableText(source.sessionStatus),
    qualityScore: Number.isFinite(Number(source.qualityScore)) ? Number(source.qualityScore) : null,
    qualityPassed: typeof source.qualityPassed === 'boolean' ? source.qualityPassed : null,
    attemptCount: integer(source.attemptCount),
    maxAttempts: Math.max(1, integer(source.maxAttempts, 1)),
    readyAt: text(source.readyAt),
    eligibleAt: text(source.eligibleAt),
    startedAt: nullableText(source.startedAt),
    completedAt: nullableText(source.completedAt),
    lastErrorCode: nullableText(source.lastErrorCode),
    lastError: nullableText(source.lastError),
    failureClass: ['transient', 'waiting_input', 'terminal'].includes(text(source.failureClass))
      ? text(source.failureClass) as ContentWritingAutomationItem['failureClass']
      : null,
    recoveryCount: integer(source.recoveryCount),
    nextRecoveryAt: nullableText(source.nextRecoveryAt),
    resolvedBySessionId: nullableText(source.resolvedBySessionId),
    resolvedAt: nullableText(source.resolvedAt),
    updatedAt: text(source.updatedAt),
  };
};

const normalizeOverview = (value: unknown): ContentWritingAutomationOverview => {
  const source = isRecord(value) ? value : {};
  const state = isRecord(source.state) ? source.state : null;
  const globalBlocker = isRecord(source.globalBlocker) ? source.globalBlocker : null;
  const focus = isRecord(source.focus) ? source.focus : null;
  const focusState = text(focus?.state);
  return {
    schemaAvailable: source.schemaAvailable !== false,
    settings: normalizeSettings(source.settings),
    state: state ? {
      nextAllowedAt: text(state.nextAllowedAt),
      lastItemId: nullableText(state.lastItemId),
      lastSessionId: nullableText(state.lastSessionId),
      lastArticleId: nullableText(state.lastArticleId),
      lastOutcome: nullableText(state.lastOutcome),
      updatedAt: text(state.updatedAt),
    } : null,
    active: normalizeItem(source.active),
    lastItem: normalizeItem(source.lastItem),
    globalBlocker: globalBlocker ? {
      type: text(globalBlocker.type || globalBlocker.kind || globalBlocker.code),
      articleId: nullableText(globalBlocker.articleId || globalBlocker.article_id),
      articleTitle: text(globalBlocker.articleTitle || globalBlocker.article_title),
      status: text(globalBlocker.status),
      message: text(globalBlocker.message),
    } : null,
    focus: focus && ['idle', 'active', 'waiting_retry', 'needs_attention'].includes(focusState) ? {
      articleId: nullableText(focus.articleId),
      articleTitle: text(focus.articleTitle),
      articleVisible: focus.articleVisible !== false,
      state: focusState as AutomaticArticleFocus['state'],
      currentStage: nullableText(focus.currentStage),
      acquiredAt: nullableText(focus.acquiredAt),
      lastProgressAt: nullableText(focus.lastProgressAt),
      nextRetryAt: nullableText(focus.nextRetryAt),
      attemptCount: integer(focus.attemptCount),
      maxAttempts: integer(focus.maxAttempts),
      attemptMetric: ['gemini_execution', 'writing_execution'].includes(text(focus.attemptMetric))
        ? text(focus.attemptMetric) as AutomaticArticleFocus['attemptMetric']
        : 'worker_execution',
      recoveryCount: Math.max(0, integer(focus.recoveryCount)),
      maxRecoveries: Math.max(0, integer(focus.maxRecoveries, 3)),
      lastErrorCode: nullableText(focus.lastErrorCode),
      lastError: nullableText(focus.lastError),
      generation: integer(focus.generation),
      lastArticleId: nullableText(focus.lastArticleId),
      lastArticleTitle: text(focus.lastArticleTitle),
      lastReleaseReason: nullableText(focus.lastReleaseReason),
      releasedAt: nullableText(focus.releasedAt),
      canResume: focus.canResume === true,
    } : null,
    candidates: Array.isArray(source.candidates) ? source.candidates.flatMap(candidate => {
      if (!isRecord(candidate) || !text(candidate.articleId)) return [];
      const readiness = normalizeReadiness(candidate.readiness);
      if (!readiness) return [];
      return [{
        position: Math.max(1, integer(candidate.position, 1)),
        articleId: text(candidate.articleId),
        articleTitle: text(candidate.articleTitle),
        articleStatus: text(candidate.articleStatus),
        articleUpdatedAt: text(candidate.articleUpdatedAt),
        itemId: nullableText(candidate.itemId),
        itemStatus: text(candidate.itemStatus) || 'discovered_ready',
        eligibleAt: nullableText(candidate.eligibleAt),
        readiness,
      }];
    }) : [],
  };
};

const normalizeTaskInventory = (value: unknown): AutomationTaskInventoryItem[] => {
  if (!Array.isArray(value)) return [];
  const allowedStatuses = new Set<AutomationTaskStatus>([
    'running', 'scheduled', 'ready', 'unscheduled', 'failed',
  ]);
  const optionalInteger = (input: unknown): number | null => (
    input === null || input === undefined || input === '' || !Number.isFinite(Number(input))
      ? null
      : integer(input)
  );
  return value.flatMap(entry => {
    if (!isRecord(entry)) return [];
    const taskId = text(entry.taskId);
    const operationKey = text(entry.operationKey);
    const articleId = text(entry.articleId);
    const status = text(entry.status) as AutomationTaskStatus;
    if (!taskId || !operationKey || !articleId || !allowedStatuses.has(status)) return [];
    const requirements = Array.isArray(entry.requirements)
      ? entry.requirements.flatMap(requirement => {
        if (!isRecord(requirement)) return [];
        const code = text(requirement.code);
        const requirementState = text(requirement.state);
        if (!code || !['complete', 'missing', 'running', 'scheduled', 'blocked'].includes(requirementState)) {
          return [];
        }
        return [{
          code,
          state: requirementState as AutomationTaskRequirement['state'],
          current: optionalInteger(requirement.current),
          required: optionalInteger(requirement.required),
          articleId: nullableText(requirement.articleId),
          articleTitle: nullableText(requirement.articleTitle),
          stage: nullableText(requirement.stage),
        }];
      })
      : [];
    return [{
      taskId,
      operationKey,
      articleId,
      articleTitle: text(entry.articleTitle),
      articleStatus: text(entry.articleStatus),
      status,
      scheduled: entry.scheduled === true || status === 'scheduled',
      scheduleAt: nullableText(entry.scheduleAt),
      startedAt: nullableText(entry.startedAt),
      readyAt: nullableText(entry.readyAt),
      updatedAt: text(entry.updatedAt),
      sourceType: text(entry.sourceType),
      sourceId: nullableText(entry.sourceId),
      priorityRank: Math.max(1, integer(entry.priorityRank, 1)),
      reasonCode: nullableText(entry.reasonCode),
      reason: nullableText(entry.reason),
      attemptCount: integer(entry.attemptCount),
      maxAttempts: Math.max(1, integer(entry.maxAttempts, 1)),
      attemptMetric: ['gemini_execution', 'writing_execution'].includes(text(entry.attemptMetric))
        ? text(entry.attemptMetric) as AutomationTaskInventoryItem['attemptMetric']
        : 'worker_execution',
      missingFields: Array.isArray(entry.missingFields)
        ? entry.missingFields.map(text).filter(Boolean)
        : [],
      usableCompetitorCount: Math.max(0, integer(entry.usableCompetitorCount)),
      minimumCompetitorCount: Math.max(0, integer(entry.minimumCompetitorCount)),
      recoveryCount: Math.max(0, integer(entry.recoveryCount)),
      maxRecoveries: Math.max(0, integer(entry.maxRecoveries)),
      manualReview: entry.manualReview === true,
      runnable: entry.runnable === true || status === 'ready',
      currentBlocker: typeof entry.currentBlocker === 'boolean' ? entry.currentBlocker : null,
      blockerCategory: ['waiting_prerequisite', 'transient', 'permanent', 'resolved']
        .includes(text(entry.blockerCategory))
        ? text(entry.blockerCategory) as AutomationTaskInventoryItem['blockerCategory']
        : null,
      rootOperationKey: nullableText(entry.rootOperationKey),
      historicalErrorCode: nullableText(entry.historicalErrorCode),
      historicalError: nullableText(entry.historicalError),
      historicalResolvedAt: nullableText(entry.historicalResolvedAt),
      requirements,
      blockedByArticleId: nullableText(entry.blockedByArticleId),
      blockedByArticleTitle: nullableText(entry.blockedByArticleTitle),
      blockedByStage: nullableText(entry.blockedByStage),
      blockedByState: nullableText(entry.blockedByState),
      upstreamStage: nullableText(entry.upstreamStage),
      upstreamState: nullableText(entry.upstreamState),
    }];
  });
};

const requestAutomation = async (
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> => {
  const token = await getAuthenticatedApiToken();
  const response = await fetch('/api/content-writing/automation', {
    method: 'POST',
    headers: getAuthenticatedApiHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  const source = isRecord(payload) ? payload : {};
  if (!response.ok) {
    throw new Error(text(source.error) || `Automatic content-writing request failed (${response.status}).`);
  }
  return source;
};

export const loadAutomaticRecoverySchedule = async (
  signal?: AbortSignal,
): Promise<AutomaticRecoverySchedule> => {
  const payload = await requestAutomation({ action: 'recovery_status' }, signal);
  return normalizeAutomaticRecoverySchedule(payload.automaticRecovery);
};

export const loadContentWritingAutomationStatus = async (
  articleId?: string,
  options: { signal?: AbortSignal; draftOnly?: boolean } = {},
): Promise<ContentWritingAutomationStatus> => {
  const payload = await requestAutomation({
    action: 'status',
    ...(articleId ? { articleId } : {}),
    ...(options.draftOnly ? { draftOnly: true } : {}),
  }, options.signal);
  const article = isRecord(payload.article) ? payload.article : null;
  return {
    overview: normalizeOverview(payload.overview),
    taskInventory: normalizeTaskInventory(payload.taskInventory),
    taskScope: payload.taskScope === 'system' ? 'system' : 'accessible',
    automaticRecovery: normalizeAutomaticRecoverySchedule(payload.automaticRecovery),
    article: article ? {
      readiness: normalizeReadiness(article.readiness),
      item: normalizeItem(article.item),
      activeFullPipeline: isRecord(article.activeFullPipeline) ? {
        id: text(article.activeFullPipeline.id),
        status: text(article.activeFullPipeline.status),
        progress: isRecord(article.activeFullPipeline.progress) ? article.activeFullPipeline.progress : {},
        updatedAt: text(article.activeFullPipeline.updatedAt),
      } : null,
      hasCompletedContentWritingSession: article.hasCompletedContentWritingSession === true,
    } : null,
  };
};

const normalizeArticleSummary = (value: unknown): ContentWritingArticleSummary | null => {
  const source = isRecord(value) ? value : null;
  const articleId = text(source?.articleId);
  const state = text(source?.state) as ContentWritingArticleSummaryState;
  if (!source || !articleId || ![
    'queued',
    'writing',
    'waiting_prerequisites',
    'partial',
    'written',
    'written_quality_failed',
    'written_quality_passed',
    'applied',
    'failed',
    'cancelled',
  ].includes(state)) return null;
  const qualityScore = typeof source.qualityScore === 'number' && Number.isFinite(source.qualityScore)
    ? source.qualityScore
    : null;
  const qualityMinimumScore = typeof source.qualityMinimumScore === 'number'
    && Number.isFinite(source.qualityMinimumScore)
    ? source.qualityMinimumScore
    : null;
  const readinessSource = isRecord(source.workReadiness) ? source.workReadiness : null;
  const readinessState = text(readinessSource?.state);
  const workReadiness = readinessSource && [
    'awaiting_writing',
    'waiting_cleanup',
    'cleaning',
    'auditing',
    'ready',
    'partial',
    'needs_attention',
  ].includes(readinessState) ? {
      state: readinessState as ContentWritingWorkReadinessState,
      ready: readinessSource.ready === true,
      cleanupCurrent: readinessSource.cleanupCurrent === true,
      cleanupActive: readinessSource.cleanupActive === true,
      cleanupFailed: readinessSource.cleanupFailed === true,
      requiredAuditCount: integer(readinessSource.requiredAuditCount),
      completedAuditCount: integer(readinessSource.completedAuditCount),
      activeAuditCount: integer(readinessSource.activeAuditCount),
      failedAuditCount: integer(readinessSource.failedAuditCount),
    } : null;
  return {
    articleId,
    state,
    sessionId: nullableText(source.sessionId),
    sessionStatus: nullableText(source.sessionStatus),
    qualityScore,
    qualityMinimumScore,
    qualityPassed: typeof source.qualityPassed === 'boolean' ? source.qualityPassed : null,
    hasFullDraft: source.hasFullDraft === true,
    partialStepCount: integer(source.partialStepCount),
    appliedAt: nullableText(source.appliedAt),
    automaticApplicationStatus: nullableText(source.automaticApplicationStatus),
    workReadiness,
    usableCompetitorCount: integer(source.usableCompetitorCount),
    minimumCompetitorCount: normalizeContentWritingMinimumCompetitors(
      source.minimumCompetitorCount,
    ),
    errorCode: nullableText(source.errorCode),
    errorMessage: nullableText(source.errorMessage),
    updatedAt: text(source.updatedAt),
  };
};

export const loadContentWritingArticleSummaries = async (
  articleIds: string[],
  options: { signal?: AbortSignal } = {},
): Promise<Record<string, ContentWritingArticleSummary>> => {
  const normalizedIds = Array.from(new Set(articleIds.map(text).filter(Boolean)));
  if (normalizedIds.length === 0) return {};
  const chunks = Array.from(
    { length: Math.ceil(normalizedIds.length / 50) },
    (_value, index) => normalizedIds.slice(index * 50, (index + 1) * 50),
  );
  const payloads = await Promise.all(chunks.map(chunk => (
    requestAutomation({ action: 'summaries', articleIds: chunk }, options.signal)
  )));
  const summaries = payloads.flatMap(payload => (
    Array.isArray(payload.summaries) ? payload.summaries : []
  ));
  return Object.fromEntries(summaries.flatMap(value => {
    const summary = normalizeArticleSummary(value);
    return summary ? [[summary.articleId, summary]] : [];
  }));
};

const mutateItem = async (
  action: 'retry' | 'cancel',
  itemId: string,
): Promise<ContentWritingAutomationOverview> => {
  const payload = await requestAutomation({ action, itemId });
  return normalizeOverview(payload.overview);
};

export const retryContentWritingAutomationItem = (
  itemId: string,
): Promise<ContentWritingAutomationOverview> => mutateItem('retry', itemId);

export const cancelContentWritingAutomationItem = (
  itemId: string,
): Promise<ContentWritingAutomationOverview> => mutateItem('cancel', itemId);

export type RecoverableAutomationResult = {
  overview: ContentWritingAutomationOverview;
  requeued: {
    externalAnalysis: number;
    contentWriting: number;
    total: number;
  };
};

export const retryRecoverableAutomationFailures = async (
  options: { draftOnly?: boolean } = {},
): Promise<RecoverableAutomationResult> => {
  const payload = await requestAutomation({
    action: 'retry_recoverable',
    ...(options.draftOnly ? { draftOnly: true } : {}),
  });
  const requeued = isRecord(payload.requeued) ? payload.requeued : {};
  return {
    overview: normalizeOverview(payload.overview),
    requeued: {
      externalAnalysis: integer(requeued.externalAnalysis),
      contentWriting: integer(requeued.contentWriting),
      total: integer(requeued.total),
    },
  };
};

export const skipAutomaticArticleFocus = async (
  options: { draftOnly?: boolean; reason?: string } = {},
): Promise<ContentWritingAutomationOverview> => {
  const payload = await requestAutomation({
    action: 'focus_skip',
    reason: options.reason || 'administrator_skipped_focus',
    ...(options.draftOnly ? { draftOnly: true } : {}),
  });
  return normalizeOverview(payload.overview);
};

export const resumeAutomaticArticleFocus = async (
  articleId?: string | null,
  options: { draftOnly?: boolean } = {},
): Promise<ContentWritingAutomationOverview> => {
  const payload = await requestAutomation({
    action: 'focus_resume',
    ...(articleId ? { articleId } : {}),
    ...(options.draftOnly ? { draftOnly: true } : {}),
  });
  return normalizeOverview(payload.overview);
};

const READINESS_LABELS: Record<string, [string, string]> = {
  draft_status: ['حالة المقالة تسمح بالكتابة', 'Article status allows writing'],
  article_editor_empty: ['المحرر خالٍ من نص سابق', 'Article editor is empty'],
  article_title: ['عنوان المقالة', 'Article title'],
  primary_keyword: ['الكلمة المفتاحية الأساسية', 'Primary keyword'],
  alternative_keywords: ['الصيغ البديلة', 'Alternative keyword forms'],
  lsi_keywords: ['كلمات LSI', 'LSI keywords'],
  company_name: ['اسم الشركة', 'Company name'],
  'goal_context.pageType': ['نوع الصفحة', 'Page type'],
  'goal_context.objective': ['هدف الصفحة', 'Page objective'],
  'goal_context.audienceScope': ['نطاق الجمهور', 'Audience scope'],
  'goal_context.searchIntent': ['نية البحث', 'Search intent'],
  competitors: ['ثلاثة نصوص منافسة مؤهلة على الأقل', 'At least three qualified competitor texts'],
};

export const getContentWritingAutomationReadinessLabel = (
  code: string,
  isArabic: boolean,
): string => READINESS_LABELS[code]?.[isArabic ? 0 : 1] || code;

export const CONTENT_WRITING_AUTOMATION_READINESS_CODES = Object.keys(READINESS_LABELS);

export const getContentWritingAutomationProviderLabel = (
  provider: string,
  isArabic: boolean,
): string => {
  if (provider === 'geminiPaid') return isArabic ? 'Gemini المدفوع' : 'Gemini paid';
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'gemini') return isArabic ? 'Gemini المجاني' : 'Gemini free';
  return isArabic ? 'مزود الكتابة' : 'Writing provider';
};

export const getContentWritingAutomationErrorMessage = (
  value: string | null | undefined,
  isArabic: boolean,
): string => {
  const raw = text(value);
  if (!raw) return isArabic
    ? 'تعذر إكمال الكتابة التلقائية. افتح تفاصيل جلسة الكتابة للمراجعة.'
    : 'Automatic writing could not be completed. Open the writing session for details.';
  if (!isArabic) return raw;
  const normalized = raw.toLowerCase();
  if (normalized.includes('reservation expired') || normalized.includes('lease expired')) {
    return 'انتهت مهلة حجز المقالة قبل إنشاء جلسة الكتابة، وستُعاد المحاولة وفق الإعدادات.';
  }
  if (normalized.includes('manual writing') || normalized.includes('direct manual')) {
    return 'أُلغي الحجز التلقائي لأن طلب الكتابة اليدوي حصل على الأولوية.';
  }
  if (normalized.includes('full article workflow') || normalized.includes('full workflow')) {
    return 'أُلغي الحجز التلقائي لأن الإنشاء الشامل حصل على الأولوية.';
  }
  if (normalized.includes('cancel')) return 'أُوقفت جلسة الكتابة التلقائية قبل اكتمالها.';
  if (/^[\x00-\x7f\s\p{P}\p{N}]+$/u.test(raw)) {
    return 'تعذر إكمال الكتابة التلقائية. افتح تفاصيل جلسة الكتابة لمعرفة السبب وخيارات الاستئناف.';
  }
  return raw;
};
