import { getSupabaseClient } from './supabaseClient';

export type ContentWritingReportStatus =
  | 'queued'
  | 'running'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ContentWritingReportSession = {
  id: string;
  articleId: string;
  createdBy: string;
  provider: 'gemini' | 'geminiPaid' | 'openai';
  model: string;
  executionMode: 'api' | 'external';
  externalProvider: 'chatgpt' | 'gemini' | null;
  status: ContentWritingReportStatus;
  estimatedInputTokens: number;
  maxInputTokens: number;
  keySuffix: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  attemptCount: number;
  startedAt: string | null;
  completedAt: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
  applicationCount: number;
  qualityScore: number | null;
  qualityPolicyVersion: number | null;
  qualityRepairCount: number;
  qualityPassed: boolean | null;
  qualityMinimumScore: number | null;
  createdAt: string;
  updatedAt: string;
};

type ContentWritingReportRow = {
  id: string;
  article_id: string;
  created_by: string;
  provider: string;
  model: string;
  execution_mode: string;
  status: string;
  estimated_input_tokens: number | null;
  max_input_tokens: number | null;
  key_suffix: string | null;
  response_metadata: unknown;
  last_error_code: string | null;
  last_error: string | null;
  attempt_count: number | null;
  started_at: string | null;
  completed_at: string | null;
  applied_at: string | null;
  applied_by: string | null;
  application_count: number | null;
  quality_score: number | null;
  quality_policy_version: number | null;
  quality_repair_count: number | null;
  created_at: string;
  updated_at: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const toText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const toNullableText = (value: unknown): string | null => toText(value) || null;

const normalizeProvider = (value: unknown): ContentWritingReportSession['provider'] => {
  if (value === 'geminiPaid' || value === 'openai') return value;
  return 'gemini';
};

const normalizeStatus = (value: unknown): ContentWritingReportStatus => {
  const status = toText(value) as ContentWritingReportStatus;
  return ['queued', 'running', 'retry_scheduled', 'completed', 'failed', 'cancelled'].includes(status)
    ? status
    : 'failed';
};

const normalizeReportSession = (row: ContentWritingReportRow): ContentWritingReportSession => {
  const metadata = isRecord(row.response_metadata) ? row.response_metadata : {};
  const externalProvider = metadata.externalProvider === 'chatgpt' || metadata.externalProvider === 'gemini'
    ? metadata.externalProvider
    : null;
  const qualityReport = isRecord(metadata.qualityReport) ? metadata.qualityReport : {};
  return {
    id: row.id,
    articleId: row.article_id,
    createdBy: row.created_by,
    provider: normalizeProvider(row.provider),
    model: toText(row.model) || '-',
    executionMode: row.execution_mode === 'external' ? 'external' : 'api',
    externalProvider,
    status: normalizeStatus(row.status),
    estimatedInputTokens: Math.max(0, Number(row.estimated_input_tokens) || 0),
    maxInputTokens: Math.max(0, Number(row.max_input_tokens) || 0),
    keySuffix: toNullableText(row.key_suffix),
    lastErrorCode: toNullableText(row.last_error_code),
    lastError: toNullableText(row.last_error),
    attemptCount: Math.max(0, Number(row.attempt_count) || 0),
    startedAt: toNullableText(row.started_at),
    completedAt: toNullableText(row.completed_at),
    appliedAt: toNullableText(row.applied_at),
    appliedBy: toNullableText(row.applied_by),
    applicationCount: Math.max(0, Number(row.application_count) || 0),
    qualityScore: row.quality_score !== null && Number.isFinite(Number(row.quality_score))
      ? Number(row.quality_score)
      : null,
    qualityPolicyVersion: row.quality_policy_version !== null && Number.isFinite(Number(row.quality_policy_version))
      ? Math.max(1, Math.round(Number(row.quality_policy_version)))
      : null,
    qualityRepairCount: Math.max(0, Math.round(Number(row.quality_repair_count) || 0)),
    qualityPassed: typeof qualityReport.passed === 'boolean' ? qualityReport.passed : null,
    qualityMinimumScore: Number.isFinite(Number(qualityReport.minimumScore))
      ? Math.max(0, Math.min(100, Math.round(Number(qualityReport.minimumScore))))
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const listContentWritingReportSessions = async (options: {
  from: string;
  to: string;
  limit?: number;
}): Promise<ContentWritingReportSession[]> => {
  const { data, error } = await getSupabaseClient()
    .from('content_writing_sessions')
    .select([
      'id',
      'article_id',
      'created_by',
      'provider',
      'model',
      'execution_mode',
      'status',
      'estimated_input_tokens',
      'max_input_tokens',
      'key_suffix',
      'response_metadata',
      'last_error_code',
      'last_error',
      'attempt_count',
      'started_at',
      'completed_at',
      'applied_at',
      'applied_by',
      'application_count',
      'quality_score',
      'quality_policy_version',
      'quality_repair_count',
      'created_at',
      'updated_at',
    ].join(','))
    .gte('created_at', options.from)
    .lte('created_at', options.to)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(options.limit || 500, 1_000)));
  if (error) throw error;
  return ((data || []) as unknown as ContentWritingReportRow[]).map(normalizeReportSession);
};
