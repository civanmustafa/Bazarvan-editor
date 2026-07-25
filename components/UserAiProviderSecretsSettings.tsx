import React, { useCallback, useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Save,
  Trash2,
} from 'lucide-react';
import {
  clearUserAiProviderKeys,
  loadUserAiProviderSecrets,
  saveUserAiProviderKeys,
  type UserAiProviderSecretStatus,
  type UserAiProviderSecretsResponse,
  type UserAiSecretProvider,
} from '../utils/userAiProviderSecrets';
import { notifyAiProviderCapabilitiesChanged } from '../utils/aiProviderCapabilities';

const PROVIDERS: Array<{
  id: UserAiSecretProvider;
  title: string;
  description: string;
}> = [
  {
    id: 'gemini_free',
    title: 'مفاتيح Gemini المجانية',
    description: 'تُستخدم أولًا عند اختيار Gemini المجاني. يمكنك إدخال عدة مفاتيح مفصولة بفاصلة أو فاصلة منقوطة.',
  },
  {
    id: 'gemini_paid',
    title: 'مفاتيح Gemini المدفوعة',
    description: 'تُستخدم أولًا عند اختيار Gemini Pro، ثم ينتقل النظام إلى مفاتيح الإدارة وهوستينجر عند فشلها.',
  },
  {
    id: 'openai_paid',
    title: 'مفاتيح OpenAI (ChatGPT API) المدفوعة',
    description: 'تُستخدم أولًا عند اختيار OpenAI، ثم ينتقل النظام إلى مفاتيح الإدارة وهوستينجر عند فشلها.',
  },
];

const emptyStatus = (provider: UserAiSecretProvider): UserAiProviderSecretStatus => ({
  provider,
  configured: false,
  enabled: false,
  keyCount: 0,
  keySuffixes: [],
  updatedAt: null,
});

const UserAiProviderSecretsSettings: React.FC = () => {
  const [overview, setOverview] = useState<UserAiProviderSecretsResponse | null>(null);
  const [inputs, setInputs] = useState<Record<UserAiSecretProvider, string>>({
    gemini_free: '',
    gemini_paid: '',
    openai_paid: '',
  });
  const [visible, setVisible] = useState<Record<UserAiSecretProvider, boolean>>({
    gemini_free: false,
    gemini_paid: false,
    openai_paid: false,
  });
  const [busyProvider, setBusyProvider] = useState<UserAiSecretProvider | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      setOverview(await loadUserAiProviderSecrets());
    } catch (loadError) {
      setError(loadError instanceof Error
        ? loadError.message
        : 'تعذر تحميل حالة مفاتيح الذكاء الاصطناعي الشخصية.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runMutation = async (
    provider: UserAiSecretProvider,
    mutation: () => Promise<UserAiProviderSecretsResponse>,
    successMessage: string,
  ) => {
    setBusyProvider(provider);
    setError('');
    setMessage('');
    try {
      const result = await mutation();
      setOverview(result);
      setInputs(current => ({ ...current, [provider]: '' }));
      setVisible(current => ({ ...current, [provider]: false }));
      notifyAiProviderCapabilitiesChanged();
      setMessage(successMessage);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'تعذر تحديث المفاتيح.');
    } finally {
      setBusyProvider(null);
    }
  };

  const handleSave = (provider: UserAiSecretProvider) => {
    const apiKeys = inputs[provider].trim();
    if (!apiKeys) {
      setError('أدخل مفتاحًا واحدًا على الأقل.');
      return;
    }
    void runMutation(
      provider,
      () => saveUserAiProviderKeys(provider, apiKeys),
      'تم تشفير المفاتيح وحفظها لحسابك.',
    );
  };

  const handleClear = (provider: UserAiSecretProvider) => {
    if (!window.confirm('هل تريد حذف جميع المفاتيح المحفوظة في هذه المجموعة؟')) return;
    void runMutation(
      provider,
      () => clearUserAiProviderKeys(provider),
      'تم حذف مجموعة المفاتيح من حسابك.',
    );
  };

  if (isLoading) {
    return (
      <div className="flex min-h-24 items-center justify-center gap-2 text-sm font-bold text-gray-500 dark:text-gray-300">
        <LoaderCircle size={18} className="animate-spin" />
        <span>جاري تحميل المفاتيح الشخصية...</span>
      </div>
    );
  }

  const canStore = Boolean(overview?.schemaAvailable && overview?.encryptionConfigured);

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
        هذه المفاتيح خاصة بحسابك ولا يراها المستخدمون الآخرون. يبدأ النظام بها أولًا،
        ويعرض بعد الحفظ عدد المفاتيح وآخر أربعة أحرف فقط. حفظ مجموعة جديدة يستبدل المجموعة القديمة من النوع نفسه.
        يبقى السماح باستخدام كل مزوّد خاضعًا لإعدادات المسؤول العامة.
      </p>

      {(!overview?.schemaAvailable || !overview?.encryptionConfigured) && (
        <div className="border-r-4 border-amber-500 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          {!overview?.schemaAvailable
            ? 'يجب تطبيق ترحيل مفاتيح المستخدمين الجديد على قاعدة البيانات قبل الحفظ.'
            : 'يجب إعداد AI_SETTINGS_ENCRYPTION_KEY في هوستينجر قبل حفظ المفاتيح.'}
        </div>
      )}
      {error && <div className="text-sm font-bold text-red-700 dark:text-red-300">{error}</div>}
      {message && <div className="text-sm font-bold text-green-700 dark:text-green-300">{message}</div>}

      {PROVIDERS.map((definition, index) => {
        const status = overview?.providers[definition.id] || emptyStatus(definition.id);
        const isBusy = busyProvider === definition.id;
        return (
          <div
            key={definition.id}
            className={index === 0 ? 'pb-4' : 'border-t border-gray-200 pt-4 dark:border-[#3C3C3C]'}
          >
            <div className="flex items-start gap-2">
              <KeyRound size={17} className="mt-0.5 shrink-0 text-[#b8922e]" />
              <div>
                <div className="text-sm font-black text-gray-800 dark:text-gray-100">{definition.title}</div>
                <p className="mt-1 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
                  {definition.description}
                </p>
                <div className="mt-1 flex flex-wrap gap-2 text-xs font-bold">
                  {status.keyCount > 0 ? (
                    <>
                      <span className="text-green-700 dark:text-green-300">
                        محفوظ: {status.keyCount} {status.keyCount === 1 ? 'مفتاح' : 'مفاتيح'}
                      </span>
                      {status.keySuffixes.map((suffix, suffixIndex) => (
                        <span
                          key={`${suffix}-${suffixIndex}`}
                          dir="ltr"
                          className="rounded bg-gray-100 px-2 py-0.5 text-gray-600 dark:bg-[#252525] dark:text-gray-300"
                        >
                          ••••{suffix}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className="text-gray-500 dark:text-gray-400">لا توجد مفاتيح محفوظة</span>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <input
                  type={visible[definition.id] ? 'text' : 'password'}
                  value={inputs[definition.id]}
                  onChange={event => setInputs(current => ({
                    ...current,
                    [definition.id]: event.target.value,
                  }))}
                  placeholder="ألصق مفتاحًا أو عدة مفاتيح مفصولة بفاصلة"
                  autoComplete="new-password"
                  spellCheck={false}
                  dir="ltr"
                  disabled={!canStore || isBusy}
                  className="w-full rounded-md border border-gray-300 bg-gray-50 py-2 pl-10 pr-3 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
                />
                <button
                  type="button"
                  onClick={() => setVisible(current => ({
                    ...current,
                    [definition.id]: !current[definition.id],
                  }))}
                  disabled={!inputs[definition.id] || isBusy}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700 disabled:opacity-40 dark:hover:text-gray-100"
                  title={visible[definition.id] ? 'إخفاء المفاتيح' : 'إظهار المفاتيح'}
                >
                  {visible[definition.id] ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => handleSave(definition.id)}
                disabled={!canStore || isBusy || !inputs[definition.id].trim()}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-sm font-bold text-white hover:bg-[#b8922e] disabled:opacity-50"
              >
                {isBusy ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />}
                <span>حفظ واستبدال</span>
              </button>
              <button
                type="button"
                onClick={() => handleClear(definition.id)}
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

export default UserAiProviderSecretsSettings;
