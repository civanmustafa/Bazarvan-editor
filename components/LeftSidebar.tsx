import React, { useState } from 'react';
import { Copy, CheckCircle, XCircle, AlertCircle, Users, ListChecks, X, Eye, Trash2, KeyRound, Repeat, LayoutGrid, ListTree, Plus, Check, Sparkles, Loader2, Hash, Percent } from 'lucide-react';
import DuplicatesTab from './DuplicatesTab';
import GoalTab from './GoalTab';
import { SECONDARY_COLORS } from '../constants';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useInteraction } from '../contexts/InteractionContext';
import { useAI } from '../contexts/AIContext';
import type { Keywords, KeywordAnalysis, AnalysisStatus, KeywordStats, DuplicateAnalysis } from '../types';
import SpiderStats, { SpiderStatMetric } from './SpiderStats';

const getProgressBarColor = (status: AnalysisStatus) => {
    switch (status) {
        case 'pass': return '#d4af37';
        case 'warn': return '#F59E0B';
        case 'fail': return '#810701';
        default: return '#6B7280';
    }
};

const RadialProgress: React.FC<{ progress: number; status: AnalysisStatus; children: React.ReactNode; size?: number; strokeWidth?: number }> = ({ progress, status, children, size = 48, strokeWidth = 3 }) => {
    const color = getProgressBarColor(status);
    const progressValue = Math.min(100, Math.max(0, progress));
    const radius = (size - strokeWidth * 2) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (progressValue / 100) * circumference;

    return (
        <div 
            className="relative inline-flex items-center justify-center"
            style={{ width: `${size}px`, height: `${size}px` }}
        >
            <svg className="absolute top-0 left-0 w-full h-full" viewBox={`0 0 ${size} ${size}`}>
                <circle
                    className="text-gray-200 dark:text-gray-700/50"
                    strokeWidth={strokeWidth}
                    stroke="currentColor"
                    fill="transparent"
                    r={radius}
                    cx={size / 2}
                    cy={size / 2}
                />
                <circle
                    className="transition-all duration-500 -rotate-90 origin-center"
                    strokeWidth={strokeWidth}
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    stroke={color}
                    fill="transparent"
                    r={radius}
                    cx={size / 2}
                    cy={size / 2}
                />
            </svg>
            {children}
        </div>
    );
};


const ModernProgressBar: React.FC<{ analysis: KeywordStats, isCompact?: boolean, t: typeof translations.ar.leftSidebar }> = ({ analysis, isCompact = false, t }) => {
    if (!analysis) return null;
    const progress = analysis.requiredCount[1] > 0 ? Math.min((analysis.count / analysis.requiredCount[1]) * 100, 100) : 0;
    const color = getProgressBarColor(analysis.status);
    const getStatusTextColor = (status: AnalysisStatus) => {
        switch (status) {
            case 'pass': return 'text-green-600 dark:text-green-500';
            case 'warn': return 'text-yellow-500 dark:text-yellow-400';
            case 'fail': return 'text-red-600 dark:text-red-500';
            default: return 'text-gray-700 dark:text-gray-300';
        }
    };
    const textColor = getStatusTextColor(analysis.status);

    return (
        <div className={'space-y-1'}>
            <div className={`flex justify-between items-center ${isCompact ? 'text-xs' : 'text-sm'}`}>
                <span className="font-semibold text-gray-600 dark:text-gray-300">{t.required}: {analysis.requiredCount[0]}-{analysis.requiredCount[1]}</span>
                <span className={`font-bold ${textColor}`}>{t.current}: {analysis.count}</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2 dark:bg-[#1F1F1F] overflow-hidden">
                <div
                    className="h-2 rounded-full transition-all duration-500"
                    style={{ width: `${progress}%`, backgroundColor: color }}
                ></div>
            </div>
        </div>
    );
};

const ModernSection: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode; onClick?: () => void; actions?: React.ReactNode; }> = ({ icon, title, children, onClick, actions }) => (
    <div 
        className={`bg-white dark:bg-[#2A2A2A] rounded-xl shadow-sm border border-gray-300 dark:border-[#3C3C3C] p-2 transition-all duration-200 ${onClick ? 'cursor-pointer hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20' : ''}`}
        onClick={onClick}
    >
        <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="flex min-w-0 items-center gap-2 text-sm font-bold text-[#333333] dark:text-[#C7C7C7]">
                {icon}
                <span className="truncate">{title}</span>
            </h3>
            {actions}
        </div>
        <div className="space-y-2" onClick={onClick ? e => e.stopPropagation() : undefined}>
            {children}
        </div>
    </div>
);

const AdvancedKeywordCard: React.FC<{
  title: string;
  icon: React.ReactNode;
  analysis: KeywordStats;
  actions?: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  t: typeof translations.ar.leftSidebar;
}> = ({ title, icon, analysis, children, actions, onClick, t }) => {
  if (!analysis) return null;
  
  const percentage = analysis.requiredCount[1] > 0 ? (analysis.count / analysis.requiredCount[1]) * 100 : 0;
  const count = Math.round(percentage);

  const getStatusTextColor = (status: AnalysisStatus) => {
    switch (status) {
        case 'pass': return 'text-green-600 dark:text-green-500';
        case 'warn': return 'text-yellow-500 dark:text-yellow-400';
        case 'fail': return 'text-red-600 dark:text-red-500';
        default: return 'text-gray-700 dark:text-gray-300';
    }
  };
  const textColor = getStatusTextColor(analysis.status);

  return (
    <div 
      className={`relative bg-white dark:bg-[#2A2A2A] rounded-xl p-2 space-y-1 transition-all duration-300 border border-gray-300 dark:border-[#3C3C3C] ${onClick ? 'cursor-pointer hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20' : ''}`}
      onClick={onClick}
    >
      <div className="flex justify-between items-center gap-3">
        {/* Main Content */}
        <div className="flex-grow space-y-1">
            <div className="flex items-center gap-2">
                <span className="text-[#d4af37]">{icon}</span>
                <h4 className="text-lg font-bold text-[#333333] dark:text-[#C7C7C7]">{title}</h4>
            </div>
             <div className="text-sm text-gray-500 dark:text-gray-400 pt-2 space-y-1">
                <div className={`font-semibold text-xs ${textColor}`}>
                    <span>{t.current}: </span>
                    <span>{analysis.count} / {(analysis.percentage * 100).toFixed(1)}%</span>
                </div>
                <div className="text-gray-600 dark:text-gray-300 text-xs">
                    <span>{t.required}: </span>
                    <span>{analysis.requiredCount.join('-')} / {(analysis.requiredPercentage[0] * 100).toFixed(1)}-{(analysis.requiredPercentage[1] * 100).toFixed(1)}%</span>
                </div>
            </div>
        </div>
        
        {/* Percentage and Actions */}
        <div className="flex flex-col items-center flex-shrink-0 gap-1 pt-2">
            <RadialProgress progress={percentage} status={analysis.status}>
                <span className={`font-bold ${textColor} flex items-baseline`}>
                    <span className="text-xl">{count}</span>
                    <span className="text-xs">%</span>
                </span>
            </RadialProgress>
            <div className="h-6 flex items-center">
              {actions}
            </div>
        </div>
      </div>
      
      {children}
    </div>
  );
};


const CopyButton: React.FC<{ onCopy: () => void; t: typeof translations.ar.leftSidebar }> = ({ onCopy, t }) => {
    const [copied, setCopied] = useState(false);
    
    return (
        <button
            onClick={(e) => {
                e.stopPropagation();
                onCopy();
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            }}
            className="p-1 rounded-full text-gray-400 hover:bg-[#d4af37]/15 hover:text-[#d4af37] dark:hover:bg-[#d4af37]/20 dark:hover:text-[#f2d675]"
            title={copied ? t.copied : t.copy}
        >
            {copied ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
        </button>
    );
};

const KeywordInput: React.FC<{
  value: string;
  onChange: (val: string) => void;
  placeholder: string;
  onHighlight: () => void;
  isHighlighted: boolean;
  onRemove?: () => void;
  onCopy?: () => void;
  className?: string;
  t: typeof translations.ar.leftSidebar;
}> = ({ value, onChange, placeholder, onHighlight, isHighlighted, onRemove, onCopy, className, t }) => (
  <div
    className="relative group cursor-pointer w-full"
    onClick={onHighlight}
  >
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      className={`w-full py-2 ps-3 pe-14 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-sm text-[#333333] dark:text-[#e0e0e0] ${isHighlighted ? 'ring-2 ring-offset-1 dark:ring-offset-[#181818] ring-[#d4af37]' : ''} ${className}`}
    />
    <div className="absolute end-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
        {onCopy && value && <CopyButton onCopy={onCopy} t={t} />}
        {onRemove && (
            <button
                onClick={(e) => { e.stopPropagation(); onRemove && onRemove(); }}
                className="p-1 rounded-full text-gray-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/50 dark:hover:text-red-400"
                title={t.remove}
            >
                <Trash2 size={16} />
            </button>
        )}
    </div>
  </div>
);

const stripKeywordDots = (value: string): string => value.replace(/\./g, '').trim();

const splitDistributedTerms = (value: string, separator: RegExp): string[] => {
    return value
        .split(separator)
        .map(stripKeywordDots)
        .filter(Boolean);
};

const getKeywordStatScore = (analysis: KeywordStats): number => {
    if (!analysis || analysis.status === 'info') return 0;
    if (analysis.status === 'pass') return 100;
    if (analysis.status === 'warn') return 72;
    const maxRequired = analysis.requiredCount[1] || analysis.requiredCount[0] || 1;
    return Math.min(60, (analysis.count / maxRequired) * 100);
};

const getKeywordStatTone = (analysis: KeywordStats): SpiderStatMetric['tone'] => {
    if (analysis.status === 'pass') return 'good';
    if (analysis.status === 'warn') return 'warn';
    if (analysis.status === 'fail') return 'bad';
    return 'neutral';
};

const MiniStat: React.FC<{ icon: React.ReactNode; value: string | number; title: string; tone?: 'gold' | 'red' | 'green' }> = ({ icon, value, title, tone = 'gold' }) => {
    const toneClass = tone === 'red'
        ? 'text-red-700 bg-red-50 border-red-100 dark:text-red-300 dark:bg-red-900/20 dark:border-red-900/40'
        : tone === 'green'
          ? 'text-emerald-700 bg-emerald-50 border-emerald-100 dark:text-emerald-300 dark:bg-emerald-900/20 dark:border-emerald-900/40'
          : 'text-[#b8922e] bg-[#d4af37]/10 border-[#d4af37]/20 dark:text-[#f2d675] dark:bg-[#d4af37]/15 dark:border-[#d4af37]/25';

    return (
        <div
            className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 ${toneClass}`}
            title={title}
            aria-label={title}
        >
            <span className="flex-shrink-0">{icon}</span>
            <span className="truncate text-[11px] font-black tabular-nums">{value}</span>
        </div>
    );
};


const LeftSidebar: React.FC = () => {
  const { keywordViewMode, uiLanguage, t, clientGoalContexts } = useUser();
  const { keywords, setKeywords, setGoalContext, analysisResults } = useEditor();
  const { applyHighlights, clearAllHighlights, highlightedItem, setHighlightedItem } = useInteraction();
  const { generateSemanticKeywords } = useAI();
  
  const { keywordAnalysis, duplicateAnalysis, duplicateStats } = analysisResults;

  const [activeTab, setActiveTab] = React.useState<'keywords' | 'duplicates'>('keywords');
  const [lsiInputValue, setLsiInputValue] = React.useState('');
  const [autoDistributeText, setAutoDistributeText] = React.useState('');
  const [isGeneratingSemanticKeywords, setIsGeneratingSemanticKeywords] = React.useState(false);
  const [semanticGenerationStatus, setSemanticGenerationStatus] = React.useState('');
  const tLk = t.leftSidebar;
  const savedCompanyNames = React.useMemo(
    () => Object.keys(clientGoalContexts).sort((a, b) => a.localeCompare(b)),
    [clientGoalContexts],
  );

  const getTabClass = (tabName: 'keywords' | 'duplicates') => {
    const isActive = activeTab === tabName;
    return `flex-1 flex items-center justify-center gap-2 py-3 px-4 text-sm font-semibold border-b-2 transition-all duration-200 ${
      isActive
        ? 'border-[#d4af37] text-[#d4af37] dark:text-white'
        : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white'
    }`;
  };
  
  const handleHighlightToggle = (term: string, type: 'primary' | 'company') => {
    if (!term) {
        clearAllHighlights();
        return;
    }
    
    if (highlightedItem === term) {
      clearAllHighlights();
    } else {
      let color: string;
      switch (type) {
        case 'primary':
          color = '#a7f3d0';
          break;
        case 'company':
          color = '#bae6fd';
          break;
      }
      applyHighlights([{ text: term, color: color }]);
      setHighlightedItem(term);
    }
  };

  const applyCompanyGoalContext = React.useCallback((companyName: string) => {
    const preset = clientGoalContexts[companyName.trim()];
    if (preset) {
      setGoalContext(preset);
    }
  }, [clientGoalContexts, setGoalContext]);

  const handleCompanyChange = React.useCallback((companyName: string) => {
    setKeywords(k => ({ ...k, company: companyName }));
    applyCompanyGoalContext(companyName);
  }, [applyCompanyGoalContext, setKeywords]);

  const renderSavedCompanySelect = () => {
    if (savedCompanyNames.length === 0) return null;

    const selectedCompany = keywords.company.trim();
    return (
      <select
        value={clientGoalContexts[selectedCompany] ? selectedCompany : ''}
        onChange={(event) => handleCompanyChange(event.target.value)}
        className="w-full mb-2 rounded-md border border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F] px-2 py-2 text-sm text-[#333333] dark:text-[#e0e0e0] focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37]"
      >
        <option value="">{tLk.chooseSavedCompany}</option>
        {savedCompanyNames.map(companyName => (
          <option key={companyName} value={companyName}>{companyName}</option>
        ))}
      </select>
    );
  };

  const handleSecondaryHighlightToggle = (term: string, index: number) => {
    if (!term.trim()) {
        clearAllHighlights();
        return;
    }
    if (highlightedItem === term) {
        clearAllHighlights();
    } else {
        const color = SECONDARY_COLORS[index % SECONDARY_COLORS.length];
        applyHighlights([{ text: term, color: color }], true);
        setHighlightedItem(term);
    }
  };

  const handleToggleAllSecondariesHighlight = () => {
    const HIGHLIGHT_ID = '__ALL_SECONDARIES__';
    const activeSecondaries = keywords.secondaries.filter(s => s.trim() !== '');
    
    if (activeSecondaries.length === 0) {
        clearAllHighlights();
        return;
    }

    if (highlightedItem === HIGHLIGHT_ID) {
      clearAllHighlights();
    } else {
      const highlights = keywords.secondaries
        .map((term, index) => ({ term, index }))
        .filter(({ term }) => term.trim() !== '')
        .map(({ term, index }) => ({
            text: term,
            color: SECONDARY_COLORS[index % SECONDARY_COLORS.length],
        }));
      applyHighlights(highlights, false);
      setHighlightedItem(HIGHLIGHT_ID);
    }
  };

  const enteredSynonymsCount = keywords.secondaries.filter(s => s.trim() !== '').length;
  const keywordMetricCounts = (status: string) => ({
    problems: status === 'pass' || status === 'info' ? 0 : 1,
    corrected: status === 'pass' ? 1 : 0,
  });

  const keywordDetailSpiderMetrics: SpiderStatMetric[] = [
    {
      label: tLk.primary,
      value: `${keywordAnalysis.primary.count}/${keywordAnalysis.primary.requiredCount[1] || '-'}`,
      score: getKeywordStatScore(keywordAnalysis.primary),
      outerPoint: keywordAnalysis.primary.status === 'pass',
      tone: getKeywordStatTone(keywordAnalysis.primary),
      ...keywordMetricCounts(keywordAnalysis.primary.status),
    },
    {
      label: tLk.synonyms,
      value: `${keywordAnalysis.secondariesDistribution.count}/${keywordAnalysis.secondariesDistribution.requiredCount[1] || '-'}`,
      score: getKeywordStatScore(keywordAnalysis.secondariesDistribution),
      outerPoint: keywordAnalysis.secondariesDistribution.status === 'pass',
      tone: getKeywordStatTone(keywordAnalysis.secondariesDistribution),
      ...keywordMetricCounts(keywordAnalysis.secondariesDistribution.status),
    },
    {
      label: tLk.company,
      value: `${keywordAnalysis.company.count}/${keywordAnalysis.company.requiredCount[1] || '-'}`,
      score: getKeywordStatScore(keywordAnalysis.company),
      outerPoint: keywordAnalysis.company.status === 'pass',
      tone: getKeywordStatTone(keywordAnalysis.company),
      ...keywordMetricCounts(keywordAnalysis.company.status),
    },
    {
      label: 'LSI',
      value: `${keywordAnalysis.lsi.distribution.count}/${keywordAnalysis.lsi.distribution.requiredCount[1] || '-'}`,
      score: getKeywordStatScore(keywordAnalysis.lsi.distribution),
      outerPoint: keywordAnalysis.lsi.distribution.status === 'pass' && keywordAnalysis.lsi.balance.status !== 'fail',
      tone: keywordAnalysis.lsi.balance.status === 'fail' ? 'bad' : getKeywordStatTone(keywordAnalysis.lsi.distribution),
      problems: (keywordAnalysis.lsi.distribution.status === 'pass' || keywordAnalysis.lsi.distribution.status === 'info' ? 0 : 1) + (keywordAnalysis.lsi.balance.status === 'fail' ? 1 : 0),
      corrected: keywordAnalysis.lsi.distribution.status === 'pass' && keywordAnalysis.lsi.balance.status !== 'fail' ? 1 : 0,
    },
  ];

  const duplicateCategoryLabels: Record<keyof DuplicateAnalysis, string> = {
    2: t.duplicatesTab.bigrams,
    3: t.duplicatesTab.trigrams,
    4: t.duplicatesTab.fourGrams,
    5: t.duplicatesTab.fiveGrams,
    6: t.duplicatesTab.sixGrams,
    7: t.duplicatesTab.sevenGrams,
    8: t.duplicatesTab.eightGrams,
  };

  const duplicateHeaderSpiderMetrics: SpiderStatMetric[] = ([8, 7, 6, 5, 4, 3, 2] as (keyof DuplicateAnalysis)[]).map(key => {
    const phrases = duplicateAnalysis[key] || [];
    const repeatedInstances = phrases.reduce((sum, phrase) => sum + Math.max(0, phrase.count - 1), 0);
    const score = repeatedInstances === 0 ? 100 : Math.max(12, 100 - repeatedInstances * 12);
    return {
      label: duplicateCategoryLabels[key],
      value: repeatedInstances,
      score,
      outerPoint: repeatedInstances === 0,
      tone: repeatedInstances === 0 ? 'good' : 'bad',
      problems: repeatedInstances,
      corrected: repeatedInstances === 0 ? 1 : 0,
    };
  });
  const duplicateRepeatedPhrasesCount = (Object.values(duplicateAnalysis).flat() as { count: number }[]).length;
  const duplicateOccurrencesCount = (Object.values(duplicateAnalysis).flat() as { count: number }[]).reduce((sum, phrase) => sum + phrase.count, 0);
  const uniqueWordsPercentage = duplicateStats.totalWords > 0
    ? `${((duplicateStats.uniqueWords / duplicateStats.totalWords) * 100).toFixed(1)}%`
    : '0%';
  const duplicateMiniStats = uiLanguage === 'ar'
    ? {
        repeatedPhrases: 'عدد العبارات المكررة',
        totalOccurrences: 'إجمالي عدد التكرارات',
        uniquePercentage: 'نسبة الكلمات الفريدة في النص',
      }
    : {
        repeatedPhrases: 'Repeated phrases count',
        totalOccurrences: 'Total repetitions count',
        uniquePercentage: 'Unique words percentage',
      };

  const handleAddSecondary = () => {
    setKeywords(k => ({ ...k, secondaries: [...k.secondaries, ''] }));
  };

  const handleRemoveSecondary = (indexToRemove: number) => {
    setKeywords(k => ({ ...k, secondaries: k.secondaries.filter((_, i) => i !== indexToRemove) }));
  };

  // LSI Handlers
    const handleLsiAdd = () => {
        if (!lsiInputValue.trim()) return;
        const newKeywords = splitDistributedTerms(lsiInputValue, /[\n,،*\/#]+/).filter(k => !keywords.lsi.includes(k));
        if (newKeywords.length > 0) {
            setKeywords(prev => ({ ...prev, lsi: [...prev.lsi, ...newKeywords] }));
        }
        setLsiInputValue('');
    };
    const handleLsiKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleLsiAdd();
        }
    };
    const handleLsiPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        e.preventDefault();
        const pastedText = e.clipboardData.getData('text');
        if (!pastedText.trim()) return;
        const newKeywords = splitDistributedTerms(pastedText, /[\n,،*\/#]+/).filter(k => !keywords.lsi.includes(k));
        if (newKeywords.length > 0) {
            setKeywords(prev => ({ ...prev, lsi: [...prev.lsi, ...newKeywords] }));
        }
        setLsiInputValue('');
    };
    const handleLsiRemove = (keywordToRemove: string) => {
        setKeywords(prev => ({ ...prev, lsi: prev.lsi.filter(k => k !== keywordToRemove) }));
    };
    const handleLsiHighlight = (kw: string) => {
        if (highlightedItem === kw) clearAllHighlights();
        else {
            applyHighlights([{ text: kw, color: '#d8b4fe' }], true);
            setHighlightedItem(kw);
        }
    };
    const handleToggleAllLsiHighlights = () => {
        if (highlightedItem === '__ALL_LSI__') {
            clearAllHighlights();
        } else {
            const lsiColors = ['#fecaca', '#fed7aa', '#fef08a', '#d9f99d', '#a7f3d0', '#99f6e4', '#a5f3fc', '#bfdbfe', '#d8b4fe'];
            const highlights = keywords.lsi.map((kw, i) => ({ text: kw, color: lsiColors[i % lsiColors.length] }));
            applyHighlights(highlights, false);
            setHighlightedItem('__ALL_LSI__');
        }
    };
  const handleClearLsi = () => {
        setKeywords(prev => ({ ...prev, lsi: [] }));
        setLsiInputValue('');
        if (highlightedItem === '__ALL_LSI__' || keywords.lsi.includes(highlightedItem as string)) {
            clearAllHighlights();
        }
    };

  const handleGenerateSemanticKeywords = async () => {
    if (!keywords.primary.trim() || isGeneratingSemanticKeywords) {
      setSemanticGenerationStatus(tLk.primaryRequiredForGeneration);
      return;
    }

    setIsGeneratingSemanticKeywords(true);
    setSemanticGenerationStatus('');
    try {
      const result = await generateSemanticKeywords();
      if (result.error) {
        setSemanticGenerationStatus(result.error);
        return;
      }
      setKeywords(prev => ({
        ...prev,
        secondaries: result.secondaries.length > 0 ? result.secondaries : prev.secondaries,
        lsi: result.lsi.length > 0 ? result.lsi : prev.lsi,
      }));
      setLsiInputValue('');
      setSemanticGenerationStatus(tLk.semanticKeywordsGenerated);
    } catch (error) {
      setSemanticGenerationStatus(tLk.semanticKeywordsGenerationFailed);
    } finally {
      setIsGeneratingSemanticKeywords(false);
    }
  };

  const semanticGeneratorControl = (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleGenerateSemanticKeywords}
        disabled={isGeneratingSemanticKeywords || !keywords.primary.trim()}
        className="w-full flex items-center justify-center gap-2 rounded-lg bg-[#d4af37] px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
        title={!keywords.primary.trim() ? tLk.primaryRequiredForGeneration : tLk.generateSemanticKeywords}
      >
        {isGeneratingSemanticKeywords ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
        <span>{isGeneratingSemanticKeywords ? tLk.generatingSemanticKeywords : tLk.generateSemanticKeywords}</span>
      </button>
      {semanticGenerationStatus && (
        <p className={`text-xs font-bold ${semanticGenerationStatus === tLk.semanticKeywordsGenerated ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`} aria-live="polite">
          {semanticGenerationStatus}
        </p>
      )}
    </div>
  );
    
    const handleAutoDistribute = (text: string) => {
        if (!text.trim()) return;
    
        const parts = text.split(/^\s*[\p{P}\p{S}]{2,}\s*$/mu);
    
        const primaryAndSynonymsPart = (parts[0] || '').trim();
        const lsiPart = (parts[1] || '').trim();
        const companyPart = (parts[2] || '').trim();
        const competitorsPart = (parts[3] || '').trim();
    
        const primaryAndSynonymsLines = splitDistributedTerms(primaryAndSynonymsPart, /[\n,،]+/);
        const newPrimary = primaryAndSynonymsLines[0] || keywords.primary;
        const newSecondaries = primaryAndSynonymsLines.length > 1 ? primaryAndSynonymsLines.slice(1) : keywords.secondaries;
    
        const newLsi = lsiPart ? splitDistributedTerms(lsiPart, /[\n,،*\/#]+/) : keywords.lsi;
    
        const companyLines = splitDistributedTerms(companyPart, /[\n,،]+/);
        const newCompany = companyLines[0] || keywords.company;
    
        setKeywords({
            primary: newPrimary,
            secondaries: newSecondaries,
            lsi: newLsi,
            company: newCompany,
        });
        applyCompanyGoalContext(newCompany);

        const competitorUrls = competitorsPart
            ? competitorsPart.split(/\r?\n/).map(url => url.trim()).filter(Boolean).slice(0, 3)
            : [];
        if (competitorUrls.length > 0) {
            window.dispatchEvent(new CustomEvent('bazarvan:auto-distribute-competitors', {
                detail: { urls: competitorUrls },
            }));
        }
    };

    const handlePasteAndDistribute = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        e.preventDefault();
        const pastedText = e.clipboardData.getData('text');
        handleAutoDistribute(pastedText);
        setAutoDistributeText('');
    };


  const renderKeywordsTab = () => {
    const autoDistributeSection = (
        <div className="mb-4">
            <label htmlFor="auto-distribute" className="block text-sm font-bold text-[#333333] dark:text-[#C7C7C7] mb-2">
                {tLk.autoDistribute}
            </label>
            <textarea
                id="auto-distribute"
                rows={4}
                value={autoDistributeText}
                onChange={(e) => setAutoDistributeText(e.target.value)}
                onPaste={handlePasteAndDistribute}
                className="w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-sm text-[#333333] dark:text-[#e0e0e0] custom-scrollbar"
                placeholder={tLk.pasteToDistribute}
            />
        </div>
    );
    if (keywordViewMode === 'modern') {
        return (
          <div className="p-2 space-y-3">
            {autoDistributeSection}
            <ModernSection 
                icon={<KeyRound size={20} />} 
                title={tLk.primaryKeyword}
                onClick={() => handleHighlightToggle(keywords.primary, 'primary')}
            >
                <div onClick={e => e.stopPropagation()}>
                    <KeywordInput 
                        value={keywords.primary}
                        onChange={(val) => setKeywords(k => ({...k, primary: val}))}
                        placeholder={tLk.enterPrimary}
                        onHighlight={() => handleHighlightToggle(keywords.primary, 'primary')}
                        isHighlighted={highlightedItem === keywords.primary}
                        onCopy={() => navigator.clipboard.writeText(keywords.primary)}
                        t={tLk}
                    />
                    <ModernProgressBar analysis={keywordAnalysis.primary} t={tLk} />
                    <div className="space-y-1 pt-2 border-t border-gray-200 dark:border-[#3C3C3C]">
                        {keywordAnalysis.primary.checks.map((check, index) => (
                            <div key={index} className="flex items-center gap-2 text-xs">
                                {check.isMet ? <CheckCircle size={14} className="text-green-500" /> : <XCircle size={14} className="text-red-500" />}
                                <span className="text-gray-600 dark:text-gray-300">{check.text}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </ModernSection>
            {semanticGeneratorControl}
            <ModernSection 
                icon={<ListChecks size={20} />} 
                title={tLk.synonyms}
                onClick={handleToggleAllSecondariesHighlight}
            >
                 <div onClick={e => e.stopPropagation()}>
                    {keywords.secondaries.map((s, i) => (
                        <div key={i}>
                            <div className="flex items-center gap-2">
                            <KeywordInput 
                                    value={s}
                                    onChange={(val) => setKeywords(k => ({...k, secondaries: k.secondaries.map((kw, idx) => idx === i ? val : kw)}))}
                                    placeholder={`${tLk.synonym} ${i + 1}`}
                                    onHighlight={() => handleSecondaryHighlightToggle(s, i)}
                                    isHighlighted={highlightedItem === s}
                                    onRemove={() => handleRemoveSecondary(i)}
                                    onCopy={() => navigator.clipboard.writeText(s)}
                                    t={tLk}
                            />
                            </div>
                            {s.trim() && (
                                <div className="mt-2 pe-1 space-y-2">
                                    <ModernProgressBar analysis={keywordAnalysis.secondaries[i]} isCompact t={tLk} />
                                    <div className="space-y-1 pt-2 border-t border-gray-200 dark:border-[#3C3C3C]">
                                    {keywordAnalysis.secondaries[i].checks.map((check, index) => (
                                        <div key={index} className="flex items-center gap-2 text-xs">
                                            {check.isMet ? <CheckCircle size={14} className="text-green-500" /> : <XCircle size={14} className="text-red-500" />}
                                            <span className="text-gray-600 dark:text-gray-300">{check.text}</span>
                                        </div>
                                    ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                    <button onClick={handleAddSecondary} className="w-full flex items-center justify-center gap-2 py-2 text-sm font-semibold text-[#d4af37] dark:text-[#f2d675] bg-gray-100 dark:bg-[#3C3C3C] rounded-md hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/25">
                        <Plus size={16} /> {tLk.addSynonym}
                    </button>
                    {enteredSynonymsCount > 0 && (
                        <div className="pt-2 border-t border-gray-200 dark:border-[#3C3C3C]">
                            <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2">{tLk.totalSynonymDist}</h4>
                            <ModernProgressBar analysis={keywordAnalysis.secondariesDistribution} t={tLk} />
                        </div>
                    )}
                 </div>
            </ModernSection>
            <ModernSection 
                icon={<Users size={20} />} 
                title={tLk.companyName}
                onClick={() => handleHighlightToggle(keywords.company, 'company')}
            >
                <div onClick={e => e.stopPropagation()}>
                    {renderSavedCompanySelect()}
                    <KeywordInput 
                        value={keywords.company}
                        onChange={handleCompanyChange}
                        placeholder={tLk.enterCompany}
                        onHighlight={() => handleHighlightToggle(keywords.company, 'company')}
                        isHighlighted={highlightedItem === keywords.company}
                        onCopy={() => navigator.clipboard.writeText(keywords.company)}
                        t={tLk}
                    />
                    <ModernProgressBar analysis={keywordAnalysis.company} t={tLk} />
                </div>
            </ModernSection>
            <GoalTab embedded />
            <ModernSection 
                icon={<Repeat size={20} />} 
                title={tLk.lsiKeywords}
                onClick={handleToggleAllLsiHighlights}
                actions={
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleClearLsi(); }}
                        disabled={keywords.lsi.length === 0}
                        className="p-1.5 rounded-full hover:bg-red-100 dark:hover:bg-red-900/50 disabled:cursor-not-allowed disabled:opacity-40"
                        title={tLk.clearAllLsi}
                    >
                        <Trash2 size={16} className="text-red-500 dark:text-red-400" />
                    </button>
                }
            >
                <div onClick={e => e.stopPropagation()}>
                    <textarea
                        value={lsiInputValue}
                        onChange={(e) => setLsiInputValue(e.target.value)}
                        onKeyDown={handleLsiKeyDown}
                        onPaste={handleLsiPaste}
                        rows={2}
                        className="w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-sm text-[#333333] dark:text-[#e0e0e0] custom-scrollbar"
                        placeholder={tLk.addLsiPlaceholder}
                    />
                    <div className="flex items-center gap-2">
                        <button onClick={handleToggleAllLsiHighlights} disabled={keywords.lsi.length === 0} className="flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-[#3C3C3C] rounded-md hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/25 disabled:opacity-50 disabled:cursor-not-allowed">
                            <Eye size={14} /> <span>{tLk.highlightAll}</span>
                        </button>
                    </div>
                    {keywordAnalysis.lsi.balance.status === 'fail' && (
                        <div className={`relative overflow-hidden rounded-lg border p-3 ${uiLanguage === 'ar' ? 'border-r-4' : 'border-l-4'} border-red-300 bg-red-50 text-red-900 dark:border-red-700/50 dark:bg-red-900/20 dark:text-red-200`}>
                             <div className="flex items-start gap-3">
                                <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
                                <div className="text-xs">
                                    <p className="font-bold">{keywordAnalysis.lsi.balance.title}: {keywordAnalysis.lsi.balance.current}</p>
                                    <p className="mt-1">{keywordAnalysis.lsi.balance.description}</p>
                                </div>
                            </div>
                        </div>
                    )}
                    {keywords.lsi.length > 0 && (
                       <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200 dark:border-[#3C3C3C]">
                            {keywords.lsi.map(kw => {
                                const kwAnalysis = keywordAnalysis.lsi.keywords.find(kwa => kwa.text === kw);
                                const count = kwAnalysis ? kwAnalysis.count : 0;
                                const isKwHighlighted = highlightedItem === kw;
                                return (
                                    <div
                                        key={kw}
                                        onClick={() => handleLsiHighlight(kw)}
                                        className={`group flex items-center gap-2 rounded-lg border bg-white px-3 py-1.5 shadow-sm transition-all hover:shadow-md dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:hover:bg-[#d4af37]/20 ${isKwHighlighted ? 'border-violet-400 ring-2 ring-violet-400/50' : 'border-gray-200'}`}
                                    >
                                        <span className="cursor-pointer text-sm font-medium text-gray-800 dark:text-gray-200">{kw}</span>
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#d4af37]/10 text-xs font-bold text-[#d4af37] dark:bg-[#d4af37]/20 dark:text-[#f2d675]">
                                            {count}
                                        </span>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleLsiRemove(kw); }}
                                            className="cursor-pointer rounded-full p-1 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-100 hover:text-red-500 dark:hover:bg-red-900/20"
                                            title={tLk.delete}
                                        >
                                            <X size={14} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </ModernSection>
          </div>
        );
    }

    return (
        <div className="p-1 space-y-3">
            {autoDistributeSection}
            <AdvancedKeywordCard
                title={tLk.primaryKeyword}
                icon={<KeyRound size={20} />}
                analysis={keywordAnalysis.primary}
                onClick={() => handleHighlightToggle(keywords.primary, 'primary')}
                t={tLk}
            >
                <div onClick={(e) => e.stopPropagation()}>
                    <KeywordInput
                        value={keywords.primary}
                        onChange={(val) => setKeywords(k => ({ ...k, primary: val }))}
                        placeholder={tLk.enterPrimary}
                        onHighlight={() => handleHighlightToggle(keywords.primary, 'primary')}
                        isHighlighted={highlightedItem === keywords.primary}
                        onCopy={() => navigator.clipboard.writeText(keywords.primary)}
                        t={tLk}
                    />
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 mt-2 border-t border-gray-200 dark:border-[#3C3C3C]">
                        {keywordAnalysis.primary.checks.map((check, index) => (
                            <div key={index} className="flex items-center gap-2 text-xs">
                                {check.isMet ? <CheckCircle size={14} className="text-green-500" /> : <XCircle size={14} className="text-red-500" />}
                                <span className="text-gray-600 dark:text-gray-300">{check.text}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </AdvancedKeywordCard>

            {semanticGeneratorControl}
            <AdvancedKeywordCard
                title={tLk.synonyms}
                icon={<ListChecks size={20} />}
                analysis={keywordAnalysis.secondariesDistribution}
                onClick={handleToggleAllSecondariesHighlight}
                t={tLk}
            >
                <div className="space-y-2 pt-2 mt-2 border-t border-gray-200 dark:border-[#3C3C3C]" onClick={(e) => e.stopPropagation()}>
                    {keywords.secondaries.map((s, i) => (
                        <div key={i} className="space-y-2">
                           <KeywordInput 
                                value={s}
                                onChange={(val) => setKeywords(k => ({...k, secondaries: k.secondaries.map((kw, idx) => idx === i ? val : kw)}))}
                                placeholder={`${tLk.synonym} ${i + 1}`}
                                onHighlight={() => handleSecondaryHighlightToggle(s, i)}
                                isHighlighted={highlightedItem === s}
                                onRemove={() => handleRemoveSecondary(i)}
                                onCopy={() => navigator.clipboard.writeText(s)}
                                t={tLk}
                           />
                           {s.trim() && keywordAnalysis.secondaries[i] && (
                              <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 border-t border-gray-100 dark:border-gray-700/50">
                                  {keywordAnalysis.secondaries[i].checks.map((check, index) => (
                                      <div key={index} className="flex items-center gap-2 text-xs">
                                          {check.isMet ? <CheckCircle size={14} className="text-green-500" /> : <XCircle size={14} className="text-red-500" />}
                                          <span className="text-gray-600 dark:text-gray-300">{check.text}</span>
                                      </div>
                                  ))}
                              </div>
                           )}
                        </div>
                    ))}
                    <button onClick={handleAddSecondary} className="w-full flex items-center justify-center gap-2 py-2 text-sm font-semibold text-[#d4af37] dark:text-[#f2d675] bg-gray-100 dark:bg-[#3C3C3C] rounded-md hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/25">
                        <Plus size={16} /> {tLk.addSynonym}
                    </button>
                </div>
            </AdvancedKeywordCard>
            
            <AdvancedKeywordCard
                title={tLk.lsiKeywords}
                icon={<Repeat size={20} />}
                analysis={keywordAnalysis.lsi.distribution}
                onClick={handleToggleAllLsiHighlights}
                t={tLk}
                actions={
                    <div className="flex items-center gap-1">
                         <button
                            onClick={(e) => { e.stopPropagation(); handleClearLsi(); }}
                            disabled={keywords.lsi.length === 0}
                            className="p-1.5 rounded-full hover:bg-red-100 dark:hover:bg-red-900/50 disabled:cursor-not-allowed disabled:opacity-40"
                            title={tLk.clearAllLsi}
                        >
                            <Trash2 size={16} className="text-red-500 dark:text-red-400" />
                        </button>
                         <button
                            onClick={(e) => { e.stopPropagation(); handleToggleAllLsiHighlights(); }}
                            disabled={keywords.lsi.length === 0}
                            className={`p-1.5 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${highlightedItem === '__ALL_LSI__' ? 'bg-[#d4af37]/15 dark:bg-[#d4af37]/20' : 'hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20'}`}
                            title={highlightedItem === '__ALL_LSI__' ? t.duplicatesTab.unhighlightAll : tLk.highlightAll}
                        >
                            <Eye size={16} className={highlightedItem === '__ALL_LSI__' ? 'text-[#d4af37] dark:text-[#f2d675]' : 'text-gray-500 dark:text-gray-400'} />
                        </button>
                    </div>
                }
            >
                <div onClick={(e) => e.stopPropagation()}>
                    <textarea
                        value={lsiInputValue}
                        onChange={(e) => setLsiInputValue(e.target.value)}
                        onKeyDown={handleLsiKeyDown}
                        onPaste={handleLsiPaste}
                        rows={2}
                        className="w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-sm text-[#333333] dark:text-[#e0e0e0] custom-scrollbar"
                        placeholder={tLk.addLsiPlaceholder}
                    />
                    
                    <div className="space-y-2 pt-2 mt-2 border-t border-gray-200 dark:border-[#3C3C3C]">
                       {keywordAnalysis.lsi.balance.status === 'fail' && (
                            <div className={`relative overflow-hidden rounded-lg border p-3 ${uiLanguage === 'ar' ? 'border-r-4' : 'border-l-4'} border-red-300 bg-red-50 text-red-900 dark:border-red-700/50 dark:bg-red-900/20 dark:text-red-200`}>
                                <div className="flex items-start gap-3">
                                    <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
                                    <div className="text-xs">
                                        <p className="font-bold">{keywordAnalysis.lsi.balance.title}: {keywordAnalysis.lsi.balance.current}</p>
                                        <p className="mt-1">{keywordAnalysis.lsi.balance.description}</p>
                                    </div>
                                </div>
                            </div>
                        )}
                        {keywords.lsi.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {keywords.lsi.map(kw => {
                                    const kwAnalysis = keywordAnalysis.lsi.keywords.find(kwa => kwa.text === kw);
                                    const count = kwAnalysis ? kwAnalysis.count : 0;
                                    const isKwHighlighted = highlightedItem === kw;
                                    return (
                                        <div
                                            key={kw}
                                            onClick={() => handleLsiHighlight(kw)}
                                            className={`group flex items-center gap-2 rounded-lg border bg-white px-3 py-1.5 shadow-sm transition-all hover:shadow-md dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:hover:bg-[#d4af37]/20 ${isKwHighlighted ? 'border-violet-400 ring-2 ring-violet-400/50' : 'border-gray-200'}`}
                                        >
                                            <span className="cursor-pointer text-sm font-medium text-gray-800 dark:text-gray-200">{kw}</span>
                                            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#d4af37]/10 text-xs font-bold text-[#d4af37] dark:bg-[#d4af37]/20 dark:text-[#f2d675]">
                                                {count}
                                            </span>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleLsiRemove(kw); }}
                                                className="cursor-pointer rounded-full p-1 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-100 hover:text-red-500 dark:hover:bg-red-900/20"
                                                title={tLk.delete}
                                            >
                                                <X size={14} />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </AdvancedKeywordCard>
            
             <div 
               className="bg-white dark:bg-[#2A2A2A] rounded-xl p-2 space-y-2 transition-all duration-300 border border-gray-300 dark:border-[#3C3C3C] cursor-pointer hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20"
               onClick={() => handleHighlightToggle(keywords.company, 'company')}
             >
                <div className="flex items-center gap-2">
                    <span className="text-[#d4af37]"><Users size={20} /></span>
                    <h4 className="text-sm font-bold text-[#333333] dark:text-[#C7C7C7]">{tLk.companyName}</h4>
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                    {renderSavedCompanySelect()}
                    <KeywordInput 
                        value={keywords.company}
                        onChange={handleCompanyChange}
                        placeholder={tLk.enterCompany}
                        onHighlight={() => handleHighlightToggle(keywords.company, 'company')}
                        isHighlighted={highlightedItem === keywords.company}
                        className="bg-white dark:bg-[#2A2A2A]"
                        onCopy={() => navigator.clipboard.writeText(keywords.company)}
                        t={tLk}
                    />
                    <ModernProgressBar analysis={keywordAnalysis.company} t={tLk} />
                </div>
              </div>
              <GoalTab embedded />
        </div>
    );
  };
  
  return (
    <aside className="relative z-30 basis-[20.57%] bg-[#F2F3F5] dark:bg-[#1F1F1F] rounded-lg shadow-lg flex flex-col h-full min-w-0">
        <div className="flex border-b border-gray-200 dark:border-[#3C3C3C]">
            <button onClick={() => setActiveTab('keywords')} className={getTabClass('keywords')}>
                <KeyRound size={16} />
                <span>{tLk.targetKeywords}</span>
            </button>
            <button onClick={() => setActiveTab('duplicates')} className={getTabClass('duplicates')}>
                <Repeat size={16} />
                <span>{tLk.duplicates}</span>
            </button>
        </div>

        <div className="flex-shrink-0 p-3 bg-[#F2F3F5] dark:bg-[#1F1F1F] border-b border-gray-200 dark:border-[#3C3C3C]">
             {activeTab === 'keywords' ? (
                 // Compact keyword/goal tab network: primary, synonyms, company, and LSI.
                 <SpiderStats metrics={keywordDetailSpiderMetrics} compact />
             ) : (
                <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-1.5">
                        <MiniStat icon={<Hash size={14} />} value={duplicateRepeatedPhrasesCount} title={duplicateMiniStats.repeatedPhrases} tone={duplicateRepeatedPhrasesCount > 0 ? 'red' : 'green'} />
                        <MiniStat icon={<Repeat size={14} />} value={duplicateOccurrencesCount} title={duplicateMiniStats.totalOccurrences} tone={duplicateOccurrencesCount > 0 ? 'red' : 'green'} />
                        <MiniStat icon={<Percent size={14} />} value={uniqueWordsPercentage} title={duplicateMiniStats.uniquePercentage} tone="gold" />
                    </div>
                    {/* Compact duplicate stats shown under the tab buttons for the duplicate tab. */}
                    <SpiderStats metrics={duplicateHeaderSpiderMetrics} compact />
                </div>
             )}
        </div>
        <div className="flex-grow overflow-y-auto custom-scrollbar">
            {activeTab === 'keywords' && renderKeywordsTab()}
            {activeTab === 'duplicates' && (
                <DuplicatesTab />
            )}
        </div>
    </aside>
  );
};

export default LeftSidebar;
