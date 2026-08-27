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
import type { ContentWritingProvider } from './contentWritingSessionService';

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const ACTIVE_JOB_STATUSES = new Set([
  'waiting_for_prerequisites',
  'queued',
  'running',
  'retry_scheduled',
  'paused',
]);
const POLL_INTERVAL_MS = 5_000;

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

const boundedCount = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(Math.round(parsed), 5))
    : fallback;
};

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> => (
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Competitor preparation was cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Competitor preparation was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  })
);

const readExternalJob = async (
  jobId: string,
  includeResult = false,
): Promise<ChildJobSnapshot> => {
  const table = getExternalAnalysisSupabaseAdmin().from('ai_external_analysis_jobs');
  const response = includeResult
    ? await table
      .select('id,status,progress,result,last_error,last_error_code,next_attempt_at')
      .eq('id', jobId)
      .maybeSingle()
    : await table
      .select('id,status,progress,last_error,last_error_code,next_attempt_at')
      .eq('id', jobId)
      .maybeSingle();
  if (response.error) throw response.error;
  if (!response.data) throw new Error(`Competitor child job ${jobId} was not found.`);
  const source = response.data as unknown as Record<string, unknown>;
  return {
    ...(response.data as unknown as ChildJobSnapshot),
    result: includeResult && isRecord(source.result)
      ? source.result as ExternalAnalysisJson
      : null,
  };
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
      stageCount: 3,
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

const preparationRetry = (options: {
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
      stageCount: 3,
      retryReason: options.code,
      ...(options.details || {}),
    },
  });
};

const waitForChildJob = async (options: {
  context: ExternalAnalysisExecutionContext;
  jobId: string;
  stage: string;
  stageIndex: number;
}): Promise<ChildJobSnapshot> => {
  while (true) {
    if (options.context.signal.aborted) {
      throw options.context.signal.reason ?? new Error('Competitor preparation was cancelled.');
    }
    const snapshot = await readExternalJob(options.jobId);
    await reportStage(options.context, options.stage, options.stageIndex, {
      childJobId: options.jobId,
      childStatus: snapshot.status,
      childProgress: snapshot.progress || {},
      nextAttemptAt: snapshot.next_attempt_at,
    });
    if (snapshot.status === 'completed') return readExternalJob(options.jobId, true);
    if (snapshot.status === 'retry_scheduled') {
      preparationRetry({
        code: `content_writing_${options.stage}_retry_scheduled`,
        message: snapshot.last_error || `The ${options.stage} task is scheduled to retry.`,
        stage: options.stage,
        stageIndex: options.stageIndex,
        details: {
          childJobId: options.jobId,
          childStatus: snapshot.status,
          nextAttemptAt: snapshot.next_attempt_at,
        },
      });
    }
    if (TERMINAL_JOB_STATUSES.has(snapshot.status)) {
      preparationRetry({
        code: `content_writing_${options.stage}_failed`,
        message: snapshot.last_error || `The ${options.stage} task failed.`,
        stage: options.stage,
        stageIndex: options.stageIndex,
        details: {
          childJobId: options.jobId,
          childStatus: snapshot.status,
          childErrorCode: snapshot.last_error_code,
        },
      });
    }
    if (!ACTIVE_JOB_STATUSES.has(snapshot.status)) {
      preparationRetry({
        code: `content_writing_${options.stage}_unknown_status`,
        message: `The ${options.stage} task returned unsupported status ${snapshot.status}.`,
        stage: options.stage,
        stageIndex: options.stageIndex,
        details: { childJobId: options.jobId, childStatus: snapshot.status },
      });
    }
    await delay(POLL_INTERVAL_MS, options.context.signal);
  }
};

const readCompetitorReadiness = async (articleId: string): Promise<{
  usableCount: number;
  pendingCount: number;
  processingComplete: boolean;
}> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'evaluate_content_writing_automation_readiness',
    { p_article_id: articleId },
  );
  if (error) throw error;
  const source = isRecord(data) ? data : {};
  return {
    usableCount: Math.max(0, Number(source.usableCompetitorCount) || 0),
    pendingCount: Math.max(0, Number(source.pendingCompetitorCount) || 0),
    processingComplete: source.processingComplete === true,
  };
};

const findActiveExtractionJob = async (articleId: string): Promise<string | null> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('ai_external_analysis_jobs')
    .select('id')
    .eq('article_id', articleId)
    .eq('job_type', 'competitor_extraction')
    .in('status', Array.from(ACTIVE_JOB_STATUSES))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return text(data?.id) || null;
};

const enqueueDiscovery = async (
  articleId: string,
  requestedBy: string,
  origin: 'auto' | 'manual',
): Promise<string> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin().rpc(
    'enqueue_competitor_discovery_job',
    {
      p_article_id: articleId,
      p_requested_by: requestedBy,
      p_origin: origin,
    },
  );
  if (error) throw error;
  const jobId = text(data);
  if (!jobId) throw new Error('Competitor discovery prerequisites are incomplete.');
  return jobId;
};

const selectCompetitorSources = (
  result: ExternalAnalysisJson | null,
  desiredCount: number,
): ExternalAnalysisJson[] => {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const valid = rows
    .filter(isRecord)
    .filter(row => row.eligible !== false && Boolean(text(row.canonicalUrl) || text(row.url)));
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
      autoSelected: row.autoSelected === true,
      contentQualification: isRecord(row.contentQualification) ? row.contentQualification : {},
    }];
  }).slice(0, boundedCount(desiredCount, 5));
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
  const jobId = text(job.id);
  if (!jobId) throw new Error('Competitor extraction did not return a job.');
  const selectedQualifications = Object.fromEntries(options.sources.map(sourceRow => {
    const url = text(sourceRow.canonicalUrl) || text(sourceRow.url);
    const qualification = isRecord(sourceRow.contentQualification) ? sourceRow.contentQualification : {};
    return [url, {
      autoSelected: sourceRow.autoSelected === true,
      qualificationRequired: text(qualification.status) === 'qualified',
      status: text(qualification.status),
      matchedKeyword: text(qualification.matchedKeyword),
      matchKind: text(qualification.matchKind),
    }];
  }));
  const { error: metadataError } = await getExternalAnalysisSupabaseAdmin()
    .from('ai_external_analysis_jobs')
    .update({
      input_snapshot: {
        ...(isRecord(job.input_snapshot) ? job.input_snapshot : {}),
        selectedQualifications,
      },
    })
    .eq('id', jobId);
  if (metadataError) throw metadataError;
  return jobId;
};

const readCurrentPreparationIntent = async (jobId: string): Promise<{
  requestedBy: string;
  startWriting: boolean;
  provider: ContentWritingProvider;
  model: string;
  idempotencyKey: string;
}> => {
  const { data, error } = await getExternalAnalysisSupabaseAdmin()
    .from('ai_external_analysis_jobs')
    .select('requested_by,input_snapshot')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  const input = isRecord(data?.input_snapshot) ? data.input_snapshot : {};
  const provider = text(input.provider) as ContentWritingProvider;
  return {
    requestedBy: text(data?.requested_by) || text(input.requestedBy),
    startWriting: input.startWriting === true,
    provider: ['gemini', 'geminiPaid', 'openai'].includes(provider) ? provider : 'gemini',
    model: text(input.model),
    idempotencyKey: text(input.contentWritingIdempotencyKey),
  };
};

const cancelChildJob = async (jobId: string, requestedBy: string): Promise<void> => {
  const snapshot = await readExternalJob(jobId).catch((): null => null);
  if (!snapshot || !ACTIVE_JOB_STATUSES.has(snapshot.status)) return;
  await getExternalAnalysisSupabaseAdmin().rpc('request_external_analysis_job_cancel', {
    p_job_id: jobId,
    p_requested_by: requestedBy,
  });
};

const executeContentWritingCompetitorPreparation = async (
  context: ExternalAnalysisExecutionContext,
) => {
  const initialInput = isRecord(context.job.input_snapshot) ? context.job.input_snapshot : {};
  const requestedBy = text(context.job.requested_by) || text(initialInput.requestedBy);
  if (!requestedBy) throw new Error('Competitor preparation requires a requesting user.');
  const minimumCount = boundedCount(initialInput.minimumCompetitorCount, 1);
  const desiredCount = boundedCount(initialInput.desiredCompetitorCount, 5);
  let activeChildJobId = '';

  try {
    let readiness = await readCompetitorReadiness(context.job.article_id);
    if (readiness.usableCount < minimumCount && readiness.pendingCount > 0) {
      activeChildJobId = await findActiveExtractionJob(context.job.article_id) || '';
      if (activeChildJobId) {
        await waitForChildJob({
          context,
          jobId: activeChildJobId,
          stage: 'competitor_extraction',
          stageIndex: 2,
        });
        activeChildJobId = '';
        readiness = await readCompetitorReadiness(context.job.article_id);
      }
    }

    if (readiness.usableCount < minimumCount) {
      await reportStage(context, 'competitor_discovery', 1, {
        usableCompetitorCount: readiness.usableCount,
        requiredCompetitorCount: minimumCount,
      });
      const discoveryJobId = await enqueueDiscovery(
        context.job.article_id,
        requestedBy,
        context.job.origin === 'auto' ? 'auto' : 'manual',
      );
      activeChildJobId = discoveryJobId;
      const discovery = await waitForChildJob({
        context,
        jobId: discoveryJobId,
        stage: 'competitor_discovery',
        stageIndex: 1,
      });
      activeChildJobId = '';
      const sources = selectCompetitorSources(discovery.result, desiredCount);
      if (sources.length === 0) {
        preparationRetry({
          code: 'content_writing_no_competitors_found',
          message: 'No suitable competitor pages were available after automatic discovery.',
          stage: 'competitor_discovery',
          stageIndex: 1,
          details: { discoveryJobId },
        });
      }

      const discoveryResult = isRecord(discovery.result) ? discovery.result : {};
      await reportStage(context, 'competitor_extraction', 2, {
        selectedCompetitorCount: sources.length,
        discoveryJobId,
      });
      const extractionJobId = await enqueueExtraction({
        articleId: context.job.article_id,
        requestedBy,
        queryType: text(discoveryResult.queryType) || 'primary_keyword',
        queryText: text(discoveryResult.query),
        sources,
      });
      activeChildJobId = extractionJobId;
      await waitForChildJob({
        context,
        jobId: extractionJobId,
        stage: 'competitor_extraction',
        stageIndex: 2,
      });
      activeChildJobId = '';
      readiness = await readCompetitorReadiness(context.job.article_id);
    }

    if (readiness.usableCount < minimumCount) {
      preparationRetry({
        code: 'content_writing_competitor_texts_missing',
        message: `Competitor extraction produced ${readiness.usableCount} usable texts; ${minimumCount} required.`,
        stage: 'competitor_extraction',
        stageIndex: 2,
        details: {
          usableCompetitorCount: readiness.usableCount,
          requiredCompetitorCount: minimumCount,
        },
      });
    }

    const currentIntent = await readCurrentPreparationIntent(context.job.id);
    if (!currentIntent.startWriting) {
      return {
        result: {
          status: 'competitors_ready',
          writingQueued: false,
          usableCompetitorCount: readiness.usableCount,
        },
        progress: {
          stage: 'competitors_ready',
          stageIndex: 3,
          stageCount: 3,
          usableCompetitorCount: readiness.usableCount,
        },
      };
    }
    if (!currentIntent.requestedBy || !currentIntent.idempotencyKey) {
      throw new Error('The explicit writing request lost its user or idempotency key.');
    }

    await reportStage(context, 'content_writing_queued', 3, {
      usableCompetitorCount: readiness.usableCount,
      provider: currentIntent.provider,
      model: currentIntent.model,
    });
    const queued = await queueContentWritingSession({
      articleId: context.job.article_id,
      createdBy: currentIntent.requestedBy,
      provider: currentIntent.provider,
      model: currentIntent.model || undefined,
      idempotencyKey: currentIntent.idempotencyKey,
      contextSnapshotPatch: {
        triggerSource: 'manual',
        competitorPreparationJobId: context.job.id,
        automaticCompetitorPreparation: true,
        preparedCompetitorCount: readiness.usableCount,
      },
    });

    return {
      result: {
        status: 'content_writing_queued',
        writingQueued: true,
        contentWritingSessionId: queued.session.id,
        contentWritingSessionStatus: queued.session.status,
        created: queued.created,
        reusedActive: queued.reusedActive === true,
        usableCompetitorCount: readiness.usableCount,
      },
      progress: {
        stage: 'content_writing_queued',
        stageIndex: 3,
        stageCount: 3,
        contentWritingSessionId: queued.session.id,
        usableCompetitorCount: readiness.usableCount,
      },
    };
  } finally {
    if (activeChildJobId && context.signal.aborted) {
      await cancelChildJob(activeChildJobId, requestedBy).catch((): void => undefined);
    }
  }
};

registerExternalAnalysisJobExecutor(
  'content_writing_preparation',
  executeContentWritingCompetitorPreparation,
);
