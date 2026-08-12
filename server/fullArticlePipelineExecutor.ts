import {
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
  recordContentWritingApplication,
  resumeContentWritingSession,
  type ContentWritingProvider,
  type ContentWritingSession,
} from './contentWritingSessionService';
import {
  contentWritingMarkdownToPlainText,
  prepareContentWritingResultForEditor,
} from '../utils/contentWritingWorkflow';
import { parseMarkdownToArticleHtml } from '../utils/editorUtils';

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

type ArticleRow = {
  id: string;
  title: string | null;
  keywords: unknown;
  goal_context: unknown;
  article_language: string | null;
  metadata: unknown;
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
    .select('id,title,keywords,goal_context,article_language,metadata,updated_at')
    .eq('id', articleId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Article ${articleId} was not found.`);
  return data as ArticleRow;
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
  await context.reportProgress({
    progress: {
      stage,
      stageIndex,
      stageCount: 7,
      qualityGatePolicy: 'insert_regardless',
      ...details,
      updatedAt: new Date().toISOString(),
    },
    provider: text(childProgress.provider) || undefined,
    model: text(childProgress.model) || undefined,
    keyAttempts: Array.isArray(childProgress.keyAttempts)
      ? childProgress.keyAttempts.filter(isRecord)
      : undefined,
  });
};

const waitForExternalJob = async (options: {
  context: ExternalAnalysisExecutionContext;
  jobId: string;
  stage: string;
  stageIndex: number;
}): Promise<ChildJobSnapshot> => {
  while (true) {
    if (options.context.signal.aborted) {
      throw options.context.signal.reason ?? new Error('The full article pipeline was cancelled.');
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
      if (options.context.job.last_error_code === retryCode) {
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

const enqueueSemantic = async (articleId: string): Promise<string | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'enqueue_external_semantic_analysis_job',
    { p_article_id: articleId },
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

const enqueueDiscovery = async (
  articleId: string,
  requestedBy: string,
): Promise<string> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'enqueue_competitor_discovery_job',
    {
      p_article_id: articleId,
      p_requested_by: requestedBy,
      p_origin: 'manual',
    },
  );
  if (error) throw error;
  const id = text(data);
  if (!id) throw new Error('Competitor discovery prerequisites are incomplete.');
  return id;
};

const selectCompetitorSources = (
  result: ExternalAnalysisJson | null,
  desiredCount: number,
): ExternalAnalysisJson[] => {
  const rows = Array.isArray(result?.results) ? result?.results : [];
  const valid = rows
    .filter(isRecord)
    .filter(row => row.eligible !== false && Boolean(text(row.url) || text(row.canonicalUrl)));
  const preferred = [
    ...valid.filter(row => row.autoSelected === true),
    ...valid.filter(row => row.autoSelected !== true),
  ];
  const seen = new Set<string>();
  return preferred.flatMap(row => {
    const url = text(row.canonicalUrl) || text(row.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{
      url,
      canonicalUrl: url,
      domain: text(row.domain),
      title: text(row.title),
      description: text(row.description),
    }];
  }).slice(0, Math.max(1, Math.min(desiredCount, 5)));
};

const enqueueExtraction = async (options: {
  articleId: string;
  requestedBy: string;
  queryType: string;
  queryText: string;
  sources: ExternalAnalysisJson[];
}): Promise<string> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'enqueue_competitor_extraction_job',
    {
      p_article_id: options.articleId,
      p_requested_by: options.requestedBy,
      p_query_type: options.queryType,
      p_query_text: options.queryText,
      p_sources: options.sources,
    },
  );
  if (error) throw error;
  const source = isRecord(data) ? data : {};
  const job = isRecord(source.job) ? source.job : {};
  const id = text(job.id);
  if (!id) throw new Error('Competitor extraction did not return a job.');
  return id;
};

const waitForContentWriting = async (options: {
  context: ExternalAnalysisExecutionContext;
  sessionId: string;
}): Promise<ContentWritingSession> => {
  while (true) {
    if (options.context.signal.aborted) {
      throw options.context.signal.reason ?? new Error('The full article pipeline was cancelled.');
    }
    const session = await getContentWritingSession(options.sessionId);
    if (!session) throw new Error(`Content writing session ${options.sessionId} was not found.`);
    await reportStage(options.context, 'content_writing', 5, {
      contentWritingSessionId: session.id,
      contentWritingStatus: session.status,
      childProgress: session.progress || {},
      nextAttemptAt: session.next_attempt_at,
      qualityScore: session.quality_score,
      qualityGatePassed: isRecord(session.quality_report) && session.quality_report.passed === true,
    });
    if (session.status === 'completed') return session;
    if (session.status === 'failed' || session.status === 'cancelled') {
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

const enqueueComprehensiveAnalysis = async (
  pipelineJobId: string,
  requestedBy: string,
): Promise<string> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'enqueue_full_article_pipeline_competitor_analysis',
    {
      p_pipeline_job_id: pipelineJobId,
      p_requested_by: requestedBy,
    },
  );
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  const id = text(row?.id);
  if (!id) throw new Error('The comprehensive competitor analysis did not return a job.');
  return id;
};

const executeFullArticlePipeline = async (
  context: ExternalAnalysisExecutionContext,
) => {
  const requestedBy = text(context.job.requested_by);
  if (!requestedBy) throw new Error('The full article pipeline requires a requesting user.');
  const input = isRecord(context.job.input_snapshot) ? context.job.input_snapshot : {};
  const provider = text(input.provider) as ContentWritingProvider;
  const model = text(input.model);
  const competitorCount = Math.max(1, Math.min(5, Math.round(numberValue(input.competitorCount, 5))));
  const savedProgress = isRecord(context.job.progress) ? context.job.progress : {};
  let activeExternalChildId = '';
  let contentWritingSessionId = text(savedProgress.contentWritingSessionId);

  try {
    await reportStage(context, 'semantic_keywords_lsi', 1);
    const semanticJobId = text(savedProgress.semanticJobId) || await enqueueSemantic(context.job.article_id) || '';
    if (semanticJobId) {
      activeExternalChildId = semanticJobId;
      await reportStage(context, 'semantic_keywords_lsi', 1, { semanticJobId });
      await waitForExternalJob({
        context,
        jobId: semanticJobId,
        stage: 'semantic_keywords_lsi',
        stageIndex: 1,
      });
      activeExternalChildId = '';
    } else {
      await reportStage(context, 'semantic_keywords_lsi', 1, { skipped: true, reason: 'already_populated' });
    }

    await reportStage(context, 'content_brief_generation', 2);
    const briefJobId = text(savedProgress.briefJobId) || await enqueueBrief(context.job.id, requestedBy);
    activeExternalChildId = briefJobId;
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

    await reportStage(context, 'competitor_discovery', 3);
    const discoveryJobId = text(savedProgress.discoveryJobId)
      || await enqueueDiscovery(context.job.article_id, requestedBy);
    activeExternalChildId = discoveryJobId;
    await reportStage(context, 'competitor_discovery', 3, { discoveryJobId });
    const discovery = await waitForExternalJob({
      context,
      jobId: discoveryJobId,
      stage: 'competitor_discovery',
      stageIndex: 3,
    });
    activeExternalChildId = '';
    const sources = selectCompetitorSources(discovery.result, competitorCount);
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
    let extractionJobId = context.job.last_error_code === 'full_pipeline_no_competitor_content'
      ? ''
      : text(savedProgress.extractionJobId);
    if (!extractionJobId) {
      extractionJobId = await enqueueExtraction({
        articleId: context.job.article_id,
        requestedBy,
        queryType,
        queryText,
        sources,
      });
    }
    activeExternalChildId = extractionJobId;
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

    await reportStage(context, 'content_writing', 5, {
      provider,
      model,
    });
    let writingSession = contentWritingSessionId
      ? await getContentWritingSession(contentWritingSessionId)
      : null;
    if (writingSession && (writingSession.status === 'failed' || writingSession.status === 'cancelled')) {
      if (context.job.last_error_code === 'full_pipeline_content_writing_failed') {
        writingSession = await resumeContentWritingAfterScheduledRetry(writingSession, requestedBy);
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
      });
      writingSession = queued.session;
    }
    contentWritingSessionId = writingSession.id;
    await reportStage(context, 'content_writing', 5, {
      contentWritingSessionId,
      contentWritingStatus: writingSession.status,
      provider,
      model: writingSession.model,
    });
    writingSession = await waitForContentWriting({
      context,
      sessionId: contentWritingSessionId,
    });

    await reportStage(context, 'article_application', 6, {
      contentWritingSessionId,
      qualityGatePolicy: 'insert_regardless',
      qualityScore: writingSession.quality_score,
      qualityGatePassed: writingSession.quality_report?.passed === true,
    });
    const article = await readArticle(context.job.article_id);
    const latestGoalContext = isRecord(article.goal_context) ? article.goal_context : {};
    if (text(latestGoalContext.generatedBrief) !== generatedBrief) {
      const { error: briefPersistenceError } = await getExternalAnalysisSupabaseAdmin()
        .from('articles')
        .update({
          goal_context: {
            ...latestGoalContext,
            generatedBrief,
          },
          last_saved_at: new Date().toISOString(),
        })
        .eq('id', article.id);
      if (briefPersistenceError) throw briefPersistenceError;
    }
    const prepared = prepareContentWritingResultForEditor(
      writingSession.result_text || '',
      text(article.title),
    );
    if (!prepared.markdown) {
      retryError({
        code: 'full_pipeline_generated_article_empty',
        message: 'The completed content-writing session did not contain an insertable article.',
        stage: 'article_application',
        stageIndex: 6,
        details: { contentWritingSessionId },
      });
    }
    const articleLanguage = article.article_language === 'en' ? 'en' : 'ar';
    const plainText = contentWritingMarkdownToPlainText(prepared.markdown);
    const contentHtml = parseMarkdownToArticleHtml(prepared.markdown, articleLanguage);
    const { data: application, error: applicationError } = await getExternalAnalysisSupabaseAdmin()
      .rpc('apply_full_article_pipeline_content', {
        p_pipeline_job_id: context.job.id,
        p_session_id: writingSession.id,
        p_content_html: contentHtml,
        p_plain_text: plainText,
      });
    if (applicationError) throw applicationError;

    const qualityPassed = writingSession.quality_report?.passed === true;
    if (!writingSession.applied_at) {
      await recordContentWritingApplication({
        sessionId: writingSession.id,
        appliedBy: requestedBy,
        qualityOverrideReason: qualityPassed
          ? undefined
          : 'إدراج تلقائي صريح من مسار الزر الشامل رغم عدم اجتياز بوابة الجودة.',
      });
    }
    await reportStage(context, 'article_application', 6, {
      contentWritingSessionId,
      articleAppliedAt: new Date().toISOString(),
      application: isRecord(application) ? application : {},
      qualityGatePolicy: 'insert_regardless',
      qualityScore: writingSession.quality_score,
      qualityGatePassed: qualityPassed,
    });

    await reportStage(context, 'comprehensive_competitor_analysis', 7, {
      commandId: COMPREHENSIVE_COMMAND_ID,
    });
    const analysisJobId = text(savedProgress.analysisJobId)
      || await enqueueComprehensiveAnalysis(context.job.id, requestedBy);
    activeExternalChildId = analysisJobId;
    await reportStage(context, 'comprehensive_competitor_analysis', 7, {
      analysisJobId,
      commandId: COMPREHENSIVE_COMMAND_ID,
    });
    const analysis = await waitForExternalJob({
      context,
      jobId: analysisJobId,
      stage: 'comprehensive_competitor_analysis',
      stageIndex: 7,
    });
    activeExternalChildId = '';

    return {
      result: {
        status: 'completed',
        articleId: context.job.article_id,
        contentWritingSessionId,
        articleApplied: true,
        qualityGatePolicy: 'insert_regardless',
        qualityGatePassed: qualityPassed,
        qualityScore: writingSession.quality_score,
        selectedCompetitorCount: sources.length,
        analysisJobId,
        analysisCompleted: analysis.status === 'completed',
        completedAt: new Date().toISOString(),
      },
      progress: {
        stage: 'completed',
        stageIndex: 7,
        stageCount: 7,
        contentWritingSessionId,
        articleAppliedAt: new Date().toISOString(),
        analysisJobId,
        qualityGatePolicy: 'insert_regardless',
        qualityGatePassed: qualityPassed,
        qualityScore: writingSession.quality_score,
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
