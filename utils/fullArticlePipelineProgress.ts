import type { ExternalAnalysisJobRow } from './externalAnalysis';

export type FullArticlePipelineStage = {
  key: string;
  labelAr: string;
  labelEn: string;
};

export const FULL_ARTICLE_PIPELINE_STAGES: FullArticlePipelineStage[] = [
  { key: 'semantic_keywords_lsi', labelAr: 'الصيغ البديلة وكلمات LSI', labelEn: 'Alternative forms and LSI terms' },
  { key: 'content_brief_generation', labelAr: 'موجز المقالة الذكي', labelEn: 'Smart article brief' },
  { key: 'competitor_discovery', labelAr: 'البحث والاختيار التلقائي للمنافسين', labelEn: 'Competitor discovery and automatic selection' },
  { key: 'competitor_extraction', labelAr: 'سحب محتوى المنافسين', labelEn: 'Competitor content extraction' },
  { key: 'content_writing', labelAr: 'كتابة المقالة', labelEn: 'Article writing' },
  { key: 'comprehensive_competitor_analysis', labelAr: 'مراجعة المنافسين والإصلاح وبوابة الجودة', labelEn: 'Competitor review, repair, and quality gate' },
  { key: 'article_application', labelAr: 'الإدراج الآمن للمقالة', labelEn: 'Safe article insertion' },
];

export const FULL_ARTICLE_PIPELINE_REVIEW_CODES = new Set([
  'full_pipeline_quality_review_required',
  'full_pipeline_external_review_blocked',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const number = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstText = (sources: Record<string, unknown>[], keys: string[]): string => {
  for (const source of sources) {
    for (const key of keys) {
      const value = text(source[key]);
      if (value) return value;
    }
  }
  return '';
};

const firstNumber = (sources: Record<string, unknown>[], keys: string[]): number | null => {
  for (const source of sources) {
    for (const key of keys) {
      const value = number(source[key]);
      if (value !== null) return value;
    }
  }
  return null;
};

const describeIssue = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  const title = firstText([value], ['title', 'label', 'code', 'id']);
  const message = firstText([value], ['message', 'reason', 'description', 'current']);
  return [title, message].filter(Boolean).join(': ');
};

const issueList = (sources: Record<string, unknown>[]): string[] => {
  const results: string[] = [];
  const add = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(add);
    else {
      const description = describeIssue(value);
      if (description && !results.includes(description)) results.push(description);
    }
  };
  for (const source of sources) {
    [
      'blockingIssues',
      'blockers',
      'blockingFailures',
      'qualityFailures',
      'rejectionReasons',
      'reviewReasons',
    ].forEach(key => add(source[key]));
    if (Array.isArray(source.criteria)) {
      source.criteria.forEach(criterion => {
        if (!isRecord(criterion)) return;
        if (criterion.status !== 'fail' || criterion.severity !== 'blocking') return;
        add(criterion);
        add(criterion.messages);
      });
    }
  }
  return results.slice(0, 12);
};

export type FullArticlePipelineProgressView = {
  stageIndex: number;
  stageCount: number;
  stageKey: string;
  substage: string;
  requestedProvider: string;
  actualProvider: string;
  requestedModel: string;
  actualModel: string;
  workflowStepIndex: number | null;
  workflowStepCount: number | null;
  completedWorkflowSteps: number | null;
  candidateCount: number | null;
  selectedCandidateIndex: number | null;
  rejectedCandidateCount: number | null;
  selectedCompetitorCount: number | null;
  qualityScore: number | null;
  qualityMinimumScore: number | null;
  qualityGatePassed: boolean | null;
  qualityBlockingFailureCount: number | null;
  reviewRequired: boolean;
  reviewReasons: string[];
  contentWritingSessionId: string;
  analysisJobId: string;
  retryReason: string;
  elapsedMs: number | null;
};

export const getFullArticlePipelineProgressView = (
  job: ExternalAnalysisJobRow | null,
  nowMs = Date.now(),
): FullArticlePipelineProgressView => {
  const progress = isRecord(job?.progress) ? job.progress : {};
  const childProgress = isRecord(progress.childProgress) ? progress.childProgress : {};
  const qualityReport = isRecord(progress.qualityReport)
    ? progress.qualityReport
    : isRecord(childProgress.qualityReport)
      ? childProgress.qualityReport
      : {};
  const input = isRecord(job?.input_snapshot) ? job.input_snapshot : {};
  const sources = [childProgress, qualityReport, progress, input];
  const configuredStageCount = firstNumber([progress], ['stageCount']);
  const stageCount = Math.max(1, Math.min(
    FULL_ARTICLE_PIPELINE_STAGES.length,
    Math.round(configuredStageCount || FULL_ARTICLE_PIPELINE_STAGES.length),
  ));
  const configuredStageIndex = firstNumber([progress], ['stageIndex']);
  const stageIndex = Math.max(0, Math.min(stageCount, Math.round(configuredStageIndex || 0)));
  const stageKey = firstText([progress], ['stage'])
    || FULL_ARTICLE_PIPELINE_STAGES[Math.max(0, stageIndex - 1)]?.key
    || 'queued';
  const workflowStepIndex = firstNumber(sources, ['workflowStepIndex', 'stepIndex']);
  const workflowStepCount = firstNumber(sources, ['workflowStepCount', 'stepCount']);
  const completedWorkflowSteps = firstNumber(sources, ['workflowCompletedSteps', 'completedStepCount']);
  const candidateCount = firstNumber(sources, ['candidateCount', 'generatedCandidateCount']);
  const selectedCandidateIndex = firstNumber(sources, ['selectedCandidateIndex', 'acceptedCandidateIndex']);
  const explicitRejectedCount = firstNumber(sources, ['rejectedCandidateCount']);
  const rejectedCandidateCount = explicitRejectedCount !== null
    ? explicitRejectedCount
    : candidateCount !== null && selectedCandidateIndex !== null
      ? Math.max(0, candidateCount - 1)
      : null;
  const rawQualityPassed = sources.find(source => typeof source.qualityGatePassed === 'boolean')?.qualityGatePassed
    ?? sources.find(source => typeof source.passed === 'boolean')?.passed;
  const reviewRequired = Boolean(
    job?.status === 'blocked'
    && (
      FULL_ARTICLE_PIPELINE_REVIEW_CODES.has(job.last_error_code || '')
      || progress.reviewRequired === true
      || progress.blockedForReview === true
      || rawQualityPassed === false
    )
  );
  const startedAtMs = Date.parse(job?.started_at || job?.created_at || '');
  const finishedAtMs = Date.parse(job?.completed_at || '');
  const elapsedMs = Number.isFinite(startedAtMs)
    ? Math.max(0, (Number.isFinite(finishedAtMs) ? finishedAtMs : nowMs) - startedAtMs)
    : null;
  const reviewReasons = issueList([qualityReport, progress, childProgress]);
  if (reviewRequired && job?.last_error && !reviewReasons.includes(job.last_error)) {
    reviewReasons.unshift(job.last_error);
  }

  return {
    stageIndex,
    stageCount,
    stageKey,
    substage: firstText(sources, [
      'workflowStepLabel',
      'substageLabel',
      'substage',
      'message',
      'stage',
    ]),
    requestedProvider: firstText([input, progress], ['provider', 'requestedProvider']),
    actualProvider: firstText([childProgress, progress], ['actualProvider', 'provider']),
    requestedModel: firstText([input, progress], ['requestedModel', 'model']),
    actualModel: firstText([childProgress, progress], ['actualModel', 'effectiveModel', 'model']),
    workflowStepIndex,
    workflowStepCount,
    completedWorkflowSteps,
    candidateCount,
    selectedCandidateIndex,
    rejectedCandidateCount,
    selectedCompetitorCount: firstNumber(sources, ['selectedCompetitorCount', 'successfulCount']),
    qualityScore: firstNumber(sources, ['qualityScore', 'score']),
    qualityMinimumScore: firstNumber(sources, ['qualityMinimumScore', 'minimumScore']),
    qualityGatePassed: typeof rawQualityPassed === 'boolean' ? rawQualityPassed : null,
    qualityBlockingFailureCount: firstNumber(sources, ['qualityBlockingFailureCount', 'blockingFailureCount']),
    reviewRequired,
    reviewReasons: reviewReasons.slice(0, 12),
    contentWritingSessionId: firstText([progress, childProgress], ['contentWritingSessionId']),
    analysisJobId: firstText([progress, childProgress], ['analysisJobId']),
    retryReason: job?.status === 'retry_scheduled'
      ? firstText([progress], ['retryReason']) || text(job.last_error_code)
      : '',
    elapsedMs,
  };
};

export const formatPipelineDuration = (durationMs: number | null, isArabic: boolean): string => {
  if (durationMs === null || !Number.isFinite(durationMs)) return '';
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const values = [
    hours > 0 ? `${hours}${isArabic ? 'س' : 'h'}` : '',
    minutes > 0 || hours > 0 ? `${minutes}${isArabic ? 'د' : 'm'}` : '',
    `${seconds}${isArabic ? 'ث' : 's'}`,
  ].filter(Boolean);
  return values.join(' ');
};
