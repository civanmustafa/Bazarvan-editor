import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Layers,
  ListOrdered,
  LoaderCircle,
  RotateCcw,
  Save,
} from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import {
  EXTERNAL_AUTOMATIC_COMMAND_IDS,
  EXTERNAL_READY_COMMAND_DEFINITIONS,
  getExternalReadyCommandLabel,
} from '../constants/externalAnalysisCommands';
import { loadSystemSettings, saveSystemSettings } from '../utils/systemSettings';

const DEFAULT_COMMAND_IDS = [...EXTERNAL_AUTOMATIC_COMMAND_IDS];
type ExecutionMode = 'independent_batch' | 'sequential';
const ALLOWED_COMMAND_IDS = new Set(
  EXTERNAL_READY_COMMAND_DEFINITIONS.map(definition => definition.id),
);

const normalizeCommandIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return DEFAULT_COMMAND_IDS;
  const normalized = Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => ALLOWED_COMMAND_IDS.has(item)),
  ));
  return normalized.length > 0 ? normalized : DEFAULT_COMMAND_IDS;
};

const normalizeExecutionMode = (value: unknown): ExecutionMode => (
  value === 'sequential' ? 'sequential' : 'independent_batch'
);

const ExternalAnalysisDefaultCommandsSettings: React.FC = () => {
  const { t } = useUser();
  const locale = t.locale === 'en' ? 'en' : 'ar';
  const [aiSettings, setAiSettings] = useState<Record<string, any>>({});
  const [selectedIds, setSelectedIds] = useState<string[]>(DEFAULT_COMMAND_IDS);
  const [savedIds, setSavedIds] = useState<string[]>(DEFAULT_COMMAND_IDS);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('independent_batch');
  const [savedExecutionMode, setSavedExecutionMode] = useState<ExecutionMode>('independent_batch');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const commandsById = useMemo(() => new Map(
    EXTERNAL_READY_COMMAND_DEFINITIONS.map(definition => [definition.id, {
      id: definition.id,
      label: (t.rightSidebar as any)?.[definition.labelKey]
        || getExternalReadyCommandLabel(definition.id, locale),
    }]),
  ), [locale, t.rightSidebar]);

  const orderedCommands = useMemo(() => {
    const selected = selectedIds
      .map(id => commandsById.get(id))
      .filter((command): command is { id: string; label: string } => Boolean(command));
    const selectedSet = new Set(selectedIds);
    const unselected = EXTERNAL_READY_COMMAND_DEFINITIONS
      .filter(definition => !selectedSet.has(definition.id))
      .map(definition => commandsById.get(definition.id))
      .filter((command): command is { id: string; label: string } => Boolean(command));
    return [...selected, ...unselected];
  }, [commandsById, selectedIds]);

  const isDirty = selectedIds.join('|') !== savedIds.join('|')
    || executionMode !== savedExecutionMode;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setMessage(null);
      try {
        const response = await loadSystemSettings();
        if (cancelled) return;
        const nextAiSettings = response.settings?.ai || {};
        const nextIds = normalizeCommandIds(nextAiSettings.externalAnalysisDefaultCommandIds);
        const nextExecutionMode = normalizeExecutionMode(
          nextAiSettings.externalAnalysisCommandExecutionMode,
        );
        setAiSettings(nextAiSettings);
        setSelectedIds(nextIds);
        setSavedIds(nextIds);
        setExecutionMode(nextExecutionMode);
        setSavedExecutionMode(nextExecutionMode);
      } catch (error) {
        if (!cancelled) {
          setMessage({
            tone: 'error',
            text: error instanceof Error ? error.message : 'تعذر تحميل إعدادات التحليل الخارجي.',
          });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleCommand = (commandId: string) => {
    setMessage(null);
    setSelectedIds(current => current.includes(commandId)
      ? current.filter(id => id !== commandId)
      : [...current, commandId]);
  };

  const moveCommand = (commandId: string, direction: -1 | 1) => {
    setMessage(null);
    setSelectedIds(current => {
      const index = current.indexOf(commandId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const restoreDefaults = () => {
    setSelectedIds(DEFAULT_COMMAND_IDS);
    setMessage(null);
  };

  const save = async () => {
    if (isSaving) return;
    if (selectedIds.length === 0) {
      setMessage({ tone: 'error', text: 'اختر أمرًا واحدًا على الأقل.' });
      return;
    }
    setIsSaving(true);
    setMessage(null);
    try {
      const response = await saveSystemSettings({
        ai: {
          ...aiSettings,
          externalAnalysisDefaultCommandIds: selectedIds,
          externalAnalysisCommandExecutionMode: executionMode,
        },
      });
      const nextAiSettings = response.settings?.ai || {};
      const nextIds = normalizeCommandIds(nextAiSettings.externalAnalysisDefaultCommandIds);
      const nextExecutionMode = normalizeExecutionMode(
        nextAiSettings.externalAnalysisCommandExecutionMode,
      );
      setAiSettings(nextAiSettings);
      setSelectedIds(nextIds);
      setSavedIds(nextIds);
      setExecutionMode(nextExecutionMode);
      setSavedExecutionMode(nextExecutionMode);
      setMessage({
        tone: 'success',
        text: 'تم حفظ الأوامر الافتراضية وترتيبها. لن تتأثر المقالات ذات الاختيار الخاص.',
      });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'تعذر حفظ الأوامر الافتراضية.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-24 items-center justify-center gap-2 text-sm font-bold text-gray-500 dark:text-gray-400">
        <LoaderCircle size={17} className="animate-spin" />
        <span>جار تحميل الأوامر الافتراضية...</span>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4">
        <div className="mb-2 text-sm font-black text-gray-700 dark:text-gray-200">
          نمط تشغيل الأوامر
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="نمط تشغيل أوامر التحليل الخارجي">
          <button
            type="button"
            onClick={() => setExecutionMode('independent_batch')}
            className={`flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 text-start text-sm font-bold ${executionMode === 'independent_batch' ? 'border-[#d4af37] bg-[#d4af37]/10 text-[#8a6f1d] dark:text-[#f2d675]' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-300 dark:hover:bg-[#333]'}`}
          >
            <Layers size={17} className="shrink-0" />
            <span>
              <span className="block">دفعة مستقلة بمفاتيح مختلفة</span>
              <span className="mt-0.5 block text-xs font-semibold opacity-75">حتى 5 طلبات، ونتيجة منفصلة لكل أمر</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setExecutionMode('sequential')}
            className={`flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 text-start text-sm font-bold ${executionMode === 'sequential' ? 'border-[#d4af37] bg-[#d4af37]/10 text-[#8a6f1d] dark:text-[#f2d675]' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-300 dark:hover:bg-[#333]'}`}
          >
            <ListOrdered size={17} className="shrink-0" />
            <span>
              <span className="block">تسلسلي محافظ</span>
              <span className="mt-0.5 block text-xs font-semibold opacity-75">لا يبدأ الأمر التالي قبل نجاح السابق</span>
            </span>
          </button>
        </div>
        <p className="mt-2 text-xs font-semibold leading-5 text-gray-500 dark:text-gray-400">
          يطبق النمط على الدفعات الجديدة. في الدفعة المستقلة يُحجز مفتاح مختلف لكل طلب، بينما تبقى نتائج الأوامر وسجلاتها منفصلة.
        </p>
      </div>

      <p className="mb-3 text-sm font-semibold leading-6 text-gray-500 dark:text-gray-400">
        تُنفذ الأوامر المحددة من الأعلى إلى الأسفل. اختيار أوامر يدويًا من بطاقة مقالة يحولها إلى حالة خاصة ولا يطبق عليها هذا الإعداد.
      </p>

      <div className="divide-y divide-gray-100 border-y border-gray-100 dark:divide-[#3C3C3C] dark:border-[#3C3C3C]">
        {orderedCommands.map(command => {
          const selectedIndex = selectedIds.indexOf(command.id);
          const selected = selectedIndex >= 0;
          return (
            <div key={command.id} className="flex min-h-12 items-center gap-2 py-2">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm font-bold text-gray-700 dark:text-gray-200">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleCommand(command.id)}
                  className="rounded text-[#d4af37] focus:ring-[#d4af37]"
                />
                {selected && (
                  <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded bg-[#d4af37]/15 px-1 text-xs font-black text-[#8a6f1d] dark:text-[#f2d675]">
                    {selectedIndex + 1}
                  </span>
                )}
                <span className="min-w-0 break-words">{command.label}</span>
              </label>

              {selected && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveCommand(command.id, -1)}
                    disabled={selectedIndex === 0}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30 dark:text-gray-300 dark:hover:bg-[#333]"
                    title="نقل إلى أعلى"
                    aria-label="نقل إلى أعلى"
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveCommand(command.id, 1)}
                    disabled={selectedIndex === selectedIds.length - 1}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30 dark:text-gray-300 dark:hover:bg-[#333]"
                    title="نقل إلى أسفل"
                    aria-label="نقل إلى أسفل"
                  >
                    <ArrowDown size={15} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={isSaving || !isDirty || selectedIds.length === 0}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#d4af37] px-4 py-2 text-sm font-black text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />}
          <span>{isSaving ? 'جار الحفظ...' : 'حفظ الأوامر والترتيب'}</span>
        </button>
        <button
          type="button"
          onClick={restoreDefaults}
          disabled={isSaving}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-[#3C3C3C] dark:text-gray-300 dark:hover:bg-[#333]"
        >
          <RotateCcw size={15} />
          <span>استعادة الأوامر الخمسة</span>
        </button>
        <span className="text-xs font-bold text-gray-500 dark:text-gray-400">
          المحدد: {selectedIds.length}
        </span>
      </div>

      {message && (
        <div className={`mt-3 flex items-start gap-2 text-sm font-bold ${message.tone === 'success' ? 'text-emerald-600 dark:text-emerald-300' : 'text-red-600 dark:text-red-300'}`} role="status">
          {message.tone === 'success' && <CheckCircle2 size={16} className="mt-0.5 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}
    </div>
  );
};

export default ExternalAnalysisDefaultCommandsSettings;
