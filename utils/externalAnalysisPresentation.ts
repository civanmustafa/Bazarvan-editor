import type {
  ExternalAnalysisJobRow,
  ExternalAnalysisJobType,
} from './externalAnalysis';

export type ExternalAnalysisResultFilter = 'all' | 'active' | 'completed';

export type ExternalAnalysisJobBatch = {
  key: string;
  jobs: ExternalAnalysisJobRow[];
  createdAt: string;
};

const ACTIVE_STATUSES = new Set([
  'waiting_for_prerequisites',
  'queued',
  'running',
  'retry_scheduled',
  'paused',
]);

const JOB_TYPE_LABELS: Record<string, { ar: string; en: string }> = {
  semantic_keywords_lsi: { ar: 'الصيغ البديلة وLSI ومقترحات Google', en: 'Alternatives, LSI, and Google suggestions' },
  content_brief_generation: { ar: 'توليد موجز المقالة الذكي', en: 'Smart article brief generation' },
  meta_description_generation: { ar: 'كتابة وصف الميتا', en: 'Meta description generation' },
  full_article_pipeline: { ar: 'إنشاء المقالة بالكامل', en: 'Complete article workflow' },
  content_writing_preparation: { ar: 'تجهيز منافسي كتابة المقالة', en: 'Writing competitor preparation' },
  engineering_command: { ar: 'تحليل أمر هندسي', en: 'Engineering command analysis' },
  competitor_discovery: { ar: 'اكتشاف وترتيب المنافسين', en: 'Competitor discovery and ranking' },
  competitor_extraction: { ar: 'سحب محتوى المنافسين', en: 'Competitor content extraction' },
  unknown: { ar: 'تحليل خارجي', en: 'External analysis' },
};

export const getExternalAnalysisJobTypeLabel = (
  jobType: ExternalAnalysisJobType,
  locale: 'ar' | 'en',
): string => {
  const normalized = String(jobType || '').trim();
  const known = JOB_TYPE_LABELS[normalized];
  if (known) return known[locale];
  return normalized.replace(/[_-]+/g, ' ') || JOB_TYPE_LABELS.unknown[locale];
};

export const filterExternalAnalysisJobs = (
  jobs: readonly ExternalAnalysisJobRow[],
  filter: ExternalAnalysisResultFilter,
): ExternalAnalysisJobRow[] => jobs.filter(job => {
  if (filter === 'active') return ACTIVE_STATUSES.has(job.status);
  if (filter === 'completed') return job.status === 'completed';
  return true;
});

export const groupExternalAnalysisJobs = (
  jobs: readonly ExternalAnalysisJobRow[],
): ExternalAnalysisJobBatch[] => {
  const grouped = new Map<string, ExternalAnalysisJobRow[]>();
  jobs.forEach(job => {
    // A worker batch remains one visual group. Standalone jobs receive their
    // own key so unrelated analysis types can never be collapsed together.
    const key = job.batch_key?.trim() || `${job.job_type}:${job.id}`;
    grouped.set(key, [...(grouped.get(key) || []), job]);
  });

  return Array.from(grouped.entries())
    .map(([key, batchJobs]) => ({
      key,
      jobs: batchJobs.sort((left, right) => (
        left.sequence_number - right.sequence_number
        || new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
      )),
      createdAt: batchJobs
        .map(job => job.created_at)
        .filter(Boolean)
        .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || '',
    }))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
};

