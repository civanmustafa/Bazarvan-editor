import { createHash } from 'node:crypto';
import {
  GEMINI_FREE_MODEL_VALUES,
  GEMINI_PAID_MODEL_VALUES,
  normalizeGeminiFreeModelId,
  normalizeGeminiPaidModelId,
  uniqueModelIds,
} from '../constants/modelRegistry';
import {
  CONTENT_WRITING_PROTECTED_SYSTEM_GUARD,
  CONTENT_WRITING_TEMPLATE_FIELDS,
  renderContentWritingTemplate,
  type ContentWritingTemplateSet,
} from '../constants/contentWriting';
import {
  getPromptTemplate,
  PROMPT_TEMPLATE_IDS,
  type PromptRegistrySettings,
} from '../constants/promptRegistry';
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
  type ContentWritingArticleInput,
  type ContentWritingPromptBundle,
  type ContentWritingPromptMessage,
} from '../utils/contentWritingContext';
import { normalizeGoalContext } from '../utils/goalContext';
import { buildContentWritingSourceInstructionsBlock } from '../utils/contentWritingSourceInstructions';
import {
  applyContentWritingLengthTargetToQualityConfiguration,
  countContentWritingTargetWords,
  resolveContentWritingLengthTarget,
} from '../utils/contentWritingTargets';
import {
  competitorPhraseIntelligenceToPromptJson,
  createCompetitorPhraseIntelligence,
} from '../utils/competitorPhraseAnalysis';
import { CONTENT_WRITING_WORKFLOW_VERSION } from '../utils/contentWritingWorkflow';
import {
  aiExecutionEngine,
  sanitizeAiExecutionResult,
  type AiExecutionProgress,
} from './aiExecutionEngine';
import { readAiProviderCapabilities } from './aiProviderCapabilities';
import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';
import { executeOpenAiRequest } from './openAiExecutionEngine';
import { readPromptRegistrySettings } from './promptRegistrySettings';
import {
  createCompletedExternalContentWritingSession,
  createContentWritingSession,
  type ContentWritingMessage,
  type ContentWritingProvider,
  type ContentWritingSession,
} from './contentWritingSessionService';
import {
  readManagedArticleCompetitorRows,
  resolveArticleCompetitorRepositorySnapshot,
} from './articleCompetitorRepository';
import { listArticleWritingSources } from './contentWritingSources';
import { readArticleAutomationPolicy } from './articleAutomationPolicy';

type JsonObject = Record<string, unknown>;

type ArticleRow = {
  id: string;
  title: string | null;
  keywords: unknown;
  goal_context: unknown;
  metadata: unknown;
  article_language: string | null;
  updated_at: string;
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
  promptRegistry: PromptRegistrySettings;
  maxInputTokens: number;
  allowModelFallback: boolean;
  qualityConfiguration: ContentWritingQualityConfiguration;
  competitorPhraseIntelligenceEnabled: boolean;
  dualKnowledgeExtractionEnabled: boolean;
  multiCandidateGenerationEnabled: boolean;
}> => {
  const [{ data, error }, promptRegistry] = await Promise.all([
    getExternalAnalysisSupabaseAdmin()
      .from('app_settings')
      .select('value')
      .eq('key', 'ai')
      .maybeSingle(),
    readPromptRegistrySettings(),
  ]);
  if (error && error.code !== '42P01') throw error;
  const ai = normalizeSystemSettingsMap({ ai: normalizeInputRecord(data?.value) }).ai;
  return {
    templates: {
      instructions: getPromptTemplate(
        promptRegistry.templates,
        PROMPT_TEMPLATE_IDS.contentWritingInstructions,
      ) || String(ai[CONTENT_WRITING_TEMPLATE_FIELDS.instructions] || ''),
      articleContext: getPromptTemplate(
        promptRegistry.templates,
        PROMPT_TEMPLATE_IDS.contentWritingArticleContext,
      ) || String(ai[CONTENT_WRITING_TEMPLATE_FIELDS.articleContext] || ''),
      generationRequest: getPromptTemplate(
        promptRegistry.templates,
        PROMPT_TEMPLATE_IDS.contentWritingGenerationRequest,
      ) || String(ai[CONTENT_WRITING_TEMPLATE_FIELDS.generationRequest] || ''),
    },
    promptRegistry,
    maxInputTokens: Number(ai.contentWritingMaxInputTokens),
    allowModelFallback: ai.geminiFreeModelFallbackEnabled !== false,
    qualityConfiguration: normalizeContentWritingQualityConfiguration({
      policyVersion: ai.contentWritingQualityPolicyVersion,
      minimumScore: ai.contentWritingMinimumQualityScore,
      maxRepairPasses: ai.contentWritingMaxRepairPasses,
    }),
    competitorPhraseIntelligenceEnabled:
      ai.contentWritingCompetitorPhraseIntelligenceEnabled !== false,
    dualKnowledgeExtractionEnabled:
      ai.contentWritingDualKnowledgeExtractionEnabled !== false,
    multiCandidateGenerationEnabled:
      ai.contentWritingMultiCandidateGenerationEnabled !== false,
  };
};

const readArticleInput = async (articleId: string): Promise<{
  article: ArticleRow;
  input: ContentWritingArticleInput;
}> => {
  const supabase = getExternalAnalysisSupabaseAdmin();
  const [articleResult, competitorResult, writingSources] = await Promise.all([
    supabase
      .from('articles')
      .select('id,title,keywords,goal_context,metadata,article_language,updated_at')
      .eq('id', articleId)
      .maybeSingle(),
    readManagedArticleCompetitorRows(articleId),
    listArticleWritingSources(articleId),
  ]);
  if (articleResult.error) throw articleResult.error;
  if (!articleResult.data) {
    throw new ContentWritingEngineError({
      message: 'Article was not found.',
      status: 404,
      code: 'article_not_found',
    });
  }

  const article = articleResult.data as ArticleRow;
  const competitorSnapshot = resolveArticleCompetitorRepositorySnapshot({
    rows: competitorResult,
    metadata: article.metadata,
  });

  return {
    article,
    input: {
      articleId: article.id,
      title: toText(article.title),
      language: article.article_language === 'en' ? 'en' : 'ar',
      keywords: normalizeInputRecord(article.keywords),
      goalContext: normalizeInputRecord(article.goal_context),
      competitors: competitorSnapshot.competitors,
      writingSources: writingSources.map(source => ({
        id: source.id,
        title: source.title,
        url: source.sourceUrl || undefined,
        content: source.contentText,
        sourceRole: source.sourceRole,
        focusInstructions: source.focusInstructions,
        enabled: source.enabled,
        status: source.status,
      })),
    },
  };
};

const getAllowedGeminiModels = (provider: ContentWritingProvider): string[] => uniqueModelIds([
  ...(provider === 'geminiPaid' ? GEMINI_PAID_MODEL_VALUES : GEMINI_FREE_MODEL_VALUES),
  ...(provider === 'geminiPaid'
    ? String(process.env.GEMINI_ALLOWED_MODELS || '').split(/[\n,;]+/)
    : []),
]);

const selectProviderModel = async (
  provider: ContentWritingProvider,
  requestedModel?: string,
  userId?: string,
): Promise<string> => {
  const capabilities = await readAiProviderCapabilities(userId);
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
      message: `${provider} is enabled but no permitted credential exists in the dashboard vault.`,
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

export const createContentWritingSessionInputHash = (
  provider: ContentWritingProvider,
  model: string,
  messages: readonly string[],
): string => createInputHash([provider, model, ...messages]);

export const resolveContentWritingResumePreference = async (
  provider: ContentWritingProvider,
  requestedModel?: string,
  userId?: string,
): Promise<{
  provider: ContentWritingProvider;
  model: string;
  allowModelFallback: boolean;
}> => {
  const [model, settings] = await Promise.all([
    selectProviderModel(provider, requestedModel, userId),
    getContentWritingSettings(),
  ]);
  return {
    provider,
    model,
    allowModelFallback: provider === 'gemini' && settings.allowModelFallback,
  };
};

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
  options: {
    allowMissingCompany?: boolean;
    allowMissingGoalContext?: boolean;
  } = {},
): Promise<PreparedContentWritingConversation> => {
  const [articleSource, settings] = await Promise.all([
    readArticleInput(articleId),
    getContentWritingSettings(),
  ]);
  const bundle = buildContentWritingPromptBundle(articleSource.input, {
    templates: settings.templates,
    maxInputTokens: settings.maxInputTokens,
    requireCompany: options.allowMissingCompany !== true,
    requireGoalContext: options.allowMissingGoalContext !== true,
  });
  assertContentWritingBundleReady(bundle);
  const normalizedGoalContext = normalizeGoalContext(articleSource.input.goalContext);
  const lengthTarget = resolveContentWritingLengthTarget({
    manualRange: normalizedGoalContext.targetWordRange,
    competitors: bundle.competitors,
  });
  const qualityConfiguration = applyContentWritingLengthTargetToQualityConfiguration(
    settings.qualityConfiguration,
    lengthTarget,
  );
  const baseQualityContract = buildContentWritingQualityContract({
    configuration: qualityConfiguration,
    language: articleSource.input.language,
    goalContext: normalizedGoalContext,
  });
  const lengthDecisionLine = lengthTarget.mode === 'manual'
    ? (
        articleSource.input.language === 'en'
          ? `- The user-defined word range ${lengthTarget.targetWords.min}-${lengthTarget.targetWords.max} is authoritative for this session.`
          : `- نطاق الكلمات الذي حدده المستخدم ${lengthTarget.targetWords.min}-${lengthTarget.targetWords.max} هو النطاق الملزم لهذه الجلسة.`
      )
    : (
        articleSource.input.language === 'en'
          ? `- Automatic length: the robust largest non-outlier competitor baseline has ${lengthTarget.baselineCompetitor?.wordCount || 0} words (${lengthTarget.excludedOutlierCount} outliers excluded); the center is ×1.20 (${lengthTarget.centerWords}) and the passing range uses ±10%.`
          : `- الطول التلقائي: خط الأساس المتين لأكبر منافس غير شاذ يحتوي ${lengthTarget.baselineCompetitor?.wordCount || 0} كلمة (استُبعد ${lengthTarget.excludedOutlierCount} شاذ)؛ حُسب المركز بضربه ×1.20 (${lengthTarget.centerWords}) وهامش النجاح ±10%.`
      );
  const qualityContract = `${baseQualityContract}\n${lengthDecisionLine}`;
  const competitorPhraseIntelligence = createCompetitorPhraseIntelligence({
    sources: bundle.competitors.map((competitor, index) => ({
      competitorNumber: index + 1,
      text: competitor.content,
    })),
    keywords: articleSource.input.keywords,
    articleLanguage: articleSource.input.language === 'en' ? 'en' : 'ar',
    enabled: settings.competitorPhraseIntelligenceEnabled,
  });
  const qualityContractHeading = articleSource.input.language === 'en'
    ? 'Mandatory quality criteria for this session:'
    : 'معايير الجودة الملزمة لهذه الجلسة:';
  const competitorPhraseIntelligenceHeading = articleSource.input.language === 'en'
    ? 'Deterministic competitor phrase intelligence for this session:'
    : 'ذكاء عبارات المنافسين المحسوب برمجيًا لهذه الجلسة:';
  const competitorPhraseIntelligenceBlock = settings.competitorPhraseIntelligenceEnabled
    ? `\n\n${competitorPhraseIntelligenceHeading}\n${competitorPhraseIntelligenceToPromptJson(competitorPhraseIntelligence)}`
    : '';
  const messages = bundle.messages.map(message => message.stage === 'generationRequest'
    ? { ...message, content: `${message.content}\n\n${qualityContractHeading}\n${qualityContract}${competitorPhraseIntelligenceBlock}` }
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
        note: 'Use the persisted competitor coverage matrix, source registry, claim ledger, and the source excerpts supplied for the current step.',
      }, null, 2),
      writing_sources_json: JSON.stringify({
        status: 'indexed_separately',
        note: 'Use the frozen writing-source records and source excerpts supplied for each step. Primary writing sources have priority over supporting sources.',
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
      faqIndependenceVersion: 1,
      finalSectionStructureVersion: 1,
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
        wordCount: countContentWritingTargetWords(competitor.content),
      })),
      competitorQualityAudit: bundle.competitorQualityAudit,
      competitorChunks: bundle.competitorChunks,
      writingSourceChunks: bundle.writingSourceChunks,
      sourceChunks: bundle.sourceChunks,
      writingSources: (articleSource.input.writingSources || [])
        .filter(source => source.enabled && source.status === 'ready')
        .map(source => ({
          id: source.id,
          title: source.title || '',
          url: source.url || null,
          role: source.sourceRole,
          focusInstructions: source.focusInstructions || '',
          contentHash: createHash('sha256').update(source.content, 'utf8').digest('hex'),
        })),
      competitorPhraseIntelligenceEnabled: settings.competitorPhraseIntelligenceEnabled,
      competitorPhraseIntelligence,
      dualKnowledgeExtractionEnabled: settings.dualKnowledgeExtractionEnabled,
      multiCandidateGenerationEnabled: settings.multiCandidateGenerationEnabled,
      compactArticleContextBase,
      lengthTarget,
      qualityPolicyVersion: qualityConfiguration.policyVersion,
      qualityConfiguration,
      qualityContract,
      promptRegistryVersion: settings.promptRegistry.registryVersion,
      promptTemplates: settings.promptRegistry.templates,
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
  contextSnapshotPatch?: JsonObject;
  allowMissingCompany?: boolean;
  allowMissingGoalContext?: boolean;
}): Promise<QueuedContentWritingSession> => {
  const [conversation, model] = await Promise.all([
    prepareContentWritingConversation(input.articleId, {
      allowMissingCompany: input.allowMissingCompany,
      allowMissingGoalContext: input.allowMissingGoalContext,
    }),
    selectProviderModel(input.provider, input.model, input.createdBy),
  ]);

  const inputHash = createContentWritingSessionInputHash(
    input.provider,
    model,
    conversation.messages.map(message => message.content),
  );
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
        ...(isRecord(input.contextSnapshotPatch) ? input.contextSnapshotPatch : {}),
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
  if (options.session.context_snapshot?.triggerSource === 'automatic_ready') {
    // Each writing stage is a separate paid request. Let a response already in
    // flight be persisted, but never start the next stage using a stale policy.
    const policy = await readArticleAutomationPolicy(options.session.article_id);
    if (!policy.enabled || !policy.contentWritingAutomationEnabled
        || (policy.scope === 'creator'
          && (!policy.creatorUserId || policy.creatorUserId !== options.session.created_by))) {
      return {
        ok: false,
        status: 499,
        text: '',
        model: options.session.model,
        metadata: { provider: options.session.provider, automationPolicyStopped: true },
        errorCode: 'content_writing_cancelled',
        errorMessage: 'Automatic writing stopped before the next request because the article creator policy no longer permits it.',
      };
    }
  }
  const [instructions, articleContext, generationRequest] = assertContentWritingConversation(options.messages);
  const currentSystemInstructions = instructions.content.includes(CONTENT_WRITING_PROTECTED_SYSTEM_GUARD)
    ? instructions.content
    : `${instructions.content}\n\n${CONTENT_WRITING_PROTECTED_SYSTEM_GUARD}`;
  const requestedArticleContext = options.articleContextOverride?.trim() || articleContext.content;
  const writingSourceInstructionsBlock = buildContentWritingSourceInstructionsBlock(
    (Array.isArray(options.session.context_snapshot?.writingSources)
      ? options.session.context_snapshot.writingSources
      : [])
      .filter(isRecord)
      .map(source => ({
        sourceId: source.id,
        sourceRole: source.role,
        instructions: source.focusInstructions,
      })),
  );
  // Queued sessions may retain the old reference-only context. Restore their
  // frozen user instructions in memory, including before knowledge indexing.
  const currentArticleContext = writingSourceInstructionsBlock
    && !requestedArticleContext.includes(writingSourceInstructionsBlock)
    ? `${requestedArticleContext}\n\n${writingSourceInstructionsBlock}`
    : requestedArticleContext;
  const baseHistory: ContentWritingTurnHistory[] = [
    { role: 'user', content: currentArticleContext },
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
  const credentialPurpose = options.session.progress?.resumed === true
    ? 'content_writing_resume' as const
    : 'standard' as const;
  const rawResult = options.session.provider === 'openai'
    ? await executeOpenAiRequest({
      instructions: currentSystemInstructions,
      messages: [
        ...baseHistory,
        { role: 'user', content: options.prompt },
      ],
      model: options.session.model,
      requestId,
      maxOutputTokens: options.maxOutputTokens || 8_000,
      conversationMode: 'independent',
      promptCacheKey: `content-writing:${options.session.id}`.slice(0, 200),
    }, { signal: options.signal, telemetry, credentialPurpose })
    : await aiExecutionEngine.executeGemini({
      systemInstruction: currentSystemInstructions,
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
      credentialPurpose,
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
