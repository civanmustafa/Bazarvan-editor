import {
  executeGeminiRequest,
  type GeminiExecutionProgress,
} from '../api/gemini';
import {
  ExternalAnalysisRetryError,
  registerExternalAnalysisJobExecutor,
  type ExternalAnalysisExecutionContext,
} from './externalAnalysisExecutor';
import {
  getExternalAnalysisSupabaseAdmin,
  type ExternalAnalysisJson,
} from './externalAnalysisQueue';
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

type GeminiCallResult = {
  ok: boolean;
  status: number;
  text: string;
  error: string;
  provider: string;
  model: string;
  keySuffix: string;
  attempts: ExternalAnalysisJson[];
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

const compactJson = (value: Record<string, unknown>): ExternalAnalysisJson => (
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
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

const readSemanticAiSettings = async (): Promise<{
  enabled: boolean;
  model: string;
  allowModelFallback: boolean;
}> => {
  const supabase = getExternalAnalysisSupabaseAdmin();
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'ai')
    .maybeSingle();

  if (error && error.code !== '42P01') throw error;
  const settings = isRecord(data?.value) ? data.value : {};
  return {
    enabled: settings.geminiFreeEnabled !== false,
    model: toTrimmedString(settings.defaultGeminiModel)
      || process.env.GEMINI_MODEL?.trim()
      || 'gemini-3.5-flash',
    allowModelFallback: settings.geminiFreeModelFallbackEnabled !== false,
  };
};

const toArticleInput = (article: ExternalSemanticArticleRow): ExternalSemanticArticleInput => ({
  title: toTrimmedString(article.title),
  plainText: toTrimmedString(article.plain_text),
  articleLanguage: article.article_language === 'en' ? 'en' : 'ar',
  keywords: normalizeKeywords(article.keywords),
  goalContext: isRecord(article.goal_context) ? article.goal_context : {},
});

const toVisibleGeminiProgress = (
  progress: GeminiExecutionProgress,
): ExternalAnalysisJson => compactJson({
  stage: `gemini_${progress.stage || 'running'}`,
  gemini: compactJson({
    stage: progress.stage,
    provider: progress.provider,
    model: progress.model,
    requestedModel: progress.requestedModel,
    currentModelIndex: progress.currentModelIndex,
    modelCount: progress.modelCount,
    currentKeyIndex: progress.currentKeyIndex,
    keyCount: progress.keyCount,
    attemptedKeyCount: progress.attemptedKeyCount,
    totalAttemptCount: progress.totalAttemptCount,
    keySuffix: progress.keySuffix,
    status: progress.status,
    reason: progress.reason,
    message: progress.message,
    completed: progress.completed,
    updatedAt: progress.updatedAt,
  }),
});

const createProgressForwarder = (context: ExternalAnalysisExecutionContext) => {
  let latest: GeminiExecutionProgress | null = null;
  let running: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (latest) {
      const current = latest;
      latest = null;
      try {
        await context.reportProgress({
          progress: toVisibleGeminiProgress(current),
          provider: current.provider,
          model: current.model,
        });
      } catch (error) {
        console.warn('[external-semantic] Could not persist intermediate Gemini progress', {
          jobId: context.job.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const start = (): void => {
    if (running) return;
    running = drain().finally(() => {
      running = null;
      if (latest) start();
    });
  };

  return {
    push(progress: GeminiExecutionProgress) {
      latest = progress;
      start();
    },
    async flush() {
      while (running || latest) {
        start();
        if (running) await running;
      }
    },
  };
};

const sanitizeGeminiAttempts = (
  body: Record<string, unknown>,
  requestIndex: number,
  succeeded: boolean,
): ExternalAnalysisJson[] => {
  const failed = Array.isArray(body.attempts)
    ? body.attempts.filter(isRecord).map((attempt): ExternalAnalysisJson => compactJson({
        requestIndex,
        outcome: 'failed',
        model: toTrimmedString(attempt.model),
        keySuffix: toTrimmedString(attempt.keySuffix),
        status: typeof attempt.status === 'number' ? attempt.status : undefined,
        reason: toTrimmedString(attempt.reason) || 'unknown',
        attempt: typeof attempt.attempt === 'number' ? attempt.attempt : 1,
      }))
    : [];

  if (succeeded) {
    failed.push(compactJson({
      requestIndex,
      outcome: 'success',
      model: toTrimmedString(body.model),
      keySuffix: toTrimmedString(body.keySuffix),
      status: 200,
      reason: 'success',
      attempt: 1,
    }));
  }

  return failed;
};

const runGeminiCall = async (options: {
  context: ExternalAnalysisExecutionContext;
  prompt: string;
  model: string;
  allowModelFallback: boolean;
  requestIndex: number;
  progressForwarder: ReturnType<typeof createProgressForwarder>;
}): Promise<GeminiCallResult> => {
  const progressId = `external-${options.context.job.id}-${options.context.job.attempt_count}-${options.requestIndex}`;
  const result = await executeGeminiRequest({
    prompt: options.prompt,
    provider: 'gemini',
    model: options.model,
    allowModelFallback: options.allowModelFallback,
    progressId,
  }, {
    signal: options.context.signal,
    onProgress: progress => options.progressForwarder.push(progress),
  });
  await options.progressForwarder.flush();

  const body = isRecord(result.body) ? result.body : {};
  const text = toTrimmedString(body.text);
  const ok = result.status >= 200 && result.status < 300 && Boolean(text);
  return {
    ok,
    status: result.status,
    text,
    error: toTrimmedString(body.error) || `Gemini request failed with status ${result.status}.`,
    provider: toTrimmedString(body.provider) || 'gemini',
    model: toTrimmedString(body.model) || options.model,
    keySuffix: toTrimmedString(body.keySuffix),
    attempts: sanitizeGeminiAttempts(body, options.requestIndex, ok),
  };
};

const createRetryError = (options: {
  code: string;
  message: string;
  progress?: ExternalAnalysisJson;
}): ExternalAnalysisRetryError => new ExternalAnalysisRetryError({
  code: options.code,
  message: options.message.slice(0, 2_000),
  progress: options.progress,
});

const reportFinalGeminiCall = async (
  context: ExternalAnalysisExecutionContext,
  call: GeminiCallResult,
  attempts: ExternalAnalysisJson[],
): Promise<void> => {
  const persisted = await context.reportProgress({
    progress: {
      stage: call.ok ? 'gemini_response_received' : 'gemini_failed',
      gemini: {
        provider: call.provider,
        model: call.model,
        keySuffix: call.keySuffix,
        status: call.status,
        requestCount: new Set(attempts.map(attempt => attempt.requestIndex)).size,
      },
    },
    provider: call.provider,
    model: call.model,
    keyAttempts: attempts,
  });
  if (!persisted) {
    throw createRetryError({
      code: 'semantic_job_lease_lost',
      message: 'The semantic job lease was lost while recording Gemini progress.',
    });
  }
};

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

  const aiSettings = await readSemanticAiSettings();
  if (!aiSettings.enabled) {
    throw createRetryError({
      code: 'gemini_free_disabled',
      message: 'Free Gemini analysis is disabled in system settings.',
      progress: { stage: 'retry_scheduled', reason: 'gemini_free_disabled' },
    });
  }

  const progressForwarder = createProgressForwarder(context);
  const attempts: ExternalAnalysisJson[] = [];
  let finalCall = await runGeminiCall({
    context,
    prompt: buildExternalSemanticPrompt(articleInput),
    model: aiSettings.model,
    allowModelFallback: aiSettings.allowModelFallback,
    requestIndex: 1,
    progressForwarder,
  });
  attempts.push(...finalCall.attempts);
  await reportFinalGeminiCall(context, finalCall, attempts);

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
    finalCall = await runGeminiCall({
      context,
      prompt: buildExternalSemanticRepairPrompt(articleInput, finalCall.text),
      model: aiSettings.model,
      allowModelFallback: aiSettings.allowModelFallback,
      requestIndex: 2,
      progressForwarder,
    });
    attempts.push(...finalCall.attempts);
    await reportFinalGeminiCall(context, finalCall, attempts);

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
