import { createHash } from 'node:crypto';
import {
  GEMINI_FREE_MODEL_VALUES,
  GEMINI_PAID_MODEL_VALUES,
  normalizeGeminiFreeModelId,
  normalizeGeminiPaidModelId,
  uniqueModelIds,
} from '../constants/modelRegistry';
import {
  CONTENT_WRITING_TEMPLATE_FIELDS,
  renderContentWritingTemplate,
  type ContentWritingTemplateSet,
} from '../constants/contentWriting';
import {
  buildContentWritingQualityContract,
  normalizeContentWritingQualityConfiguration,
  type ContentWritingQualityConfiguration,
} from '../constants/contentWritingQuality';
import {
  SETTINGS_REGISTRY_VERSION,
  normalizeSystemSettingsMap,
} from '../constants/settingsRegistry';
import {
  buildContentWritingPromptBundle,
  estimateContentWritingInputTokens,
  getContentWritingCompetitorsFromMetadata,
  normalizeContentWritingCompetitors,
  type ContentWritingArticleInput,
  type ContentWritingCompetitorInput,
  type ContentWritingPromptBundle,
  type ContentWritingPromptMessage,
} from '../utils/contentWritingContext';
import { normalizeGoalContext } from '../utils/goalContext';
import { CONTENT_WRITING_WORKFLOW_VERSION } from '../utils/contentWritingWorkflow';
import {
  aiExecutionEngine,
  sanitizeAiExecutionResult,
  type AiExecutionProgress,
} from './aiExecutionEngine';
import { readAiProviderCapabilities } from './aiProviderCapabilities';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import { executeOpenAiRequest } from './openAiExecutionEngine';
import {
  createCompletedExternalContentWritingSession,
  createContentWritingSession,
  type ContentWritingMessage,
  type ContentWritingProvider,
  type ContentWritingSession,
} from './contentWritingSessionService';

type JsonObject = Record<string, unknown>;

type ArticleRow = {
  id: string;
  title: string | null;
  plain_text: string | null;
  keywords: unknown;
  goal_context: unknown;
  metadata: unknown;
  article_language: string | null;
  updated_at: string;
};

type CompetitorRow = {
  id: string;
  position: number;
  source_url: string | null;
  canonical_url: string | null;
  title: string | null;
  content_text: string | null;
  status: string;
};

export class ContentWritingEngineError extends Error {
  status: number;
  code: string;
  details?: JsonObject;

  constructor(options: { message: string; status?: number; code?: string; details?: JsonObject }) {
    super(options.message);
    this.name = 'ContentWritingEngineError';
    this.status = options.status || 400;
    this.code = options.code || 'content_writing_request_failed';
    this.details = options.details;
  }
}

export type QueuedContentWritingSession = {
  created: boolean;
  reusedActive?: boolean;
  session: ContentWritingSession;
};

export type ContentWritingExecutionResult = {
  ok: boolean;
  status: number;
  text: string;
  model: string;
  conversationId?: string;
  keySuffix?: string;
  metadata: JsonObject;
  errorCode?: string;
  errorMessage?: string;
};

export type ContentWritingTurnHistory = {
  role: 'user' | 'assistant';
  content: string;
};

export type PreparedContentWritingConversation = {
  article: {
    id: string;
    title: string;
    language: string;
    updatedAt: string;
  };
  messages: ContentWritingPromptMessage[];
  inputHash: string;
  templateRegistryVersion: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  contextSnapshot: JsonObject;
  allowModelFallback: boolean;
  qualityConfiguration: ContentWritingQualityConfiguration;
  qualityContract: string;
};

const isRecord = (value: unknown): value is JsonObject => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const normalizeInputRecord = (value: unknown): JsonObject => isRecord(value) ? value : {};

const getContentWritingSettings = async (): Promise<{
  templates: ContentWritingTemplateSet;
  maxInputTokens: number;
  allowModelFallback: boolean;
  qualityConfiguration: ContentWritingQualityConfiguration;
}> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('app_settings')
    .select('value')
    .eq('key', 'ai')
    .maybeSingle();
  if (error && error.code !== '42P01') throw error;
  const ai = normalizeSystemSettingsMap({ ai: normalizeInputRecord(data?.value) }).ai;
  return {
    templates: {
      instructions: String(ai[CONTENT_WRITING_TEMPLATE_FIELDS.instructions] || ''),
      articleContext: String(ai[CONTENT_WRITING_TEMPLATE_FIELDS.articleContext] || ''),
      generationRequest: String(ai[CONTENT_WRITING_TEMPLATE_FIELDS.generationRequest] || ''),
    },
    maxInputTokens: Number(ai.contentWritingMaxInputTokens),
    allowModelFallback: ai.geminiFreeModelFallbackEnabled !== false,
    qualityConfiguration: normalizeContentWritingQualityConfiguration({
      policyVersion: ai.contentWritingQualityPolicyVersion,
      minimumScore: ai.contentWritingMinimumQualityScore,
      maxRepairPasses: ai.contentWritingMaxRepairPasses,
    }),
  };
};

const readArticleInput = async (articleId: string): Promise<{
  article: ArticleRow;
  input: ContentWritingArticleInput;
}> => {
  const supabase = getExternalAnalysisSupabaseAdmin();
  const [articleResult, competitorResult] = await Promise.all([
    supabase
      .from('articles')
      .select('id,title,plain_text,keywords,goal_context,metadata,article_language,updated_at')
      .eq('id', articleId)
      .maybeSingle(),
    supabase
      .from('article_competitors')
      .select('id,position,source_url,canonical_url,title,content_text,status')
      .eq('article_id', articleId)
      .order('position', { ascending: true }),
  ]);
  if (articleResult.error) throw articleResult.error;
  if (competitorResult.error) throw competitorResult.error;
  if (!articleResult.data) {
    throw new ContentWritingEngineError({
      message: 'Article was not found.',
      status: 404,
      code: 'article_not_found',
    });
  }

  const article = articleResult.data as ArticleRow;
  const metadataCompetitors = getContentWritingCompetitorsFromMetadata(article.metadata);
  const databaseCompetitors = normalizeContentWritingCompetitors(
    ((competitorResult.data || []) as CompetitorRow[])
      .filter(row => row.status === 'completed' && Boolean(toText(row.content_text)))
      .map(row => ({
        id: row.id,
        position: row.position,
        title: row.title || '',
        url: row.canonical_url || row.source_url || '',
        content: row.content_text || '',
      })),
  );
  const competitorsByPosition = new Map<number, ContentWritingCompetitorInput>();
  databaseCompetitors.forEach((competitor, index) => {
    competitorsByPosition.set(competitor.position || index + 1, competitor);
  });
  metadataCompetitors.forEach((competitor, index) => {
    const position = competitor.position || index + 1;
    const databaseCompetitor = competitorsByPosition.get(position);
    competitorsByPosition.set(position, {
      ...databaseCompetitor,
      ...competitor,
      id: competitor.id || databaseCompetitor?.id,
      title: competitor.title || databaseCompetitor?.title,
      url: competitor.url || databaseCompetitor?.url,
      content: competitor.content || databaseCompetitor?.content || '',
      position,
    });
  });

  return {
    article,
    input: {
      articleId: article.id,
      title: toText(article.title),
      language: article.article_language === 'en' ? 'en' : 'ar',
      articleText: typeof article.plain_text === 'string' ? article.plain_text : '',
      keywords: normalizeInputRecord(article.keywords),
      goalContext: normalizeInputRecord(article.goal_context),
      competitors: Array.from(competitorsByPosition.values())
        .sort((left, right) => (left.position || 0) - (right.position || 0)),
    },
  };
};

const getAllowedGeminiModels = (provider: ContentWritingProvider): string[] => uniqueModelIds([
  ...(provider === 'geminiPaid' ? GEMINI_PAID_MODEL_VALUES : GEMINI_FREE_MODEL_VALUES),
  ...String(process.env.GEMINI_ALLOWED_MODELS || '').split(/[\n,;]+/),
]);

const selectProviderModel = async (
  provider: ContentWritingProvider,
  requestedModel?: string,
): Promise<string> => {
  const capabilities = await readAiProviderCapabilities();
  const capability = capabilities.providers[provider];
  if (!capability.enabled) {
    throw new ContentWritingEngineError({
      message: `${provider} is disabled by the system administrator.`,
      status: 403,
      code: 'AI_PROVIDER_DISABLED',
      details: { provider },
    });
  }
  if (!capability.configured) {
    throw new ContentWritingEngineError({
      message: `${provider} is enabled but no server API key is configured.`,
      status: 503,
      code: 'AI_PROVIDER_NOT_CONFIGURED',
      details: { provider },
    });
  }

  const candidate = toText(requestedModel) || capability.model;
  if (provider === 'gemini') {
    return normalizeGeminiFreeModelId(candidate, getAllowedGeminiModels(provider));
  }
  if (provider === 'geminiPaid') {
    return normalizeGeminiPaidModelId(candidate, getAllowedGeminiModels(provider));
  }
  const allowed = new Set([
    capability.model,
    process.env.OPENAI_MODEL?.trim(),
    ...String(process.env.OPENAI_ALLOWED_MODELS || '').split(/[\n,;]+/).map(value => value.trim()),
  ].filter(Boolean));
  return candidate && allowed.has(candidate) ? candidate : capability.model;
};

const createInputHash = (values: readonly string[]): string => (
  createHash('sha256').update(values.join('\n\u0000\n'), 'utf8').digest('hex')
);

const assertContentWritingBundleReady = (bundle: ContentWritingPromptBundle): void => {
  if (bundle.readinessIssues.length > 0) {
    throw new ContentWritingEngineError({
      message: 'Content writing prerequisites are incomplete.',
      status: 422,
      code: 'content_writing_prerequisites_missing',
      details: { readinessIssues: bundle.readinessIssues },
    });
  }
  if (bundle.templateIssues.length > 0) {
    throw new ContentWritingEngineError({
      message: 'One or more content writing prompt templates are invalid.',
      status: 422,
      code: 'content_writing_templates_invalid',
      details: { templateIssues: bundle.templateIssues },
    });
  }
  if (bundle.exceedsInputBudget) {
    throw new ContentWritingEngineError({
      message: 'The complete article context exceeds the configured content writing input budget.',
      status: 413,
      code: 'content_writing_input_too_large',
      details: {
        estimatedInputTokens: bundle.estimatedInputTokens,
        maxInputTokens: bundle.maxInputTokens,
      },
    });
  }
};

export const prepareContentWritingConversation = async (
  articleId: string,
): Promise<PreparedContentWritingConversation> => {
  const [articleSource, settings] = await Promise.all([
    readArticleInput(articleId),
    getContentWritingSettings(),
  ]);
  const bundle = buildContentWritingPromptBundle(articleSource.input, {
    templates: settings.templates,
    maxInputTokens: settings.maxInputTokens,
  });
  assertContentWritingBundleReady(bundle);
  const normalizedGoalContext = normalizeGoalContext(articleSource.input.goalContext);
  const qualityConfiguration = settings.qualityConfiguration;
  const qualityContract = buildContentWritingQualityContract({
    configuration: qualityConfiguration,
    language: articleSource.input.language,
    goalContext: normalizedGoalContext,
  });
  const qualityContractHeading = articleSource.input.language === 'en'
    ? 'Mandatory quality criteria for this session:'
    : 'معايير الجودة الملزمة لهذه الجلسة:';
  const messages = bundle.messages.map(message => message.stage === 'generationRequest'
    ? { ...message, content: `${message.content}\n\n${qualityContractHeading}\n${qualityContract}` }
    : message);
  const estimatedInputTokens = estimateContentWritingInputTokens(
    messages.map(message => message.content).join('\n\n'),
  );
  if (estimatedInputTokens > bundle.maxInputTokens) {
    throw new ContentWritingEngineError({
      message: 'The complete article context exceeds the configured content writing input budget.',
      status: 413,
      code: 'content_writing_input_too_large',
      details: {
        estimatedInputTokens,
        maxInputTokens: bundle.maxInputTokens,
      },
    });
  }
  const qualityInput = {
    keywords: {
      primary: toText(articleSource.input.keywords.primary),
      secondaries: Array.isArray(articleSource.input.keywords.secondaries)
        ? articleSource.input.keywords.secondaries.map(toText).filter(Boolean)
        : [],
      company: toText(articleSource.input.keywords.company),
      lsi: Array.isArray(articleSource.input.keywords.lsi)
        ? articleSource.input.keywords.lsi.map(toText).filter(Boolean)
        : [],
    },
    goalContext: normalizedGoalContext,
  };
  const compactArticleContextBase = renderContentWritingTemplate(
    settings.templates.articleContext,
    {
      ...bundle.variables,
      competitors_json: JSON.stringify({
        status: 'indexed_separately',
        note: 'Use the persisted competitor knowledge index and the source excerpts supplied for the current step.',
      }, null, 2),
    },
  ).text;

  return {
    article: {
      id: articleSource.article.id,
      title: toText(articleSource.article.title),
      language: articleSource.input.language,
      updatedAt: articleSource.article.updated_at,
    },
    messages,
    inputHash: createInputHash(messages.map(message => message.content)),
    templateRegistryVersion: SETTINGS_REGISTRY_VERSION,
    estimatedInputTokens,
    maxInputTokens: bundle.maxInputTokens,
    contextSnapshot: {
      workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
      article: {
        id: articleSource.article.id,
        title: articleSource.article.title,
        language: articleSource.input.language,
        updatedAt: articleSource.article.updated_at,
      },
      competitors: bundle.competitors.map(competitor => ({
        id: competitor.id || null,
        position: competitor.position || null,
        title: competitor.title || null,
        url: competitor.url || null,
        contentLength: competitor.content.length,
      })),
      competitorChunks: bundle.competitorChunks,
      compactArticleContextBase,
      qualityPolicyVersion: qualityConfiguration.policyVersion,
      qualityConfiguration,
      qualityContract,
      qualityInput,
    },
    allowModelFallback: settings.allowModelFallback,
    qualityConfiguration,
    qualityContract,
  };
};

export const recordExternalContentWritingResult = async (input: {
  articleId: string;
  createdBy: string;
  externalProvider: 'chatgpt' | 'gemini';
  idempotencyKey: string;
  preparedInputHash: string;
  resultText: string;
}): Promise<QueuedContentWritingSession> => {
  const conversation = await prepareContentWritingConversation(input.articleId);
  if (conversation.inputHash !== input.preparedInputHash) {
    throw new ContentWritingEngineError({
      message: 'The article context changed after the external conversation was prepared.',
      status: 409,
      code: 'content_writing_external_context_changed',
    });
  }
  const resultText = String(input.resultText || '').trim();
  if (!resultText) {
    throw new ContentWritingEngineError({
      message: 'The external content writing result cannot be empty.',
      status: 422,
      code: 'content_writing_external_result_empty',
    });
  }
  if (resultText.length > 1_000_000) {
    throw new ContentWritingEngineError({
      message: 'The external content writing result is too large.',
      status: 413,
      code: 'content_writing_external_result_too_large',
    });
  }

  const inputHash = createInputHash([
    'external',
    input.externalProvider,
    ...conversation.messages.map(message => message.content),
  ]);
  try {
    return await createCompletedExternalContentWritingSession({
      articleId: conversation.article.id,
      createdBy: input.createdBy,
      externalProvider: input.externalProvider,
      idempotencyKey: input.idempotencyKey,
      templateRegistryVersion: conversation.templateRegistryVersion,
      estimatedInputTokens: conversation.estimatedInputTokens,
      maxInputTokens: conversation.maxInputTokens,
      inputHash,
      contextSnapshot: conversation.contextSnapshot,
      messages: conversation.messages.map(message => ({ content: message.content })),
      resultText,
    });
  } catch (error) {
    if (error instanceof Error && /idempotency key belongs to a different/i.test(error.message)) {
      throw new ContentWritingEngineError({
        message: 'The idempotency key was already used for a different external writing result.',
        status: 409,
        code: 'content_writing_idempotency_conflict',
      });
    }
    throw error;
  }
};

export const queueContentWritingSession = async (input: {
  articleId: string;
  createdBy: string;
  provider: ContentWritingProvider;
  model?: string;
  idempotencyKey: string;
}): Promise<QueuedContentWritingSession> => {
  const [conversation, model] = await Promise.all([
    prepareContentWritingConversation(input.articleId),
    selectProviderModel(input.provider, input.model),
  ]);

  const inputHash = createInputHash([
    input.provider,
    model,
    ...conversation.messages.map(message => message.content),
  ]);
  try {
    return await createContentWritingSession({
      articleId: conversation.article.id,
      createdBy: input.createdBy,
      provider: input.provider,
      model,
      idempotencyKey: input.idempotencyKey,
      templateRegistryVersion: conversation.templateRegistryVersion,
      estimatedInputTokens: conversation.estimatedInputTokens,
      maxInputTokens: conversation.maxInputTokens,
      inputHash,
      contextSnapshot: {
        ...conversation.contextSnapshot,
        allowModelFallback: input.provider === 'gemini' && conversation.allowModelFallback,
      },
      messages: conversation.messages.map(message => ({ content: message.content })),
    });
  } catch (error) {
    if (error instanceof Error && /idempotency key belongs to a different/i.test(error.message)) {
      throw new ContentWritingEngineError({
        message: 'The idempotency key was already used for a different content writing request.',
        status: 409,
        code: 'content_writing_idempotency_conflict',
      });
    }
    throw error;
  }
};

export const assertContentWritingConversation = (
  messages: ContentWritingMessage[],
): [ContentWritingMessage, ContentWritingMessage, ContentWritingMessage] => {
  const expected = [
    { sequence: 1, stage: 'instructions', role: 'system' },
    { sequence: 2, stage: 'article_context', role: 'user' },
    { sequence: 3, stage: 'generation_request', role: 'user' },
  ] as const;
  if (messages.length < 3) {
    throw new ContentWritingEngineError({
      message: 'The content writing session does not contain its three required messages.',
      status: 500,
      code: 'content_writing_messages_incomplete',
    });
  }
  const selected = messages.slice(0, 3);
  expected.forEach((definition, index) => {
    const message = selected[index];
    if (
      message.sequence_number !== definition.sequence
      || message.stage !== definition.stage
      || message.role !== definition.role
      || !message.content.trim()
    ) {
      throw new ContentWritingEngineError({
        message: `Content writing message ${definition.sequence} is invalid.`,
        status: 500,
        code: 'content_writing_messages_invalid',
      });
    }
  });
  return selected as [ContentWritingMessage, ContentWritingMessage, ContentWritingMessage];
};

const toSafeMetadata = (body: JsonObject): JsonObject => {
  const { text: _text, ...metadata } = body;
  return metadata;
};

const createContentWritingRequestId = (
  sessionId: string,
  stepKey: string,
  attempt: number,
): string => `${sessionId}-${stepKey}-${Math.max(1, attempt)}`
  .replace(/[^A-Za-z0-9_-]/g, '-')
  .slice(0, 80);

export const executeContentWritingTurn = async (options: {
  session: ContentWritingSession;
  messages: ContentWritingMessage[];
  prompt: string;
  stepKey: string;
  stepLabel: string;
  stepAttempt: number;
  includeGenerationRequestInHistory?: boolean;
  articleContextOverride?: string;
  additionalHistory?: ContentWritingTurnHistory[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AiExecutionProgress) => void;
}): Promise<ContentWritingExecutionResult> => {
  const [instructions, articleContext, generationRequest] = assertContentWritingConversation(options.messages);
  const baseHistory: ContentWritingTurnHistory[] = [
    { role: 'user', content: options.articleContextOverride?.trim() || articleContext.content },
    ...(options.includeGenerationRequestInHistory === false
      ? []
      : [{ role: 'user' as const, content: generationRequest.content }]),
    ...(options.additionalHistory || []),
  ];
  const requestId = createContentWritingRequestId(
    options.session.id,
    options.stepKey,
    options.stepAttempt,
  );
  const telemetry = {
    actorUserId: options.session.created_by,
    source: 'content_writing',
    articleId: options.session.article_id,
    action: `structured_${options.stepKey}`,
    commandId: options.stepKey,
    commandLabel: options.stepLabel,
  };
  const allowModelFallback = options.session.provider === 'gemini'
    && options.session.context_snapshot?.allowModelFallback === true;
  const rawResult = options.session.provider === 'openai'
    ? await executeOpenAiRequest({
      instructions: instructions.content,
      messages: [
        ...baseHistory,
        { role: 'user', content: options.prompt },
      ],
      model: options.session.model,
      requestId,
      maxOutputTokens: options.maxOutputTokens || 8_000,
      conversationMode: 'independent',
      promptCacheKey: `content-writing:${options.session.id}`.slice(0, 200),
    }, { signal: options.signal, telemetry })
    : await aiExecutionEngine.executeGemini({
      systemInstruction: instructions.content,
      history: baseHistory.map(message => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        text: message.content,
      })),
      prompt: options.prompt,
      provider: options.session.provider,
      model: options.session.model,
      allowModelFallback,
      progressId: requestId,
    }, {
      signal: options.signal,
      telemetry,
      onProgress: options.onProgress,
    });
  const publicResult = options.session.provider === 'openai'
    ? { ...rawResult, body: rawResult.body || {} }
    : sanitizeAiExecutionResult({ status: rawResult.status, body: rawResult.body || {} });
  const body = isRecord(publicResult.body) ? publicResult.body : {};
  const text = toText(body.text);
  const model = toText(body.model) || options.session.model;
  const metadata = toSafeMetadata(body);
  if (publicResult.status >= 200 && publicResult.status < 300 && text) {
    return {
      ok: true,
      status: publicResult.status,
      text,
      model,
      conversationId: toText(body.conversationId) || undefined,
      keySuffix: toText(body.keySuffix) || undefined,
      metadata,
    };
  }
  return {
    ok: false,
    status: publicResult.status,
    text: '',
    model,
    keySuffix: toText(body.keySuffix) || undefined,
    metadata,
    errorCode: toText(body.code) || `${options.session.provider}_http_${publicResult.status}`,
    errorMessage: toText(body.error) || `Content writing request failed with HTTP ${publicResult.status}.`,
  };
};

export const executeContentWritingConversation = async (options: {
  session: ContentWritingSession;
  messages: ContentWritingMessage[];
  signal?: AbortSignal;
  onProgress?: (progress: AiExecutionProgress) => void;
}): Promise<ContentWritingExecutionResult> => {
  const [, , generationRequest] = assertContentWritingConversation(options.messages);
  return executeContentWritingTurn({
    ...options,
    prompt: generationRequest.content,
    stepKey: 'complete-article',
    stepLabel: 'Complete article generation',
    stepAttempt: Math.max(1, options.session.attempt_count),
    includeGenerationRequestInHistory: false,
    maxOutputTokens: 32_000,
  });
};
