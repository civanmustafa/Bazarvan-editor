import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleStop,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import {
  cancelExternalAnalysisJob,
  enqueueFullArticlePipeline,
  EXTERNAL_ANALYSIS_ACTIVE_STATUSES,
  listExternalAnalysisJobs,
  retryExternalAnalysisJob,
  type ExternalAnalysisJobRow,
} from '../utils/externalAnalysis';
import type { ContentWritingProvider } from '../utils/contentWritingSessions';

type Props = {
  articleId: string;
  articleTitle: string;
  provider: ContentWritingProvider;
  model: string;
  disabled?: boolean;
  isArabic: boolean;
  onBeforeStart: () => Promise<boolean>;
  onReloadArticle: (articleId: string) => Promise<boolean>;
  onReloadGoalContext: (articleId: string) => Promise<boolean>;
};

const STAGES = [
  ['الصيغ البديلة وكلمات LSI', 'Alternative forms and LSI terms'],
  ['موجز المقالة الذكي', 'Smart article brief'],
  ['البحث والاختيار التلقائي للمنافسين', 'Competitor discovery and automatic selection'],
  ['سحب محتوى المنافسين', 'Competitor content extraction'],
  ['كتابة المقالة', 'Article writing'],
  ['إدراج المقالة تلقائيًا', 'Automatic article insertion'],
  ['تحليل المنافسين الشامل', 'Comprehensive competitor analysis'],
] as const;

const isActive = (job: ExternalAnalysisJobRow | null): boolean => (
  Boolean(job && EXTERNAL_ANALYSIS_ACTIVE_STATUSES.includes(job.status))
);

const getStatusLabel = (job: ExternalAnalysisJobRow, isArabic: boolean): string => {
  const labels: Record<ExternalAnalysisJobRow['status'], [string, string]> = {
    waiting_for_prerequisites: ['بانتظار المتطلبات', 'Waiting for prerequisites'],
    queued: ['في قائمة التنفيذ', 'Queued'],
    running: ['جار التنفيذ', 'Running'],
    retry_scheduled: ['إعادة محاولة مجدولة', 'Retry scheduled'],
    completed: ['اكتملت العملية', 'Completed'],
    failed: ['فشلت العملية', 'Failed'],
    blocked: ['توقفت العملية', 'Blocked'],
    cancelled: ['تم الإيقاف', 'Cancelled'],
    paused: ['متوقفة مؤقتًا', 'Paused'],
  };
  return labels[job.status][isArabic ? 0 : 1];
};

const formatDate = (value: string | null, isArabic: boolean): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(isArabic ? 'ar' : 'en', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
};

const FullArticlePipelineControl: React.FC<Props> = ({
  articleId,
  articleTitle,
  provider,
  model,
  disabled = false,
  isArabic,
  onBeforeStart,
  onReloadArticle,
  onReloadGoalContext,
}) => {
  const [competitorCount, setCompetitorCount] = useState(5);
  const [job, setJob] = useState<ExternalAnalysisJobRow | null>(null);
  const [busy, setBusy] = useState<'start' | 'cancel' | 'retry' | ''>('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(true);
  const reloadedJobsRef = useRef(new Set<string>());
  const syncedBriefJobsRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (!articleId) return;
    const rows = await listExternalAnalysisJobs(articleId, 50);
    const pipeline = rows
      .filter(row => row.job_type === 'full_article_pipeline')
      .sort((left, right) => (
        new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
      ))[0] || null;
    setJob(pipeline);
    const briefJobId = String(pipeline?.progress?.briefJobId || '').trim();
    const contentBriefSavedAt = String(pipeline?.progress?.contentBriefSavedAt || '').trim();
    if (
      pipeline
      && briefJobId
      && contentBriefSavedAt
      && !syncedBriefJobsRef.current.has(briefJobId)
    ) {
      syncedBriefJobsRef.current.add(briefJobId);
      const synchronized = await onReloadGoalContext(articleId);
      if (!synchronized) syncedBriefJobsRef.current.delete(briefJobId);
    }
    if (
      pipeline
      && !reloadedJobsRef.current.has(pipeline.id)
      && (
        pipeline.status === 'completed'
        || Boolean(pipeline.progress?.articleAppliedAt)
        || Boolean(pipeline.result?.articleApplied)
      )
    ) {
      reloadedJobsRef.current.add(pipeline.id);
      await onReloadArticle(articleId);
    }
  }, [articleId, onReloadArticle, onReloadGoalContext]);

  useEffect(() => {
    void refresh().catch(loadError => {
      console.error('Could not load the full article pipeline:', loadError);
    });
  }, [refresh]);

  useEffect(() => {
    if (!job || !isActive(job)) return;
    const timer = window.setInterval(() => {
      void refresh().catch(loadError => {
        console.error('Could not refresh the full article pipeline:', loadError);
      });
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [job, refresh]);

  const stageIndex = Math.max(0, Math.min(7, Number(job?.progress?.stageIndex) || 0));
  const qualityGatePassed = job?.result?.qualityGatePassed === true
    || job?.progress?.qualityGatePassed === true;
  const qualityScore = Number(job?.result?.qualityScore ?? job?.progress?.qualityScore);
  const selectedCompetitorCount = Number(
    job?.result?.selectedCompetitorCount
    ?? job?.progress?.selectedCompetitorCount,
  );
  const canRetry = Boolean(job && ['failed', 'blocked', 'cancelled', 'retry_scheduled'].includes(job.status));

  const start = async () => {
    if (busy || disabled || isActive(job)) return;
    setBusy('start');
    setError('');
    try {
      const saved = await onBeforeStart();
      if (!saved) {
        throw new Error(isArabic
          ? 'تعذر حفظ بيانات المقالة قبل بدء العملية الشاملة.'
          : 'The article could not be saved before starting the full workflow.');
      }
      const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await enqueueFullArticlePipeline({
        articleId,
        provider,
        model,
        competitorCount,
        idempotencyKey: `full-article-pipeline:${articleId}:${randomPart}`,
      });
      setExpanded(true);
      await refresh();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy('');
    }
  };

  const cancel = async () => {
    if (!job || busy) return;
    setBusy('cancel');
    setError('');
    try {
      await cancelExternalAnalysisJob(articleId, job.id);
      await refresh();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    } finally {
      setBusy('');
    }
  };

  const retry = async () => {
    if (!job || busy || !canRetry) return;
    setBusy('retry');
    setError('');
    try {
      await retryExternalAnalysisJob(articleId, job.id);
      setExpanded(true);
      await refresh();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
    } finally {
      setBusy('');
    }
  };

  const stageRows = useMemo(() => STAGES.map((labels, index) => {
    const number = index + 1;
    const complete = job?.status === 'completed' || stageIndex > number;
    const current = Boolean(job && stageIndex === number && job.status !== 'completed');
    const failed = current && ['failed', 'blocked', 'cancelled'].includes(job.status);
    return { number, label: labels[isArabic ? 0 : 1], complete, current, failed };
  }), [isArabic, job, stageIndex]);

  return (
    <section className="rounded-xl border border-[#d4af37]/35 bg-[#d4af37]/5 p-3 dark:bg-[#d4af37]/10">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-black text-gray-800 dark:text-gray-100">
            {isArabic ? 'إنشاء المقالة بالكامل' : 'Complete article workflow'}
          </div>
          <div className="mt-1 text-[10px] font-bold leading-5 text-gray-500 dark:text-gray-400">
            {isArabic
              ? 'ينفذ المراحل السبع بالترتيب، ويُدرج المقالة حتى عند عدم اجتياز بوابة الجودة. أي فشل يُعاد حسب المدة المضبوطة لدى المسؤول.'
              : 'Runs all seven stages in order and inserts the article even if the quality gate fails. Failures retry using the administrator interval.'}
          </div>
        </div>
        {job && (
          <button
            type="button"
            onClick={() => setExpanded(value => !value)}
            className="rounded-md p-1.5 text-gray-500 hover:bg-black/5 dark:hover:bg-white/5"
            title={expanded ? (isArabic ? 'طي التفاصيل' : 'Collapse details') : (isArabic ? 'توسيع التفاصيل' : 'Expand details')}
          >
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        )}
      </div>

      <div className="mt-3 flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-[10px] font-black text-gray-600 dark:text-gray-300">
            {isArabic ? 'عدد المنافسين' : 'Competitors'}
          </span>
          <select
            value={competitorCount}
            onChange={event => setCompetitorCount(Number(event.target.value))}
            disabled={isActive(job) || busy !== ''}
            className="h-9 w-full rounded-lg border border-gray-200 bg-white px-2 text-xs font-bold text-gray-800 outline-none dark:border-[#444] dark:bg-[#242424] dark:text-gray-100"
          >
            {[1, 2, 3, 4, 5].map(value => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={start}
          disabled={disabled || busy !== '' || isActive(job) || !model}
          className="inline-flex h-9 flex-[1.7] items-center justify-center gap-2 rounded-lg bg-[#d4af37] px-3 text-xs font-black text-[#171717] hover:bg-[#e0bd47] disabled:cursor-not-allowed disabled:opacity-50"
          title={articleTitle}
        >
          {busy === 'start' ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
          {isArabic ? 'بدء الإنشاء الشامل' : 'Start full workflow'}
        </button>
      </div>

      {job && expanded && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white/80 p-2.5 dark:border-[#414141] dark:bg-[#202020]/80">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-gray-700 dark:text-gray-200">
              {isActive(job) ? <Loader2 size={13} className="animate-spin text-blue-500" /> : job.status === 'completed' ? <CheckCircle2 size={13} className="text-emerald-500" /> : <Clock3 size={13} className="text-amber-500" />}
              {getStatusLabel(job, isArabic)}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-[#333]"
                title={isArabic ? 'تحديث' : 'Refresh'}
              >
                <RefreshCw size={13} />
              </button>
              {isActive(job) && (
                <button
                  type="button"
                  onClick={cancel}
                  disabled={busy !== ''}
                  className="inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-[10px] font-black text-red-600 disabled:opacity-50 dark:border-red-800 dark:text-red-300"
                >
                  {busy === 'cancel' ? <Loader2 size={12} className="animate-spin" /> : <CircleStop size={12} />}
                  {isArabic ? 'إيقاف' : 'Stop'}
                </button>
              )}
              {canRetry && (
                <button
                  type="button"
                  onClick={retry}
                  disabled={busy !== ''}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-300 px-2 py-1 text-[10px] font-black text-amber-700 disabled:opacity-50 dark:border-amber-800 dark:text-amber-300"
                >
                  {busy === 'retry' ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                  {isArabic ? 'استئناف الآن' : 'Resume now'}
                </button>
              )}
            </div>
          </div>

          <div className="mt-2 space-y-1.5">
            {stageRows.map(stage => (
              <div
                key={stage.number}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[10px] font-bold ${
                  stage.current ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {stage.failed
                  ? <XCircle size={13} className="shrink-0 text-red-500" />
                  : stage.complete
                    ? <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
                    : stage.current
                      ? <Loader2 size={13} className="shrink-0 animate-spin text-blue-500" />
                      : <Circle size={13} className="shrink-0" />}
                <span>{stage.number}. {stage.label}</span>
              </div>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] font-bold text-gray-500 dark:text-gray-400">
            {Number.isFinite(selectedCompetitorCount) && selectedCompetitorCount > 0 && (
              <span className="rounded bg-gray-100 px-2 py-1 dark:bg-[#303030]">
                {isArabic ? `المنافسون: ${selectedCompetitorCount}` : `Competitors: ${selectedCompetitorCount}`}
              </span>
            )}
            {Number.isFinite(qualityScore) && (
              <span className={`rounded px-2 py-1 ${qualityGatePassed ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'}`}>
                {isArabic ? `الجودة: ${qualityScore}/100` : `Quality: ${qualityScore}/100`}
              </span>
            )}
            {job.next_attempt_at && job.status === 'retry_scheduled' && (
              <span className="rounded bg-amber-50 px-2 py-1 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                {isArabic ? 'المحاولة القادمة' : 'Next attempt'}: {formatDate(job.next_attempt_at, isArabic)}
              </span>
            )}
          </div>

          {job.last_error && (
            <div className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[10px] font-bold leading-5 text-red-700 dark:bg-red-900/20 dark:text-red-300">
              {job.last_error}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[10px] font-bold text-red-700 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      )}
    </section>
  );
};

export default FullArticlePipelineControl;
