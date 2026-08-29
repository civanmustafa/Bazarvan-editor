import React from 'react';
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  XCircle,
} from 'lucide-react';
import type {
  CrawlerProviderReportEvent,
} from '../utils/crawlerProviderReports';
import { formatIstanbulDateTime } from '../utils/dateTime';

type CrawlerProviderUsageReportsTableProps = {
  events: CrawlerProviderReportEvent[];
  isLoading: boolean;
  error: string;
  schemaAvailable: boolean;
  locale: 'ar' | 'en';
};

const providerLabel = (
  provider: CrawlerProviderReportEvent['provider']
    | CrawlerProviderReportEvent['requestedProvider'],
  locale: 'ar' | 'en',
): string => {
  if (provider === 'auto') return locale === 'ar' ? 'تلقائي' : 'Auto';
  if (provider === 'local') return locale === 'ar' ? 'محلي' : 'Local';
  return provider === 'firecrawl' ? 'Firecrawl' : 'Browserless';
};

const sourceLabel = (
  event: CrawlerProviderReportEvent,
  locale: 'ar' | 'en',
): string => {
  if (event.provider === 'local') return locale === 'ar' ? 'بدون مفتاح' : 'No key';
  const sourceLabels: Record<string, string> = {
    user: locale === 'ar' ? 'مفتاح المستخدم' : 'Personal key',
    assigned_user: locale === 'ar' ? 'مشترك لهذا المستخدم' : 'Shared for user',
    assigned_all: locale === 'ar' ? 'مشترك للجميع' : 'Shared for all',
    resume: locale === 'ar' ? 'مفتاح مهمة خاص' : 'Task credential',
    admin: locale === 'ar' ? 'مفتاح إداري' : 'Admin credential',
    hostinger: locale === 'ar' ? 'سجل خادم قديم' : 'Legacy server record',
  };
  const source = sourceLabels[event.credentialSource || '']
    || (locale === 'ar' ? 'لم يُحسم' : 'Unresolved');
  return event.keySuffix ? `${source} · ••••${event.keySuffix}` : source;
};

const durationLabel = (durationMs: number, locale: 'ar' | 'en'): string => {
  if (durationMs < 1_000) return `${durationMs} ms`;
  const seconds = durationMs / 1_000;
  return `${seconds.toLocaleString(locale, { maximumFractionDigits: 2 })} ${locale === 'ar' ? 'ث' : 's'}`;
};

const fallbackLabel = (
  reason: string | null,
  locale: 'ar' | 'en',
): string => {
  if (!reason) return '-';
  if (reason === 'local_rendered_content_sparse') {
    return locale === 'ar'
      ? 'المحتوى المحلي ناقص'
      : 'Sparse local content';
  }
  if (reason === 'local_crawl_failed') {
    return locale === 'ar' ? 'فشل الزحف المحلي' : 'Local crawl failed';
  }
  return reason;
};

const CrawlerProviderUsageReportsTable: React.FC<
  CrawlerProviderUsageReportsTableProps
> = ({
  events,
  isLoading,
  error,
  schemaAvailable,
  locale,
}) => {
  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm font-bold text-gray-400">
        {locale === 'ar'
          ? 'جارٍ تحميل تقارير استخدام خدمات الزحف...'
          : 'Loading crawler provider usage reports...'}
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
        {error}
      </div>
    );
  }
  if (!schemaAvailable) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
        {locale === 'ar'
          ? 'طبّق ترحيل تقارير استخدام خدمات الزحف لبدء تسجيل الاستدعاءات.'
          : 'Apply the crawler usage reports migration to start recording calls.'}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <table className="w-full min-w-[2200px] text-start text-sm">
        <thead className="text-xs uppercase text-gray-400">
          <tr className="border-b border-gray-100 dark:border-[#3C3C3C]">
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'الوقت' : 'Time'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'العميل والصفحة' : 'Client and page'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'الوضع المطلوب' : 'Requested mode'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'المزود الفعلي' : 'Actual provider'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'مصدر المفتاح' : 'Key source'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'النتيجة' : 'Result'}</th>
            <th className="px-3 py-2 text-start">HTTP</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'المدة' : 'Duration'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'المحتوى' : 'Content'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'سبب التحويل' : 'Fallback reason'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'الخطأ' : 'Error'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'المستخدم' : 'User'}</th>
            <th className="px-3 py-2 text-start">{locale === 'ar' ? 'المهمة' : 'Job'}</th>
          </tr>
        </thead>
        <tbody>
          {events.length > 0 ? events.map(event => (
            <tr
              key={event.id}
              className="border-b border-gray-100 align-top dark:border-[#3C3C3C]"
            >
              <td className="whitespace-nowrap px-3 py-3 text-xs text-gray-500">
                {formatIstanbulDateTime(event.createdAt, locale, {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </td>
              <td className="max-w-[420px] px-3 py-3">
                <div className="font-black text-gray-800 dark:text-gray-100">
                  {event.clientName}
                </div>
                <a
                  href={event.targetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex max-w-full items-center gap-1 font-bold text-[#8a6f1d] hover:underline dark:text-[#f2d675]"
                  title={event.targetUrl}
                >
                  <ExternalLink size={12} className="shrink-0" />
                  <span className="truncate">{event.pageTitle || event.targetUrl}</span>
                </a>
                {event.finalUrl && event.finalUrl !== event.targetUrl ? (
                  <div className="mt-1 truncate text-[10px] text-gray-400" dir="ltr" title={event.finalUrl}>
                    → {event.finalUrl}
                  </div>
                ) : null}
              </td>
              <td className="px-3 py-3 font-bold text-gray-600 dark:text-gray-300">
                {providerLabel(event.requestedProvider, locale)}
              </td>
              <td className="px-3 py-3 font-black text-gray-800 dark:text-gray-100">
                {providerLabel(event.provider, locale)}
              </td>
              <td className="whitespace-nowrap px-3 py-3">
                <span className="inline-flex items-center gap-1 font-bold text-gray-600 dark:text-gray-300">
                  {event.provider !== 'local' ? <KeyRound size={13} /> : null}
                  {sourceLabel(event, locale)}
                </span>
              </td>
              <td className="px-3 py-3">
                <span className={`inline-flex items-center gap-1 font-black ${
                  event.status === 'completed'
                    ? 'text-emerald-600 dark:text-emerald-300'
                    : 'text-red-600 dark:text-red-300'
                }`}>
                  {event.status === 'completed'
                    ? <CheckCircle2 size={13} />
                    : <XCircle size={13} />}
                  {event.status === 'completed'
                    ? locale === 'ar' ? 'نجح' : 'Completed'
                    : locale === 'ar' ? 'فشل' : 'Failed'}
                </span>
              </td>
              <td className="px-3 py-3 font-mono text-xs text-gray-500">
                {event.httpStatus ?? '-'}
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-gray-500">
                {durationLabel(event.durationMs, locale)}
              </td>
              <td
                className="whitespace-nowrap px-3 py-3 text-gray-500"
                title={event.responseContentType || ''}
              >
                <div>{locale === 'ar' ? 'كلمات' : 'Words'}: {event.wordCount ?? '-'}</div>
                <div>{locale === 'ar' ? 'روابط' : 'Links'}: {event.internalLinkCount ?? '-'}</div>
              </td>
              <td className="max-w-[260px] break-words px-3 py-3 text-gray-500">
                {fallbackLabel(event.fallbackReason, locale)}
              </td>
              <td
                className="max-w-[360px] break-words px-3 py-3 text-red-600 dark:text-red-300"
                title={event.errorMessage || event.errorCode || ''}
              >
                {event.errorMessage || event.errorCode || '-'}
                {event.status === 'failed' && event.retryable !== null ? (
                  <div className="mt-1 text-[10px] font-bold text-gray-400">
                    {event.retryable
                      ? locale === 'ar' ? 'قابل لإعادة المحاولة' : 'Retryable'
                      : locale === 'ar' ? 'غير قابل لإعادة المحاولة' : 'Not retryable'}
                  </div>
                ) : null}
              </td>
              <td className="max-w-[220px] break-words px-3 py-3 text-gray-600 dark:text-gray-300">
                {event.requestedByName || '-'}
              </td>
              <td className="max-w-[220px] px-3 py-3 font-mono text-[10px] text-gray-400" dir="ltr">
                <div title={event.crawlJobId || ''}>{event.crawlJobId || '-'}</div>
                <div className="mt-1">attempt {event.jobAttempt}</div>
              </td>
            </tr>
          )) : (
            <tr>
              <td colSpan={13} className="px-3 py-8 text-center text-gray-500">
                {locale === 'ar'
                  ? 'لا توجد محاولات لاستخدام خدمات الزحف في هذا اليوم.'
                  : 'No crawler provider attempts for this day.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

export default CrawlerProviderUsageReportsTable;
