import React, { useState } from 'react';
import { Copy, CheckCircle, XCircle, AlertCircle, Users, ListChecks, X, Eye, Trash2, KeyRound, Repeat, LayoutGrid, LayoutTemplate, ListTree, Plus, Check, Sparkles, Loader2, Hash, Percent, ChevronLeft, ChevronRight } from 'lucide-react';
import GoalTab from './GoalTab';
import { SECONDARY_COLORS } from '../constants';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditorSelector } from '../contexts/EditorContext';
import { useInteractionSelector } from '../contexts/InteractionContext';
import { useAISelector } from '../contexts/AIContext';
import type { Keywords, KeywordAnalysis, AnalysisStatus, KeywordStats, DuplicateAnalysis, GoalContext } from '../types';
import SpiderStats, { SpiderStatMetric } from './SpiderStats';
import { parseGoalContextText } from '../utils/goalContext';
import { MAX_ARTICLE_COMPETITORS } from '../constants/competitors';
import { useClientDirectory } from '../hooks/useClientDirectory';
import {
  buildUnifiedCompanyKeywords,
  getClientGoalContext,
  resolveCompanyClient,
} from '../utils/clientCompanyIdentity';
import {
  loadArticleClientContext,
  saveArticleClientSelection,
} from '../utils/articleClientContext';
import QuickClientCreateModal from './QuickClientCreateModal';
import { IconTooltip } from './toolbar/ToolbarItems';

const DuplicatesTab = React.lazy(() => import('./DuplicatesTab'));
const StructureTab = React.lazy(() => import('./StructureTab'));

type LeftSidebarTab = 'keywords' | 'duplicates' | 'criteria';

const mergeUniqueKeywordTerms = (existing: string[], incoming: string[], maxItems: number): string[] => {
  const seen = new Set<string>();
  return [...existing, ...incoming]
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
};

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
        className={`bg-white dark:bg-[#2A2A2A] rounded-xl shadow-sm border border-gray-300 dark:border-[#3C3C3C] p-[0.125rem] transition-all duration-200 ${onClick ? 'cursor-pointer hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20' : ''}`}
        onClick={onClick}
    >
        <div className="mb-[0.125rem] flex items-center justify-between gap-[0.125rem]">
            <h3 className="flex min-w-0 items-center gap-[0.125rem] text-sm font-bold text-[#333333] dark:text-[#C7C7C7]">
                {icon}
                <span className="truncate">{title}</span>
            </h3>
            {actions}
        </div>
        <div className="space-y-[0.125rem]" onClick={onClick ? e => e.stopPropagation() : undefined}>
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
      className={`relative bg-white dark:bg-[#2A2A2A] rounded-xl p-[0.125rem] space-y-[0.0625rem] transition-all duration-300 border border-gray-300 dark:border-[#3C3C3C] ${onClick ? 'cursor-pointer hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20' : ''}`}
      onClick={onClick}
    >
      <div className="flex justify-between items-center gap-[0.1875rem]">
        {/* Main Content */}
        <div className="flex-grow space-y-[0.0625rem]">
            <div className="flex items-center gap-[0.125rem]">
                <span className="text-[#d4af37]">{icon}</span>
                <h4 className="text-lg font-bold text-[#333333] dark:text-[#C7C7C7]">{title}</h4>
            </div>
             <div className="text-sm text-gray-500 dark:text-gray-400 pt-[0.125rem] space-y-[0.0625rem]">
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
        <div className="flex flex-col items-center flex-shrink-0 gap-[0.0625rem] pt-[0.125rem]">
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
  list?: string;
  className?: string;
  t: typeof translations.ar.leftSidebar;
}> = ({ value, onChange, placeholder, onHighlight, isHighlighted, onRemove, onCopy, list, className, t }) => (
  <div
    className="relative group cursor-pointer w-full"
    onClick={onHighlight}
  >
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      list={list}
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

const TERM_SEPARATOR_PATTERN = /[\n,،*\/#|؛;\t]+/;

const isAutoDistributeSeparatorLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return /^[\s\-_=*#./\\|،,؛;:：~–—]+$/.test(trimmed);
};

const splitAutoDistributeSections = (value: string): string[] => {
    const sections: string[][] = [[]];
    let sectionIndex = 0;

    value.split(/\r?\n/).forEach(line => {
        if (isAutoDistributeSeparatorLine(line)) {
            sectionIndex += 1;
            if (!sections[sectionIndex]) sections[sectionIndex] = [];
            return;
        }
        sections[sectionIndex].push(line);
    });

    return sections.map(section => section.join('\n').trim());
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
            className={`flex min-w-0 items-center justify-center gap-[0.09375rem] rounded-lg border px-[0.125rem] py-[0.09375rem] ${toneClass}`}
            title={title}
            aria-label={title}
        >
            <span className="flex-shrink-0">{icon}</span>
            <span className="truncate text-[11px] font-black tabular-nums">{value}</span>
        </div>
    );
};


type LeftSidebarProps = {
  collapsed?: boolean;
  expandedFlexBasis?: string;
  isHidden?: boolean;
  onToggleCollapsed?: () => void;
};

const LeftSidebar: React.FC<LeftSidebarProps> = ({
  collapsed = false,
  expandedFlexBasis,
  isHidden = false,
  onToggleCollapsed,
}) => {
  const { keywordViewMode, uiLanguage, t, clientGoalContexts } = useUser();
  const keywords = useEditorSelector(context => context.keywords);
  const setKeywords = useEditorSelector(context => context.setKeywords);
  const setTitle = useEditorSelector(context => context.setTitle);
  const setMetaDescription = useEditorSelector(context => context.setMetaDescription);
  const activeArticleId = useEditorSelector(context => context.activeArticleId);
  const setGoalContext = useEditorSelector(context => context.setGoalContext);
  const analysisResults = useEditorSelector(context => context.analysisResults);
  const setIsDuplicatesTabActive = useEditorSelector(context => context.setIsDuplicatesTabActive);
  const setIsStructureTabActive = useEditorSelector(context => context.setIsStructureTabActive);
  const applyHighlights = useInteractionSelector(context => context.applyHighlights);
  const clearAllHighlights = useInteractionSelector(context => context.clearAllHighlights);
  const highlightedItem = useInteractionSelector(context => context.highlightedItem);
  const setHighlightedItem = useInteractionSelector(context => context.setHighlightedItem);
  const generateSemanticKeywords = useAISelector(context => context.generateSemanticKeywords);
  const {
    clients,
    activeClients,
    isLoadingClients,
    clientDirectoryError,
  } = useClientDirectory();
  
  const { keywordAnalysis, duplicateAnalysis, duplicateStats } = analysisResults;

  const [activeTab, setActiveTab] = React.useState<LeftSidebarTab>('keywords');
  const [lsiInputValue, setLsiInputValue] = React.useState('');
  const [autoDistributeText, setAutoDistributeText] = React.useState('');
  const [isGeneratingSemanticKeywords, setIsGeneratingSemanticKeywords] = React.useState(false);
  const [semanticGenerationStatus, setSemanticGenerationStatus] = React.useState('');
  const [companySelectionError, setCompanySelectionError] = React.useState('');
  const [linkedArticleClientId, setLinkedArticleClientId] = React.useState('');
  const [companyInputValue, setCompanyInputValue] = React.useState(keywords.company);
  const [isCompanyMenuOpen, setIsCompanyMenuOpen] = React.useState(false);
  const [quickClientName, setQuickClientName] = React.useState('');
  const [isQuickClientModalOpen, setIsQuickClientModalOpen] = React.useState(false);
  const tLk = t.leftSidebar;
  const selectedCompanyClient = React.useMemo(
    // A client link belongs to a saved article only. Ignoring the previous link while
    // starting an unsaved article prevents its company from being selected again.
    () => resolveCompanyClient(
      activeClients,
      keywords,
      activeArticleId ? linkedArticleClientId : '',
    ),
    [activeArticleId, activeClients, keywords.clientId, keywords.company, linkedArticleClientId],
  );

  const criteriaTabLabel = uiLanguage === 'ar' ? 'المعايير' : 'Criteria';

  const getTabClass = (tabName: LeftSidebarTab) => {
    const isActive = activeTab === tabName;
    return `group relative flex h-9 min-w-0 flex-1 items-center justify-center rounded-md px-2 text-xs font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] ${
      isActive
        ? 'bg-[#d4af37]/15 text-[#8a6f1d] ring-1 ring-inset ring-[#d4af37]/35 shadow-sm dark:bg-[#d4af37]/15 dark:text-[#f2d675]'
        : 'text-gray-500 hover:bg-white/80 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white'
    }`;
  };

  const handleTabChange = React.useCallback((tabName: LeftSidebarTab) => {
    setActiveTab(tabName);
    setIsDuplicatesTabActive(tabName === 'duplicates');
    setIsStructureTabActive(tabName === 'criteria');
  }, [setIsDuplicatesTabActive, setIsStructureTabActive]);

  React.useEffect(() => {
    setIsDuplicatesTabActive(activeTab === 'duplicates');
    setIsStructureTabActive(activeTab === 'criteria');
    return () => {
      setIsDuplicatesTabActive(false);
      setIsStructureTabActive(false);
    };
  }, [activeTab, setIsDuplicatesTabActive, setIsStructureTabActive]);

  React.useEffect(() => {
    const handleTabShortcut = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const nextTab: LeftSidebarTab | null = event.code === 'Digit1'
        ? 'keywords'
        : event.code === 'Digit2'
          ? 'duplicates'
          : event.code === 'Digit3'
            ? 'criteria'
            : null;
      if (!nextTab) return;

      event.preventDefault();
      handleTabChange(nextTab);
      if (collapsed) onToggleCollapsed?.();
    };

    window.addEventListener('keydown', handleTabShortcut);
    return () => window.removeEventListener('keydown', handleTabShortcut);
  }, [collapsed, handleTabChange, onToggleCollapsed]);
  
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

  React.useEffect(() => {
    let cancelled = false;
    setLinkedArticleClientId('');
    if (!activeArticleId) return () => {
      cancelled = true;
    };

    void loadArticleClientContext(activeArticleId).then(context => {
      if (!cancelled) setLinkedArticleClientId(context?.clientId || '');
    }).catch(error => {
      if (!cancelled) {
        setCompanySelectionError(
          error instanceof Error ? error.message : 'تعذر تحميل عميل المقالة.',
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeArticleId]);

  React.useEffect(() => {
    if (!selectedCompanyClient) return;
    if (
      keywords.clientId === selectedCompanyClient.id
      && keywords.company === selectedCompanyClient.name
    ) return;
    setKeywords(current => buildUnifiedCompanyKeywords(current, selectedCompanyClient));
  }, [
    keywords.clientId,
    keywords.company,
    selectedCompanyClient,
    setKeywords,
  ]);

  const applyCompanyGoalContext = React.useCallback((client: typeof selectedCompanyClient) => {
    if (!client) return;
    const preset = getClientGoalContext(clientGoalContexts, client);
    if (preset) {
      setGoalContext(preset);
    }
  }, [clientGoalContexts, setGoalContext]);

  React.useEffect(() => {
    setCompanyInputValue(keywords.company);
  }, [keywords.company]);

  const applyCompanySelection = React.useCallback((client: typeof selectedCompanyClient) => {
    if (!client) return;
    setCompanySelectionError('');
    setCompanyInputValue(client.name);
    setIsCompanyMenuOpen(false);
    setLinkedArticleClientId(client.id);
    setKeywords(current => buildUnifiedCompanyKeywords(current, client));
    applyCompanyGoalContext(client);
    if (activeArticleId) {
      void saveArticleClientSelection(activeArticleId, client.id).catch(error => {
        setCompanySelectionError(
          error instanceof Error ? error.message : 'تعذر ربط المقالة بالعميل المحدد.',
        );
      });
    }
  }, [activeArticleId, applyCompanyGoalContext, setKeywords]);

  const handleCompanyChange = React.useCallback((clientId: string) => {
    applyCompanySelection(activeClients.find(candidate => candidate.id === clientId) || null);
  }, [activeClients, applyCompanySelection]);

  const normalizedCompanyInput = companyInputValue.trim().replace(/\s+/g, ' ');
  const exactCompanyClient = React.useMemo(() => {
    const normalized = normalizedCompanyInput.toLocaleLowerCase();
    if (!normalized) return null;
    return clients.find(client => client.name.trim().toLocaleLowerCase() === normalized) || null;
  }, [clients, normalizedCompanyInput]);
  const filteredCompanyClients = React.useMemo(() => {
    const normalized = normalizedCompanyInput.toLocaleLowerCase();
    const candidates = normalized
      ? activeClients.filter(client => client.name.toLocaleLowerCase().includes(normalized))
      : activeClients;
    return candidates.slice(0, 8);
  }, [activeClients, normalizedCompanyInput]);

  const openQuickClientModal = React.useCallback(() => {
    if (normalizedCompanyInput.length < 2 || exactCompanyClient) return;
    setQuickClientName(normalizedCompanyInput);
    setCompanySelectionError('');
    setIsCompanyMenuOpen(false);
    setIsQuickClientModalOpen(true);
  }, [exactCompanyClient, normalizedCompanyInput]);

  const handleCompanyInputKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setIsCompanyMenuOpen(false);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (exactCompanyClient?.isActive) {
      applyCompanySelection(exactCompanyClient);
      return;
    }
    openQuickClientModal();
  }, [applyCompanySelection, exactCompanyClient, openQuickClientModal]);

  const handleQuickClientCreated = React.useCallback((client: typeof selectedCompanyClient) => {
    if (!client) return;
    if (!client.isActive) {
      throw new Error('هذا العميل موجود لكنه غير نشط. فعّله من الإعدادات ← العملاء.');
    }
    applyCompanySelection(client);
  }, [applyCompanySelection]);

  const renderCompanySelector = () => {
    return (
      <div className="space-y-2">
        <div
          className="relative"
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setIsCompanyMenuOpen(false);
            }
          }}
        >
          <input
            type="text"
            role="combobox"
            aria-expanded={isCompanyMenuOpen}
            aria-controls="company-client-options"
            aria-autocomplete="list"
            value={companyInputValue}
            onChange={event => {
              setCompanyInputValue(event.target.value);
              setCompanySelectionError('');
              setIsCompanyMenuOpen(true);
            }}
            onFocus={() => setIsCompanyMenuOpen(true)}
            onKeyDown={handleCompanyInputKeyDown}
            disabled={isLoadingClients}
            placeholder={isLoadingClients ? 'جاري تحميل العملاء...' : 'ابحث أو اكتب اسمًا جديدًا'}
            className="w-full rounded-md border border-gray-300 bg-gray-50 p-2 text-sm font-semibold text-[#333333] outline-none focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-[#e0e0e0]"
            data-testid="company-client-combobox"
          />
          {isCompanyMenuOpen && !isLoadingClients && (
            <div
              id="company-client-options"
              role="listbox"
              className="absolute inset-x-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-md border border-gray-200 bg-white p-1 shadow-xl dark:border-[#3C3C3C] dark:bg-[#2A2A2A]"
            >
              {filteredCompanyClients.map(client => (
                <button
                  key={client.id}
                  type="button"
                  role="option"
                  aria-selected={selectedCompanyClient?.id === client.id}
                  onClick={() => handleCompanyChange(client.id)}
                  className="w-full rounded px-3 py-2 text-start text-sm font-bold text-gray-700 hover:bg-[#d4af37]/15 dark:text-gray-200 dark:hover:bg-[#d4af37]/20"
                >
                  {client.name}
                </button>
              ))}
              {exactCompanyClient && !exactCompanyClient.isActive && (
                <div className="rounded px-3 py-2 text-xs font-bold leading-5 text-amber-700 dark:text-amber-300">
                  هذا العميل موجود لكنه غير نشط. فعّله من الإعدادات ← العملاء.
                </div>
              )}
              {!exactCompanyClient && normalizedCompanyInput.length >= 2 && (
                <button
                  type="button"
                  onClick={openQuickClientModal}
                  className="flex w-full items-start gap-2 rounded px-3 py-2 text-start text-sm font-black text-[#9a7720] hover:bg-[#d4af37]/15 dark:text-[#f2d675] dark:hover:bg-[#d4af37]/20"
                  data-testid="create-new-client-option"
                >
                  <Plus className="mt-0.5 shrink-0" size={15} />
                  <span>إضافة «{normalizedCompanyInput}» كشركة/عميل جديد</span>
                </button>
              )}
              {filteredCompanyClients.length === 0 && normalizedCompanyInput.length < 2 && (
                <div className="px-3 py-2 text-xs font-semibold leading-5 text-gray-400">
                  اكتب حرفين على الأقل للبحث أو إضافة عميل جديد.
                </div>
              )}
            </div>
          )}
        </div>
        <p className="text-[11px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
          اختر اسمًا مسجلًا، أو اكتب اسمًا جديدًا ثم اضغط Enter لإضافته إلى مركز العملاء.
        </p>
        {(clientDirectoryError || companySelectionError) && (
          <p className="text-[11px] font-bold text-red-600 dark:text-red-400">
            {companySelectionError || clientDirectoryError}
          </p>
        )}
      </div>
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

  const {
    duplicateHeaderSpiderMetrics,
    duplicateRepeatedPhrasesCount,
    duplicateOccurrencesCount,
    uniqueWordsPercentage,
    duplicateMiniStats,
  } = React.useMemo(() => {
    const duplicateCategoryLabels: Record<keyof DuplicateAnalysis, string> = {
      2: t.duplicatesTab.bigrams,
      3: t.duplicatesTab.trigrams,
      4: t.duplicatesTab.fourGrams,
      5: t.duplicatesTab.fiveGrams,
      6: t.duplicatesTab.sixGrams,
      7: t.duplicatesTab.sevenGrams,
      8: t.duplicatesTab.eightGrams,
    };

    const allPhrases = Object.values(duplicateAnalysis).flat() as { count: number }[];
    const headerMetrics: SpiderStatMetric[] = ([8, 7, 6, 5, 4, 3, 2] as (keyof DuplicateAnalysis)[]).map(key => {
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

    return {
      duplicateHeaderSpiderMetrics: headerMetrics,
      duplicateRepeatedPhrasesCount: allPhrases.length,
      duplicateOccurrencesCount: duplicateStats.totalDuplicates,
      uniqueWordsPercentage: duplicateStats.totalWords > 0
        ? `${((duplicateStats.uniqueWords / duplicateStats.totalWords) * 100).toFixed(1)}%`
        : '0%',
      duplicateMiniStats: uiLanguage === 'ar'
        ? {
            repeatedPhrases: 'عدد العبارات المكررة',
            totalOccurrences: 'إجمالي عدد التكرارات',
            uniquePercentage: 'نسبة الكلمات الفريدة في النص',
          }
        : {
            repeatedPhrases: 'Repeated phrases count',
            totalOccurrences: 'Total repetitions count',
            uniquePercentage: 'Unique words percentage',
          },
    };
  }, [duplicateAnalysis, duplicateStats, t.duplicatesTab, uiLanguage]);

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
      if (result.cancelled) return;
      if (result.error) {
        setSemanticGenerationStatus(result.error);
        return;
      }
      setKeywords(prev => ({
        ...prev,
        secondaries: result.secondaries.length > 0
          ? mergeUniqueKeywordTerms(prev.secondaries, result.secondaries, 10)
          : prev.secondaries,
        lsi: result.lsi.length > 0
          ? mergeUniqueKeywordTerms(prev.lsi, result.lsi, 24)
          : prev.lsi,
        googleTitles: result.googleTitles,
        googleDescriptions: result.googleDescriptions,
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

  const hasGoogleMetadataSuggestions = (
    (keywords.googleTitles?.length || 0) > 0 || (keywords.googleDescriptions?.length || 0) > 0
  );
  const googleMetadataSuggestions = (
    <div className="space-y-3 rounded-xl border border-[#d4af37]/35 bg-white p-3 dark:border-[#d4af37]/30 dark:bg-[#2A2A2A]">
      {hasGoogleMetadataSuggestions ? (
        <>
          <div>
            <h4 className="text-sm font-black text-[#333333] dark:text-[#e0e0e0]">{tLk.googleTitleSuggestions}</h4>
            <div className="mt-2 space-y-2">
              {(keywords.googleTitles || []).map((suggestion, index) => (
                <div key={`${suggestion}-${index}`} className="rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                  <p className="text-xs font-bold leading-5 text-gray-800 dark:text-gray-200">{suggestion}</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" onClick={() => setTitle(suggestion)} className="rounded-md bg-[#d4af37]/15 px-2 py-1 text-[11px] font-black text-[#8a6f1d] hover:bg-[#d4af37]/25 dark:text-[#f2d675]">
                      {tLk.useGoogleTitle}
                    </button>
                    <button type="button" onClick={() => navigator.clipboard.writeText(suggestion)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-white/5">
                      <Copy size={12} /> {tLk.copy}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t border-gray-200 pt-3 dark:border-[#3C3C3C]">
            <h4 className="text-sm font-black text-[#333333] dark:text-[#e0e0e0]">{tLk.googleDescriptionSuggestions}</h4>
            <div className="mt-2 space-y-2">
              {(keywords.googleDescriptions || []).map((suggestion, index) => (
                <div key={`${suggestion.text}-${index}`} className="rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                  <p className="text-xs font-medium leading-5 text-gray-700 dark:text-gray-300">{suggestion.text}</p>
                  {suggestion.callToAction && (
                    <p className="mt-1 text-[10px] font-black text-[#8a6f1d] dark:text-[#f2d675]">{tLk.callToAction}: {suggestion.callToAction}</p>
                  )}
                  <div className="mt-2 flex gap-2">
                    <button type="button" onClick={() => setMetaDescription(suggestion.text)} className="rounded-md bg-[#d4af37]/15 px-2 py-1 text-[11px] font-black text-[#8a6f1d] hover:bg-[#d4af37]/25 dark:text-[#f2d675]">
                      {tLk.useGoogleDescription}
                    </button>
                    <button type="button" onClick={() => navigator.clipboard.writeText(suggestion.text)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-white/5">
                      <Copy size={12} /> {tLk.copy}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div>
          <h4 className="text-sm font-black text-[#333333] dark:text-[#e0e0e0]">{tLk.googleMetadataSuggestions}</h4>
          <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">{tLk.googleMetadataSuggestionsPending}</p>
        </div>
      )}
    </div>
  );
    
    const handleAutoDistribute = (text: string) => {
        if (!text.trim()) return;
    
        const parts = splitAutoDistributeSections(text)
            .map(part => part.trim());
    
        const primaryAndSynonymsPart = (parts[0] || '').trim();
        const lsiPart = (parts[1] || '').trim();
        const companyPart = (parts[2] || '').trim();
        const goalContextPart = (parts[3] || '').trim();
        const competitorParts = parts.slice(4);
        const distributedGoalContext = goalContextPart
            ? parseGoalContextText(goalContextPart, t.goalTab)
            : null;
    
        const primaryAndSynonymsLines = primaryAndSynonymsPart
            .split(/\r?\n/)
            .map(stripKeywordDots)
            .filter(Boolean);
        const newPrimary = primaryAndSynonymsLines[0] || keywords.primary;
        const synonymsPart = primaryAndSynonymsLines.slice(1).join('\n');
        const newSecondaries = synonymsPart
            ? splitDistributedTerms(synonymsPart, TERM_SEPARATOR_PATTERN)
            : keywords.secondaries;
    
        const newLsi = lsiPart ? splitDistributedTerms(lsiPart, TERM_SEPARATOR_PATTERN) : keywords.lsi;
    
        const companyLines = companyPart
            .split(/\r?\n/)
            .map(stripKeywordDots)
            .filter(Boolean);
        const newCompany = companyLines[0] || keywords.company;
        const distributedClient = resolveCompanyClient(activeClients, {
            clientId: keywords.clientId,
            company: newCompany,
        });
    
        setKeywords({
            primary: newPrimary,
            secondaries: newSecondaries,
            lsi: newLsi,
            company: distributedClient?.name || keywords.company,
            ...(distributedClient?.id || keywords.clientId
                ? { clientId: distributedClient?.id || keywords.clientId }
                : {}),
        });
        if (distributedGoalContext) {
            setGoalContext(distributedGoalContext);
        } else {
            applyCompanyGoalContext(distributedClient || selectedCompanyClient);
        }

        const competitorsPart = competitorParts.join('\n');
        const competitorUrls = competitorsPart
            ? competitorsPart.split(/\r?\n/).map(url => url.trim()).filter(Boolean).slice(0, MAX_ARTICLE_COMPETITORS)
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
                rows={9}
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
          <div className="p-[0.125rem] space-y-[0.1875rem]">
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
            {googleMetadataSuggestions}
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
                    {renderCompanySelector()}
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
        <div className="p-[0.0625rem] space-y-[0.1875rem]">
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
            {googleMetadataSuggestions}
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
               className="bg-white dark:bg-[#2A2A2A] rounded-xl p-[0.125rem] space-y-[0.125rem] transition-all duration-300 border border-gray-300 dark:border-[#3C3C3C] cursor-pointer hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20"
               onClick={() => handleHighlightToggle(keywords.company, 'company')}
             >
                <div className="flex items-center gap-[0.125rem]">
                    <span className="text-[#d4af37]"><Users size={20} /></span>
                    <h4 className="text-sm font-bold text-[#333333] dark:text-[#C7C7C7]">{tLk.companyName}</h4>
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                    {renderCompanySelector()}
                    <ModernProgressBar analysis={keywordAnalysis.company} t={tLk} />
                </div>
              </div>
              <GoalTab embedded />
        </div>
    );
  };
  
  return (
    <>
      <QuickClientCreateModal
        isOpen={isQuickClientModalOpen}
        initialName={quickClientName}
        primaryKeyword={keywords.primary}
        fallbackLanguage={uiLanguage}
        onClose={() => setIsQuickClientModalOpen(false)}
        onCreated={handleQuickClientCreated}
      />
      <aside
        className={`${isHidden ? 'hidden' : 'flex'} relative z-30 h-full min-w-0 flex-none flex-col overflow-hidden rounded-lg bg-[#F2F3F5] shadow-lg transition-[width,flex-basis] duration-150 dark:bg-[#1F1F1F] ${collapsed ? 'w-12 basis-12' : 'w-auto basis-[20.57%]'}`}
        style={collapsed || !expandedFlexBasis ? undefined : { flexBasis: expandedFlexBasis }}
      >
        <div className={`${collapsed ? 'flex' : 'hidden'} h-full flex-col items-center gap-[0.1875rem] px-[0.09375rem] py-[0.125rem]`}>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-white hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            aria-label={uiLanguage === 'ar' ? 'إظهار لوحة الكلمات والأهداف' : 'Show keywords and goals panel'}
            title={uiLanguage === 'ar' ? 'إظهار لوحة الكلمات والأهداف' : 'Show keywords and goals panel'}
          >
            {uiLanguage === 'ar' ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
          </button>
          <div
            className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-[#d4af37]/15 text-[#8a6f1d] ring-1 ring-inset ring-[#d4af37]/35 dark:text-[#f2d675]"
            title={activeTab === 'keywords'
              ? `${tLk.targetKeywords} — Alt+1`
              : activeTab === 'duplicates'
                ? `${tLk.duplicates} — Alt+2`
                : `${criteriaTabLabel} — Alt+3`}
          >
            {activeTab === 'keywords'
              ? <KeyRound size={17} />
              : activeTab === 'duplicates'
                ? <Repeat size={17} />
                : <LayoutTemplate size={17} />}
          </div>
        </div>

        <div className={`${collapsed ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col`}>
          <div className="relative z-40 flex items-stretch gap-[0.0625rem] border-b border-gray-200 p-[0.09375rem] dark:border-[#3C3C3C]">
            <div role="tablist" aria-label={uiLanguage === 'ar' ? 'الكلمات والتكرارات والمعايير' : 'Keywords, duplicates, and criteria'} className="flex min-w-0 flex-1 gap-[0.0625rem] rounded-lg bg-gray-200/70 p-[0.0625rem] dark:bg-black/20">
              <button
                type="button"
                role="tab"
                id="keywords-sidebar-tab"
                aria-controls="keywords-sidebar-panel"
                aria-selected={activeTab === 'keywords'}
                aria-label={`${tLk.targetKeywords} — Alt+1`}
                onClick={() => handleTabChange('keywords')}
                className={getTabClass('keywords')}
              >
                  <KeyRound size={16} />
                  <span className="sr-only">{tLk.targetKeywords}</span>
                  <IconTooltip label={tLk.targetKeywords} align="start" />
              </button>
              <button
                type="button"
                role="tab"
                id="duplicates-sidebar-tab"
                aria-controls="duplicates-sidebar-panel"
                aria-selected={activeTab === 'duplicates'}
                aria-label={`${tLk.duplicates} — Alt+2`}
                onClick={() => handleTabChange('duplicates')}
                className={getTabClass('duplicates')}
              >
                  <Repeat size={16} />
                  <span className="sr-only">{tLk.duplicates}</span>
                  <IconTooltip label={tLk.duplicates} />
              </button>
              <button
                type="button"
                role="tab"
                id="criteria-sidebar-tab"
                aria-controls="criteria-sidebar-panel"
                aria-selected={activeTab === 'criteria'}
                aria-label={`${criteriaTabLabel} — Alt+3`}
                onClick={() => handleTabChange('criteria')}
                className={getTabClass('criteria')}
              >
                  <LayoutTemplate size={16} />
                  <span className="sr-only">{criteriaTabLabel}</span>
                  <IconTooltip label={criteriaTabLabel} align="end" />
              </button>
            </div>
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="inline-flex h-[44px] w-9 flex-none items-center justify-center rounded-md text-gray-400 hover:bg-gray-200/80 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] dark:hover:bg-white/5 dark:hover:text-white"
              aria-label={uiLanguage === 'ar' ? 'طي لوحة الكلمات والأهداف' : 'Collapse keywords and goals panel'}
              title={uiLanguage === 'ar' ? 'طي لوحة الكلمات والأهداف' : 'Collapse keywords and goals panel'}
            >
              {uiLanguage === 'ar' ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            </button>
          </div>

          <div
            id={activeTab === 'keywords'
              ? 'keywords-sidebar-panel'
              : activeTab === 'duplicates'
                ? 'duplicates-sidebar-panel'
                : 'criteria-sidebar-panel'}
            role="tabpanel"
            aria-labelledby={activeTab === 'keywords'
              ? 'keywords-sidebar-tab'
              : activeTab === 'duplicates'
                ? 'duplicates-sidebar-tab'
                : 'criteria-sidebar-tab'}
            className="flex min-h-0 flex-1 flex-col"
          >
            {activeTab !== 'criteria' && (
              <div className="flex-shrink-0 border-b border-gray-200 bg-[#F2F3F5] p-[0.1875rem] dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
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
            )}
            <div className="flex-grow overflow-y-auto custom-scrollbar">
                {activeTab === 'keywords' && renderKeywordsTab()}
                {activeTab === 'duplicates' && (
                    <React.Suspense fallback={<div className="p-[0.25rem] text-center text-xs font-bold text-gray-400">جار تحميل التكرارات...</div>}>
                      <DuplicatesTab />
                    </React.Suspense>
                )}
                {activeTab === 'criteria' && (
                    <React.Suspense fallback={<div className="p-[0.25rem] text-center text-xs font-bold text-gray-400">{uiLanguage === 'ar' ? 'جار تحميل المعايير...' : 'Loading criteria...'}</div>}>
                      <StructureTab />
                    </React.Suspense>
                )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
};

export default LeftSidebar;
