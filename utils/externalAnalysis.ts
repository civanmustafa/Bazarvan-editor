import type {
  AiContentPatch,
  AiContentPatchOperation,
  AiContentPatchStatus,
} from '../types';
import { getSupabaseClient } from './supabaseClient';

export type ExternalAnalysisJobType = 'semantic_keywords_lsi' | 'engineering_command';

export type ExternalAnalysisJobStatus =
  | 'waiting_for_prerequisites'
  | 'queued'
  | 'running'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'paused';

export type ExternalAnalysisJobRow = {
  id: string;
  article_id: string;
  requested_by?: string | null;
  job_type: ExternalAnalysisJobType;
  origin: 'auto' | 'manual';
  status: ExternalAnalysisJobStatus;
  batch_key: string | null;
  sequence_number: number;
  command_id: string | null;
  command_label: string | null;
  depends_on_job_id?: string | null;
  input_snapshot?: Record<string, unknown>;
  result: Record<string, unknown> | null;
  progress: Record<string, unknown>;
  last_error: string | null;
  last_error_code: string | null;
  attempt_count: number;
  retry_count: number;
  next_attempt_at: string | null;
  cancel_requested_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ExternalAnalysisArticleState = {
  article_id: string;
  semantic_ready: boolean;
  external_analysis_ready: boolean;
  semantic_missing_fields: string[];
  external_analysis_missing_fields: string[];
  updated_at: string;
};

export type ExternalAnalysisDashboardSummary = {
  articleId: string;
  state: ExternalAnalysisArticleState | null;
  latestSemanticJob: ExternalAnalysisJobRow | null;
  activeEngineeringCount: number;
  completedEngineeringCount: number;
  retryingEngineeringCount: number;
  latestEngineeringJob: ExternalAnalysisJobRow | null;
  latestUpdatedAt: string | null;
};

export const EXTERNAL_ANALYSIS_ACTIVE_STATUSES: ExternalAnalysisJobStatus[] = [
  'waiting_for_prerequisites',
  'queued',
  'running',
  'retry_scheduled',
  'paused',
];

const ALLOWED_PATCH_OPERATIONS = new Set<AiContentPatchOperation>([
  'replace_block',
  'replace_text',
  'delete_block',
  'insert_after_heading',
  'insert_before_heading',
  'append_to_section',
  'insert_before_faq',
  'insert_before_conclusion',
  'append_to_article',
]);

const MISSING_FIELD_LABELS: Record<string, { ar: string; en: string }> = {
  draft_status: { ar: 'حالة المقالة: مسودة', en: 'Draft article status' },
  article_title: { ar: 'عنوان المقالة', en: 'Article title' },
  editor_text: { ar: 'نص المقالة', en: 'Article text' },
  primary_keyword: { ar: 'الكلمة المفتاحية الأساسية', en: 'Primary keyword' },
  alternative_keywords: { ar: 'الصيغ البديلة', en: 'Alternative keyword forms' },
  lsi_keywords: { ar: 'كلمات LSI', en: 'LSI terms' },
  goal_context: { ar: 'سياق وهدف الصفحة', en: 'Page goal context' },
  company_name: { ar: 'اسم الشركة', en: 'Company name' },
  competitor_content_or_url: { ar: 'نص أو رابط منافس', en: 'Competitor text or URL' },
};

const isRecord = (value: unknown): value is Record<string, any> => (
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

const toNumber = (value: unknown, fallback = 0): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const toJobRow = (row: Record<string, any>): ExternalAnalysisJobRow => ({
  id: String(row.id),
  article_id: String(row.article_id),
  requested_by: row.requested_by || null,
  job_type: row.job_type === 'semantic_keywords_lsi' ? 'semantic_keywords_lsi' : 'engineering_command',
  origin: row.origin === 'manual' ? 'manual' : 'auto',
  status: row.status as ExternalAnalysisJobStatus,
  batch_key: row.batch_key || null,
  sequence_number: toNumber(row.sequence_number),
  command_id: row.command_id || null,
  command_label: row.command_label || null,
  depends_on_job_id: row.depends_on_job_id || null,
  input_snapshot: isRecord(row.input_snapshot) ? row.input_snapshot : {},
  result: isRecord(row.result) ? row.result : null,
  progress: isRecord(row.progress) ? row.progress : {},
  last_error: row.last_error || null,
  last_error_code: row.last_error_code || null,
  attempt_count: toNumber(row.attempt_count),
  retry_count: toNumber(row.retry_count),
  next_attempt_at: row.next_attempt_at || null,
  cancel_requested_at: row.cancel_requested_at || null,
  started_at: row.started_at || null,
  completed_at: row.completed_at || null,
  created_at: String(row.created_at || ''),
  updated_at: String(row.updated_at || ''),
});

const SUMMARY_JOB_SELECT = [
  'id',
  'article_id',
  'job_type',
  'origin',
  'status',
  'batch_key',
  'sequence_number',
  'command_id',
  'command_label',
  'progress',
  'last_error',
  'last_error_code',
  'attempt_count',
  'retry_count',
  'next_attempt_at',
  'cancel_requested_at',
  'started_at',
  'completed_at',
  'created_at',
  'updated_at',
].join(',');

const FULL_JOB_SELECT = [
  SUMMARY_JOB_SELECT,
  'requested_by',
  'depends_on_job_id',
  'input_snapshot',
  'result',
].join(',');

export const listExternalAnalysisDashboardSummaries = async (
  articleIds: string[],
): Promise<Record<string, ExternalAnalysisDashboardSummary>> => {
  const ids = Array.from(new Set(articleIds.map(item => item.trim()).filter(Boolean)));
  if (ids.length === 0) return {};
  const supabase = getSupabaseClient();
  const [stateResult, jobsResult] = await Promise.all([
    supabase
      .from('ai_external_analysis_article_state')
      .select('article_id,semantic_ready,external_analysis_ready,semantic_missing_fields,external_analysis_missing_fields,updated_at')
      .in('article_id', ids),
    supabase
      .from('ai_external_analysis_jobs')
      .select(SUMMARY_JOB_SELECT)
      .in('article_id', ids)
      .order('created_at', { ascending: false })
      .limit(Math.max(100, ids.length * 50)),
  ]);
  if (stateResult.error) throw stateResult.error;
  if (jobsResult.error) throw jobsResult.error;

  const stateByArticle = new Map<string, ExternalAnalysisArticleState>();
  (stateResult.data || []).forEach(row => {
    stateByArticle.set(String(row.article_id), {
      article_id: String(row.article_id),
      semantic_ready: row.semantic_ready === true,
      external_analysis_ready: row.external_analysis_ready === true,
      semantic_missing_fields: toStringList(row.semantic_missing_fields),
      external_analysis_missing_fields: toStringList(row.external_analysis_missing_fields),
      updated_at: String(row.updated_at || ''),
    });
  });

  const jobsByArticle = new Map<string, ExternalAnalysisJobRow[]>();
  (jobsResult.data || []).map(row => toJobRow(row as Record<string, any>)).forEach(job => {
    const jobs = jobsByArticle.get(job.article_id) || [];
    jobs.push(job);
    jobsByArticle.set(job.article_id, jobs);
  });

  return Object.fromEntries(ids.map(articleId => {
    const jobs = jobsByArticle.get(articleId) || [];
    const semanticJobs = jobs.filter(job => job.job_type === 'semantic_keywords_lsi');
    const engineeringJobs = jobs.filter(job => job.job_type === 'engineering_command');
    const activeEngineeringJobs = engineeringJobs.filter(job => EXTERNAL_ANALYSIS_ACTIVE_STATUSES.includes(job.status));
    const latestUpdatedAt = [stateByArticle.get(articleId)?.updated_at, ...jobs.map(job => job.updated_at)]
      .filter(Boolean)
      .sort((left, right) => new Date(right!).getTime() - new Date(left!).getTime())[0] || null;
    return [articleId, {
      articleId,
      state: stateByArticle.get(articleId) || null,
      latestSemanticJob: semanticJobs[0] || null,
      activeEngineeringCount: activeEngineeringJobs.length,
      completedEngineeringCount: engineeringJobs.filter(job => job.status === 'completed').length,
      retryingEngineeringCount: activeEngineeringJobs.filter(job => job.status === 'retry_scheduled').length,
      latestEngineeringJob: engineeringJobs[0] || null,
      latestUpdatedAt,
    } satisfies ExternalAnalysisDashboardSummary];
  }));
};

export const listExternalAnalysisJobs = async (
  articleId: string,
  limit = 100,
): Promise<ExternalAnalysisJobRow[]> => {
  if (!articleId.trim()) return [];
  const { data, error } = await getSupabaseClient()
    .from('ai_external_analysis_jobs')
    .select(FULL_JOB_SELECT)
    .eq('article_id', articleId)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 250)));
  if (error) throw error;
  return (data || []).map(row => toJobRow(row as Record<string, any>));
};

export class ExternalAnalysisRequestError extends Error {
  status: number;
  code: string;
  missingFields: string[];
  commandIds: string[];

  constructor(response: Response, body: Record<string, any>) {
    super(toTrimmedString(body.error) || `External analysis request failed with status ${response.status}.`);
    this.name = 'ExternalAnalysisRequestError';
    this.status = response.status;
    this.code = toTrimmedString(body.code) || 'external_analysis_request_failed';
    this.missingFields = toStringList(body.missingFields);
    this.commandIds = toStringList(body.commandIds);
  }
}

const requestExternalAnalysis = async (
  articleId: string,
  body: Record<string, unknown>,
): Promise<Record<string, any>> => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new Error('Supabase authentication is required.');
  }
  const response = await fetch('/api/external-analysis', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify({ articleId, ...body }),
  });
  const payload = await response.json().catch(() => ({}));
  const normalized = isRecord(payload) ? payload : {};
  if (!response.ok) throw new ExternalAnalysisRequestError(response, normalized);
  return normalized;
};

export const enqueueExternalSemanticAnalysis = (articleId: string) => (
  requestExternalAnalysis(articleId, { action: 'semantic' })
);

export const enqueueExternalEngineeringAnalysis = (
  articleId: string,
  commandIds: string[],
) => requestExternalAnalysis(articleId, { action: 'engineering', commandIds });

export const cancelExternalAnalysisJob = (
  articleId: string,
  jobId: string,
) => requestExternalAnalysis(articleId, { action: 'cancel', jobId });

export const cancelAllExternalAnalysisJobs = (
  articleId: string,
) => requestExternalAnalysis(articleId, { action: 'cancel_all' });

export const getExternalMissingFieldLabels = (
  fields: string[],
  locale: 'ar' | 'en' = 'ar',
): string[] => Array.from(new Set(fields.map(field => (
  MISSING_FIELD_LABELS[field]?.[locale] || field
))));

export const externalJobHasActiveStatus = (job?: ExternalAnalysisJobRow | null): boolean => (
  Boolean(job && EXTERNAL_ANALYSIS_ACTIVE_STATUSES.includes(job.status))
);

export const toExternalAiPatches = (
  job: ExternalAnalysisJobRow,
): AiContentPatch[] => {
  const result = isRecord(job.result) ? job.result : {};
  const rawPatches = Array.isArray(result.patches) ? result.patches : [];
  return rawPatches.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const operation = toTrimmedString(value.operation) as AiContentPatchOperation;
    const contentMarkdown = toTrimmedString(value.contentMarkdown);
    if (!ALLOWED_PATCH_OPERATIONS.has(operation)) return [];
    if (operation !== 'delete_block' && !contentMarkdown) return [];
    const marker = toTrimmedString(value.marker) || `external_${job.id}_${index + 1}`;
    const status = ['pending', 'applied', 'failed'].includes(toTrimmedString(value.status))
      ? toTrimmedString(value.status) as AiContentPatchStatus
      : 'pending';
    const mergeDeleteStatusValue = toTrimmedString(value.mergeDeleteStatus);
    const mergeDeleteStatus = ['pending', 'applied', 'failed'].includes(mergeDeleteStatusValue)
      ? mergeDeleteStatusValue as AiContentPatchStatus
      : undefined;
    return [{
      id: `${job.id}:${marker}`,
      provider: 'gemini',
      commandId: toTrimmedString(value.commandId) || job.command_id || undefined,
      operation,
      title: toTrimmedString(value.title) || `Suggestion ${index + 1}`,
      marker,
      anchorText: toTrimmedString(value.anchorText) || undefined,
      targetText: toTrimmedString(value.targetText) || undefined,
      placementLabel: toTrimmedString(value.placementLabel) || undefined,
      contentMarkdown,
      reason: toTrimmedString(value.reason) || undefined,
      confidence: typeof value.confidence === 'number' ? value.confidence : undefined,
      mergeDeleteTargetText: toTrimmedString(value.mergeDeleteTargetText) || undefined,
      mergeDeleteAnchorText: toTrimmedString(value.mergeDeleteAnchorText) || undefined,
      mergeDeletePlacementLabel: toTrimmedString(value.mergeDeletePlacementLabel) || undefined,
      mergeDeleteStatus,
      status,
    }];
  });
};

export const getExternalJobAnalysisMarkdown = (job: ExternalAnalysisJobRow): string => (
  toTrimmedString(job.result?.analysisMarkdown)
);
