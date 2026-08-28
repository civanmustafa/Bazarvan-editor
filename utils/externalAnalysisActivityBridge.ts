import type {
  ExternalAnalysisJobRow,
  ExternalAnalysisJobStatus,
} from './externalAnalysis';

type ExternalActivityState = 'running' | 'success' | 'failed' | 'cancelled';
type ExternalActivityOutcome = 'success' | 'failed' | 'cancelled';

export type ExternalAnalysisActivityProjection = {
  activityId: string;
  fingerprint: string;
  state: ExternalActivityState;
  outcome?: ExternalActivityOutcome;
  articleId: string;
  articleTitle: string;
  commandId: string;
  provider: string;
  requestedProvider: string;
  model: string;
  requestedModel: string;
  stage: string;
  surface: string;
  message: string;
  keySuffix: string;
  currentKeyIndex?: number;
  keyCount?: number;
  attemptedKeyCount?: number;
  currentModelIndex?: number;
  modelCount?: number;
  totalAttemptCount?: number;
  httpStatus?: number;
  startedAt: string;
  payload: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const toPositiveNumber = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
};

const normalizeStage = (value: unknown, status: ExternalAnalysisJobStatus): string => {
  const stage = toText(value).replace(/^gemini_/, '');
  if (stage) return stage;
  if (status === 'running') return 'running';
  if (status === 'retry_scheduled') return 'retry_scheduled';
  if (status === 'queued') return 'queued';
  if (status === 'waiting_for_prerequisites') return 'waiting_for_prerequisites';
  if (status === 'paused') return 'paused';
  return status;
};

const resolveState = (
  status: ExternalAnalysisJobStatus,
): { state: ExternalActivityState; outcome?: ExternalActivityOutcome } => {
  if (status === 'completed') return { state: 'success', outcome: 'success' };
  if (status === 'failed' || status === 'blocked') {
    return { state: 'failed', outcome: 'failed' };
  }
  if (status === 'cancelled') return { state: 'cancelled', outcome: 'cancelled' };
  return { state: 'running' };
};

const resolveSurface = (job: ExternalAnalysisJobRow, stage: string): string => {
  if (job.job_type === 'semantic_keywords_lsi') return 'semantic_keywords_lsi';
  if (job.job_type === 'content_brief_generation') return 'goal_context_generation';
  if (job.job_type === 'meta_description_generation') return 'meta_description_generation';
  if (job.job_type === 'full_article_pipeline') return 'full_article_pipeline';
  if (job.job_type === 'content_writing_preparation') return 'content_writing_preparation';
  if (job.job_type === 'competitor_discovery') return 'competitor_discovery';
  if (job.job_type === 'competitor_extraction') return 'competitor_extraction';
  if (job.command_id !== 'smartAnalysis.competitorContentComparison') return 'engineering_command';
  if (stage.includes('repairing_competitor_synthesis')) {
    return 'competitor_comparison_synthesis_repair';
  }
  if (stage.includes('synthesizing_competitor_results')) {
    return 'competitor_comparison_synthesis';
  }
  return 'competitor_comparison_map';
};

export const projectExternalAnalysisActivity = (
  job: ExternalAnalysisJobRow,
  articleTitle: string,
): ExternalAnalysisActivityProjection => {
  const progress = isRecord(job.progress) ? job.progress : {};
  const gemini = isRecord(progress.gemini) ? progress.gemini : {};
  const childProgress = isRecord(progress.childProgress) ? progress.childProgress : {};
  const result = isRecord(job.result) ? job.result : {};
  const stage = normalizeStage(progress.stage, job.status);
  const state = resolveState(job.status);
  const fallbackProvider = job.job_type === 'competitor_discovery' || job.job_type === 'competitor_extraction'
    ? 'crawler'
    : job.job_type === 'full_article_pipeline' || job.job_type === 'content_writing_preparation'
      ? ''
      : 'gemini';
  const provider = toText(gemini.provider)
    || toText(childProgress.provider)
    || toText(progress.provider)
    || toText(result.provider)
    || fallbackProvider;
  const model = toText(gemini.model)
    || toText(childProgress.model)
    || toText(progress.model)
    || toText(result.model);
  const requestedModel = toText(gemini.requestedModel) || model;
  const message = toText(progress.message)
    || toText(gemini.message)
    || toText(job.last_error);
  const keySuffix = toText(gemini.keySuffix) || toText(result.keySuffix);
  const keyAttempts = Array.isArray(result.keyAttempts) ? result.keyAttempts : [];
  const compactResult = {
    provider: toText(result.provider),
    model: toText(result.model),
    keySuffix: toText(result.keySuffix),
    keyAttempts,
  };

  return {
    activityId: `external-analysis:${job.id}`,
    fingerprint: [
      job.status,
      job.updated_at,
      stage,
      model,
      keySuffix,
      message,
      JSON.stringify(gemini),
    ].join('|'),
    ...state,
    articleId: job.article_id,
    articleTitle: articleTitle.trim(),
    commandId: job.command_id || job.job_type,
    provider,
    requestedProvider: provider,
    model,
    requestedModel,
    stage,
    surface: resolveSurface(job, stage),
    message,
    keySuffix,
    ...(toPositiveNumber(gemini.currentKeyIndex) ? { currentKeyIndex: toPositiveNumber(gemini.currentKeyIndex) } : {}),
    ...(toPositiveNumber(gemini.keyCount) ? { keyCount: toPositiveNumber(gemini.keyCount) } : {}),
    ...(toPositiveNumber(gemini.attemptedKeyCount) ? { attemptedKeyCount: toPositiveNumber(gemini.attemptedKeyCount) } : {}),
    ...(toPositiveNumber(gemini.currentModelIndex) ? { currentModelIndex: toPositiveNumber(gemini.currentModelIndex) } : {}),
    ...(toPositiveNumber(gemini.modelCount) ? { modelCount: toPositiveNumber(gemini.modelCount) } : {}),
    ...(toPositiveNumber(gemini.totalAttemptCount) ? { totalAttemptCount: toPositiveNumber(gemini.totalAttemptCount) } : {}),
    ...(toPositiveNumber(gemini.status) ? { httpStatus: toPositiveNumber(gemini.status) } : {}),
    startedAt: job.started_at || job.created_at,
    payload: {
      progress,
      result: compactResult,
    },
  };
};
