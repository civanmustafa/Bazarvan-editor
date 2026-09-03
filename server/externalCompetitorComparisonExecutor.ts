import { createHash } from 'node:crypto';
import {
  ExternalAnalysisRetryError,
  type ExternalAnalysisExecutionContext,
} from './externalAnalysisExecutor';
import {
  getExternalAnalysisSupabaseAdmin,
  type ExternalAnalysisJson,
} from './externalAnalysisQueue';
import type { ExternalGeminiSettings } from './externalAnalysisSettings';
import type { ExternalEngineeringCommand } from './externalEngineeringCommands';
import {
  buildExternalEngineeringArticleContext,
  EXTERNAL_ENGINEERING_OUTPUT_CONTRACT,
  type ExternalEngineeringPromptInput,
} from './externalEngineeringPrompt';
import {
  parseExternalEngineeringResult,
  type ExternalEngineeringResult,
} from './externalEngineeringResult';
import {
  reportExternalGeminiCall,
  runExternalGeminiCall,
  type ExternalGeminiCallResult,
} from './externalGeminiRunner';
import {
  buildCompetitorComparisonMapPrompt,
  buildCompetitorComparisonSynthesisPrompt,
  buildCompetitorComparisonSynthesisRepairPrompt,
  combineCompetitorComparisonMapResults,
  COMPETITOR_COMPARISON_WORKFLOW_VERSION,
  createCompetitorComparisonBatches,
  getCompetitorComparisonExpectedItemIds,
  getCompetitorComparisonExpectedItems,
  parseCompetitorComparisonMapResponse,
  validateCompetitorComparisonSynthesisResponse,
  type CompetitorComparisonMapResult,
  type CompetitorComparisonSource,
} from '../utils/competitorComparisonWorkflow';
import { sanitizeCompetitorSlots } from '../utils/competitorContent';

type CompetitorMapCacheRow = {
  result: unknown;
  provider: string | null;
  model: string | null;
};

type CompetitorComparisonWorkflowResult = {
  parsed: ExternalEngineeringResult;
  finalCall: ExternalGeminiCallResult;
  attempts: ExternalAnalysisJson[];
  mapResults: CompetitorComparisonMapResult[];
  workflow: ExternalAnalysisJson;
};

const hasUsableCompetitorCardResult = (
  result: ExternalEngineeringResult,
): boolean => (
  result.parsedFromJson
  && result.invalidPatchCount === 0
);

const toTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const createRetryError = (options: {
  code: string;
  message: string;
  progress?: ExternalAnalysisJson;
}): ExternalAnalysisRetryError => new ExternalAnalysisRetryError({
  code: options.code,
  message: options.message.slice(0, 2_000),
  progress: options.progress,
});

const createSources = (input: ExternalEngineeringPromptInput): CompetitorComparisonSource[] => {
  const competitors = sanitizeCompetitorSlots(
    input.competitorTexts,
    input.competitorUrls,
  );
  return (
    Array.from(
    { length: Math.max(competitors.texts.length, competitors.urls.length) },
    (_, index) => ({
      competitorNumber: index + 1,
      url: competitors.urls[index] || '',
      title: '',
      text: competitors.texts[index] || '',
    }),
  ).filter(source => source.text || source.url)
  );
};

const attachSourceMetadata = (
  result: CompetitorComparisonMapResult,
  source: CompetitorComparisonSource,
): CompetitorComparisonMapResult => ({
  ...result,
  sourceUrl: source.url,
  sourceTitle: source.title,
});

const hasExactChunkCoverage = (
  result: CompetitorComparisonMapResult,
  expectedChunkIds: string[],
): boolean => {
  const actual = new Set(result.processedChunkIds);
  return (
    result.processedChunkIds.length === expectedChunkIds.length
    && expectedChunkIds.every(chunkId => actual.has(chunkId))
  );
};

const readCachedMapResult = async (options: {
  articleId: string;
  commandId: string;
  competitorNumber: number;
  articleSignature: string;
  competitorSignature: string;
  promptSignature: string;
  expectedChunkIds: string[];
}): Promise<CompetitorComparisonMapResult | null> => {
  const supabase = getExternalAnalysisSupabaseAdmin();
  const { data, error } = await supabase
    .from('ai_engineering_competitor_map_cache')
    .select('result,provider,model')
    .eq('article_id', options.articleId)
    .eq('command_id', options.commandId)
    .eq('competitor_number', options.competitorNumber)
    .eq('article_signature', options.articleSignature)
    .eq('competitor_signature', options.competitorSignature)
    .eq('prompt_signature', options.promptSignature)
    .maybeSingle();
  if (error) {
    if (error.code === '42P01') return null;
    throw error;
  }
  const row = data as CompetitorMapCacheRow | null;
  const result = row?.result as CompetitorComparisonMapResult | undefined;
  if (
    !result
    || result.competitorNumber !== options.competitorNumber
    || !Array.isArray(result.items)
    || !Array.isArray(result.processedChunkIds)
    || !hasExactChunkCoverage(result, options.expectedChunkIds)
  ) {
    return null;
  }
  void supabase
    .from('ai_engineering_competitor_map_cache')
    .update({ last_used_at: new Date().toISOString() })
    .eq('article_id', options.articleId)
    .eq('command_id', options.commandId)
    .eq('competitor_number', options.competitorNumber)
    .eq('article_signature', options.articleSignature)
    .eq('competitor_signature', options.competitorSignature)
    .eq('prompt_signature', options.promptSignature);
  return result;
};

const saveCachedMapResult = async (options: {
  articleId: string;
  commandId: string;
  competitorNumber: number;
  articleSignature: string;
  competitorSignature: string;
  promptSignature: string;
  source: CompetitorComparisonSource;
  result: CompetitorComparisonMapResult;
  provider: string;
  model: string;
}): Promise<void> => {
  const now = new Date().toISOString();
  const { error } = await getExternalAnalysisSupabaseAdmin()
    .from('ai_engineering_competitor_map_cache')
    .upsert({
      article_id: options.articleId,
      command_id: options.commandId,
      competitor_number: options.competitorNumber,
      article_signature: options.articleSignature,
      competitor_signature: options.competitorSignature,
      prompt_signature: options.promptSignature,
      source_url: options.source.url || null,
      source_chars: options.source.text.length,
      result: options.result,
      provider: options.provider,
      model: options.model,
      completed_at: now,
      last_used_at: now,
      updated_at: now,
    }, {
      onConflict: 'article_id,command_id,competitor_number,article_signature,competitor_signature,prompt_signature',
    });
  if (error && error.code !== '42P01') throw error;
};

export const executeExternalCompetitorComparisonWorkflow = async (options: {
  context: ExternalAnalysisExecutionContext;
  command: ExternalEngineeringCommand;
  input: ExternalEngineeringPromptInput;
  commandPosition: { sequence: number; total: number };
  aiSettings: ExternalGeminiSettings;
}): Promise<CompetitorComparisonWorkflowResult> => {
  const { context, command, input, commandPosition, aiSettings } = options;
  const sources = createSources(input);
  if (sources.length === 0) {
    throw createRetryError({
      code: 'engineering_competitor_input_missing',
      message: 'At least one competitor URL or text is required for competitor comparison.',
      progress: { stage: 'retry_scheduled', reason: 'competitor_input_missing' },
    });
  }

  const articleContext = buildExternalEngineeringArticleContext(command, input);
  const articleSignature = sha256(JSON.stringify({
    title: input.title,
    plainText: input.plainText,
    articleLanguage: input.articleLanguage,
    keywords: input.keywords,
    goalContext: input.goalContext,
  }));
  // Map results describe one competitor against the current article and are
  // independent of the user-editable final synthesis wording.
  const promptSignature = sha256(COMPETITOR_COMPARISON_WORKFLOW_VERSION);
  const attempts: ExternalAnalysisJson[] = [];
  const mapResults: CompetitorComparisonMapResult[] = [];
  let requestIndex = 0;
  let cacheHitCount = 0;
  let mapRequestCount = 0;

  for (const source of sources) {
    const batches = createCompetitorComparisonBatches(source);
    const expectedChunkIds = batches.flatMap(batch => batch.chunks.map(chunk => chunk.id));
    const competitorSignature = sha256(JSON.stringify(source));
    const cached = await readCachedMapResult({
      articleId: context.job.article_id,
      commandId: command.id,
      competitorNumber: source.competitorNumber,
      articleSignature,
      competitorSignature,
      promptSignature,
      expectedChunkIds,
    });
    if (cached) {
      cacheHitCount += 1;
      mapResults.push(attachSourceMetadata(cached, source));
      await context.reportProgress({
        progress: {
          stage: 'competitor_map_cache_hit',
          message: `اكتملت المقارنة المستقلة مع المنافس ${source.competitorNumber} من النتيجة المحفوظة.`,
          competitorCurrent: mapResults.length,
          competitorTotal: sources.length,
          competitorNumber: source.competitorNumber,
          cacheHitCount,
          independentCompetitorResults: mapResults,
        },
      });
      continue;
    }

    const batchResults: CompetitorComparisonMapResult[] = [];
    for (const batch of batches) {
      requestIndex += 1;
      mapRequestCount += 1;
      await context.reportProgress({
        progress: {
          stage: 'analyzing_competitor_independently',
          message: `جار تحليل المنافس ${source.competitorNumber} بصورة مستقلة (${mapResults.length + 1}/${sources.length}).`,
          commandSequence: commandPosition.sequence,
          commandTotal: commandPosition.total,
          competitorCurrent: mapResults.length + 1,
          competitorTotal: sources.length,
          competitorNumber: source.competitorNumber,
          sourceBatch: batchResults.length + 1,
          sourceBatchTotal: batches.length,
          cacheHitCount,
          independentCompetitorResults: mapResults,
        },
      });
      const mapPrompt = buildCompetitorComparisonMapPrompt({ articleContext, batch });
      console.info('[external-engineering] Independent competitor map prompt', {
        jobId: context.job.id,
        commandId: command.id,
        competitorNumber: source.competitorNumber,
        sourceBatch: batchResults.length + 1,
        sourceBatchTotal: batches.length,
        promptChars: mapPrompt.length,
        articleContextChars: articleContext.length,
        competitorChars: batch.chunks.reduce((total, chunk) => total + chunk.text.length, 0),
      });
      const mapCall = await runExternalGeminiCall({
        context,
        prompt: mapPrompt,
        model: aiSettings.model,
        allowModelFallback: aiSettings.allowModelFallback,
        requestIndex,
        useUrlContext: batch.useUrlContext,
      });
      attempts.push(...mapCall.attempts);
      await reportExternalGeminiCall(context, mapCall, attempts);
      if (!mapCall.ok) {
        throw createRetryError({
          code: `competitor_map_http_${mapCall.status}`,
          message: mapCall.error,
          progress: {
            stage: 'retry_scheduled',
            reason: 'competitor_map_failed',
            competitorNumber: source.competitorNumber,
            competitorCurrent: mapResults.length + 1,
            competitorTotal: sources.length,
            provider: mapCall.provider,
            model: mapCall.model,
          },
        });
      }
      const parsed = parseCompetitorComparisonMapResponse({
        responseText: mapCall.text,
        batch,
        itemOffset: batchResults.reduce((total, result) => total + result.items.length, 0),
      });
      if (!parsed.result) {
        throw createRetryError({
          code: 'competitor_map_response_invalid',
          message: `Competitor ${source.competitorNumber} did not return complete chunk coverage: ${parsed.errors.join(', ')}`,
          progress: {
            stage: 'retry_scheduled',
            reason: 'competitor_map_response_invalid',
            competitorNumber: source.competitorNumber,
            validationErrors: parsed.errors,
          },
        });
      }
      batchResults.push(parsed.result);
    }

    const combined = attachSourceMetadata(
      combineCompetitorComparisonMapResults(
        source.competitorNumber,
        batchResults,
      ),
      source,
    );
    const lastAttempt = attempts[attempts.length - 1] || {};
    await saveCachedMapResult({
      articleId: context.job.article_id,
      commandId: command.id,
      competitorNumber: source.competitorNumber,
      articleSignature,
      competitorSignature,
      promptSignature,
      source,
      result: combined,
      provider: toTrimmedString(lastAttempt.provider) || 'gemini',
      model: toTrimmedString(lastAttempt.model) || aiSettings.model,
    });
    mapResults.push(combined);
    await context.reportProgress({
      progress: {
        stage: 'competitor_map_completed',
        message: `اكتملت المقارنة المستقلة مع المنافس ${source.competitorNumber}.`,
        commandSequence: commandPosition.sequence,
        commandTotal: commandPosition.total,
        competitorCurrent: mapResults.length,
        competitorTotal: sources.length,
        competitorNumber: source.competitorNumber,
        cacheHitCount,
        independentCompetitorResults: mapResults,
      },
    });
  }

  await context.reportProgress({
    progress: {
      stage: 'synthesizing_competitor_results',
      message: 'اكتمل التحليل المستقل. جار دمج النتائج دلاليًا وإنشاء التعديلات النهائية.',
      commandSequence: commandPosition.sequence,
      commandTotal: commandPosition.total,
      competitorCurrent: sources.length,
      competitorTotal: sources.length,
      cacheHitCount,
      mapRequestCount,
      independentCompetitorResults: mapResults,
    },
  });
  const synthesisPrompt = buildCompetitorComparisonSynthesisPrompt({
    commandPrompt: command.prompt,
    articleContext,
    mapResults,
    outputContract: EXTERNAL_ENGINEERING_OUTPUT_CONTRACT,
  });
  requestIndex += 1;
  console.info('[external-engineering] Competitor synthesis prompt', {
    jobId: context.job.id,
    commandId: command.id,
    promptChars: synthesisPrompt.length,
    articleContextChars: articleContext.length,
    structuredCompetitorResultChars: JSON.stringify(mapResults).length,
    competitorCount: sources.length,
    itemCount: getCompetitorComparisonExpectedItemIds(mapResults).length,
    cacheHitCount,
  });
  let finalCall = await runExternalGeminiCall({
    context,
    prompt: synthesisPrompt,
    model: aiSettings.model,
    allowModelFallback: aiSettings.allowModelFallback,
    requestIndex,
  });
  attempts.push(...finalCall.attempts);
  await reportExternalGeminiCall(context, finalCall, attempts);
  if (!finalCall.ok) {
    throw createRetryError({
      code: `competitor_synthesis_http_${finalCall.status}`,
      message: finalCall.error,
      progress: {
        stage: 'retry_scheduled',
        reason: 'competitor_synthesis_failed',
        competitorTotal: sources.length,
        cacheHitCount,
        mapRequestCount,
      },
    });
  }

  const expectedItemIds = getCompetitorComparisonExpectedItemIds(mapResults);
  const expectedItems = getCompetitorComparisonExpectedItems(mapResults);
  let validation = validateCompetitorComparisonSynthesisResponse({
    responseText: finalCall.text,
    expectedItems,
  });
  let parsed = parseExternalEngineeringResult(
    finalCall.text,
    command.id,
    commandPosition.sequence,
  );
  if (!validation.ok || !hasUsableCompetitorCardResult(parsed)) {
    requestIndex += 1;
    await context.reportProgress({
      progress: {
        stage: 'repairing_competitor_synthesis',
        message: 'جار إصلاح تغطية نتائج المنافسين في الرد النهائي.',
        validationErrors: validation.errors,
        missingItemCount: validation.missingItemIds.length,
      },
    });
    finalCall = await runExternalGeminiCall({
      context,
      prompt: buildCompetitorComparisonSynthesisRepairPrompt({
        originalPrompt: synthesisPrompt,
        previousResponse: finalCall.text,
        validation,
      }),
      model: aiSettings.model,
      allowModelFallback: aiSettings.allowModelFallback,
      requestIndex,
    });
    attempts.push(...finalCall.attempts);
    await reportExternalGeminiCall(context, finalCall, attempts);
    if (!finalCall.ok) {
      throw createRetryError({
        code: `competitor_synthesis_repair_http_${finalCall.status}`,
        message: finalCall.error,
        progress: {
          stage: 'retry_scheduled',
          reason: 'competitor_synthesis_repair_failed',
        },
      });
    }
    validation = validateCompetitorComparisonSynthesisResponse({
      responseText: finalCall.text,
      expectedItems,
    });
    parsed = parseExternalEngineeringResult(
      finalCall.text,
      command.id,
      commandPosition.sequence,
    );
  }

  if (!validation.ok || !hasUsableCompetitorCardResult(parsed)) {
    throw createRetryError({
      code: 'competitor_synthesis_response_invalid',
      message: `Gemini did not cover every independent competitor result: ${validation.errors.join(', ')}`,
      progress: {
        stage: 'retry_scheduled',
        reason: 'competitor_synthesis_response_invalid',
        missingItemIds: validation.missingItemIds,
        unknownItemIds: validation.unknownItemIds,
        duplicateItemIds: validation.duplicateItemIds,
      },
    });
  }

  return {
    parsed: {
      ...parsed,
      // The comprehensive comparison is application-first: the user-facing
      // result is composed only of editor-ready cards, never a prose report.
      analysisMarkdown: '',
    },
    finalCall,
    attempts,
    mapResults,
    workflow: {
      mode: 'independent_per_competitor_ai_synthesis',
      version: COMPETITOR_COMPARISON_WORKFLOW_VERSION,
      competitorCount: sources.length,
      processedCompetitorNumbers: sources.map(source => source.competitorNumber),
      processedChunkCount: mapResults.reduce(
        (total, result) => total + result.processedChunkIds.length,
        0,
      ),
      processedItemCount: expectedItemIds.length,
      cacheHitCount,
      mapRequestCount,
      synthesisRequestCount: requestIndex - mapRequestCount,
      itemDispositions: validation.dispositions,
      clusters: validation.clusters,
    },
  };
};
