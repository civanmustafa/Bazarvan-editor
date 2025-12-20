import React, { useEffect, useState, useMemo, useRef } from 'react';
import type { CheckResult, AnalysisStatus } from '../types';
import { Pilcrow, Heading, AlertCircle as AlertCircleIcon, Star, LayoutTemplate, ListTree, SpellCheck, MousePointerClick, Flag, X, ShieldAlert, Wand2, Loader2, CheckSquare, Square } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useInteraction } from '../contexts/InteractionContext';
import { useAI } from '../contexts/AIContext';
import { FIXABLE_RULES } from '../constants';

// Internal component for the floating tooltip to ensure it's never clipped
const FloatingTooltip: React.FC<{ content: string; targetRect: DOMRect | null }> = ({ content, targetRect }) => {
    if (!targetRect) return null;
    const isRtl = document.documentElement.dir === 'rtl';
    
    return (
        <div 
            className="fixed z-[9999] pointer-events-none"
            style={{
                top: targetRect.top - 8,
                left: isRtl ? 'auto' : targetRect.left + (targetRect.width / 2),
                right: isRtl ? (window.innerWidth - targetRect.right) + (targetRect.width / 2) : 'auto',
                transform: 'translate(calc(var(--tw-translate-x) * -1), -100%)',
                '--tw-translate-x': isRtl ? '-50%' : '50%'
            } as any}
        >
            <div className="bg-gray-900 text-white text-[11px] font-medium rounded-lg py-2 px-3 shadow-2xl max-w-xs whitespace-normal break-words border border-white/10">
                {content}
                <div className="absolute top-full start-1/2 -translate-x-1/2 w-0 h-0 border-x-[6px] border-x-transparent border-t-[6px] border-t-gray-900"></div>
            </div>
        </div>
    );
};

const InfoModal: React.FC<{ item: CheckResult; onClose: () => void, t: typeof translations.ar.structureTab }> = ({ item, onClose, t }) => {
  return (
    <div 
      className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 backdrop-blur-sm"
      aria-modal="true"
      role="dialog"
      onClick={onClose}
    >
      <div 
        className="bg-white dark:bg-[#2A2A2A] rounded-2xl shadow-2xl w-full max-w-lg p-7 border dark:border-[#3C3C3C] transform transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6 pb-4 border-b border-gray-100 dark:border-[#3C3C3C]">
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${item.status === 'fail' ? 'bg-red-100 text-red-600' : item.status === 'warn' ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600'}`}>
                <AlertCircleIcon size={22} />
            </div>
            <h3 className="text-xl font-bold text-[#333333] dark:text-gray-100">{item.title}</h3>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-[#3C3C3C] transition-colors" aria-label={t.close}>
            <X size={20} className="text-gray-500 dark:text-gray-400" />
          </button>
        </div>
        
        <div className="space-y-6 text-gray-600 dark:text-gray-300 max-h-[60vh] overflow-y-auto custom-scrollbar px-1">
          {item.description && (
            <div>
                <h4 className="text-[10px] font-black uppercase tracking-[0.1em] text-gray-400 mb-2">{document.documentElement.lang === 'ar' ? 'وصف المعيار' : 'CRITERION DESCRIPTION'}</h4>
                <p className="leading-relaxed text-sm font-medium">{item.description}</p>
            </div>
          )}
          
          <div className="bg-gray-50 dark:bg-[#1F1F1F] p-5 rounded-2xl border border-gray-100 dark:border-[#3C3C3C]">
              <h4 className="font-bold text-[#00778e] dark:text-[#94d2bd] mb-4 flex items-center gap-2 text-sm">
                <ListTree size={18} />
                {t.availableConditions}
              </h4>
              <div className="text-xs space-y-3 whitespace-pre-line leading-loose text-gray-500 dark:text-gray-400 font-medium">
                {item.details || (document.documentElement.lang === 'ar' ? 'لا توجد تفاصيل إضافية لهذا المعيار.' : 'No additional details for this criterion.')}
              </div>
          </div>

          <div className="flex justify-between items-center bg-gray-100/50 dark:bg-[#333] p-3 rounded-xl text-xs font-bold">
              <div className="flex gap-6">
                  <span className="flex items-center gap-2"><span className="text-gray-400 font-normal">{document.documentElement.lang === 'ar' ? 'المطلوب:' : 'Required:'}</span> <span className="text-[#00778e]">{item.required}</span></span>
                  <span className="flex items-center gap-2"><span className="text-gray-400 font-normal">{document.documentElement.lang === 'ar' ? 'الحالي:' : 'Current:'}</span> <span className={item.status === 'fail' ? 'text-red-500' : 'text-emerald-500'}>{item.current}</span></span>
              </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const getConciseSummary = (item: CheckResult, t: typeof translations.ar, uiLanguage: 'ar' | 'en'): string => {
  for (const key of Object.keys(translations.ar.structureAnalysis)) {
    const typedKey = key as keyof typeof translations.ar.structureAnalysis;
    if (translations.ar.structureAnalysis[typedKey].title === item.title || translations.en.structureAnalysis[typedKey].title === item.title) {
      const rule = t.structureAnalysis[typedKey];
      if (rule.conciseSummary) {
        if (typedKey === 'عدد الكلمات') {
          return typeof item.required === 'string' && item.required.startsWith('>')
            ? `${item.required} ${uiLanguage === 'ar' ? 'كلمة' : 'words'}`
            : rule.conciseSummary;
        }
        return rule.conciseSummary;
      }
      break; 
    }
  }
  return typeof item.required === 'string' ? item.required : String(item.required);
};

const ChecklistItem: React.FC<{ item: CheckResult; onClick?: () => void; isHighlighted?: boolean; onInfoClick: (item: CheckResult) => void; uiLanguage: 'ar' | 'en'; }> = ({ item, onClick, isHighlighted, onInfoClick, uiLanguage }) => {
  const t = translations[uiLanguage];
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  
  const progress = Math.max(0, Math.min(item.progress || 0, 1));
  const hasViolatingItems = item.violatingItems && item.violatingItems.length > 0;
  
  const conciseSummary = getConciseSummary(item, t, uiLanguage);
  const hoverTooltipContent = (item.status !== 'pass' && item.violatingItems?.[0]?.message)
    ? item.violatingItems[0].message
    : conciseSummary;

  return (
    <>
        <div
            ref={cardRef}
            className={`group relative rounded-xl transition-all duration-200 cursor-pointer bg-white hover:bg-gray-50 dark:bg-[#2A2A2A] dark:hover:bg-[#3C3C3C] h-14 flex flex-col justify-between border border-gray-100 dark:border-[#3C3C3C] hover:border-[#00778e]/30 dark:hover:border-[#00778e]/30 shadow-sm`}
            onClick={onClick}
            onMouseEnter={() => setHoverRect(cardRef.current?.getBoundingClientRect() || null)}
            onMouseLeave={() => setHoverRect(null)}
        >
            {isHighlighted && (
                <div className="absolute top-0 end-0 w-8 h-8" aria-hidden="true">
                <div className={`absolute inset-0 ${item.status === 'fail' ? 'bg-[#810701]' : item.status === 'warn' ? 'bg-amber-500' : 'bg-[#00778E]'} [clip-path:polygon(0_0,100%_0,0_100%)] rounded-tl-lg`}></div>
                <Star size={10} className="absolute top-1.5 end-1.5 text-white -rotate-45" fill="white" />
                </div>
            )}
            
            <div className="flex-1 flex items-center justify-between px-3">
                <h4 className="font-bold text-[10px] text-gray-500 dark:text-[#8d8d8d] uppercase tracking-tight truncate pe-1">{item.title}</h4>
                <div className="flex items-center gap-1.5">
                    {hasViolatingItems && (item.status === 'fail' || item.status === 'warn') && item.title !== 'عدد H2' && item.title !== 'H2 Count' ? (
                    <span 
                        className="text-white text-[9px] font-black min-w-[14px] h-3.5 px-1 flex items-center justify-center rounded-full"
                        style={{ backgroundColor: item.status === 'fail' ? '#810701' : '#F59E0B' }}
                    >
                        {item.violatingItems!.length}
                    </span>
                    ) : null}
                    <button 
                        onClick={(e) => {
                            e.stopPropagation();
                            onInfoClick(item);
                        }}
                        className="p-1 rounded-md text-gray-400 hover:bg-gray-200 dark:hover:bg-[#3C3C3C]/80 hover:text-[#00778e] transition-all"
                        aria-label={t.structureTab.showDetails}
                    >
                        <AlertCircleIcon size={14} />
                    </button>
                </div>
            </div>

            <div className="absolute bottom-0 start-0 w-full h-1.5 rounded-b-xl overflow-hidden bg-gray-100 dark:bg-[#1F1F1F]">
                <div
                className="h-full transition-all duration-700 ease-in-out"
                style={{
                    width: `${item.status === 'fail' ? 100 : progress * 100}%`,
                    backgroundColor:
                    item.status === 'fail'
                        ? '#810701' 
                        : item.status === 'warn'
                        ? '#F59E0B'
                        : '#00778e',
                }}
                ></div>
            </div>
        </div>
        {hoverRect && <FloatingTooltip content={hoverTooltipContent} targetRect={hoverRect} />}
    </>
  );
};

const ChecklistItemList: React.FC<{ item: CheckResult; onClick?: () => void; isHighlighted?: boolean; onInfoClick: (item: CheckResult) => void; uiLanguage: 'ar' | 'en'; }> = ({ item, onClick, isHighlighted, onInfoClick, uiLanguage }) => {
  const t = translations[uiLanguage];
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  
  const statusColor = item.status === 'fail' ? 'bg-[#810701]' : item.status === 'warn' ? 'bg-amber-500' : 'bg-emerald-500';
  const hasViolatingItems = item.violatingItems && item.violatingItems.length > 0;
  
  const conciseSummary = getConciseSummary(item, t, uiLanguage);
  const hoverTooltipContent = (item.status !== 'pass' && item.violatingItems?.[0]?.message)
    ? item.violatingItems[0].message
    : conciseSummary;

  return (
    <>
        <div
            ref={rowRef}
            onClick={onClick}
            onMouseEnter={() => setHoverRect(rowRef.current?.getBoundingClientRect() || null)}
            onMouseLeave={() => setHoverRect(null)}
            className={`group flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all border border-transparent ${isHighlighted ? 'bg-blue-50/50 dark:bg-blue-900/10 border-blue-100 dark:border-blue-800/20' : 'hover:bg-gray-50 dark:hover:bg-[#3C3C3C]'}`}
        >
            <div className="flex items-center gap-3">
                <span className={`w-2 h-2 rounded-full ${statusColor} flex-shrink-0 shadow-sm`}></span>
                <span className="text-[11px] font-bold text-gray-700 dark:text-gray-300">{item.title}</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                {hasViolatingItems && (item.status === 'fail' || item.status === 'warn') ? (
                <span className={`text-white text-[8px] font-black w-3.5 h-3.5 flex items-center justify-center rounded-full ${item.status === 'fail' ? 'bg-[#810701]' : 'bg-amber-500'}`}>{item.violatingItems!.length}</span>
                ) : null}
                <button
                onClick={(e) => { e.stopPropagation(); onInfoClick(item); }}
                className="p-1 rounded-md text-gray-400 hover:bg-gray-200 dark:hover:bg-[#4A4A4A] hover:text-[#00778e]"
                >
                <AlertCircleIcon size={14} />
                </button>
            </div>
        </div>
        {hoverRect && <FloatingTooltip content={hoverTooltipContent} targetRect={hoverRect} />}
    </>
  );
};

const StatDisplay: React.FC<{ icon: React.ReactNode; value: number; label: string }> = ({ icon, value, label }) => (
  <div title={label} className="flex-1 flex items-center justify-center gap-3 p-2 cursor-help group">
    <div className="p-2 bg-[#00778e]/10 dark:bg-[#00778e]/20 text-[#00778e] rounded-full group-hover:scale-110 transition-transform">
      {icon}
    </div>
    <div className={document.documentElement.dir === 'rtl' ? "text-right" : "text-left"}>
      <div className="text-lg font-bold text-[#333333] dark:text-[#b7b7b7] leading-none">{value}</div>
    </div>
  </div>
);

const FixAllModal: React.FC<{
    groups: { [title: string]: number };
    onClose: () => void;
    onConfirm: (selectedRules: string[]) => void;
    t: typeof translations.ar;
}> = ({ groups, onClose, onConfirm, t }) => {
    const [selectedRules, setSelectedRules] = useState<string[]>(() => Object.keys(groups));

    const handleToggleRule = (ruleTitle: string) => {
        setSelectedRules(prev =>
            prev.includes(ruleTitle)
                ? prev.filter(r => r !== ruleTitle)
                : [...prev, ruleTitle]
        );
    };

    const handleToggleAll = () => {
        if (selectedRules.length === Object.keys(groups).length) {
            setSelectedRules([]);
        } else {
            setSelectedRules(Object.keys(groups));
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-white dark:bg-[#2A2A2A] rounded-2xl shadow-2xl w-full max-w-md p-6 border dark:border-[#3C3C3C]" onClick={e => e.stopPropagation()}>
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">{t.fixAllModalTitle}</h3>
                    <button onClick={onClose} className="p-1 rounded-full text-gray-400 hover:bg-gray-200 dark:hover:bg-[#3C3C3C]">
                        <X size={20} />
                    </button>
                </div>
                <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar pr-1">
                    <div
                        className="flex items-center gap-3 p-3 cursor-pointer rounded-lg hover:bg-gray-50 dark:hover:bg-[#3C3C3C] border border-transparent hover:border-gray-100 dark:hover:border-[#444]"
                        onClick={handleToggleAll}
                    >
                        {selectedRules.length === Object.keys(groups).length ? <CheckSquare size={20} className="text-[#00778e]" /> : <Square size={20} className="text-gray-300" />}
                        <span className="font-bold text-sm text-gray-800 dark:text-gray-200">{t.all}</span>
                    </div>
                    <div className="h-px bg-gray-100 dark:bg-[#3C3C3C] my-2"></div>
                    {Object.entries(groups).map(([title, count]) => (
                        <div
                            key={title}
                            className="flex items-center gap-3 p-2.5 cursor-pointer rounded-lg hover:bg-gray-50 dark:hover:bg-[#3C3C3C]"
                            onClick={() => handleToggleRule(title)}
                        >
                            {selectedRules.includes(title) ? <CheckSquare size={20} className="text-[#00778e]" /> : <Square size={20} className="text-gray-300" />}
                            <span className="flex-grow text-sm text-gray-700 dark:text-gray-300">{title}</span>
                            <span className="text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 px-2 py-0.5 rounded-full">{count}</span>
                        </div>
                    ))}
                </div>
                <div className="mt-8 flex justify-end gap-3">
                    <button onClick={onClose} className="px-5 py-2.5 text-sm font-bold text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 dark:bg-[#3C3C3C] dark:text-gray-300 dark:hover:bg-[#4A4A4A] transition-colors">
                        {t.cancel}
                    </button>
                    <button onClick={() => onConfirm(selectedRules)} disabled={selectedRules.length === 0} className="px-5 py-2.5 text-sm font-bold text-white bg-[#00778e] rounded-lg hover:bg-[#005f73] disabled:bg-gray-300 shadow-md shadow-[#00778e]/20 transition-all">
                        {t.startFix} ({selectedRules.length})
                    </button>
                </div>
            </div>
        </div>
    );
};


const StructureTab: React.FC = () => {
    const { structureViewMode: viewMode, uiLanguage } = useUser();
    const { analysisResults } = useEditor();
    const { highlightedItem, handleHighlightStructureItem: onHighlightStructureItem } = useInteraction();
    const { handleFixAllViolations, fixAllProgress } = useAI();
    
    const { structureAnalysis: analysis, structureStats: stats } = analysisResults;
    const [modalContent, setModalContent] = useState<CheckResult | null>(null);
    const [isFixModalOpen, setIsFixModalOpen] = useState(false);
    const t = translations[uiLanguage];
    const tSt = t.structureTab;
    const tAi = t.aiHistory;

    const fixableViolationGroups = useMemo(() => {
        const groups: { [title: string]: number } = {};
        Object.values(analysis)
            .filter((rule: any) => rule && FIXABLE_RULES.has(rule.title) && rule.violatingItems && rule.violatingItems.length > 0)
            .forEach((rule: any) => {
                groups[rule.title] = (groups[rule.title] || 0) + rule.violatingItems!.length;
            });
        return groups;
    }, [analysis]);
    
    const fixableViolationsCount = Object.values(fixableViolationGroups).reduce((sum: number, count: number) => sum + count, 0);

    const handleStartFixing = (selectedRules: string[]) => {
        handleFixAllViolations(selectedRules);
        setIsFixModalOpen(false);
    };
    
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setModalContent(null);
                setIsFixModalOpen(false);
            }
        };

        if (modalContent || isFixModalOpen) {
            document.addEventListener('keydown', handleKeyDown);
        }

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [modalContent, isFixModalOpen]);

    const analysisGroups = [
      {
          name: tSt.basicStructure,
          icon: <LayoutTemplate size={16} className="text-[#00778e]" />,
          items: [
              analysis.wordCount,
              analysis.summaryParagraph,
              analysis.secondParagraph,
              analysis.paragraphLength,
              analysis.sentenceLength,
              analysis.stepsIntroduction,
              analysis.keywordStuffing,
              analysis.automaticLists,
          ],
      },
      {
          name: tSt.headingsSequence,
          icon: <ListTree size={16} className="text-[#00778e]" />,
          items: [
              analysis.h2Structure,
              analysis.h2Count,
              analysis.h3Structure,
              analysis.h4Structure,
              analysis.betweenH2H3,
              analysis.faqSection,
              analysis.answerParagraph,
              analysis.ambiguousHeadings,
              analysis.headingLength,
          ],
      },
      {
          name: tSt.languageQuality,
          icon: <SpellCheck size={16} className="text-[#00778e]" />,
          items: [
              analysis.punctuation,
              analysis.paragraphEndings,
              analysis.interrogativeH2,
              analysis.duplicateWordsInParagraph,
              analysis.duplicateWordsInHeading,
              analysis.sentenceBeginnings,
              analysis.arabicOnly,
              analysis.spacing,
              analysis.repeatedBigrams,
              analysis.wordConsistency,
              analysis.wordsToDelete,
          ],
      },
      {
          name: tSt.interactionCta,
          icon: <MousePointerClick size={16} className="text-[#00778e]" />,
          items: [
              analysis.ctaWords,
              analysis.interactiveLanguage,
              analysis.warningWords,
              analysis.differentTransitionalWords,
              analysis.slowWords,
          ],
      },
      {
          name: tSt.conclusion,
          icon: <Flag size={16} className="text-[#00778e]" />,
          items: [
              analysis.lastH2IsConclusion,
              analysis.conclusionParagraph,
              analysis.conclusionWordCount,
              analysis.conclusionHasNumber,
              analysis.conclusionHasList,
          ],
      },
    ];

  return (
    <div className="p-2 space-y-3">
       <div className="px-1 py-1">
         <div className="flex bg-white dark:bg-gradient-to-r from-[#2A2A2A] via-[#222222] to-[#1F1F1F] rounded-2xl border border-gray-200 dark:border-[#3C3C3C] divide-x divide-gray-100 dark:divide-[#3C3C3C] shadow-sm">
            <StatDisplay icon={<ShieldAlert size={16} />} value={stats.violatingCriteriaCount} label={tSt.violatingCriteria} />
            <StatDisplay icon={<AlertCircleIcon size={16} />} value={stats.totalErrorsCount} label={tSt.totalErrors} />
            <StatDisplay icon={<Pilcrow size={16} />} value={stats.paragraphCount} label={tSt.paragraph} />
            <StatDisplay icon={<Heading size={16} />} value={stats.headingCount} label={tSt.heading} />
          </div>
       </div>
       <div className="px-1">
          <button
              onClick={() => setIsFixModalOpen(true)}
              disabled={fixAllProgress.running || fixableViolationsCount === 0}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-xs font-black uppercase tracking-widest text-white bg-gradient-to-r from-[#00778e] to-[#005f73] rounded-2xl hover:shadow-lg disabled:from-gray-400 disabled:to-gray-500 disabled:cursor-not-allowed transition-all"
          >
              {fixAllProgress.running ? (
                  <>
                      <Loader2 size={16} className="animate-spin" />
                      <span>{tAi.fixingInProgress.replace('{current}', String(fixAllProgress.current)).replace('{total}', String(fixAllProgress.total))}</span>
                  </>
              ) : (
                  <>
                      <Wand2 size={16} />
                      <span>{tAi.fixAll.replace('{count}', String(fixableViolationsCount))}</span>
                  </>
              )}
          </button>
       </div>

      {viewMode === 'grid' ? (
        <div className="space-y-6 px-1">
          {analysisGroups.map((group) => {
            const validItems = group.items.filter(Boolean);
            if (validItems.length === 0) return null;

            return (
              <div key={group.name}>
                <h3 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-gray-400 dark:text-gray-500 mb-4 px-1">
                  {group.icon}
                  <span>{group.name}</span>
                </h3>
                <div className="grid grid-cols-2 gap-2.5">
                  {validItems.map((item) => (
                    <ChecklistItem
                      key={item!.title}
                      item={item!}
                      onClick={() => onHighlightStructureItem(item!)}
                      isHighlighted={highlightedItem === item!.title}
                      onInfoClick={() => setModalContent(item!)}
                      uiLanguage={uiLanguage}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-5 px-1">
          {analysisGroups.map((group) => {
            const validItems = group.items.filter(Boolean);
            if (validItems.length === 0) return null;

            return (
                <div key={group.name} className="bg-white dark:bg-[#2A2A2A] p-4 rounded-2xl border border-gray-200 dark:border-[#3C3C3C] shadow-sm">
                  <h3 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-4">
                    {group.icon}
                    <span>{group.name}</span>
                  </h3>
                  <div className="space-y-1.5">
                    {validItems.map((item) => (
                      <ChecklistItemList
                        key={item!.title}
                        item={item!}
                        onClick={() => onHighlightStructureItem(item!)}
                        isHighlighted={highlightedItem === item!.title}
                        onInfoClick={() => setModalContent(item!)}
                        uiLanguage={uiLanguage}
                      />
                    ))}
                  </div>
                </div>
            )
          })}
        </div>
      )}
      
      {modalContent && <InfoModal item={modalContent} onClose={() => setModalContent(null)} t={tSt} />}
      {isFixModalOpen && (
        <FixAllModal
          groups={fixableViolationGroups}
          onClose={() => setIsFixModalOpen(false)}
          onConfirm={handleStartFixing}
          t={t}
        />
      )}
    </div>
  );
};

export default StructureTab;