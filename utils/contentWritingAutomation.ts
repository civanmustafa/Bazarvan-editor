import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi';

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
  updatedAt: string;
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
  globalBlocker: ContentWritingAutomationGlobalBlocker | null;
  candidates: ContentWritingAutomationCandidate[];
};

export type ContentWritingAutomationStatus = {
  overview: ContentWritingAutomationOverview;
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
    minimumCompetitors: Math.max(1, Math.min(5, integer(source.minimumCompetitors, 1))),
    requireCompetitorTerminalState: source.requireCompetitorTerminalState !== false,
    maxAttempts: Math.max(1, integer(source.maxAttempts, 3)),
    retryMinutes: Math.max(1, integer(source.retryMinutes, 30)),
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
    updatedAt: text(source.updatedAt),
  };
};

const normalizeOverview = (value: unknown): ContentWritingAutomationOverview => {
  const source = isRecord(value) ? value : {};
  const state = isRecord(source.state) ? source.state : null;
  const globalBlocker = isRecord(source.globalBlocker) ? source.globalBlocker : null;
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
    globalBlocker: globalBlocker ? {
      type: text(globalBlocker.type || globalBlocker.kind || globalBlocker.code),
      articleId: nullableText(globalBlocker.articleId || globalBlocker.article_id),
      articleTitle: text(globalBlocker.articleTitle || globalBlocker.article_title),
      status: text(globalBlocker.status),
      message: text(globalBlocker.message),
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

export const loadContentWritingAutomationStatus = async (
  articleId?: string,
  options: { signal?: AbortSignal } = {},
): Promise<ContentWritingAutomationStatus> => {
  const payload = await requestAutomation({
    action: 'status',
    ...(articleId ? { articleId } : {}),
  }, options.signal);
  const article = isRecord(payload.article) ? payload.article : null;
  return {
    overview: normalizeOverview(payload.overview),
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

const READINESS_LABELS: Record<string, [string, string]> = {
  draft_status: ['حالة المقالة تسمح بالكتابة', 'Article status allows writing'],
  article_title: ['عنوان المقالة', 'Article title'],
  primary_keyword: ['الكلمة المفتاحية الأساسية', 'Primary keyword'],
  alternative_keywords: ['الصيغ البديلة', 'Alternative keyword forms'],
  lsi_keywords: ['كلمات LSI', 'LSI keywords'],
  company_name: ['اسم الشركة', 'Company name'],
  'goal_context.pageType': ['نوع الصفحة', 'Page type'],
  'goal_context.objective': ['هدف الصفحة', 'Page objective'],
  'goal_context.audienceScope': ['نطاق الجمهور', 'Audience scope'],
  'goal_context.searchIntent': ['نية البحث', 'Search intent'],
  competitors: ['نص منافس صالح واحد على الأقل', 'At least one usable competitor text'],
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
