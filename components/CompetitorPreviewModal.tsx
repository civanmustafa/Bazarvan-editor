import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  ExternalLink,
  FileText,
  Globe2,
  ListTree,
  LoaderCircle,
  X,
} from 'lucide-react';
import type { CompetitorPreview } from '../utils/competitorDiscovery';

export type CompetitorPreviewTarget = {
  url: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  description: string;
  position: number;
};

type CompetitorPreviewModalProps = {
  target: CompetitorPreviewTarget;
  preview: CompetitorPreview | null;
  isLoading: boolean;
  error: string;
  locale: 'ar' | 'en';
  currentIndex: number;
  totalItems: number;
  canSelect: boolean;
  isSelected: boolean;
  onLoadPreview: () => void;
  onToggleSelection: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
};

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const formatPreviewDate = (value: string, locale: 'ar' | 'en'): string => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(locale === 'ar' ? 'ar' : 'en');
};

const CompetitorPreviewModal: React.FC<CompetitorPreviewModalProps> = ({
  target,
  preview,
  isLoading,
  error,
  locale,
  currentIndex,
  totalItems,
  canSelect,
  isSelected,
  onLoadPreview,
  onToggleSelection,
  onPrevious,
  onNext,
  onClose,
}) => {
  const isArabic = locale === 'ar';
  const [activeView, setActiveView] = useState<'content' | 'headings'>('content');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setActiveView('content');
  }, [target.canonicalUrl]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector),
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
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  const pageUrl = target.canonicalUrl || target.url;
  const headings = preview?.headings || { h1: [], h2: [], h3: [] };
  const headingGroups = [
    { level: 'H1', items: headings.h1 },
    { level: 'H2', items: headings.h2 },
    { level: 'H3', items: headings.h3 },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[160] flex items-center justify-center bg-black/65 sm:p-4"
      role="presentation"
      onMouseDown={event => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="competitor-preview-title"
        dir={isArabic ? 'rtl' : 'ltr'}
        className="flex h-[100dvh] w-full flex-col overflow-hidden bg-white text-start shadow-2xl dark:bg-[#1F1F1F] sm:h-[min(86vh,850px)] sm:w-[min(1100px,calc(100vw-2rem))] sm:rounded-lg sm:border sm:border-gray-200 sm:dark:border-[#3C3C3C]"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-gray-200 px-4 py-3 dark:border-[#3C3C3C]">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="competitor-preview-title" className="min-w-0 truncate text-base font-black text-gray-900 dark:text-gray-100">
                {preview?.title || target.title || target.domain}
              </h2>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-black text-gray-500 dark:bg-[#333] dark:text-gray-300">
                {currentIndex + 1}/{totalItems}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] font-bold text-[#8a6f1d] dark:text-[#f2d675]" dir="ltr">
              <Globe2 size={12} className="shrink-0" />
              <span className="truncate">{target.domain}</span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onPrevious}
              disabled={totalItems <= 1}
              title={isArabic ? 'المنافس السابق' : 'Previous competitor'}
              className="flex size-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-35 dark:hover:bg-[#333]"
            >
              {isArabic ? <ArrowRight size={17} /> : <ArrowLeft size={17} />}
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={totalItems <= 1}
              title={isArabic ? 'المنافس التالي' : 'Next competitor'}
              className="flex size-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-35 dark:hover:bg-[#333]"
            >
              {isArabic ? <ArrowLeft size={17} /> : <ArrowRight size={17} />}
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              title={isArabic ? 'إغلاق المعاينة' : 'Close preview'}
              className="flex size-8 items-center justify-center rounded-md text-gray-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden lg:grid lg:grid-cols-[minmax(0,1fr)_260px]">
          <main className="flex h-full min-h-0 flex-col">
            {preview && (
              <div className="grid shrink-0 grid-cols-2 gap-1 border-b border-gray-200 bg-gray-50 p-1.5 dark:border-[#3C3C3C] dark:bg-[#242424]">
                <button
                  type="button"
                  onClick={() => setActiveView('content')}
                  className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-black ${activeView === 'content' ? 'bg-white text-[#8a6f1d] shadow-sm dark:bg-[#333] dark:text-[#f2d675]' : 'text-gray-500 dark:text-gray-400'}`}
                >
                  <FileText size={14} />
                  {isArabic ? 'المحتوى' : 'Content'}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveView('headings')}
                  className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-black ${activeView === 'headings' ? 'bg-white text-[#8a6f1d] shadow-sm dark:bg-[#333] dark:text-[#f2d675]' : 'text-gray-500 dark:text-gray-400'}`}
                >
                  <ListTree size={14} />
                  {isArabic ? 'العناوين' : 'Headings'}
                </button>
              </div>
            )}
            {preview && (
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-2 text-[10px] font-bold text-gray-500 dark:border-[#3C3C3C] lg:hidden">
                <span>{preview.wordCount.toLocaleString(isArabic ? 'ar' : 'en')} {isArabic ? 'كلمة' : 'words'}</span>
                <span>
                  {preview.persisted
                    ? (isArabic ? 'محفوظة في المقالة' : 'Saved in article')
                    : preview.cacheHit
                      ? (isArabic ? 'نسخة مؤقتة' : 'Cached preview')
                      : (isArabic ? 'سُحبت الآن' : 'Fetched now')}
                </span>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 custom-scrollbar sm:px-6">
              {!preview ? (
                <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center py-8 text-center">
                  <Globe2 size={34} className="mx-auto text-[#d4af37]" />
                  <h3 className="mt-4 text-lg font-black text-gray-900 dark:text-gray-100">
                    {target.title || target.domain}
                  </h3>
                  {target.description && (
                    <p className="mt-3 text-sm leading-7 text-gray-600 dark:text-gray-300" dir="auto">
                      {target.description}
                    </p>
                  )}
                  <p className="mt-4 text-xs leading-6 text-gray-500 dark:text-gray-400">
                    {isArabic
                      ? 'يتم تحميل المحتوى الرئيسي فقط عند الطلب لتجنب استهلاك حصة Firecrawl على نتائج لن تختارها.'
                      : 'Main content is loaded only on demand to avoid spending Firecrawl quota on unused results.'}
                  </p>
                  <button
                    type="button"
                    onClick={onLoadPreview}
                    disabled={isLoading}
                    className="mx-auto mt-5 flex min-h-10 items-center justify-center gap-2 rounded-md bg-[#d4af37] px-5 py-2 text-sm font-black text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isLoading ? <LoaderCircle size={17} className="animate-spin" /> : <FileText size={17} />}
                    {isLoading
                      ? (isArabic ? 'جاري تحميل المعاينة...' : 'Loading preview...')
                      : (isArabic ? 'تحميل المعاينة الكاملة' : 'Load full preview')}
                  </button>
                </div>
              ) : activeView === 'content' ? (
                <article className="mx-auto max-w-3xl whitespace-pre-wrap text-sm leading-8 text-gray-800 dark:text-gray-200" dir="auto">
                  {preview.text}
                </article>
              ) : (
                <div className="mx-auto max-w-3xl space-y-6">
                  {headingGroups.map(group => (
                    <section key={group.level}>
                      <div className="mb-2 flex items-center gap-2 border-b border-gray-200 pb-2 dark:border-[#3C3C3C]">
                        <span className="text-xs font-black text-[#8a6f1d] dark:text-[#f2d675]">{group.level}</span>
                        <span className="text-[10px] font-bold text-gray-400">{group.items.length}</span>
                      </div>
                      {group.items.length > 0 ? (
                        <ol className="space-y-2">
                          {group.items.map((heading, index) => (
                            <li key={`${group.level}-${index}`} className="flex gap-2 text-sm leading-6 text-gray-700 dark:text-gray-200" dir="auto">
                              <span className="shrink-0 text-[10px] font-black text-gray-400">{index + 1}</span>
                              <span>{heading}</span>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="text-xs text-gray-400">{isArabic ? 'لا توجد عناوين من هذا المستوى.' : 'No headings at this level.'}</p>
                      )}
                    </section>
                  ))}
                </div>
              )}

              {error && (
                <div className="mx-auto mt-4 max-w-2xl rounded-md bg-red-50 px-3 py-2 text-xs font-bold leading-6 text-red-700 dark:bg-red-500/10 dark:text-red-300">
                  {error}
                </div>
              )}
            </div>
          </main>

          <aside className="hidden overflow-y-auto border-s border-gray-200 px-4 py-5 dark:border-[#3C3C3C] lg:block custom-scrollbar">
            <div className="space-y-5 text-xs">
              <div>
                <div className="font-black text-gray-800 dark:text-gray-100">{isArabic ? 'المصدر' : 'Source'}</div>
                <div className="mt-1 break-all leading-5 text-gray-500" dir="ltr">{pageUrl}</div>
              </div>
              {preview && (
                <>
                  <div>
                    <div className="font-black text-gray-800 dark:text-gray-100">{isArabic ? 'حجم المحتوى' : 'Content size'}</div>
                    <div className="mt-1 text-gray-500">{preview.wordCount.toLocaleString(isArabic ? 'ar' : 'en')} {isArabic ? 'كلمة' : 'words'}</div>
                  </div>
                  <div>
                    <div className="font-black text-gray-800 dark:text-gray-100">{isArabic ? 'المعاينة' : 'Preview'}</div>
                    <div className="mt-1 text-gray-500">
                      {preview.cacheHit
                        ? (isArabic ? 'نسخة مؤقتة محفوظة' : 'Saved temporary copy')
                        : preview.persisted
                          ? (isArabic ? 'محفوظة في المقالة' : 'Saved in article')
                          : (isArabic ? 'تم سحبها الآن' : 'Fetched now')}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 font-black text-gray-800 dark:text-gray-100"><Clock3 size={13} />{isArabic ? 'تاريخ السحب' : 'Fetched at'}</div>
                    <div className="mt-1 leading-5 text-gray-500">{formatPreviewDate(preview.fetchedAt, locale)}</div>
                  </div>
                </>
              )}
            </div>
          </aside>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-gray-200 bg-gray-50 px-3 py-3 dark:border-[#3C3C3C] dark:bg-[#242424] sm:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {canSelect && (
              <button
                type="button"
                onClick={onToggleSelection}
                className={`flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-black ${isSelected ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-[#d4af37] text-white hover:bg-[#b8922e]'}`}
              >
                <Check size={15} />
                {isSelected
                  ? (isArabic ? 'إلغاء الاختيار' : 'Remove selection')
                  : (isArabic ? 'اختيار المنافس' : 'Select competitor')}
              </button>
            )}
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-xs font-black text-gray-600 hover:bg-white hover:text-[#8a6f1d] dark:border-[#444] dark:text-gray-300 dark:hover:bg-[#333] dark:hover:text-[#f2d675]"
            >
              <ExternalLink size={14} />
              {isArabic ? 'فتح الأصل' : 'Open original'}
            </a>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-9 rounded-md px-3 py-2 text-xs font-black text-gray-500 hover:bg-gray-200 dark:hover:bg-[#333]"
          >
            {isArabic ? 'إغلاق' : 'Close'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
};

export default CompetitorPreviewModal;
