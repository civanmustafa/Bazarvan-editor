import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, LoaderCircle, RefreshCw, Save, ShieldCheck, Workflow } from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import {
  EXTERNAL_READY_COMMAND_DEFINITIONS,
  getExternalReadyCommandLabel,
} from '../constants/externalAnalysisCommands';
import {
  type UserAutomationBlockedReasons,
  type UserAutomationBooleanKey,
  type UserAutomationPreferences,
} from '../constants/userAutomation';
import {
  loadUserAutomationPreferences,
  saveUserAutomationPreferences,
  type UserAutomationResponse,
} from '../utils/userAutomation';

const AUTOMATION_FIELDS: Array<{
  key: Exclude<UserAutomationBooleanKey, 'enabled'>;
  label: string;
  description: string;
}> = [
  {
    key: 'autoGenerateAlternativeKeywords',
    label: 'توليد الصيغ البديلة تلقائيًا',
    description: 'توليد الصيغ البديلة للكلمة المفتاحية بعد توفر بيانات المقالة.',
  },
  {
    key: 'autoGenerateLsiKeywords',
    label: 'توليد كلمات LSI تلقائيًا',
    description: 'توليد الكلمات المرتبطة بالموضوع دون الحاجة إلى طلب يدوي.',
  },
  {
    key: 'autoGenerateGoogleMetadata',
    label: 'اقتراح عناوين وأوصاف Google تلقائيًا',
    description: 'إنشاء اقتراحات عنوان ووصف نتائج البحث عند اكتمال المدخلات المطلوبة.',
  },
  {
    key: 'autoDiscoverCompetitors',
    label: 'البحث عن المنافسين تلقائيًا',
    description: 'اكتشاف المنافسين عند توفر متطلبات البحث، دون تشغيل توليد كلمات عطّلته.',
  },
  {
    key: 'autoExtractCompetitorContent',
    label: 'سحب محتوى المنافسين تلقائيًا',
    description: 'سحب نصوص المنافسين المتاحين للتحليل ضمن صلاحيات خدمات الزحف.',
  },
  {
    key: 'autoRunReadyEngineeringCommands',
    label: 'تشغيل الأوامر الجاهزة تلقائيًا',
    description: 'تنفيذ الأوامر المختارة أدناه بعد اكتمال متطلباتها، حتى دون فتح المقالة.',
  },
  {
    key: 'contentWritingAutomationEnabled',
    label: 'كتابة المقالة تلقائيًا',
    description: 'الكتابة عند اكتمال المدخلات وشروط الجودة. تبقى النتيجة للمراجعة ولا تعيد كتابة ما اكتمل.',
  },
  {
    key: 'autoApplyStrongInternalLinkSuggestions',
    label: 'إدراج روابط داخلية مؤكدة تلقائيًا',
    description: 'إدراج الاقتراحات القوية فقط وفق ضوابط الصلة والتطابق ومنع الربط بالصفحة نفسها.',
  },
];

type PreferenceFieldsProps = {
  value: UserAutomationPreferences;
  onChange: (value: UserAutomationPreferences) => void;
  disabled?: boolean;
  blockedReasons?: UserAutomationBlockedReasons;
  defaultsMode?: boolean;
};

export const UserAutomationPreferenceFields: React.FC<PreferenceFieldsProps> = ({
  value,
  onChange,
  disabled = false,
  blockedReasons = {},
  defaultsMode = false,
}) => {
  const selectedSet = new Set(value.externalAnalysisCommandIds);
  const orderedCommands = [
    ...value.externalAnalysisCommandIds,
    ...EXTERNAL_READY_COMMAND_DEFINITIONS.map(command => command.id).filter(id => !selectedSet.has(id)),
  ];
  const updateBoolean = (key: UserAutomationBooleanKey, checked: boolean) => {
    onChange({ ...value, [key]: checked });
  };
  const toggleCommand = (commandId: string) => {
    onChange({
      ...value,
      externalAnalysisCommandIds: selectedSet.has(commandId)
        ? value.externalAnalysisCommandIds.filter(id => id !== commandId)
        : [...value.externalAnalysisCommandIds, commandId],
    });
  };
  const moveCommand = (commandId: string, direction: -1 | 1) => {
    const index = value.externalAnalysisCommandIds.indexOf(commandId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= value.externalAnalysisCommandIds.length) return;
    const commandIds = [...value.externalAnalysisCommandIds];
    [commandIds[index], commandIds[targetIndex]] = [commandIds[targetIndex], commandIds[index]];
    onChange({ ...value, externalAnalysisCommandIds: commandIds });
  };

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 disabled:opacity-70">
      <legend className="sr-only">{defaultsMode ? 'أتمتة المستخدمين الجدد' : 'تفضيلات أتمتة مقالاتي'}</legend>
      <label className="flex items-start justify-between gap-4 rounded-lg border border-[#d4af37]/50 bg-[#d4af37]/10 p-4">
        <span>
          <span className="block text-sm font-black text-gray-800 dark:text-gray-100">
            {defaultsMode ? 'تفعيل الأتمتة افتراضيًا للمستخدم الجديد' : 'تفعيل أتمتة مقالاتي'}
          </span>
          <span className="mt-1 block text-xs font-semibold leading-6 text-gray-600 dark:text-gray-300">
            إيقاف هذا المفتاح يوقف التشغيل التلقائي المشمول بتفضيلاتك، ويحفظ اختيارات المراحل أدناه. يبقى التشغيل اليدوي متاحًا ضمن الصلاحيات.
          </span>
          {blockedReasons.enabled && (
            <span className="mt-2 block text-xs font-bold text-amber-800 dark:text-amber-200">{blockedReasons.enabled}</span>
          )}
        </span>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={event => updateBoolean('enabled', event.target.checked)}
          className="mt-1 h-5 w-5 shrink-0 rounded border-gray-300 accent-[#d4af37] focus:ring-[#d4af37]"
        />
      </label>

      <div className="grid gap-3 md:grid-cols-2">
        {AUTOMATION_FIELDS.map(field => (
          <label key={field.key} className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
            <span>
              <span className="block text-sm font-bold text-gray-800 dark:text-gray-100">{field.label}</span>
              <span className="mt-1 block text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">{field.description}</span>
              {!defaultsMode && blockedReasons[field.key] && (
                <span className="mt-2 block text-xs font-bold leading-5 text-amber-800 dark:text-amber-200">
                  غير متاح حاليًا: {blockedReasons[field.key]} يبقى تفضيلك محفوظًا.
                </span>
              )}
              {!value.enabled && value[field.key] && (
                <span className="mt-2 block text-xs font-bold text-gray-500 dark:text-gray-400">لن تعمل هذه المرحلة ما دام مفتاح الأتمتة العام متوقفًا.</span>
              )}
            </span>
            <input
              type="checkbox"
              checked={value[field.key]}
              onChange={event => updateBoolean(field.key, event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300 accent-[#d4af37] focus:ring-[#d4af37]"
            />
          </label>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 p-4 dark:border-[#3C3C3C]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-black text-gray-800 dark:text-gray-100">الأوامر الخارجية المطلوبة وترتيبها</h3>
          <span className="rounded-full bg-[#d4af37]/10 px-3 py-1 text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">
            {value.externalAnalysisCommandIds.length} محدد
          </span>
        </div>
        <p className="mt-2 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
          يمكنك ترك جميع الأوامر دون تحديد؛ لن يُشغّل أي أمر تلقائيًا ولن يُستبدل اختيارك بالقائمة الافتراضية.
          يُراعى الترتيب عند اعتماد المسؤول نمط التنفيذ التسلسلي.
        </p>
        {(!value.enabled || !value.autoRunReadyEngineeringCommands || selectedSet.size === 0) && (
          <p className="mt-2 rounded-md bg-gray-100 px-3 py-2 text-xs font-bold leading-5 text-gray-600 dark:bg-[#1F1F1F] dark:text-gray-300">
            تشغيل الأوامر تلقائيًا متوقف {selectedSet.size === 0 ? 'لعدم تحديد أي أمر.' : 'وفق اختياراتك أعلاه. يمكنك تجهيز اختيار الأوامر دون تفعيل التشغيل.'}
          </p>
        )}
        <div className="mt-3 grid gap-2">
          {orderedCommands.map(commandId => {
            const selected = selectedSet.has(commandId);
            const selectedIndex = value.externalAnalysisCommandIds.indexOf(commandId);
            const label = getExternalReadyCommandLabel(commandId, 'ar');
            return (
              <div key={commandId} className={`flex items-center gap-2 rounded-md border px-3 py-2 ${selected ? 'border-[#d4af37]/50 bg-[#d4af37]/10' : 'border-gray-200 bg-gray-50 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]'}`}>
                <label className="flex min-h-8 min-w-0 flex-1 items-center gap-3 text-xs font-bold text-gray-700 dark:text-gray-200">
                  <input type="checkbox" checked={selected} onChange={() => toggleCommand(commandId)} className="h-4 w-4 shrink-0 rounded border-gray-300 accent-[#d4af37]" />
                  <span>{selected ? `${selectedIndex + 1}. ` : ''}{label}</span>
                </label>
                {selected && (
                  <div className="flex shrink-0 gap-1">
                    <button type="button" onClick={() => moveCommand(commandId, -1)} disabled={selectedIndex === 0} aria-label={`تقديم ${label}`} title={`تقديم ${label}`} className="rounded p-2 text-gray-600 hover:bg-[#d4af37]/20 disabled:opacity-30 dark:text-gray-300"><ArrowUp size={15} /></button>
                    <button type="button" onClick={() => moveCommand(commandId, 1)} disabled={selectedIndex === value.externalAnalysisCommandIds.length - 1} aria-label={`تأخير ${label}`} title={`تأخير ${label}`} className="rounded p-2 text-gray-600 hover:bg-[#d4af37]/20 disabled:opacity-30 dark:text-gray-300"><ArrowDown size={15} /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
};

const UserAutomationSettings: React.FC = () => {
  const { currentUserId } = useUser();
  const [response, setResponse] = useState<UserAutomationResponse | null>(null);
  const [draft, setDraft] = useState<UserAutomationPreferences | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setIsLoading(true);
    setError('');
    setMessage('');
    try {
      const result = await loadUserAutomationPreferences();
      if (version !== requestVersion.current) return;
      setResponse(result);
      setDraft(result.preferences);
    } catch (loadError) {
      if (version !== requestVersion.current) return;
      setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل أتمتة مقالاتك.');
    } finally {
      if (version === requestVersion.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    setResponse(null);
    setDraft(null);
    setIsSaving(false);
    void load();
    return () => { requestVersion.current += 1; };
  }, [currentUserId, load]);

  const isDirty = Boolean(draft && response && JSON.stringify(draft) !== JSON.stringify(response.preferences));
  const save = async () => {
    if (!draft || !isDirty || isSaving || isLoading) return;
    const version = ++requestVersion.current;
    setIsSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await saveUserAutomationPreferences(draft);
      if (version !== requestVersion.current) return;
      setResponse(result);
      setDraft(result.preferences);
      setMessage('تم حفظ أتمتة مقالاتك. تبقى المقالات السابقة لتفعيل الإعدادات الشخصية خارج هذا التغيير.');
    } catch (saveError) {
      if (version !== requestVersion.current) return;
      setError(saveError instanceof Error ? saveError.message : 'تعذر حفظ أتمتة مقالاتك.');
    } finally {
      if (version === requestVersion.current) setIsSaving(false);
    }
  };

  return (
    <section aria-busy={isLoading || isSaving} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Workflow size={20} className="text-[#d4af37]" />
          <h2 className="text-lg font-black text-gray-800 dark:text-gray-100">أتمتة مقالاتي</h2>
        </div>
        <div className="flex gap-2">
          {isDirty && (
            <button type="button" onClick={() => { setDraft(response!.preferences); setError(''); setMessage(''); }} disabled={isLoading || isSaving} className="inline-flex min-h-10 items-center rounded-md border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 disabled:opacity-50 dark:border-[#3C3C3C] dark:text-gray-300">إلغاء التعديلات</button>
          )}
          <button type="button" onClick={() => void load()} disabled={isLoading || isSaving || isDirty} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 disabled:opacity-50 dark:border-[#3C3C3C] dark:text-gray-300"><RefreshCw size={15} />تحديث</button>
          <button type="button" onClick={() => void save()} disabled={!isDirty || isLoading || isSaving} className="inline-flex min-h-10 items-center gap-2 rounded-md bg-[#d4af37] px-3 py-2 text-xs font-bold text-white hover:bg-[#b8922e] disabled:opacity-50">
            {isSaving ? <LoaderCircle size={15} className="animate-spin" /> : <Save size={15} />}
            {isSaving ? 'جار الحفظ...' : 'حفظ أتمتة مقالاتي'}
          </button>
        </div>
      </div>
      <div className="mb-4 rounded-lg border border-[#d4af37]/30 bg-[#d4af37]/10 p-3 text-xs font-semibold leading-6 text-gray-700 dark:text-gray-200">
        <p><strong>المرجع دائمًا منشئ المقالة الأصلي.</strong> تنطبق تفضيلاتك على المقالات الجديدة التي تنشئها بنفسك بعد تفعيل هذا النظام، ولا تنتقل إلى مقالات الآخرين لمجرد تحريرها أو إسنادها إليك.</p>
        <p className="mt-2">المقالات السابقة ومقالات n8n أو النظام تبقى على سياستها الحالية. تغيير المسؤول للقيم الافتراضية للمستخدمين الجدد لا يغيّر اختياراتك المحفوظة.</p>
      </div>
      <div className="mb-4 flex items-start gap-2 text-xs font-semibold leading-6 text-gray-500 dark:text-gray-400">
        <ShieldCheck size={17} className="mt-1 shrink-0 text-[#8a6f1d] dark:text-[#f2d675]" />
        <p>كل مرحلة مستقلة؛ تفعيلها لا يفعّل مراحل عطّلتها لتوفير مدخلاتها. تبقى شروط اكتمال البيانات والجودة وصلاحيات المزودات والحصص نافذة، ولا يُعاد تنفيذ ما اكتمل. يمكن حفظ رغبتك في ميزة غير متاحة حتى يسمح بها المسؤول.</p>
      </div>
      <div aria-live="polite">
        {error && <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-200">{error}</p>}
        {message && <p className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm font-bold text-green-700 dark:border-green-900/50 dark:bg-green-950/20 dark:text-green-200">{message}</p>}
        {isLoading && <p className="mb-4 flex items-center gap-2 py-3 text-sm font-bold text-gray-500 dark:text-gray-400"><LoaderCircle size={18} className="animate-spin" />جار تحميل أتمتة مقالاتك...</p>}
        {isDirty && <p className="mb-4 text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">لديك تعديلات لم تُحفظ بعد.</p>}
      </div>
      {draft && response && (
        <UserAutomationPreferenceFields value={draft} onChange={value => { setDraft(value); setMessage(''); }} blockedReasons={response.blockedReasons} disabled={isLoading || isSaving} />
      )}
    </section>
  );
};

export default UserAutomationSettings;
