import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { DuplicateAnalysis, DuplicateStats, DuplicatePhrase } from '../types';
import { ChevronDown, Eye, Copy, FileText, Sparkles, CopyX, Repeat, Key } from 'lucide-react';
import { SECONDARY_COLORS } from '../constants';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useInteraction } from '../contexts/InteractionContext';

const StatDisplay: React.FC<{ icon: React.ReactNode; value: number | string; label: string }> = ({ icon, value, label }) => (
    <div title={label} className="flex-1 flex items-center justify-center gap-2 p-2 text-center flex-col cursor-help">
      <div className="p-2 bg-[#d4af37]/10 dark:bg-[#d4af37]/20 text-[#d4af37] rounded-full">
        {icon}
      </div>
      <div className="font-bold text-base text-[#333333] dark:text-[#b7b7b7]">{value}</div>
    </div>
);

const usePrevious = <T,>(value: T): T | undefined => {
    const ref = useRef<T | undefined>(undefined);
    useEffect(() => {
        ref.current = value;
    });
    return ref.current;
};

const DuplicatesTab: React.FC = () => {
  const { uiLanguage } = useUser();
  const { editor, analysisResults } = useEditor();
  const { clearAllHighlights, applyHighlights, highlightedItem, setHighlightedItem } = useInteraction();
  
  const { duplicateAnalysis: analysis, duplicateStats: stats } = analysisResults;
  
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    '2': false, '3': false, '4': false, '5': false, '6': false, '7': false, '8': false
  });
  const prevAnalysis = usePrevious(analysis);
  const t = translations[uiLanguage].duplicatesTab;
  const tLeftSidebar = translations[uiLanguage].leftSidebar;

  useEffect(() => {
    if (!editor || !prevAnalysis || !Array.isArray(highlightedItem) || highlightedItem.length === 0 || analysis === prevAnalysis) {
      return;
    }

    const newAllDuplicateTexts = new Set(
      (Object.values(analysis).flat() as DuplicatePhrase[]).map(p => p.text)
    );
    const stillDuplicateHighlights = (highlightedItem as { text: string; color: string }[]).filter(h => newAllDuplicateTexts.has(h.text));
    
    const stillTexts = stillDuplicateHighlights.map(h => h.text).sort().join(',');
    const currentTexts = (highlightedItem as { text: string }[]).map(h => h.text).sort().join(',');

    if (stillTexts !== currentTexts) {
      setHighlightedItem(stillDuplicateHighlights);
    }
    
    setTimeout(() => {
      if (editor && !editor.isDestroyed) {
        applyHighlights(stillDuplicateHighlights, false);
      }
    }, 0);
    
  }, [analysis, prevAnalysis, editor, highlightedItem, setHighlightedItem, applyHighlights]);

  const toggleSection = (key: string) => {
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));
  };
  
  const handlePhraseClick = (phrase: DuplicatePhrase, color: string) => {
    const phraseHighlight = { text: phrase.text, color: color };

    const currentHighlights = Array.isArray(highlightedItem) ? [...highlightedItem] : [];
    const itemIndex = currentHighlights.findIndex(h => h.text === phrase.text);

    let newHighlights;

    if (itemIndex > -1) {
      newHighlights = currentHighlights.filter((_, index) => index !== itemIndex);
    } else {
      newHighlights = [...currentHighlights, phraseHighlight];
    }
    
    if (newHighlights.length === 0) {
      clearAllHighlights();
    } else {
      const shouldScroll = currentHighlights.length === 0 && newHighlights.length === 1;
      applyHighlights(newHighlights, shouldScroll);
      setHighlightedItem(newHighlights);
    }
  };

  const handleHighlightAll = (phrases: DuplicatePhrase[]) => {
      const isAllHighlighted = Array.isArray(highlightedItem) && 
        highlightedItem.length === phrases.length &&
        phrases.every(p => highlightedItem.some(h => h.text === p.text));


      if (isAllHighlighted) {
          clearAllHighlights();
      } else {
          const phraseColors = phrases
            .sort((a, b) => b.count - a.count)
            .map((p, i) => ({ text: p.text, color: SECONDARY_COLORS[i % SECONDARY_COLORS.length] }));
          applyHighlights(phraseColors, false);
          setHighlightedItem(phraseColors);
      }
  };

  const copyAll = (phrases: DuplicatePhrase[]) => {
      navigator.clipboard.writeText(phrases.map(p => p.text).join('\n'));
  };

  const nGramMap: { [key: string]: string } = {
    '2': t.bigrams, '3': t.trigrams, '4': t.fourGrams, '5': t.fiveGrams,
    '6': t.sixGrams, '7': t.sevenGrams, '8': t.eightGrams
  };

  const uniqueWordsPercentage = stats.totalWords > 0 
    ? Math.round((stats.uniqueWords / stats.totalWords) * 100)
    : 0;

  const uniqueWordsDisplay = `${stats.uniqueWords}/${uniqueWordsPercentage}%`;

  const PhraseList: React.FC<{phrases: DuplicatePhrase[]}> = ({ phrases }) => {
    return (
      <ul 
        className="space-y-2"
      >
        {phrases
        .sort((a, b) => b.count - a.count)
        .map((phrase, index) => {
            const isHighlighted = Array.isArray(highlightedItem) && highlightedItem.some(h => h.text === phrase.text);
            const accentColor = SECONDARY_COLORS[index % SECONDARY_COLORS.length];
            return (
                <li
                    key={phrase.text}
                    onClick={() => handlePhraseClick(phrase, accentColor)}
                    className={`group relative flex justify-between items-center p-2 rounded-md cursor-pointer transition-colors ${uiLanguage === 'ar' ? 'pr-5' : 'pl-5'} ${isHighlighted ? 'bg-[#d4af37]/10 dark:bg-[#d4af37]/30' : 'bg-gray-50 dark:bg-[#2A2A2A] hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20'}`}
                >
                    <div 
                        className={`absolute top-0 h-full w-1.5 ${uiLanguage === 'ar' ? 'right-0 rounded-r-md' : 'left-0 rounded-l-md'}`}
                        style={{ backgroundColor: accentColor }}
                    ></div>
                    
                    <span className="text-[#333333] dark:text-[#8d8d8d] text-sm font-medium flex-grow">{phrase.text}</span>
                    
                    <div className="flex items-center gap-3 ps-1 flex-shrink-0">
                        <span className="text-xs font-semibold bg-[#d4af37]/10 text-[#b8922e] dark:bg-[#d4af37]/20 dark:text-[#f2d675] rounded-full px-2.5 py-0.5">
                            {phrase.count}
                        </span>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                navigator.clipboard.writeText(phrase.text);
                            }}
                            className="p-1.5 rounded-full text-[#d4af37] hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                            title={t.copyAll}
                            aria-label="Copy phrase"
                        >
                            <Copy size={14} />
                        </button>
                    </div>
                </li>
            )
        })}
      </ul>
    );
  };

  return (
    <div className="p-3">
      <div className="p-2 mb-4">
        <div className="flex bg-white dark:bg-gradient-to-r from-[#2A2A2A] via-[#222222] to-[#1F1F1F] rounded-lg border border-gray-200 dark:border-[#3C3C3C]">
          <StatDisplay icon={<FileText size={16} />} value={stats.totalWords} label={t.totalWords} />
          <StatDisplay icon={<Sparkles size={16} />} value={uniqueWordsDisplay} label={t.uniqueWords} />
          <StatDisplay icon={<Repeat size={16} />} value={stats.totalDuplicates} label={t.totalDuplicates} />
          <StatDisplay icon={<Key size={16} />} value={stats.keywordDuplicatesCount} label={t.keywordDuplicates} />
          <StatDisplay icon={<CopyX size={16} />} value={stats.commonDuplicatesCount} label={t.commonDuplicates} />
        </div>
      </div>

      {Object.entries(analysis)
        .reverse()
        .filter(([_, phrases]) => (phrases as any[]).length > 0)
        .map(([key, phrases]: [string, DuplicatePhrase[]]) => {
            const totalPhrases = phrases.length;
            const keywordPhrasesCount = phrases.filter(p => p.containsKeyword).length;
            const commonPhrasesCount = totalPhrases - keywordPhrasesCount;
            const keywordPercentage = totalPhrases > 0 ? (keywordPhrasesCount / totalPhrases) * 100 : 0;
            const commonPercentage = totalPhrases > 0 ? (commonPhrasesCount / totalPhrases) * 100 : 0;
            const isThisCategoryHighlighted = Array.isArray(highlightedItem) &&
                totalPhrases > 0 &&
                highlightedItem.length === totalPhrases &&
                phrases.every(p => (highlightedItem as any[]).some(h => h.text === p.text));
            const commonPhrases = phrases.filter(p => !p.containsKeyword);
            const keywordPhrases = phrases.filter(p => p.containsKeyword);

            return (
                <div key={key} className="mb-2 bg-white dark:bg-[#2A2A2A] border border-gray-200 dark:border-[#3C3C3C] rounded-lg overflow-hidden transition-all duration-300">
                    <div
                        onClick={() => toggleSection(key)}
                        className="w-full p-3 transition cursor-pointer hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20"
                    >
                        <div className="flex justify-between items-center">
                            <span className="font-bold text-sm text-[#333333] dark:text-[#C7C7C7]">{`${t.phrases} ${nGramMap[key]}`}</span>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleHighlightAll(phrases); }}
                                    className="p-1.5 rounded-full text-gray-500 dark:text-gray-400 hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20"
                                    title={isThisCategoryHighlighted ? t.unhighlightAll : tLeftSidebar.highlightAll}
                                >
                                    <Eye size={16} className={isThisCategoryHighlighted ? "text-[#d4af37]" : ""} />
                                </button>
                                <button
                                    onClick={(e) => { e.stopPropagation(); copyAll(phrases); }}
                                    className="p-1.5 rounded-full text-gray-500 dark:text-gray-400 hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20"
                                    title={t.copyAll}
                                >
                                    <Copy size={16} />
                                </button>
                                <ChevronDown className={`transition-transform text-gray-500 dark:text-gray-400 ${openSections[key] ? 'rotate-180' : ''}`} />
                            </div>
                        </div>
                        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 flex justify-between items-center">
                            <div className="flex gap-4">
                                <span><span className="font-bold text-[#333] dark:text-gray-300">{totalPhrases}</span> {t.phrases}</span>
                                <span className="text-[#d4af37] dark:text-[#f2d675]"><span className="font-bold">{keywordPhrasesCount}</span> {t.keyword}</span>
                                <span className="text-gray-600 dark:text-gray-300"><span className="font-bold">{commonPhrasesCount}</span> {t.common}</span>
                            </div>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-[#1F1F1F] rounded-full h-1.5 mt-2 flex overflow-hidden">
                            <div className="bg-[#d4af37]/100 h-full" style={{ width: `${keywordPercentage}%` }} title={`${t.keyword}: ${keywordPercentage.toFixed(1)}%`}></div>
                            <div className="bg-gray-400 dark:bg-gray-500 h-full" style={{ width: `${commonPercentage}%` }} title={`${t.common}: ${commonPercentage.toFixed(1)}%`}></div>
                        </div>
                    </div>
                    {openSections[key] && (
                        <div className="p-3 border-t border-gray-200 dark:border-[#3C3C3C] bg-gray-50/50 dark:bg-[#1F1F1F]">
                          {commonPhrases.length > 0 && <PhraseList phrases={commonPhrases} />}
                          
                          {keywordPhrases.length > 0 && (
                            <>
                              {commonPhrases.length > 0 && (
                                <h5 className="mt-4 pt-3 border-t border-gray-200 dark:border-[#3C3C3C] text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-2">
                                  <Key size={14} />
                                  <span>{t.duplicatesWithKeywords}</span>
                                </h5>
                              )}
                              <div className={commonPhrases.length > 0 ? "mt-2" : ""}>
                                <PhraseList phrases={keywordPhrases} />
                              </div>
                            </>
                          )}
                          
                          {phrases.length === 0 && (
                            <p className="text-sm text-center text-gray-400 dark:text-gray-500 py-4">
                              {t.noDuplicatesInCategory}
                            </p>
                          )}
                        </div>
                    )}
                </div>
            )
        })}
    </div>
  );
};

export default DuplicatesTab;