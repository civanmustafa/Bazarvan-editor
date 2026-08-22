import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, KeyRound, LoaderCircle, Save, Trash2 } from 'lucide-react';
import {
  GEMINI_FREE_MODEL_OPTIONS,
  GEMINI_PAID_MODEL_OPTIONS,
  OPENAI_ANALYSIS_MODEL,
} from '../constants/modelRegistry';
import {
  encodeContentWritingResumeModel,
  getContentWritingResumeSecretProvider,
  parseContentWritingResumeModel,
} from '../constants/contentWritingResume';
import {
  clearAdminAiProviderSecret,
  loadAdminAiProviderSecrets,
  saveAndEnableAdminAiProviderSecret,
  type AdminAiProviderSecretsResponse,
} from '../utils/adminAiProviderSecrets';
import { notifyAiProviderCapabilitiesChanged } from '../utils/aiProviderCapabilities';

type ContentWritingResumeSettingsProps = {
  values: Record<string, unknown>;
  onChange: (field: 'contentWritingResumeModel', value: string) => void;
};

const inputClass = 'w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100';

const ContentWritingResumeSettings: React.FC<ContentWritingResumeSettingsProps> = ({ values, onChange }) => {
  const [overview, setOverview] = useState<AdminAiProviderSecretsResponse | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const resumeModelValue = String(values.contentWritingResumeModel || '');
  const preference = parseContentWritingResumeModel(resumeModelValue);
  const openAiModel = String(values.defaultOpenAiModel || OPENAI_ANALYSIS_MODEL).trim()
    || OPENAI_ANALYSIS_MODEL;
  const modelOptions = useMemo(() => ([
    {
      value: '',
      label: 'اختيار المستخدم الظاهر أعلى تبويب كتابة المحتوى',
    },
    ...GEMINI_FREE_MODEL_OPTIONS.map(option => ({
      value: encodeContentWritingResumeModel('gemini', option.value),
      label: `Gemini المجاني — ${option.label}`,
    })),
    ...GEMINI_PAID_MODEL_OPTIONS.map(option => ({
      value: encodeContentWritingResumeModel('geminiPaid', option.value),
      label: `Gemini Pro — ${option.label}`,
    })),
    {
      value: encodeContentWritingResumeModel('openai', openAiModel),
      label: `OpenAI — ${openAiModel}`,
    },
  ]), [openAiModel]);
  const secretProvider = preference
    ? getContentWritingResumeSecretProvider(preference.provider)
    : null;
  const secretStatus = secretProvider ? overview?.providers[secretProvider] : null;
  const canStore = Boolean(
    secretProvider
    && overview?.schemaAvailable
    && overview.encryptionConfigured,
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      setOverview(await loadAdminAiProviderSecrets());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل مفتاح الاستئناف.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleModelChange = (value: string) => {
    setApiKey('');
    setVisible(false);
    setError('');
    setMessage('');
    onChange('contentWritingResumeModel', value);
  };

  const handleSaveKey = async () => {
    if (!secretProvider || !apiKey.trim()) return;
    setIsSaving(true);
    setError('');
    setMessage('');
    try {
      const next = await saveAndEnableAdminAiProviderSecret(secretProvider, apiKey.trim());
      setOverview(next);
      setApiKey('');
      setVisible(false);
      notifyAiProviderCapabilitiesChanged();
      setMessage('تم حفظ المفتاح الخاص بالاستئناف مشفّرًا وتفعيله.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'تعذر حفظ مفتاح الاستئناف.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteKey = async () => {
    if (!secretProvider || !window.confirm('هل تريد حذف المفتاح الخاص باستئناف هذا المزود؟')) return;
    setIsSaving(true);
    setError('');
    setMessage('');
    try {
      const next = await clearAdminAiProviderSecret(secretProvider);
      setOverview(next);
      setApiKey('');
      setVisible(false);
      notifyAiProviderCapabilitiesChanged();
      setMessage('تم حذف مفتاح الاستئناف الخاص بهذا المزود.');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'تعذر حذف مفتاح الاستئناف.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-4 dark:border-indigo-900/50 dark:bg-indigo-950/10">
      <div className="mb-4 flex items-start gap-2">
        <KeyRound size={18} className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-300" />
        <div>
          <div className="text-sm font-black text-gray-800 dark:text-gray-100">إعدادات الاستئناف</div>
          <p className="mt-1 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
            اختيار المستخدم الظاهر أعلى تبويب كتابة المحتوى هو القرار النهائي عند الضغط على «استئناف». الموديل أدناه يحدد الاختيار الابتدائي فقط إذا لم يغيّره المستخدم، والمفتاح المشفّر يُجرّب أولًا للمزود نفسه ثم يستمر تدوير بقية المفاتيح عند فشله.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <label className="block">
          <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">
            موديل الخاص للاستئناف
          </span>
          <select
            value={modelOptions.some(option => option.value === resumeModelValue) ? resumeModelValue : ''}
            onChange={event => handleModelChange(event.target.value)}
            className={inputClass}
          >
            {modelOptions.map(option => (
              <option key={option.value || 'user-selection'} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className="mt-1.5 block text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
            احفظ إعدادات الصفحة بعد تغييره. إذا اختار المستخدم موديلًا آخر في أعلى تبويب الكتابة فسيُستأنف بالموديل الذي اختاره المستخدم.
          </span>
        </label>

        <div>
          <label className="block">
            <span className="mb-2 block text-sm font-bold text-gray-600 dark:text-gray-300">
              المفتاح الخاص للاستئناف
            </span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <input
                  type={visible ? 'text' : 'password'}
                  value={apiKey}
                  onChange={event => setApiKey(event.target.value)}
                  placeholder={preference ? 'أدخل مفتاحًا جديدًا لهذا المزود' : 'اختر موديل الاستئناف أولًا'}
                  autoComplete="new-password"
                  spellCheck={false}
                  dir="ltr"
                  disabled={!canStore || isSaving || isLoading}
                  className={`${inputClass} pl-10`}
                />
                <button
                  type="button"
                  onClick={() => setVisible(current => !current)}
                  disabled={!apiKey || isSaving}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700 disabled:opacity-40 dark:hover:text-gray-100"
                  title={visible ? 'إخفاء المفتاح' : 'إظهار المفتاح'}
                >
                  {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => void handleSaveKey()}
                disabled={!canStore || !apiKey.trim() || isSaving || isLoading}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-xs font-black text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {isSaving ? <LoaderCircle size={15} className="animate-spin" /> : <Save size={15} />}
                حفظ المفتاح
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteKey()}
                disabled={!secretStatus?.configured || isSaving || isLoading}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-red-200 px-3 py-2 text-xs font-black text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/60 dark:text-red-300"
              >
                <Trash2 size={15} />
                حذف
              </button>
            </div>
          </label>
          <div className="mt-1.5 text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
            {isLoading
              ? 'جار تحميل حالة المفتاح...'
              : secretStatus?.configured
                ? `المحفوظ لهذا المزود: ••••${secretStatus.keySuffix}${secretStatus.enabled ? ' — مفعّل' : ' — معطّل'}`
                : preference
                  ? 'لا يوجد مفتاح استئناف محفوظ لهذا المزود.'
                  : 'يبقى نظام تدوير المفاتيح المعتاد فعالًا عند عدم تحديد موديل ومفتاح خاصين.'}
          </div>
        </div>
      </div>

      {overview && (!overview.schemaAvailable || !overview.encryptionConfigured) && (
        <div className="mt-3 rounded-md bg-amber-100 px-3 py-2 text-xs font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          {!overview.schemaAvailable
            ? 'يجب تطبيق ترحيل مفتاح الاستئناف على قاعدة البيانات قبل الحفظ.'
            : 'مفتاح تشفير إعدادات الذكاء الاصطناعي غير مهيأ على الخادم.'}
        </div>
      )}
      {error && <div className="mt-3 text-xs font-bold text-red-700 dark:text-red-300">{error}</div>}
      {message && <div className="mt-3 text-xs font-bold text-green-700 dark:text-green-300">{message}</div>}
    </div>
  );
};

export default ContentWritingResumeSettings;
