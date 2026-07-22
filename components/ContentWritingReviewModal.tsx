import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  FileText,
  Loader2,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';
import { parseMarkdownToArticleHtml } from '../utils/editorUtils';
import {
  contentWritingMarkdownToPlainText,
  prepareContentWritingResultForEditor,
} from '../utils/contentWritingWorkflow';
import type { ContentWritingQualityReport } from '../utils/contentWritingQuality';

type ContentWritingReviewModalProps = {
  articleTitle: string;
  articleLanguage: 'ar' | 'en';
  locale: 'ar' | 'en';
  currentHtml: string;
  currentText: string;
  resultMarkdown: string;
  qualityReport: ContentWritingQualityReport;
  allowQualityOverride: boolean;
  isApplying: boolean;
  onConfirm: (qualityOverrideReason?: string) => void;
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
  qualityReport,
  allowQualityOverride,
  isApplying,
  onConfirm,
  onClose,
}) => {
  const isArabic = locale === 'ar';
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [qualityOverrideReason, setQualityOverrideReason] = useState('');
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
  const qualityNeedsOverride = !qualityReport.passed;
  const canOverrideQuality = allowQualityOverride && qualityOverrideReason.trim().length >= 8;

  useEffect(() => {
    setQualityOverrideReason('');
  }, [qualityReport.generatedAt, resultMarkdown]);

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

        <section className={`shrink-0 border-b px-4 py-3 ${qualityReport.passed
          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-900/15'
          : 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-900/15'}`}>
          <div className="flex flex-wrap items-center gap-3">
            <ShieldCheck size={18} className={qualityReport.passed ? 'text-emerald-600' : 'text-red-600'} />
            <div className="font-black text-gray-900 dark:text-gray-100">
              {isArabic ? 'بوابة الجودة' : 'Quality gate'}: {qualityReport.score}/100
            </div>
            <span className="text-xs font-bold text-gray-600 dark:text-gray-300">
              {isArabic ? 'المطلوب' : 'Required'}: {qualityReport.minimumScore}/100
            </span>
            <span className={`rounded-full px-2 py-1 text-[10px] font-black ${qualityReport.passed
              ? 'bg-emerald-600 text-white'
              : 'bg-red-600 text-white'}`}>
              {qualityReport.passed
                ? (isArabic ? 'مجتازة' : 'Passed')
                : (isArabic ? 'تحتاج إصلاحًا' : 'Needs repair')}
            </span>
            <span className="text-[10px] font-bold text-gray-500 dark:text-gray-400">
              {isArabic ? 'السياسة' : 'Policy'} v{qualityReport.policyVersion} · {isArabic ? 'إصلاحات' : 'Repairs'} {qualityReport.repairPasses}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-black">
            <span className="rounded bg-emerald-100 px-2 py-1 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">✓ {qualityReport.passedCount}</span>
            <span className="rounded bg-amber-100 px-2 py-1 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">! {qualityReport.warningCount}</span>
            <span className="rounded bg-red-100 px-2 py-1 text-red-700 dark:bg-red-900/30 dark:text-red-300">× {qualityReport.failedCount}</span>
            <span className="rounded bg-red-100 px-2 py-1 text-red-800 dark:bg-red-900/30 dark:text-red-200">
              {isArabic ? 'حرجة' : 'Blocking'}: {qualityReport.blockingFailureCount}
            </span>
          </div>
          {(qualityReport.failedCount > 0 || qualityReport.warningCount > 0) && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-black text-gray-700 dark:text-gray-200">
                {isArabic ? 'عرض المعايير غير المجتازة' : 'Show unmet criteria'}
              </summary>
              <div className="mt-2 max-h-44 space-y-1 overflow-y-auto custom-scrollbar">
                {qualityReport.criteria
                  .filter(criterion => criterion.status === 'fail' || criterion.status === 'warn')
                  .map(criterion => (
                    <div key={criterion.id} className="rounded-md bg-white/80 px-2 py-1.5 text-[10px] font-bold text-gray-700 dark:bg-black/15 dark:text-gray-200">
                      <span className={criterion.status === 'fail' ? 'text-red-600 dark:text-red-300' : 'text-amber-600 dark:text-amber-300'}>
                        {criterion.status === 'fail' ? '×' : '!'} {criterion.title}
                      </span>
                      <span className="ms-2 text-gray-500 dark:text-gray-400">
                        {String(criterion.current)} / {String(criterion.required)}
                      </span>
                    </div>
                  ))}
              </div>
            </details>
          )}
          {qualityNeedsOverride && allowQualityOverride && (
            <label className="mt-3 block">
              <span className="mb-1 block text-xs font-black text-red-700 dark:text-red-300">
                {isArabic ? 'سبب تجاوز بوابة الجودة بواسطة المشرف' : 'Administrator quality override reason'}
              </span>
              <textarea
                value={qualityOverrideReason}
                onChange={event => setQualityOverrideReason(event.target.value)}
                rows={2}
                maxLength={500}
                placeholder={isArabic ? 'اكتب سببًا واضحًا من 8 أحرف على الأقل.' : 'Enter a clear reason of at least 8 characters.'}
                className="w-full rounded-md border border-red-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-red-500 dark:border-red-900/60 dark:bg-[#1F1F1F]"
              />
            </label>
          )}
        </section>

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
              onClick={() => onConfirm(qualityNeedsOverride ? qualityOverrideReason.trim() : undefined)}
              disabled={isApplying || !prepared.markdown || (qualityNeedsOverride && !canOverrideQuality)}
              className="flex h-9 items-center justify-center gap-2 rounded-md bg-[#d4af37] px-4 text-xs font-black text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isApplying ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              {isApplying
                ? (isArabic ? 'جار الإدراج والحفظ...' : 'Inserting and saving...')
                : qualityNeedsOverride
                  ? (isArabic ? 'تجاوز الجودة واعتماد المقالة' : 'Override quality and approve')
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
