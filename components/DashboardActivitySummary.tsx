import React from 'react';
import {
  Activity,
  Archive,
  BookCheck,
  Clock3,
  FilePenLine,
  FileText,
  Gauge,
  History,
  Save,
  ScrollText,
  Users,
} from 'lucide-react';
import {
  DASHBOARD_ARTICLE_STATUS_TABS,
  getArticleStatusLabel,
  type ArticleStatus,
} from '../constants/articleStatuses';
import type { DashboardActivitySummary as DashboardActivitySummaryData } from '../utils/supabaseArticles';
import { formatIstanbulDateTime } from '../utils/dateTime';

type Props = {
  summary: DashboardActivitySummaryData | null;
  isLoading: boolean;
  error: string;
  isAdmin: boolean;
  locale: string;
};

const STATUS_ICONS: Record<ArticleStatus, React.ReactNode> = {
  in_review: <BookCheck size={15} />,
  content_preparation: <FilePenLine size={15} />,
  draft: <FileText size={15} />,
  published: <ScrollText size={15} />,
  archived: <Archive size={15} />,
};

const STATUS_STYLES: Record<ArticleStatus, string> = {
  in_review: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  content_preparation: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  draft: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  published: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  archived: 'bg-gray-100 text-gray-600 dark:bg-gray-500/10 dark:text-gray-300',
};

const formatDuration = (seconds: number, isArabic: boolean): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  if (hours > 0) return `${hours}${isArabic ? 'س' : 'h'} ${minutes}${isArabic ? 'د' : 'm'}`;
  if (minutes > 0) return `${minutes}${isArabic ? 'د' : 'm'}`;
  return `${safeSeconds}${isArabic ? 'ث' : 's'}`;
};

const formatNumber = (value: number, locale: string): string => (
  new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'ar').format(Math.max(0, value || 0))
);

const SummaryMetric: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}> = ({ icon, label, value, hint }) => (
  <div className="min-w-0 rounded-lg bg-gray-50 p-3 dark:bg-[#222]">
    <div className="flex items-center gap-2 text-[11px] font-black text-gray-500 dark:text-gray-400">
      <span className="text-[#b8922e] dark:text-[#f2d675]">{icon}</span>
      <span>{label}</span>
    </div>
    <div className="mt-2 truncate text-xl font-black text-gray-900 dark:text-gray-100">{value}</div>
    {hint && <div className="mt-1 text-[10px] font-bold text-gray-400 dark:text-gray-500">{hint}</div>}
  </div>
);

const DashboardActivitySummary: React.FC<Props> = ({
  summary,
  isLoading,
  error,
  isAdmin,
  locale,
}) => {
  const isArabic = locale !== 'en';
  const statusOrder = DASHBOARD_ARTICLE_STATUS_TABS.filter(status => status !== 'all') as ArticleStatus[];
  const lastActivityLabel = summary?.lastActivityAt
    ? formatIstanbulDateTime(summary.lastActivityAt, locale, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
    : (isArabic ? 'لا يوجد نشاط بعد' : 'No activity yet');

  return (
    <section
      data-dashboard-activity-summary="true"
      className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-[#3C3C3C] dark:bg-[#2A2A2A]"
    >
      <header className="flex items-start justify-between gap-3 border-b border-gray-100 px-4 py-4 dark:border-[#3C3C3C]">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-lg bg-[#d4af37]/12 p-2 text-[#a5811e] dark:bg-[#d4af37]/20 dark:text-[#f2d675]">
            <Activity size={19} />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-black text-gray-900 dark:text-gray-100">
              {isArabic ? 'ملخص النشاط' : 'Activity summary'}
            </h2>
            <p className="mt-1 text-[11px] font-bold text-gray-400 dark:text-gray-500">
              {isAdmin
                ? (isArabic ? 'نظرة شاملة لجميع المستخدمين والمقالات' : 'All users and articles at a glance')
                : (isArabic ? 'ملخص المقالات المتاحة لك' : 'Summary of articles available to you')}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-end text-[10px] font-bold text-gray-400 dark:text-gray-500">
          <div>{isArabic ? 'آخر نشاط' : 'Last activity'}</div>
          <div className="mt-1 text-gray-600 dark:text-gray-300">{lastActivityLabel}</div>
        </div>
      </header>

      {isLoading && !summary ? (
        <div className="p-6 text-center text-sm font-bold text-gray-400 dark:text-gray-500">
          {isArabic ? 'جار تجهيز الإحصاءات...' : 'Preparing statistics...'}
        </div>
      ) : summary ? (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2">
            <SummaryMetric
              icon={<FileText size={15} />}
              label={isArabic ? 'إجمالي المقالات' : 'Total articles'}
              value={formatNumber(summary.totalArticles, locale)}
              hint={isArabic ? `${summary.articlesUpdatedLast7Days} نشطة خلال 7 أيام` : `${summary.articlesUpdatedLast7Days} active in 7 days`}
            />
            <SummaryMetric
              icon={<Clock3 size={15} />}
              label={isArabic ? 'إجمالي وقت التحرير' : 'Total editing time'}
              value={formatDuration(summary.totalTimeSeconds, isArabic)}
              hint={isArabic ? `المتوسط ${formatDuration(summary.averageTimeSeconds, true)} للمقال` : `Average ${formatDuration(summary.averageTimeSeconds, false)} per article`}
            />
            <SummaryMetric
              icon={<Gauge size={15} />}
              label={isArabic ? 'إجمالي الكلمات' : 'Total words'}
              value={formatNumber(summary.totalWords, locale)}
            />
            <SummaryMetric
              icon={<Save size={15} />}
              label={isArabic ? 'عمليات الحفظ' : 'Save operations'}
              value={formatNumber(summary.totalSaves, locale)}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-black text-gray-700 dark:text-gray-200">
                {isArabic ? 'توزيع حالات المقالات' : 'Article status distribution'}
              </h3>
              <span className="text-[10px] font-bold text-gray-400">
                {isArabic ? 'المقالات النشطة خارج السلة' : 'Active articles outside trash'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 lg:grid-cols-2 xl:grid-cols-5">
              {statusOrder.map(status => {
                const count = summary.statusCounts[status] || 0;
                const percentage = summary.totalArticles > 0 ? Math.round((count / summary.totalArticles) * 100) : 0;
                return (
                  <div key={status} className={`rounded-lg p-2.5 ${STATUS_STYLES[status]}`}>
                    <div className="flex items-center justify-between gap-2">
                      {STATUS_ICONS[status]}
                      <span className="text-[10px] font-black opacity-70">{percentage}%</span>
                    </div>
                    <div className="mt-2 text-lg font-black">{formatNumber(count, locale)}</div>
                    <div className="mt-0.5 text-[10px] font-black">{getArticleStatusLabel(status, locale)}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {isAdmin && (
            <>
              <div className="grid grid-cols-2 gap-2 border-y border-gray-100 py-3 text-center dark:border-[#3C3C3C]">
                <div>
                  <div className="flex items-center justify-center gap-1.5 text-[10px] font-black text-gray-400">
                    <Users size={13} />
                    {isArabic ? 'المستخدمون' : 'Users'}
                  </div>
                  <div className="mt-1 text-sm font-black text-gray-800 dark:text-gray-100">
                    {summary.totalUsers} <span className="text-[10px] text-gray-400">· {summary.enabledUsers} {isArabic ? 'مفعّل' : 'enabled'}</span>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-center gap-1.5 text-[10px] font-black text-gray-400">
                    <History size={13} />
                    {isArabic ? 'مستخدمون لديهم مقالات' : 'Contributors'}
                  </div>
                  <div className="mt-1 text-sm font-black text-gray-800 dark:text-gray-100">
                    {summary.contributorUsers}
                    {summary.unassignedArticles > 0 && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-300"> · {summary.unassignedArticles} {isArabic ? 'غير مسند' : 'unassigned'}</span>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-black text-gray-700 dark:text-gray-200">
                    {isArabic ? 'نشاط المستخدمين' : 'User activity'}
                  </h3>
                  <span className="text-[10px] font-bold text-gray-400">
                    {isArabic ? 'المقالات والوقت الإجمالي لكل مستخدم' : 'Articles and total time per user'}
                  </span>
                </div>
                <div className="max-h-80 overflow-auto rounded-lg border border-gray-100 dark:border-[#3C3C3C]">
                  <table className="w-full min-w-[520px] text-start text-[11px]">
                    <thead className="sticky top-0 bg-gray-50 text-gray-500 dark:bg-[#222] dark:text-gray-400">
                      <tr>
                        <th className="px-3 py-2 font-black">{isArabic ? 'المستخدم' : 'User'}</th>
                        <th className="px-2 py-2 text-center font-black">{isArabic ? 'المقالات' : 'Articles'}</th>
                        <th className="px-2 py-2 text-center font-black">{isArabic ? 'الوقت' : 'Time'}</th>
                        <th className="px-2 py-2 text-center font-black">{isArabic ? 'الكلمات' : 'Words'}</th>
                        <th className="px-3 py-2 font-black">{isArabic ? 'آخر نشاط' : 'Last activity'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-[#3C3C3C]">
                      {summary.users.map(user => (
                        <tr key={user.id} className="text-gray-600 dark:text-gray-300">
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <span className={`h-2 w-2 shrink-0 rounded-full ${user.isActive ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                              <div className="min-w-0">
                                <div className="max-w-44 truncate font-black text-gray-800 dark:text-gray-100">
                                  {user.fullName || user.email || (isArabic ? 'مستخدم غير معروف' : 'Unknown user')}
                                </div>
                                <div className="max-w-44 truncate text-[9px] text-gray-400">
                                  {user.email || user.role}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-2 py-2.5 text-center font-black">{formatNumber(user.articleCount, locale)}</td>
                          <td className="px-2 py-2.5 text-center font-black">{formatDuration(user.totalTimeSeconds, isArabic)}</td>
                          <td className="px-2 py-2.5 text-center font-black">{formatNumber(user.totalWords, locale)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-[10px] font-bold text-gray-400">
                            {user.lastActivityAt
                              ? formatIstanbulDateTime(user.lastActivityAt, locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                              : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}

      {error && (
        <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-[11px] font-bold text-red-600 dark:border-red-900/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}
    </section>
  );
};

export default DashboardActivitySummary;
