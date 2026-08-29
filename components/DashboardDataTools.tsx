import React, { useState } from 'react';
import { AlertTriangle, FileDown, Loader2, Trash2 } from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import {
  getArticleTrashInfo,
  listRemoteArticles,
  moveRemoteArticleToTrash,
  type RemoteArticleActivity,
} from '../utils/supabaseArticles';
import { formatIstanbulDateTime, getIstanbulDateKey } from '../utils/dateTime';
import { getArticleStatusLabel } from '../constants/articleStatuses';

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const formatDuration = (seconds: number, isArabic: boolean): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  return [
    hours > 0 ? `${hours} ${isArabic ? 'ساعة' : 'h'}` : '',
    minutes > 0 ? `${minutes} ${isArabic ? 'دقيقة' : 'm'}` : '',
    hours === 0 && minutes === 0 ? `${remainingSeconds} ${isArabic ? 'ثانية' : 's'}` : '',
  ].filter(Boolean).join(' ');
};

const getArticleActivityAt = (article: RemoteArticleActivity): number => Math.max(
  new Date(article.updatedAt || 0).getTime(),
  new Date(article.lastSaved || 0).getTime(),
  new Date(article.createdAt || 0).getTime(),
);

const DashboardDataTools: React.FC = () => {
  const { currentUser, currentUserId, uiLanguage, t } = useUser();
  const isArabic = uiLanguage !== 'en';
  const [isExporting, setIsExporting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadActiveArticles = async (): Promise<RemoteArticleActivity[]> => {
    const articles = await listRemoteArticles();
    return articles.filter(article => !getArticleTrashInfo(article, currentUserId));
  };

  const handleExportHtml = async () => {
    if (!currentUser || isExporting) return;
    setIsExporting(true);
    setMessage('');
    setError('');
    try {
      const exportArticles = (await loadActiveArticles())
        .sort((left, right) => getArticleActivityAt(right) - getArticleActivityAt(left));
      const totalTimeSpent = exportArticles.reduce((sum, article) => sum + article.timeSpentSeconds, 0);
      const totalWords = exportArticles.reduce((sum, article) => sum + Number(article.stats?.wordCount || 0), 0);
      const articlesHtml = exportArticles.map(article => `
        <tr>
          <td>${escapeHtml(article.title || t.untitled)}</td>
          <td>${escapeHtml(getArticleStatusLabel(article.status, t.locale))}</td>
          <td>${escapeHtml(formatDuration(article.timeSpentSeconds, isArabic))}</td>
          <td>${escapeHtml(article.stats?.wordCount ?? 0)}</td>
          <td>${escapeHtml(article.saveCount ?? 0)}</td>
          <td>${escapeHtml(article.lastSaved ? formatIstanbulDateTime(article.lastSaved, t.locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-')}</td>
        </tr>
      `).join('');
      const htmlContent = `<!DOCTYPE html>
        <html lang="${escapeHtml(uiLanguage)}" dir="${isArabic ? 'rtl' : 'ltr'}">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${escapeHtml(t.userActivityReport)}: ${escapeHtml(currentUser)}</title>
          <style>
            body{font-family:Segoe UI,Tahoma,sans-serif;line-height:1.6;color:#292929;background:#f5f5f5;margin:0;padding:24px}
            .container{max-width:1200px;margin:auto;background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
            h1,h2{color:#94731c} .meta{color:#666}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0}
            .metric{background:#faf7ed;border:1px solid #eadba8;border-radius:10px;padding:14px}.metric strong{display:block;font-size:22px}
            table{width:100%;border-collapse:collapse;margin-top:16px;text-align:${isArabic ? 'right' : 'left'}}
            th,td{padding:11px;border:1px solid #e5e5e5}th{background:#f4f4f4;color:#6f5718}tr:nth-child(even){background:#fafafa}
            @media(max-width:700px){.summary{grid-template-columns:1fr}body{padding:10px}.container{padding:15px}table{font-size:12px}}
          </style>
        </head>
        <body><div class="container">
          <h1>${escapeHtml(t.userActivityReport)}: ${escapeHtml(currentUser)}</h1>
          <p class="meta">${escapeHtml(t.reportDate)}: ${escapeHtml(formatIstanbulDateTime(new Date(), t.locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</p>
          <div class="summary">
            <div class="metric"><span>${escapeHtml(t.totalArticles)}</span><strong>${exportArticles.length}</strong></div>
            <div class="metric"><span>${escapeHtml(t.totalTimeSpent)}</span><strong>${escapeHtml(formatDuration(totalTimeSpent, isArabic))}</strong></div>
            <div class="metric"><span>${isArabic ? 'إجمالي الكلمات' : 'Total words'}</span><strong>${totalWords}</strong></div>
          </div>
          <h2>${escapeHtml(t.articlesDetails)}</h2>
          <table><thead><tr>
            <th>${escapeHtml(t.articleTitle)}</th><th>${isArabic ? 'الحالة' : 'Status'}</th><th>${escapeHtml(t.timeSpent)}</th>
            <th>${escapeHtml(t.words)}</th><th>${isArabic ? 'مرات الحفظ' : 'Saves'}</th><th>${isArabic ? 'آخر حفظ' : 'Last saved'}</th>
          </tr></thead><tbody>${articlesHtml}</tbody></table>
        </div></body></html>`;

      const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `bazarvan-articles-${getIstanbulDateKey()}.html`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setMessage(isArabic ? `تم تصدير ${exportArticles.length} مقالة إلى ملف HTML.` : `Exported ${exportArticles.length} articles to HTML.`);
    } catch (exportError) {
      console.error('Failed to export dashboard HTML:', exportError);
      setError(isArabic ? 'تعذر تجهيز ملف HTML. أعد المحاولة.' : 'Could not prepare the HTML file. Try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleConfirmClearData = async () => {
    if (!currentUserId || isClearing) return;
    setIsClearing(true);
    setMessage('');
    setError('');
    try {
      const articles = await loadActiveArticles();
      const ownedArticles = articles.filter(article => (
        article.ownerId === currentUserId || article.createdBy === currentUserId
      ));
      for (const article of ownedArticles) {
        await moveRemoteArticleToTrash(article.id);
      }
      setIsConfirmOpen(false);
      setMessage(isArabic
        ? `تم نقل ${ownedArticles.length} مقالة تابعة لك إلى السلة ويمكن استعادتها قبل انتهاء مدة الاحتفاظ.`
        : `Moved ${ownedArticles.length} of your articles to trash. They remain recoverable during retention.`);
      window.dispatchEvent(new CustomEvent('smart-editor-activity-updated'));
    } catch (clearError) {
      console.error('Failed to move user articles to trash:', clearError);
      setError(isArabic ? 'تعذر نقل المقالات إلى السلة. لم يتم حذفها نهائيًا.' : 'Could not move articles to trash. Nothing was permanently deleted.');
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <>
      <section data-dashboard-data-tools="true" className="rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
        <h2 className="text-lg font-black text-gray-800 dark:text-gray-100">
          {isArabic ? 'أدوات بيانات لوحة المقالات' : 'Article dashboard data tools'}
        </h2>
        <p className="mt-1 text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">
          {isArabic
            ? 'تصدير تقرير كامل للمقالات المتاحة لك، أو نقل مقالاتك إلى السلة من مكان واحد وآمن.'
            : 'Export a complete report of visible articles, or move your own articles to trash from one safe place.'}
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => { void handleExportHtml(); }}
            disabled={isExporting || isClearing}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-black text-gray-700 transition-colors hover:border-[#d4af37]/50 hover:bg-[#d4af37]/10 disabled:cursor-wait disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#222] dark:text-gray-200"
          >
            {isExporting ? <Loader2 size={17} className="animate-spin" /> : <FileDown size={17} />}
            <span>{isArabic ? 'تصدير تقرير HTML' : 'Export HTML report'}</span>
          </button>
          <button
            type="button"
            onClick={() => { setMessage(''); setError(''); setIsConfirmOpen(true); }}
            disabled={isExporting || isClearing}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-black text-red-600 transition-colors hover:bg-red-100 disabled:cursor-wait disabled:opacity-60 dark:border-red-900/40 dark:bg-red-500/10 dark:text-red-300"
          >
            <Trash2 size={17} />
            <span>{isArabic ? 'نقل بياناتي إلى السلة' : 'Move my data to trash'}</span>
          </button>
        </div>
        {message && <div className="mt-3 rounded-md bg-emerald-50 p-3 text-xs font-bold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{message}</div>}
        {error && <div className="mt-3 rounded-md bg-red-50 p-3 text-xs font-bold text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
      </section>

      {isConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="dashboard-data-clear-title">
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 text-start shadow-xl dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-red-100 p-2 text-red-600 dark:bg-red-500/10 dark:text-red-300"><AlertTriangle size={20} /></div>
              <div>
                <h3 id="dashboard-data-clear-title" className="text-lg font-black text-gray-900 dark:text-gray-100">
                  {isArabic ? 'نقل جميع مقالاتك إلى السلة؟' : 'Move all your articles to trash?'}
                </h3>
                <p className="mt-2 text-sm font-semibold leading-6 text-gray-500 dark:text-gray-400">
                  {isArabic
                    ? 'سيتم نقل المقالات التي تملكها أنت فقط إلى السلة. لا يشمل ذلك مقالات المستخدمين الآخرين، ويمكن الاستعادة قبل انتهاء مدة الاحتفاظ.'
                    : 'Only articles you own will be moved. Other users are unaffected, and the articles remain recoverable during retention.'}
                </p>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsConfirmOpen(false)}
                disabled={isClearing}
                className="min-h-10 rounded-lg border border-gray-200 px-4 py-2 text-sm font-black text-gray-600 disabled:opacity-60 dark:border-[#3C3C3C] dark:text-gray-300"
              >
                {t.cancel}
              </button>
              <button
                type="button"
                onClick={() => { void handleConfirmClearData(); }}
                disabled={isClearing}
                className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-black text-white hover:bg-red-500 disabled:cursor-wait disabled:opacity-60"
              >
                {isClearing && <Loader2 size={16} className="animate-spin" />}
                {isArabic ? 'نعم، انقلها إلى السلة' : 'Yes, move to trash'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default DashboardDataTools;
