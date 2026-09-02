import {
  ExternalAnalysisRetryError,
  ExternalAnalysisTerminalError,
  registerExternalAnalysisJobExecutor,
  type ExternalAnalysisExecutionContext,
  type ExternalAnalysisExecutionResult,
} from './externalAnalysisExecutor';
import {
  getExternalAnalysisSupabaseAdmin,
  type ExternalAnalysisJson,
} from './externalAnalysisQueue';
import {
  readExternalGeminiSettings,
} from './externalAnalysisSettings';
import { readArticleAutomationPolicy, type ArticleAutomationPolicy } from './articleAutomationPolicy';
import {
  reportExternalGeminiCall,
  runExternalGeminiCall,
} from './externalGeminiRunner';
import {
  PROMPT_TEMPLATE_IDS,
  getPromptTemplate,
} from '../constants/promptRegistry';
import { readPromptRegistrySettings } from './promptRegistrySettings';
import {
  buildExternalSemanticPrompt,
  buildExternalSemanticRepairPrompt,
  describeExternalSemanticValidationFailure,
  hasUsableExternalSemanticTerms,
  parseExternalSemanticTerms,
  type ExternalSemanticArticleInput,
  type ExternalSemanticKeywords,
  type ExternalSemanticTerms,
} from './externalSemanticTerms';
import type { GoogleDescriptionSuggestion } from '../types';

type ExternalSemanticArticleRow = {
  id: string;
  status: string;
  title: string | null;
  plain_text: string | null;
  keywords: unknown;
  goal_context: unknown;
  article_language: string | null;
  updated_at: string;
};

type ExternalSemanticStateRow = {
  article_id: string;
  semantic_ready: boolean;
  semantic_readiness_signature: string;
};

type SemanticTargetState = {
  needsSecondaries: boolean;
  needsLsi: boolean;
  needsGoogleMetadata: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const toStringList = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(toTrimmedString).filter(Boolean)
    : []
);

const toGoogleDescriptionList = (value: unknown): GoogleDescriptionSuggestion[] => (
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item === 'string') {
          const text = item.trim();
          return text ? [{ text, callToAction: '' }] : [];
        }
        if (!isRecord(item)) return [];
        const text = toTrimmedString(item.text);
        const callToAction = toTrimmedString(item.callToAction ?? item.cta);
        return text ? [{ text, callToAction }] : [];
      }).slice(0, 2)
    : []
);

const normalizeKeywords = (value: unknown): ExternalSemanticKeywords => {
  const source = isRecord(value) ? value : {};
  return {
    primary: toTrimmedString(source.primary),
    secondaries: toStringList(source.secondaries),
    company: toTrimmedString(source.company),
    lsi: toStringList(source.lsi),
    googleTitles: toStringList(source.googleTitles).slice(0, 2),
    googleDescriptions: toGoogleDescriptionList(source.googleDescriptions),
  };
};

const getTargetState = (keywords: ExternalSemanticKeywords): SemanticTargetState => ({
  needsSecondaries: keywords.secondaries.length === 0,
  needsLsi: keywords.lsi.length === 0,
  needsGoogleMetadata: keywords.googleTitles.length !== 2
    || keywords.googleDescriptions.length !== 2,
});

const getRequestedTargetState = (
  context: ExternalAnalysisExecutionContext,
  keywords: ExternalSemanticKeywords,
  automationSettings: ArticleAutomationPolicy | null,
): SemanticTargetState => {
  const missing = getTargetState(keywords);
  const snapshot = isRecord(context.job.input_snapshot) ? context.job.input_snapshot : {};
  const requestedSecondaries = typeof snapshot.needsSecondaries === 'boolean'
    ? snapshot.needsSecondaries
    : true;
  const requestedLsi = typeof snapshot.needsLsi === 'boolean'
    ? snapshot.needsLsi
    : true;
  const requestedGoogleMetadata = typeof snapshot.needsGoogleMetadata === 'boolean'
    ? snapshot.needsGoogleMetadata
    : true;
  const manual = context.job.origin === 'manual';
  const regenerateAll = manual && snapshot.forceRegenerateSemantic === true;
  return {
    needsSecondaries: (regenerateAll || missing.needsSecondaries)
      && requestedSecondaries
      && (manual || automationSettings?.autoGenerateAlternativeKeywords !== false),
    needsLsi: (regenerateAll || missing.needsLsi)
      && requestedLsi
      && (manual || automationSettings?.autoGenerateLsiKeywords !== false),
    needsGoogleMetadata: (regenerateAll || missing.needsGoogleMetadata)
      && requestedGoogleMetadata
      && (manual || automationSettings?.autoGenerateGoogleMetadata !== false),
  };
};

const keepRequestedTerms = (
  terms: ExternalSemanticTerms,
  targets: SemanticTargetState,
  scoped = false,
): ExternalSemanticTerms => scoped ? {
  secondaries: targets.needsSecondaries ? terms.secondaries : [],
  lsi: targets.needsLsi ? terms.lsi : [],
  googleTitles: targets.needsGoogleMetadata ? terms.googleTitles : [],
  googleDescriptions: targets.needsGoogleMetadata ? terms.googleDescriptions : [],
} : terms;

const isCurrentSemanticJob = (
  context: ExternalAnalysisExecutionContext,
  state: ExternalSemanticStateRow,
): boolean => {
  const input = isRecord(context.job.input_snapshot) ? context.job.input_snapshot : {};
  const pipelineOwned = Boolean(context.job.pipeline_parent_job_id)
    && input.pipelineSemanticGeneration === true
    && input.companyIsOptional === true
    && input.goalContextIsOptional === true;
  if (pipelineOwned) {
    return Boolean(state.semantic_readiness_signature)
      && state.semantic_readiness_signature === toTrimmedString(input.sourceReadinessSignature);
  }
  return state.semantic_ready === true
    && Boolean(state.semantic_readiness_signature)
    && state.semantic_readiness_signature === context.job.readiness_signature;
};

const readArticleAndState = async (articleId: string): Promise<{
  article: ExternalSemanticArticleRow;
  state: ExternalSemanticStateRow;
}> => {
  const supabase = getExternalAnalysisSupabaseAdmin();
  const [articleResult, stateResult] = await Promise.all([
    supabase
      .from('articles')
      .select('id,status,title,plain_text,keywords,goal_context,article_language,updated_at')
      .eq('id', articleId)
      .maybeSingle(),
    supabase
      .from('ai_external_analysis_article_state')
      .select('article_id,semantic_ready,semantic_readiness_signature')
      .eq('article_id', articleId)
      .maybeSingle(),
  ]);

  if (articleResult.error) throw articleResult.error;
  if (stateResult.error) throw stateResult.error;
  if (!articleResult.data) throw new Error(`Article ${articleId} was not found.`);
  if (!stateResult.data) throw new Error(`External analysis state for article ${articleId} was not found.`);

  return {
    article: articleResult.data as ExternalSemanticArticleRow,
    state: stateResult.data as ExternalSemanticStateRow,
  };
};

const toArticleInput = (article: ExternalSemanticArticleRow): ExternalSemanticArticleInput => ({
  title: toTrimmedString(article.title),
  plainText: toTrimmedString(article.plain_text),
  articleLanguage: article.article_language === 'en' ? 'en' : 'ar',
  keywords: normalizeKeywords(article.keywords),
  goalContext: isRecord(article.goal_context) ? article.goal_context : {},
});

const createRetryError = (options: {
  code: string;
  message: string;
  progress?: ExternalAnalysisJson;
}): ExternalAnalysisRetryError => new ExternalAnalysisRetryError({
  code: options.code,
  message: options.message.slice(0, 2_000),
  progress: options.progress,
});

const applySemanticTerms = async (options: {
  context: ExternalAnalysisExecutionContext;
  terms: ExternalSemanticTerms;
}): Promise<{
  status: 'applied' | 'already_populated' | 'automation_disabled' | 'superseded';
  appliedFields: string[];
  articleUpdatedAt: string;
}> => {
  const latest = await readArticleAndState(options.context.job.article_id);
  if (!isCurrentSemanticJob(options.context, latest.state)) {
    return {
      status: 'superseded',
      appliedFields: [],
      articleUpdatedAt: latest.article.updated_at,
    };
  }

  const latestKeywords = normalizeKeywords(latest.article.keywords);
  const latestAutomationSettings = options.context.job.origin === 'auto'
    ? await readArticleAutomationPolicy(options.context.job.article_id)
    : null;
  const targets = getRequestedTargetState(
    options.context,
    latestKeywords,
    latestAutomationSettings,
  );
  if (!targets.needsSecondaries && !targets.needsLsi && !targets.needsGoogleMetadata) {
    const missing = getTargetState(latestKeywords);
    return {
      status: missing.needsSecondaries || missing.needsLsi || missing.needsGoogleMetadata
        ? 'automation_disabled'
        : 'already_populated',
      appliedFields: [],
      articleUpdatedAt: latest.article.updated_at,
    };
  }

  if (!hasUsableExternalSemanticTerms(
    options.terms,
    targets.needsSecondaries,
    targets.needsLsi,
    targets.needsGoogleMetadata,
  )) {
    throw createRetryError({
      code: 'semantic_response_missing_current_target',
      message: 'Gemini did not return the semantic list that is currently empty.',
      progress: { stage: 'retry_scheduled', reason: 'missing_current_target' },
    });
  }

  const rawKeywords = isRecord(latest.article.keywords) ? latest.article.keywords : {};
  const shouldApplySecondaries = targets.needsSecondaries && options.terms.secondaries.length > 0;
  const shouldApplyLsi = targets.needsLsi && options.terms.lsi.length > 0;
  const shouldApplyGoogleMetadata = targets.needsGoogleMetadata
    && options.terms.googleTitles.length === 2
    && options.terms.googleDescriptions.length === 2;
  const appliedFields = [
    shouldApplySecondaries ? 'secondaries' : '',
    shouldApplyLsi ? 'lsi' : '',
    shouldApplyGoogleMetadata ? 'googleTitles' : '',
    shouldApplyGoogleMetadata ? 'googleDescriptions' : '',
  ].filter(Boolean);
  const now = new Date().toISOString();
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('articles')
    .update({
      keywords: {
        ...rawKeywords,
        secondaries: shouldApplySecondaries
          ? options.terms.secondaries
          : latestKeywords.secondaries,
        lsi: shouldApplyLsi
          ? options.terms.lsi
          : latestKeywords.lsi,
        googleTitles: shouldApplyGoogleMetadata
          ? options.terms.googleTitles
          : latestKeywords.googleTitles,
        googleDescriptions: shouldApplyGoogleMetadata
          ? options.terms.googleDescriptions
          : latestKeywords.googleDescriptions,
      },
      last_saved_at: now,
    })
    .eq('id', latest.article.id)
    .eq('updated_at', latest.article.updated_at)
    .select('id,updated_at')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw createRetryError({
      code: 'article_changed_during_semantic_apply',
      message: 'The article changed while semantic terms were being applied.',
      progress: { stage: 'retry_scheduled', reason: 'article_changed' },
    });
  }

  return {
    status: 'applied',
    appliedFields,
    articleUpdatedAt: String(data.updated_at || now),
  };
};

const executeExternalSemanticAnalysis = async (
  context: ExternalAnalysisExecutionContext,
): Promise<ExternalAnalysisExecutionResult> => {
  await context.reportProgress({
    progress: { stage: 'loading_article' },
  });

  const initial = await readArticleAndState(context.job.article_id);
  if (!isCurrentSemanticJob(context, initial.state)) {
    return {
      result: {
        status: 'superseded',
        reason: 'article_readiness_changed',
        articleUpdatedAt: initial.article.updated_at,
      },
      progress: { stage: 'superseded' },
    };
  }

  const articleInput = toArticleInput(initial.article);
  const automationSettings = context.job.origin === 'auto'
    ? await readArticleAutomationPolicy(context.job.article_id)
    : null;
  let initialTargets = getRequestedTargetState(context, articleInput.keywords, automationSettings);
  const scoped = automationSettings?.scope === 'creator';
  const scopedTargets = scoped || context.job.input_snapshot?.manualTarget === 'google_metadata';
  if (!initialTargets.needsSecondaries && !initialTargets.needsLsi && !initialTargets.needsGoogleMetadata) {
    const missing = getTargetState(articleInput.keywords);
    const status = missing.needsSecondaries || missing.needsLsi || missing.needsGoogleMetadata
      ? 'automation_disabled'
      : 'already_populated';
    return {
      result: {
        status,
        appliedFields: [],
        articleUpdatedAt: initial.article.updated_at,
      },
      progress: { stage: status },
    };
  }

  const aiSettings = await readExternalGeminiSettings();
  if (!aiSettings.enabled) {
    throw createRetryError({
      code: 'gemini_free_disabled',
      message: 'Free Gemini analysis is disabled in system settings.',
      progress: { stage: 'retry_scheduled', reason: 'gemini_free_disabled' },
    });
  }

  const promptRegistry = await readPromptRegistrySettings();
  const semanticPromptTemplate = getPromptTemplate(
    promptRegistry.templates,
    PROMPT_TEMPLATE_IDS.semanticKeywordsGeneration,
  );
  const attempts: ExternalAnalysisJson[] = [];
  let finalCall = await runExternalGeminiCall({
    context,
    prompt: buildExternalSemanticPrompt(
      articleInput,
      semanticPromptTemplate,
      initialTargets.needsSecondaries,
      initialTargets.needsLsi,
      initialTargets.needsGoogleMetadata,
      scopedTargets,
    ),
    model: aiSettings.model,
    allowModelFallback: aiSettings.allowModelFallback,
    requestIndex: 1,
  });
  attempts.push(...finalCall.attempts);
  await reportExternalGeminiCall(context, finalCall, attempts);

  if (!finalCall.ok) {
    throw createRetryError({
      code: `gemini_http_${finalCall.status}`,
      message: finalCall.error,
      progress: {
        stage: 'retry_scheduled',
        provider: finalCall.provider,
        model: finalCall.model,
        keyAttemptCount: attempts.length,
      },
    });
  }

  let terms = keepRequestedTerms(
    parseExternalSemanticTerms(finalCall.text, articleInput),
    initialTargets,
    scopedTargets,
  );

  if (!hasUsableExternalSemanticTerms(
    terms,
    initialTargets.needsSecondaries,
    initialTargets.needsLsi,
    initialTargets.needsGoogleMetadata,
  )) {
    if (scoped) {
      const current = getRequestedTargetState(context, articleInput.keywords, await readArticleAutomationPolicy(context.job.article_id));
      initialTargets = {
        needsSecondaries: initialTargets.needsSecondaries && current.needsSecondaries,
        needsLsi: initialTargets.needsLsi && current.needsLsi,
        needsGoogleMetadata: initialTargets.needsGoogleMetadata && current.needsGoogleMetadata,
      };
      if (!Object.values(initialTargets).some(Boolean)) {
        throw new ExternalAnalysisTerminalError({ code: 'creator_automation_disabled', message: 'The creator disabled semantic automation before repair.' });
      }
    }
    await context.reportProgress({
      progress: { stage: 'repairing_semantic_response' },
      provider: finalCall.provider,
      model: finalCall.model,
      keyAttempts: attempts,
    });
    finalCall = await runExternalGeminiCall({
      context,
      prompt: buildExternalSemanticRepairPrompt(
        articleInput,
        finalCall.text,
        semanticPromptTemplate,
        initialTargets.needsSecondaries,
        initialTargets.needsLsi,
        initialTargets.needsGoogleMetadata,
        scopedTargets,
      ),
      model: aiSettings.model,
      allowModelFallback: aiSettings.allowModelFallback,
      requestIndex: 2,
    });
    attempts.push(...finalCall.attempts);
    await reportExternalGeminiCall(context, finalCall, attempts);

    if (!finalCall.ok) {
      throw createRetryError({
        code: `gemini_repair_http_${finalCall.status}`,
        message: finalCall.error,
        progress: {
          stage: 'retry_scheduled',
          provider: finalCall.provider,
          model: finalCall.model,
          keyAttemptCount: attempts.length,
        },
      });
    }

    terms = keepRequestedTerms(
      parseExternalSemanticTerms(finalCall.text, articleInput),
      initialTargets,
      scopedTargets,
    );
  }

  if (!hasUsableExternalSemanticTerms(
    terms,
    initialTargets.needsSecondaries,
    initialTargets.needsLsi,
    initialTargets.needsGoogleMetadata,
  )) {
    throw createRetryError({
      code: 'semantic_response_invalid',
      message: describeExternalSemanticValidationFailure(
        terms,
        articleInput,
        initialTargets.needsSecondaries,
        initialTargets.needsLsi,
        initialTargets.needsGoogleMetadata,
      ),
      progress: {
        stage: 'retry_scheduled',
        reason: 'semantic_response_invalid',
        keyAttemptCount: attempts.length,
      },
    });
  }

  await context.reportProgress({
    progress: { stage: 'applying_semantic_terms' },
    provider: finalCall.provider,
    model: finalCall.model,
    keyAttempts: attempts,
  });
  const application = await applySemanticTerms({ context, terms });

  return {
    result: {
      status: application.status,
      generated: terms,
      appliedFields: application.appliedFields,
      provider: finalCall.provider,
      model: finalCall.model,
      keySuffix: finalCall.keySuffix,
      keyAttempts: attempts,
      sourceArticleUpdatedAt: initial.article.updated_at,
      articleUpdatedAt: application.articleUpdatedAt,
      completedAt: new Date().toISOString(),
    },
    progress: {
      stage: application.status,
      provider: finalCall.provider,
      model: finalCall.model,
      keySuffix: finalCall.keySuffix,
      keyAttemptCount: attempts.length,
    },
  };
};

registerExternalAnalysisJobExecutor(
  'semantic_keywords_lsi',
  executeExternalSemanticAnalysis,
);
