import React, { useCallback, useEffect, useState } from 'react';
import { Languages, Lightbulb } from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import { useEditorSelector } from '../contexts/EditorContext';
import { ARTICLE_STATUS_DEFINITIONS } from '../constants/articleStatuses';

const ARTICLE_ACCESS_ROLE_LABELS: Record<string, { ar: string; en: string }> = {
  viewer: { ar: 'عرض', en: 'View' },
  editor: { ar: 'تعديل', en: 'Edit' },
};

interface TipsCarouselProps {
  interval?: number;
}

const TipsCarousel: React.FC<TipsCarouselProps> = ({ interval = 20000 }) => {
  const { t, isIdle, uiLanguage } = useUser();
  const articleLanguage = useEditorSelector(context => context.articleLanguage);
  const handleLanguageChange = useEditorSelector(context => context.handleLanguageChange);
  const activeArticleSettings = useEditorSelector(context => context.activeArticleSettings);
  const handleActiveArticleStatusChange = useEditorSelector(context => context.handleActiveArticleStatusChange);
  const tips = t.proTips;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(true);
  const [isStatusSaving, setIsStatusSaving] = useState(false);

  const handleStatusChange = useCallback(async (status: string) => {
    setIsStatusSaving(true);
    const saved = await handleActiveArticleStatusChange(status as any);
    setIsStatusSaving(false);
    if (!saved) {
      alert(uiLanguage === 'ar'
        ? 'تعذر تغيير حالة المقالة من داخل المحرر. حاول مرة أخرى.'
        : 'Could not change the article status. Please try again.');
    }
  }, [handleActiveArticleStatusChange, uiLanguage]);

  useEffect(() => {
    if (tips.length === 0) return;

    const timer = setInterval(() => {
      setIsVisible(false);
      setTimeout(() => {
        setCurrentIndex(prevIndex => (prevIndex + 1) % tips.length);
        setIsVisible(true);
      }, 300);
    }, interval);

    return () => clearInterval(timer);
  }, [tips, interval]);

  if (tips.length === 0) return null;

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 bg-[#d4af37]/10 px-3 py-1.5 text-sm text-[#333333] dark:bg-[#d4af37]/20 dark:text-[#b7b7b7]">
      <div className="flex min-w-[260px] flex-1 items-center gap-3">
        <Lightbulb size={16} className="flex-shrink-0 text-[#d4af37] dark:text-[#f2d675]" />
        <p
          className="min-h-[1.25rem] flex-grow transition-opacity duration-300"
          style={{ opacity: isVisible ? 1 : 0 }}
        >
          {tips[currentIndex]}
        </p>
      </div>

      <div className="ms-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
        {activeArticleSettings.status && (
          <label className="inline-flex h-7 items-center gap-1 rounded-md bg-white/55 px-2 text-[11px] font-black text-[#806718] dark:bg-black/15 dark:text-[#f2d675]">
            <span>{uiLanguage === 'ar' ? 'الحالة:' : 'Status:'}</span>
            <select
              value={activeArticleSettings.status}
              disabled={isStatusSaving}
              onChange={(event) => { void handleStatusChange(event.target.value); }}
              className="max-w-[132px] bg-transparent text-[11px] font-black outline-none disabled:opacity-60"
            >
              {ARTICLE_STATUS_DEFINITIONS.map(({ value, labelAr, labelEn }) => (
                <option key={value} value={value}>{uiLanguage === 'ar' ? labelAr : labelEn}</option>
              ))}
            </select>
          </label>
        )}

        {activeArticleSettings.accessRole && (
          <span className="inline-flex h-7 items-center rounded-md bg-white/55 px-2 text-[11px] font-black text-gray-600 dark:bg-black/15 dark:text-gray-300">
            {uiLanguage === 'ar' ? 'الصلاحية:' : 'Access:'}{' '}
            {ARTICLE_ACCESS_ROLE_LABELS[activeArticleSettings.accessRole]?.[uiLanguage] || activeArticleSettings.accessRole}
          </span>
        )}

        <button
          type="button"
          onClick={() => handleLanguageChange(articleLanguage === 'ar' ? 'en' : 'ar')}
          aria-label={t.toggleArticleLanguage}
          title={t.toggleArticleLanguage}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-white/55 px-2 text-xs font-black text-gray-700 transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] dark:bg-black/15 dark:text-gray-200 dark:hover:bg-black/25"
        >
          <Languages size={15} />
          <span>{articleLanguage.toUpperCase()}</span>
        </button>

        <div className="flex h-7 items-center gap-1.5 rounded-md bg-white/55 px-2 dark:bg-black/15" title={isIdle ? t.idle : t.active}>
          <span className={`h-2.5 w-2.5 rounded-full transition-colors duration-500 ${isIdle ? 'animate-pulse bg-yellow-500' : 'bg-green-500'}`} />
          <span className="select-none text-xs font-bold text-gray-600 dark:text-gray-300">{isIdle ? t.idle : t.active}</span>
        </div>
      </div>
    </div>
  );
};

export default TipsCarousel;
