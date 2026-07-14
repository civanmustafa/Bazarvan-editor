import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import type { GoalContext } from '../types';
import CompetitorDiscoveryPanel from './CompetitorDiscoveryPanel';

type CompetitorDiscoveryModalProps = {
  articleId: string;
  articleTitle: string;
  primaryKeyword: string;
  articleLanguage: 'ar' | 'en';
  goalContext: GoalContext;
  companyName: string;
  locale: 'ar' | 'en';
  onClose: () => void;
};

const ignoreCompetitorChanges = (): void => {};

const CompetitorDiscoveryModal: React.FC<CompetitorDiscoveryModalProps> = ({
  articleId,
  articleTitle,
  primaryKeyword,
  articleLanguage,
  goalContext,
  companyName,
  locale,
  onClose,
}) => {
  const isArabic = locale === 'ar';

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-3 backdrop-blur-[1px] sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={isArabic ? 'اكتشاف المنافسين' : 'Competitor discovery'}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-[#3C3C3C] dark:bg-[#242424]"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-[#3C3C3C]">
          <div className="flex min-w-0 items-center gap-2">
            <Search size={17} className="shrink-0 text-[#d4af37]" />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-black text-gray-800 dark:text-gray-100">
                {isArabic ? 'اكتشاف المنافسين ومراجعتهم' : 'Discover and review competitors'}
              </h2>
              <p className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400" dir="auto">
                {articleTitle || primaryKeyword}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-[#333] dark:hover:text-gray-100"
            title={isArabic ? 'إغلاق' : 'Close'}
          >
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 custom-scrollbar">
          <CompetitorDiscoveryPanel
            articleId={articleId}
            articleTitle={articleTitle}
            primaryKeyword={primaryKeyword}
            articleLanguage={articleLanguage}
            goalContext={goalContext}
            companyName={companyName}
            locale={locale}
            onCompetitorsChange={ignoreCompetitorChanges}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default CompetitorDiscoveryModal;
