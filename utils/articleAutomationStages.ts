import type { ContentWritingArticleSummary } from './contentWritingAutomation.ts';
import type { ExternalAnalysisDashboardSummary, ExternalAnalysisJobRow } from './externalAnalysis.ts';
import { formatIstanbulDateTime } from './dateTime.ts';

export type ArticleAutomationStageKey =
  | 'alternative_keywords'
  | 'lsi_keywords'
  | 'google_metadata'
  | 'competitor_discovery'
  | 'competitor_extraction'
  | 'external_analysis'
  | 'content_writing'
  | 'duplicate_suggestions'
  | 'internal_linking';

export type ArticleAutomationStageStatus =
  | 'completed'
  | 'running'
  | 'waiting'
  | 'partial'
  | 'attention'
  | 'not_started';

export type ArticleAutomationStage = {
  key: ArticleAutomationStageKey;
  label: string;
  status: ArticleAutomationStageStatus;
  statusLabel: string;
  details: string;
};

type BuildArticleAutomationStagesInput = {
  summary?: ExternalAnalysisDashboardSummary;
  contentWritingSummary?: ContentWritingArticleSummary;
  hasAlternativeKeywords: boolean;
  hasLsiKeywords: boolean;
  googleMetadataReady: boolean;
  locale?: 'ar' | 'en';
};

const ACTIVE_STATUSES = new Set(['running']);
const WAITING_STATUSES = new Set(['waiting_for_prerequisites', 'queued', 'retry_scheduled', 'paused']);
const ATTENTION_STATUSES = new Set(['failed', 'blocked']);

const statusLabels: Record<'ar' | 'en', Record<ArticleAutomationStageStatus, string>> = {
  ar: {
    completed: 'مكتملة',
    running: 'قيد التنفيذ',
    waiting: 'مجدولة أو في الانتظار',
    partial: 'مكتملة جزئيًا',
    attention: 'تحتاج مراجعة',
    not_started: 'لم تبدأ',
  },
  en: {
    completed: 'Completed',
    running: 'Running',
    waiting: 'Scheduled or waiting',
    partial: 'Partially completed',
    attention: 'Needs attention',
    not_started: 'Not started',
  },
};

const jobStatus = (
  job: ExternalAnalysisJobRow | null | undefined,
  completedEvidence = false,
): ArticleAutomationStageStatus => {
  if (completedEvidence) return 'completed';
  if (!job) return 'not_started';
  if (ACTIVE_STATUSES.has(job.status)) return 'running';
  if (WAITING_STATUSES.has(job.status)) return 'waiting';
  if (ATTENTION_STATUSES.has(job.status)) return 'attention';
  if (job.status === 'completed') return 'completed';
  return 'not_started';
};

const latestUpdateLabel = (
  job: ExternalAnalysisJobRow | null | undefined,
  locale: 'ar' | 'en',
): string => {
  if (!job?.updated_at) return '';
  const formatted = formatIstanbulDateTime(job.updated_at, locale === 'ar' ? 'ar' : 'en', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return formatted
    ? `${locale === 'ar' ? 'آخر تحديث' : 'Last update'}: ${formatted}`
    : '';
};

const jobDetails = (
  job: ExternalAnalysisJobRow | null | undefined,
  locale: 'ar' | 'en',
  fallback: string,
): string => {
  if (!job) return fallback;
  const parts = [
    job.last_error || '',
    job.status === 'retry_scheduled' && job.next_attempt_at
      ? `${locale === 'ar' ? 'إعادة المحاولة' : 'Retry'}: ${formatIstanbulDateTime(job.next_attempt_at, locale, {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        })}`
      : '',
    latestUpdateLabel(job, locale),
  ].filter(Boolean);
  return parts.join(' · ') || fallback;
};

const contentWritingStatus = (
  summary?: ContentWritingArticleSummary,
): ArticleAutomationStageStatus => {
  if (!summary) return 'not_started';
  if (summary.state === 'writing') return 'running';
  if (summary.state === 'queued' || summary.state === 'waiting_prerequisites') return 'waiting';
  if (summary.state === 'partial' || summary.state === 'written' || summary.state === 'written_quality_passed') return 'partial';
  if (summary.state === 'failed' || summary.state === 'written_quality_failed') return 'attention';
  if (summary.state === 'applied') return 'completed';
  return 'not_started';
};

const contentWritingDetails = (
  summary: ContentWritingArticleSummary | undefined,
  locale: 'ar' | 'en',
): string => {
  if (!summary) return locale === 'ar' ? 'لم تبدأ الكتابة التلقائية.' : 'Automatic writing has not started.';
  if (locale === 'en') {
    if (summary.state === 'applied' && summary.workReadiness?.state === 'auditing') return 'Content inserted automatically · running external audits.';
    if (summary.state === 'applied' && ['cleaning', 'waiting_cleanup'].includes(summary.workReadiness?.state || '')) return 'Content inserted automatically · cleaning repeated phrases.';
    if (summary.state === 'applied' && summary.workReadiness?.state === 'ready') return 'Content inserted automatically · ready for work.';
    return summary.errorMessage || `Writing status: ${summary.state}.`;
  }
  if (summary.state === 'applied' && summary.workReadiness?.state === 'auditing') return 'أدرج المحتوى تلقائيا · تنفيذ التدقيقات الخارجية';
  if (summary.state === 'applied' && ['cleaning', 'waiting_cleanup'].includes(summary.workReadiness?.state || '')) return 'أدرج المحتوى تلقائيا · تنقية المحتوى';
  if (summary.state === 'applied' && summary.workReadiness?.state === 'ready') return 'أدرج المحتوى تلقائيا · جاهزة للعمل';
  if (summary.state === 'written_quality_failed') return 'لم تتجاوز سياسة الجودة.';
  if (summary.state === 'writing') return 'تُكتب المقالة تلقائيًا الآن.';
  if (summary.state === 'queued') return 'بانتظار دورها في طابور الكتابة.';
  if (summary.state === 'waiting_prerequisites') {
    return `بانتظار اكتمال شروط الكتابة؛ المنافسون المؤهلون ${summary.usableCompetitorCount}/${summary.minimumCompetitorCount}.`;
  }
  if (summary.state === 'partial') return `محتوى جزئي محفوظ؛ اكتملت ${summary.partialStepCount} مراحل.`;
  if (summary.state === 'applied') return 'أدرج المحتوى تلقائيا.';
  return summary.errorMessage || 'تعذرت الكتابة وتحتاج إلى مراجعة.';
};

export const buildArticleAutomationStages = ({
  summary,
  contentWritingSummary,
  hasAlternativeKeywords,
  hasLsiKeywords,
  googleMetadataReady,
  locale = 'ar',
}: BuildArticleAutomationStagesInput): ArticleAutomationStage[] => {
  const semanticJob = summary?.latestSemanticJob || summary?.latestAutomaticSemanticJob || null;
  const discoveryJob = summary?.latestCompetitorDiscoveryJob || summary?.latestAutomaticCompetitorDiscoveryJob || null;
  const extractionJob = summary?.latestCompetitorExtractionJob || summary?.latestAutomaticCompetitorExtractionJob || null;
  const engineeringJobs = summary?.currentEngineeringJobs || (summary?.latestEngineeringJob ? [summary.latestEngineeringJob] : []);
  const expectedEngineeringIds = new Set(summary?.state?.external_analysis_effective_command_ids || []);
  const relevantEngineeringJobs = expectedEngineeringIds.size > 0
    ? engineeringJobs.filter(job => expectedEngineeringIds.has(job.command_id || ''))
    : engineeringJobs;
  const completedEngineering = relevantEngineeringJobs.filter(job => job.status === 'completed').length;
  const runningEngineering = relevantEngineeringJobs.filter(job => ACTIVE_STATUSES.has(job.status)).length;
  const waitingEngineering = relevantEngineeringJobs.filter(job => WAITING_STATUSES.has(job.status)).length;
  const failedEngineering = relevantEngineeringJobs.filter(job => ATTENTION_STATUSES.has(job.status)).length;
  const requiredAuditCount = contentWritingSummary?.workReadiness?.requiredAuditCount || expectedEngineeringIds.size;
  const completedAuditCount = Math.max(
    completedEngineering,
    contentWritingSummary?.workReadiness?.completedAuditCount || 0,
  );
  const activeAuditCount = Math.max(
    runningEngineering,
    contentWritingSummary?.workReadiness?.activeAuditCount || 0,
  );
  const failedAuditCount = Math.max(
    failedEngineering,
    contentWritingSummary?.workReadiness?.failedAuditCount || 0,
  );
  const externalAnalysisStatus: ArticleAutomationStageStatus = failedAuditCount > 0
    ? 'attention'
    : activeAuditCount > 0
      ? 'running'
      : waitingEngineering > 0
        ? 'waiting'
        : requiredAuditCount > 0 && completedAuditCount >= requiredAuditCount
          ? 'completed'
          : completedAuditCount > 0
            ? 'partial'
            : 'not_started';
  const totalCompetitors = summary?.competitorTotalCount || 0;
  const readyCompetitors = summary?.competitorReadyCount || 0;
  const discoveryResult = discoveryJob?.result;
  const discoveryCandidateCount = Array.isArray(discoveryResult?.results) ? discoveryResult.results.length : 0;
  const discoveryStatus = totalCompetitors > 0
    ? 'completed'
    : discoveryJob?.status === 'completed' && discoveryCandidateCount > 0
      ? 'partial'
      : discoveryJob?.status === 'completed'
        ? 'attention'
        : jobStatus(discoveryJob);
  const extractionStatus = totalCompetitors > 0 && readyCompetitors >= totalCompetitors
    ? 'completed'
    : readyCompetitors > 0
      ? 'partial'
      : jobStatus(extractionJob);
  const duplicate = summary?.duplicateCleanup;
  const duplicateStatus: ArticleAutomationStageStatus = !duplicate || duplicate.state === 'not_started'
    ? 'not_started'
    : duplicate.state === 'completed'
      ? 'completed'
      : duplicate.state === 'running'
        ? 'running'
        : duplicate.state === 'queued'
          ? 'waiting'
          : duplicate.state === 'partial'
            ? 'partial'
            : 'attention';
  const labels = locale === 'ar' ? {
    alternative_keywords: 'الصيغ البديلة',
    lsi_keywords: 'كلمات LSI',
    google_metadata: 'بيانات Google',
    competitor_discovery: 'بحث المنافسين',
    competitor_extraction: 'نصوص المنافسين',
    external_analysis: 'التدقيقات الخارجية',
    content_writing: 'كتابة المحتوى',
    duplicate_suggestions: 'اقتراحات التكرار',
    internal_linking: 'الربط الداخلي',
  } : {
    alternative_keywords: 'Alternatives',
    lsi_keywords: 'LSI',
    google_metadata: 'Google metadata',
    competitor_discovery: 'Competitor search',
    competitor_extraction: 'Competitor content',
    external_analysis: 'External audits',
    content_writing: 'Content writing',
    duplicate_suggestions: 'Duplicate suggestions',
    internal_linking: 'Internal linking',
  };
  const semanticDetails = jobDetails(
    semanticJob,
    locale,
    locale === 'ar' ? 'لم تبدأ مهمة التوليد الموحدة.' : 'Unified generation has not started.',
  );
  const stages: Array<Omit<ArticleAutomationStage, 'statusLabel'>> = [
    {
      key: 'alternative_keywords', label: labels.alternative_keywords,
      status: jobStatus(semanticJob, hasAlternativeKeywords), details: semanticDetails,
    },
    {
      key: 'lsi_keywords', label: labels.lsi_keywords,
      status: jobStatus(semanticJob, hasLsiKeywords), details: semanticDetails,
    },
    {
      key: 'google_metadata', label: labels.google_metadata,
      status: jobStatus(semanticJob, googleMetadataReady), details: semanticDetails,
    },
    {
      key: 'competitor_discovery', label: labels.competitor_discovery,
      status: discoveryStatus,
      details: [
        locale === 'ar' ? `النتائج المحفوظة: ${totalCompetitors}` : `Saved results: ${totalCompetitors}`,
        jobDetails(discoveryJob, locale, locale === 'ar' ? 'لم يبدأ البحث.' : 'Search has not started.'),
      ].filter(Boolean).join(' · '),
    },
    {
      key: 'competitor_extraction', label: labels.competitor_extraction,
      status: extractionStatus,
      details: [
        locale === 'ar' ? `النصوص الجاهزة: ${readyCompetitors}/${totalCompetitors}` : `Ready content: ${readyCompetitors}/${totalCompetitors}`,
        jobDetails(extractionJob, locale, locale === 'ar' ? 'لم يبدأ سحب النصوص.' : 'Content extraction has not started.'),
      ].filter(Boolean).join(' · '),
    },
    {
      key: 'external_analysis', label: labels.external_analysis,
      status: externalAnalysisStatus,
      details: [
        locale === 'ar'
          ? `التدقيقات المكتملة: ${completedAuditCount}/${requiredAuditCount || relevantEngineeringJobs.length}`
          : `Completed audits: ${completedAuditCount}/${requiredAuditCount || relevantEngineeringJobs.length}`,
        failedAuditCount > 0 && relevantEngineeringJobs.find(job => ATTENTION_STATUSES.has(job.status))?.last_error,
        latestUpdateLabel(summary?.latestEngineeringJob, locale),
      ].filter(Boolean).join(' · '),
    },
    {
      key: 'content_writing', label: labels.content_writing,
      status: contentWritingStatus(contentWritingSummary),
      details: contentWritingDetails(contentWritingSummary, locale),
    },
    {
      key: 'duplicate_suggestions', label: labels.duplicate_suggestions,
      status: duplicateStatus,
      details: duplicate
        ? (locale === 'ar'
            ? `اقتراحات التكرار: ${statusLabels.ar[duplicateStatus]} · اكتملت ${duplicate.completedCount} من ${duplicate.totalCount} تصنيفات.`
            : `Duplicate suggestions: ${statusLabels.en[duplicateStatus]} · ${duplicate.completedCount} of ${duplicate.totalCount} categories completed.`)
        : (locale === 'ar' ? 'لم يبدأ توليد اقتراحات التكرار.' : 'Duplicate suggestions have not started.'),
    },
    {
      key: 'internal_linking', label: labels.internal_linking,
      status: (summary?.savedInternalLinkCount || 0) > 0 ? 'completed' : 'not_started',
      details: (summary?.savedInternalLinkCount || 0) > 0
        ? (locale === 'ar'
            ? `طُبّق ${summary?.savedInternalLinkCount} رابط داخلي موثوق.`
            : `${summary?.savedInternalLinkCount} trusted internal link(s) applied.`)
        : (locale === 'ar'
            ? 'لم يُطبّق رابط بعد؛ يُنفذ داخل المحرر عند تحقق شروط الثقة.'
            : 'No link applied yet; this runs in the editor when confidence requirements are met.'),
    },
  ];
  return stages.map(stage => ({
    ...stage,
    statusLabel: statusLabels[locale][stage.status],
  }));
};
