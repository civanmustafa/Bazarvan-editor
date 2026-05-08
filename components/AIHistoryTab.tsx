import React from 'react';
import { useState } from 'react';
import { useAI } from '../contexts/AIContext';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { BookCopy, Trash2, Check, Copy, MapPin, ChevronDown } from 'lucide-react';
import { parseMarkdownToHtml } from '../utils/editorUtils';
import type { AiContentPatch, AIHistoryItem, BulkFixReviewVariant } from '../types';

const getCriterionDisplayOrder = (status?: string): number => {
    if (status === 'pass') return 0;
    if (status === 'fail') return 1;
    if (status === 'warn') return 2;
    return 3;
};

const orderCriteriaChecksForDisplay = (checks?: BulkFixReviewVariant['criteriaChecks']) => (
    (checks || [])
        .map((check, index) => ({ check, index }))
        .sort((a, b) => getCriterionDisplayOrder(a.check.status) - getCriterionDisplayOrder(b.check.status) || a.index - b.index)
        .map(({ check }) => check)
);

const getCriteriaStatusCounts = (checks?: BulkFixReviewVariant['criteriaChecks']) => (
    (checks || []).reduce(
        (counts, check) => {
            if (check.status === 'pass') counts.pass += 1;
            else if (check.status === 'unknown') counts.unknown += 1;
            else counts.fail += 1;
            return counts;
        },
        { pass: 0, fail: 0, unknown: 0 }
    )
);

const AIHistoryTab: React.FC = () => {
    const { aiHistory, applySuggestionFromHistory, removeFromAiHistory } = useAI();
    const { t, uiLanguage } = useUser();
    const { editor } = useEditor();
    const isArabic = uiLanguage === 'ar';
    const [expandedCriteriaKeys, setExpandedCriteriaKeys] = useState<Record<string, boolean>>({});
    const toggleCriteria = (key: string) => {
        setExpandedCriteriaKeys(prev => ({ ...prev, [key]: !prev[key] }));
    };
    const iconButtonClass = 'inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-600 bg-white/80 border border-gray-100 hover:border-[#d4af37]/45 hover:bg-[#d4af37]/15 dark:bg-[#1F1F1F]/80 dark:text-gray-200 dark:border-[#3C3C3C] dark:hover:bg-[#d4af37]/20';

    if (aiHistory.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full p-4 text-center">
                <BookCopy size={48} className="text-gray-300 dark:text-gray-600 mb-4" />
                <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300">{t.aiHistory.noHistoryTitle}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t.aiHistory.noHistoryDescription}</p>
            </div>
        );
    }

    const handleOriginalTextClick = (from: number, to: number) => {
        if (!editor) return;
        const docSize = editor.state.doc.content.size;
        if (from < 0 || to > docSize || from >= to) return;
        editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
    };
    const copyText = (text: string) => {
        void navigator.clipboard?.writeText(text);
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
    const historyTypeLabel = (item: AIHistoryItem) => {
        if (item.type === 'fix-violation') return t.aiHistory.violationFix;
        if (item.type === 'manual-analysis') return isArabic ? 'تحليل أمر يدوي جاهز' : 'Ready Command Analysis';
        return t.aiHistory.userCommand;
    };
    const providerLabel = (provider?: AIHistoryItem['provider']) => {
        if (provider === 'gemini') return 'Gemini';
        if (provider === 'chatgpt') return 'ChatGPT';
        return '';
    };
    const renderAnalysisPatch = (patch: AiContentPatch) => (
        <div key={patch.id} className="my-3 rounded-lg border border-[#d4af37]/25 bg-white/80 p-2 dark:border-[#d4af37]/30 dark:bg-[#1F1F1F]/80">
            <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <div className="text-xs font-bold text-[#333333] line-clamp-2 dark:text-gray-100">{patch.title}</div>
                    {(patch.placementLabel || patch.anchorText || patch.targetText) && (
                        <div className="mt-1 text-[11px] text-gray-500 line-clamp-2 dark:text-gray-400">
                            {patch.placementLabel || patch.anchorText || patch.targetText}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => copyText(patch.contentMarkdown)}
                    className={iconButtonClass}
                    title={isArabic ? 'نسخ النص الجاهز' : 'Copy ready text'}
                    aria-label={isArabic ? 'نسخ النص الجاهز' : 'Copy ready text'}
                >
                    <Copy size={13} />
                </button>
            </div>
            <div
                className="ai-output rounded-md border border-gray-100 bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-800 dark:border-[#3C3C3C] dark:bg-[#2A2A2A] dark:text-gray-100"
                dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(patch.contentMarkdown) }}
            />
        </div>
    );
    const renderManualAnalysisResult = (item: AIHistoryItem) => {
        const result = item.analysisResult || item.suggestions.join('\n\n');
        const patches = item.analysisPatches || [];

        if (!patches.length) {
            return <div className="ai-output text-sm text-[#333333] dark:text-[#b7b7b7]" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(result) }} />;
        }

        const usedPatchIds = new Set<string>();
        const markerPattern = /\[\[PATCH:([^\]]+)\]\]/g;
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = markerPattern.exec(result)) !== null) {
            const textChunk = result.slice(lastIndex, match.index);
            const marker = match[1].trim();

            if (textChunk.trim()) {
                parts.push(
                    <div key={`text-${lastIndex}`} className="ai-output text-sm text-[#333333] dark:text-[#b7b7b7]" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(textChunk) }} />
                );
            }

            const patch = patches.find(itemPatch => itemPatch.marker === marker || itemPatch.title === marker);
            if (patch) {
                usedPatchIds.add(patch.id);
                parts.push(renderAnalysisPatch(patch));
            }

            lastIndex = markerPattern.lastIndex;
        }

        const tail = result.slice(lastIndex);
        if (tail.trim()) {
            parts.push(
                <div key="text-tail" className="ai-output text-sm text-[#333333] dark:text-[#b7b7b7]" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(tail) }} />
            );
        }

        patches
            .filter(patch => !usedPatchIds.has(patch.id))
            .forEach(patch => parts.push(renderAnalysisPatch(patch)));

        return <>{parts}</>;
    };

    return (
        <div className="p-2 space-y-3">
            {aiHistory.map((item) => (
                <div key={item.id} className="bg-white dark:bg-[#2A2A2A] rounded-lg border border-gray-200 dark:border-[#3C3C3C] overflow-hidden">
                    <div className="p-3 border-b border-gray-200 dark:border-[#3C3C3C]">
                        <div className="flex justify-between items-start gap-2">
                            <div>
                                <h4 className="text-xs font-bold text-[#d4af37] dark:text-[#f2d675] uppercase tracking-wider">
                                    {historyTypeLabel(item)}
                                </h4>
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                    {item.ruleTitle && (
                                        <p className="text-base font-semibold text-[#333333] dark:text-[#b7b7b7] ai-history-content-text">{item.ruleTitle}</p>
                                    )}
                                    {providerLabel(item.provider) && (
                                        <span className="rounded-full bg-[#d4af37]/15 px-2 py-0.5 text-[10px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                                            {providerLabel(item.provider)}
                                        </span>
                                    )}
                                </div>
                            </div>
                            <button 
                                onClick={() => removeFromAiHistory(item.id)}
                                className="p-1.5 rounded-full text-gray-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                                title={t.aiHistory.remove}
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                        {item.type !== 'manual-analysis' && !item.bulkFixReviewItem && (
                            <p
                                onClick={() => handleOriginalTextClick(item.from, item.to)}
                                className="mt-2 text-sm text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-[#1F1F1F] p-2 rounded-md line-clamp-2 cursor-pointer hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20 transition-colors"
                                title={t.aiHistory.original}
                            >
                                <span className="font-semibold">{t.aiHistory.original}: </span><span className="ai-history-content-text">{item.originalText}</span>
                            </p>
                        )}
                        {item.applyError && (
                            <p className="mt-2 text-xs font-semibold text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 p-2 rounded-md">
                                {item.applyError}
                            </p>
                        )}
                    </div>

                    {item.type === 'manual-analysis' ? (
                        <div className="p-3 space-y-3 bg-gray-50/50 dark:bg-[#2A2A2A]/50">
                            <div className="flex justify-end">
                                <button
                                    type="button"
                                    onClick={() => copyText(item.analysisResult || item.suggestions.join('\n\n'))}
                                    className={iconButtonClass}
                                    title={isArabic ? 'نسخ النتيجة' : 'Copy result'}
                                    aria-label={isArabic ? 'نسخ النتيجة' : 'Copy result'}
                                >
                                    <Copy size={13} />
                                </button>
                            </div>
                            <div className="overflow-y-auto custom-scrollbar rounded-lg border border-gray-100 bg-white/80 p-2 text-sm leading-relaxed text-gray-800 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100" style={{ maxHeight: 'min(56vh, 34rem)' }}>
                                {renderManualAnalysisResult(item)}
                            </div>
                        </div>
                    ) : item.bulkFixReviewItem ? (
                        <div className="p-3 space-y-3 bg-gray-50/50 dark:bg-[#2A2A2A]/50">
                            <div>
                                <div
                                    onClick={() => handleOriginalTextClick(item.from, item.to)}
                                    className="cursor-pointer overflow-y-auto custom-scrollbar rounded-lg border border-gray-100 bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-600 whitespace-pre-wrap break-words transition-colors hover:bg-[#d4af37]/10 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-300 dark:hover:bg-[#d4af37]/15"
                                    style={{ maxHeight: 'min(42vh, 24rem)' }}
                                    title={isArabic ? 'انتقال إلى النص داخل المحرر' : 'Go to text in editor'}
                                >
                                    {item.bulkFixReviewItem.originalText}
                                </div>
                            </div>
                            <div className="text-[9px] font-black uppercase tracking-widest text-[#b8922e]">
                                {isArabic ? 'الاقتراحات' : 'Suggestions'}
                            </div>
                            {(item.bulkFixReviewItem.variants?.length
                                ? item.bulkFixReviewItem.variants
                                : item.suggestions.map((suggestion, index) => ({
                                    id: `history-${item.id}-${index}`,
                                    label: isArabic ? `اقتراح ${index + 1}` : `Suggestion ${index + 1}`,
                                    fixedText: suggestion,
                                    criteriaChecks: [],
                                }))
                            ).map((variant, index) => {
                                const isApplied = item.appliedSuggestion === variant.fixedText;
                                const isDisabled = !!item.appliedSuggestion && !isApplied;
                                const criteriaStatusCounts = getCriteriaStatusCounts(variant.criteriaChecks);
                                const criteriaKey = `${item.id}:${variant.id}`;
                                const hasCriteriaChecks = Boolean(variant.criteriaChecks && variant.criteriaChecks.length > 0);
                                const isCriteriaExpanded = Boolean(expandedCriteriaKeys[criteriaKey]);

                                return (
                                    <div
                                        key={variant.id}
                                        className={`rounded-xl border p-2 transition-all duration-200 ${
                                            isApplied
                                                ? 'border-emerald-300 bg-emerald-50/80 dark:border-emerald-900/40 dark:bg-emerald-900/15'
                                                : isDisabled
                                                    ? 'border-gray-200 bg-gray-100 opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]'
                                                    : 'border-[#d4af37]/25 bg-[#d4af37]/5 dark:bg-[#d4af37]/10'
                                        }`}
                                    >
                                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                            <div className="min-w-0 flex-1 truncate text-[9px] font-black uppercase tracking-widest text-[#b8922e]">
                                                {variant.label || `${isArabic ? 'اقتراح' : 'Suggestion'} ${index + 1}`}
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1.5">
                                                {hasCriteriaChecks && (
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleCriteria(criteriaKey)}
                                                        className="inline-flex h-7 items-center gap-1 rounded-lg border border-gray-100 bg-white/80 px-1.5 text-[9px] font-black tabular-nums text-gray-600 hover:border-[#d4af37]/45 hover:bg-[#d4af37]/15 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]/80 dark:text-gray-200 dark:hover:bg-[#d4af37]/20"
                                                        title={isArabic ? 'ضمن الحد / خارج الحد / غير مؤكد' : 'Pass / Fail / Unknown'}
                                                        aria-label={isArabic ? 'فتح أو إغلاق تدقيق المعايير' : 'Toggle criteria audit'}
                                                        aria-expanded={isCriteriaExpanded}
                                                    >
                                                        <span className="text-emerald-600 dark:text-emerald-400">{criteriaStatusCounts.pass}</span>
                                                        <span className="text-gray-300 dark:text-gray-600">/</span>
                                                        <span className="text-red-700 dark:text-red-400">{criteriaStatusCounts.fail}</span>
                                                        <span className="text-gray-300 dark:text-gray-600">/</span>
                                                        <span className="text-gray-950 dark:text-gray-100">{criteriaStatusCounts.unknown}</span>
                                                        <ChevronDown size={12} className={`text-gray-400 transition-transform ${isCriteriaExpanded ? 'rotate-180' : ''}`} />
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => handleOriginalTextClick(item.from, item.to)}
                                                    className={iconButtonClass}
                                                    title={isArabic ? 'تحديد الموضع' : 'Locate'}
                                                    aria-label={isArabic ? 'تحديد الموضع' : 'Locate'}
                                                >
                                                    <MapPin size={13} />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => copyText(variant.fixedText)}
                                                    className={iconButtonClass}
                                                    title={isArabic ? 'نسخ الاقتراح' : 'Copy suggestion'}
                                                    aria-label={isArabic ? 'نسخ الاقتراح' : 'Copy suggestion'}
                                                >
                                                    <Copy size={13} />
                                                </button>
                                                {!item.appliedSuggestion && (
                                                    <button
                                                        type="button"
                                                        onClick={() => applySuggestionFromHistory(item.id, variant.fixedText)}
                                                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[#d4af37] text-white hover:bg-[#b8922e]"
                                                        title={isArabic ? 'تطبيق الاقتراح' : 'Apply suggestion'}
                                                        aria-label={isArabic ? 'تطبيق الاقتراح' : 'Apply suggestion'}
                                                    >
                                                        <Check size={13} />
                                                    </button>
                                                )}
                                                {isApplied && (
                                                    <span className="inline-flex h-7 items-center rounded-lg bg-emerald-100 px-2 text-[8px] font-black text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                                                        {t.aiHistory.applied}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        {hasCriteriaChecks && isCriteriaExpanded && (
                                            <div className="mb-2 rounded-lg border border-white/60 bg-white/75 p-2 dark:border-[#3C3C3C] dark:bg-[#1F1F1F]/80">
                                                <div className="mb-1 text-[9px] font-black uppercase tracking-widest text-[#b8922e]">
                                                    {isArabic ? 'تدقيق المعايير' : 'Criteria audit'}
                                                </div>
                                                <div className="space-y-1">
                                                    {orderCriteriaChecksForDisplay(variant.criteriaChecks).map((check, checkIndex) => (
                                                        <div key={`${check.criterionTitle}-${checkIndex}`} className="rounded-md bg-gray-50 p-1.5 text-[9px] leading-relaxed text-gray-600 dark:bg-[#2A2A2A] dark:text-gray-300">
                                                            <div className="flex flex-wrap items-center justify-between gap-1">
                                                                <span className="font-black text-gray-800 dark:text-gray-100">{check.criterionTitle}</span>
                                                                <span className={`rounded-full px-1.5 py-0.5 font-black ${criterionStatusClass(check.status)}`}>
                                                                    {criterionStatusLabel(check.status)}
                                                                </span>
                                                            </div>
                                                            <div className="mt-1 grid grid-cols-1 gap-1">
                                                                <span>{isArabic ? 'الحالي' : 'Current'}: <b>{check.before}</b></span>
                                                                <span>{isArabic ? 'المطلوب' : 'Required'}: <b>{check.required}</b></span>
                                                                <span>{isArabic ? 'المستخرج' : 'Extracted'}: <b>{check.after}</b></span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        <div className="overflow-y-auto custom-scrollbar rounded-lg border border-white/60 bg-white/80 p-2 text-[11px] leading-relaxed text-gray-800 whitespace-pre-wrap break-words dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100" style={{ maxHeight: 'min(42vh, 24rem)' }}>
                                            {variant.fixedText}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="p-3 space-y-2 bg-gray-50/50 dark:bg-[#2A2A2A]/50">
                            {item.suggestions.map((suggestion, index) => {
                            const isApplied = item.appliedSuggestion === suggestion;
                            const isDisabled = !!item.appliedSuggestion && !isApplied;

                            return (
                                <div
                                    key={index}
                                    onClick={() => !item.appliedSuggestion && applySuggestionFromHistory(item.id, suggestion)}
                                    className={`relative p-3 rounded-md transition-all duration-200 ${
                                        isApplied
                                            ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-300 dark:border-emerald-700/50 border'
                                            : isDisabled
                                                ? 'bg-gray-100 dark:bg-[#1F1F1F] opacity-50 cursor-not-allowed'
                                                : 'cursor-pointer bg-white dark:bg-[#1F1F1F] border border-gray-200 dark:border-[#3C3C3C] hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20'
                                    }`}
                                >
                                    {isApplied && (
                                        <div className="absolute top-2 end-2 flex items-center gap-1.5 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                                            <Check size={14} />
                                            <span>{t.aiHistory.applied}</span>
                                        </div>
                                    )}
                                    <div
                                        className="ai-output text-sm text-[#333333] dark:text-[#b7b7b7]"
                                        dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(suggestion) }}
                                    />
                                </div>
                            );
                            })}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};

export default AIHistoryTab;
