import React, { useState } from 'react';
import { Copy, CheckCircle, XCircle, AlertCircle, Users, ListChecks, X, Eye, Trash2, KeyRound, Repeat, LayoutGrid, ListTree, Plus, Check } from 'lucide-react';
import DuplicatesTab from './DuplicatesTab';
import { SECONDARY_COLORS } from '../constants';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useInteraction } from '../contexts/InteractionContext';
import type { Keywords, KeywordAnalysis, AnalysisStatus, KeywordStats, DuplicateAnalysis, DuplicateStats } from '../types';

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

const ModernSection: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode; onClick?: () => void; }> = ({ icon, title, children, onClick }) => (
    <div 
        className={`bg-white dark:bg-[#2A2A2A] rounded-xl shadow-sm border border-gray-300 dark:border-[#3C3C3C] p-2 transition-all duration-200 ${onClick ? 'cursor-pointer hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20' : ''}`}
        onClick={onClick}
    >
        <h3 className="flex items-center gap-2 text-sm font-bold text-[#333333] dark:text-[#C7C7C7] mb-2">
            {icon}
            <span>{title}</span>
        </h3>
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


const LeftSidebar: React.FC = () => {
  const { keywordViewMode, uiLanguage, t } = useUser();
  const { keywords, setKeywords, analysisResults } = useEditor();
  const { applyHighlights, clearAllHighlights, highlightedItem, setHighlightedItem } = useInteraction();
  
  const { keywordAnalysis, duplicateAnalysis, duplicateStats } = analysisResults;

  const [activeTab, setActiveTab] = React.useState<'keywords' | 'duplicates'>('keywords');
  const [lsiInputValue, setLsiInputValue] = React.useState('');
  const [autoDistributeText, setAutoDistributeText] = React.useState('');
  const tLk = t.leftSidebar;

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
  let totalConditions = 0;
  let violatingConditions = 0;

  if (keywords.primary.trim()) {
      const primaryChecks = keywordAnalysis.primary.checks;
      totalConditions += 1 + primaryChecks.length;
      if (keywordAnalysis.primary.status === 'fail') {
          violatingConditions++;
      }
      violatingConditions += primaryChecks.filter(c => !c.isMet).length;
  }

  if (enteredSynonymsCount > 0) {
      totalConditions += 1;
      if (keywordAnalysis.secondariesDistribution.status === 'fail') {
          violatingConditions++;
      }

      keywords.secondaries.forEach((s, i) => {
          if (s.trim()) {
              const synonymAnalysis = keywordAnalysis.secondaries[i];
              const synonymChecks = synonymAnalysis.checks;
              totalConditions += 1 + synonymChecks.length;
              if (synonymAnalysis.status === 'fail') {
                  violatingConditions++;
              }
              violatingConditions += synonymChecks.filter(c => !c.isMet).length;
          }
      });
  }

  if (keywords.company.trim()) {
      totalConditions += 1;
      if (keywordAnalysis.company.status === 'fail') {
          violatingConditions++;
      }
  }

  const handleAddSecondary = () => {
    setKeywords(k => ({ ...k, secondaries: [...k.secondaries, ''] }));
  };

  const handleRemoveSecondary = (indexToRemove: number) => {
    setKeywords(k => ({ ...k, secondaries: k.secondaries.filter((_, i) => i !== indexToRemove) }));
  };

  // LSI Handlers
    const handleLsiAdd = () => {
        if (!lsiInputValue.trim()) return;
        const newKeywords = lsiInputValue.split(/[\n,،.*\/#]+/).map(k => k.trim()).filter(k => k && !keywords.lsi.includes(k));
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
        const newKeywords = pastedText.split(/[\n,،.*\/#]+/).map(k => k.trim()).filter(k => k && !keywords.lsi.includes(k));
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
        if (highlightedItem === '__ALL_LSI__' || keywords.lsi.includes(highlightedItem as string)) {
            clearAllHighlights();
        }
    };
    
    const handleAutoDistribute = (text: string) => {
        if (!text.trim()) return;
    
        const parts = text.split(/^\s*[-/\\=.+*]+\s*$/m);
    
        const primaryAndSynonymsPart = (parts[0] || '').trim();
        const lsiPart = (parts[1] || '').trim();
        const companyPart = (parts[2] || '').trim();
    
        const primaryAndSynonymsLines = primaryAndSynonymsPart.split(/[\n,،]+/).map(line => line.trim()).filter(Boolean);
        const newPrimary = primaryAndSynonymsLines[0] || keywords.primary;
        const newSecondaries = primaryAndSynonymsLines.length > 1 ? primaryAndSynonymsLines.slice(1) : keywords.secondaries;
    
        const newLsi = lsiPart ? lsiPart.split(/[\n,،.*\/#]+/).map(line => line.trim()).filter(Boolean) : keywords.lsi;
    
        const companyLines = companyPart.split(/[\n,،]+/).map(line => line.trim()).filter(Boolean);
        const newCompany = companyLines[0] || keywords.company;
    
        setKeywords({
            primary: newPrimary,
            secondaries: newSecondaries,
            lsi: newLsi,
            company: newCompany,
        });
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
                    <KeywordInput 
                        value={keywords.company}
                        onChange={(val) => setKeywords(k => ({...k, company: val}))}
                        placeholder={tLk.enterCompany}
                        onHighlight={() => handleHighlightToggle(keywords.company, 'company')}
                        isHighlighted={highlightedItem === keywords.company}
                        onCopy={() => navigator.clipboard.writeText(keywords.company)}
                        t={tLk}
                    />
                    <ModernProgressBar analysis={keywordAnalysis.company} t={tLk} />
                </div>
            </ModernSection>
            <ModernSection 
                icon={<Repeat size={20} />} 
                title={tLk.lsiKeywords}
                onClick={handleToggleAllLsiHighlights}
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
                        <button onClick={handleClearLsi} disabled={keywords.lsi.length === 0} className="flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-md hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50 disabled:cursor-not-allowed">
                            <Trash2 size={14} /> <span>{tLk.clearAll}</span>
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
             <div className="px-1 py-1">
                <div className="flex bg-white dark:bg-gradient-to-r from-[#2A2A2A] via-[#222222] to-[#1F1F1F] rounded-lg border border-gray-300 dark:border-[#3C3C3C] divide-x divide-gray-200 dark:divide-[#3C3C3C] cursor-help">
                    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-2 text-center" title={tLk.primary}>
                        <div className="p-2 bg-[#d4af37]/10 dark:bg-[#d4af37]/20 text-[#d4af37] rounded-full">
                            <KeyRound size={16} />
                        </div>
                        <div className="font-bold text-base text-[#333333] dark:text-gray-200">{`${keywordAnalysis.primary.count}/${keywordAnalysis.primary.requiredCount[1] || '-'}`}</div>
                    </div>
                    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-2 text-center" title={tLk.synonyms}>
                        <div className="p-2 bg-[#d4af37]/10 dark:bg-[#d4af37]/20 text-[#d4af37] rounded-full">
                            <ListChecks size={16} />
                        </div>
                        <div className="font-bold text-base text-[#333333] dark:text-gray-200">{`${keywordAnalysis.secondariesDistribution.count}/${keywordAnalysis.secondariesDistribution.requiredCount[1] || '-'}`}</div>
                    </div>
                    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-2 text-center" title={tLk.company}>
                        <div className="p-2 bg-[#d4af37]/10 dark:bg-[#d4af37]/20 text-[#d4af37] rounded-full">
                            <Users size={16} />
                        </div>
                        <div className="font-bold text-base text-[#333333] dark:text-gray-200">{`${keywordAnalysis.company.count}/${keywordAnalysis.company.requiredCount[1] || '-'}`}</div>
                    </div>
                    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-2 text-center" title="LSI">
                        <div className="p-2 bg-[#d4af37]/10 dark:bg-[#d4af37]/20 text-[#d4af37] rounded-full">
                            <Repeat size={16} />
                        </div>
                        <div className="font-bold text-base text-[#333333] dark:text-gray-200">{`${keywordAnalysis.lsi.distribution.count}/${keywordAnalysis.lsi.distribution.requiredCount[1] || '-'}`}</div>
                    </div>
                </div>
              </div>
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
                    keywords.lsi.length > 0 ? (
                        <div className="flex items-center gap-1">
                             <button
                                onClick={(e) => { e.stopPropagation(); handleClearLsi(); }}
                                className="p-1.5 rounded-full hover:bg-red-100 dark:hover:bg-red-900/50"
                                title={tLk.clearAll}
                            >
                                <Trash2 size={16} className="text-red-500 dark:text-red-400" />
                            </button>
                             <button
                                onClick={(e) => { e.stopPropagation(); handleToggleAllLsiHighlights(); }}
                                className={`p-1.5 rounded-full transition-colors ${highlightedItem === '__ALL_LSI__' ? 'bg-[#d4af37]/15 dark:bg-[#d4af37]/20' : 'hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20'}`}
                                title={highlightedItem === '__ALL_LSI__' ? t.duplicatesTab.unhighlightAll : tLk.highlightAll}
                            >
                                <Eye size={16} className={highlightedItem === '__ALL_LSI__' ? 'text-[#d4af37] dark:text-[#f2d675]' : 'text-gray-500 dark:text-gray-400'} />
                            </button>
                        </div>
                    ) : undefined
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
                    <KeywordInput 
                        value={keywords.company}
                        onChange={(val) => setKeywords(k => ({...k, company: val}))}
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
        </div>
    );
  };
  
  return (
    <aside className="relative z-30 basis-[17%] bg-[#F2F3F5] dark:bg-[#1F1F1F] rounded-lg shadow-lg flex flex-col h-full min-w-0">
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
                 <div className="flex justify-between items-center px-2">
                     <div className="flex items-center gap-2 text-xs font-bold" title={tLk.keywordStats}>
                        <div className="flex items-center gap-1.5 text-red-500">
                           <XCircle size={14}/>
                           <span>{violatingConditions} {tLk.violations}</span>
                        </div>
                        <span className="text-gray-300 dark:text-gray-600">/</span>
                        <div className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
                           <CheckCircle size={14}/>
                           <span>{totalConditions} {tLk.rules}</span>
                        </div>
                     </div>
                 </div>
             ) : (
                uiLanguage === 'ar' && (
                    <div className="flex items-center justify-center gap-4 text-xs font-bold text-gray-500 dark:text-gray-400">
                        <span>{duplicateStats.totalWords} {tLk.word}</span>
                        <span>|</span>
                        <span>{duplicateStats.uniqueWords} {tLk.unique}</span>
                        <span>|</span>
                        <span>{duplicateStats.totalDuplicates} {tLk.duplicate}</span>
                    </div>
                )
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