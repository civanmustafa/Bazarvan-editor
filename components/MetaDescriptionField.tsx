import React, { useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Save, Search, Sparkles, XCircle } from 'lucide-react';
import { useEditorSelector } from '../contexts/EditorContext';
import {
  META_DESCRIPTION_MAX_LENGTH,
  META_DESCRIPTION_MIN_LENGTH,
  validateMetaDescription,
} from '../utils/metaDescription';

const MetaDescriptionField: React.FC = () => {
  const activeArticleId = useEditorSelector(context => context.activeArticleId);
  const metaDescription = useEditorSelector(context => context.metaDescription);
  const setMetaDescription = useEditorSelector(context => context.setMetaDescription);
  const primaryKeyword = useEditorSelector(context => context.keywords.primary);
  const activeArticleSettings = useEditorSelector(context => context.activeArticleSettings);
  const saveStatus = useEditorSelector(context => context.saveStatus);
  const handleSaveDraft = useEditorSelector(context => context.handleSaveDraft);
  const [saveMessage, setSaveMessage] = useState('');
  const validation = useMemo(
    () => validateMetaDescription(metaDescription, primaryKeyword),
    [metaDescription, primaryKeyword],
  );

  if (!activeArticleId) return null;

  const saveMetaDescription = async () => {
    setSaveMessage('');
    const saved = await handleSaveDraft({ reason: 'manual', force: true });
    setSaveMessage(saved ? 'تم حفظ وصف الميتا.' : 'تعذر الحفظ. راجع التنبيه الظاهر أعلاه.');
  };

  const lengthClass = validation.lengthValid
    ? 'text-emerald-700 dark:text-emerald-300'
    : validation.length > META_DESCRIPTION_MAX_LENGTH
      ? 'text-red-700 dark:text-red-300'
      : 'text-amber-700 dark:text-amber-300';

  return (
    <section
      data-bazarvan-meta-description-field="true"
      className="border-t border-gray-200 bg-slate-50 px-3 py-2.5 dark:border-[#3C3C3C] dark:bg-[#202020]"
      dir="rtl"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-[170px] items-center gap-2 pt-2">
          <Search size={17} className="text-[#b8922e] dark:text-[#f2d675]" />
          <div>
            <label htmlFor="article-meta-description" className="block text-xs font-black text-gray-900 dark:text-gray-100">
              وصف الميتا
            </label>
            <p className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
              مناسب لهدف الصفحة وجدول المحتويات
            </p>
          </div>
        </div>

        <div className="min-w-[280px] flex-1">
          <textarea
            id="article-meta-description"
            dir="auto"
            rows={2}
            maxLength={500}
            value={metaDescription}
            onChange={event => {
              setSaveMessage('');
              setMetaDescription(event.target.value);
            }}
            placeholder="اختر أحد أوصاف Google المقترحة أو اكتب وصف الميتا يدويًا هنا."
            className="block w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm leading-6 text-gray-900 outline-none transition focus:border-[#d4af37] focus:ring-2 focus:ring-[#d4af37]/20 dark:border-[#4A4A4A] dark:bg-[#181818] dark:text-gray-100"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-bold">
            <span className={`inline-flex items-center gap-1 ${lengthClass}`}>
              {validation.lengthValid ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
              {validation.length} حرفًا — المطلوب {META_DESCRIPTION_MIN_LENGTH}–{META_DESCRIPTION_MAX_LENGTH}
            </span>
            <span className={`inline-flex items-center gap-1 ${validation.includesPrimaryKeyword ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
              {validation.includesPrimaryKeyword ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
              {primaryKeyword.trim() ? 'يتضمن الكلمة المفتاحية' : 'أضف الكلمة المفتاحية الأساسية'}
            </span>
            {activeArticleSettings.status === 'in_review' && !metaDescription.trim() && (
              <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-300">
                <Sparkles size={13} />
                مهمة الكتابة التلقائية ستظهر في شريط الذكاء الاصطناعي
              </span>
            )}
            {saveMessage && <span className="text-gray-600 dark:text-gray-300">{saveMessage}</span>}
          </div>
        </div>

        <button
          type="button"
          onClick={() => { void saveMetaDescription(); }}
          disabled={saveStatus === 'saving'}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-[#d4af37] px-3 text-xs font-black text-white transition hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saveStatus === 'saving' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          حفظ الوصف
        </button>
      </div>
    </section>
  );
};

export default MetaDescriptionField;
