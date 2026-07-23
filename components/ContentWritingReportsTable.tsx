import React, { useMemo } from 'react';
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import type { RemoteArticleActivity, RemoteProfile } from '../utils/supabaseArticles';
import type { ContentWritingReportSession } from '../utils/contentWritingReports';
import { buildAdminArticlePath, navigateToAppPath } from '../utils/appRoutes';
import { formatIstanbulDateTime } from '../utils/dateTime';

type ContentWritingReportsTableProps = {
  sessions: ContentWritingReportSession[];
  articles: RemoteArticleActivity[];
  profiles: RemoteProfile[];
  isLoading: boolean;
  error: string;
  locale: 'ar' | 'en';
};

const getStatusLabel = (status: ContentWritingReportSession['status'], locale: 'ar' | 'en'): string => {
  const labels: Record<ContentWritingReportSession['status'], [string, string]> = {
    queued: ['قيد الانتظار', 'Queued'],
    running: ['قيد التنفيذ', 'Running'],
    retry_scheduled: ['إعادة مجدولة', 'Retry scheduled'],
    completed: ['مكتمل', 'Completed'],
    failed: ['فشل', 'Failed'],
    cancelled: ['ملغى', 'Cancelled'],
  };
  return labels[status][locale === 'ar' ? 0 : 1];
};

const getExecutionLabel = (session: ContentWritingReportSession, locale: 'ar' | 'en'): string => {
  if (session.executionMode === 'external') {
    if (session.externalProvider === 'chatgpt') return locale === 'ar' ? 'ChatGPT خارجي' : 'External ChatGPT';
    return locale === 'ar' ? 'Gemini خارجي' : 'External Gemini';
  }
  if (session.provider === 'geminiPaid') return 'Gemini Pro API';
  if (session.provider === 'openai') return 'OpenAI API';
  return locale === 'ar' ? 'Gemini المجاني API' : 'Gemini Free API';
};

const formatDuration = (session: ContentWritingReportSession, locale: 'ar' | 'en'): string => {
  if (!session.startedAt || !session.completedAt) return '-';
  const milliseconds = new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '-';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} ${locale === 'ar' ? 'ث' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')} ${locale === 'ar' ? 'د' : 'm'}`;
};

const ContentWritingReportsTable: React.FC<ContentWritingReportsTableProps> = ({
  sessions,
  articles,
  profiles,
  isLoading,
  error,
  locale,
}) => {
  const articleById = useMemo(() => new Map(articles.map(article => [article.id, article])), [articles]);
  const profileById = useMemo(() => new Map(profiles.map(profile => [profile.id, profile])), [profiles]);

  if (isLoading) {
    return <div className="py-8 text-center text-sm font-bold text-gray-400">{locale === 'ar' ? 'جار تحميل تقارير الكتابة...' : 'Loading writing reports...'}</div>;
  }
  if (error) {
    return <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">{error}</div>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <table className="w-full min-w-[1660px] text-start text-sm">
        <thead className="text-xs uppercase text-gray-400">
          <tr className="border-b border-gray-100 dark:border-[#3C3C3C]">
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'المقالة' : 'Article'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'طريقة التشغيل' : 'Execution'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'الموديل' : 'Model'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'الحالة' : 'Status'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'الجودة' : 'Quality'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'المستخدم' : 'User'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'المدخلات' : 'Input'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'المحاولات' : 'Attempts'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'المدة' : 'Duration'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'الإدراج' : 'Applied'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'الخطأ' : 'Error'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'وقت الإنشاء' : 'Created'}</th>
          </tr>
        </thead>
        <tbody>
          {sessions.length > 0 ? sessions.map(session => {
            const article = articleById.get(session.articleId);
            const profile = profileById.get(session.createdBy);
            const isCompleted = session.status === 'completed';
            return (
              <tr key={session.id} className="border-b border-gray-100 align-top dark:border-[#3C3C3C]">
                <td className="max-w-[260px] px-3 py-3">
                  <button
                    type="button"
                    onClick={() => navigateToAppPath(buildAdminArticlePath(session.articleId))}
                    className="inline-flex max-w-full items-center gap-1 font-bold text-[#8a6f1d] hover:underline dark:text-[#f2d675]"
                    title={article?.title || session.articleId}
                  >
                    <ExternalLink size={12} className="shrink-0" />
                    <span className="truncate">{article?.title || session.articleId}</span>
                  </button>
                </td>
                <td className="px-3 py-3 font-bold text-gray-700 dark:text-gray-200">{getExecutionLabel(session, locale)}</td>
                <td className="px-3 py-3 font-mono text-xs text-gray-500" dir="ltr">{session.model}</td>
                <td className="px-3 py-3">
                  <span className={`inline-flex items-center gap-1 font-black ${isCompleted ? 'text-emerald-600 dark:text-emerald-300' : session.status === 'failed' ? 'text-red-600 dark:text-red-300' : 'text-amber-600 dark:text-amber-300'}`}>
                    {isCompleted ? <CheckCircle2 size={13} /> : session.status === 'failed' ? <XCircle size={13} /> : null}
                    {getStatusLabel(session.status, locale)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  {session.qualityScore === null ? '-' : (
                    <span className={`font-black tabular-nums ${session.qualityPassed === true ? 'text-emerald-600 dark:text-emerald-300' : session.qualityPassed === false ? 'text-red-600 dark:text-red-300' : 'text-amber-600 dark:text-amber-300'}`}>
                      {session.qualityScore}/{session.qualityMinimumScore || 100}
                      <span className="ms-1 text-[10px] font-bold text-gray-400">
                        v{session.qualityPolicyVersion || '-'} · {locale === 'ar' ? 'إصلاح' : 'repair'} {session.qualityRepairCount}
                      </span>
                    </span>
                  )}
                </td>
                <td className="max-w-[220px] px-3 py-3 text-gray-600 dark:text-gray-300">{profile?.fullName || profile?.email || session.createdBy}</td>
                <td className="whitespace-nowrap px-3 py-3 text-gray-500">
                  <div>
                    {(session.actualInputTokens || session.estimatedInputTokens).toLocaleString(locale)}
                    {' / '}
                    {session.maxInputTokens.toLocaleString(locale)}
                  </div>
                  {session.apiRequestCount > 0 ? (
                    <div className="mt-1 text-[10px] font-bold text-gray-400">
                      {locale === 'ar' ? 'كاش' : 'cache'} {session.cachedInputTokens.toLocaleString(locale)}
                      {' · '}
                      {locale === 'ar' ? 'مخرجات' : 'output'} {session.outputTokens.toLocaleString(locale)}
                      {' · '}
                      {locale === 'ar' ? 'طلبات' : 'requests'} {session.apiRequestCount.toLocaleString(locale)}
                      {session.knowledgeCoveragePercent !== null
                        ? ` · ${locale === 'ar' ? 'تغطية' : 'coverage'} ${session.knowledgeCoveragePercent}%`
                        : ''}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-3 text-center font-bold tabular-nums text-gray-600 dark:text-gray-300">{session.attemptCount}</td>
                <td className="whitespace-nowrap px-3 py-3 text-gray-500">{formatDuration(session, locale)}</td>
                <td className="whitespace-nowrap px-3 py-3 text-gray-500">
                  {session.appliedAt
                    ? `${formatIstanbulDateTime(session.appliedAt, locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}${session.applicationCount > 1 ? ` · ${session.applicationCount}` : ''}`
                    : '-'}
                </td>
                <td className="max-w-[320px] break-words px-3 py-3 text-red-600 dark:text-red-300" title={session.lastError || session.lastErrorCode || ''}>
                  {session.lastError || session.lastErrorCode || '-'}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-gray-500">{formatIstanbulDateTime(session.createdAt, locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
              </tr>
            );
          }) : (
            <tr><td colSpan={12} className="px-3 py-8 text-center text-gray-500">{locale === 'ar' ? 'لا توجد جلسات كتابة محتوى لهذا اليوم.' : 'No content writing sessions for this day.'}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

export default ContentWritingReportsTable;
