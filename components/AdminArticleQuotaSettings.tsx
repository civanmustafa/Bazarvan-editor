import AppSelect from './AppSelect';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import {
  loadAdminArticleQuota,
  saveGlobalArticleQuota,
  saveUserArticleQuota,
  type ArticleQuotaMode,
  type ArticleQuotaResponse,
} from '../utils/articleQuota.ts';

type Props = {
  userId?: string;
};

const inputClass = 'w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100';

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

const AdminArticleQuotaSettings: React.FC<Props> = ({ userId }) => {
  const [overview, setOverview] = useState<ArticleQuotaResponse | null>(null);
  const [globalLimit, setGlobalLimit] = useState('');
  const [mode, setMode] = useState<ArticleQuotaMode>('inherit');
  const [customLimit, setCustomLimit] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const applyOverview = useCallback((value: ArticleQuotaResponse) => {
    setOverview(value);
    setGlobalLimit(value.globalDefaultMonthlyLimit === null ? '' : String(value.globalDefaultMonthlyLimit));
    if (value.status) {
      setMode(value.status.mode);
      setCustomLimit(value.status.customMonthlyLimit === null ? '' : String(value.status.customMonthlyLimit));
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      applyOverview(await loadAdminArticleQuota(userId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل حصة المقالات.');
    } finally {
      setLoading(false);
    }
  }, [applyOverview, userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveGlobal = async () => {
    const normalized = globalLimit.trim();
    const value = normalized === '' ? null : Number(normalized);
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1_000_000)) {
      setError('أدخل عدداً صحيحاً بين 0 و1,000,000، أو اتركه فارغاً لعدم التحديد.');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      applyOverview(await saveGlobalArticleQuota(value));
      setMessage('تم حفظ الحصة الشهرية الافتراضية.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'تعذر حفظ الحصة الافتراضية.');
    } finally {
      setSaving(false);
    }
  };

  const saveUser = async () => {
    if (!userId) return;
    const value = mode === 'custom' ? Number(customLimit) : null;
    if (mode === 'custom' && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000_000)) {
      setError('أدخل حصة مخصصة صحيحة بين 1 و1,000,000.');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      applyOverview(await saveUserArticleQuota({ userId, mode, monthlyLimit: value }));
      setMessage('تم حفظ حصة المستخدم الشهرية.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'تعذر حفظ حصة المستخدم.');
    } finally {
      setSaving(false);
    }
  };

  const status = overview?.status || null;
  const progress = useMemo(() => {
    if (!status || status.effectiveMonthlyLimit === null || status.effectiveMonthlyLimit <= 0) return 0;
    return Math.min(100, Math.round((status.used / status.effectiveMonthlyLimit) * 100));
  }, [status]);

  if (loading && !overview) {
    return <div className="text-sm font-semibold text-gray-500">جار تحميل حصة المقالات...</div>;
  }

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-black text-gray-900 dark:text-gray-100">
            {userId ? 'حصة المقالات الشهرية للمستخدم' : 'الحصة الشهرية الافتراضية للمقالات'}
          </h3>
          <p className="mt-1 text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">
            تُحسب المقالة مرة واحدة عند إنشائها أول مرة. لا تُحسب التعديلات أو الحفظ التلقائي، ولا يعيد الحذف الحصة.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading || saving} className="inline-flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-xs font-black text-gray-600 disabled:opacity-60 dark:border-[#3C3C3C] dark:text-gray-300">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          تحديث
        </button>
      </div>

      {overview && !overview.schemaAvailable && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-800">ترحيل حصة المقالات غير مطبق بعد.</div>
      )}
      {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">{error}</div>}
      {message && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-700">{message}</div>}

      {!userId ? (
        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <label className="space-y-1">
            <span className="text-xs font-black text-gray-600 dark:text-gray-300">عدد المقالات لكل مستخدم في الشهر</span>
            <input type="number" min="0" max="1000000" value={globalLimit} onChange={event => setGlobalLimit(event.target.value)} placeholder="فارغ = غير محدود" className={inputClass} disabled={saving || !overview?.schemaAvailable} />
            <span className="block text-[11px] font-semibold text-gray-400">القيمة 0 تمنع الإنشاء. المسؤولون غير محدودين عند الوراثة، ويمكن تخصيصهم من صفحة المستخدم.</span>
          </label>
          <button type="button" onClick={() => void saveGlobal()} disabled={saving || !overview?.schemaAvailable} className="inline-flex items-center justify-center gap-2 rounded-md bg-[#d4af37] px-4 py-2 text-sm font-black text-white disabled:opacity-60">
            <Save size={15} />
            حفظ الافتراضي
          </button>
        </div>
      ) : status ? (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-md bg-gray-50 p-3 dark:bg-[#1F1F1F]"><div className="text-xs font-bold text-gray-400">المقالات المستخدمة</div><div className="mt-1 text-xl font-black text-gray-900 dark:text-gray-100">{status.used}</div></div>
            <div className="rounded-md bg-gray-50 p-3 dark:bg-[#1F1F1F]"><div className="text-xs font-bold text-gray-400">الحد الفعلي</div><div className="mt-1 text-xl font-black text-gray-900 dark:text-gray-100">{status.effectiveMonthlyLimit === null ? 'غير محدود' : status.effectiveMonthlyLimit}</div></div>
            <div className="rounded-md bg-gray-50 p-3 dark:bg-[#1F1F1F]"><div className="text-xs font-bold text-gray-400">المتبقي</div><div className="mt-1 text-xl font-black text-gray-900 dark:text-gray-100">{status.remaining === null ? '∞' : status.remaining}</div></div>
            <div className="rounded-md bg-gray-50 p-3 dark:bg-[#1F1F1F]"><div className="text-xs font-bold text-gray-400">إعادة الضبط</div><div className="mt-1 text-sm font-black text-gray-900 dark:text-gray-100">{formatReset(status.resetAt)}</div></div>
          </div>
          {status.effectiveMonthlyLimit !== null && status.effectiveMonthlyLimit > 0 && (
            <div className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-[#1F1F1F]"><div className={`h-full ${progress >= 100 ? 'bg-red-500' : progress >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${progress}%` }} /></div>
          )}
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <label className="space-y-1">
              <span className="text-xs font-black text-gray-600 dark:text-gray-300">سياسة المستخدم</span>
              <AppSelect value={mode} onChange={event => setMode(event.target.value as ArticleQuotaMode)} className={inputClass} disabled={saving}>
                <option value="inherit">يرث الحصة الافتراضية</option>
                <option value="custom">حد مخصص</option>
                <option value="unlimited">غير محدود</option>
                <option value="blocked">منع إنشاء مقالات جديدة</option>
              </AppSelect>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-black text-gray-600 dark:text-gray-300">الحد المخصص</span>
              <input type="number" min="1" max="1000000" value={customLimit} onChange={event => setCustomLimit(event.target.value)} className={inputClass} disabled={saving || mode !== 'custom'} />
            </label>
            <button type="button" onClick={() => void saveUser()} disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-md bg-[#d4af37] px-4 py-2 text-sm font-black text-white disabled:opacity-60">
              <Save size={15} />
              حفظ الحصة
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
};

export default AdminArticleQuotaSettings;
