import React, { useCallback, useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Save,
  Trash2,
} from 'lucide-react';
import type { CrawlerExternalProvider } from '../constants/crawlerProviders';
import {
  clearCrawlerProviderSecret,
  loadCrawlerProviderSecrets,
  saveAndEnableCrawlerProviderSecret,
  saveCrawlerUsagePolicy,
  setCrawlerProviderSecretEnabled,
  type CrawlerProviderSecretStatus,
  type CrawlerProviderSecretsResponse,
  type CrawlerUsagePolicy,
} from '../utils/adminCrawlerProviderSecrets';

const PROVIDERS: Array<{
  id: CrawlerExternalProvider;
  title: string;
  description: string;
  environmentVariable: string;
}> = [
  {
    id: 'firecrawl',
    title: 'Firecrawl API',
    description:
      'يُستخدم لبحث المنافسين وسحب محتواهم، وكذلك لاستخراج HTML بعد تنفيذ JavaScript في زحف مواقع العملاء. في الوضع التلقائي لا يُستهلك لزحف العملاء إلا عندما تكون نتيجة الزاحف المحلي ناقصة أو يفشل الاتصال المباشر.',
    environmentVariable: 'FIRECRAWL_API_KEY',
  },
  {
    id: 'browserless',
    title: 'Browserless API',
    description:
      'متصفح سحابي فعلي للمواقع الديناميكية والصعبة. يُستخدم بعد Firecrawl في الوضع التلقائي، أو مباشرة عند اختياره لعملية الزحف.',
    environmentVariable: 'BROWSERLESS_API_KEY',
  },
];

const emptyStatus = (
  provider: CrawlerExternalProvider,
): CrawlerProviderSecretStatus => ({
  provider,
  configured: false,
  enabled: false,
  keySuffix: null,
  updatedAt: null,
  fallbackConfigured: false,
  effectiveConfigured: false,
  activeSource: 'hostinger',
});

const DEFAULT_USAGE_POLICY: CrawlerUsagePolicy = {
  externalReuseDays: 14,
  maxExternalRequestsPerRun: 100,
  firecrawlMonthlyRequestLimit: 500,
  browserlessMonthlyRequestLimit: 500,
};

const AdminCrawlerProviderSecretsSettings: React.FC = () => {
  const [overview, setOverview] =
    useState<CrawlerProviderSecretsResponse | null>(null);
  const [inputs, setInputs] = useState<Record<CrawlerExternalProvider, string>>({
    firecrawl: '',
    browserless: '',
  });
  const [visible, setVisible] = useState<Record<CrawlerExternalProvider, boolean>>({
    firecrawl: false,
    browserless: false,
  });
  const [busyProvider, setBusyProvider] =
    useState<CrawlerExternalProvider | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [usagePolicy, setUsagePolicy] =
    useState<CrawlerUsagePolicy>(DEFAULT_USAGE_POLICY);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const value = await loadCrawlerProviderSecrets();
      setOverview(value);
      setUsagePolicy(value.usagePolicy || DEFAULT_USAGE_POLICY);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'تعذر تحميل حالة مفاتيح خدمات الزحف.',
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runMutation = async (
    provider: CrawlerExternalProvider,
    mutation: () => Promise<CrawlerProviderSecretsResponse>,
    successMessage: string,
  ) => {
    setBusyProvider(provider);
    setError('');
    setMessage('');
    try {
      setOverview(await mutation());
      setInputs(current => ({ ...current, [provider]: '' }));
      setVisible(current => ({ ...current, [provider]: false }));
      setMessage(successMessage);
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : 'تعذر تحديث مفتاح خدمة الزحف.',
      );
    } finally {
      setBusyProvider(null);
    }
  };

  const saveProvider = (provider: CrawlerExternalProvider) => {
    const apiKey = inputs[provider].trim();
    if (!apiKey) {
      setError('أدخل مفتاح API أولًا.');
      return;
    }
    void runMutation(
      provider,
      () => saveAndEnableCrawlerProviderSecret(provider, apiKey),
      'تم تشفير المفتاح وحفظه وتفعيل الخدمة.',
    );
  };

  const toggleProvider = (
    provider: CrawlerExternalProvider,
    enabled: boolean,
  ) => {
    void runMutation(
      provider,
      () => setCrawlerProviderSecretEnabled(provider, enabled),
      enabled
        ? 'تم تفعيل المفتاح الإداري.'
        : 'تم تعطيل المفتاح الإداري، وسيُستخدم مفتاح الخادم الاحتياطي إن وُجد.',
    );
  };

  const clearProvider = (provider: CrawlerExternalProvider) => {
    if (!window.confirm('هل تريد حذف المفتاح الإداري المشفّر؟')) return;
    void runMutation(
      provider,
      () => clearCrawlerProviderSecret(provider),
      'تم حذف المفتاح الإداري.',
    );
  };

  const saveUsagePolicy = async () => {
    setIsSavingPolicy(true);
    setError('');
    setMessage('');
    try {
      const value = await saveCrawlerUsagePolicy(usagePolicy);
      setOverview(value);
      setUsagePolicy(value.usagePolicy || DEFAULT_USAGE_POLICY);
      setMessage('تم حفظ سياسة إعادة الاستخدام والحدود الصارمة للطلبات الخارجية.');
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : 'تعذر حفظ سياسة استخدام خدمات الزحف.',
      );
    } finally {
      setIsSavingPolicy(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-24 items-center justify-center gap-2 text-sm font-bold text-gray-500 dark:text-gray-300">
        <LoaderCircle size={18} className="animate-spin" />
        <span>جارٍ تحميل حالة خدمات الزحف...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border-r-4 border-[#d4af37] bg-[#d4af37]/10 px-3 py-3 text-xs font-semibold leading-6 text-gray-700 dark:text-gray-200">
        المفاتيح لا تُعاد إلى المتصفح بعد حفظها؛ يظهر آخر أربعة أحرف فقط.
        مفتاح Firecrawl هنا يفعّل بحث المنافسين وسحب محتواهم لكل المستخدمين، والزاحف المحلي يبقى متاحًا دائمًا لمواقع العملاء.
      </div>

      {(!overview?.schemaAvailable || !overview?.encryptionConfigured) && (
        <div className="border-r-4 border-amber-500 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          {!overview?.schemaAvailable
            ? 'طبّق ترحيل مفاتيح خدمات الزحف قبل الحفظ.'
            : 'تعذر تهيئة التشفير الخادمي. تأكد من أن اتصال Supabase الخادمي يعمل ثم أعد تشغيل التطبيق.'}
        </div>
      )}
      {error && (
        <div className="text-sm font-bold text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {message && (
        <div className="text-sm font-bold text-green-700 dark:text-green-300">
          {message}
        </div>
      )}

      {PROVIDERS.map((definition, index) => {
        const status =
          overview?.providers[definition.id] || emptyStatus(definition.id);
        const isBusy = busyProvider === definition.id;
        const canStore = Boolean(
          overview?.schemaAvailable && overview?.encryptionConfigured,
        );
        return (
          <div
            key={definition.id}
            className={
              index === 0
                ? 'pb-4'
                : 'border-t border-gray-200 pt-4 dark:border-[#3C3C3C]'
            }
          >
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-black text-gray-800 dark:text-gray-100">
                  <KeyRound size={17} className="shrink-0 text-[#b8922e]" />
                  <span>{definition.title}</span>
                </div>
                <p className="mt-1 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
                  {definition.description}
                </p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-bold text-gray-500 dark:text-gray-300">
                  <span>
                    {status.configured
                      ? `المفتاح الإداري: ••••${status.keySuffix}`
                      : 'لا يوجد مفتاح إداري محفوظ'}
                  </span>
                  <span>
                    {definition.environmentVariable}:{' '}
                    {status.fallbackConfigured ? 'موجود' : 'غير موجود'}
                  </span>
                  <span
                    className={
                      status.effectiveConfigured
                        ? 'text-green-700 dark:text-green-300'
                        : 'text-red-700 dark:text-red-300'
                    }
                  >
                    المصدر النشط:{' '}
                    {status.activeSource === 'admin' ? 'إعدادات المسؤول' : 'الخادم'}
                  </span>
                </div>
              </div>
              <label className="flex min-h-10 shrink-0 items-center gap-3 text-sm font-bold text-gray-700 dark:text-gray-200">
                <span>{status.enabled ? 'مفعّل' : 'معطّل'}</span>
                <input
                  type="checkbox"
                  checked={status.enabled}
                  disabled={
                    !status.configured
                    || isBusy
                    || (!status.enabled && !canStore)
                  }
                  onChange={event =>
                    toggleProvider(definition.id, event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-[#d4af37] focus:ring-[#d4af37] disabled:opacity-50"
                />
              </label>
            </div>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <input
                  type={visible[definition.id] ? 'text' : 'password'}
                  value={inputs[definition.id]}
                  onChange={event =>
                    setInputs(current => ({
                      ...current,
                      [definition.id]: event.target.value,
                    }))}
                  placeholder={`أدخل مفتاح ${definition.title}`}
                  autoComplete="new-password"
                  spellCheck={false}
                  dir="ltr"
                  disabled={!canStore || isBusy}
                  className="w-full rounded-md border border-gray-300 bg-gray-50 py-2 pl-10 pr-3 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
                />
                <button
                  type="button"
                  onClick={() =>
                    setVisible(current => ({
                      ...current,
                      [definition.id]: !current[definition.id],
                    }))}
                  disabled={!inputs[definition.id] || isBusy}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700 disabled:opacity-40 dark:hover:text-gray-100"
                  title={visible[definition.id] ? 'إخفاء المفتاح' : 'إظهار المفتاح'}
                >
                  {visible[definition.id]
                    ? <EyeOff size={17} />
                    : <Eye size={17} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => saveProvider(definition.id)}
                disabled={!canStore || isBusy || !inputs[definition.id].trim()}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e] disabled:opacity-50"
              >
                {isBusy
                  ? <LoaderCircle size={16} className="animate-spin" />
                  : <Save size={16} />}
                <span>حفظ وتفعيل</span>
              </button>
              <button
                type="button"
                onClick={() => clearProvider(definition.id)}
                disabled={!status.configured || isBusy}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/30"
              >
                <Trash2 size={16} />
                <span>حذف</span>
              </button>
            </div>
          </div>
        );
      })}

      <div className="border-t border-gray-200 pt-4 dark:border-[#3C3C3C]">
        <div className="text-sm font-black text-gray-800 dark:text-gray-100">
          سياسة منع تكرار الطلبات الخارجية
        </div>
        <p className="mt-1 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
          يُعاد استخدام الصفحة وشبكة روابطها إذا كان آخر زحف ناجح ضمن مدة الحداثة.
          وتُطبّق الحدود التالية داخل قاعدة البيانات قبل إرسال أي طلب مدفوع.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {([
            ['externalReuseDays', 'حداثة البيانات (يوم)', 1, 90],
            ['maxExternalRequestsPerRun', 'حد الطلبات لكل زحف', 1, 2000],
            ['firecrawlMonthlyRequestLimit', 'حد Firecrawl الشهري', 1, 1000000],
            ['browserlessMonthlyRequestLimit', 'حد Browserless الشهري', 1, 1000000],
          ] as const).map(([key, label, minimum, maximum]) => (
            <label key={key} className="block">
              <span className="mb-1 block text-xs font-bold text-gray-600 dark:text-gray-300">
                {label}
              </span>
              <input
                type="number"
                min={minimum}
                max={maximum}
                value={usagePolicy[key]}
                disabled={isSavingPolicy}
                onChange={event => setUsagePolicy(current => ({
                  ...current,
                  [key]: Math.max(
                    minimum,
                    Math.min(maximum, Number(event.target.value) || minimum),
                  ),
                }))}
                className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
              />
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs font-bold text-gray-500 dark:text-gray-300">
          <span>
            Firecrawl هذا الشهر:{' '}
            {(overview?.monthlyUsage?.firecrawl?.used || 0).toLocaleString('ar')}
            {' / '}
            {usagePolicy.firecrawlMonthlyRequestLimit.toLocaleString('ar')}
          </span>
          <span>
            Browserless هذا الشهر:{' '}
            {(overview?.monthlyUsage?.browserless?.used || 0).toLocaleString('ar')}
            {' / '}
            {usagePolicy.browserlessMonthlyRequestLimit.toLocaleString('ar')}
          </span>
          <button
            type="button"
            onClick={() => void saveUsagePolicy()}
            disabled={isSavingPolicy}
            className="mr-auto inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e] disabled:opacity-50"
          >
            {isSavingPolicy
              ? <LoaderCircle size={16} className="animate-spin" />
              : <Save size={16} />}
            <span>حفظ سياسة الاستخدام</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default AdminCrawlerProviderSecretsSettings;
