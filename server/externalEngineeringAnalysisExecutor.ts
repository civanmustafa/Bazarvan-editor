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
import { getExternalEngineeringCommand } from './externalEngineeringCommands';
import {
  buildExternalEngineeringPrompt,
  buildExternalEngineeringRepairPrompt,
  type ExternalEngineeringPromptInput,
} from './externalEngineeringPrompt';
import {
  hasUsableExternalEngineeringResult,
  parseExternalEngineeringResult,
} from './externalEngineeringResult';
import {
  reportExternalGeminiCall,
  runExternalGeminiCall,
} from './externalGeminiRunner';
import { MAX_ARTICLE_COMPETITORS } from '../constants/competitors';

type ExternalEngineeringArticleRow = {
  id: string;
  status: string;
  title: string | null;
  plain_text: string | null;
  keywords: unknown;
  goal_context: unknown;
  article_language: string | null;
  metadata: unknown;
  updated_at: string;
};

type ExternalEngineeringStateRow = {
  article_id: string;
  external_analysis_ready: boolean;
  external_analysis_readiness_signature: string;
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

const toCompetitorSlots = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.slice(0, MAX_ARTICLE_COMPETITORS).map(toTrimmedString)
    : []
);

const createRetryError = (options: {
  code: string;
  message: string;
  progress?: ExternalAnalysisJson;
}): ExternalAnalysisRetryError => new ExternalAnalysisRetryError({
  code: options.code,
  message: options.message.slice(0, 2_000),
  progress: options.progress,
});

const readArticleAndState = async (articleId: string): Promise<{
  article: ExternalEngineeringArticleRow;
  state: ExternalEngineeringStateRow;
}> => {
  const supabase = getExternalAnalysisSupabaseAdmin();
  const [articleResult, stateResult] = await Promise.all([
    supabase
      .from('articles')
      .select('id,status,title,plain_text,keywords,goal_context,article_language,metadata,updated_at')
      .eq('id', articleId)
      .maybeSingle(),
    supabase
      .from('ai_external_analysis_article_state')
      .select('article_id,external_analysis_ready,external_analysis_readiness_signature')
      .eq('article_id', articleId)
      .maybeSingle(),
  ]);

  if (articleResult.error) throw articleResult.error;
  if (stateResult.error) throw stateResult.error;
  if (!articleResult.data) throw new Error(`Article ${articleId} was not found.`);
  if (!stateResult.data) throw new Error(`External analysis state for article ${articleId} was not found.`);

  return {
    article: articleResult.data as ExternalEngineeringArticleRow,
    state: stateResult.data as ExternalEngineeringStateRow,
  };
};

const isCurrentEngineeringJob = (
  context: ExternalAnalysisExecutionContext,
  state: ExternalEngineeringStateRow,
): boolean => (
  state.external_analysis_ready === true
  && Boolean(state.external_analysis_readiness_signature)
  && state.external_analysis_readiness_signature === context.job.readiness_signature
);

const toEngineeringPromptInput = (
  article: ExternalEngineeringArticleRow,
): ExternalEngineeringPromptInput => {
  const keywords = isRecord(article.keywords) ? article.keywords : {};
  const metadata = isRecord(article.metadata) ? article.metadata : {};
  const attachments = isRecord(metadata.attachments) ? metadata.attachments : {};
  const competitors = isRecord(attachments.competitors)
    ? attachments.competitors
    : isRecord(metadata.competitors)
      ? metadata.competitors
      : {};

  return {
    title: toTrimmedString(article.title),
    plainText: toTrimmedString(article.plain_text),
    articleLanguage: article.article_language === 'en' ? 'en' : 'ar',
    keywords: {
      primary: toTrimmedString(keywords.primary),
      secondaries: toStringList(keywords.secondaries),
      company: toTrimmedString(keywords.company),
      lsi: toStringList(keywords.lsi),
    },
    goalContext: isRecord(article.goal_context) ? article.goal_context : {},
    competitorUrls: toCompetitorSlots(competitors.urls),
    competitorTexts: toCompetitorSlots(competitors.texts),
  };
};

const assertEngineeringInputs = (
  input: ExternalEngineeringPromptInput,
): void => {
  if (!input.plainText) {
    throw createRetryError({
      code: 'engineering_article_text_missing',
      message: 'The article text is still empty; engineering analysis will retry later.',
      progress: { stage: 'retry_scheduled', reason: 'article_text_missing' },
    });
  }
  if (input.keywords.secondaries.length === 0 || input.keywords.lsi.length === 0) {
    throw createRetryError({
      code: 'engineering_semantic_terms_missing',
      message: 'Alternative forms and LSI terms must be ready before engineering analysis.',
      progress: { stage: 'retry_scheduled', reason: 'semantic_terms_missing' },
    });
  }
  if (
    !input.competitorUrls.some(Boolean)
    && !input.competitorTexts.some(Boolean)
  ) {
    throw createRetryError({
      code: 'engineering_competitor_input_missing',
      message: 'At least one competitor URL or text is required for external engineering analysis.',
      progress: { stage: 'retry_scheduled', reason: 'competitor_input_missing' },
    });
  }
};

const getJobCommandPosition = (
  context: ExternalAnalysisExecutionContext,
  fallbackSequence: number,
): { sequence: number; total: number } => {
  const snapshotTotal = Number(context.job.input_snapshot?.commandTotal);
  const sequence = Math.max(1, context.job.sequence_number || fallbackSequence);
  const total = Number.isFinite(snapshotTotal) && snapshotTotal > 0
    ? Math.max(sequence, Math.floor(snapshotTotal))
    : context.job.origin === 'auto'
      ? 5
      : sequence;
  return { sequence, total };
};

const executeExternalEngineeringAnalysis = async (
  context: ExternalAnalysisExecutionContext,
) => {
  const command = getExternalEngineeringCommand(context.job.command_id);
  if (!command) {
    throw createRetryError({
      code: 'engineering_command_not_registered',
      message: `Engineering command ${context.job.command_id || '-'} is not registered in this worker.`,
      progress: { stage: 'retry_scheduled', reason: 'command_not_registered' },
    });
  }
  const commandPosition = getJobCommandPosition(context, command.sequence);
  await context.reportProgress({
    progress: {
      stage: 'loading_engineering_context',
      commandSequence: commandPosition.sequence,
      commandTotal: commandPosition.total,
    },
  });

  const initial = await readArticleAndState(context.job.article_id);
  if (!isCurrentEngineeringJob(context, initial.state)) {
    return {
      result: {
        status: 'superseded',
        reason: 'external_readiness_changed',
        commandId: command.id,
        commandLabel: command.label,
        commandSequence: commandPosition.sequence,
      },
      progress: {
        stage: 'superseded',
        commandSequence: commandPosition.sequence,
        commandTotal: commandPosition.total,
      },
    };
  }

  const input = toEngineeringPromptInput(initial.article);
  const inputFingerprint = JSON.stringify(input);
  assertEngineeringInputs(input);
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
    prompt: buildExternalEngineeringPrompt(command, input, commandPosition),
    model: aiSettings.model,
    allowModelFallback: aiSettings.allowModelFallback,
    useUrlContext: input.competitorUrls.some(Boolean),
    requestIndex: 1,
  });
  attempts.push(...finalCall.attempts);
  await reportExternalGeminiCall(context, finalCall, attempts);

  if (!finalCall.ok) {
    throw createRetryError({
      code: `engineering_gemini_http_${finalCall.status}`,
      message: finalCall.error,
      progress: {
        stage: 'retry_scheduled',
        commandSequence: commandPosition.sequence,
        provider: finalCall.provider,
        model: finalCall.model,
        keyAttemptCount: attempts.length,
      },
    });
  }

  let parsed = parseExternalEngineeringResult(
    finalCall.text,
    command.id,
    commandPosition.sequence,
  );

  if (!hasUsableExternalEngineeringResult(parsed)) {
    await context.reportProgress({
      progress: {
        stage: 'repairing_engineering_response',
        commandSequence: commandPosition.sequence,
        commandTotal: commandPosition.total,
      },
      provider: finalCall.provider,
      model: finalCall.model,
      keyAttempts: attempts,
    });
    finalCall = await runExternalGeminiCall({
      context,
      prompt: buildExternalEngineeringRepairPrompt(finalCall.text),
      model: aiSettings.model,
      allowModelFallback: aiSettings.allowModelFallback,
      requestIndex: 2,
    });
    attempts.push(...finalCall.attempts);
    await reportExternalGeminiCall(context, finalCall, attempts);

    if (!finalCall.ok) {
      throw createRetryError({
        code: `engineering_repair_http_${finalCall.status}`,
        message: finalCall.error,
        progress: {
          stage: 'retry_scheduled',
          commandSequence: commandPosition.sequence,
          provider: finalCall.provider,
          model: finalCall.model,
          keyAttemptCount: attempts.length,
        },
      });
    }

    parsed = parseExternalEngineeringResult(
      finalCall.text,
      command.id,
      commandPosition.sequence,
    );
  }

  if (!hasUsableExternalEngineeringResult(parsed)) {
    throw createRetryError({
      code: 'engineering_response_invalid',
      message: 'Gemini did not return a usable engineering report after one repair request.',
      progress: {
        stage: 'retry_scheduled',
        commandSequence: commandPosition.sequence,
        reason: 'engineering_response_invalid',
        keyAttemptCount: attempts.length,
      },
    });
  }

  const latest = await readArticleAndState(context.job.article_id);
  if (!isCurrentEngineeringJob(context, latest.state)) {
    return {
      result: {
        status: 'superseded',
        reason: 'external_readiness_changed_during_analysis',
        commandId: command.id,
        commandLabel: command.label,
        commandSequence: commandPosition.sequence,
        generated: parsed,
      },
      progress: {
        stage: 'superseded',
        commandSequence: commandPosition.sequence,
        commandTotal: commandPosition.total,
      },
    };
  }
  if (JSON.stringify(toEngineeringPromptInput(latest.article)) !== inputFingerprint) {
    throw createRetryError({
      code: 'engineering_input_changed_during_analysis',
      message: 'The article or competitor input changed while the engineering command was running.',
      progress: {
        stage: 'retry_scheduled',
        commandSequence: commandPosition.sequence,
        reason: 'engineering_input_changed',
      },
    });
  }

  return {
    result: {
      status: 'completed',
      commandId: command.id,
      commandLabel: command.label,
      commandSequence: commandPosition.sequence,
      commandTotal: commandPosition.total,
      analysisMarkdown: parsed.analysisMarkdown,
      patches: parsed.patches,
      rawResponse: finalCall.text.slice(0, 60_000),
      provider: finalCall.provider,
      model: finalCall.model,
      keySuffix: finalCall.keySuffix,
      keyAttempts: attempts,
      sourceArticleUpdatedAt: initial.article.updated_at,
      completedAt: new Date().toISOString(),
    },
    progress: {
      stage: 'engineering_completed',
      commandSequence: commandPosition.sequence,
      commandTotal: commandPosition.total,
      provider: finalCall.provider,
      model: finalCall.model,
      keySuffix: finalCall.keySuffix,
      keyAttemptCount: attempts.length,
    },
  };
};

registerExternalAnalysisJobExecutor(
  'engineering_command',
  executeExternalEngineeringAnalysis,
);
