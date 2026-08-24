import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleStop,
  Clock3,
  Eye,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import {
  cancelExternalAnalysisJob,
  enqueueFullArticlePipeline,
  EXTERNAL_ANALYSIS_ACTIVE_STATUSES,
  loadLatestFullArticlePipeline,
  retryExternalAnalysisJob,
  type ExternalAnalysisJobRow,
} from '../utils/externalAnalysis';
import type { ContentWritingProvider } from '../utils/contentWritingSessions';
import {
  formatPipelineDuration,
  FULL_ARTICLE_PIPELINE_STAGES,
  getFullArticlePipelineProgressView,
} from '../utils/fullArticlePipelineProgress';

type Props = {
  articleId: string;
  articleTitle: string;
  provider: ContentWritingProvider;
  model: string;
  /** @deprecated Prefer the start/resume-specific blockers below. */
  disabled?: boolean;
  startDisabled?: boolean;
  resumeDisabled?: boolean;
  startDisabledReason?: string;
  isArabic: boolean;
  onBeforeStart: () => Promise<boolean>;
  onReloadArticle: (articleId: string) => Promise<boolean>;
  onReloadGoalContext: (articleId: string) => Promise<boolean>;
  onActivityChange?: (active: boolean) => void;
  onReviewRequested?: (contentWritingSessionId: string) => void;
};

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

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return fallback;
};

const FullArticlePipelineControl: React.FC<Props> = ({
  articleId,
  articleTitle,
  provider,
  model,
  disabled = false,
  startDisabled = false,
  resumeDisabled = false,
  startDisabledReason,
  isArabic,
  onBeforeStart,
  onReloadArticle,
  onReloadGoalContext,
  onActivityChange,
  onReviewRequested,
}) => {
  const [competitorCount, setCompetitorCount] = useState(5);
  const [job, setJob] = useState<ExternalAnalysisJobRow | null>(null);
  const [busy, setBusy] = useState<'start' | 'cancel' | 'retry' | ''>('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState(true);
  const reloadedJobsRef = useRef(new Set<string>());
  const syncedBriefJobsRef = useRef(new Set<string>());
  const refreshInFlightRef = useRef(false);
  const fullWorkflowStartDisabled = disabled || startDisabled;
  const fullWorkflowResumeDisabled = disabled || resumeDisabled;

  useEffect(() => {
    onActivityChange?.(isActive(job) || busy === 'start' || busy === 'retry');
  }, [busy, job, onActivityChange]);

  const refresh = useCallback(async () => {
    if (!articleId || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const pipeline = await loadLatestFullArticlePipeline(articleId);
      setJob(pipeline);
      setLoadError('');
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
    } catch (refreshError) {
      setLoadError(getErrorMessage(
        refreshError,
        isArabic ? 'تعذر تحميل حالة الإنشاء الشامل.' : 'Could not load the full workflow status.',
      ));
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [articleId, isArabic, onReloadArticle, onReloadGoalContext]);

  useEffect(() => {
    setJob(null);
    setLoadError('');
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!job || !isActive(job)) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5_000);
    const onVisibilityChange = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [job, refresh]);

  const progressView = useMemo(
    () => getFullArticlePipelineProgressView(job),
    [job],
  );
  const canRetry = Boolean(
    job
    && !progressView.reviewRequired
    && ['failed', 'cancelled', 'retry_scheduled'].includes(job.status),
  );
  const showFailure = Boolean(
    job
    && ['failed', 'blocked', 'retry_scheduled'].includes(job.status)
    && job.last_error,
  );
  const effectiveModel = progressView.actualModel || progressView.requestedModel;
  const displayedModel = effectiveModel && progressView.requestedModel && effectiveModel !== progressView.requestedModel
    ? `${progressView.requestedModel} → ${effectiveModel}`
    : effectiveModel || progressView.requestedModel;
  const effectiveProvider = progressView.actualProvider || progressView.requestedProvider;
  const completedWritingSteps = progressView.completedWorkflowSteps ?? progressView.workflowStepIndex;
  const elapsed = formatPipelineDuration(progressView.elapsedMs, isArabic);

  const start = async () => {
    if (busy || fullWorkflowStartDisabled || isActive(job)) return;
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
    if (!job || busy || fullWorkflowResumeDisabled || !canRetry) return;
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

  const stageRows = useMemo(() => FULL_ARTICLE_PIPELINE_STAGES
    .slice(0, progressView.stageCount)
    .map((stageDefinition, index) => {
    const number = index + 1;
    const complete = job?.status === 'completed' || progressView.stageIndex > number;
    const current = Boolean(job && progressView.stageIndex === number && job.status !== 'completed');
    const failed = current && ['failed', 'blocked', 'cancelled'].includes(job.status);
    return {
      number,
      key: stageDefinition.key,
      label: isArabic ? stageDefinition.labelAr : stageDefinition.labelEn,
      complete,
      current,
      failed,
    };
  }), [isArabic, job, progressView.stageCount, progressView.stageIndex]);

  return (
    <section className="rounded-xl border border-[#d4af37]/35 bg-[#d4af37]/5 p-3 dark:bg-[#d4af37]/10">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-black text-gray-800 dark:text-gray-100">
            {isArabic ? 'إنشاء المقالة بالكامل' : 'Complete article workflow'}
          </div>
          <div className="mt-1 text-[10px] font-bold leading-5 text-gray-500 dark:text-gray-400">
            {isArabic
              ? 'ينفذ المراحل السبع بالترتيب، ويراجع النتيجة ويصلحها قبل الإدراج الآمن. تتوقف مخالفات الجودة المانعة للمراجعة بدل استبدال المقالة.'
              : 'Runs all seven stages in order, reviews and repairs the draft, then inserts it safely. Blocking quality issues pause for review instead of replacing the article.'}
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
            {isArabic ? 'عدد منافسي الإنشاء الشامل' : 'Full-workflow competitors'}
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
          disabled={fullWorkflowStartDisabled || busy !== '' || isActive(job) || !model}
          className="inline-flex h-9 flex-[1.7] items-center justify-center gap-2 rounded-lg bg-[#d4af37] px-3 text-xs font-black text-[#171717] hover:bg-[#e0bd47] disabled:cursor-not-allowed disabled:opacity-50"
          title={fullWorkflowStartDisabled && startDisabledReason ? startDisabledReason : articleTitle}
        >
          {busy === 'start' ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
          {isArabic ? 'بدء الإنشاء الشامل' : 'Start full workflow'}
        </button>
      </div>

      <p className="mt-1.5 text-[9px] font-bold leading-4 text-gray-500 dark:text-gray-400">
        {isArabic
          ? 'هذا العدد خاص بزر «بدء الإنشاء الشامل»؛ زر «كتابة المقالة» يستخدم المنافسين المحفوظين حاليًا في المقالة.'
          : 'This count only applies to “Start full workflow”; “Write article” uses the competitors already saved on the article.'}
      </p>

      {fullWorkflowStartDisabled && startDisabledReason && !isActive(job) && (
        <p className="mt-1.5 rounded bg-amber-50 px-2 py-1 text-[9px] font-bold leading-4 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          {startDisabledReason}
        </p>
      )}

      {loadError && (
        <div className="mt-2 flex items-start justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[10px] font-bold leading-5 text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 rounded p-1 hover:bg-red-100 dark:hover:bg-red-900/30"
            title={isArabic ? 'إعادة المحاولة' : 'Retry'}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      )}

      {job && expanded && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white/80 p-2.5 dark:border-[#414141] dark:bg-[#202020]/80">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-gray-700 dark:text-gray-200">
              {isActive(job)
                ? <Loader2 size={13} className="animate-spin text-blue-500" />
                : job.status === 'completed'
                  ? <CheckCircle2 size={13} className="text-emerald-500" />
                  : progressView.reviewRequired
                    ? <ShieldAlert size={13} className="text-amber-500" />
                    : <Clock3 size={13} className="text-amber-500" />}
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
                  disabled={fullWorkflowResumeDisabled || busy !== ''}
                  title={fullWorkflowResumeDisabled
                    ? (isArabic ? 'يوجد مسار كتابة آخر نشط لهذه المقالة.' : 'Another writing workflow is active for this article.')
                    : undefined}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-300 px-2 py-1 text-[10px] font-black text-amber-700 disabled:opacity-50 dark:border-amber-800 dark:text-amber-300"
                >
                  {busy === 'retry' ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                  {isArabic ? 'استئناف الآن' : 'Resume now'}
                </button>
              )}
              {progressView.reviewRequired && (
                <button
                  type="button"
                  onClick={() => onReviewRequested?.(progressView.contentWritingSessionId)}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-400 bg-amber-50 px-2 py-1 text-[10px] font-black text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
                >
                  <Eye size={12} />
                  {isArabic ? 'مراجعة النواقص' : 'Review issues'}
                </button>
              )}
            </div>
          </div>

          <div className="mt-2 space-y-1.5">
            {stageRows.map(stage => (
              <div
                key={stage.key}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[10px] font-bold ${
                  stage.current ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {stage.failed
                  ? progressView.reviewRequired
                    ? <ShieldAlert size={13} className="shrink-0 text-amber-500" />
                    : <XCircle size={13} className="shrink-0 text-red-500" />
                  : stage.complete
                    ? <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
                    : stage.current
                      ? <Loader2 size={13} className="shrink-0 animate-spin text-blue-500" />
                      : <Circle size={13} className="shrink-0" />}
                <span>{stage.number}. {stage.label}</span>
              </div>
            ))}
          </div>

          {progressView.substage && job.status !== 'completed' && (
            <div className="mt-2 rounded-md border border-blue-100 bg-blue-50/70 px-2 py-1.5 text-[10px] font-bold leading-5 text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/10 dark:text-blue-200">
              <span className="me-1 text-blue-500">{isArabic ? 'المرحلة الفرعية:' : 'Substage:'}</span>
              {progressView.substage}
            </div>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] font-bold text-gray-500 dark:text-gray-400">
            <span className="rounded bg-gray-100 px-2 py-1 dark:bg-[#303030]">
              {isArabic ? 'المرحلة' : 'Stage'}: {progressView.stageIndex}/{progressView.stageCount}
            </span>
            {elapsed && (
              <span className="rounded bg-gray-100 px-2 py-1 dark:bg-[#303030]">
                {isArabic ? 'الزمن' : 'Elapsed'}: {elapsed}
              </span>
            )}
            {(job.attempt_count > 0 || job.retry_count > 0) && (
              <span className="rounded bg-gray-100 px-2 py-1 dark:bg-[#303030]">
                {isArabic
                  ? `المحاولات: ${job.attempt_count} · الإعادات: ${job.retry_count}`
                  : `Attempts: ${job.attempt_count} · Retries: ${job.retry_count}`}
              </span>
            )}
            {effectiveProvider && (
              <span className="rounded bg-gray-100 px-2 py-1 dark:bg-[#303030]">
                {isArabic ? 'المزود' : 'Provider'}: <span dir="ltr">{effectiveProvider}</span>
              </span>
            )}
            {displayedModel && (
              <span className="max-w-full truncate rounded bg-gray-100 px-2 py-1 font-mono dark:bg-[#303030]" dir="ltr" title={displayedModel}>
                {displayedModel}
              </span>
            )}
            {progressView.workflowStepCount !== null && progressView.workflowStepCount > 0 && (
              <span className="rounded bg-blue-50 px-2 py-1 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                {isArabic ? 'خطوات الكتابة' : 'Writing steps'}: {Math.min(
                  progressView.workflowStepCount,
                  Math.max(0, completedWritingSteps || 0),
                )}/{progressView.workflowStepCount}
              </span>
            )}
            {progressView.candidateCount !== null && progressView.candidateCount > 0 && (
              <span className="rounded bg-violet-50 px-2 py-1 text-violet-700 dark:bg-violet-900/20 dark:text-violet-300">
                {isArabic ? 'المرشحون' : 'Candidates'}: {progressView.candidateCount}
                {progressView.selectedCandidateIndex !== null
                  ? ` · ${isArabic ? 'المعتمد' : 'selected'} ${progressView.selectedCandidateIndex}`
                  : ''}
                {progressView.rejectedCandidateCount !== null
                  ? ` · ${isArabic ? 'المرفوض' : 'rejected'} ${progressView.rejectedCandidateCount}`
                  : ''}
              </span>
            )}
            {progressView.selectedCompetitorCount !== null && progressView.selectedCompetitorCount > 0 && (
              <span className="rounded bg-gray-100 px-2 py-1 dark:bg-[#303030]">
                {isArabic ? `المنافسون: ${progressView.selectedCompetitorCount}` : `Competitors: ${progressView.selectedCompetitorCount}`}
              </span>
            )}
            {progressView.qualityScore !== null && (
              <span className={`rounded px-2 py-1 ${progressView.qualityGatePassed === true ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'}`}>
                {isArabic ? `الجودة: ${progressView.qualityScore}/100` : `Quality: ${progressView.qualityScore}/100`}
                {progressView.qualityMinimumScore !== null
                  ? ` · ${isArabic ? 'الحد' : 'min'} ${progressView.qualityMinimumScore}`
                  : ''}
                {progressView.qualityBlockingFailureCount !== null
                  ? ` · ${isArabic ? 'مانع' : 'blocking'} ${progressView.qualityBlockingFailureCount}`
                  : ''}
              </span>
            )}
            {job.next_attempt_at && job.status === 'retry_scheduled' && (
              <span className="rounded bg-amber-50 px-2 py-1 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                {isArabic ? 'المحاولة القادمة' : 'Next attempt'}: {formatDate(job.next_attempt_at, isArabic)}
              </span>
            )}
          </div>

          {progressView.retryReason && (
            <div className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[10px] font-bold leading-5 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              {isArabic ? 'سبب إعادة المحاولة:' : 'Retry reason:'} <span dir="ltr">{progressView.retryReason}</span>
            </div>
          )}

          {progressView.reviewRequired && (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[10px] font-bold leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
              <div className="flex items-center gap-1.5 font-black">
                <ShieldAlert size={13} />
                {isArabic
                  ? 'توقفت العملية للمراجعة؛ لن تُدرج المسودة قبل معالجة النواقص.'
                  : 'The workflow paused for review; the draft will not be inserted until issues are resolved.'}
              </div>
              {progressView.reviewReasons.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-1 ps-4">
                  {progressView.reviewReasons.map(reason => <li key={reason}>{reason}</li>)}
                </ul>
              )}
            </div>
          )}

          {showFailure && !progressView.reviewRequired && (
            <div className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[10px] font-bold leading-5 text-red-700 dark:bg-red-900/20 dark:text-red-300">
              {job.last_error_code && <span className="me-1 font-mono" dir="ltr">[{job.last_error_code}]</span>}
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
