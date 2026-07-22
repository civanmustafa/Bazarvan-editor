import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

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
  article_id: string;
  created_by: string;
  provider: ContentWritingProvider;
  model: string;
  status: ContentWritingSessionStatus;
  execution_mode: 'api' | 'external';
  idempotency_key: string;
  template_registry_version: number;
  estimated_input_tokens: number;
  max_input_tokens: number;
  input_hash: string;
  context_snapshot: Record<string, unknown>;
  progress: Record<string, unknown>;
  result_text: string | null;
  conversation_id: string | null;
  key_suffix: string | null;
  response_metadata: Record<string, unknown>;
  last_error_code: string | null;
  last_error: string | null;
  attempt_count: number;
  next_attempt_at: string;
  locked_by: string | null;
  locked_at: string | null;
  lease_expires_at: string | null;
  cancel_requested_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  applied_at: string | null;
  applied_by: string | null;
  application_count: number;
  created_at: string;
  updated_at: string;
};

export type ContentWritingSessionSummary = Omit<ContentWritingSession, 'input_hash' | 'result_text'>;

export type ContentWritingMessage = {
  id: string;
  session_id: string;
  sequence_number: number;
  stage: 'instructions' | 'article_context' | 'generation_request' | 'assistant_result';
  role: 'system' | 'user' | 'assistant';
  content: string;
  created_at: string;
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
  session_id: string;
  step_key: string;
  step_type: ContentWritingStepType;
  ordinal: number;
  title: string;
  status: ContentWritingStepStatus;
  prompt_text?: string;
  output_text?: string | null;
  metadata: JsonObject;
  attempt_count: number;
  last_error_code: string | null;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const firstRow = <T>(value: unknown): T | null => {
  if (Array.isArray(value)) return (value[0] as T | undefined) || null;
  return isRecord(value) ? value as T : null;
};

const throwServiceError = (operation: string, error: any): never => {
  const details = [error?.message, error?.details, error?.hint].filter(Boolean).join(' | ');
  throw new Error(`Content writing ${operation} failed: ${details || 'Unknown database error.'}`);
};

export const createContentWritingSession = async (input: {
  articleId: string;
  createdBy: string;
  provider: ContentWritingProvider;
  model: string;
  idempotencyKey: string;
  templateRegistryVersion: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  inputHash: string;
  contextSnapshot: JsonObject;
  messages: Array<{ content: string }>;
}): Promise<{ created: boolean; session: ContentWritingSession }> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'create_content_writing_session',
    {
      p_article_id: input.articleId,
      p_created_by: input.createdBy,
      p_provider: input.provider,
      p_model: input.model,
      p_idempotency_key: input.idempotencyKey,
      p_template_registry_version: input.templateRegistryVersion,
      p_estimated_input_tokens: input.estimatedInputTokens,
      p_max_input_tokens: input.maxInputTokens,
      p_input_hash: input.inputHash,
      p_context_snapshot: input.contextSnapshot,
      p_messages: input.messages,
    },
  );
  if (error) throwServiceError('session creation', error);
  const source = isRecord(data) ? data : {};
  const session = isRecord(source.session) ? source.session as ContentWritingSession : null;
  if (!session?.id) throw new Error('Content writing session creation returned no session.');
  return { created: source.created === true, session };
};

export const createCompletedExternalContentWritingSession = async (input: {
  articleId: string;
  createdBy: string;
  externalProvider: 'chatgpt' | 'gemini';
  idempotencyKey: string;
  templateRegistryVersion: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  inputHash: string;
  contextSnapshot: JsonObject;
  messages: Array<{ content: string }>;
  resultText: string;
}): Promise<{ created: boolean; session: ContentWritingSession }> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'record_external_content_writing_result',
    {
      p_article_id: input.articleId,
      p_created_by: input.createdBy,
      p_external_provider: input.externalProvider,
      p_idempotency_key: input.idempotencyKey,
      p_template_registry_version: input.templateRegistryVersion,
      p_estimated_input_tokens: input.estimatedInputTokens,
      p_max_input_tokens: input.maxInputTokens,
      p_input_hash: input.inputHash,
      p_context_snapshot: input.contextSnapshot,
      p_messages: input.messages,
      p_result_text: input.resultText,
    },
  );
  if (error) throwServiceError('external result creation', error);
  const source = isRecord(data) ? data : {};
  const session = isRecord(source.session) ? source.session as ContentWritingSession : null;
  if (!session?.id) throw new Error('External content writing result returned no session.');
  return { created: source.created === true, session };
};

export const claimNextContentWritingSession = async (options: {
  workerId: string;
  leaseSeconds: number;
}): Promise<ContentWritingSession | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'claim_next_content_writing_session',
    {
      p_worker_id: options.workerId,
      p_lease_seconds: options.leaseSeconds,
    },
  );
  if (error) throwServiceError('session claim', error);
  return firstRow<ContentWritingSession>(data);
};

export const heartbeatContentWritingSession = async (options: {
  sessionId: string;
  workerId: string;
  leaseSeconds: number;
}): Promise<{ owned: boolean; cancelRequested: boolean; status: string }> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'heartbeat_content_writing_session',
    {
      p_session_id: options.sessionId,
      p_worker_id: options.workerId,
      p_lease_seconds: options.leaseSeconds,
    },
  );
  if (error) throwServiceError('session heartbeat', error);
  const source = isRecord(data) ? data : {};
  return {
    owned: source.owned === true,
    cancelRequested: source.cancelRequested === true,
    status: typeof source.status === 'string' ? source.status : '',
  };
};

export const updateContentWritingProgress = async (options: {
  sessionId: string;
  workerId: string;
  progress: JsonObject;
}): Promise<boolean> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'update_content_writing_progress',
    {
      p_session_id: options.sessionId,
      p_worker_id: options.workerId,
      p_progress: options.progress,
    },
  );
  if (error) throwServiceError('progress update', error);
  return data === true;
};

export const getContentWritingMessages = async (
  sessionId: string,
): Promise<ContentWritingMessage[]> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('content_writing_messages')
    .select('id,session_id,sequence_number,stage,role,content,created_at')
    .eq('session_id', sessionId)
    .order('sequence_number', { ascending: true });
  if (error) throwServiceError('message read', error);
  return (data || []) as ContentWritingMessage[];
};

export const getContentWritingSteps = async (
  sessionId: string,
  options: { includeContent?: boolean; includeMetadata?: boolean } = {},
): Promise<ContentWritingStep[]> => {
  const columns = [
    'id',
    'session_id',
    'step_key',
    'step_type',
    'ordinal',
    'title',
    'status',
    ...(options.includeContent ? ['prompt_text', 'output_text'] : []),
    ...(options.includeMetadata ? ['metadata'] : []),
    'attempt_count',
    'last_error_code',
    'last_error',
    'started_at',
    'completed_at',
    'created_at',
    'updated_at',
  ];
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('content_writing_steps')
    .select(columns.join(','))
    .eq('session_id', sessionId)
    .order('ordinal', { ascending: true });
  if (error) throwServiceError('step read', error);
  const rows = Array.isArray(data) ? data as unknown as JsonObject[] : [];
  return rows.map(row => ({
    ...row,
    metadata: isRecord(row.metadata) ? row.metadata : {},
  })) as unknown as ContentWritingStep[];
};

export const ensureContentWritingStep = async (options: {
  sessionId: string;
  workerId: string;
  stepKey: string;
  stepType: ContentWritingStepType;
  ordinal: number;
  title: string;
  metadata?: JsonObject;
}): Promise<ContentWritingStep | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'ensure_content_writing_step',
    {
      p_session_id: options.sessionId,
      p_worker_id: options.workerId,
      p_step_key: options.stepKey,
      p_step_type: options.stepType,
      p_ordinal: options.ordinal,
      p_title: options.title,
      p_metadata: options.metadata || {},
    },
  );
  if (error) throwServiceError('step preparation', error);
  return firstRow<ContentWritingStep>(data);
};

export const startContentWritingStep = async (options: {
  sessionId: string;
  workerId: string;
  stepKey: string;
  promptText: string;
}): Promise<ContentWritingStep | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'start_content_writing_step',
    {
      p_session_id: options.sessionId,
      p_worker_id: options.workerId,
      p_step_key: options.stepKey,
      p_prompt_text: options.promptText,
    },
  );
  if (error) throwServiceError('step start', error);
  return firstRow<ContentWritingStep>(data);
};

export const completeContentWritingStep = async (options: {
  sessionId: string;
  workerId: string;
  stepKey: string;
  outputText: string;
  metadata?: JsonObject;
}): Promise<ContentWritingStep | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'complete_content_writing_step',
    {
      p_session_id: options.sessionId,
      p_worker_id: options.workerId,
      p_step_key: options.stepKey,
      p_output_text: options.outputText,
      p_metadata: options.metadata || {},
    },
  );
  if (error) throwServiceError('step completion', error);
  return firstRow<ContentWritingStep>(data);
};

export const failContentWritingStep = async (options: {
  sessionId: string;
  workerId: string;
  stepKey: string;
  errorCode: string;
  errorMessage: string;
  outputText?: string;
  metadata?: JsonObject;
}): Promise<ContentWritingStep | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'fail_content_writing_step',
    {
      p_session_id: options.sessionId,
      p_worker_id: options.workerId,
      p_step_key: options.stepKey,
      p_error_code: options.errorCode,
      p_error_message: options.errorMessage,
      p_output_text: options.outputText || null,
      p_metadata: options.metadata || {},
    },
  );
  if (error) throwServiceError('step failure', error);
  return firstRow<ContentWritingStep>(data);
};

export const completeContentWritingSession = async (options: {
  sessionId: string;
  workerId: string;
  resultText: string;
  model: string;
  conversationId?: string;
  keySuffix?: string;
  responseMetadata?: JsonObject;
  progress: JsonObject;
}): Promise<ContentWritingSession | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'complete_content_writing_session',
    {
      p_session_id: options.sessionId,
      p_worker_id: options.workerId,
      p_result_text: options.resultText,
      p_model: options.model,
      p_conversation_id: options.conversationId || null,
      p_key_suffix: options.keySuffix || null,
      p_response_metadata: options.responseMetadata || {},
      p_progress: options.progress,
    },
  );
  if (error) throwServiceError('session completion', error);
  return firstRow<ContentWritingSession>(data);
};

export const failContentWritingSession = async (options: {
  sessionId: string;
  workerId: string;
  errorCode: string;
  errorMessage: string;
  responseMetadata?: JsonObject;
  progress: JsonObject;
}): Promise<ContentWritingSession | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'fail_content_writing_session',
    {
      p_session_id: options.sessionId,
      p_worker_id: options.workerId,
      p_error_code: options.errorCode,
      p_error_message: options.errorMessage,
      p_response_metadata: options.responseMetadata || {},
      p_progress: options.progress,
    },
  );
  if (error) throwServiceError('session failure', error);
  return firstRow<ContentWritingSession>(data);
};

export const getContentWritingSession = async (
  sessionId: string,
): Promise<ContentWritingSession | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('content_writing_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throwServiceError('session read', error);
  return data as ContentWritingSession | null;
};

export const listContentWritingSessions = async (options: {
  articleId: string;
  userId?: string;
  limit?: number;
}): Promise<ContentWritingSessionSummary[]> => {
  let query = getExternalAnalysisSupabaseAdmin()
    .from('content_writing_sessions')
    .select([
      'id',
      'article_id',
      'created_by',
      'provider',
      'model',
      'status',
      'execution_mode',
      'idempotency_key',
      'template_registry_version',
      'estimated_input_tokens',
      'max_input_tokens',
      'context_snapshot',
      'progress',
      'conversation_id',
      'key_suffix',
      'response_metadata',
      'last_error_code',
      'last_error',
      'attempt_count',
      'next_attempt_at',
      'locked_by',
      'locked_at',
      'lease_expires_at',
      'cancel_requested_at',
      'started_at',
      'completed_at',
      'applied_at',
      'applied_by',
      'application_count',
      'created_at',
      'updated_at',
    ].join(','))
    .eq('article_id', options.articleId)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(options.limit || 20, 50)));
  if (options.userId) query = query.eq('created_by', options.userId);
  const { data, error } = await query;
  if (error) throwServiceError('session list', error);
  return (data || []) as unknown as ContentWritingSessionSummary[];
};

export const cancelContentWritingSession = async (options: {
  sessionId: string;
  requestedBy: string;
}): Promise<ContentWritingSession | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'request_content_writing_session_cancel',
    {
      p_session_id: options.sessionId,
      p_requested_by: options.requestedBy,
    },
  );
  if (error) throwServiceError('session cancellation', error);
  return firstRow<ContentWritingSession>(data);
};

export const resumeContentWritingSession = async (options: {
  sessionId: string;
  requestedBy: string;
}): Promise<ContentWritingSession | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'resume_content_writing_session',
    {
      p_session_id: options.sessionId,
      p_requested_by: options.requestedBy,
    },
  );
  if (error) throwServiceError('session resume', error);
  return firstRow<ContentWritingSession>(data);
};

export const recordContentWritingApplication = async (options: {
  sessionId: string;
  appliedBy: string;
}): Promise<ContentWritingSession | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'record_content_writing_application',
    {
      p_session_id: options.sessionId,
      p_applied_by: options.appliedBy,
    },
  );
  if (error) throwServiceError('application recording', error);
  return firstRow<ContentWritingSession>(data);
};
