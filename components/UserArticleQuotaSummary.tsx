import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { loadUserArticleQuota, type ArticleQuotaResponse } from '../utils/articleQuota.ts';

const formatReset = (value?: string): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ar', {
    timeZone: 'Europe/Istanbul',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const UserArticleQuotaSummary: React.FC = () => {
  const [overview, setOverview] = useState<ArticleQuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setOverview(await loadUserArticleQuota());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل حصة المقالات.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const status = overview?.status || null;
  const progress = useMemo(() => {
    if (!status || status.effectiveMonthlyLimit === null || status.effectiveMonthlyLimit <= 0) return 0;
    return Math.min(100, Math.round((status.used / status.effectiveMonthlyLimit) * 100));
  }, [status]);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold leading-6 text-gray-500 dark:text-gray-400">يمكن للمسؤول فقط تغيير الحصة. تُحتسب المقالة عند إنشائها أول مرة ولا تُحتسب عمليات الحفظ اللاحقة.</p>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-md border border-gray-200 p-2 text-gray-500 disabled:opacity-60 dark:border-[#3C3C3C] dark:text-gray-300" aria-label="تحديث حصة المقالات"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
      </div>
      {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">{error}</div>}
      {loading && !status && <div className="text-sm font-semibold text-gray-500">جار تحميل حصة المقالات...</div>}
      {status && (
        <>
          <div className="grid grid-cols-2 gap-3 text-center md:grid-cols-4">
            <div className="rounded-md bg-gray-50 p-3 dark:bg-[#1F1F1F]"><div className="text-xs font-bold text-gray-400">المقالات المستخدمة</div><div className="mt-1 text-xl font-black">{status.used}</div></div>
            <div className="rounded-md bg-gray-50 p-3 dark:bg-[#1F1F1F]"><div className="text-xs font-bold text-gray-400">الحد</div><div className="mt-1 text-xl font-black">{status.effectiveMonthlyLimit === null ? '∞' : status.effectiveMonthlyLimit}</div></div>
            <div className="rounded-md bg-gray-50 p-3 dark:bg-[#1F1F1F]"><div className="text-xs font-bold text-gray-400">المتبقي</div><div className="mt-1 text-xl font-black">{status.remaining === null ? '∞' : status.remaining}</div></div>
            <div className="rounded-md bg-gray-50 p-3 dark:bg-[#1F1F1F]"><div className="text-xs font-bold text-gray-400">إعادة الضبط</div><div className="mt-1 text-sm font-black">{formatReset(status.resetAt)}</div></div>
          </div>
          {status.effectiveMonthlyLimit !== null && status.effectiveMonthlyLimit > 0 && (
            <div className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-[#1F1F1F]"><div className={`h-full ${progress >= 100 ? 'bg-red-500' : progress >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${progress}%` }} /></div>
          )}
          {!status.canCreate && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-black text-red-700">تم استهلاك الحصة الشهرية. يمكنك متابعة تعديل المقالات الحالية، لكن لا يمكن إنشاء مقالة جديدة حتى الشهر القادم أو تعديل المسؤول للحصة.</div>}
        </>
      )}
    </div>
  );
};

export default UserArticleQuotaSummary;
