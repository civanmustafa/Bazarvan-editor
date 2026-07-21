import {
  CONTENT_WRITING_WORKFLOW_VERSION,
  assembleContentWritingDraft,
  buildContentWritingConclusionPrompt,
  buildContentWritingFaqPrompt,
  buildContentWritingFinalReviewPrompt,
  buildContentWritingIntroductionPrompt,
  buildContentWritingOutlinePrompt,
  buildContentWritingSectionPrompt,
  createContentWritingWorkflowSteps,
  getContentWritingOutlineStep,
  normalizeContentWritingOutline,
  normalizeFinalContentWritingResult,
  parseContentWritingOutline,
  type ContentWritingOutline,
  type ContentWritingWorkflowStepDefinition,
} from '../utils/contentWritingWorkflow';
import {
  executeContentWritingTurn,
  type ContentWritingExecutionResult,
} from './contentWritingEngine';
import {
  completeContentWritingStep,
  ensureContentWritingStep,
  failContentWritingStep,
  getContentWritingSteps,
  startContentWritingStep,
  type ContentWritingMessage,
  type ContentWritingSession,
  type ContentWritingStep,
} from './contentWritingSessionService';

type JsonObject = Record<string, unknown>;

type StructuredWorkflowOptions = {
  session: ContentWritingSession;
  messages: ContentWritingMessage[];
  workerId: string;
  signal?: AbortSignal;
  onProgress?: (progress: JsonObject) => void;
};

type StepRunResult =
  | { ok: true; step: ContentWritingStep; output: string; execution?: ContentWritingExecutionResult }
  | { ok: false; execution: ContentWritingExecutionResult };

const isRecord = (value: unknown): value is JsonObject => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const getArticleSnapshot = (session: ContentWritingSession): { title: string; language: string } => {
  const article = isRecord(session.context_snapshot?.article) ? session.context_snapshot.article : {};
  return {
    title: toText(article.title).replace(/[\r\n]+/g, ' ') || 'Untitled article',
    language: toText(article.language) === 'en' ? 'en' : 'ar',
  };
};

const getCompletedCount = (steps: Iterable<ContentWritingStep>): number => (
  Array.from(steps).filter(step => step.status === 'completed').length
);

const createWorkflowFailure = (options: {
  session: ContentWritingSession;
  status: number;
  code: string;
  message: string;
  step: ContentWritingWorkflowStepDefinition;
  metadata?: JsonObject;
}): ContentWritingExecutionResult => ({
  ok: false,
  status: options.status,
  text: '',
  model: options.session.model,
  metadata: {
    provider: options.session.provider,
    workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
    workflowStepKey: options.step.key,
    workflowStepType: options.step.type,
    ...(options.metadata || {}),
  },
  errorCode: options.code,
  errorMessage: options.message,
});

const getPersistedExecution = (step: ContentWritingStep): {
  model?: string;
  conversationId?: string;
  keySuffix?: string;
  status?: number;
} => {
  const execution = isRecord(step.metadata?.execution) ? step.metadata.execution : {};
  return {
    model: toText(execution.model) || undefined,
    conversationId: toText(execution.conversationId) || undefined,
    keySuffix: toText(execution.keySuffix) || undefined,
    status: Number.isFinite(Number(execution.status)) ? Number(execution.status) : undefined,
  };
};

const getExecutionMetadata = (
  result: ContentWritingExecutionResult,
  extra: JsonObject = {},
): JsonObject => ({
  workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
  execution: {
    status: result.status,
    model: result.model,
    conversationId: result.conversationId || null,
    keySuffix: result.keySuffix || null,
    providerMetadata: result.metadata,
  },
  ...extra,
});

export const executeStructuredContentWritingWorkflow = async (
  options: StructuredWorkflowOptions,
): Promise<ContentWritingExecutionResult> => {
  const article = getArticleSnapshot(options.session);
  const stepMap = new Map(
    (await getContentWritingSteps(options.session.id, { includeContent: true, includeMetadata: true }))
      .map(step => [step.step_key, step]),
  );

  const emitProgress = (
    definition: ContentWritingWorkflowStepDefinition,
    stepIndex: number,
    stepCount: number,
    progress: JsonObject,
  ): void => {
    options.onProgress?.({
      ...progress,
      workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
      workflowStage: definition.type,
      workflowStepKey: definition.key,
      workflowStepLabel: definition.title,
      workflowStepIndex: stepIndex,
      workflowStepCount: stepCount,
      workflowCompletedSteps: getCompletedCount(stepMap.values()),
    });
  };

  const ensureStep = async (definition: ContentWritingWorkflowStepDefinition): Promise<ContentWritingStep> => {
    const persisted = await ensureContentWritingStep({
      sessionId: options.session.id,
      workerId: options.workerId,
      stepKey: definition.key,
      stepType: definition.type,
      ordinal: definition.ordinal,
      title: definition.title,
      metadata: definition.metadata,
    });
    if (!persisted) {
      throw new Error(`The worker no longer owns content writing step ${definition.key}.`);
    }
    stepMap.set(definition.key, persisted);
    return persisted;
  };

  const runStep = async (optionsForStep: {
    definition: ContentWritingWorkflowStepDefinition;
    prompt: string;
    stepIndex: number;
    stepCount: number;
    maxOutputTokens: number;
    processOutput?: (output: string) => { output: string; metadata?: JsonObject };
  }): Promise<StepRunResult> => {
    const definition = optionsForStep.definition;
    const existing = stepMap.get(definition.key) || await ensureStep(definition);
    if (existing.status === 'completed' && toText(existing.output_text)) {
      return { ok: true, step: existing, output: toText(existing.output_text) };
    }

    const running = await startContentWritingStep({
      sessionId: options.session.id,
      workerId: options.workerId,
      stepKey: definition.key,
      promptText: optionsForStep.prompt,
    });
    if (!running) {
      const latest = (await getContentWritingSteps(options.session.id, { includeContent: true, includeMetadata: true }))
        .find(step => step.step_key === definition.key);
      if (latest?.status === 'completed' && toText(latest.output_text)) {
        stepMap.set(definition.key, latest);
        return { ok: true, step: latest, output: toText(latest.output_text) };
      }
      throw new Error(`Could not start content writing step ${definition.key}.`);
    }
    stepMap.set(definition.key, running);
    emitProgress(definition, optionsForStep.stepIndex, optionsForStep.stepCount, {
      stage: 'workflow-step',
      provider: options.session.provider,
      model: options.session.model,
      message: `Generating ${definition.title} (${optionsForStep.stepIndex}/${optionsForStep.stepCount}).`,
      completed: false,
    });

    const execution = await executeContentWritingTurn({
      session: options.session,
      messages: options.messages,
      prompt: optionsForStep.prompt,
      stepKey: definition.key,
      stepLabel: definition.title,
      stepAttempt: running.attempt_count,
      includeGenerationRequestInHistory: true,
      maxOutputTokens: optionsForStep.maxOutputTokens,
      signal: options.signal,
      onProgress: progress => emitProgress(definition, optionsForStep.stepIndex, optionsForStep.stepCount, {
        ...progress,
        message: `${definition.title}: ${progress.message}`,
      }),
    });
    if (!execution.ok) {
      await failContentWritingStep({
        sessionId: options.session.id,
        workerId: options.workerId,
        stepKey: definition.key,
        errorCode: execution.errorCode || 'content_writing_step_failed',
        errorMessage: execution.errorMessage || `Content writing step ${definition.key} failed.`,
        metadata: getExecutionMetadata(execution),
      });
      return { ok: false, execution };
    }

    let processed: { output: string; metadata?: JsonObject };
    try {
      processed = optionsForStep.processOutput
        ? optionsForStep.processOutput(execution.text)
        : { output: execution.text };
      if (!toText(processed.output)) {
        throw new Error(`The ${definition.title} step returned an empty usable output.`);
      }
      processed.output = processed.output.trim();
    } catch (error) {
      const failure = createWorkflowFailure({
        session: options.session,
        status: 422,
        code: 'content_writing_step_output_invalid',
        message: error instanceof Error ? error.message : `Invalid output for ${definition.title}.`,
        step: definition,
      });
      await failContentWritingStep({
        sessionId: options.session.id,
        workerId: options.workerId,
        stepKey: definition.key,
        errorCode: failure.errorCode || 'content_writing_step_output_invalid',
        errorMessage: failure.errorMessage || 'The content writing step returned invalid output.',
        outputText: execution.text,
        metadata: getExecutionMetadata(execution),
      });
      return { ok: false, execution: failure };
    }

    const completed = await completeContentWritingStep({
      sessionId: options.session.id,
      workerId: options.workerId,
      stepKey: definition.key,
      outputText: processed.output,
      metadata: getExecutionMetadata(execution, processed.metadata),
    });
    if (!completed) throw new Error(`Could not complete content writing step ${definition.key}.`);
    stepMap.set(definition.key, completed);
    emitProgress(definition, optionsForStep.stepIndex, optionsForStep.stepCount, {
      stage: 'workflow-step-completed',
      provider: options.session.provider,
      model: execution.model,
      message: `Completed ${definition.title} (${optionsForStep.stepIndex}/${optionsForStep.stepCount}).`,
      completed: false,
    });
    return { ok: true, step: completed, output: processed.output, execution };
  };

  const outlineDefinition = getContentWritingOutlineStep();
  await ensureStep(outlineDefinition);
  const outlineResult = await runStep({
    definition: outlineDefinition,
    prompt: buildContentWritingOutlinePrompt({ articleTitle: article.title, language: article.language }),
    stepIndex: 1,
    stepCount: 1,
    maxOutputTokens: 4_000,
    processOutput: output => {
      const outline = parseContentWritingOutline(output);
      return { output, metadata: { outline } };
    },
  });
  if (!outlineResult.ok) return outlineResult.execution;
  const outline = normalizeContentWritingOutline(outlineResult.step.metadata?.outline)
    || normalizeContentWritingOutline(outlineResult.output);
  if (!outline) {
    return createWorkflowFailure({
      session: options.session,
      status: 422,
      code: 'content_writing_outline_invalid',
      message: 'The persisted content writing outline is invalid.',
      step: outlineDefinition,
    });
  }

  const definitions = createContentWritingWorkflowSteps(outline);
  for (const definition of definitions) {
    if (definition.key !== 'outline') await ensureStep(definition);
  }
  const outputs: Record<string, string> = {};
  outputs.outline = outlineResult.output;

  const sectionDefinitions = definitions.filter(definition => definition.type === 'section');
  for (let index = 0; index < sectionDefinitions.length; index += 1) {
    const definition = sectionDefinitions[index];
    const result = await runStep({
      definition,
      prompt: buildContentWritingSectionPrompt({
        outline,
        section: outline.sections[index],
        sectionIndex: index,
        previousSection: index > 0 ? outputs[sectionDefinitions[index - 1].key] : undefined,
      }),
      stepIndex: definition.ordinal,
      stepCount: definitions.length,
      maxOutputTokens: 8_000,
    });
    if (!result.ok) return result.execution;
    outputs[definition.key] = result.output;
  }

  const introductionDefinition = definitions.find(definition => definition.type === 'introduction')!;
  const bodyDraft = assembleContentWritingDraft({
    articleTitle: article.title,
    language: article.language,
    outline,
    outputs,
    includeFaq: false,
  });
  const introductionResult = await runStep({
    definition: introductionDefinition,
    prompt: buildContentWritingIntroductionPrompt({ outline, bodyDraft }),
    stepIndex: introductionDefinition.ordinal,
    stepCount: definitions.length,
    maxOutputTokens: 4_000,
  });
  if (!introductionResult.ok) return introductionResult.execution;
  outputs.introduction = introductionResult.output;

  const conclusionDefinition = definitions.find(definition => definition.type === 'conclusion')!;
  const introductionAndBodyDraft = assembleContentWritingDraft({
    articleTitle: article.title,
    language: article.language,
    outline,
    outputs,
    includeFaq: false,
  });
  const conclusionResult = await runStep({
    definition: conclusionDefinition,
    prompt: buildContentWritingConclusionPrompt({ outline, draft: introductionAndBodyDraft }),
    stepIndex: conclusionDefinition.ordinal,
    stepCount: definitions.length,
    maxOutputTokens: 4_000,
  });
  if (!conclusionResult.ok) return conclusionResult.execution;
  outputs.conclusion = conclusionResult.output;

  const faqDefinition = definitions.find(definition => definition.type === 'faq')!;
  const articleWithoutFaq = assembleContentWritingDraft({
    articleTitle: article.title,
    language: article.language,
    outline,
    outputs,
    includeFaq: false,
  });
  const faqResult = await runStep({
    definition: faqDefinition,
    prompt: buildContentWritingFaqPrompt({ outline, draft: articleWithoutFaq }),
    stepIndex: faqDefinition.ordinal,
    stepCount: definitions.length,
    maxOutputTokens: 6_000,
  });
  if (!faqResult.ok) return faqResult.execution;
  outputs.faq = faqResult.output;

  const assembledDraft = assembleContentWritingDraft({
    articleTitle: article.title,
    language: article.language,
    outline,
    outputs,
  });
  const finalDefinition = definitions.find(definition => definition.type === 'final_review')!;
  const finalResult = await runStep({
    definition: finalDefinition,
    prompt: buildContentWritingFinalReviewPrompt({ articleTitle: article.title, draft: assembledDraft }),
    stepIndex: finalDefinition.ordinal,
    stepCount: definitions.length,
    maxOutputTokens: 32_000,
    processOutput: output => ({ output: normalizeFinalContentWritingResult(output) }),
  });
  if (!finalResult.ok) return finalResult.execution;

  const persistedExecution = getPersistedExecution(finalResult.step);
  const execution = finalResult.execution;
  return {
    ok: true,
    status: execution?.status || persistedExecution.status || 200,
    text: finalResult.output,
    model: execution?.model || persistedExecution.model || options.session.model,
    conversationId: execution?.conversationId || persistedExecution.conversationId,
    keySuffix: execution?.keySuffix || persistedExecution.keySuffix,
    metadata: {
      provider: options.session.provider,
      structured: true,
      workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
      stepCount: definitions.length,
      completedStepCount: getCompletedCount(stepMap.values()),
      finalStepKey: finalDefinition.key,
    },
  };
};
