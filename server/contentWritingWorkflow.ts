import {
  CONTENT_WRITING_WORKFLOW_VERSION,
  auditContentWritingFinalSectionStructure,
  assembleContentWritingDraft,
  balanceContentWritingOutlineWordTargets,
  buildContentWritingCallToActionPrompt,
  buildContentWritingCompetitorIndexPrompt,
  buildContentWritingConclusionPrompt,
  buildContentWritingCoverageAuditPrompt,
  buildContentWritingFaqPrompt,
  buildContentWritingFinalReviewPrompt,
  buildContentWritingIntroductionPrompt,
  buildContentWritingKnowledgeReconciliationPrompt,
  buildContentWritingOutlinePrompt,
  buildContentWritingRevisionApplyPrompt,
  buildContentWritingSectionRepairPrompt,
  buildContentWritingSectionPrompt,
  createContentWritingWorkflowSteps,
  ensureContentWritingOutlineKnowledgeCoverage,
  fitContentWritingOutlineSectionRange,
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
  buildContentWritingKnowledgeEnsembleSummary,
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
  type ContentWritingKnowledgeEnsembleSummary,
  type ContentWritingSectionCoverage,
  type ContentWritingSourceChunk,
} from '../utils/contentWritingKnowledge';
import {
  selectContentWritingClaims,
  summarizeContentWritingClaimUsage,
} from '../utils/contentWritingClaims';
import {
  buildContentWritingQualityContract,
  normalizeContentWritingQualityConfiguration,
  type ContentWritingQualityConfiguration,
} from '../constants/contentWritingQuality';
import {
  getPromptTemplate,
  PROMPT_TEMPLATE_IDS,
} from '../constants/promptRegistry';
import {
  buildContentWritingRepairPrompt,
  evaluateContentWritingQuality,
  normalizeContentWritingQualityReport,
  type ContentWritingQualityReport,
} from '../utils/contentWritingQuality';
import {
  competitorPhraseIntelligenceToPromptJson,
  type CompetitorPhraseIntelligenceResult,
} from '../utils/competitorPhraseAnalysis';
import {
  buildContentWritingPhraseAudit,
  getContentWritingPhraseAuditOutput,
} from '../utils/contentWritingPhraseAudit';
import {
  contentWritingFaqAuditToMarkdown,
  evaluateContentWritingFaqRevision,
  extractContentWritingFaqQuestionSeeds,
  normalizeContentWritingFaqAudit,
  type ContentWritingFaqAudit,
} from '../utils/contentWritingFaq';
import { normalizeGoalContext } from '../utils/goalContext';
import {
  CONTENT_WRITING_EVIDENCE_TRACE_VERSION,
  type ContentWritingEvidenceTrace,
} from '../utils/contentWritingEvidence';
import {
  applyContentWritingRevisionEdits,
  buildContentWritingRevisionDocument,
  compareContentWritingQualityReports,
  contentWritingRevisionTargetsToPromptJson,
  evaluateContentWritingRevisionKnowledge,
  parseContentWritingRevisionEdits,
  parseContentWritingRevisionPlan,
  type ContentWritingRevisionPlan,
} from '../utils/contentWritingRevision';
import {
  buildContentWritingCandidatePrompt,
  evaluateContentWritingCandidate,
  getContentWritingCandidateMetadata,
  mergeContentWritingCandidateFailureCodes,
  selectBestContentWritingCandidate,
  type ContentWritingCandidateEvaluation,
  type ContentWritingCandidateSelection,
} from '../utils/contentWritingCandidates';
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

type ProcessedStepOutput = { output: string; metadata?: JsonObject };

type CandidateStepResult = Extract<StepRunResult, { ok: true }> & {
  evaluation: ContentWritingCandidateEvaluation;
};

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

const getSessionGoalContext = (session: ContentWritingSession): GoalContext => {
  const qualityInput = isRecord(session.context_snapshot?.qualityInput)
    ? session.context_snapshot.qualityInput
    : {};
  const article = isRecord(session.context_snapshot?.article)
    ? session.context_snapshot.article
    : {};
  const source = isRecord(qualityInput.goalContext)
    ? qualityInput.goalContext
    : isRecord(session.context_snapshot?.goalContext)
      ? session.context_snapshot.goalContext
      : isRecord(article.goalContext)
        ? article.goalContext
        : {};
  return normalizeGoalContext(source);
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
  const keywords: Keywords = {
    primary: toText(keywordSource.primary),
    secondaries: toTextList(keywordSource.secondaries),
    company: toText(keywordSource.company),
    lsi: toTextList(keywordSource.lsi),
  };
  if (!keywords.primary) return null;
  const goalContext = getSessionGoalContext(session);
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

const getCompetitorPhraseIntelligence = (
  session: ContentWritingSession,
): CompetitorPhraseIntelligenceResult | null => (
  isRecord(session.context_snapshot?.competitorPhraseIntelligence)
    ? session.context_snapshot.competitorPhraseIntelligence as unknown as CompetitorPhraseIntelligenceResult
    : null
);

const buildCompactArticleContext = (
  session: ContentWritingSession,
  knowledge: ContentWritingKnowledgeBase,
): string => {
  const base = toText(session.context_snapshot?.compactArticleContextBase);
  const competitorPhraseIntelligence = getCompetitorPhraseIntelligence(session);
  const phraseIntelligenceBlock = competitorPhraseIntelligence?.enabled
    ? `

<deterministic_competitor_phrase_intelligence>
${competitorPhraseIntelligenceToPromptJson(competitorPhraseIntelligence)}
</deterministic_competitor_phrase_intelligence>`
    : '';
  return `${base || 'Use the persisted article, keyword, goal, and audience context for this session.'}

<persisted_competitor_coverage_matrix>
${contentWritingKnowledgeToPromptJson(knowledge)}
</persisted_competitor_coverage_matrix>${phraseIntelligenceBlock}`;
};

const buildTargetedRevisionArticleContext = (
  compactArticleContext: string,
): string => compactArticleContext.replace(
  /<current_article_text>[\s\S]*?<\/current_article_text>/gi,
  '<current_article_text withheld="targeted-revision">Only the explicitly targeted segments are attached to this revision step.</current_article_text>',
);

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
  Array.from(steps).filter(step => (
    step.status === 'completed'
    && !step.metadata?.candidatePhase
  )).length
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
  const goalContext = qualityRuntime?.goalContext || getSessionGoalContext(options.session);
  const primaryKeyword = qualityRuntime?.keywords.primary || '';
  const companyName = qualityRuntime?.keywords.company || '';
  const promptTemplates = isRecord(options.session.context_snapshot?.promptTemplates)
    ? options.session.context_snapshot.promptTemplates as Record<string, string>
    : {};
  const promptTemplate = (id: string): string => getPromptTemplate(promptTemplates, id);
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
      const isStructuredRevisionPayload = Boolean(definition.metadata.revisionPhase);
      const isGeneratedArticleProse = !isStructuredRevisionPayload && (
        definition.type === 'section'
        || definition.type === 'introduction'
        || definition.type === 'faq'
        || definition.type === 'conclusion'
        || definition.type === 'call_to_action'
        || definition.type === 'section_repair'
        || definition.type === 'final_review'
        || definition.type === 'quality_repair'
      );
      // Keep every persisted and live-visible prose result identical to the
      // editor import: normalize list markers and remove generated bold text.
      processed.output = isGeneratedArticleProse
        ? normalizeFinalContentWritingResult(processed.output)
        : processed.output.trim();
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

    const phraseAuditOutput = getContentWritingPhraseAuditOutput({
      outputText: processed.output,
      metadata: processed.metadata,
    });
    const competitorPhraseAudit = buildContentWritingPhraseAudit({
      stepType: definition.type,
      intelligence: getCompetitorPhraseIntelligence(options.session),
      outputText: phraseAuditOutput.text,
      outputSubject: phraseAuditOutput.subject,
    });
    const completed = await completeContentWritingStep({
      sessionId: options.session.id,
      workerId: options.workerId,
      stepKey: definition.key,
      outputText: processed.output,
      metadata: getExecutionMetadata(execution, {
        ...(processed.metadata || {}),
        competitorPhraseAudit,
      }),
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

  const multiCandidateGenerationEnabled = (
    options.session.context_snapshot?.multiCandidateGenerationEnabled === true
  );

  const runCandidateStage = async (candidateOptions: {
    definition: ContentWritingWorkflowStepDefinition;
    prompt: string;
    stepIndex: number;
    stepCount: number;
    maxOutputTokens: number;
    articleContextOverride?: string;
    processOutput?: (output: string) => ProcessedStepOutput;
    evaluate: (
      result: Extract<StepRunResult, { ok: true }>,
      candidateIndex: number,
    ) => ContentWritingCandidateEvaluation;
    finalize?: (candidates: CandidateStepResult[]) => {
      output: string;
      metadata?: JsonObject;
      mode: ContentWritingCandidateSelection['mode'];
      selectedCandidateStepKey: string;
      selectedCandidateIndex: number;
      selectionReason: string;
    };
  }): Promise<StepRunResult> => {
    if (!multiCandidateGenerationEnabled) {
      return runStep(candidateOptions);
    }
    const canonicalExisting = stepMap.get(candidateOptions.definition.key)
      || await ensureStep(candidateOptions.definition);
    if (canonicalExisting.status === 'completed' && toText(canonicalExisting.output_text)) {
      return {
        ok: true,
        step: canonicalExisting,
        output: toText(canonicalExisting.output_text),
      };
    }
    const canonicalRunning = await startContentWritingStep({
      sessionId: options.session.id,
      workerId: options.workerId,
      stepKey: candidateOptions.definition.key,
      promptText: `Protected multi-candidate selection for ${candidateOptions.definition.title}.`,
    });
    if (!canonicalRunning) {
      const latest = (await getContentWritingSteps(
        options.session.id,
        { includeContent: true, includeMetadata: true },
      )).find(step => step.step_key === candidateOptions.definition.key);
      if (latest?.status === 'completed' && toText(latest.output_text)) {
        stepMap.set(candidateOptions.definition.key, latest);
        return { ok: true, step: latest, output: toText(latest.output_text) };
      }
      throw new Error(`Could not start candidate selection ${candidateOptions.definition.key}.`);
    }
    stepMap.set(candidateOptions.definition.key, canonicalRunning);
    emitProgress(
      candidateOptions.definition,
      candidateOptions.stepIndex,
      candidateOptions.stepCount,
      {
        stage: 'workflow-candidates',
        provider: options.session.provider,
        model: options.session.model,
        message: `Generating two independent candidates for ${candidateOptions.definition.title}.`,
        candidateCount: 2,
        completed: false,
      },
    );

    const createCandidateDefinition = (
      candidateIndex: number,
      remediationFailures: readonly string[] = [],
    ): ContentWritingWorkflowStepDefinition => ({
      key: `${candidateOptions.definition.key}-candidate-${candidateIndex}`,
      type: candidateOptions.definition.type,
      ordinal: candidateOptions.definition.ordinal,
      title: `${candidateOptions.definition.title} — candidate ${candidateIndex}`,
      metadata: {
        ...candidateOptions.definition.metadata,
        candidatePhase: 'generation',
        parentStepKey: candidateOptions.definition.key,
        candidateIndex,
        candidateLabel: `Candidate ${candidateIndex}`,
        remediationFailures,
      },
    });
    const runOneCandidate = async (
      candidateIndex: number,
      remediationFailures: readonly string[] = [],
    ): Promise<StepRunResult> => {
      const definition = createCandidateDefinition(candidateIndex, remediationFailures);
      await ensureStep(definition);
      return runStep({
        definition,
        prompt: buildContentWritingCandidatePrompt({
          prompt: candidateOptions.prompt,
          candidateIndex,
          stageLabel: candidateOptions.definition.title,
          remediationFailures,
        }),
        stepIndex: candidateOptions.stepIndex,
        stepCount: candidateOptions.stepCount,
        maxOutputTokens: candidateOptions.maxOutputTokens,
        articleContextOverride: candidateOptions.articleContextOverride,
        processOutput: candidateOptions.processOutput,
      });
    };

    const initialResults = await Promise.all([
      runOneCandidate(1),
      runOneCandidate(2),
    ]);
    const failedResult = initialResults.find(
      (result): result is Extract<StepRunResult, { ok: false }> => !result.ok,
    );
    if (failedResult) {
      await failContentWritingStep({
        sessionId: options.session.id,
        workerId: options.workerId,
        stepKey: candidateOptions.definition.key,
        errorCode: failedResult.execution.errorCode || 'content_writing_candidate_failed',
        errorMessage: failedResult.execution.errorMessage || 'A writing candidate failed.',
      });
      return failedResult;
    }
    const evaluated: CandidateStepResult[] = initialResults.map((result, index) => ({
      ...result as Extract<StepRunResult, { ok: true }>,
      evaluation: candidateOptions.evaluate(
        result as Extract<StepRunResult, { ok: true }>,
        index + 1,
      ),
    }));
    if (!evaluated.some(candidate => candidate.evaluation.passedHardGates)) {
      const failureCodes = mergeContentWritingCandidateFailureCodes(
        evaluated.map(candidate => candidate.evaluation),
      );
      const recoveryResult = await runOneCandidate(3, failureCodes);
      if (recoveryResult.ok) {
        evaluated.push({
          ...recoveryResult,
          evaluation: candidateOptions.evaluate(recoveryResult, 3),
        });
      }
    }

    const selected = selectBestContentWritingCandidate(evaluated);
    if (!selected) {
      const failure = createWorkflowFailure({
        session: options.session,
        status: 422,
        code: 'content_writing_candidate_selection_empty',
        message: `No usable candidate was produced for ${candidateOptions.definition.title}.`,
        step: candidateOptions.definition,
      });
      await failContentWritingStep({
        sessionId: options.session.id,
        workerId: options.workerId,
        stepKey: candidateOptions.definition.key,
        errorCode: failure.errorCode || 'content_writing_candidate_selection_empty',
        errorMessage: failure.errorMessage || 'No usable candidate was produced.',
      });
      return { ok: false, execution: failure };
    }
    const finalized = candidateOptions.finalize?.(evaluated) || {
      output: selected.output,
      metadata: getContentWritingCandidateMetadata(selected.step.metadata),
      mode: 'best_candidate' as const,
      selectedCandidateStepKey: selected.step.step_key,
      selectedCandidateIndex: selected.evaluation.candidateIndex,
      selectionReason: selected.evaluation.passedHardGates
        ? 'highest_score_after_hard_gates'
        : 'best_available_candidate_pending_later_repairs',
    };
    const candidateSelection: ContentWritingCandidateSelection = {
      version: 1,
      enabled: true,
      parentStepKey: candidateOptions.definition.key,
      mode: finalized.mode,
      selectedCandidateStepKey: finalized.selectedCandidateStepKey,
      selectedCandidateIndex: finalized.selectedCandidateIndex,
      selectionReason: finalized.selectionReason,
      candidates: evaluated.map(candidate => ({
        ...candidate.evaluation,
        stepKey: candidate.step.step_key,
        title: candidate.step.title,
        selected: candidate.step.step_key === finalized.selectedCandidateStepKey,
      })),
    };
    const phraseAuditOutput = getContentWritingPhraseAuditOutput({
      outputText: finalized.output,
      metadata: finalized.metadata,
    });
    const competitorPhraseAudit = buildContentWritingPhraseAudit({
      stepType: candidateOptions.definition.type,
      intelligence: getCompetitorPhraseIntelligence(options.session),
      outputText: phraseAuditOutput.text,
      outputSubject: phraseAuditOutput.subject,
    });
    const completed = await completeContentWritingStep({
      sessionId: options.session.id,
      workerId: options.workerId,
      stepKey: candidateOptions.definition.key,
      outputText: finalized.output,
      metadata: {
        ...(finalized.metadata || {}),
        candidateSelection,
        competitorPhraseAudit,
      },
    });
    if (!completed) {
      throw new Error(`Could not complete candidate selection ${candidateOptions.definition.key}.`);
    }
    stepMap.set(candidateOptions.definition.key, completed);
    emitProgress(
      candidateOptions.definition,
      candidateOptions.stepIndex,
      candidateOptions.stepCount,
      {
        stage: 'workflow-candidate-selected',
        provider: options.session.provider,
        model: options.session.model,
        message: `Selected candidate ${finalized.selectedCandidateIndex || 'union'} for ${candidateOptions.definition.title}.`,
        candidateCount: evaluated.length,
        selectedCandidateIndex: finalized.selectedCandidateIndex,
        completed: false,
      },
    );
    return {
      ok: true,
      step: completed,
      output: finalized.output,
      execution: selected.execution,
    };
  };

  const competitorChunks = getCompetitorChunks(options.session);
  const competitorPhraseIntelligence = getCompetitorPhraseIntelligence(options.session);
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
  const processKnowledgeOutput = (output: string): ProcessedStepOutput => {
    const knowledge = parseContentWritingKnowledgeBase(output, competitorChunks);
    return {
      output,
      metadata: {
        knowledge,
        sourceChunkCount: competitorChunks.length,
        modelIndexedChunkCount: knowledge.modelProcessedChunkIds.length,
        fallbackChunkCount: knowledge.fallbackChunkIds.length,
        competitorCoverageMatrix: knowledge.competitorCoverageMatrix,
        sourceRegistry: knowledge.sourceRegistry,
        claimLedger: knowledge.claimLedger,
        competitorPhraseIntelligence,
      },
    };
  };
  const dualKnowledgeExtractionEnabled = (
    options.session.context_snapshot?.dualKnowledgeExtractionEnabled === true
  );
  let competitorIndexResult: StepRunResult;
  if (dualKnowledgeExtractionEnabled) {
    const createKnowledgePassDefinition = (
      pass: 1 | 2,
    ): ContentWritingWorkflowStepDefinition => ({
      key: `competitor-index-pass-${pass}`,
      type: 'competitor_index',
      ordinal: competitorIndexDefinition.ordinal,
      title: `Competitor knowledge extraction ${pass}`,
      metadata: {
        workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
        candidatePhase: 'knowledge_extraction',
        parentStepKey: competitorIndexDefinition.key,
        candidateIndex: pass,
        candidateLabel: `Independent reading ${pass}`,
      },
    });
    const knowledgePassDefinitions = [
      createKnowledgePassDefinition(1),
      createKnowledgePassDefinition(2),
    ] as const;
    await Promise.all(knowledgePassDefinitions.map(ensureStep));
    const knowledgePassResults = await Promise.all(
      knowledgePassDefinitions.map((definition, index) => runStep({
        definition,
        prompt: buildContentWritingCompetitorIndexPrompt({
          chunks: competitorChunks,
          language: article.language,
          template: promptTemplate(PROMPT_TEMPLATE_IDS.competitorIndex),
          sourceClaimsTemplate: promptTemplate(PROMPT_TEMPLATE_IDS.sourceClaimsLedger),
          competitorPhraseIntelligence,
          extractionPass: (index + 1) as 1 | 2,
        }),
        stepIndex: competitorIndexDefinition.ordinal,
        stepCount: 2,
        maxOutputTokens: 16_000,
        processOutput: processKnowledgeOutput,
      })),
    );
    const failedKnowledgePass = knowledgePassResults.find(
      (result): result is Extract<StepRunResult, { ok: false }> => !result.ok,
    );
    if (failedKnowledgePass) return failedKnowledgePass.execution;
    const firstPassResult = knowledgePassResults[0] as Extract<StepRunResult, { ok: true }>;
    const secondPassResult = knowledgePassResults[1] as Extract<StepRunResult, { ok: true }>;
    const firstPass = normalizeContentWritingKnowledgeBase(
      firstPassResult.step.metadata?.knowledge || firstPassResult.output,
      competitorChunks,
    );
    const secondPass = normalizeContentWritingKnowledgeBase(
      secondPassResult.step.metadata?.knowledge || secondPassResult.output,
      competitorChunks,
    );
    competitorIndexResult = await runStep({
      definition: {
        ...competitorIndexDefinition,
        title: 'Reconciled competitor coverage and claim ledger',
        metadata: {
          ...competitorIndexDefinition.metadata,
          ensemblePhase: 'reconciliation',
          extractionPassStepKeys: knowledgePassDefinitions.map(definition => definition.key),
        },
      },
      prompt: buildContentWritingKnowledgeReconciliationPrompt({
        firstPass,
        secondPass,
        chunks: competitorChunks,
        language: article.language,
        template: promptTemplate(PROMPT_TEMPLATE_IDS.knowledgeReconciliation),
      }),
      stepIndex: competitorIndexDefinition.ordinal,
      stepCount: 2,
      maxOutputTokens: 20_000,
      processOutput: output => {
        const processed = processKnowledgeOutput(output);
        const finalKnowledge = normalizeContentWritingKnowledgeBase(
          processed.metadata?.knowledge || output,
          competitorChunks,
        );
        const knowledgeEnsemble: ContentWritingKnowledgeEnsembleSummary = (
          buildContentWritingKnowledgeEnsembleSummary({
            firstPass,
            secondPass,
            finalKnowledge,
            chunks: competitorChunks,
          })
        );
        if (!knowledgeEnsemble.allChunksAccountedFor) {
          throw new Error('The reconciled knowledge index did not account for every source chunk.');
        }
        return {
          ...processed,
          metadata: {
            ...(processed.metadata || {}),
            knowledge: finalKnowledge,
            knowledgeEnsemble,
            extractionPassStepKeys: knowledgePassDefinitions.map(definition => definition.key),
          },
        };
      },
    });
  } else {
    competitorIndexResult = await runStep({
      definition: competitorIndexDefinition,
      prompt: buildContentWritingCompetitorIndexPrompt({
        chunks: competitorChunks,
        language: article.language,
        template: promptTemplate(PROMPT_TEMPLATE_IDS.competitorIndex),
        sourceClaimsTemplate: promptTemplate(PROMPT_TEMPLATE_IDS.sourceClaimsLedger),
        competitorPhraseIntelligence,
      }),
      stepIndex: competitorIndexDefinition.ordinal,
      stepCount: 2,
      maxOutputTokens: 16_000,
      processOutput: processKnowledgeOutput,
    });
  }
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
      targetWords: qualityRuntime?.configuration.policy.targetWords,
      minimumSections: qualityRuntime?.configuration.policy.outlineSections.min,
      maximumSections: qualityRuntime?.configuration.policy.outlineSections.max,
      template: promptTemplate(PROMPT_TEMPLATE_IDS.outline),
    }),
    stepIndex: outlineDefinition.ordinal,
    stepCount: 2,
    maxOutputTokens: 6_000,
    articleContextOverride: compactArticleContext,
    processOutput: output => {
      const parsedOutline = parseContentWritingOutline(output);
      const policyOutline = qualityRuntime
        ? fitContentWritingOutlineSectionRange(
            parsedOutline,
            knowledge,
            qualityRuntime.configuration.policy.outlineSections,
          )
        : parsedOutline;
      if (qualityRuntime && (
        policyOutline.sections.length < qualityRuntime.configuration.policy.outlineSections.min
        || policyOutline.sections.length > qualityRuntime.configuration.policy.outlineSections.max
      )) {
        throw new Error(
          `The outline must contain ${qualityRuntime.configuration.policy.outlineSections.min}-${qualityRuntime.configuration.policy.outlineSections.max} sections for quality policy ${qualityRuntime.configuration.policyVersion}.`,
        );
      }
      const coveredOutline = ensureContentWritingOutlineKnowledgeCoverage(policyOutline, knowledge);
      const balancedOutline = qualityRuntime
        ? balanceContentWritingOutlineWordTargets(
            coveredOutline,
            qualityRuntime.configuration.policy.targetWords,
          )
        : coveredOutline;
      return {
        output: JSON.stringify(balancedOutline, null, 2),
        metadata: {
          outline: balancedOutline,
          lengthTarget: options.session.context_snapshot?.lengthTarget || null,
          targetWordRange: qualityRuntime?.configuration.policy.targetWords || null,
          outlineSectionRange: qualityRuntime?.configuration.policy.outlineSections || null,
        },
      };
    },
  });
  if (!outlineResult.ok) return outlineResult.execution;
  const normalizedOutline = normalizeContentWritingOutline(outlineResult.step.metadata?.outline)
    || normalizeContentWritingOutline(outlineResult.output);
  const outlineWithCoverage = normalizedOutline
    ? ensureContentWritingOutlineKnowledgeCoverage(normalizedOutline, knowledge)
    : null;
  const outline = outlineWithCoverage && qualityRuntime
    ? balanceContentWritingOutlineWordTargets(
        outlineWithCoverage,
        qualityRuntime.configuration.policy.targetWords,
      )
    : outlineWithCoverage;
  if (!outline) {
    return createWorkflowFailure({
      session: options.session,
      status: 422,
      code: 'content_writing_outline_invalid',
      message: 'The persisted content writing outline is invalid.',
      step: outlineDefinition,
    });
  }

  const definitions = createContentWritingWorkflowSteps(outline, goalContext);
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
    const relevantClaims = selectContentWritingClaims({
      claimLedger: knowledge.claimLedger,
      knowledgeItemIds: requiredIdeaIds,
      sourceChunkIds: relevantChunks.map(chunk => chunk.id),
    });
    const assignedKnowledgeItems = knowledge.items.filter(item => requiredIdeaIds.includes(item.id));
    const evidenceTrace: ContentWritingEvidenceTrace = {
      version: CONTENT_WRITING_EVIDENCE_TRACE_VERSION,
      sectionKey: definition.key,
      sectionTitle: section.title,
      knowledgeItems: assignedKnowledgeItems,
      claims: relevantClaims,
      sourceChunks: relevantChunks,
    };
    const sectionTargetWords = Math.max(80, Math.round(Number(section.targetWords) || 140));
    const result = await runCandidateStage({
      definition,
      prompt: buildContentWritingSectionPrompt({
        outline,
        section,
        sectionIndex: index,
        previousSection: index > 0 ? outputs[sectionDefinitions[index - 1].key] : undefined,
        knowledgeItems: assignedKnowledgeItems,
        claims: relevantClaims,
        sourceChunks: relevantChunks,
        coverageLedger: {
          coveredIdeaIds: Array.from(sectionCoverageByKey.values())
            .flatMap(coverage => coverage.coveredIdeaIds),
          usedClaimIds: Array.from(sectionCoverageByKey.values())
            .flatMap(coverage => coverage.usedClaimIds),
          previousSectionSummaries: sectionDefinitions.slice(0, index).map(previousDefinition => ({
            sectionKey: previousDefinition.key,
            title: previousDefinition.title,
            coveredIdeaIds: sectionCoverageByKey.get(previousDefinition.key)?.coveredIdeaIds || [],
            usedClaimIds: sectionCoverageByKey.get(previousDefinition.key)?.usedClaimIds || [],
          })),
        },
        template: promptTemplate(PROMPT_TEMPLATE_IDS.bodySection),
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
          knowledge.claimLedger.claims.map(claim => claim.id),
        );
        return {
          output: parsed.markdown,
          metadata: {
            sectionCoverage: parsed.coverage,
            evidenceTrace,
          },
        };
      },
      evaluate: (candidate, candidateIndex) => evaluateContentWritingCandidate({
        candidateIndex,
        outputText: candidate.output,
        metadata: candidate.step.metadata,
        requiredIdeaIds,
        requiredClaimIds: section.requiredClaimIds || [],
        blockedClaimIds: knowledge.claimLedger.blockedClaimIds,
        targetWordRange: {
          min: Math.max(60, Math.round(sectionTargetWords * 0.85)),
          max: Math.round(sectionTargetWords * 1.15),
        },
        comparisonTexts: sectionDefinitions
          .slice(0, index)
          .map(previousDefinition => outputs[previousDefinition.key])
          .filter(Boolean),
      }),
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
    goalContext,
    primaryKeyword,
  });
  const introductionResult = await runCandidateStage({
    definition: introductionDefinition,
    prompt: buildContentWritingIntroductionPrompt({
      outline,
      bodyDraft,
      template: promptTemplate(PROMPT_TEMPLATE_IDS.introduction),
    }),
    stepIndex: introductionDefinition.ordinal,
    stepCount: definitions.length,
    maxOutputTokens: 4_000,
    articleContextOverride: compactArticleContext,
    evaluate: (candidate, candidateIndex) => evaluateContentWritingCandidate({
      candidateIndex,
      outputText: candidate.output,
      metadata: candidate.step.metadata,
      targetWordRange: qualityRuntime ? {
        min: qualityRuntime.configuration.policy.introduction.firstParagraphWords.min
          + qualityRuntime.configuration.policy.introduction.secondParagraphWords.min,
        max: qualityRuntime.configuration.policy.introduction.firstParagraphWords.max
          + qualityRuntime.configuration.policy.introduction.secondParagraphWords.max,
      } : { min: 70, max: 140 },
    }),
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
    goalContext,
    primaryKeyword,
  });
  const faqQuestionSeeds = extractContentWritingFaqQuestionSeeds({
    knowledge,
    chunks: competitorChunks,
    goalContext,
  });
  let faqAudit: ContentWritingFaqAudit | null = null;
  const faqResult = await runCandidateStage({
    definition: faqDefinition,
    prompt: buildContentWritingFaqPrompt({
      outline,
      draft: articleWithoutFaq,
      goalContext,
      knowledge,
      questionSeeds: faqQuestionSeeds,
      template: promptTemplate(PROMPT_TEMPLATE_IDS.faq),
    }),
    stepIndex: faqDefinition.ordinal,
    stepCount: definitions.length,
    maxOutputTokens: 6_000,
    articleContextOverride: compactArticleContext,
    processOutput: output => {
      const audit = normalizeContentWritingFaqAudit({
        value: output,
        draft: articleWithoutFaq,
        knowledge,
        chunks: competitorChunks,
        goalContext,
        questionSeeds: faqQuestionSeeds,
      });
      faqAudit = audit;
      return {
        output: contentWritingFaqAuditToMarkdown(audit),
        metadata: {
          faqIndependenceAudit: audit,
          acceptedQuestionCount: audit.acceptedCount,
          rejectedQuestionCount: audit.rejectedCount,
          needsInformationQuestionCount: audit.needsInformationCount,
        },
      };
    },
    evaluate: (candidate, candidateIndex) => evaluateContentWritingCandidate({
      candidateIndex,
      outputText: candidate.output,
      metadata: candidate.step.metadata,
      requireFaqCandidates: true,
    }),
    finalize: candidates => {
      const combinedCandidates = candidates
        .flatMap(candidate => {
          const audit = isRecord(candidate.step.metadata?.faqIndependenceAudit)
            ? candidate.step.metadata.faqIndependenceAudit
            : {};
          return Array.isArray(audit.candidates) ? audit.candidates : [];
        })
        .filter(isRecord)
        .sort((left, right) => (
          Number(right.decision === 'accepted') - Number(left.decision === 'accepted')
          || Number(right.sourceType === 'people_also_ask') - Number(left.sourceType === 'people_also_ask')
          || Number(right.informationGainScore || 0) - Number(left.informationGainScore || 0)
          || Number(left.bodySimilarityScore || 0) - Number(right.bodySimilarityScore || 0)
        ))
        .map((candidate, index) => ({
          ...candidate,
          id: `FAQM${String(index + 1).padStart(3, '0')}`,
        }));
      const mergedAudit = normalizeContentWritingFaqAudit({
        value: { candidates: combinedCandidates },
        draft: articleWithoutFaq,
        knowledge,
        chunks: competitorChunks,
        goalContext,
        questionSeeds: faqQuestionSeeds,
      });
      faqAudit = mergedAudit;
      return {
        output: contentWritingFaqAuditToMarkdown(mergedAudit),
        metadata: {
          faqIndependenceAudit: mergedAudit,
          acceptedQuestionCount: mergedAudit.acceptedCount,
          rejectedQuestionCount: mergedAudit.rejectedCount,
          needsInformationQuestionCount: mergedAudit.needsInformationCount,
          faqCandidateUnion: {
            sourceCandidateCount: candidates.length,
            mergedCandidateCount: combinedCandidates.length,
            acceptedCount: mergedAudit.acceptedCount,
          },
        },
        mode: 'faq_union',
        selectedCandidateStepKey: 'faq-union',
        selectedCandidateIndex: 0,
        selectionReason: 'semantic_union_with_independence_guards',
      };
    },
  });
  if (!faqResult.ok) return faqResult.execution;
  if (!faqAudit && isRecord(faqResult.step.metadata?.faqIndependenceAudit)) {
    faqAudit = faqResult.step.metadata.faqIndependenceAudit as unknown as ContentWritingFaqAudit;
  }
  outputs.faq = faqResult.output;

  const finalSectionDefinition = definitions.find(definition => (
    definition.type === 'conclusion' || definition.type === 'call_to_action'
  ))!;
  const introductionBodyAndFaqDraft = assembleContentWritingDraft({
    articleTitle: article.title,
    language: article.language,
    outline,
    outputs,
    goalContext,
    primaryKeyword,
  });
  const finalSectionResult = await runCandidateStage({
    definition: finalSectionDefinition,
    prompt: finalSectionDefinition.type === 'call_to_action'
      ? buildContentWritingCallToActionPrompt({
          outline,
          draft: introductionBodyAndFaqDraft,
          goalContext,
          primaryKeyword,
          companyName,
          template: promptTemplate(PROMPT_TEMPLATE_IDS.callToAction),
        })
      : buildContentWritingConclusionPrompt({
          outline,
          draft: introductionBodyAndFaqDraft,
          template: promptTemplate(PROMPT_TEMPLATE_IDS.conclusion),
        }),
    stepIndex: finalSectionDefinition.ordinal,
    stepCount: definitions.length,
    maxOutputTokens: 4_000,
    articleContextOverride: compactArticleContext,
    evaluate: (candidate, candidateIndex) => evaluateContentWritingCandidate({
      candidateIndex,
      outputText: candidate.output,
      metadata: candidate.step.metadata,
      targetWordRange: finalSectionDefinition.type === 'conclusion'
        ? qualityRuntime?.configuration.policy.conclusion.words || { min: 70, max: 120 }
        : { min: 70, max: 125 },
    }),
  });
  if (!finalSectionResult.ok) return finalSectionResult.execution;
  outputs[finalSectionDefinition.key] = finalSectionResult.output;

  const coverageBeforeAudit = summarizeContentWritingCoverage({
    knowledge,
    sectionCoverages: Array.from(sectionCoverageByKey.values()),
  });
  const claimUsageBeforeAudit = summarizeContentWritingClaimUsage({
    claimLedger: knowledge.claimLedger,
    usedClaimIds: Array.from(sectionCoverageByKey.values())
      .flatMap(coverage => coverage.usedClaimIds),
  });
  const draftBeforeAudit = assembleContentWritingDraft({
    articleTitle: article.title,
    language: article.language,
    outline,
    outputs,
    goalContext,
    primaryKeyword,
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
          usedClaimIds: [],
        },
      })),
      deterministicMissingIdeaIds: coverageBeforeAudit.missingIdeaIds,
      deterministicBlockedClaimIds: claimUsageBeforeAudit.blockedClaimIds,
      template: promptTemplate(PROMPT_TEMPLATE_IDS.coverageAudit),
    }),
    stepIndex: coverageAuditDefinition.ordinal,
    stepCount: definitions.length,
    maxOutputTokens: 6_000,
    articleContextOverride: compactArticleContext,
    processOutput: output => {
      const audit = parseContentWritingCoverageAudit(output, {
        validIdeaIds: knowledge.items.map(item => item.id),
        validChunkIds: competitorChunks.map(chunk => chunk.id),
        validClaimIds: knowledge.claimLedger.claims.map(claim => claim.id),
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
      validClaimIds: knowledge.claimLedger.claims.map(claim => claim.id),
      validSectionKeys: sectionDefinitions.map(definition => definition.key),
    },
  );

  for (let repairIndex = 0; repairIndex < coverageAudit.repairs.length; repairIndex += 1) {
    const repair = coverageAudit.repairs[repairIndex];
    const sectionIndex = sectionDefinitions.findIndex(definition => definition.key === repair.sectionKey);
    if (sectionIndex < 0) continue;
    const sourceChunkIdSet = new Set(repair.sourceChunkIds);
    const repairClaimIds = new Set(repair.claimIds);
    knowledge.claimLedger.claims
      .filter(claim => repairClaimIds.has(claim.id))
      .flatMap(claim => claim.supportingSourceChunkIds)
      .forEach(chunkId => sourceChunkIdSet.add(chunkId));
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
    const selectedRepairClaims = selectContentWritingClaims({
      claimLedger: knowledge.claimLedger,
      knowledgeItemIds: repair.ideaIds,
      sourceChunkIds: repairChunks.map(chunk => chunk.id),
    });
    const repairClaims = repairClaimIds.size > 0
      ? knowledge.claimLedger.claims.filter(claim => repairClaimIds.has(claim.id))
      : selectedRepairClaims;
    const repairKnowledgeItems = knowledge.items.filter(item => repair.ideaIds.includes(item.id));
    const repairEvidenceTrace: ContentWritingEvidenceTrace = {
      version: CONTENT_WRITING_EVIDENCE_TRACE_VERSION,
      sectionKey: repair.sectionKey,
      sectionTitle: sectionDefinitions[sectionIndex].title,
      knowledgeItems: repairKnowledgeItems,
      claims: repairClaims,
      sourceChunks: repairChunks,
    };
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
    const repairTargetWords = Math.max(
      80,
      Math.round(Number(outline.sections[sectionIndex].targetWords) || 140),
    );
    const repairResult = await runCandidateStage({
      definition: repairDefinition,
      prompt: buildContentWritingSectionRepairPrompt({
        outline,
        section: outline.sections[sectionIndex],
        sectionKey: repair.sectionKey,
        originalMarkdown: outputs[repair.sectionKey],
        repair,
        knowledgeItems: repairKnowledgeItems,
        claims: repairClaims,
        sourceChunks: repairChunks,
        template: promptTemplate(PROMPT_TEMPLATE_IDS.sectionRepair),
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
          knowledge.claimLedger.claims.map(claim => claim.id),
        );
        return {
          output: parsed.markdown,
          metadata: {
            sectionCoverage: parsed.coverage,
            repairedSectionKey: repair.sectionKey,
            evidenceTrace: repairEvidenceTrace,
          },
        };
      },
      evaluate: (candidate, candidateIndex) => evaluateContentWritingCandidate({
        candidateIndex,
        outputText: candidate.output,
        metadata: candidate.step.metadata,
        requiredIdeaIds: repair.ideaIds,
        requiredClaimIds: repair.claimIds,
        blockedClaimIds: knowledge.claimLedger.blockedClaimIds,
        targetWordRange: {
          min: Math.max(60, Math.round(repairTargetWords * 0.85)),
          max: Math.round(repairTargetWords * 1.15),
        },
        comparisonTexts: Object.entries(outputs)
          .filter(([key]) => key !== repair.sectionKey)
          .map(([, value]) => value)
          .filter(Boolean),
      }),
    });
    if (!repairResult.ok) return repairResult.execution;
    outputs[repair.sectionKey] = repairResult.output;
    const previousCoverage = sectionCoverageByKey.get(repair.sectionKey) || {
      coveredIdeaIds: [],
      usedSourceChunkIds: [],
      usedClaimIds: [],
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
      // A targeted repair replaces the complete section, so removed blocked claims
      // must not survive in the declared claim usage ledger.
      usedClaimIds: repairedCoverage.usedClaimIds,
    });
  }

  const coverageAfterRepairs = summarizeContentWritingCoverage({
    knowledge,
    sectionCoverages: Array.from(sectionCoverageByKey.values()),
  });
  const claimUsageAfterRepairs = summarizeContentWritingClaimUsage({
    claimLedger: knowledge.claimLedger,
    usedClaimIds: Array.from(sectionCoverageByKey.values())
      .flatMap(coverage => coverage.usedClaimIds),
  });
  const assembledDraft = assembleContentWritingDraft({
    articleTitle: article.title,
    language: article.language,
    outline,
    outputs,
    goalContext,
    primaryKeyword,
  });
  const baseFinalDefinition = definitions.find(definition => definition.type === 'final_review')!;
  const finalDefinition: ContentWritingWorkflowStepDefinition = {
    ...baseFinalDefinition,
    ordinal: coverageAuditDefinition.ordinal + coverageAudit.repairs.length + 1,
    title: 'Final review plan',
    metadata: {
      ...baseFinalDefinition.metadata,
      revisionPhase: 'plan',
      revisionKind: 'final_review',
    },
  };
  let finalOutput = assembledDraft;
  let finalStep = coverageAuditResult.step;
  let execution = coverageAuditResult.execution || finalSectionResult.execution;
  let repairPasses = 0;
  let activeSectionCoverageByKey = new Map(sectionCoverageByKey);
  let qualityReport: ContentWritingQualityReport | null = qualityRuntime
    ? evaluateContentWritingQuality({
        markdown: finalOutput,
        articleTitle: article.title,
        keywords: qualityRuntime.keywords,
        goalContext: qualityRuntime.goalContext,
        articleLanguage: article.language === 'en' ? 'en' : 'ar',
        configuration: qualityRuntime.configuration,
        repairPasses,
      }).report
    : null;
  const totalRevisionStepCount = definitions.length
    + coverageAudit.repairs.length
    + 2
    + ((qualityRuntime?.configuration.maxRepairPasses || 0) * 2);

  const applyPersistedRevisionOutcome = (step: ContentWritingStep): boolean => {
    const decision = isRecord(step.metadata?.revisionDecision)
      ? step.metadata.revisionDecision
      : {};
    if (decision.accepted !== true) return false;
    const acceptedDraft = toText(step.metadata?.acceptedDraft);
    if (!acceptedDraft) return false;
    const normalizedAcceptedDraft = normalizeFinalContentWritingResult(acceptedDraft);
    if (!auditContentWritingFinalSectionStructure({
      markdown: normalizedAcceptedDraft,
      goalContext,
    }).accepted) {
      return false;
    }
    finalOutput = normalizedAcceptedDraft;
    qualityReport = normalizeContentWritingQualityReport(
      step.metadata?.qualityReportAfterRevision,
    ) || qualityReport;
    if (Array.isArray(step.metadata?.sectionCoveragesAfter)) {
      const nextCoverages = new Map<string, ContentWritingSectionCoverage>();
      step.metadata.sectionCoveragesAfter.forEach(item => {
        if (!isRecord(item)) return;
        const sectionKey = toText(item.sectionKey);
        if (!sectionKey) return;
        nextCoverages.set(
          sectionKey,
          normalizeContentWritingSectionCoverage(item.coverage),
        );
      });
      if (nextCoverages.size > 0) activeSectionCoverageByKey = nextCoverages;
    }
    return true;
  };

  const runRevisionApplication = async (revisionOptions: {
    definition: ContentWritingWorkflowStepDefinition;
    plan: ContentWritingRevisionPlan;
    stepIndex: number;
  }): Promise<StepRunResult> => {
    const revisionDocument = buildContentWritingRevisionDocument({
      markdown: finalOutput,
      outline,
      goalContext,
    });
    const qualityBeforeRevision = qualityReport;
    const draftBeforeRevision = finalOutput;
    const coverageBeforeRevision = new Map(activeSectionCoverageByKey);
    const result = await runCandidateStage({
      definition: revisionOptions.definition,
      prompt: buildContentWritingRevisionApplyPrompt({
        plan: revisionOptions.plan,
        document: revisionDocument,
        knowledge,
        qualityContract: qualityRuntime?.contract,
        language: article.language,
        template: promptTemplate(PROMPT_TEMPLATE_IDS.revisionApply),
      }),
      stepIndex: revisionOptions.stepIndex,
      stepCount: totalRevisionStepCount,
      maxOutputTokens: 20_000,
      articleContextOverride: buildTargetedRevisionArticleContext(compactArticleContext),
      processOutput: output => {
        const edits = parseContentWritingRevisionEdits(output, revisionOptions.plan);
        const application = applyContentWritingRevisionEdits(revisionDocument, edits);
        const knowledgeGuard = evaluateContentWritingRevisionKnowledge({
          beforeMarkdown: draftBeforeRevision,
          candidateMarkdown: application.candidateMarkdown,
          document: revisionDocument,
          application,
          knowledge,
          sectionCoverages: coverageBeforeRevision,
        });
        const faqIndependenceGuard = evaluateContentWritingFaqRevision({
          beforeMarkdown: draftBeforeRevision,
          candidateMarkdown: application.candidateMarkdown,
          audit: faqAudit,
        });
        const finalSectionStructureGuard = auditContentWritingFinalSectionStructure({
          markdown: application.candidateMarkdown,
          goalContext,
        });
        const qualityAfterRevision = qualityRuntime && qualityBeforeRevision
          ? evaluateContentWritingQuality({
              markdown: application.candidateMarkdown,
              articleTitle: article.title,
              keywords: qualityRuntime.keywords,
              goalContext: qualityRuntime.goalContext,
              articleLanguage: article.language === 'en' ? 'en' : 'ar',
              configuration: qualityRuntime.configuration,
              repairPasses,
            }).report
          : null;
        const qualityGuard = qualityBeforeRevision && qualityAfterRevision
          ? compareContentWritingQualityReports(qualityBeforeRevision, qualityAfterRevision)
          : null;
        const reasons = Array.from(new Set([
          ...application.errors,
          ...(application.appliedEdits.length === 0 ? ['no_valid_revision_edits'] : []),
          ...(application.candidateMarkdown === draftBeforeRevision ? ['candidate_unchanged'] : []),
          ...knowledgeGuard.reasons,
          ...faqIndependenceGuard.reasons,
          ...finalSectionStructureGuard.reasons,
          ...(qualityGuard?.reasons || ['quality_guard_unavailable']),
        ]));
        const accepted = reasons.length === 0
          && knowledgeGuard.accepted
          && faqIndependenceGuard.accepted
          && finalSectionStructureGuard.accepted
          && qualityGuard?.accepted === true;
        return {
          output: JSON.stringify({
            edits: application.appliedEdits,
            decision: {
              accepted,
              reasons,
              unchangedTargetIds: application.unchangedTargetIds,
            },
          }, null, 2),
          metadata: {
            revisionPhase: 'apply',
            revisionPlan: revisionOptions.plan,
            revisionEdits: application.appliedEdits,
            revisionDecision: {
              accepted,
              reasons,
              unchangedTargetIds: application.unchangedTargetIds,
              appliedEditCount: application.appliedEdits.length,
            },
            qualityReportBeforeRevision: qualityBeforeRevision,
            qualityReportAfterRevision: qualityAfterRevision,
            qualityGuard,
            knowledgeGuard,
            faqIndependenceGuard,
            finalSectionStructureGuard,
            acceptedDraft: accepted ? application.candidateMarkdown : null,
            sectionCoveragesAfter: knowledgeGuard.sectionCoverages,
          },
        };
      },
      evaluate: (candidate, candidateIndex) => evaluateContentWritingCandidate({
        candidateIndex,
        outputText: candidate.output,
        metadata: candidate.step.metadata,
        blockedClaimIds: knowledge.claimLedger.blockedClaimIds,
        requireAcceptedRevision: true,
      }),
    });
    if (result.ok) applyPersistedRevisionOutcome(result.step);
    return result;
  };

  const finalReviewDocument = buildContentWritingRevisionDocument({
    markdown: finalOutput,
    outline,
    goalContext,
  });
  await ensureStep(finalDefinition);
  const finalResult = await runStep({
    definition: finalDefinition,
    prompt: buildContentWritingFinalReviewPrompt({
      articleTitle: article.title,
      draft: finalOutput,
      knowledge,
      coverageAudit,
      qualityContract: qualityRuntime?.contract,
      qualityReportJson: JSON.stringify(qualityReport || {}, null, 2),
      documentTargetsJson: contentWritingRevisionTargetsToPromptJson(finalReviewDocument),
      template: promptTemplate(PROMPT_TEMPLATE_IDS.finalReview),
    }),
    stepIndex: finalDefinition.ordinal,
    stepCount: totalRevisionStepCount,
    maxOutputTokens: 8_000,
    articleContextOverride: compactArticleContext,
    processOutput: output => {
      const revisionPlan = parseContentWritingRevisionPlan(output, finalReviewDocument);
      return {
        output: JSON.stringify(revisionPlan, null, 2),
        metadata: {
          revisionPhase: 'plan',
          revisionKind: 'final_review',
          revisionPlan,
          plannedOperationCount: revisionPlan.operations.length,
        },
      };
    },
  });
  if (!finalResult.ok) return finalResult.execution;
  finalStep = finalResult.step;
  execution = finalResult.execution || execution;
  const finalReviewPlan = parseContentWritingRevisionPlan(
    finalResult.step.metadata?.revisionPlan || finalResult.output,
    finalReviewDocument,
  );
  if (finalReviewPlan.operations.length > 0 && qualityRuntime && qualityReport) {
    const finalApplyDefinition: ContentWritingWorkflowStepDefinition = {
      key: 'final-review-apply',
      type: 'final_review',
      ordinal: finalDefinition.ordinal + 1,
      title: 'Apply final review edits',
      metadata: {
        workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
        revisionPhase: 'apply',
        revisionKind: 'final_review',
      },
    };
    await ensureStep(finalApplyDefinition);
    const finalApplyResult = await runRevisionApplication({
      definition: finalApplyDefinition,
      plan: finalReviewPlan,
      stepIndex: finalApplyDefinition.ordinal,
    });
    if (!finalApplyResult.ok) return finalApplyResult.execution;
    finalStep = finalApplyResult.step;
    execution = finalApplyResult.execution || execution;
  }

  if (qualityRuntime) {
    for (
      let pass = 1;
      qualityReport && !qualityReport.passed && pass <= qualityRuntime.configuration.maxRepairPasses;
      pass += 1
    ) {
      repairPasses = pass;
      const repairDocument = buildContentWritingRevisionDocument({
        markdown: finalOutput,
        outline,
        goalContext,
      });
      const repairPlanDefinition: ContentWritingWorkflowStepDefinition = {
        key: `quality-repair-${String(pass).padStart(2, '0')}-plan`,
        type: 'quality_repair',
        ordinal: finalDefinition.ordinal + 2 + ((pass - 1) * 2),
        title: `Quality repair ${pass} plan`,
        metadata: {
          workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
          qualityPolicyVersion: qualityRuntime.configuration.policyVersion,
          repairPass: pass,
          revisionPhase: 'plan',
          revisionKind: 'quality_repair',
        },
      };
      await ensureStep(repairPlanDefinition);
      const repairPlanResult = await runStep({
        definition: repairPlanDefinition,
        prompt: buildContentWritingRepairPrompt({
          report: qualityReport,
          draft: finalOutput,
          qualityContract: qualityRuntime.contract,
          language: article.language === 'en' ? 'en' : 'ar',
          documentTargetsJson: contentWritingRevisionTargetsToPromptJson(repairDocument),
          template: promptTemplate(PROMPT_TEMPLATE_IDS.qualityRepair),
        }),
        stepIndex: repairPlanDefinition.ordinal,
        stepCount: totalRevisionStepCount,
        maxOutputTokens: 8_000,
        articleContextOverride: compactArticleContext,
        processOutput: output => {
          const revisionPlan = parseContentWritingRevisionPlan(output, repairDocument);
          return {
            output: JSON.stringify(revisionPlan, null, 2),
            metadata: {
              revisionPhase: 'plan',
              revisionKind: 'quality_repair',
              repairPass: pass,
              revisionPlan,
              plannedOperationCount: revisionPlan.operations.length,
              qualityReportBeforeRepair: qualityReport,
            },
          };
        },
      });
      if (!repairPlanResult.ok) return repairPlanResult.execution;
      finalStep = repairPlanResult.step;
      execution = repairPlanResult.execution || execution;
      const repairPlan = parseContentWritingRevisionPlan(
        repairPlanResult.step.metadata?.revisionPlan || repairPlanResult.output,
        repairDocument,
      );
      if (repairPlan.operations.length === 0) {
        qualityReport = {
          ...qualityReport,
          repairPasses,
        };
        break;
      }

      const repairApplyDefinition: ContentWritingWorkflowStepDefinition = {
        key: `quality-repair-${String(pass).padStart(2, '0')}-apply`,
        type: 'quality_repair',
        ordinal: repairPlanDefinition.ordinal + 1,
        title: `Apply quality repair ${pass}`,
        metadata: {
          workflowVersion: CONTENT_WRITING_WORKFLOW_VERSION,
          qualityPolicyVersion: qualityRuntime.configuration.policyVersion,
          repairPass: pass,
          revisionPhase: 'apply',
          revisionKind: 'quality_repair',
        },
      };
      await ensureStep(repairApplyDefinition);
      const repairApplyResult = await runRevisionApplication({
        definition: repairApplyDefinition,
        plan: repairPlan,
        stepIndex: repairApplyDefinition.ordinal,
      });
      if (!repairApplyResult.ok) return repairApplyResult.execution;
      finalStep = repairApplyResult.step;
      execution = repairApplyResult.execution || execution;
      if (qualityReport) {
        qualityReport = {
          ...qualityReport,
          repairPasses,
        };
      }
    }
  }

  const finalCoverage = summarizeContentWritingCoverage({
    knowledge,
    sectionCoverages: Array.from(activeSectionCoverageByKey.values()),
  });
  const finalClaimUsage = summarizeContentWritingClaimUsage({
    claimLedger: knowledge.claimLedger,
    usedClaimIds: Array.from(activeSectionCoverageByKey.values())
      .flatMap(coverage => coverage.usedClaimIds),
  });
  const revisionApplySteps = Array.from(stepMap.values()).filter(step => (
    step.status === 'completed'
    && isRecord(step.metadata?.revisionDecision)
  ));
  const acceptedRevisionCount = revisionApplySteps.filter(
    step => (step.metadata.revisionDecision as JsonObject).accepted === true,
  ).length;
  const rejectedRevisionCount = revisionApplySteps.length - acceptedRevisionCount;
  const persistedExecution = getPersistedExecution(finalStep);
  const usage = getWorkflowUsage(stepMap.values());
  const finalSectionStructure = auditContentWritingFinalSectionStructure({
    markdown: finalOutput,
    goalContext,
  });
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
      stepCount: Array.from(stepMap.values()).filter(step => !step.metadata?.candidatePhase).length,
      completedStepCount: getCompletedCount(stepMap.values()),
      candidateRequestStepCount: Array.from(stepMap.values())
        .filter(step => Boolean(step.metadata?.candidatePhase)).length,
      finalStepKey: finalStep.step_key,
      qualityPolicyVersion: qualityRuntime?.configuration.policyVersion || null,
      qualityGatePassed: qualityReport?.passed ?? null,
      qualityReport,
      qualityRepairCount: repairPasses,
      lengthTarget: options.session.context_snapshot?.lengthTarget || null,
      targetWordRange: qualityRuntime?.configuration.policy.targetWords || null,
      outlineSectionRange: qualityRuntime?.configuration.policy.outlineSections || null,
      selectedOutlineSectionCount: outline.sections.length,
      bodyTargetWordCount: outline.sections.reduce(
        (sum, section) => sum + (section.targetWords || 0),
        0,
      ),
      revisionSafety: {
        mode: 'targeted_hybrid',
        acceptedRevisionCount,
        rejectedRevisionCount,
        unchangedContentProtected: true,
        qualityRegressionRollback: true,
        knowledgeCoverageRollback: true,
        blockedClaimRollback: true,
        faqIndependenceRollback: true,
      },
      faqIndependence: faqAudit ? {
        version: faqAudit.version,
        pageType: faqAudit.pageType,
        discoveredQuestionSeedCount: faqAudit.questionSeeds.length,
        acceptedQuestionCount: faqAudit.acceptedCount,
        rejectedQuestionCount: faqAudit.rejectedCount,
        needsInformationQuestionCount: faqAudit.needsInformationCount,
      } : null,
      finalSectionStructure,
      usage,
      knowledgeCoverage: {
        sourceChunkCount: competitorChunks.length,
        knowledgeItemCount: knowledge.items.length,
        modelIndexedChunkCount: knowledge.modelProcessedChunkIds.length,
        fallbackChunkCount: knowledge.fallbackChunkIds.length,
        allCompetitorIdeaCount: knowledge.competitorCoverageMatrix.allCompetitorIdeaIds.length,
        multipleCompetitorIdeaCount: knowledge.competitorCoverageMatrix.multipleCompetitorIdeaIds.length,
        singleCompetitorIdeaCount: knowledge.competitorCoverageMatrix.singleCompetitorIdeaIds.length,
        originalityOpportunityIdeaCount:
          knowledge.competitorCoverageMatrix.originalityOpportunityIdeaIds.length,
        sourceCount: knowledge.sourceRegistry.sources.length,
        primarySourceCount: knowledge.sourceRegistry.primarySourceIds.length,
        contextualSourceCount: knowledge.sourceRegistry.contextualSourceIds.length,
        referenceOnlySourceCount: knowledge.sourceRegistry.referenceOnlySourceIds.length,
        claimCount: knowledge.claimLedger.claims.length,
        allowedClaimCount: knowledge.claimLedger.allowedClaimIds.length,
        qualifiedClaimCount: knowledge.claimLedger.qualifiedClaimIds.length,
        blockedClaimCount: knowledge.claimLedger.blockedClaimIds.length,
        usedClaimCount: finalClaimUsage.usedClaimIds.length,
        declaredBlockedClaimIdsBeforeFinalReview: claimUsageAfterRepairs.blockedClaimIds,
        declaredBlockedClaimIdsAfterRevisions: finalClaimUsage.blockedClaimIds,
        coverageByCompetitor: knowledge.competitorCoverageMatrix.coverageByCompetitor.map(item => ({
          competitorNumber: item.competitorNumber,
          ideaCount: item.knowledgeItemIds.length,
          highPriorityIdeaCount: item.highPriorityItemIds.length,
        })),
        beforeAuditPercent: coverageBeforeAudit.coveragePercent,
        afterRepairPercent: finalCoverage.coveragePercent,
        coveredIdeaCount: finalCoverage.coveredIdeaIds.length,
        missingIdeaIds: finalCoverage.missingIdeaIds,
        targetedRepairCount: coverageAudit.repairs.length,
      },
    },
  };
};
