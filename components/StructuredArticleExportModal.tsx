import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Download,
  FileCode2,
  FileText,
  X,
} from 'lucide-react';
import type { Keywords } from '../types';
import {
  buildStructuredArticleExport,
  copyUtf8Text,
  DEFAULT_STRUCTURED_ARTICLE_EXPORT_OPTIONS,
  downloadStructuredArticleExport,
  type StructuredArticleExportFormat,
  type StructuredArticleExportOptions,
} from '../utils/articleStructuredExport';

type StructuredArticleExportModalProps = {
  title: string;
  metaDescription: string;
  language: 'ar' | 'en';
  locale: 'ar' | 'en';
  keywords: Keywords;
  document: unknown;
  onClose: () => void;
};

const OPTION_DEFINITIONS: Array<{
  key: keyof StructuredArticleExportOptions;
  ar: string;
  en: string;
}> = [
  { key: 'includePrimaryKeyword', ar: 'الكلمة المفتاحية الأساسية', en: 'Primary keyword' },
  { key: 'includeAlternativePhrases', ar: 'الصيغ البديلة', en: 'Alternative phrases' },
  { key: 'includeLsiKeywords', ar: 'كلمات LSI', en: 'LSI keywords' },
  { key: 'includeSeoTitles', ar: 'العناوين المقترحة', en: 'Suggested titles' },
  { key: 'includeMetaDescriptions', ar: 'الأوصاف المقترحة والحالي', en: 'Current and suggested descriptions' },
  { key: 'includeSectionMarkers', ar: 'علامات حدود الأقسام', en: 'Section boundary markers' },
];

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const StructuredArticleExportModal: React.FC<StructuredArticleExportModalProps> = ({
  title,
  metaDescription,
  language,
  locale,
  keywords,
  document: articleDocument,
  onClose,
}) => {
  const isArabic = locale === 'ar';
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [format, setFormat] = useState<StructuredArticleExportFormat>('markdown');
  const [options, setOptions] = useState(DEFAULT_STRUCTURED_ARTICLE_EXPORT_OPTIONS);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  const result = useMemo(() => buildStructuredArticleExport({
    title,
    metaDescription,
    language,
    keywords,
    document: articleDocument,
    options,
  }, format), [articleDocument, format, keywords, language, metaDescription, options, title]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    setCopyState('idle');
  }, [format, options]);

  const handleCopy = async () => {
    try {
      await copyUtf8Text(result.content);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2200);
    } catch (error) {
      console.error('Could not copy the structured article export:', error);
      setCopyState('error');
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black/65 sm:p-4"
      role="presentation"
      onMouseDown={event => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="structured-article-export-title"
        dir={isArabic ? 'rtl' : 'ltr'}
        data-structured-article-export-modal="true"
        className="flex h-[100dvh] w-full flex-col overflow-hidden bg-white text-start shadow-2xl dark:bg-[#1F1F1F] sm:h-[min(90vh,900px)] sm:w-[min(1180px,calc(100vw-2rem))] sm:rounded-xl sm:border sm:border-gray-200 sm:dark:border-[#3C3C3C]"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-gray-200 px-4 py-3 dark:border-[#3C3C3C]">
          <FileCode2 size={20} className="mt-0.5 shrink-0 text-[#b8922e]" />
          <div className="min-w-0 flex-1">
            <h2 id="structured-article-export-title" className="text-base font-black text-gray-900 dark:text-gray-100">
              {isArabic ? 'تصدير المقالة والسياق بصيغة منظمة' : 'Export article and context in a structured format'}
            </h2>
            <p className="mt-1 text-xs font-semibold text-gray-500 dark:text-gray-400">
              {isArabic
                ? 'تفصل بيانات SEO عن جسم المقالة، وتحدد علامات واضحة للمقدمة والأقسام والأسئلة والخاتمة.'
                : 'SEO context is separated from the article body, with clear markers for every section.'}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={isArabic ? 'إغلاق' : 'Close'}
            title={isArabic ? 'إغلاق' : 'Close'}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-gray-500 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
          >
            <X size={18} />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="overflow-y-auto border-b border-gray-200 bg-gray-50 p-4 custom-scrollbar dark:border-[#3C3C3C] dark:bg-[#242424] lg:border-b-0 lg:border-e">
            <div className="grid grid-cols-2 rounded-lg bg-gray-200 p-1 dark:bg-[#181818]" role="tablist" aria-label={isArabic ? 'صيغة التصدير' : 'Export format'}>
              <button
                type="button"
                role="tab"
                aria-selected={format === 'markdown'}
                onClick={() => setFormat('markdown')}
                className={`flex h-9 items-center justify-center gap-2 rounded-md text-xs font-black transition ${format === 'markdown' ? 'bg-white text-[#8a6f1d] shadow-sm dark:bg-[#333] dark:text-[#f2d675]' : 'text-gray-500 dark:text-gray-400'}`}
              >
                <FileCode2 size={15} /> Markdown
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={format === 'text'}
                onClick={() => setFormat('text')}
                className={`flex h-9 items-center justify-center gap-2 rounded-md text-xs font-black transition ${format === 'text' ? 'bg-white text-[#8a6f1d] shadow-sm dark:bg-[#333] dark:text-[#f2d675]' : 'text-gray-500 dark:text-gray-400'}`}
              >
                <FileText size={15} /> UTF-8
              </button>
            </div>

            <div className="mt-4">
              <h3 className="text-xs font-black text-gray-800 dark:text-gray-200">
                {isArabic ? 'المعلومات المرفقة' : 'Included information'}
              </h3>
              <div className="mt-2 space-y-1.5">
                {OPTION_DEFINITIONS.map(option => (
                  <label key={option.key} className="flex cursor-pointer items-center gap-2 rounded-md border border-gray-200 bg-white px-2.5 py-2 text-xs font-bold text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200">
                    <input
                      type="checkbox"
                      checked={options[option.key]}
                      onChange={event => setOptions(previous => ({ ...previous, [option.key]: event.target.checked }))}
                      className="size-4 accent-[#b8922e]"
                    />
                    <span>{isArabic ? option.ar : option.en}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 text-center text-[11px] font-black">
              <div className="rounded-lg border border-gray-200 bg-white p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                <div className="text-lg text-[#9a781c] dark:text-[#f2d675]">{result.sectionCount.toLocaleString(locale)}</div>
                <div className="text-gray-500 dark:text-gray-400">{isArabic ? 'قسم' : 'sections'}</div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                <div className="text-lg text-[#9a781c] dark:text-[#f2d675]">{result.wordCount.toLocaleString(locale)}</div>
                <div className="text-gray-500 dark:text-gray-400">{isArabic ? 'كلمة' : 'words'}</div>
              </div>
            </div>

            {result.warnings.length > 0 && (
              <section className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-900/15">
                <h3 className="flex items-center gap-2 text-xs font-black text-amber-800 dark:text-amber-200">
                  <AlertTriangle size={15} />
                  {isArabic ? 'ملاحظات قبل التصدير' : 'Export notes'}
                </h3>
                <ul className="mt-2 list-disc space-y-1 ps-4 text-[11px] font-semibold leading-5 text-amber-800 dark:text-amber-200">
                  {result.warnings.map(warning => <li key={warning}>{warning}</li>)}
                </ul>
              </section>
            )}
          </aside>

          <main className="flex min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-2 dark:border-[#3C3C3C]">
              <div>
                <div className="text-xs font-black text-gray-800 dark:text-gray-200">{isArabic ? 'معاينة الملف' : 'File preview'}</div>
                <div dir="ltr" className="mt-0.5 text-[10px] font-semibold text-gray-400">{result.filename}</div>
              </div>
              <div className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-black text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                UTF-8
              </div>
            </div>
            <textarea
              readOnly
              value={result.content}
              spellCheck={false}
              dir="ltr"
              aria-label={isArabic ? 'معاينة المحتوى المنظم' : 'Structured content preview'}
              className="min-h-0 flex-1 resize-none border-0 bg-white p-4 font-mono text-xs leading-6 text-gray-800 outline-none custom-scrollbar dark:bg-[#171717] dark:text-gray-100"
            />
          </main>
        </div>

        <footer className="flex shrink-0 flex-col gap-2 border-t border-gray-200 bg-white px-4 py-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
            {isArabic
              ? 'لن تُدرج بيانات المنافسين أو أوامر النظام؛ التصدير يضم المقالة وسياق SEO المحدد فقط.'
              : 'Competitor content and system prompts are excluded; only the article and selected SEO context are exported.'}
          </p>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => downloadStructuredArticleExport(result)}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-gray-300 px-3 text-xs font-black text-gray-700 transition hover:bg-gray-50 dark:border-[#444] dark:text-gray-200 dark:hover:bg-[#2A2A2A]"
            >
              <Download size={15} />
              {isArabic ? `تنزيل .${format === 'markdown' ? 'md' : 'txt'}` : `Download .${format === 'markdown' ? 'md' : 'txt'}`}
            </button>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className={`inline-flex h-9 min-w-32 items-center justify-center gap-2 rounded-md px-4 text-xs font-black text-white transition ${copyState === 'error' ? 'bg-red-600 hover:bg-red-700' : copyState === 'copied' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-[#b8922e] hover:bg-[#96751f]'}`}
            >
              {copyState === 'copied' ? <Check size={15} /> : <ClipboardCopy size={15} />}
              {copyState === 'copied'
                ? (isArabic ? 'تم النسخ' : 'Copied')
                : copyState === 'error'
                  ? (isArabic ? 'تعذر النسخ' : 'Copy failed')
                  : (isArabic ? 'نسخ المحتوى' : 'Copy content')}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
};

export default StructuredArticleExportModal;
