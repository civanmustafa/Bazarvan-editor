import React from 'react';
import { Languages } from 'lucide-react';
import { translations } from './translations';

interface NewArticleLanguageModalProps {
  t: typeof translations.ar;
  uiLanguage: 'ar' | 'en';
  onChoose: (lang: 'ar' | 'en') => void;
}

const NewArticleLanguageModal: React.FC<NewArticleLanguageModalProps> = ({ t, uiLanguage, onChoose }) => {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 text-start shadow-xl dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-[#d4af37]/15 text-[#d4af37] dark:bg-[#d4af37]/20 dark:text-[#f2d675]">
            <Languages size={22} />
          </div>
          <div>
            <h3 className="text-lg font-bold text-[#333333] dark:text-gray-100">{t.newArticleLanguageTitle}</h3>
            <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              {t.newArticleLanguagePrompt}
            </p>
          </div>
        </div>

        <div className={`mt-6 grid grid-cols-2 gap-3 ${uiLanguage === 'ar' ? 'text-right' : 'text-left'}`}>
          <button
            type="button"
            onClick={() => onChoose('ar')}
            className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center font-bold text-[#333333] transition-colors hover:border-[#d4af37] hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100 dark:hover:bg-[#d4af37]/20"
          >
            {t.arabic}
          </button>
          <button
            type="button"
            onClick={() => onChoose('en')}
            className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center font-bold text-[#333333] transition-colors hover:border-[#d4af37] hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100 dark:hover:bg-[#d4af37]/20"
          >
            {t.english}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewArticleLanguageModal;
