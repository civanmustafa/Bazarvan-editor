import React, { useEffect, useState, useMemo, useRef } from 'react';
import type { BulkFixRelatedRule, BulkFixReviewItem, BulkFixReviewStats, BulkFixReviewVariant, CheckResult } from '../types';
import { Pilcrow, Heading, AlertCircle as AlertCircleIcon, Star, LayoutTemplate, ListTree, SpellCheck, MousePointerClick, Flag, X, ShieldAlert, Wand2, Loader2, CheckSquare, Square, MapPin, Copy, Check, Trash2 } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useInteraction } from '../contexts/InteractionContext';
import { useAI } from '../contexts/AIContext';

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
          <button onClick={onClose} className="p-2 rounded-full hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20 transition-colors" aria-label={t.close}>
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
              <h4 className="font-bold text-[#d4af37] dark:text-[#f2d675] mb-4 flex items-center gap-2 text-sm">
                <ListTree size={18} />
                {t.availableConditions}
              </h4>
              <div className="text-xs space-y-3 whitespace-pre-line leading-loose text-gray-500 dark:text-gray-400 font-medium">
                {item.details || (document.documentElement.lang === 'ar' ? 'لا توجد تفاصيل إضافية لهذا المعيار.' : 'No additional details for this criterion.')}
              </div>
          </div>

          <div className="flex justify-between items-center bg-gray-100/50 dark:bg-[#333] p-3 rounded-xl text-xs font-bold">
              <div className="flex gap-6">
                  <span className="flex items-center gap-2"><span className="text-gray-400 font-normal">{document.documentElement.lang === 'ar' ? 'المطلوب:' : 'Required:'}</span> <span className="text-[#d4af37]">{item.required}</span></span>
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
            className={`group relative rounded-xl transition-all duration-200 cursor-pointer bg-white hover:bg-[#d4af37]/10 dark:bg-[#2A2A2A] dark:hover:bg-[#d4af37]/20 h-14 flex flex-col justify-between border border-gray-100 dark:border-[#3C3C3C] hover:border-[#d4af37]/30 dark:hover:border-[#d4af37]/30 shadow-sm`}
            onClick={onClick}
            onMouseEnter={() => setHoverRect(cardRef.current?.getBoundingClientRect() || null)}
            onMouseLeave={() => setHoverRect(null)}
        >
            {isHighlighted && (
                <div className="absolute top-0 end-0 w-8 h-8" aria-hidden="true">
                <div className={`absolute inset-0 ${item.status === 'fail' ? 'bg-[#810701]' : item.status === 'warn' ? 'bg-amber-500' : 'bg-[#d4af37]'} [clip-path:polygon(0_0,100%_0,0_100%)] rounded-tl-lg`}></div>
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
                        className="p-1 rounded-md text-gray-400 hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/25 hover:text-[#d4af37] transition-all"
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
                        : '#d4af37',
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
            className={`group flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all border border-transparent ${isHighlighted ? 'bg-[#d4af37]/10 dark:bg-[#d4af37]/10 border-[#d4af37]/20 dark:border-[#d4af37]/20' : 'hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20'}`}
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
                className="p-1 rounded-md text-gray-400 hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/25 hover:text-[#d4af37]"
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
    <div className="p-2 bg-[#d4af37]/10 dark:bg-[#d4af37]/20 text-[#d4af37] rounded-full group-hover:scale-110 transition-transform">
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
    onConfirm: (selectedRules: string[], includeRelatedRules: boolean) => void;
    getRelatedRules: (selectedRules: string[]) => BulkFixRelatedRule[];
    uiLanguage: 'ar' | 'en';
    t: typeof translations.ar;
}> = ({ groups, onClose, onConfirm, getRelatedRules, uiLanguage, t }) => {
    const [selectedRules, setSelectedRules] = useState<string[]>(() => Object.keys(groups));
    const [includeRelatedRules, setIncludeRelatedRules] = useState(true);
    const isArabic = uiLanguage === 'ar';
    const relatedRules = useMemo(() => getRelatedRules(selectedRules), [getRelatedRules, selectedRules]);
    const relatedRulesCount = relatedRules.reduce((sum, rule) => sum + rule.count, 0);

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
                    <button onClick={onClose} className="p-1 rounded-full text-gray-400 hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20">
                        <X size={20} />
                    </button>
                </div>
                <p className="mb-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                    {isArabic
                        ? 'سيتم إنشاء قائمة إصلاحات مقترحة للمراجعة فقط. لن يتم تعديل النص قبل أن تطبق الاقتراحات بنفسك.'
                        : 'This creates reviewable fix proposals only. The editor text will not change until you apply them.'}
                </p>
                <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar pr-1">
                    <div
                        className="flex items-center gap-3 p-3 cursor-pointer rounded-lg hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20 border border-transparent hover:border-gray-100 dark:hover:border-[#444]"
                        onClick={handleToggleAll}
                    >
                        {selectedRules.length === Object.keys(groups).length ? <CheckSquare size={20} className="text-[#d4af37]" /> : <Square size={20} className="text-gray-300" />}
                        <span className="font-bold text-sm text-gray-800 dark:text-gray-200">{t.all}</span>
                    </div>
                    <div className="h-px bg-gray-100 dark:bg-[#3C3C3C] my-2"></div>
                    {Object.entries(groups).map(([title, count]) => (
                        <div
                            key={title}
                            className="flex items-center gap-3 p-2.5 cursor-pointer rounded-lg hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20"
                            onClick={() => handleToggleRule(title)}
                        >
                            {selectedRules.includes(title) ? <CheckSquare size={20} className="text-[#d4af37]" /> : <Square size={20} className="text-gray-300" />}
                            <span className="flex-grow text-sm text-gray-700 dark:text-gray-300">{title}</span>
                            <span className="text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 px-2 py-0.5 rounded-full">{count}</span>
                        </div>
                    ))}
                </div>
                {relatedRules.length > 0 && (
                    <div className="mt-4 rounded-xl border border-[#d4af37]/25 bg-[#d4af37]/5 p-3 dark:border-[#d4af37]/20 dark:bg-[#d4af37]/10">
                        <button
                            type="button"
                            onClick={() => setIncludeRelatedRules(prev => !prev)}
                            className="flex w-full items-start gap-2 text-start"
                        >
                            {includeRelatedRules ? <CheckSquare size={18} className="mt-0.5 text-[#d4af37]" /> : <Square size={18} className="mt-0.5 text-gray-300" />}
                            <span className="min-w-0">
                                <span className="block text-xs font-black text-gray-800 dark:text-gray-100">
                                    {isArabic ? 'تضمين المعايير المرتبطة في نفس المواضع' : 'Include related criteria in the same locations'}
                                </span>
                                <span className="mt-1 block text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
                                    {isArabic
                                        ? `تم العثور على ${relatedRulesCount} مخالفة مرتبطة داخل نفس الفقرات أو الأقسام المحددة.`
                                        : `${relatedRulesCount} related violations were found in the same selected paragraphs or sections.`}
                                </span>
                            </span>
                        </button>
                        <div className="mt-3 max-h-28 overflow-y-auto custom-scrollbar space-y-1.5">
                            {relatedRules.map((rule) => (
                                <div key={rule.title} className="flex items-center gap-2 rounded-lg bg-white/70 px-2 py-1.5 text-[10px] font-bold text-gray-600 dark:bg-[#1F1F1F]/70 dark:text-gray-300">
                                    <span className="min-w-0 flex-1 truncate">{rule.title}</span>
                                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-black text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">{rule.count}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                <div className="mt-8 flex justify-end gap-3">
                    <button onClick={onClose} className="px-5 py-2.5 text-sm font-bold text-gray-600 bg-gray-100 rounded-lg hover:bg-[#d4af37]/15 dark:bg-[#3C3C3C] dark:text-gray-300 dark:hover:bg-[#d4af37]/25 transition-colors">
                        {t.cancel}
                    </button>
                    <button onClick={() => onConfirm(selectedRules, includeRelatedRules && relatedRules.length > 0)} disabled={selectedRules.length === 0} className="px-5 py-2.5 text-sm font-bold text-white bg-[#d4af37] rounded-lg hover:bg-[#b8922e] disabled:bg-gray-300 shadow-md shadow-[#d4af37]/20 transition-all">
                        {isArabic ? 'إنشاء الاقتراحات' : 'Create Proposals'} ({selectedRules.length}{includeRelatedRules && relatedRules.length > 0 ? ` + ${relatedRules.length}` : ''})
                    </button>
                </div>
            </div>
        </div>
    );
};

const BulkFixReviewPanel: React.FC<{
    items: BulkFixReviewItem[];
    selectedIds: string[];
    onToggleItem: (itemId: string) => void;
    onToggleAll: () => void;
    onApplyItem: (itemId: string, variantId?: string) => void;
    onApplySelected: () => void;
    onLocateItem: (itemId: string) => void;
    onSkipItem: (itemId: string) => void;
    onClear: () => void;
    uiLanguage: 'ar' | 'en';
}> = ({
    items,
    selectedIds,
    onToggleItem,
    onToggleAll,
    onApplyItem,
    onApplySelected,
    onLocateItem,
    onSkipItem,
    onClear,
    uiLanguage,
}) => {
    if (items.length === 0) return null;

    const isArabic = uiLanguage === 'ar';
    const pendingItems = items.filter(item => item.status === 'pending');
    const selectedPendingCount = selectedIds.filter(id => pendingItems.some(item => item.id === id)).length;
    const allPendingSelected = pendingItems.length > 0 && selectedPendingCount === pendingItems.length;
    const statusLabel = (item: BulkFixReviewItem) => {
        if (item.status === 'applied') return isArabic ? 'تم التطبيق' : 'Applied';
        if (item.status === 'failed') return isArabic ? 'تعذر التطبيق' : 'Failed';
        if (item.status === 'skipped') return isArabic ? 'تم التجاهل' : 'Skipped';
        return isArabic ? 'بانتظار المراجعة' : 'Pending review';
    };
    const statusClass = (item: BulkFixReviewItem) => {
        if (item.status === 'applied') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-300';
        if (item.status === 'failed') return 'bg-red-100 text-red-700 dark:bg-red-900/25 dark:text-red-300';
        if (item.status === 'skipped') return 'bg-gray-100 text-gray-600 dark:bg-[#333] dark:text-gray-300';
        return 'bg-amber-100 text-amber-700 dark:bg-amber-900/25 dark:text-amber-300';
    };
    const copyText = (text: string) => {
        void navigator.clipboard?.writeText(text);
    };
    const renderStats = (before: BulkFixReviewStats, after: BulkFixReviewStats) => {
        const items = [
            [isArabic ? 'الكلمات' : 'Words', before.words, after.words],
            [isArabic ? 'الجمل' : 'Sentences', before.sentences, after.sentences],
            [isArabic ? 'الفقرات' : 'Paragraphs', before.paragraphs, after.paragraphs],
        ];

        return (
            <div className="grid grid-cols-3 gap-1.5">
                {items.map(([label, beforeValue, afterValue]) => (
                    <div key={String(label)} className="rounded-md bg-white/80 px-2 py-1 text-[9px] font-bold text-gray-500 border border-[#d4af37]/10 dark:bg-[#1F1F1F]/70 dark:text-gray-300 dark:border-[#3C3C3C]">
                        <span className="block text-gray-400">{label}</span>
                        <span className="text-gray-700 dark:text-gray-100">{beforeValue}</span>
                        <span className="mx-1 text-[#d4af37]">→</span>
                        <span className="text-[#b8922e] dark:text-[#f2d675]">{afterValue}</span>
                    </div>
                ))}
            </div>
        );
    };
    const criterionStatusClass = (status?: string) => {
        if (status === 'pass') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-300';
        if (status === 'fail') return 'bg-red-100 text-red-700 dark:bg-red-900/25 dark:text-red-300';
        if (status === 'warn') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/25 dark:text-amber-300';
        return 'bg-gray-100 text-gray-600 dark:bg-[#333] dark:text-gray-300';
    };
    const criterionStatusLabel = (status?: string) => {
        if (status === 'pass') return isArabic ? 'ضمن الحد' : 'Pass';
        if (status === 'fail') return isArabic ? 'خارج الحد' : 'Fail';
        if (status === 'warn') return isArabic ? 'يحتاج مراجعة' : 'Review';
        return isArabic ? 'غير مؤكد' : 'Unknown';
    };

    return (
        <div className="mt-3 rounded-2xl border border-[#d4af37]/25 bg-[#d4af37]/5 dark:bg-[#d4af37]/10 dark:border-[#d4af37]/20 overflow-hidden">
            <div className="p-3 border-b border-[#d4af37]/15 dark:border-[#d4af37]/20">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <h3 className="text-xs font-black text-gray-800 dark:text-gray-100">
                            {isArabic ? 'قائمة إصلاحات مقترحة' : 'Proposed Fix Review'}
                        </h3>
                        <p className="mt-1 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
                            {isArabic
                                ? 'راجع النص قبل وبعد، واختر أحد البدائل أو طبق الاقتراح الأول للعناصر المحددة.'
                                : 'Review the before and after text, choose a variant, or apply the first suggestion for selected items.'}
                        </p>
                    </div>
                    <button
                        onClick={onClear}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        title={isArabic ? 'مسح القائمة' : 'Clear list'}
                    >
                        <X size={15} />
                    </button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                        onClick={onToggleAll}
                        disabled={pendingItems.length === 0}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-white text-gray-700 border border-gray-200 hover:border-[#d4af37]/50 disabled:opacity-50 dark:bg-[#2A2A2A] dark:text-gray-200 dark:border-[#3C3C3C]"
                    >
                        {allPendingSelected ? <CheckSquare size={14} className="text-[#d4af37]" /> : <Square size={14} />}
                        <span>{isArabic ? 'تحديد الكل' : 'Select all'}</span>
                    </button>
                    <button
                        onClick={onApplySelected}
                        disabled={selectedPendingCount === 0}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-black bg-[#d4af37] text-white hover:bg-[#b8922e] disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                    >
                        <Check size={14} />
                        <span>{isArabic ? `تطبيق المحدد (${selectedPendingCount})` : `Apply selected (${selectedPendingCount})`}</span>
                    </button>
                </div>
            </div>

            <div className="divide-y divide-[#d4af37]/15 dark:divide-[#d4af37]/20 max-h-[560px] overflow-y-auto custom-scrollbar">
                {items.map((item, index) => {
                    const isPending = item.status === 'pending';
                    const isSelected = selectedIds.includes(item.id);
                    return (
                        <div key={item.id} className="p-3 bg-white/70 dark:bg-[#242424]/70">
                            <div className="flex items-start justify-between gap-2">
                                <button
                                    onClick={() => onToggleItem(item.id)}
                                    disabled={!isPending}
                                    className="mt-0.5 p-1 rounded-md text-gray-400 hover:text-[#d4af37] disabled:opacity-40"
                                    title={isArabic ? 'تحديد الاقتراح' : 'Select proposal'}
                                >
                                    {isSelected && isPending ? <CheckSquare size={16} className="text-[#d4af37]" /> : <Square size={16} />}
                                </button>
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-[10px] font-black text-gray-400">#{index + 1}</span>
                                        <span className="text-[11px] font-black text-gray-800 dark:text-gray-100">{item.ruleTitle}</span>
                                        {item.ruleTitles && item.ruleTitles.length > 1 && (
                                            <span className="px-2 py-0.5 rounded-full text-[9px] font-black bg-[#d4af37]/15 text-[#8a6a12] dark:bg-[#d4af37]/20 dark:text-[#f2d675]">
                                                {isArabic ? `بطاقة مركبة: ${item.ruleTitles.length} معايير` : `Combined: ${item.ruleTitles.length} criteria`}
                                            </span>
                                        )}
                                        {item.variants && item.variants.length > 1 && (
                                            <span className="px-2 py-0.5 rounded-full text-[9px] font-black bg-blue-100 text-blue-700 dark:bg-blue-900/25 dark:text-blue-300">
                                                {isArabic ? `${item.variants.length} بدائل` : `${item.variants.length} variants`}
                                            </span>
                                        )}
                                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${statusClass(item)}`}>{statusLabel(item)}</span>
                                    </div>
                                    {item.ruleTitles && item.ruleTitles.length > 1 && (
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            {item.ruleTitles.slice(0, 6).map((ruleTitle) => (
                                                <span key={ruleTitle} className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[9px] font-bold text-gray-500 dark:bg-[#333] dark:text-gray-300">
                                                    {ruleTitle}
                                                </span>
                                            ))}
                                            {item.ruleTitles.length > 6 && (
                                                <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[9px] font-bold text-gray-500 dark:bg-[#333] dark:text-gray-300">
                                                    +{item.ruleTitles.length - 6}
                                                </span>
                                            )}
                                        </div>
                                    )}
                                    {item.message && (
                                        <p className="mt-1 text-[10px] leading-relaxed text-gray-500 dark:text-gray-400">{item.message}</p>
                                    )}
                                    {item.criteria && item.criteria.length > 1 && (
                                        <div className="mt-2 rounded-lg border border-[#d4af37]/15 bg-white/70 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]/70">
                                            <div className="mb-1 text-[9px] font-black uppercase tracking-widest text-[#b8922e]">
                                                {isArabic ? 'المعايير المخالفة' : 'Violated criteria'}
                                            </div>
                                            <div className="space-y-1">
                                                {item.criteria.map((criterion) => (
                                                    <div key={criterion.title} className="rounded-md bg-gray-50 p-1.5 text-[10px] leading-relaxed text-gray-600 dark:bg-[#2A2A2A] dark:text-gray-300">
                                                        <div className="font-black text-gray-800 dark:text-gray-100">{criterion.title}</div>
                                                        <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
                                                            <span>{isArabic ? 'الحالي' : 'Current'}: <b>{criterion.current}</b></span>
                                                            <span>{isArabic ? 'المطلوب' : 'Required'}: <b>{criterion.required}</b></span>
                                                        </div>
                                                        {criterion.message && (
                                                            <div className="mt-1 text-[9px] text-gray-400 dark:text-gray-500">{criterion.message}</div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    <div className="mt-2">
                                        <button
                                            onClick={() => onLocateItem(item.id)}
                                            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold bg-gray-100 text-gray-700 hover:bg-[#d4af37]/15 dark:bg-[#333] dark:text-gray-200 dark:hover:bg-[#d4af37]/20"
                                        >
                                            <MapPin size={13} />
                                            <span>{isArabic ? 'تحديد الموضع' : 'Locate'}</span>
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div className="mt-3 grid grid-cols-1 gap-2">
                                <div>
                                    <div className="mb-1 text-[9px] font-black uppercase tracking-widest text-gray-400">{isArabic ? 'قبل' : 'Before'}</div>
                                    <div className="max-h-24 overflow-y-auto custom-scrollbar rounded-lg border border-gray-100 bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-600 whitespace-pre-wrap dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-300">
                                        {item.originalText}
                                    </div>
                                </div>
                                <div className="flex items-center justify-between gap-2">
                                    <div className="text-[9px] font-black uppercase tracking-widest text-[#b8922e]">
                                        {isArabic ? 'بدائل التطبيق' : 'Application variants'}
                                    </div>
                                    <div className="text-[9px] font-black text-gray-400">
                                        {isArabic
                                            ? `${item.variants?.length || 1} من 2`
                                            : `${item.variants?.length || 1} of 2`}
                                    </div>
                                </div>
                                {(item.variants?.length ? item.variants : [{
                                    id: 'default',
                                    label: isArabic ? 'اقتراح 1' : 'Suggestion 1',
                                    fixedText: item.fixedText,
                                    statsBefore: { words: 0, sentences: 0, paragraphs: 0, characters: 0 },
                                    statsAfter: { words: 0, sentences: 0, paragraphs: 0, characters: 0 },
                                    criteriaChecks: item.criteria?.map((criterion) => ({
                                        criterionTitle: criterion.title,
                                        before: String(criterion.current),
                                        after: isArabic ? 'غير متاح' : 'Unavailable',
                                        required: String(criterion.required),
                                        status: 'unknown',
                                    })),
                                } as BulkFixReviewVariant]).map((variant, variantIndex) => {
                                    const isAppliedVariant = item.appliedVariantId === variant.id || (item.status === 'applied' && !item.appliedVariantId && variantIndex === 0);
                                    return (
                                        <div key={variant.id} className={`rounded-xl border p-2 ${isAppliedVariant ? 'border-emerald-300 bg-emerald-50/80 dark:border-emerald-900/40 dark:bg-emerald-900/15' : 'border-[#d4af37]/25 bg-[#d4af37]/5 dark:bg-[#d4af37]/10'}`}>
                                            <div className="mb-2 flex items-center justify-between gap-2">
                                                <div className="text-[9px] font-black uppercase tracking-widest text-[#b8922e]">
                                                    {variant.label || `${isArabic ? 'اقتراح' : 'Suggestion'} ${variantIndex + 1}`}
                                                </div>
                                                {isAppliedVariant && (
                                                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[8px] font-black text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                                                        {isArabic ? 'المطبق' : 'Applied'}
                                                    </span>
                                                )}
                                            </div>
                                            {variant.statsBefore.words > 0 || variant.statsAfter.words > 0 ? (
                                                <div className="mb-2">
                                                    {renderStats(variant.statsBefore, variant.statsAfter)}
                                                </div>
                                            ) : null}
                                            {variant.criteriaChecks && variant.criteriaChecks.length > 0 && (
                                                <div className="mb-2 rounded-lg border border-white/60 bg-white/75 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]/80">
                                                    <div className="mb-1 text-[9px] font-black uppercase tracking-widest text-[#b8922e]">
                                                        {isArabic ? 'تدقيق المعايير' : 'Criteria audit'}
                                                    </div>
                                                    <div className="space-y-1">
                                                        {variant.criteriaChecks.map((check, checkIndex) => (
                                                            <div key={`${check.criterionTitle}-${checkIndex}`} className="rounded-md bg-gray-50 p-1.5 text-[9px] leading-relaxed text-gray-600 dark:bg-[#2A2A2A] dark:text-gray-300">
                                                                <div className="flex flex-wrap items-center justify-between gap-1">
                                                                    <span className="font-black text-gray-800 dark:text-gray-100">{check.criterionTitle}</span>
                                                                    <span className={`rounded-full px-1.5 py-0.5 font-black ${criterionStatusClass(check.status)}`}>
                                                                        {criterionStatusLabel(check.status)}
                                                                    </span>
                                                                </div>
                                                                <div className="mt-1 grid grid-cols-1 gap-1">
                                                                    <span>{isArabic ? 'قبل الإصلاح' : 'Before'}: <b>{check.before}</b></span>
                                                                    <span>{isArabic ? 'بعد التعديل' : 'After'}: <b>{check.after}</b></span>
                                                                    <span>{isArabic ? 'المطلوب' : 'Required'}: <b>{check.required}</b></span>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            <div className="max-h-28 overflow-y-auto custom-scrollbar rounded-lg border border-white/60 bg-white/80 p-2 text-[11px] leading-relaxed text-gray-800 whitespace-pre-wrap dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100">
                                                {variant.fixedText}
                                            </div>
                                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                                <button
                                                    onClick={() => copyText(variant.fixedText)}
                                                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold bg-gray-100 text-gray-700 hover:bg-[#d4af37]/15 dark:bg-[#333] dark:text-gray-200 dark:hover:bg-[#d4af37]/20"
                                                >
                                                    <Copy size={13} />
                                                    <span>{isArabic ? 'نسخ الاقتراح' : 'Copy'}</span>
                                                </button>
                                                {isPending && (
                                                    <button
                                                        onClick={() => onApplyItem(item.id, variant.id)}
                                                        className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-black bg-[#d4af37] text-white hover:bg-[#b8922e]"
                                                    >
                                                        <Check size={13} />
                                                        <span>{isArabic ? 'تطبيق هذا الاقتراح' : 'Apply this'}</span>
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {item.applyError && (
                                <p className="mt-2 rounded-lg bg-red-50 p-2 text-[10px] leading-relaxed text-red-700 dark:bg-red-900/20 dark:text-red-300">
                                    {item.applyError}
                                </p>
                            )}

                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                {isPending && (
                                    <>
                                        <button
                                            onClick={() => onApplyItem(item.id)}
                                            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-black bg-[#d4af37] text-white hover:bg-[#b8922e]"
                                        >
                                            <Check size={13} />
                                            <span>{isArabic ? 'تطبيق الأول' : 'Apply first'}</span>
                                        </button>
                                        <button
                                            onClick={() => onSkipItem(item.id)}
                                            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold bg-gray-100 text-gray-600 hover:bg-red-50 hover:text-red-700 dark:bg-[#333] dark:text-gray-300 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                                        >
                                            <Trash2 size={13} />
                                            <span>{isArabic ? 'تجاهل' : 'Skip'}</span>
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};


const StructureTab: React.FC = () => {
    const { structureViewMode: viewMode, uiLanguage } = useUser();
    const { analysisResults } = useEditor();
    const { highlightedItem, handleHighlightStructureItem: onHighlightStructureItem } = useInteraction();
    const {
        handleFixAllViolations,
        fixAllProgress,
        bulkFixReviewItems,
        getRelatedBulkFixRules,
        applyBulkFixReviewItem,
        applySelectedBulkFixReviewItems,
        selectBulkFixReviewItemTarget,
        skipBulkFixReviewItem,
        clearBulkFixReviewItems,
    } = useAI();
    
    const { structureAnalysis: analysis, structureStats: stats } = analysisResults;
    const [modalContent, setModalContent] = useState<CheckResult | null>(null);
    const [isFixModalOpen, setIsFixModalOpen] = useState(false);
    const [selectedBulkFixIds, setSelectedBulkFixIds] = useState<string[]>([]);
    const t = translations[uiLanguage];
    const tSt = t.structureTab;

    const fixableViolationGroups = useMemo(() => {
        const groups: { [title: string]: number } = {};
        Object.values(analysis)
            .filter((rule: any) => rule && rule.violatingItems && rule.violatingItems.length > 0)
            .forEach((rule: any) => {
                groups[rule.title] = (groups[rule.title] || 0) + rule.violatingItems!.length;
            });
        return groups;
    }, [analysis]);
    
    const fixableViolationsCount = Object.values(fixableViolationGroups).reduce((sum: number, count: number) => sum + count, 0);
    const pendingBulkFixIds = useMemo(() => bulkFixReviewItems.filter(item => item.status === 'pending').map(item => item.id), [bulkFixReviewItems]);
    const bulkFixReviewIdsKey = useMemo(() => bulkFixReviewItems.map(item => item.id).join('|'), [bulkFixReviewItems]);

    const handleStartFixing = (selectedRules: string[], includeRelatedRules: boolean) => {
        handleFixAllViolations(selectedRules, { includeRelatedRules });
        setIsFixModalOpen(false);
    };

    useEffect(() => {
        setSelectedBulkFixIds(bulkFixReviewItems.filter(item => item.status === 'pending').map(item => item.id));
    }, [bulkFixReviewIdsKey]);

    const handleToggleBulkFixItem = (itemId: string) => {
        setSelectedBulkFixIds(prev => (
            prev.includes(itemId) ? prev.filter(id => id !== itemId) : [...prev, itemId]
        ));
    };

    const handleToggleAllBulkFixItems = () => {
        setSelectedBulkFixIds(prev => (
            pendingBulkFixIds.length > 0 && pendingBulkFixIds.every(id => prev.includes(id))
                ? prev.filter(id => !pendingBulkFixIds.includes(id))
                : Array.from(new Set([...prev, ...pendingBulkFixIds]))
        ));
    };

    const handleApplySelectedBulkFixes = () => {
        const idsToApply = selectedBulkFixIds.filter(id => pendingBulkFixIds.includes(id));
        applySelectedBulkFixReviewItems(idsToApply);
        setSelectedBulkFixIds(prev => prev.filter(id => !idsToApply.includes(id)));
    };

    const handleApplyBulkFixItem = (itemId: string, variantId?: string) => {
        applyBulkFixReviewItem(itemId, variantId);
        setSelectedBulkFixIds(prev => prev.filter(id => id !== itemId));
    };

    const handleSkipBulkFixItem = (itemId: string) => {
        skipBulkFixReviewItem(itemId);
        setSelectedBulkFixIds(prev => prev.filter(id => id !== itemId));
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
          icon: <LayoutTemplate size={16} className="text-[#d4af37]" />,
          items: [
              analysis.wordCount,
              analysis.summaryParagraph,
              analysis.secondParagraph,
              analysis.paragraphLength,
              analysis.sentenceLength,
              analysis.tableListOpportunities,
              analysis.stepsIntroduction,
              analysis.keywordStuffing,
              analysis.automaticLists,
          ],
      },
      {
          name: tSt.headingsSequence,
          icon: <ListTree size={16} className="text-[#d4af37]" />,
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
          icon: <SpellCheck size={16} className="text-[#d4af37]" />,
          items: [
              analysis.punctuation,
              analysis.paragraphEndings,
              analysis.interrogativeH2,
              analysis.duplicateWordsInParagraph,
              analysis.duplicateWordsInHeading,
              analysis.sentenceBeginnings,
              analysis.ambiguousParagraphReferences,
              analysis.arabicOnly,
              analysis.punctuationSpacing,
              analysis.repeatedBigrams,
              analysis.wordConsistency,
              analysis.wordsToDelete,
          ],
      },
      {
          name: tSt.interactionCta,
          icon: <MousePointerClick size={16} className="text-[#d4af37]" />,
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
          icon: <Flag size={16} className="text-[#d4af37]" />,
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
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-xs font-black uppercase tracking-widest text-white bg-gradient-to-r from-[#d4af37] to-[#b8922e] rounded-2xl hover:shadow-lg disabled:from-gray-400 disabled:to-gray-500 disabled:cursor-not-allowed transition-all"
          >
              {fixAllProgress.running ? (
                  <>
                      <Loader2 size={16} className="animate-spin" />
                      <span>
                          {uiLanguage === 'ar'
                              ? `جاري إنشاء الاقتراحات ${fixAllProgress.current}/${fixAllProgress.total}`
                              : `Creating proposals ${fixAllProgress.current}/${fixAllProgress.total}`}
                      </span>
                  </>
              ) : (
                  <>
                      <Wand2 size={16} />
                      <span>
                          {uiLanguage === 'ar'
                              ? `إنشاء قائمة إصلاحات مقترحة (${fixableViolationsCount})`
                              : `Create proposed fixes (${fixableViolationsCount})`}
                      </span>
                  </>
              )}
          </button>
          {fixAllProgress.failed > 0 && !fixAllProgress.running && (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
                  <p className="font-bold">
                      {uiLanguage === 'ar' ? 'تعذر إنشاء بعض الاقتراحات.' : 'Some proposals could not be created.'}
                  </p>
                  {fixAllProgress.errors.slice(0, 2).map((error, index) => (
                      <p key={index} className="mt-1 break-words">{error}</p>
                  ))}
              </div>
          )}
          <BulkFixReviewPanel
              items={bulkFixReviewItems}
              selectedIds={selectedBulkFixIds}
              onToggleItem={handleToggleBulkFixItem}
              onToggleAll={handleToggleAllBulkFixItems}
              onApplyItem={handleApplyBulkFixItem}
              onApplySelected={handleApplySelectedBulkFixes}
              onLocateItem={selectBulkFixReviewItemTarget}
              onSkipItem={handleSkipBulkFixItem}
              onClear={clearBulkFixReviewItems}
              uiLanguage={uiLanguage}
          />
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
          getRelatedRules={getRelatedBulkFixRules}
          uiLanguage={uiLanguage}
          t={t}
        />
      )}
    </div>
  );
};

export default StructureTab;
