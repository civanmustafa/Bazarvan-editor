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
  setCrawlerProviderSecretEnabled,
  type CrawlerProviderSecretStatus,
  type CrawlerProviderSecretsResponse,
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
      'يُستخدم لاستخراج HTML بعد تنفيذ JavaScript. في الوضع التلقائي لا يُستهلك إلا عندما تكون نتيجة الزاحف المحلي ناقصة أو يفشل الاتصال المباشر.',
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
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      setOverview(await loadCrawlerProviderSecrets());
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
        الزاحف المحلي متاح دائمًا، والوضع التلقائي يستخدم الخدمات الخارجية عند الحاجة فقط.
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
    </div>
  );
};

export default AdminCrawlerProviderSecretsSettings;
