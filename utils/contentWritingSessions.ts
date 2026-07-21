import { getAuthenticatedApiHeaders, getAuthenticatedApiToken } from './authenticatedApi';

export type ContentWritingProvider = 'gemini' | 'geminiPaid' | 'openai';
export type ContentWritingSessionStatus =
  | 'queued'
  | 'running'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ContentWritingSession = {
  id: string;
  articleId: string;
  createdBy: string;
  provider: ContentWritingProvider;
  model: string;
  status: ContentWritingSessionStatus;
  idempotencyKey: string;
  templateRegistryVersion: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  contextSnapshot: Record<string, unknown>;
  progress: Record<string, unknown>;
  resultText?: string | null;
  conversationId: string | null;
  keySuffix: string | null;
  responseMetadata: Record<string, unknown>;
  lastErrorCode: string | null;
  lastError: string | null;
  attemptCount: number;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContentWritingMessage = {
  id: string;
  sequenceNumber: number;
  stage: 'instructions' | 'article_context' | 'generation_request' | 'assistant_result';
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type ContentWritingStepType =
  | 'outline'
  | 'section'
  | 'introduction'
  | 'conclusion'
  | 'faq'
  | 'final_review';

export type ContentWritingStepStatus = 'pending' | 'running' | 'completed' | 'failed';

export type ContentWritingStep = {
  id: string;
  sessionId: string;
  stepKey: string;
  stepType: ContentWritingStepType;
  ordinal: number;
  title: string;
  status: ContentWritingStepStatus;
  promptText?: string;
  outputText?: string | null;
  metadata: Record<string, unknown>;
  attemptCount: number;
  lastErrorCode: string | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContentWritingSessionDetail = {
  session: ContentWritingSession;
  messages: ContentWritingMessage[];
  steps: ContentWritingStep[];
};

export class ContentWritingRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload: Record<string, unknown>;

  constructor(response: Response, payload: Record<string, unknown>) {
    super(typeof payload.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : `Content writing request failed with HTTP ${response.status}.`);
    this.name = 'ContentWritingRequestError';
    this.status = response.status;
    this.code = typeof payload.code === 'string' ? payload.code : 'content_writing_request_failed';
    this.payload = payload;
  }
}

const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const toNullableText = (value: unknown): string | null => toText(value) || null;

const normalizeStatus = (value: unknown): ContentWritingSessionStatus => {
  const status = toText(value) as ContentWritingSessionStatus;
  return ['queued', 'running', 'retry_scheduled', 'completed', 'failed', 'cancelled'].includes(status)
    ? status
    : 'failed';
};

const normalizeProvider = (value: unknown): ContentWritingProvider => {
  if (value === 'geminiPaid' || value === 'openai') return value;
  return 'gemini';
};

const normalizeSession = (value: unknown): ContentWritingSession | null => {
  if (!isRecord(value) || !toText(value.id) || !toText(value.articleId)) return null;
  return {
    id: toText(value.id),
    articleId: toText(value.articleId),
    createdBy: toText(value.createdBy),
    provider: normalizeProvider(value.provider),
    model: toText(value.model),
    status: normalizeStatus(value.status),
    idempotencyKey: toText(value.idempotencyKey),
    templateRegistryVersion: Math.max(1, Number(value.templateRegistryVersion) || 1),
    estimatedInputTokens: Math.max(0, Number(value.estimatedInputTokens) || 0),
    maxInputTokens: Math.max(0, Number(value.maxInputTokens) || 0),
    contextSnapshot: isRecord(value.contextSnapshot) ? value.contextSnapshot : {},
    progress: isRecord(value.progress) ? value.progress : {},
    ...('resultText' in value ? { resultText: typeof value.resultText === 'string' ? value.resultText : null } : {}),
    conversationId: toNullableText(value.conversationId),
    keySuffix: toNullableText(value.keySuffix),
    responseMetadata: isRecord(value.responseMetadata) ? value.responseMetadata : {},
    lastErrorCode: toNullableText(value.lastErrorCode),
    lastError: toNullableText(value.lastError),
    attemptCount: Math.max(0, Number(value.attemptCount) || 0),
    cancelRequestedAt: toNullableText(value.cancelRequestedAt),
    startedAt: toNullableText(value.startedAt),
    completedAt: toNullableText(value.completedAt),
    createdAt: toText(value.createdAt),
    updatedAt: toText(value.updatedAt),
  };
};

const normalizeMessage = (value: unknown): ContentWritingMessage | null => {
  if (!isRecord(value) || !toText(value.id) || !toText(value.content)) return null;
  const stage = toText(value.stage) as ContentWritingMessage['stage'];
  const role = toText(value.role) as ContentWritingMessage['role'];
  if (!['instructions', 'article_context', 'generation_request', 'assistant_result'].includes(stage)) return null;
  if (!['system', 'user', 'assistant'].includes(role)) return null;
  return {
    id: toText(value.id),
    sequenceNumber: Math.max(1, Number(value.sequenceNumber) || 1),
    stage,
    role,
    content: String(value.content),
    createdAt: toText(value.createdAt),
  };
};

const normalizeStep = (value: unknown): ContentWritingStep | null => {
  if (!isRecord(value) || !toText(value.id) || !toText(value.stepKey)) return null;
  const stepType = toText(value.stepType) as ContentWritingStepType;
  const status = toText(value.status) as ContentWritingStepStatus;
  if (!['outline', 'section', 'introduction', 'conclusion', 'faq', 'final_review'].includes(stepType)) return null;
  if (!['pending', 'running', 'completed', 'failed'].includes(status)) return null;
  return {
    id: toText(value.id),
    sessionId: toText(value.sessionId),
    stepKey: toText(value.stepKey),
    stepType,
    ordinal: Math.max(1, Number(value.ordinal) || 1),
    title: toText(value.title),
    status,
    ...('promptText' in value ? { promptText: String(value.promptText || '') } : {}),
    ...('outputText' in value ? { outputText: typeof value.outputText === 'string' ? value.outputText : null } : {}),
    metadata: isRecord(value.metadata) ? value.metadata : {},
    attemptCount: Math.max(0, Number(value.attemptCount) || 0),
    lastErrorCode: toNullableText(value.lastErrorCode),
    lastError: toNullableText(value.lastError),
    startedAt: toNullableText(value.startedAt),
    completedAt: toNullableText(value.completedAt),
    createdAt: toText(value.createdAt),
    updatedAt: toText(value.updatedAt),
  };
};

const requestContentWriting = async (body: Record<string, unknown>): Promise<Record<string, any>> => {
  const token = await getAuthenticatedApiToken();
  const response = await fetch('/api/content-writing', {
    method: 'POST',
    headers: getAuthenticatedApiHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  const normalized = isRecord(payload) ? payload : {};
  if (!response.ok) throw new ContentWritingRequestError(response, normalized);
  return normalized;
};

export const createContentWritingIdempotencyKey = (articleId: string): string => {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `content:${articleId}:${randomPart}`;
};

export const isContentWritingSessionActive = (session: ContentWritingSession | null | undefined): boolean => (
  Boolean(session && ['queued', 'running', 'retry_scheduled'].includes(session.status))
);

export const startContentWritingSession = async (options: {
  articleId: string;
  provider: ContentWritingProvider;
  model?: string;
  idempotencyKey?: string;
}): Promise<{ created: boolean; session: ContentWritingSession }> => {
  const payload = await requestContentWriting({
    action: 'start',
    articleId: options.articleId,
    provider: options.provider,
    ...(options.model ? { model: options.model } : {}),
    idempotencyKey: options.idempotencyKey || createContentWritingIdempotencyKey(options.articleId),
  });
  const session = normalizeSession(payload.session);
  if (!session) throw new Error('Content writing API returned an invalid session.');
  return { created: payload.created === true, session };
};

export const getContentWritingSessionDetail = async (
  sessionId: string,
  options: { includeMessages?: boolean; includeSteps?: boolean; includeStepContent?: boolean } = {},
): Promise<ContentWritingSessionDetail> => {
  const payload = await requestContentWriting({
    action: 'get',
    sessionId,
    includeMessages: options.includeMessages === true,
    includeSteps: options.includeSteps !== false,
    includeStepContent: options.includeStepContent === true,
  });
  const session = normalizeSession(payload.session);
  if (!session) throw new Error('Content writing API returned an invalid session.');
  return {
    session,
    messages: Array.isArray(payload.messages)
      ? payload.messages.map(normalizeMessage).filter((message): message is ContentWritingMessage => Boolean(message))
      : [],
    steps: Array.isArray(payload.steps)
      ? payload.steps.map(normalizeStep).filter((step): step is ContentWritingStep => Boolean(step))
      : [],
  };
};

export const listContentWritingSessions = async (
  articleId: string,
  limit = 20,
): Promise<ContentWritingSession[]> => {
  const payload = await requestContentWriting({ action: 'list', articleId, limit });
  return Array.isArray(payload.sessions)
    ? payload.sessions.map(normalizeSession).filter((session): session is ContentWritingSession => Boolean(session))
    : [];
};

export const cancelContentWritingSession = async (
  sessionId: string,
): Promise<ContentWritingSession> => {
  const payload = await requestContentWriting({ action: 'cancel', sessionId });
  const session = normalizeSession(payload.session);
  if (!session) throw new Error('Content writing API returned an invalid cancellation response.');
  return session;
};

export const resumeContentWritingSession = async (
  sessionId: string,
): Promise<ContentWritingSession> => {
  const payload = await requestContentWriting({ action: 'resume', sessionId });
  const session = normalizeSession(payload.session);
  if (!session) throw new Error('Content writing API returned an invalid resume response.');
  return session;
};
