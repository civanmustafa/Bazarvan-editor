import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Settings2, X } from 'lucide-react';
import {
  ARTICLE_AUTOMATION_CAPABILITIES,
  ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS,
  COMPETITOR_COMPARISON_COMMAND_ID,
  countArticleAutomationExceptions,
  type ArticleAutomationCapability,
  type ArticleAutomationOverrides,
  type ArticleWritingMode,
} from '../constants/articleAutomationOverrides';
import {
  EXTERNAL_AUTOMATIC_COMMAND_IDS,
  getExternalReadyCommandLabel,
} from '../constants/externalAnalysisCommands';
import {
  loadArticleAutomationOverrides,
  updateArticleAutomationOverrides,
} from '../utils/articleAutomationOverrides';

const CAPABILITY_LABELS: Record<ArticleAutomationCapability, { title: string; detail: string }> = {
  autoGenerateAlternativeKeywords: {
    title: 'توليد الصيغ البديلة',
    detail: 'لن تُنشأ الصيغ البديلة تلقائيًا، ويمكن إضافتها يدويًا.',
  },
  autoGenerateLsiKeywords: {
    title: 'توليد كلمات LSI',
    detail: 'لن تُنشأ كلمات الارتباط الدلالي تلقائيًا.',
  },
  autoGenerateGoogleMetadata: {
    title: 'عناوين وأوصاف Google',
    detail: 'لن تُنشأ اقتراحات العنوان والوصف تلقائيًا.',
  },
  autoDiscoverCompetitors: {
    title: 'بحث واختيار المنافسين',
    detail: 'لن يبدأ مسار البحث البرمجي عن المنافسين لهذه المقالة.',
  },
  autoExtractCompetitorContent: {
    title: 'سحب نصوص المنافسين',
    detail: 'لن تُسحب نصوص المنافسين تلقائيًا حتى إن وُجدت روابط.',
  },
  autoRunReadyEngineeringCommands: {
    title: 'التدقيقات الخارجية',
    detail: 'لن تُشغّل أوامر التحليل الخارجي تلقائيًا.',
  },
  contentWritingAutomationEnabled: {
    title: 'كتابة المحتوى تلقائيًا',
    detail: 'لن تُحجز المقالة في طابور الكتابة التلقائية.',
  },
  autoApplyStrongInternalLinkSuggestions: {
    title: 'تطبيق الربط الداخلي المؤكد',
    detail: 'لن تُطبّق اقتراحات الربط القوية تلقائيًا.',
  },
};

const WRITING_MODES: Array<{ value: ArticleWritingMode; title: string; detail: string }> = [
  {
    value: 'strict',
    title: 'المسار القياسي الصارم',
    detail: 'يشترط المنافسين وكل مدخلات الكتابة الحالية. هذا هو الوضع الافتراضي.',
  },
  {
    value: 'available_inputs',
    title: 'الكتابة بالمدخلات المتاحة',
    detail: 'تبدأ الكتابة دون انتظار المنافسين، ويُستثنى أمر مقارنة المنافسين تلقائيًا.',
  },
  {
    value: 'manual_only',
    title: 'كتابة يدوية فقط',
    detail: 'لا تُحجز المقالة تلقائيًا للكتابة؛ يبقى التحرير اليدوي متاحًا.',
  },
];

const cloneDefaults = (): ArticleAutomationOverrides => ({
  ...ARTICLE_AUTOMATION_OVERRIDE_DEFAULTS,
  disabledCapabilities: [],
  excludedExternalCommandIds: [],
});

const ArticleAutomationOverridesControl: React.FC<{
  articleId: string;
  articleTitle: string;
  onSaved?: () => void | Promise<void>;
}> = ({ articleId, articleTitle, onSaved }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [overrides, setOverrides] = useState<ArticleAutomationOverrides | null>(null);
  const exceptionCount = useMemo(
    () => overrides ? countArticleAutomationExceptions(overrides) : 0,
    [overrides],
  );

  useEffect(() => {
    if (!isOpen || overrides || isLoading) return;
    setIsLoading(true);
    setError('');
    loadArticleAutomationOverrides(articleId)
      .then(result => setOverrides(result.overrides))
      .catch(loadError => {
        setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل الاستثناءات.');
        setOverrides(cloneDefaults());
      })
      .finally(() => setIsLoading(false));
  }, [articleId, isLoading, isOpen, overrides]);

  const close = () => {
    if (!isSaving) setIsOpen(false);
  };

  const toggleCapability = (capability: ArticleAutomationCapability) => {
    setOverrides(current => {
      const value = current || cloneDefaults();
      const disabled = value.disabledCapabilities.includes(capability)
        ? value.disabledCapabilities.filter(item => item !== capability)
        : [...value.disabledCapabilities, capability];
      return { ...value, disabledCapabilities: disabled };
    });
  };

  const toggleCommand = (commandId: string) => {
    setOverrides(current => {
      const value = current || cloneDefaults();
      const excluded = value.excludedExternalCommandIds.includes(commandId)
        ? value.excludedExternalCommandIds.filter(item => item !== commandId)
        : [...value.excludedExternalCommandIds, commandId];
      return { ...value, excludedExternalCommandIds: excluded };
    });
  };

  const save = async () => {
    if (!overrides || isSaving) return;
    setIsSaving(true);
    setError('');
    try {
      const result = await updateArticleAutomationOverrides(articleId, overrides);
      setOverrides(result.overrides);
      await onSaved?.();
      setIsOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'تعذر حفظ الاستثناءات.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={event => {
          event.stopPropagation();
          setIsOpen(true);
        }}
        className={`relative rounded-full p-1 transition-colors ${exceptionCount > 0
          ? 'bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300'
          : 'text-gray-400 hover:bg-[#d4af37]/10 hover:text-[#d4af37] dark:text-gray-500 dark:hover:bg-[#d4af37]/20 dark:hover:text-[#f2d675]'
        }`}
        title={exceptionCount > 0 ? `استثناءات الأتمتة: ${exceptionCount}` : 'استثناءات أتمتة المقالة'}
        aria-label="استثناءات أتمتة المقالة"
      >
        <Settings2 size={13} />
        {exceptionCount > 0 && (
          <span className="absolute -left-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[8px] font-black text-white">
            {exceptionCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="استثناءات أتمتة المقالة"
          onClick={event => {
            event.stopPropagation();
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-[#3c3c3c] dark:bg-[#171717]"
            onClick={event => event.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-gray-200 bg-white px-5 py-4 dark:border-[#333] dark:bg-[#171717]">
              <div>
                <h3 className="text-base font-black text-gray-900 dark:text-white">استثناءات أتمتة المقالة</h3>
                <p className="mt-1 max-w-2xl truncate text-xs text-gray-500 dark:text-gray-400" title={articleTitle}>
                  {articleTitle || 'مقالة بدون عنوان'}
                </p>
              </div>
              <button type="button" onClick={close} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10" aria-label="إغلاق">
                <X size={18} />
              </button>
            </div>

            {isLoading ? (
              <div className="flex min-h-64 items-center justify-center gap-2 text-sm font-bold text-gray-500">
                <Loader2 className="animate-spin" size={18} /> جار تحميل السياسة…
              </div>
            ) : overrides ? (
              <div className="space-y-6 p-5">
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs leading-6 text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">
                  كل الخيارات أدناه استثنائية لهذه المقالة فقط. عند تركها كما هي، ترث المقالة إعدادات المستخدم والمسؤول دون أي تغيير.
                </div>

                <section>
                  <h4 className="mb-2 text-sm font-black text-gray-800 dark:text-gray-100">وضع كتابة المحتوى</h4>
                  <div className="grid gap-2 md:grid-cols-3">
                    {WRITING_MODES.map(mode => (
                      <label key={mode.value} className={`cursor-pointer rounded-xl border p-3 transition ${overrides.writingMode === mode.value
                        ? 'border-[#d4af37] bg-[#d4af37]/10'
                        : 'border-gray-200 hover:border-gray-300 dark:border-[#3c3c3c] dark:hover:border-gray-500'
                      }`}>
                        <span className="flex items-center gap-2 text-xs font-black text-gray-800 dark:text-gray-100">
                          <input
                            type="radio"
                            name={`article-writing-mode-${articleId}`}
                            value={mode.value}
                            checked={overrides.writingMode === mode.value}
                            onChange={() => setOverrides({ ...overrides, writingMode: mode.value })}
                            className="text-[#d4af37] focus:ring-[#d4af37]"
                          />
                          {mode.title}
                        </span>
                        <span className="mt-1 block text-[11px] leading-5 text-gray-500 dark:text-gray-400">{mode.detail}</span>
                      </label>
                    ))}
                  </div>
                </section>

                <section>
                  <h4 className="mb-2 text-sm font-black text-gray-800 dark:text-gray-100">المراحل المستثناة</h4>
                  <div className="grid gap-2 md:grid-cols-2">
                    {ARTICLE_AUTOMATION_CAPABILITIES.map(capability => {
                      const disabled = overrides.disabledCapabilities.includes(capability);
                      return (
                        <label key={capability} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${disabled
                          ? 'border-red-200 bg-red-50/70 dark:border-red-500/30 dark:bg-red-500/10'
                          : 'border-gray-200 dark:border-[#3c3c3c]'
                        }`}>
                          <input
                            type="checkbox"
                            checked={disabled}
                            onChange={() => toggleCapability(capability)}
                            className="mt-0.5 rounded border-gray-300 text-red-600 focus:ring-red-500"
                          />
                          <span>
                            <span className="block text-xs font-black text-gray-800 dark:text-gray-100">{CAPABILITY_LABELS[capability].title}</span>
                            <span className="mt-1 block text-[11px] leading-5 text-gray-500 dark:text-gray-400">{CAPABILITY_LABELS[capability].detail}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </section>

                <section>
                  <h4 className="mb-2 text-sm font-black text-gray-800 dark:text-gray-100">استثناء أوامر خارجية بعينها</h4>
                  <div className="grid gap-2 md:grid-cols-3">
                    {EXTERNAL_AUTOMATIC_COMMAND_IDS.map(commandId => {
                      const forcedByMode = overrides.writingMode === 'available_inputs'
                        && commandId === COMPETITOR_COMPARISON_COMMAND_ID;
                      const excluded = forcedByMode || overrides.excludedExternalCommandIds.includes(commandId);
                      return (
                        <label key={commandId} className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 p-2 text-xs dark:border-[#3c3c3c]">
                          <input
                            type="checkbox"
                            checked={excluded}
                            disabled={forcedByMode}
                            onChange={() => toggleCommand(commandId)}
                            className="mt-0.5 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                          />
                          <span className="font-bold text-gray-700 dark:text-gray-200">
                            {getExternalReadyCommandLabel(commandId, 'ar')}
                            {forcedByMode && <span className="mt-1 block text-[10px] font-normal text-amber-700 dark:text-amber-300">مستثنى تلقائيًا بسبب وضع الكتابة</span>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </section>

                <label className="block">
                  <span className="mb-1 block text-sm font-black text-gray-800 dark:text-gray-100">سبب الاستثناء (اختياري)</span>
                  <textarea
                    value={overrides.reason}
                    onChange={event => setOverrides({ ...overrides, reason: event.target.value.slice(0, 1_000) })}
                    rows={3}
                    placeholder="مثال: هذه المقالة مرجعية وستُكتب يدويًا دون مقارنة منافسين."
                    className="w-full rounded-xl border border-gray-300 bg-white p-3 text-sm text-gray-800 focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#444] dark:bg-[#202020] dark:text-gray-100"
                  />
                </label>

                {error && (
                  <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4 dark:border-[#333]">
                  <button
                    type="button"
                    onClick={() => setOverrides(cloneDefaults())}
                    disabled={isSaving}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-black text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-[#444] dark:text-gray-300 dark:hover:bg-white/5"
                  >
                    استعادة الوراثة الافتراضية
                  </button>
                  <div className="flex gap-2">
                    <button type="button" onClick={close} disabled={isSaving} className="rounded-lg px-4 py-2 text-xs font-black text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-white/5">
                      إلغاء
                    </button>
                    <button type="button" onClick={save} disabled={isSaving} className="inline-flex items-center gap-2 rounded-lg bg-[#d4af37] px-4 py-2 text-xs font-black text-white hover:bg-[#b8922e] disabled:cursor-wait disabled:opacity-60">
                      {isSaving && <Loader2 size={14} className="animate-spin" />}
                      حفظ وتحديث الطابور
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-5">
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">{error || 'تعذر تحميل الاستثناءات.'}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default ArticleAutomationOverridesControl;
