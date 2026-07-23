import {
  CONTENT_WRITING_WORKFLOW_VERSION,
  assembleContentWritingDraft,
  buildContentWritingCompetitorIndexPrompt,
  buildContentWritingConclusionPrompt,
  buildContentWritingCoverageAuditPrompt,
  buildContentWritingFaqPrompt,
  buildContentWritingFinalReviewPrompt,
  buildContentWritingIntroductionPrompt,
  buildContentWritingOutlinePrompt,
  buildContentWritingSectionRepairPrompt,
  buildContentWritingSectionPrompt,
  createContentWritingWorkflowSteps,
  ensureContentWritingOutlineKnowledgeCoverage,
  getContentWritingCompetitorIndexStep,
  getContentWritingOutlineStep,
  normalizeContentWritingOutline,
  normalizeFinalContentWritingResult,
  parseContentWritingOutline,
  type ContentWritingOutline,
  type ContentWritingWorkflowStepDefinition,
} from '../utils/contentWritingWorkflow';
import {
  contentWritingKnowledgeToPromptJson,
  normalizeContentWritingKnowledgeBase,
  normalizeContentWritingSectionCoverage,
  normalizeContentWritingSourceChunks,
  parseContentWritingCoverageAudit,
  parseContentWritingKnowledgeBase,
  parseContentWritingSectionResult,
  selectRelevantContentWritingChunks,
  summarizeContentWritingCoverage,
  type ContentWritingCoverageAudit,
  type ContentWritingKnowledgeBase,
  type ContentWritingSectionCoverage,
  type ContentWritingSourceChunk,
} from '../utils/contentWritingKnowledge';
import {
  buildContentWritingQualityContract,
  normalizeContentWritingQualityConfiguration,
  type ContentWritingQualityConfiguration,
} from '../constants/contentWritingQuality';
import {
  buildContentWritingRepairPrompt,
  evaluateContentWritingQuality,
  type ContentWritingQualityReport,
} from '../utils/contentWritingQuality';
import { normalizeGoalContext } from '../utils/goalContext';
import type { GoalContext, Keywords } from '../types';
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
import { sumAiUsage } from './aiUsage';

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

const toTextList = (value: unknown): string[] => Array.isArray(value)
  ? value.map(toText).filter(Boolean)
  : [];

type QualityRuntime = {
  configuration: ContentWritingQualityConfiguration;
  contract: string;
  keywords: Keywords;
  goalContext: GoalContext;
};

const getQualityRuntime = (
  session: ContentWritingSession,
  language: string,
): QualityRuntime | null => {
  const source = isRecord(session.context_snapshot?.qualityInput)
    ? session.context_snapshot.qualityInput
    : null;
  if (!source) return null;
  const keywordSource = isRecord(source.keywords) ? source.keywords : {};
  const goalSource = isRecord(source.goalContext) ? source.goalContext : {};
  const keywords: Keywords = {
    primary: toText(keywordSource.primary),
    secondaries: toTextList(keywordSource.secondaries),
    company: toText(keywordSource.company),
    lsi: toTextList(keywordSource.lsi),
  };
  if (!keywords.primary) return null;
  const goalContext = normalizeGoalContext(goalSource);
  const configuration = normalizeContentWritingQualityConfiguration(
    isRecord(session.context_snapshot?.qualityConfiguration)
      ? session.context_snapshot.qualityConfiguration
      : {},
  );
  const persistedContract = toText(session.context_snapshot?.qualityContract);
  return {
    configuration,
    contract: persistedContract || buildContentWritingQualityContract({
      configuration,
      language,
      goalContext,
    }),
    keywords,
    goalContext,
  };
};

const getArticleSnapshot = (session: ContentWritingSession): { title: string; language: string } => {
  const article = isRecord(session.context_snapshot?.article) ? session.context_snapshot.article : {};
  return {
    title: toText(article.title).replace(/[\r\n]+/g, ' ') || 'Untitled article',
    language: toText(article.language) === 'en' ? 'en' : 'ar',
  };
};

const getCompetitorChunks = (session: ContentWritingSession): ContentWritingSourceChunk[] => (
  normalizeContentWritingSourceChunks(session.context_snapshot?.competitorChunks)
);

const buildCompactArticleContext = (
  session: ContentWritingSession,
  knowledge: ContentWritingKnowledgeBase,
): string => {
  const base = toText(session.context_snapshot?.compactArticleContextBase);
  return `${base || 'Use the persisted article, keyword, goal, and audience context for this session.'}

<persisted_competitor_knowledge_index>
${contentWritingKnowledgeToPromptJson(knowledge)}
</persisted_competitor_knowledge_index>`;
};

const getStepUsage = (step: ContentWritingStep): unknown => {
  const execution = isRecord(step.metadata?.execution) ? step.metadata.execution : {};
  const providerMetadata = isRecord(execution.providerMetadata) ? execution.providerMetadata : {};
  return providerMetadata.usage;
};

const getWorkflowUsage = (steps: Iterable<ContentWritingStep>) => {
  const completedSteps = Array.from(steps).filter(step => step.status === 'completed');
  return {
    ...sumAiUsage(completedSteps.map(getStepUsage)),
    apiRequestCount: completedSteps.filter(step => {
      const usage = getStepUsage(step);
      return isRecord(usage) && Number(usage.totalTokens) > 0;
    }).length,
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
  const qualityRuntime = getQualityRuntime(options.session, article.language);
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
    articleContextOverride?: string;
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
      articleContextOverride: optionsForStep.articleContextOverride,
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

  const competitorChunks = getCompetitorChunks(options.session);
  const competitorIndexDefinition = getContentWritingCompetitorIndexStep();
  if (competitorChunks.length === 0) {
    return createWorkflowFailure({
      session: options.session,
      status: 422,
      code: 'content_writing_competitor_chunks_missing',
      message: 'The session does not contain the competitor source chunks required by workflow version 3.',
      step: competitorIndexDefinition,
    });
  }

  await ensureStep(competitorIndexDefinition);
  const competitorIndexResult = await runStep({
    definition: competitorIndexDefinition,
    prompt: buildContentWritingCompetitorIndexPrompt({
      chunks: competitorChunks,
      language: article.language,
    }),
    stepIndex: competitorIndexDefinition.ordinal,
    stepCount: 2,
    maxOutputTokens: 12_000,
    processOutput: output => {
      const knowledge = parseContentWritingKnowledgeBase(output, competitorChunks);
      return {
        output,
        metadata: {
          knowledge,
          sourceChunkCount: competitorChunks.length,
          modelIndexedChunkCount: knowledge.modelProcessedChunkIds.length,
          fallbackChunkCount: knowledge.fallbackChunkIds.length,
        },
      };
    },
  });
  if (!competitorIndexResult.ok) return competitorIndexResult.execution;
  const knowledge = normalizeContentWritingKnowledgeBase(
    competitorIndexResult.step.metadata?.knowledge || competitorIndexResult.output,
    competitorChunks,
  );
  if (knowledge.items.length === 0) {
    return createWorkflowFailure({
      session: options.session,
      status: 422,
      code: 'content_writing_competitor_index_invalid',
      message: 'The persisted competitor knowledge index is invalid.',
      step: competitorIndexDefinition,
    });
  }
  const compactArticleContext = buildCompactArticleContext(options.session, knowledge);

  const outlineDefinition = getContentWritingOutlineStep();
  await ensureStep(outlineDefinition);
  const outlineResult = await runStep({
    definition: outlineDefinition,
    prompt: buildContentWritingOutlinePrompt({
      articleTitle: article.title,
      language: article.language,
      knowledge,
      qualityContract: qualityRuntime?.contract,
      minimumSections: qualityRuntime?.configuration.policy.outlineSections.min,
      maximumSections: qualityRuntime?.configuration.policy.outlineSections.max,
    }),
    stepIndex: outlineDefinition.ordinal,
    stepCount: 2,
    maxOutputTokens: 6_000,
    articleContextOverride: compactArticleContext,
    processOutput: output => {
      const parsedOutline = parseContentWritingOutline(output);
      if (qualityRuntime && (
        parsedOutline.sections.length < qualityRuntime.configuration.policy.outlineSections.min
        || parsedOutline.sections.length > qualityRuntime.configuration.policy.outlineSections.max
      )) {
        throw new Error(
          `The outline must contain ${qualityRuntime.configuration.policy.outlineSections.min}-${qualityRuntime.configuration.policy.outlineSections.max} sections for quality policy ${qualityRuntime.configuration.policyVersion}.`,
        );
      }
      const coveredOutline = ensureContentWritingOutlineKnowledgeCoverage(parsedOutline, knowledge);
      return { output: JSON.stringify(coveredOutline, null, 2), metadata: { outline: coveredOutline } };
    },
  });
  if (!outlineResult.ok) return outlineResult.execution;
  const normalizedOutline = normalizeContentWritingOutline(outlineResult.step.metadata?.outline)
    || normalizeContentWritingOutline(outlineResult.output);
  const outline = normalizedOutline
    ? ensureContentWritingOutlineKnowledgeCoverage(normalizedOutline, knowledge)
    : null;
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
    if (
      definition.key !== 'competitor-index'
      && definition.key !== 'outline'
      && definition.key !== 'final-review'
    ) {
      await ensureStep(definition);
    }
  }
  const outputs: Record<string, string> = {
    'competitor-index': competitorIndexResult.output,
    outline: outlineResult.output,
  };
  const sectionCoverageByKey = new Map<string, ContentWritingSectionCoverage>();

  const sectionDefinitions = definitions.filter(definition => definition.type === 'section');
  for (let index = 0; index < sectionDefinitions.length; index += 1) {
    const definition = sectionDefinitions[index];
    const section = outline.sections[index];
    const requiredIdeaIds = section.requiredIdeaIds || [];
    const relevantChunks = selectRelevantContentWritingChunks({
      title: section.title,
      brief: section.brief,
      requiredIdeaIds,
      knowledge,
      chunks: competitorChunks,
    });
    const result = await runStep({
      definition,
      prompt: buildContentWritingSectionPrompt({
        outline,
        section,
        sectionIndex: index,
        previousSection: index > 0 ? outputs[sectionDefinitions[index - 1].key] : undefined,
        knowledgeItems: knowledge.items.filter(item => requiredIdeaIds.includes(item.id)),
        sourceChunks: relevantChunks,
        coverageLedger: {
          coveredIdeaIds: Array.from(sectionCoverageByKey.values())
            .flatMap(coverage => coverage.coveredIdeaIds),
          previousSectionSummaries: sectionDefinitions.slice(0, index).map(previousDefinition => ({
            sectionKey: previousDefinition.key,
            title: previousDefinition.title,
            coveredIdeaIds: sectionCoverageByKey.get(previousDefinition.key)?.coveredIdeaIds || [],
          })),
        },
      }),
      stepIndex: definition.ordinal,
      stepCount: definitions.length,
      maxOutputTokens: 8_000,
      articleContextOverride: compactArticleContext,
      processOutput: output => {
        const parsed = parseContentWritingSectionResult(
          output,
          knowledge.items.map(item => item.id),
          competitorChunks.map(chunk => chunk.id),
        );
        return { output: parsed.markdown, metadata: { sectionCoverage: parsed.coverage } };
      },
    });
    if (!result.ok) return result.execution;
    outputs[definition.key] = result.output;
    sectionCoverageByKey.set(
      definition.key,
      normalizeContentWritingSectionCoverage(result.step.metadata?.sectionCoverage),
    );
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
    articleContextOverride: compactArticleContext,
  });
  if (!introductionResult.ok) return introductionResult.execution;
  outputs.introduction = introductionResult.output;

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
    articleContextOverride: compactArticleContext,
  });
  if (!faqResult.ok) return faqResult.execution;
  outputs.faq = faqResult.output;

  const conclusionDefinition = definitions.find(definition => definition.type === 'conclusion')!;
  const introductionBodyAndFaqDraft = assembleContentWritingDraft({
    articleTitle: article.title,
    language: article.language,
    outline,
    outputs,
  });
  const conclusionResult = await runStep({
    definition: conclusionDefinition,
    prompt: buildContentWritingConclusionPrompt({ outline, draft: introductionBodyAndFaqDraft }),
    stepIndex: conclusionDefinition.ordinal,
    stepCount: definitions.length,
    maxOutputTokens: 4_000,
    articleContextOverride: compactArticleContext,
  });
  if (!conclusionResult.ok) return conclusionResult.execution;
  outputs.conclusion = conclusionResult.output;

  const coverageBeforeAudit = summarizeContentWritingCoverage({
    knowledge,
    sectionCoverages: Array.from(sectionCoverageByKey.values()),
  });
  const draftBeforeAudit = assembleContentWritingDraft({
    articleTitle: article.title,
    language: article.language,
    outline,
    outputs,
  });
  const coverageAuditDefinition = definitions.find(definition => definition.type === 'coverage_audit')!;
  const coverageAuditResult = await runStep({
    definition: coverageAuditDefinition,
    prompt: buildContentWritingCoverageAuditPrompt({
      outline,
      knowledge,
      draft: draftBeforeAudit,
      sectionCoverages: sectionDefinitions.map(definition => ({
        sectionKey: definition.key,
        title: definition.title,
        coverage: sectionCoverageByKey.get(definition.key) || {
          coveredIdeaIds: [],
          usedSourceChunkIds: [],
        },
      })),
      deterministicMissingIdeaIds: coverageBeforeAudit.missingIdeaIds,
    }),
    stepIndex: coverageAuditDefinition.ordinal,
    stepCount: definitions.length,
    maxOutputTokens: 6_000,
    articleContextOverride: compactArticleContext,
    processOutput: output => {
      const audit = parseContentWritingCoverageAudit(output, {
        validIdeaIds: knowledge.items.map(item => item.id),
        validChunkIds: competitorChunks.map(chunk => chunk.id),
        validSectionKeys: sectionDefinitions.map(definition => definition.key),
      });
      return { output, metadata: { coverageAudit: audit, deterministicCoverage: coverageBeforeAudit } };
    },
  });
  if (!coverageAuditResult.ok) return coverageAuditResult.execution;
  const coverageAudit = parseContentWritingCoverageAudit(
    JSON.stringify(coverageAuditResult.step.metadata?.coverageAudit || coverageAuditResult.output),
    {
      validIdeaIds: knowledge.items.map(item => item.id),
      validChunkIds: competitorChunks.map(chunk => chunk.id),
      validSectionKeys: sectionDefinitions.map(definition => definition.key),
    },
  );

  for (let repairIndex = 0; repairIndex < coverageAudit.repairs.length; repairIndex += 1) {
    const repair = coverageAudit.repairs[repairIndex];
    const sectionIndex = sectionDefinitions.findIndex(definition => definition.key === repair.sectionKey);
    if (sectionIndex < 0) continue;
    const sourceChunkIdSet = new Set(repair.sourceChunkIds);
    const selectedChunks = selectRelevantContentWritingChunks({
      title: outline.sections[sectionIndex].title,
      brief: `${outline.sections[sectionIndex].brief}\n${repair.instructions}`,
      requiredIdeaIds: repair.ideaIds,
      knowledge,
      chunks: competitorChunks,
    });
    const repairChunks = [
      ...competitorChunks.filter(chunk => sourceChunkIdSet.has(chunk.id)),
      ...selectedChunks,
    ].filter((chunk, index, list) => list.findIndex(candidate => candidate.id === chunk.id) === index);
    const repairDefinition: ContentWritingWorkflowStepDefinition = {
      key: `section-repair-${String(repairIndex + 1).padStart(2, '0')}`,
      type: 'section_repair',
      ordinal: coverageAuditDefinition.ordinal + repairIndex + 1,
      title: `Targeted repair: ${sectionDefinitions[sectionIndex].title}`,
      metadata: {
        workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
        sectionKey: repair.sectionKey,
        repair,
      },
    };
    await ensureStep(repairDefinition);
    const repairResult = await runStep({
      definition: repairDefinition,
      prompt: buildContentWritingSectionRepairPrompt({
        outline,
        section: outline.sections[sectionIndex],
        sectionKey: repair.sectionKey,
        originalMarkdown: outputs[repair.sectionKey],
        repair,
        knowledgeItems: knowledge.items.filter(item => repair.ideaIds.includes(item.id)),
        sourceChunks: repairChunks,
      }),
      stepIndex: repairDefinition.ordinal,
      stepCount: definitions.length + coverageAudit.repairs.length,
      maxOutputTokens: 8_000,
      articleContextOverride: compactArticleContext,
      processOutput: output => {
        const parsed = parseContentWritingSectionResult(
          output,
          knowledge.items.map(item => item.id),
          competitorChunks.map(chunk => chunk.id),
        );
        return {
          output: parsed.markdown,
          metadata: { sectionCoverage: parsed.coverage, repairedSectionKey: repair.sectionKey },
        };
      },
    });
    if (!repairResult.ok) return repairResult.execution;
    outputs[repair.sectionKey] = repairResult.output;
    const previousCoverage = sectionCoverageByKey.get(repair.sectionKey) || {
      coveredIdeaIds: [],
      usedSourceChunkIds: [],
    };
    const repairedCoverage = normalizeContentWritingSectionCoverage(
      repairResult.step.metadata?.sectionCoverage,
    );
    sectionCoverageByKey.set(repair.sectionKey, {
      coveredIdeaIds: Array.from(new Set([
        ...previousCoverage.coveredIdeaIds,
        ...repairedCoverage.coveredIdeaIds,
      ])),
      usedSourceChunkIds: Array.from(new Set([
        ...previousCoverage.usedSourceChunkIds,
        ...repairedCoverage.usedSourceChunkIds,
      ])),
    });
  }

  const coverageAfterRepairs = summarizeContentWritingCoverage({
    knowledge,
    sectionCoverages: Array.from(sectionCoverageByKey.values()),
  });
  const assembledDraft = assembleContentWritingDraft({
    articleTitle: article.title,
    language: article.language,
    outline,
    outputs,
  });
  const baseFinalDefinition = definitions.find(definition => definition.type === 'final_review')!;
  const finalDefinition: ContentWritingWorkflowStepDefinition = {
    ...baseFinalDefinition,
    ordinal: coverageAuditDefinition.ordinal + coverageAudit.repairs.length + 1,
  };
  await ensureStep(finalDefinition);
  const finalResult = await runStep({
    definition: finalDefinition,
    prompt: buildContentWritingFinalReviewPrompt({
      articleTitle: article.title,
      draft: assembledDraft,
      knowledge,
      coverageAudit,
      qualityContract: qualityRuntime?.contract,
    }),
    stepIndex: finalDefinition.ordinal,
    stepCount: definitions.length + coverageAudit.repairs.length,
    maxOutputTokens: 32_000,
    articleContextOverride: compactArticleContext,
    processOutput: output => ({ output: normalizeFinalContentWritingResult(output) }),
  });
  if (!finalResult.ok) return finalResult.execution;

  let finalOutput = finalResult.output;
  let finalStep = finalResult.step;
  let execution = finalResult.execution;
  let qualityReport: ContentWritingQualityReport | null = null;
  let repairPasses = 0;

  if (qualityRuntime) {
    let evaluation = evaluateContentWritingQuality({
      markdown: finalOutput,
      articleTitle: article.title,
      keywords: qualityRuntime.keywords,
      goalContext: qualityRuntime.goalContext,
      articleLanguage: article.language === 'en' ? 'en' : 'ar',
      configuration: qualityRuntime.configuration,
      repairPasses,
    });
    qualityReport = evaluation.report;

    for (
      let pass = 1;
      !qualityReport.passed && pass <= qualityRuntime.configuration.maxRepairPasses;
      pass += 1
    ) {
      const repairDefinition: ContentWritingWorkflowStepDefinition = {
        key: `quality-repair-${String(pass).padStart(2, '0')}`,
        type: 'quality_repair',
        ordinal: finalDefinition.ordinal + pass,
        title: `Quality repair ${pass}`,
        metadata: {
          workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
          qualityPolicyVersion: qualityRuntime.configuration.policyVersion,
          repairPass: pass,
        },
      };
      await ensureStep(repairDefinition);
      const repairResult = await runStep({
        definition: repairDefinition,
        prompt: buildContentWritingRepairPrompt({
          report: qualityReport,
          draft: finalOutput,
          qualityContract: qualityRuntime.contract,
          language: article.language === 'en' ? 'en' : 'ar',
        }),
        stepIndex: repairDefinition.ordinal,
        stepCount: definitions.length
          + coverageAudit.repairs.length
          + qualityRuntime.configuration.maxRepairPasses,
        maxOutputTokens: 32_000,
        articleContextOverride: compactArticleContext,
        processOutput: output => ({
          output: normalizeFinalContentWritingResult(output),
          metadata: { qualityReportBeforeRepair: qualityReport },
        }),
      });
      if (!repairResult.ok) return repairResult.execution;
      repairPasses = pass;
      finalOutput = repairResult.output;
      finalStep = repairResult.step;
      execution = repairResult.execution || execution;
      evaluation = evaluateContentWritingQuality({
        markdown: finalOutput,
        articleTitle: article.title,
        keywords: qualityRuntime.keywords,
        goalContext: qualityRuntime.goalContext,
        articleLanguage: article.language === 'en' ? 'en' : 'ar',
        configuration: qualityRuntime.configuration,
        repairPasses,
      });
      qualityReport = evaluation.report;
    }
  }

  const persistedExecution = getPersistedExecution(finalStep);
  const usage = getWorkflowUsage(stepMap.values());
  return {
    ok: true,
    status: execution?.status || persistedExecution.status || 200,
    text: finalOutput,
    model: execution?.model || persistedExecution.model || options.session.model,
    conversationId: execution?.conversationId || persistedExecution.conversationId,
    keySuffix: execution?.keySuffix || persistedExecution.keySuffix,
    metadata: {
      provider: options.session.provider,
      structured: true,
      workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
      stepCount: definitions.length + coverageAudit.repairs.length + repairPasses,
      completedStepCount: getCompletedCount(stepMap.values()),
      finalStepKey: finalStep.step_key,
      qualityPolicyVersion: qualityRuntime?.configuration.policyVersion || null,
      qualityGatePassed: qualityReport?.passed ?? null,
      qualityReport,
      qualityRepairCount: repairPasses,
      usage,
      knowledgeCoverage: {
        sourceChunkCount: competitorChunks.length,
        knowledgeItemCount: knowledge.items.length,
        modelIndexedChunkCount: knowledge.modelProcessedChunkIds.length,
        fallbackChunkCount: knowledge.fallbackChunkIds.length,
        beforeAuditPercent: coverageBeforeAudit.coveragePercent,
        afterRepairPercent: coverageAfterRepairs.coveragePercent,
        coveredIdeaCount: coverageAfterRepairs.coveredIdeaIds.length,
        missingIdeaIds: coverageAfterRepairs.missingIdeaIds,
        targetedRepairCount: coverageAudit.repairs.length,
      },
    },
  };
};
