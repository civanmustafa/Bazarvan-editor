import {
  ExternalAnalysisBlockedError,
  ExternalAnalysisOwnershipLostError,
  ExternalAnalysisRetryError,
  registerExternalAnalysisJobExecutor,
  type ExternalAnalysisExecutionContext,
} from './externalAnalysisExecutor';
import {
  getExternalAnalysisSupabaseAdmin,
  type ExternalAnalysisJob,
  type ExternalAnalysisJson,
} from './externalAnalysisQueue';
import { queueContentWritingSession } from './contentWritingEngine';
import {
  cancelContentWritingSession,
  getContentWritingSession,
  getContentWritingSteps,
  resumeContentWritingSession,
  type ContentWritingProvider,
  type ContentWritingSession,
} from './contentWritingSessionService';
import {
  contentWritingMarkdownToPlainText,
  prepareContentWritingResultForEditor,
} from '../utils/contentWritingWorkflow';
import { parseMarkdownToArticleHtml } from '../utils/editorUtils';
import {
  reevaluateContentWritingQualityAfterExternalReview,
  type ContentWritingSourceAccuracyInput,
} from '../utils/contentWritingQuality';
import {
  normalizeContentWritingKnowledgeBase,
  normalizeContentWritingSourceChunks,
} from '../utils/contentWritingKnowledge';
import { htmlToTipTapJson, preserveExistingArticleLinks } from '../utils/editorHtmlContent';
import {
  CONTENT_WRITING_MIN_COMPETITOR_COUNT,
  CONTENT_WRITING_MIN_DISTINCT_SOURCE_DOMAINS,
  selectQualityContentWritingCompetitors,
  type ContentWritingCompetitorInput,
} from '../utils/contentWritingContext';
import {
  enqueueCompetitorPreparationDiscovery,
  enqueueCompetitorPreparationExtraction,
  selectCompetitorPreparationSources,
} from './competitorPreparationCoordinator';
import { readManagedArticleCompetitors } from './articleCompetitorRepository';
import {
  evaluateContentWritingEditorSourceCoverage,
  evaluateContentWritingEditorStructureCoverage,
  normalizeContentWritingEditorSourceLedger,
} from '../utils/contentWritingEditorSource';

const COMPREHENSIVE_COMMAND_ID = 'smartAnalysis.competitorContentComparison';
const TERMINAL_EXTERNAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const ACTIVE_EXTERNAL_STATUSES = new Set([
  'waiting_for_prerequisites',
  'queued',
  'running',
  'retry_scheduled',
  'paused',
]);
const POLL_INTERVAL_MS = 10_000;
const PIPELINE_STAGE_TIMEOUT_MS = Math.max(
  5 * 60_000,
  Math.min(
    Number(process.env.FULL_ARTICLE_PIPELINE_STAGE_TIMEOUT_MS) || 2 * 60 * 60_000,
    6 * 60 * 60_000,
  ),
);

type ArticleRow = {
  id: string;
  title: string | null;
  keywords: unknown;
  goal_context: unknown;
  article_language: string | null;
  metadata: unknown;
  content_json: unknown;
  content_html: string | null;
  plain_text: string | null;
  save_count: number;
  updated_at: string;
};

type ChildJobSnapshot = Pick<
  ExternalAnalysisJob,
  'id' | 'status' | 'progress' | 'result' | 'last_error' | 'last_error_code' | 'next_attempt_at'
>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const numberValue = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> => (
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('The full article pipeline was cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('The full article pipeline was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  })
);

const readArticle = async (articleId: string): Promise<ArticleRow> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('articles')
    .select('id,title,keywords,goal_context,article_language,metadata,content_json,content_html,plain_text,save_count,updated_at')
    .eq('id', articleId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Article ${articleId} was not found.`);
  return data as ArticleRow;
};

const getSemanticKeywordReadiness = (article: ArticleRow): {
  ready: boolean;
  missingFields: string[];
} => {
  const keywords = isRecord(article.keywords) ? article.keywords : {};
  const hasSecondaries = Array.isArray(keywords.secondaries)
    && keywords.secondaries.some(item => Boolean(text(item)));
  const hasLsi = Array.isArray(keywords.lsi)
    && keywords.lsi.some(item => Boolean(text(item)));
  const missingFields = [
    hasSecondaries ? '' : 'alternative_keywords',
    hasLsi ? '' : 'lsi_keywords',
  ].filter(Boolean);
  return { ready: missingFields.length === 0, missingFields };
};

const readExternalJob = async (
  jobId: string,
  includeResult = false,
): Promise<ChildJobSnapshot> => {
  const table = getExternalAnalysisSupabaseAdmin().from('ai_external_analysis_jobs');
  const queryResult = includeResult
    ? await table
      .select('id,status,progress,result,last_error,last_error_code,next_attempt_at')
      .eq('id', jobId)
      .maybeSingle()
    : await table
      .select('id,status,progress,last_error,last_error_code,next_attempt_at')
      .eq('id', jobId)
      .maybeSingle();
  const { data, error } = queryResult;
  if (error) throw error;
  if (!data) throw new Error(`External analysis child job ${jobId} was not found.`);
  const source = data as unknown as Record<string, unknown>;
  return {
    ...(data as unknown as ChildJobSnapshot),
    result: includeResult && isRecord(source.result)
      ? source.result as ExternalAnalysisJson
      : null,
  };
};

const retryError = (options: {
  code: string;
  message: string;
  stage: string;
  stageIndex: number;
  details?: ExternalAnalysisJson;
}): never => {
  throw new ExternalAnalysisRetryError({
    code: options.code,
    message: options.message,
    progress: {
      stage: options.stage,
      stageIndex: options.stageIndex,
      stageCount: 7,
      retryReason: options.code,
      ...(options.details || {}),
    },
  });
};

const reportStage = async (
  context: ExternalAnalysisExecutionContext,
  stage: string,
  stageIndex: number,
  details: ExternalAnalysisJson = {},
): Promise<void> => {
  const childProgress = isRecord(details.childProgress) ? details.childProgress : {};
  const owned = await context.reportProgress({
    progress: {
      stage,
      stageIndex,
      stageCount: 7,
      qualityGatePolicy: 'review_required',
      ...(stageIndex < 6 ? { qualityGatePassed: null } : {}),
      ...details,
      updatedAt: new Date().toISOString(),
    },
    provider: text(childProgress.provider) || undefined,
    model: text(childProgress.model) || undefined,
    keyAttempts: Array.isArray(childProgress.keyAttempts)
      ? childProgress.keyAttempts.filter(isRecord)
      : undefined,
  });
  if (!owned) {
    throw new ExternalAnalysisOwnershipLostError(
      `Progress ownership was lost while reporting full pipeline stage ${stage}.`,
    );
  }
};

const getPipelineLeaseGeneration = (context: ExternalAnalysisExecutionContext): number => {
  const generation = Number((context.job as unknown as Record<string, unknown>).lease_generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ExternalAnalysisOwnershipLostError('The full pipeline claim has no valid fencing generation.');
  }
  return generation;
};

const assertLeaseOwned = async (context: ExternalAnalysisExecutionContext): Promise<void> => {
  if (context.signal.aborted || !await context.renewLease()) {
    throw new ExternalAnalysisOwnershipLostError('The full pipeline lease could not be renewed.');
  }
};

const attachExternalChild = async (options: {
  context: ExternalAnalysisExecutionContext;
  jobId: string;
  kind: 'semantic' | 'brief' | 'discovery' | 'extraction' | 'analysis';
  leaseGeneration: number;
}): Promise<void> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'attach_full_article_pipeline_external_child',
    {
      p_pipeline_job_id: options.context.job.id,
      p_child_job_id: options.jobId,
      p_child_kind: options.kind,
      p_worker_id: options.context.workerId,
      p_lease_generation: options.leaseGeneration,
    },
  );
  if (error) throw error;
  if (data !== true) throw new ExternalAnalysisOwnershipLostError();
};

const attachWritingSession = async (options: {
  context: ExternalAnalysisExecutionContext;
  sessionId: string;
  leaseGeneration: number;
}): Promise<void> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'attach_full_article_pipeline_writing_session',
    {
      p_pipeline_job_id: options.context.job.id,
      p_session_id: options.sessionId,
      p_worker_id: options.context.workerId,
      p_lease_generation: options.leaseGeneration,
    },
  );
  if (error) throw error;
  if (data !== true) throw new ExternalAnalysisOwnershipLostError();
};

const waitForExternalJob = async (options: {
  context: ExternalAnalysisExecutionContext;
  jobId: string;
  stage: string;
  stageIndex: number;
}): Promise<ChildJobSnapshot> => {
  let childRetryAttempted = false;
  const waitStartedAt = Date.now();
  const parentProgress = isRecord(options.context.job.progress) ? options.context.job.progress : {};
  while (true) {
    if (options.context.signal.aborted) {
      throw options.context.signal.reason ?? new Error('The full article pipeline was cancelled.');
    }
    if (Date.now() - waitStartedAt >= PIPELINE_STAGE_TIMEOUT_MS) {
      retryError({
        code: `full_pipeline_${options.stage}_timeout`,
        message: `The ${options.stage} child did not reach a terminal state before the bounded wait deadline.`,
        stage: options.stage,
        stageIndex: options.stageIndex,
        details: { childJobId: options.jobId, waitTimeoutMs: PIPELINE_STAGE_TIMEOUT_MS },
      });
    }
    const snapshot = await readExternalJob(options.jobId, false);
    await reportStage(options.context, options.stage, options.stageIndex, {
      childJobId: options.jobId,
      childStatus: snapshot.status,
      childProgress: snapshot.progress || {},
      nextAttemptAt: snapshot.next_attempt_at,
    });
    if (snapshot.status === 'completed') return readExternalJob(options.jobId, true);
    if (snapshot.status === 'retry_scheduled') {
      const nextAttemptAt = new Date(snapshot.next_attempt_at || '').getTime();
      if (!Number.isFinite(nextAttemptAt) || nextAttemptAt <= Date.now()) {
        await delay(POLL_INTERVAL_MS, options.context.signal);
        continue;
      }
      retryError({
        code: `full_pipeline_${options.stage}_retry_scheduled`,
        message: snapshot.last_error || `The ${options.stage} stage is scheduled to retry.`,
        stage: options.stage,
        stageIndex: options.stageIndex,
        details: {
          childJobId: options.jobId,
          childStatus: snapshot.status,
          nextAttemptAt: snapshot.next_attempt_at,
        },
      });
    }
    if (TERMINAL_EXTERNAL_STATUSES.has(snapshot.status)) {
      const retryCode = `full_pipeline_${options.stage}_failed`;
      const resumeTargetId = text(parentProgress.resumeTargetId);
      const resumeReason = text(parentProgress.resumeReason);
      const retryReason = text(parentProgress.retryReason);
      const mayRetryChild = resumeTargetId === options.jobId
        || resumeReason === retryCode
        || retryReason === retryCode;
      if (mayRetryChild && !childRetryAttempted) {
        childRetryAttempted = true;
        const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
          'retry_external_analysis_job',
          {
            p_job_id: options.jobId,
            p_requested_by: options.context.job.requested_by,
          },
        );
        if (error) throw error;
        if (data) {
          await delay(POLL_INTERVAL_MS, options.context.signal);
          continue;
        }
      }
      retryError({
        code: retryCode,
        message: snapshot.last_error || `The ${options.stage} stage failed.`,
        stage: options.stage,
        stageIndex: options.stageIndex,
        details: {
          childJobId: options.jobId,
          childStatus: snapshot.status,
          childErrorCode: snapshot.last_error_code,
        },
      });
    }
    if (!ACTIVE_EXTERNAL_STATUSES.has(snapshot.status)) {
      retryError({
        code: `full_pipeline_${options.stage}_unknown_status`,
        message: `The ${options.stage} stage returned an unsupported status: ${snapshot.status}.`,
        stage: options.stage,
        stageIndex: options.stageIndex,
        details: { childJobId: options.jobId, childStatus: snapshot.status },
      });
    }
    await delay(POLL_INTERVAL_MS, options.context.signal);
  }
};

const cancelExternalChild = async (
  jobId: string,
  requestedBy: string,
): Promise<void> => {
  const snapshot = await readExternalJob(jobId).catch((_error: unknown): null => null);
  if (!snapshot || !ACTIVE_EXTERNAL_STATUSES.has(snapshot.status)) return;
  await getExternalAnalysisSupabaseAdmin().rpc('request_external_analysis_job_cancel', {
    p_job_id: jobId,
    p_requested_by: requestedBy,
  });
};

const enqueueSemantic = async (options: {
  context: ExternalAnalysisExecutionContext;
  requestedBy: string;
  leaseGeneration: number;
  completionPass: number;
}): Promise<string | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'enqueue_full_article_pipeline_semantic',
    {
      p_pipeline_job_id: options.context.job.id,
      p_requested_by: options.requestedBy,
      p_worker_id: options.context.workerId,
      p_lease_generation: options.leaseGeneration,
      p_completion_pass: options.completionPass,
    },
  );
  if (error) throw error;
  return typeof data === 'string' ? data : null;
};

const enqueueBrief = async (
  pipelineJobId: string,
  requestedBy: string,
): Promise<string> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'enqueue_full_article_pipeline_brief',
    {
      p_pipeline_job_id: pipelineJobId,
      p_requested_by: requestedBy,
    },
  );
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  const id = text(row?.id);
  if (!id) throw new Error('The content brief stage did not return a job.');
  return id;
};

const readQualityCompetitors = async (articleId: string): Promise<{
  competitors: ContentWritingCompetitorInput[];
  audit: ReturnType<typeof selectQualityContentWritingCompetitors>['audit'];
}> => {
  const snapshot = await readManagedArticleCompetitors(articleId);
  return selectQualityContentWritingCompetitors(snapshot.competitors);
};

const waitForContentWriting = async (options: {
  context: ExternalAnalysisExecutionContext;
  sessionId: string;
  requestedBy: string;
  resumeAlreadyAttempted?: boolean;
}): Promise<ContentWritingSession> => {
  const waitStartedAt = Date.now();
  const resumeTargetId = text(options.context.job.progress?.resumeTargetId);
  let resumeAttempted = options.resumeAlreadyAttempted === true;
  while (true) {
    if (options.context.signal.aborted) {
      throw options.context.signal.reason ?? new Error('The full article pipeline was cancelled.');
    }
    if (Date.now() - waitStartedAt >= PIPELINE_STAGE_TIMEOUT_MS) {
      retryError({
        code: 'full_pipeline_content_writing_timeout',
        message: 'The content-writing session did not reach a terminal state before the bounded wait deadline.',
        stage: 'content_writing',
        stageIndex: 5,
        details: {
          contentWritingSessionId: options.sessionId,
          waitTimeoutMs: PIPELINE_STAGE_TIMEOUT_MS,
        },
      });
    }
    const session = await getContentWritingSession(options.sessionId);
    if (!session) throw new Error(`Content writing session ${options.sessionId} was not found.`);
    await reportStage(options.context, 'content_writing', 5, {
      contentWritingSessionId: session.id,
      contentWritingStatus: session.status,
      childProgress: session.progress || {},
      nextAttemptAt: session.next_attempt_at,
      qualityScore: session.quality_score,
      qualityGatePassed: isRecord(session.quality_report)
        && typeof session.quality_report.passed === 'boolean'
        ? session.quality_report.passed
        : null,
    });
    if (session.status === 'completed') return session;
    if (session.status === 'failed' || session.status === 'cancelled') {
      if (!resumeAttempted && resumeTargetId === session.id) {
        resumeAttempted = true;
        const resumed = await resumeContentWritingAfterScheduledRetry(
          session,
          options.requestedBy,
        );
        await reportStage(options.context, 'content_writing', 5, {
          contentWritingSessionId: resumed.id,
          contentWritingStatus: resumed.status,
          resumedAfterParentCancellation: true,
        });
        continue;
      }
      retryError({
        code: 'full_pipeline_content_writing_failed',
        message: session.last_error || 'Content writing failed.',
        stage: 'content_writing',
        stageIndex: 5,
        details: {
          contentWritingSessionId: session.id,
          contentWritingStatus: session.status,
          childErrorCode: session.last_error_code,
        },
      });
    }
    await delay(POLL_INTERVAL_MS, options.context.signal);
  }
};

const resumeContentWritingAfterScheduledRetry = async (
  session: ContentWritingSession,
  requestedBy: string,
): Promise<ContentWritingSession> => {
  if (session.status !== 'failed' && session.status !== 'cancelled') return session;
  const resumed = await resumeContentWritingSession({
    sessionId: session.id,
    requestedBy,
    provider: session.provider,
    model: session.model,
    inputHash: session.input_hash,
    allowModelFallback: session.context_snapshot?.allowModelFallback === true,
  });
  if (!resumed) throw new Error('The failed content-writing session could not be resumed.');
  return resumed;
};

const getContentWritingSourceAccuracyInput = async (
  session: ContentWritingSession,
  baselineMarkdown: string,
): Promise<ContentWritingSourceAccuracyInput> => {
  const chunks = normalizeContentWritingSourceChunks(session.context_snapshot?.competitorChunks);
  const steps = await getContentWritingSteps(session.id, { includeMetadata: true });
  const knowledgeStep = steps.find(step => (
    step.step_key === 'competitor-index'
    && isRecord(step.metadata?.knowledge)
  ));
  const normalizedKnowledge = knowledgeStep && chunks.length > 0
    ? normalizeContentWritingKnowledgeBase(knowledgeStep.metadata.knowledge, chunks)
    : null;
  const knowledge = normalizedKnowledge?.items.length
    ? normalizedKnowledge
    : null;
  const knowledgeCoverage = isRecord(session.response_metadata?.knowledgeCoverage)
    ? session.response_metadata.knowledgeCoverage
    : {};
  const persistedUsedClaimIds = Array.isArray(knowledgeCoverage.usedClaimIds)
    ? knowledgeCoverage.usedClaimIds.map(text).filter(Boolean)
    : [];
  const fallbackUsedClaimIds = steps.flatMap(step => {
    const sectionCoverage = isRecord(step.metadata?.sectionCoverage)
      ? step.metadata.sectionCoverage
      : {};
    const direct = Array.isArray(sectionCoverage.usedClaimIds)
      ? sectionCoverage.usedClaimIds.map(text).filter(Boolean)
      : [];
    const revised = Array.isArray(step.metadata?.sectionCoveragesAfter)
      ? step.metadata.sectionCoveragesAfter.flatMap(candidate => {
          if (!isRecord(candidate) || !isRecord(candidate.coverage)) return [];
          return Array.isArray(candidate.coverage.usedClaimIds)
            ? candidate.coverage.usedClaimIds.map(text).filter(Boolean)
            : [];
        })
      : [];
    return [...direct, ...revised];
  });
  return {
    knowledge,
    usedClaimIds: Array.from(new Set(
      persistedUsedClaimIds.length > 0 ? persistedUsedClaimIds : fallbackUsedClaimIds,
    )),
    baselineMarkdown,
  };
};

const enqueueComprehensiveAnalysis = async (options: {
  context: ExternalAnalysisExecutionContext;
  requestedBy: string;
  leaseGeneration: number;
  plainText: string;
  contentHtml: string;
}): Promise<string> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'enqueue_full_article_pipeline_draft_analysis',
    {
      p_pipeline_job_id: options.context.job.id,
      p_requested_by: options.requestedBy,
      p_worker_id: options.context.workerId,
      p_lease_generation: options.leaseGeneration,
      p_plain_text: options.plainText,
      p_content_html: options.contentHtml,
    },
  );
  if (error) {
    if (error.code === '55000') throw new ExternalAnalysisOwnershipLostError();
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const id = text(row?.id);
  if (!id) throw new Error('The comprehensive draft analysis did not return a job.');
  return id;
};

const persistDraftReview = async (options: {
  context: ExternalAnalysisExecutionContext;
  sessionId: string;
  analysisJobId: string;
  leaseGeneration: number;
  markdown: string;
  qualityReport: ExternalAnalysisJson;
  reviewMetadata: ExternalAnalysisJson;
  contentJson?: ExternalAnalysisJson;
  contentHtml?: string;
  plainText?: string;
}): Promise<void> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'persist_full_article_pipeline_draft_review',
    {
      p_pipeline_job_id: options.context.job.id,
      p_session_id: options.sessionId,
      p_analysis_job_id: options.analysisJobId,
      p_worker_id: options.context.workerId,
      p_lease_generation: options.leaseGeneration,
      p_markdown: options.markdown,
      p_quality_report: options.qualityReport,
      p_review_metadata: options.reviewMetadata,
      ...(options.contentJson ? { p_content_json: options.contentJson } : {}),
      ...(options.contentHtml !== undefined ? { p_content_html: options.contentHtml } : {}),
      ...(options.plainText !== undefined ? { p_plain_text: options.plainText } : {}),
    },
  );
  if (error) throw error;
  if (data !== true) throw new ExternalAnalysisOwnershipLostError();
};

const executeFullArticlePipeline = async (
  context: ExternalAnalysisExecutionContext,
) => {
  const requestedBy = text(context.job.requested_by);
  if (!requestedBy) throw new Error('The full article pipeline requires a requesting user.');
  const input = isRecord(context.job.input_snapshot) ? context.job.input_snapshot : {};
  const provider = text(input.provider) as ContentWritingProvider;
  const model = text(input.model);
  const competitorCount = Math.max(
    CONTENT_WRITING_MIN_COMPETITOR_COUNT,
    Math.min(5, Math.round(numberValue(input.competitorCount, 5))),
  );
  const leaseGeneration = getPipelineLeaseGeneration(context);
  const baselineSaveCount = Math.round(numberValue(input.baselineSaveCount, -1));
  const baselineContentHash = text(input.baselineContentHash);
  if (baselineSaveCount < 0 || !baselineContentHash) {
    throw new ExternalAnalysisBlockedError({
      code: 'full_pipeline_baseline_missing',
      message: 'The pipeline has no trusted article baseline and cannot apply content safely.',
      progress: { stage: 'blocked', reviewRequired: true },
    });
  }
  const savedProgress = isRecord(context.job.progress) ? context.job.progress : {};
  let activeExternalChildId = '';
  let contentWritingSessionId = text(savedProgress.contentWritingSessionId);

  try {
    await reportStage(context, 'semantic_keywords_lsi', 1);
    let semanticReadiness = getSemanticKeywordReadiness(await readArticle(context.job.article_id));
    const semanticJobIds: string[] = [];
    for (let pass = 0; pass < 2 && !semanticReadiness.ready; pass += 1) {
      const semanticJobId = await enqueueSemantic({
        context,
        requestedBy,
        leaseGeneration,
        completionPass: pass + 1,
      }) || '';
      if (!semanticJobId || semanticJobIds.includes(semanticJobId)) break;
      semanticJobIds.push(semanticJobId);
      activeExternalChildId = semanticJobId;
      await attachExternalChild({
        context,
        jobId: semanticJobId,
        kind: 'semantic',
        leaseGeneration,
      });
      await reportStage(context, 'semantic_keywords_lsi', 1, {
        semanticJobId,
        semanticJobIds,
        semanticCompletionPass: pass + 1,
      });
      await waitForExternalJob({
        context,
        jobId: semanticJobId,
        stage: 'semantic_keywords_lsi',
        stageIndex: 1,
      });
      activeExternalChildId = '';
      semanticReadiness = getSemanticKeywordReadiness(await readArticle(context.job.article_id));
    }
    if (!semanticReadiness.ready) {
      retryError({
        code: 'full_pipeline_semantic_keywords_incomplete',
        message: 'Semantic keyword generation completed without filling every required keyword list.',
        stage: 'semantic_keywords_lsi',
        stageIndex: 1,
        details: {
          semanticJobIds,
          missingFields: semanticReadiness.missingFields,
        },
      });
    }
    if (semanticJobIds.length === 0) {
      await reportStage(context, 'semantic_keywords_lsi', 1, { skipped: true, reason: 'already_populated' });
    }

    await reportStage(context, 'content_brief_generation', 2);
    const briefJobId = text(savedProgress.briefJobId) || await enqueueBrief(context.job.id, requestedBy);
    activeExternalChildId = briefJobId;
    await attachExternalChild({ context, jobId: briefJobId, kind: 'brief', leaseGeneration });
    await reportStage(context, 'content_brief_generation', 2, { briefJobId });
    const brief = await waitForExternalJob({
      context,
      jobId: briefJobId,
      stage: 'content_brief_generation',
      stageIndex: 2,
    });
    const generatedBrief = text(brief.result?.briefText);
    if (!generatedBrief) {
      retryError({
        code: 'full_pipeline_content_brief_missing',
        message: 'The completed content-brief stage did not contain a saved brief.',
        stage: 'content_brief_generation',
        stageIndex: 2,
        details: { briefJobId },
      });
    }
    await reportStage(context, 'content_brief_generation', 2, {
      briefJobId,
      contentBriefSavedAt: text(brief.result?.articleUpdatedAt) || new Date().toISOString(),
    });
    activeExternalChildId = '';

    const competitorInputsMustBeReplaced = [
      text(savedProgress.retryReason),
      text(savedProgress.resumeReason),
    ].some(reason => (
      reason === 'full_pipeline_no_competitor_content'
      || reason === 'full_pipeline_insufficient_competitor_content'
      || reason === 'full_pipeline_no_competitors_found'
    ));
    await reportStage(context, 'competitor_discovery', 3, {
      forceRefresh: competitorInputsMustBeReplaced,
    });
    const discoveryJobId = (!competitorInputsMustBeReplaced
      ? text(savedProgress.discoveryJobId)
      : '') || await enqueueCompetitorPreparationDiscovery({
      mode: 'full_article_pipeline',
      pipelineJobId: context.job.id,
      requestedBy,
      workerId: context.workerId,
      leaseGeneration,
      forceRefresh: competitorInputsMustBeReplaced,
    });
    activeExternalChildId = discoveryJobId;
    await attachExternalChild({ context, jobId: discoveryJobId, kind: 'discovery', leaseGeneration });
    await reportStage(context, 'competitor_discovery', 3, { discoveryJobId });
    const discovery = await waitForExternalJob({
      context,
      jobId: discoveryJobId,
      stage: 'competitor_discovery',
      stageIndex: 3,
    });
    activeExternalChildId = '';
    const sources = selectCompetitorPreparationSources(discovery.result, competitorCount);
    if (sources.length === 0) {
      retryError({
        code: 'full_pipeline_no_competitors_found',
        message: 'No valid competitor pages were available after discovery and deterministic filtering.',
        stage: 'competitor_discovery',
        stageIndex: 3,
        details: { discoveryJobId },
      });
    }
    const discoveryInput = isRecord(discovery.result) ? discovery.result : {};
    const queryType = text(discoveryInput.queryType) || 'primary_keyword';
    const queryText = text(discoveryInput.query) || text(input.articleTitle);

    await reportStage(context, 'competitor_extraction', 4, {
      selectedCompetitorCount: sources.length,
    });
    const extractionMustBeReplaced = competitorInputsMustBeReplaced;
    let extractionJobId = extractionMustBeReplaced
      ? ''
      : text(savedProgress.extractionJobId);
    if (!extractionJobId) {
      extractionJobId = await enqueueCompetitorPreparationExtraction({
        articleId: context.job.article_id,
        requestedBy,
        origin: 'full_article_pipeline',
        queryType,
        queryText,
        sources,
      });
    }
    activeExternalChildId = extractionJobId;
    await attachExternalChild({ context, jobId: extractionJobId, kind: 'extraction', leaseGeneration });
    await reportStage(context, 'competitor_extraction', 4, {
      extractionJobId,
      selectedCompetitorCount: sources.length,
    });
    const extraction = await waitForExternalJob({
      context,
      jobId: extractionJobId,
      stage: 'competitor_extraction',
      stageIndex: 4,
    });
    activeExternalChildId = '';
    if (numberValue(extraction.result?.successfulCount, 0) < 1) {
      retryError({
        code: 'full_pipeline_no_competitor_content',
        message: 'Firecrawl and programmatic extraction did not produce usable text for any selected competitor.',
        stage: 'competitor_extraction',
        stageIndex: 4,
        details: { extractionJobId },
      });
    }
    const competitorQuality = await readQualityCompetitors(context.job.article_id);
    await reportStage(context, 'competitor_extraction', 4, {
      extractionJobId,
      selectedCompetitorCount: sources.length,
      competitorQualityAudit: competitorQuality.audit as unknown as ExternalAnalysisJson,
      acceptedCompetitorCount: competitorQuality.audit.acceptedCount,
      distinctCompetitorDomainCount: competitorQuality.audit.distinctDomainCount,
      rejectedCompetitorCount: competitorQuality.audit.rejectedCount,
      replacementNeededCount: competitorQuality.audit.replacementNeededCount,
    });
    if (
      competitorQuality.audit.acceptedCount < CONTENT_WRITING_MIN_COMPETITOR_COUNT
      || competitorQuality.audit.distinctDomainCount < CONTENT_WRITING_MIN_DISTINCT_SOURCE_DOMAINS
    ) {
      retryError({
        code: 'full_pipeline_insufficient_competitor_content',
        message: `Only ${competitorQuality.audit.acceptedCount} quality competitors across ${competitorQuality.audit.distinctDomainCount} domains were available; at least ${CONTENT_WRITING_MIN_COMPETITOR_COUNT} competitors across ${CONTENT_WRITING_MIN_DISTINCT_SOURCE_DOMAINS} domains are required.`,
        stage: 'competitor_extraction',
        stageIndex: 4,
        details: {
          extractionJobId,
          competitorQualityAudit: competitorQuality.audit as unknown as ExternalAnalysisJson,
          replacementNeededCount: Math.max(
            competitorQuality.audit.replacementNeededCount,
            competitorQuality.audit.distinctDomainCount < CONTENT_WRITING_MIN_DISTINCT_SOURCE_DOMAINS ? 1 : 0,
          ),
        },
      });
    }

    await reportStage(context, 'content_writing', 5, {
      provider,
      model,
    });
    let writingSession = contentWritingSessionId
      ? await getContentWritingSession(contentWritingSessionId)
      : null;
    let writingResumeAttempted = false;
    if (writingSession && (writingSession.status === 'failed' || writingSession.status === 'cancelled')) {
      const writingResumeRequested = text(savedProgress.resumeTargetId) === writingSession.id
        || text(savedProgress.retryReason) === 'full_pipeline_content_writing_failed'
        || text(savedProgress.resumeReason) === 'full_pipeline_content_writing_failed';
      if (writingResumeRequested) {
        writingSession = await resumeContentWritingAfterScheduledRetry(writingSession, requestedBy);
        writingResumeAttempted = true;
      } else {
        retryError({
          code: 'full_pipeline_content_writing_failed',
          message: writingSession.last_error || 'Content writing failed.',
          stage: 'content_writing',
          stageIndex: 5,
          details: { contentWritingSessionId: writingSession.id },
        });
      }
    }
    if (!writingSession) {
      const queued = await queueContentWritingSession({
        articleId: context.job.article_id,
        createdBy: requestedBy,
        provider,
        model,
        idempotencyKey: `full-pipeline:${context.job.id}:content-writing`,
        allowMissingCompany: true,
        allowMissingGoalContext: true,
        contextSnapshotPatch: {
          triggerSource: 'full_pipeline',
          fullArticlePipelineJobId: context.job.id,
          fullPipelineOptionalPrerequisites: {
            company: true,
            goalContext: true,
          },
        },
      });
      writingSession = queued.session;
    }
    contentWritingSessionId = writingSession.id;
    await attachWritingSession({ context, sessionId: contentWritingSessionId, leaseGeneration });
    await reportStage(context, 'content_writing', 5, {
      contentWritingSessionId,
      contentWritingStatus: writingSession.status,
      provider,
      model: writingSession.model,
    });
    writingSession = await waitForContentWriting({
      context,
      sessionId: contentWritingSessionId,
      requestedBy,
      resumeAlreadyAttempted: writingResumeAttempted,
    });

    const article = await readArticle(context.job.article_id);
    const latestGoalContext = isRecord(article.goal_context) ? article.goal_context : {};
    const prepared = prepareContentWritingResultForEditor(
      writingSession.result_text || '',
      text(article.title),
    );
    if (!prepared.markdown) {
      retryError({
        code: 'full_pipeline_generated_article_empty',
        message: 'The completed content-writing session did not contain an insertable article.',
        stage: 'content_writing',
        stageIndex: 5,
        details: { contentWritingSessionId },
      });
    }
    const articleLanguage = article.article_language === 'en' ? 'en' : 'ar';
    const draftContentHtml = parseMarkdownToArticleHtml(prepared.markdown, articleLanguage);

    await reportStage(context, 'comprehensive_competitor_analysis', 6, {
      commandId: COMPREHENSIVE_COMMAND_ID,
      contentWritingSessionId,
      auditTarget: 'generated_draft',
    });
    await assertLeaseOwned(context);
    const analysisJobId = await enqueueComprehensiveAnalysis({
      context,
      requestedBy,
      leaseGeneration,
      // The review emits exact literal Markdown patches, so its source draft
      // must retain the same headings, tables, links, and anchors that the
      // patch applier will inspect later.
      plainText: prepared.markdown,
      contentHtml: draftContentHtml,
    });
    activeExternalChildId = analysisJobId;
    await attachExternalChild({ context, jobId: analysisJobId, kind: 'analysis', leaseGeneration });
    await reportStage(context, 'comprehensive_competitor_analysis', 6, {
      analysisJobId,
      commandId: COMPREHENSIVE_COMMAND_ID,
      auditTarget: 'generated_draft',
    });
    const analysis = await waitForExternalJob({
      context,
      jobId: analysisJobId,
      stage: 'comprehensive_competitor_analysis',
      stageIndex: 6,
    });
    activeExternalChildId = '';

    const analysisResult = isRecord(analysis.result) ? analysis.result : {};
    const analysisPatches = Array.isArray(analysisResult.patches) ? analysisResult.patches : [];
    const analysisUsable = analysisResult.status === 'completed'
      && (Boolean(text(analysisResult.analysisMarkdown)) || analysisPatches.length > 0);
    if (!analysisUsable) {
      throw new ExternalAnalysisBlockedError({
        code: 'full_pipeline_external_review_blocked',
        message: 'The draft audit completed without a usable, non-superseded review result.',
        progress: {
          stage: 'comprehensive_competitor_analysis',
          stageIndex: 6,
          stageCount: 7,
          contentWritingSessionId,
          analysisJobId,
          reviewRequired: true,
          analysisResultStatus: text(analysisResult.status) || 'empty',
        },
      });
    }

    const sourceAccuracy = await getContentWritingSourceAccuracyInput(
      writingSession,
      prepared.markdown,
    );
    const frozenQualityConfiguration = isRecord(
      writingSession.context_snapshot?.qualityConfiguration,
    )
      ? writingSession.context_snapshot.qualityConfiguration
      : undefined;
    const externalReview = reevaluateContentWritingQualityAfterExternalReview({
      markdown: prepared.markdown,
      patches: analysisPatches,
      articleTitle: text(article.title),
      keywords: (isRecord(article.keywords) ? article.keywords : {}) as any,
      goalContext: latestGoalContext as any,
      articleLanguage,
      configuration: frozenQualityConfiguration,
      repairPasses: writingSession.quality_repair_count,
      sourceAccuracy,
    });
    const reviewedMarkdown = externalReview.patchApplication.markdown;
    const reviewedQuality = externalReview.evaluation.report;
    const editorSourceLedger = normalizeContentWritingEditorSourceLedger(
      writingSession.context_snapshot?.editorSourceLedger,
    );
    const editorSourceItemIds = editorSourceLedger.items.map(item => item.id);
    const editorSourceCoverage = evaluateContentWritingEditorSourceCoverage({
      outputText: contentWritingMarkdownToPlainText(reviewedMarkdown),
      items: editorSourceLedger.items,
      requiredItemIds: editorSourceItemIds,
      declaredItemIds: editorSourceItemIds,
    });
    const editorStructureCoverage = evaluateContentWritingEditorStructureCoverage({
      outputMarkdown: reviewedMarkdown,
      structure: editorSourceLedger.structure,
    });
    const reviewMetadata: ExternalAnalysisJson = {
      auditTarget: 'generated_draft',
      appliedPatches: externalReview.patchApplication.applied,
      rejectedPatches: externalReview.patchApplication.rejected,
      patchChangedDraft: externalReview.patchApplication.changed,
      analysisMarkdown: text(analysisResult.analysisMarkdown).slice(0, 20_000),
      editorSourceCoverage: editorSourceCoverage as unknown as ExternalAnalysisJson,
      editorStructureCoverage: editorStructureCoverage as unknown as ExternalAnalysisJson,
    };
    await assertLeaseOwned(context);
    await persistDraftReview({
      context,
      sessionId: writingSession.id,
      analysisJobId,
      leaseGeneration,
      markdown: reviewedMarkdown,
      qualityReport: reviewedQuality as unknown as ExternalAnalysisJson,
      reviewMetadata,
    });

    const externalReviewBlocked = externalReview.patchApplication.rejected.length > 0
      || editorSourceCoverage.missingItemIds.length > 0
      || editorStructureCoverage.passed !== true;
    const reviewBlocked = externalReviewBlocked
      || reviewedQuality.passed !== true
      || reviewedQuality.blockingFailureCount > 0;
    if (reviewBlocked) {
      throw new ExternalAnalysisBlockedError({
        code: externalReviewBlocked
          ? 'full_pipeline_external_review_blocked'
          : 'full_pipeline_quality_review_required',
        message: externalReviewBlocked
          ? 'The external review could not preserve every required source or structure item deterministically; the draft was saved for review.'
          : 'The reviewed draft did not pass the mandatory quality gate and was saved for review.',
        progress: {
          stage: 'comprehensive_competitor_analysis',
          stageIndex: 6,
          stageCount: 7,
          contentWritingSessionId,
          analysisJobId,
          reviewRequired: true,
          qualityReport: reviewedQuality as unknown as ExternalAnalysisJson,
          appliedPatchCount: externalReview.patchApplication.applied.length,
          rejectedPatches: externalReview.patchApplication.rejected,
          editorSourceCoverage: editorSourceCoverage as unknown as ExternalAnalysisJson,
          editorStructureCoverage: editorStructureCoverage as unknown as ExternalAnalysisJson,
        },
      });
    }

    const reviewedPlainText = contentWritingMarkdownToPlainText(reviewedMarkdown);
    const generatedHtml = parseMarkdownToArticleHtml(reviewedMarkdown, articleLanguage);
    const preservedLinks = preserveExistingArticleLinks({
      sourceHtml: article.content_html || '',
      targetHtml: generatedHtml,
    });
    const unresolvedSafeLinks = preservedLinks.missingSafeLinks.filter(issue => (
      issue.reason === 'anchor_missing' || issue.reason === 'anchor_ambiguous'
    ));
    if (unresolvedSafeLinks.length > 0) {
      await persistDraftReview({
        context,
        sessionId: writingSession.id,
        analysisJobId,
        leaseGeneration,
        markdown: reviewedMarkdown,
        qualityReport: reviewedQuality as unknown as ExternalAnalysisJson,
        reviewMetadata: {
          ...reviewMetadata,
          preservedLinkCount: preservedLinks.preservedCount,
          unresolvedSafeLinks,
        },
      });
      throw new ExternalAnalysisBlockedError({
        code: 'full_pipeline_link_preservation_review_required',
        message: 'Existing safe links could not all be preserved unambiguously; the draft was saved for review.',
        progress: {
          stage: 'article_application',
          stageIndex: 7,
          stageCount: 7,
          contentWritingSessionId,
          analysisJobId,
          reviewRequired: true,
          unresolvedSafeLinks,
        },
      });
    }
    const contentHtml = preservedLinks.html;
    const contentJson = htmlToTipTapJson(contentHtml, articleLanguage);
    await persistDraftReview({
      context,
      sessionId: writingSession.id,
      analysisJobId,
      leaseGeneration,
      markdown: reviewedMarkdown,
      qualityReport: reviewedQuality as unknown as ExternalAnalysisJson,
      reviewMetadata: {
        ...reviewMetadata,
        preservedLinkCount: preservedLinks.preservedCount,
      },
      contentJson,
      contentHtml,
      plainText: reviewedPlainText,
    });

    await reportStage(context, 'article_application', 7, {
      contentWritingSessionId,
      analysisJobId,
      qualityGatePolicy: 'review_required',
      qualityScore: reviewedQuality.score,
      qualityGatePassed: true,
      preservedLinkCount: preservedLinks.preservedCount,
    });
    await assertLeaseOwned(context);
    const { data: application, error: applicationError } = await getExternalAnalysisSupabaseAdmin()
      .rpc('apply_full_article_pipeline_content', {
        p_pipeline_job_id: context.job.id,
        p_session_id: writingSession.id,
        p_analysis_job_id: analysisJobId,
        p_worker_id: context.workerId,
        p_lease_generation: leaseGeneration,
        p_baseline_save_count: baselineSaveCount,
        p_baseline_content_hash: baselineContentHash,
        p_reviewed_markdown: reviewedMarkdown,
        p_content_json: contentJson,
        p_content_html: contentHtml,
        p_plain_text: reviewedPlainText,
        p_quality_report: reviewedQuality,
      });
    if (applicationError) {
      if (applicationError.code === '55000') throw new ExternalAnalysisOwnershipLostError();
      if (applicationError.code === '40001') {
        throw new ExternalAnalysisBlockedError({
          code: 'full_pipeline_article_changed',
          message: 'The article changed after the pipeline started; the reviewed draft was not applied.',
          progress: {
            stage: 'article_application',
            stageIndex: 7,
            stageCount: 7,
            contentWritingSessionId,
            analysisJobId,
            reviewRequired: true,
          },
        });
      }
      throw applicationError;
    }

    await reportStage(context, 'article_application', 7, {
      contentWritingSessionId,
      analysisJobId,
      articleAppliedAt: new Date().toISOString(),
      application: isRecord(application) ? application : {},
      qualityGatePolicy: 'review_required',
      qualityScore: reviewedQuality.score,
      qualityGatePassed: true,
      preservedLinkCount: preservedLinks.preservedCount,
    });

    return {
      result: {
        status: 'completed',
        articleId: context.job.article_id,
        contentWritingSessionId,
        articleApplied: true,
        qualityGatePolicy: 'review_required',
        qualityGatePassed: true,
        qualityScore: reviewedQuality.score,
        selectedCompetitorCount: sources.length,
        analysisJobId,
        analysisCompleted: true,
        appliedPatchCount: externalReview.patchApplication.applied.length,
        preservedLinkCount: preservedLinks.preservedCount,
        completedAt: new Date().toISOString(),
      },
      progress: {
        stage: 'completed',
        stageIndex: 7,
        stageCount: 7,
        contentWritingSessionId,
        articleAppliedAt: new Date().toISOString(),
        analysisJobId,
        qualityGatePolicy: 'review_required',
        qualityGatePassed: true,
        qualityScore: reviewedQuality.score,
      },
    };
  } finally {
    if (context.signal.aborted) {
      if (activeExternalChildId) {
        await cancelExternalChild(activeExternalChildId, requestedBy)
          .catch((_error: unknown): void => undefined);
      }
      if (contentWritingSessionId) {
        const session = await getContentWritingSession(contentWritingSessionId)
          .catch((_error: unknown): null => null);
        if (session && ['queued', 'running', 'retry_scheduled'].includes(session.status)) {
          await cancelContentWritingSession({
            sessionId: contentWritingSessionId,
            requestedBy,
          }).catch((_error: unknown): void => undefined);
        }
      }
    }
  }
};

registerExternalAnalysisJobExecutor(
  'full_article_pipeline',
  executeFullArticlePipeline,
);
