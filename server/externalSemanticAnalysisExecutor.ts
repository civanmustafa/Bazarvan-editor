import {
  ExternalAnalysisRetryError,
  registerExternalAnalysisJobExecutor,
  type ExternalAnalysisExecutionContext,
} from './externalAnalysisExecutor';
import {
  getExternalAnalysisSupabaseAdmin,
  type ExternalAnalysisJson,
} from './externalAnalysisQueue';
import { readExternalGeminiSettings } from './externalAnalysisSettings';
import {
  reportExternalGeminiCall,
  runExternalGeminiCall,
} from './externalGeminiRunner';
import {
  buildExternalSemanticPrompt,
  buildExternalSemanticRepairPrompt,
  hasUsableExternalSemanticTerms,
  parseExternalSemanticTerms,
  type ExternalSemanticArticleInput,
  type ExternalSemanticKeywords,
  type ExternalSemanticTerms,
} from './externalSemanticTerms';

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

const normalizeKeywords = (value: unknown): ExternalSemanticKeywords => {
  const source = isRecord(value) ? value : {};
  return {
    primary: toTrimmedString(source.primary),
    secondaries: toStringList(source.secondaries),
    company: toTrimmedString(source.company),
    lsi: toStringList(source.lsi),
  };
};

const getTargetState = (keywords: ExternalSemanticKeywords): SemanticTargetState => ({
  needsSecondaries: keywords.secondaries.length === 0,
  needsLsi: keywords.lsi.length === 0,
});

const isCurrentSemanticJob = (
  context: ExternalAnalysisExecutionContext,
  state: ExternalSemanticStateRow,
): boolean => (
  state.semantic_ready === true
  && Boolean(state.semantic_readiness_signature)
  && state.semantic_readiness_signature === context.job.readiness_signature
);

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
  status: 'applied' | 'already_populated' | 'superseded';
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
  const targets = getTargetState(latestKeywords);
  if (!targets.needsSecondaries && !targets.needsLsi) {
    return {
      status: 'already_populated',
      appliedFields: [],
      articleUpdatedAt: latest.article.updated_at,
    };
  }

  if (!hasUsableExternalSemanticTerms(
    options.terms,
    targets.needsSecondaries,
    targets.needsLsi,
  )) {
    throw createRetryError({
      code: 'semantic_response_missing_current_target',
      message: 'Gemini did not return the semantic list that is currently empty.',
      progress: { stage: 'retry_scheduled', reason: 'missing_current_target' },
    });
  }

  const rawKeywords = isRecord(latest.article.keywords) ? latest.article.keywords : {};
  const appliedFields = [
    targets.needsSecondaries ? 'secondaries' : '',
    targets.needsLsi ? 'lsi' : '',
  ].filter(Boolean);
  const now = new Date().toISOString();
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('articles')
    .update({
      keywords: {
        ...rawKeywords,
        secondaries: targets.needsSecondaries
          ? options.terms.secondaries
          : latestKeywords.secondaries,
        lsi: targets.needsLsi
          ? options.terms.lsi
          : latestKeywords.lsi,
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
) => {
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
  const initialTargets = getTargetState(articleInput.keywords);
  if (!initialTargets.needsSecondaries && !initialTargets.needsLsi) {
    return {
      result: {
        status: 'already_populated',
        appliedFields: [],
        articleUpdatedAt: initial.article.updated_at,
      },
      progress: { stage: 'already_populated' },
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

  const attempts: ExternalAnalysisJson[] = [];
  let finalCall = await runExternalGeminiCall({
    context,
    prompt: buildExternalSemanticPrompt(articleInput),
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

  let terms = parseExternalSemanticTerms(
    finalCall.text,
    articleInput.keywords.primary,
    articleInput.keywords.company,
  );

  if (!hasUsableExternalSemanticTerms(
    terms,
    initialTargets.needsSecondaries,
    initialTargets.needsLsi,
  )) {
    await context.reportProgress({
      progress: { stage: 'repairing_semantic_response' },
      provider: finalCall.provider,
      model: finalCall.model,
      keyAttempts: attempts,
    });
    finalCall = await runExternalGeminiCall({
      context,
      prompt: buildExternalSemanticRepairPrompt(articleInput, finalCall.text),
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

    terms = parseExternalSemanticTerms(
      finalCall.text,
      articleInput.keywords.primary,
      articleInput.keywords.company,
    );
  }

  if (!hasUsableExternalSemanticTerms(
    terms,
    initialTargets.needsSecondaries,
    initialTargets.needsLsi,
  )) {
    throw createRetryError({
      code: 'semantic_response_invalid',
      message: 'Gemini returned no usable alternative forms or LSI terms after one repair request.',
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
