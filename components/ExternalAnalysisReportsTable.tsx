import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import type { RemoteArticleActivity, RemoteProfile } from '../utils/supabaseArticles';
import type {
  ExternalAnalysisKeyAttempt,
  ExternalAnalysisReportJob,
  ExternalAnalysisRunRow,
} from '../utils/externalAnalysis';
import { getExternalReadyCommandLabel } from '../constants/externalAnalysisCommands';
import { buildAdminArticlePath, navigateToAppPath } from '../utils/appRoutes';
import { formatIstanbulDateTime } from '../utils/dateTime';

const PAGE_SIZE = 25;

const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const textValue = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const formatKeySuffix = (value: unknown): string => {
  const suffix = textValue(value);
  return suffix ? `••••${suffix.slice(-6)}` : '-';
};

const providerLabel = (provider: string): string => {
  if (provider === 'geminiPaid') return 'Gemini Pro';
  if (provider === 'gemini') return 'Gemini المجاني';
  if (provider === 'openai') return 'OpenAI';
  return provider || '-';
};

const statusLabel = (status: string, locale: 'ar' | 'en'): string => {
  const labels: Record<string, { ar: string; en: string }> = {
    waiting_for_prerequisites: { ar: 'بانتظار المتطلبات', en: 'Waiting for prerequisites' },
    queued: { ar: 'في الطابور', en: 'Queued' },
    running: { ar: 'قيد التشغيل', en: 'Running' },
    retry_scheduled: { ar: 'إعادة محاولة مجدولة', en: 'Retry scheduled' },
    completed: { ar: 'مكتمل', en: 'Completed' },
    failed: { ar: 'فشل', en: 'Failed' },
    blocked: { ar: 'محظور', en: 'Blocked' },
    cancelled: { ar: 'ملغي', en: 'Cancelled' },
    paused: { ar: 'متوقف مؤقتًا', en: 'Paused' },
  };
  return labels[status]?.[locale] || status || '-';
};

const failureReasonLabel = (reason: string, locale: 'ar' | 'en'): string => {
  if (locale === 'en') return reason || 'Unknown failure';
  const labels: Record<string, string> = {
    quota: 'الحصة مستنفدة',
    auth: 'المفتاح غير صالح أو غير مصرح',
    server: 'خطأ مؤقت من الخادم',
    blocked: 'محظور من الخدمة',
    cancelled: 'ألغيت المحاولة',
    unknown: 'سبب غير معروف',
  };
  return labels[reason] || reason || 'سبب غير معروف';
};

const statusClasses = (status: string): string => {
  if (status === 'completed') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300';
  if (status === 'running') return 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300';
  if (status === 'retry_scheduled' || status === 'queued' || status === 'waiting_for_prerequisites') {
    return 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300';
  }
  if (status === 'cancelled' || status === 'paused') return 'bg-gray-100 text-gray-600 dark:bg-gray-500/10 dark:text-gray-300';
  return 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300';
};

const getLatestSuccessfulApi = (job: ExternalAnalysisReportJob) => {
  for (const run of [...job.runs].sort((left, right) => right.runNumber - left.runNumber)) {
    const successfulAttempt = [...run.keyAttempts]
      .reverse()
      .find(attempt => attempt.outcome === 'success');
    if (successfulAttempt) {
      return {
        provider: run.provider,
        model: successfulAttempt.model || run.model,
        keySuffix: successfulAttempt.keySuffix,
      };
    }
  }

  if (job.runs.length === 0) {
    const result = isRecord(job.result) ? job.result : {};
    const resultKeySuffix = textValue(result.keySuffix);
    const resultProvider = textValue(result.provider);
    const resultModel = textValue(result.model);
    if (resultKeySuffix || resultProvider || resultModel) {
      return {
        provider: resultProvider,
        model: resultModel,
        keySuffix: resultKeySuffix,
      };
    }
  }
  return null;
};

type FailedAttemptWithRun = {
  run: ExternalAnalysisRunRow;
  attempt: ExternalAnalysisKeyAttempt;
};

const getFailedAttempts = (job: ExternalAnalysisReportJob): FailedAttemptWithRun[] => (
  job.runs.flatMap(run => run.keyAttempts
    .filter(attempt => attempt.outcome !== 'success')
    .map(attempt => ({ run, attempt })))
);

const getJobMoment = (job: ExternalAnalysisReportJob): string => (
  job.runs[0]?.startedAt || job.started_at || job.reportActivityAt || job.created_at
);

const formatDuration = (job: ExternalAnalysisReportJob, locale: 'ar' | 'en'): string => {
  const startedAt = job.started_at || job.runs[job.runs.length - 1]?.startedAt;
  const finishedAt = job.completed_at || job.runs[0]?.finishedAt;
  if (!startedAt || !finishedAt) return '-';
  const seconds = Math.max(0, Math.floor((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '-';
  if (seconds < 60) return locale === 'ar' ? `${seconds} ث` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return locale === 'ar' ? `${minutes} د ${remainingSeconds} ث` : `${minutes}m ${remainingSeconds}s`;
};

const getProfileLabel = (profile?: RemoteProfile | null): string => (
  profile?.fullName?.trim() || profile?.email?.trim() || '-'
);

const ExternalAnalysisReportsTable: React.FC<{
  jobs: ExternalAnalysisReportJob[];
  articles: RemoteArticleActivity[];
  profiles: RemoteProfile[];
  isLoading: boolean;
  error: string;
  locale: 'ar' | 'en';
}> = ({ jobs, articles, profiles, isLoading, error, locale }) => {
  const [page, setPage] = useState(1);
  const articleById = useMemo(
    () => new Map(articles.map(article => [article.id, article])),
    [articles],
  );
  const profileById = useMemo(
    () => new Map(profiles.map(profile => [profile.id, profile])),
    [profiles],
  );
  const totalPages = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  const displayedJobs = jobs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const completedCount = jobs.filter(job => job.status === 'completed').length;
  const retryCount = jobs.filter(job => job.status === 'retry_scheduled').length;
  const failedCount = jobs.filter(job => ['failed', 'blocked', 'cancelled'].includes(job.status)).length;

  useEffect(() => {
    setPage(1);
  }, [jobs]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const renderTask = (job: ExternalAnalysisReportJob) => {
    if (job.job_type === 'semantic_keywords_lsi') {
      return (
        <div>
          <div className="font-black text-gray-800 dark:text-gray-100">توليد الصيغ البديلة وLSI</div>
          <div className="mt-1 text-[11px] text-gray-500">{job.origin === 'auto' ? 'مهمة تلقائية' : 'طلب يدوي'}</div>
        </div>
      );
    }
    const commandLabel = job.command_id
      ? getExternalReadyCommandLabel(job.command_id, locale)
      : job.command_label || '-';
    return (
      <div>
        <div className="font-black text-gray-800 dark:text-gray-100">تحليل أمر جاهز</div>
        <div className="mt-1 max-w-[260px] break-words text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">{commandLabel}</div>
        <div className="mt-1 text-[11px] text-gray-500">
          {job.origin === 'auto' ? 'تشغيل تلقائي' : 'اختيار يدوي'} · الترتيب {job.sequence_number || 1}
        </div>
      </div>
    );
  };

  const renderFailureDetails = (job: ExternalAnalysisReportJob) => {
    const failedAttempts = getFailedAttempts(job);
    const latestRunError = job.runs.find(run => run.errorCode || run.errorMessage);
    const errorCode = latestRunError?.errorCode || job.last_error_code || '';
    const errorMessage = latestRunError?.errorMessage || job.last_error || '';
    if (!errorCode && !errorMessage && failedAttempts.length === 0) {
      return <span className="text-gray-400">-</span>;
    }

    return (
      <div className="max-w-[420px] space-y-2">
        {(errorCode || errorMessage) && (
          <div className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {errorCode && <div className="font-mono font-black">{errorCode}</div>}
            {errorMessage && <div className="mt-1 max-h-20 overflow-y-auto break-words leading-5">{errorMessage}</div>}
          </div>
        )}
        {failedAttempts.length > 0 && (
          <details className="rounded-md border border-red-100 px-2 py-1.5 text-xs dark:border-red-900/40">
            <summary className="cursor-pointer font-black text-red-700 dark:text-red-300">
              {failedAttempts.length} محاولة مفتاح فاشلة
            </summary>
            <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto border-t border-red-100 pt-2 dark:border-red-900/40">
              {failedAttempts.map(({ run, attempt }, index) => (
                <li key={`${run.id}-${index}`} className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                  <span className="font-mono font-black">{formatKeySuffix(attempt.keySuffix)}</span>
                  <span className="break-words">{failureReasonLabel(attempt.reason, locale)}</span>
                  <span className="col-span-2 text-[10px] text-gray-500">
                    المحاولة {run.runNumber} · {attempt.model || run.model || '-'}
                    {attempt.status !== null ? ` · HTTP ${attempt.status}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-bold text-gray-500 dark:text-gray-400">
        <span>المهام: <strong className="text-gray-800 dark:text-gray-100">{jobs.length}</strong></span>
        <span className="text-emerald-600 dark:text-emerald-300">ناجحة: {completedCount}</span>
        <span className="text-amber-600 dark:text-amber-300">بانتظار إعادة المحاولة: {retryCount}</span>
        <span className="text-red-600 dark:text-red-300">فاشلة أو ملغاة: {failedCount}</span>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
        <table className="w-full min-w-[1840px] text-start text-sm">
          <thead className="text-xs uppercase text-gray-400">
            <tr className="border-b border-gray-100 dark:border-[#3C3C3C]">
              <th className="px-3 py-2 text-start">تاريخ التشغيل</th>
              <th className="px-3 py-2 text-start">المقالة</th>
              <th className="px-3 py-2 text-start">نوع التحليل والأمر</th>
              <th className="px-3 py-2 text-start">الحالة</th>
              <th className="px-3 py-2 text-start">API الناجح</th>
              <th className="px-3 py-2 text-start">الفشل والمحاولات</th>
              <th className="px-3 py-2 text-start">المستخدم والمصدر</th>
              <th className="px-3 py-2 text-start">إنشاء المقالة</th>
              <th className="px-3 py-2 text-start">التوقيت والمتابعة</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-gray-500">
                  <span className="inline-flex items-center gap-2 font-bold"><LoaderCircle size={16} className="animate-spin" /> جار تحميل تقارير التحليل الخارجي...</span>
                </td>
              </tr>
            ) : displayedJobs.length > 0 ? displayedJobs.map(job => {
              const article = articleById.get(job.article_id);
              const inputSnapshot = isRecord(job.input_snapshot) ? job.input_snapshot : {};
              const articleTitle = article?.title || textValue(inputSnapshot.title) || '(بدون عنوان)';
              const requestedBy = job.requested_by ? profileById.get(job.requested_by) : null;
              const successfulApi = getLatestSuccessfulApi(job);
              const result = isRecord(job.result) ? job.result : {};
              const generatedCount = job.job_type === 'semantic_keywords_lsi'
                ? (Array.isArray(result.appliedFields) ? result.appliedFields.length : 0)
                : (Array.isArray(result.patches) ? result.patches.length : 0);
              return (
                <tr key={job.id} className="border-b border-gray-100 align-top dark:border-[#3C3C3C]">
                  <td className="whitespace-nowrap px-3 py-3 text-gray-500">
                    {formatIstanbulDateTime(getJobMoment(job), locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    <div className="mt-1 font-mono text-[10px] text-gray-400">#{job.id.slice(0, 8)}</div>
                  </td>
                  <td className="max-w-[280px] px-3 py-3">
                    <button
                      type="button"
                      onClick={() => navigateToAppPath(buildAdminArticlePath(job.article_id))}
                      className="inline-flex max-w-full items-start gap-1.5 text-start font-black text-gray-800 hover:text-[#8a6f1d] dark:text-gray-100 dark:hover:text-[#f2d675]"
                      title="فتح المقالة في مركز المتابعة"
                    >
                      <span className="break-words">{articleTitle}</span>
                      <ExternalLink size={12} className="mt-1 shrink-0" />
                    </button>
                    <div className="mt-1 font-mono text-[10px] text-gray-400">{job.article_id}</div>
                  </td>
                  <td className="px-3 py-3">{renderTask(job)}</td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-black ${statusClasses(job.status)}`}>
                      {job.status === 'completed'
                        ? <CheckCircle2 size={13} />
                        : job.status === 'running'
                          ? <LoaderCircle size={13} className="animate-spin" />
                          : job.status === 'retry_scheduled'
                            ? <RotateCcw size={13} />
                            : ['failed', 'blocked', 'cancelled'].includes(job.status)
                              ? <XCircle size={13} />
                              : <Clock3 size={13} />}
                      {statusLabel(job.status, locale)}
                    </span>
                    <div className="mt-2 text-[11px] leading-5 text-gray-500">
                      تشغيل: {job.attempt_count} · إعادة: {job.retry_count}
                    </div>
                    {generatedCount > 0 && (
                      <div className="text-[11px] font-bold text-emerald-600 dark:text-emerald-300">
                        {job.job_type === 'semantic_keywords_lsi' ? `حقول مطبقة: ${generatedCount}` : `اقتراحات: ${generatedCount}`}
                      </div>
                    )}
                  </td>
                  <td className="max-w-[240px] px-3 py-3">
                    {successfulApi ? (
                      <div className="space-y-1">
                        <div className="font-black text-emerald-600 dark:text-emerald-300">{providerLabel(successfulApi.provider)}</div>
                        <div className="break-words font-mono text-xs text-gray-600 dark:text-gray-300">{successfulApi.model || '-'}</div>
                        <div className="font-mono text-xs font-black text-gray-500">{formatKeySuffix(successfulApi.keySuffix)}</div>
                      </div>
                    ) : job.status === 'completed' ? (
                      <span className="text-xs text-gray-500">اكتمل دون استدعاء جديد</span>
                    ) : <span className="text-gray-400">-</span>}
                  </td>
                  <td className="px-3 py-3">{renderFailureDetails(job)}</td>
                  <td className="max-w-[220px] px-3 py-3 text-gray-600 dark:text-gray-300">
                    <div className="font-bold">{getProfileLabel(requestedBy)}</div>
                    <div className="mt-1 text-xs text-gray-500">{job.origin === 'auto' ? 'تلقائي' : 'يدوي'}</div>
                    {job.batch_key && <div className="mt-1 truncate font-mono text-[10px] text-gray-400" title={job.batch_key}>{job.batch_key}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-gray-500">
                    {article?.createdAt
                      ? formatIstanbulDateTime(article.createdAt, locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                      : '-'}
                  </td>
                  <td className="min-w-[220px] px-3 py-3 text-xs leading-6 text-gray-500">
                    <div>إنشاء المهمة: {formatIstanbulDateTime(job.created_at, locale)}</div>
                    <div>المدة: {formatDuration(job, locale)}</div>
                    {job.completed_at && <div>الاكتمال: {formatIstanbulDateTime(job.completed_at, locale)}</div>}
                    {job.next_attempt_at && <div className="font-bold text-amber-600 dark:text-amber-300">المحاولة القادمة: {formatIstanbulDateTime(job.next_attempt_at, locale)}</div>}
                    <div>سجلات التشغيل في اليوم: {job.runs.length}</div>
                  </td>
                </tr>
              );
            }) : (
              <tr><td colSpan={9} className="px-3 py-10 text-center text-gray-500">لا توجد مهام تحليل خارجي مسجلة لهذا اليوم.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {jobs.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3 text-xs font-bold text-gray-500 dark:text-gray-400">
          <span>عرض {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, jobs.length)} من {jobs.length}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage(current => Math.max(1, current - 1))}
              disabled={page === 1}
              className="rounded-md border border-gray-200 p-1.5 hover:bg-gray-50 disabled:opacity-40 dark:border-[#3C3C3C] dark:hover:bg-[#333]"
              title="الصفحة السابقة"
            >
              <ChevronRight size={15} />
            </button>
            <span>صفحة {page} من {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage(current => Math.min(totalPages, current + 1))}
              disabled={page === totalPages}
              className="rounded-md border border-gray-200 p-1.5 hover:bg-gray-50 disabled:opacity-40 dark:border-[#3C3C3C] dark:hover:bg-[#333]"
              title="الصفحة التالية"
            >
              <ChevronLeft size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExternalAnalysisReportsTable;
