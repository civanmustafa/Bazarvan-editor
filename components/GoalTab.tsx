import React from 'react';
import type { StructureAnalysis, CheckResult, AnalysisStatus } from '../types';
import { Info, ShoppingCart, GitCompare, ChevronDown, BookOpen, Map, Star, AlertCircle, Smartphone } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useInteraction } from '../contexts/InteractionContext';


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


const GoalConditionCard: React.FC<{
  item: CheckResult;
  onClick: () => void;
  isHighlighted: boolean;
  uiLanguage: 'ar' | 'en';
}> = ({ item, onClick, isHighlighted, uiLanguage }) => {
  const [isInfoOpen, setIsInfoOpen] = React.useState(false);
  const t = translations[uiLanguage];
  const progress = Math.max(0, Math.min(item.progress || 0, 1));
  const violationCount = item.status === 'fail' ? (item.violatingItems?.length || 1) : 0;
  const conciseSummary = getConciseSummary(item, t, uiLanguage);
  const cardHeightClass = "min-h-[5.5rem]";

  return (
    <div className="relative">
      <div
        className={`group relative rounded-lg transition-all duration-200 cursor-pointer bg-white hover:bg-[#d4af37]/10 dark:bg-[#2A2A2A] dark:hover:bg-[#d4af37]/20 ${cardHeightClass} flex flex-col justify-between p-3 pt-2 shadow-sm`}
        onClick={onClick}
      >
        <div className="absolute -top-9 end-1/2 translate-x-1/2 w-max max-w-xs bg-gray-900 text-white text-xs rounded-md py-1.5 px-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none z-20 whitespace-nowrap">
          {conciseSummary}
          <div className="absolute top-full end-1/2 -translate-x-1/2 w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-gray-900"></div>
        </div>
        
        {isHighlighted && (
          <div className="absolute top-0 end-0 w-8 h-8" aria-hidden="true">
            <div className={`absolute inset-0 ${item.status === 'fail' ? 'bg-[#810701]' : 'bg-[#d4af37]'} [clip-path:polygon(0_0,100%_0,0_100%)] rounded-tl-lg`}></div>
            <Star size={10} className="absolute top-1.5 end-1.5 text-white -rotate-45" fill="white" />
          </div>
        )}
        
        <div className="flex-1 flex items-start justify-between">
          <div className="flex-1 pe-6">
            <h4 className="font-bold text-sm text-gray-700 dark:text-gray-200">{item.title}</h4>
            <div className="text-xs mt-1 text-gray-500 dark:text-gray-400">
                <span className="font-semibold">{t.leftSidebar.current}:</span> {item.current} / <span className="font-semibold">{t.leftSidebar.required}:</span> {item.required}
            </div>
          </div>
          <div className="flex items-center gap-2 absolute top-2 start-2">
            {violationCount > 0 && (
              <span 
                className="text-white text-[9px] font-bold w-3.5 h-3.5 flex items-center justify-center rounded-full"
                style={{ backgroundColor: '#810701' }}
              >
                  {violationCount}
              </span>
            )}
            <button 
                onClick={(e) => {
                    e.stopPropagation();
                    setIsInfoOpen(prev => !prev);
                }}
                className="p-1 rounded-full text-gray-400 hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20"
                aria-label={t.structureTab.showDetails}
            >
                <AlertCircle size={16} />
            </button>
          </div>
        </div>

        <div
          className="absolute bottom-0 start-0 w-full h-1.5 rounded-b-lg overflow-hidden bg-gray-200 dark:bg-[#1F1F1F]"
        >
          <div
            className="h-full transition-all duration-500 ease-out"
            style={{
              width: `${item.status === 'fail' ? 100 : progress * 100}%`,
              backgroundColor:
                item.status === 'fail'
                  ? '#810701' 
                  : item.status === 'warn'
                  ? '#F59E0B'
                  : '#d4af37',
            }}
          ></div>
        </div>
      </div>

      {isInfoOpen && (
        <div className="absolute z-10 w-full mt-1 p-3 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-300">
          {item.description || "لا يوجد وصف إضافي."}
        </div>
      )}
    </div>
  );
};

const GoalContextSelect: React.FC<{
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => (
  <label className="block">
    <span className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">{label}</span>
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-md border border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F] px-2 py-2 text-sm text-[#333333] dark:text-[#e0e0e0] focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37]"
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  </label>
);

const GoalTab: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
    const { uiLanguage } = useUser();
    const { 
        analysisResults,
        aiGoal,
        setAiGoal,
        goalContext,
        setGoalContext,
    } = useEditor();
    const { 
        highlightedItem,
        handleHighlightStructureItem: onHighlightStructureItem,
    } = useInteraction();
    
    const { structureAnalysis } = analysisResults;

  const t = translations[uiLanguage].goalTab;
  const contextOptions = t.contextOptions;

  const goalOptions = [
    { value: 'اكاديمية', label: t.academy, icon: <Info size={18} /> },
    { value: 'البيع', label: t.sellService, icon: <ShoppingCart size={18} /> },
    { value: 'بيع جهاز', label: t.sellDevice, icon: <Smartphone size={18} /> },
    { value: 'مدونة', label: t.blog, icon: <BookOpen size={18} /> },
    { value: 'برنامج سياحي', label: t.tourism, icon: <Map size={18} /> },
    { value: 'مقارنة', label: t.comparison, icon: <GitCompare size={18} /> },
  ];

  const [isGoalOpen, setIsGoalOpen] = React.useState(false);
  const selectedGoal = goalOptions.find(opt => opt.value === aiGoal) || goalOptions[0];
  const updateGoalContext = (key: keyof typeof goalContext, value: string) => {
    setGoalContext(prev => ({ ...prev, [key]: value }));
  };
  const pageTypeOptions = [
    { value: 'article', label: contextOptions.article },
    { value: 'news', label: contextOptions.news },
    { value: 'service', label: contextOptions.service },
    { value: 'comparison', label: contextOptions.comparisonPage },
    { value: 'product', label: contextOptions.product },
    { value: 'landing', label: contextOptions.landing },
    { value: 'guide', label: contextOptions.guide },
    { value: 'faq', label: contextOptions.faq },
  ];
  const objectiveOptions = [
    { value: 'educate', label: contextOptions.educate },
    { value: 'sell', label: contextOptions.sell },
    { value: 'bookings', label: contextOptions.bookings },
    { value: 'leads', label: contextOptions.leads },
    { value: 'trust', label: contextOptions.trust },
    { value: 'retention', label: contextOptions.retention },
  ];
  const awarenessOptions = [
    { value: 'unaware', label: contextOptions.unaware },
    { value: 'problem-aware', label: contextOptions.problemAware },
    { value: 'solution-aware', label: contextOptions.solutionAware },
    { value: 'product-aware', label: contextOptions.productAware },
    { value: 'ready-to-buy', label: contextOptions.readyToBuy },
  ];
  const scopeOptions = [
    { value: 'local', label: contextOptions.local },
    { value: 'country', label: contextOptions.country },
    { value: 'regional', label: contextOptions.regional },
    { value: 'global', label: contextOptions.global },
  ];
  const intentOptions = [
    { value: 'informational', label: contextOptions.informational },
    { value: 'commercial', label: contextOptions.commercial },
    { value: 'transactional', label: contextOptions.transactional },
    { value: 'navigational', label: contextOptions.navigational },
    { value: 'local-intent', label: contextOptions.localIntent },
  ];
  const funnelOptions = [
    { value: 'awareness', label: contextOptions.awareness },
    { value: 'consideration', label: contextOptions.consideration },
    { value: 'decision', label: contextOptions.decision },
    { value: 'loyalty', label: contextOptions.loyalty },
  ];
  
  const touristProgramChecks = [
      structureAnalysis.firstTitle,
      structureAnalysis.secondTitle,
      structureAnalysis.includesExcludes,
      structureAnalysis.preTravelH2,
      structureAnalysis.pricingH2,
      structureAnalysis.whoIsItForH2,
  ].filter(check => check && check.current !== 'غير مطبق' && check.current !== 'Not applicable');

  const deviceSaleChecks = [
      structureAnalysis.mandatoryH2Sections,
      structureAnalysis.supportingH2Sections,
      structureAnalysis.tablesCount,
  ].filter(check => check && check.current !== 'غير مطبق' && check.current !== 'Not applicable');

  return (
    <div className={`${embedded ? 'p-0' : 'p-4'} space-y-4`}>
      <div className="bg-white dark:bg-[#2A2A2A] rounded-xl shadow-sm border dark:border-[#3C3C3C] p-4 space-y-4 transition-all duration-300 border-gray-200 dark:border-transparent">
        <div>
            <label htmlFor="ai-goal-button" className="block text-sm font-semibold text-[#333333] dark:text-[#C7C7C7] mb-2">
                {t.goal}
            </label>
            <div className="relative">
                <button
                    id="ai-goal-button"
                    type="button"
                    className="relative w-full cursor-pointer rounded-md border border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F] py-2 ps-3 pe-10 text-start shadow-sm focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37] sm:text-sm"
                    aria-haspopup="listbox"
                    aria-expanded={isGoalOpen}
                    onClick={() => setIsGoalOpen(!isGoalOpen)}
                >
                    <span className="flex items-center gap-3">
                        <span className="text-[#d4af37]">{selectedGoal.icon}</span>
                        <span className="block truncate text-[#333333] dark:text-[#e0e0e0]">{selectedGoal.label}</span>
                    </span>
                    <span className="pointer-events-none absolute inset-y-0 end-0 flex items-center pe-2">
                    <ChevronDown className={`h-5 w-5 text-gray-400 transform transition-transform ${isGoalOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </span>
                </button>

                {isGoalOpen && (
                    <ul
                    className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-white dark:bg-[#3C3C3C] py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm"
                    tabIndex={-1}
                    role="listbox"
                    aria-labelledby="ai-goal-button"
                    >
                    {goalOptions.map((option) => (
                        <li
                        key={option.value}
                        className="group relative cursor-pointer select-none py-2 ps-3 pe-9 text-gray-900 dark:text-gray-200 hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/15"
                        role="option"
                        aria-selected={option.value === aiGoal}
                        onClick={() => {
                            setAiGoal(option.value);
                            setIsGoalOpen(false);
                        }}
                        >
                        <div className="flex items-center gap-3">
                            <span className="text-[#d4af37] group-hover:text-[#b8922e] dark:group-hover:text-[#f2d675]">{option.icon}</span>
                            <span className={`block truncate ${option.value === aiGoal ? 'font-semibold' : 'font-normal'}`}>{option.label}</span>
                        </div>
                        </li>
                    ))}
                    </ul>
                )}
            </div>
        </div>

        <div className="space-y-3 border-t border-gray-200 dark:border-[#3C3C3C] pt-4">
            <div>
                <h4 className="text-sm font-bold text-[#333333] dark:text-gray-100">{t.contextTitle}</h4>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t.contextDescription}</p>
            </div>
            <div className="grid grid-cols-1 gap-3">
                <GoalContextSelect label={t.pageType} value={goalContext.pageType} options={pageTypeOptions} onChange={(value) => updateGoalContext('pageType', value)} />
                <GoalContextSelect label={t.objective} value={goalContext.objective} options={objectiveOptions} onChange={(value) => updateGoalContext('objective', value)} />
                <GoalContextSelect label={t.audienceAwareness} value={goalContext.audienceAwareness} options={awarenessOptions} onChange={(value) => updateGoalContext('audienceAwareness', value)} />
                <GoalContextSelect label={t.audienceScope} value={goalContext.audienceScope} options={scopeOptions} onChange={(value) => updateGoalContext('audienceScope', value)} />
                <label className="block">
                    <span className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">{t.targetCountry}</span>
                    <input
                        value={goalContext.targetCountry}
                        onChange={(event) => updateGoalContext('targetCountry', event.target.value)}
                        className="w-full rounded-md border border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F] px-2 py-2 text-sm text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37]"
                        placeholder={t.targetCountryPlaceholder}
                    />
                </label>
                <label className="block">
                    <span className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">{t.targetAudience}</span>
                    <input
                        value={goalContext.targetAudience}
                        onChange={(event) => updateGoalContext('targetAudience', event.target.value)}
                        className="w-full rounded-md border border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F] px-2 py-2 text-sm text-[#333333] dark:text-[#e0e0e0] placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37]"
                        placeholder={t.targetAudiencePlaceholder}
                    />
                </label>
                <GoalContextSelect label={t.searchIntent} value={goalContext.searchIntent} options={intentOptions} onChange={(value) => updateGoalContext('searchIntent', value)} />
                <GoalContextSelect label={t.funnelStage} value={goalContext.funnelStage} options={funnelOptions} onChange={(value) => updateGoalContext('funnelStage', value)} />
            </div>
        </div>

        {aiGoal === 'برنامج سياحي' && touristProgramChecks.length > 0 && (
            <div className="space-y-3 border-t border-gray-200 dark:border-[#3C3C3C] pt-4">
                {touristProgramChecks.map(check => (
                    <GoalConditionCard
                        key={check.title}
                        item={check}
                        onClick={() => onHighlightStructureItem(check)}
                        isHighlighted={highlightedItem === check.title}
                        uiLanguage={uiLanguage}
                    />
                ))}
            </div>
        )}

        {aiGoal === 'بيع جهاز' && deviceSaleChecks.length > 0 && (
            <div className="space-y-3 border-t border-gray-200 dark:border-[#3C3C3C] pt-4">
                {deviceSaleChecks.map(check => (
                    <GoalConditionCard
                        key={check.title}
                        item={check}
                        onClick={() => onHighlightStructureItem(check)}
                        isHighlighted={highlightedItem === check.title}
                        uiLanguage={uiLanguage}
                    />
                ))}
            </div>
        )}

      </div>
    </div>
  );
};

export default GoalTab;
