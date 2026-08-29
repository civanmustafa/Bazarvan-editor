import React, { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw, Save } from 'lucide-react';
import {
  loadCrawlerUsagePolicy,
  saveCrawlerUsagePolicy,
  type CrawlerUsagePolicy,
  type CrawlerUsagePolicyResponse,
} from '../utils/adminCrawlerUsagePolicy';

const DEFAULT_USAGE_POLICY: CrawlerUsagePolicy = {
  externalReuseDays: 14,
  maxExternalRequestsPerRun: 100,
  firecrawlMonthlyRequestLimit: 500,
  browserlessMonthlyRequestLimit: 500,
};

const AdminCrawlerUsagePolicySettings: React.FC = () => {
  const [overview, setOverview] = useState<CrawlerUsagePolicyResponse | null>(null);
  const [usagePolicy, setUsagePolicy] = useState<CrawlerUsagePolicy>(DEFAULT_USAGE_POLICY);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const applyOverview = (value: CrawlerUsagePolicyResponse) => {
    setOverview(value);
    setUsagePolicy(value.usagePolicy || DEFAULT_USAGE_POLICY);
  };

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      applyOverview(await loadCrawlerUsagePolicy());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل سياسة استخدام خدمات الزحف.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setIsSaving(true);
    setError('');
    setMessage('');
    try {
      applyOverview(await saveCrawlerUsagePolicy(usagePolicy));
      setMessage('تم حفظ سياسة إعادة الاستخدام والحدود الصارمة للطلبات الخارجية.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'تعذر حفظ سياسة استخدام خدمات الزحف.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-24 items-center justify-center gap-2 text-sm font-bold text-gray-500 dark:text-gray-300">
        <LoaderCircle size={18} className="animate-spin" />
        جاري تحميل سياسة خدمات الزحف...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-black text-gray-800 dark:text-gray-100">سياسة منع تكرار الطلبات الخارجية</div>
          <p className="mt-1 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
            يُعاد استخدام الصفحة وشبكة روابطها ضمن مدة الحداثة، وتُطبّق الحدود في قاعدة البيانات قبل إرسال أي طلب خارجي مدفوع.
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={isSaving} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-xs font-black text-gray-600 disabled:opacity-50 dark:border-[#3C3C3C] dark:text-gray-300">
          <RefreshCw size={15} /> تحديث
        </button>
      </div>

      {error && <div className="rounded-md bg-red-50 p-3 text-sm font-bold text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
      {message && <div className="rounded-md bg-green-50 p-3 text-sm font-bold text-green-700 dark:bg-green-950/30 dark:text-green-300">{message}</div>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {([
          ['externalReuseDays', 'حداثة البيانات (يوم)', 1, 90],
          ['maxExternalRequestsPerRun', 'حد الطلبات لكل زحف', 1, 2000],
          ['firecrawlMonthlyRequestLimit', 'حد Firecrawl الشهري', 1, 1000000],
          ['browserlessMonthlyRequestLimit', 'حد Browserless الشهري', 1, 1000000],
        ] as const).map(([key, label, minimum, maximum]) => (
          <label key={key} className="block">
            <span className="mb-1 block text-xs font-bold text-gray-600 dark:text-gray-300">{label}</span>
            <input
              type="number"
              min={minimum}
              max={maximum}
              value={usagePolicy[key]}
              disabled={isSaving}
              onChange={event => setUsagePolicy(current => ({
                ...current,
                [key]: Math.max(minimum, Math.min(maximum, Number(event.target.value) || minimum)),
              }))}
              className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
            />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs font-bold text-gray-500 dark:text-gray-300">
        <span>Firecrawl هذا الشهر: {(overview?.monthlyUsage?.firecrawl?.used || 0).toLocaleString('ar')} / {usagePolicy.firecrawlMonthlyRequestLimit.toLocaleString('ar')}</span>
        <span>Browserless هذا الشهر: {(overview?.monthlyUsage?.browserless?.used || 0).toLocaleString('ar')} / {usagePolicy.browserlessMonthlyRequestLimit.toLocaleString('ar')}</span>
        <button type="button" onClick={() => void save()} disabled={isSaving} className="mr-auto inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e] disabled:opacity-50">
          {isSaving ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />}
          حفظ سياسة الاستخدام
        </button>
      </div>
    </div>
  );
};

export default AdminCrawlerUsagePolicySettings;
