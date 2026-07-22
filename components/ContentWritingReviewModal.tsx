import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  FileText,
  Loader2,
  Save,
  X,
} from 'lucide-react';
import { parseMarkdownToArticleHtml } from '../utils/editorUtils';
import {
  contentWritingMarkdownToPlainText,
  prepareContentWritingResultForEditor,
} from '../utils/contentWritingWorkflow';

type ContentWritingReviewModalProps = {
  articleTitle: string;
  articleLanguage: 'ar' | 'en';
  locale: 'ar' | 'en';
  currentHtml: string;
  currentText: string;
  resultMarkdown: string;
  isApplying: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const countWords = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;

const ContentWritingReviewModal: React.FC<ContentWritingReviewModalProps> = ({
  articleTitle,
  articleLanguage,
  locale,
  currentHtml,
  currentText,
  resultMarkdown,
  isApplying,
  onConfirm,
  onClose,
}) => {
  const isArabic = locale === 'ar';
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const prepared = useMemo(
    () => prepareContentWritingResultForEditor(resultMarkdown, articleTitle),
    [articleTitle, resultMarkdown],
  );
  const generatedHtml = useMemo(
    () => parseMarkdownToArticleHtml(prepared.markdown, articleLanguage),
    [articleLanguage, prepared.markdown],
  );
  const generatedText = useMemo(
    () => contentWritingMarkdownToPlainText(prepared.markdown),
    [prepared.markdown],
  );
  const currentWordCount = countWords(currentText);
  const generatedWordCount = countWords(generatedText);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!isApplying) {
          event.preventDefault();
          onClose();
        }
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(element => !element.hasAttribute('disabled'));
      if (focusable.length === 0) return;
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
  }, [isApplying, onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[170] flex items-center justify-center bg-black/65 sm:p-4"
      role="presentation"
      onMouseDown={event => {
        if (!isApplying && event.currentTarget === event.target) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="content-writing-review-title"
        dir={isArabic ? 'rtl' : 'ltr'}
        className="flex h-[100dvh] w-full flex-col overflow-hidden bg-white text-start shadow-2xl dark:bg-[#1F1F1F] sm:h-[min(90vh,900px)] sm:w-[min(1280px,calc(100vw-2rem))] sm:rounded-lg sm:border sm:border-gray-200 sm:dark:border-[#3C3C3C]"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-gray-200 px-4 py-3 dark:border-[#3C3C3C]">
          <FileText size={19} className="mt-0.5 shrink-0 text-[#b8922e]" />
          <div className="min-w-0 flex-1">
            <h2 id="content-writing-review-title" className="truncate text-base font-black text-gray-900 dark:text-gray-100">
              {isArabic ? 'مراجعة المقالة قبل الإدراج' : 'Review article before insertion'}
            </h2>
            <div className="mt-1 truncate text-xs font-bold text-gray-500 dark:text-gray-400">{articleTitle}</div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            disabled={isApplying}
            title={isArabic ? 'إغلاق' : 'Close'}
            aria-label={isArabic ? 'إغلاق' : 'Close'}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-500/10"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-b border-gray-200 bg-gray-50 px-4 py-2 text-[11px] font-bold text-gray-500 dark:border-[#3C3C3C] dark:bg-[#242424] dark:text-gray-400">
          <span>{isArabic ? 'الحالي' : 'Current'}: {currentWordCount.toLocaleString(isArabic ? 'ar' : 'en')} {isArabic ? 'كلمة' : 'words'}</span>
          <span>{isArabic ? 'المقترح' : 'Proposed'}: {generatedWordCount.toLocaleString(isArabic ? 'ar' : 'en')} {isArabic ? 'كلمة' : 'words'}</span>
          <span className={generatedWordCount >= currentWordCount ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300'}>
            {isArabic ? 'الفرق' : 'Difference'}: {(generatedWordCount - currentWordCount).toLocaleString(isArabic ? 'ar' : 'en')}
          </span>
        </div>

        {prepared.leadingTitle && !prepared.titleMatchesArticle && (
          <div className="flex shrink-0 items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>
              {isArabic
                ? `اقترح النموذج عنوانًا مختلفًا: «${prepared.leadingTitle}». سيبقى عنوان المقالة الحالي كما هو.`
                : `The model proposed a different title: “${prepared.leadingTitle}”. The saved article title will remain unchanged.`}
            </span>
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto custom-scrollbar lg:grid lg:grid-cols-2 lg:overflow-hidden">
          <section className="min-h-0 border-b border-gray-200 lg:flex lg:flex-col lg:border-b-0 lg:border-e dark:border-[#3C3C3C]">
            <div className="sticky top-0 z-10 border-b border-gray-200 bg-white px-4 py-2 text-xs font-black text-gray-700 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200 lg:static">
              {isArabic ? 'النص الحالي' : 'Current article'}
            </div>
            <div dir={articleLanguage === 'ar' ? 'rtl' : 'ltr'} className="ai-output min-h-[18rem] flex-1 overflow-y-auto p-4 text-sm leading-7 text-gray-800 custom-scrollbar dark:text-gray-100" dangerouslySetInnerHTML={{ __html: currentHtml }} />
          </section>

          <section className="min-h-0 lg:flex lg:flex-col">
            <div className="sticky top-0 z-10 border-b border-gray-200 bg-white px-4 py-2 text-xs font-black text-[#8a6f1d] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-[#f2d675] lg:static">
              {isArabic ? 'النص المقترح' : 'Proposed article'}
            </div>
            <div dir={articleLanguage === 'ar' ? 'rtl' : 'ltr'} className="ai-output min-h-[18rem] flex-1 overflow-y-auto p-4 text-sm leading-7 text-gray-800 custom-scrollbar dark:text-gray-100" dangerouslySetInnerHTML={{ __html: generatedHtml }} />
          </section>
        </main>

        <footer className="flex shrink-0 flex-col gap-2 border-t border-gray-200 bg-white px-4 py-3 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] sm:flex-row sm:items-center sm:justify-between">
          <div className="text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
            {isArabic
              ? 'سيُحفظ النص الحالي أولًا، ثم يُستبدل جسم المقالة ويُحفظ في Supabase.'
              : 'The current text is saved first, then the article body is replaced and saved to Supabase.'}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isApplying}
              className="h-9 rounded-md border border-gray-300 px-3 text-xs font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-[#3C3C3C] dark:text-gray-300 dark:hover:bg-[#2A2A2A]"
            >
              {isArabic ? 'إلغاء' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isApplying || !prepared.markdown}
              className="flex h-9 items-center justify-center gap-2 rounded-md bg-[#d4af37] px-4 text-xs font-black text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isApplying ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              {isApplying
                ? (isArabic ? 'جار الإدراج والحفظ...' : 'Inserting and saving...')
                : (isArabic ? 'اعتماد واستبدال نص المقالة' : 'Approve and replace article')}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
};

export default ContentWritingReviewModal;
