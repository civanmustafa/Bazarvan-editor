
import React, { useState, useCallback, useEffect, useRef, createContext, useContext, useMemo } from 'react';
import type { Editor as EditorClass } from '@tiptap/core';

import { useUser } from './UserContext';
import { useEditor } from './EditorContext';
import { useAI } from './AIContext';
import type { CheckResult, StructureAnalysis } from '../types';
import { SECONDARY_COLORS, VIOLATION_PRIORITY, DEFAULT_PRIORITY, FIXABLE_RULES } from '../constants';

/*
 * InteractionContext owns editor-side interactions that are not article data:
 * keyword/violation highlighting, tooltips, scroll-to-top, TOC insertion,
 * paste cleanup, spotlight visibility, and formatting cleanup actions.
 *
 * Edit here when a sidebar/toolbar button needs to manipulate the current editor view.
 * Edit EditorContext for persistence/state, and AIContext for AI requests.
 */

type TooltipState = { 
  content: string; 
  top: number; 
  left: number; 
  violations: { title: string; from: number }[] 
} | null;

interface InteractionContextType {
    highlightedItem: string | any[] | null;
    setHighlightedItem: React.Dispatch<React.SetStateAction<string | any[] | null>>;
    tooltip: TooltipState;
    tooltipRef: React.RefObject<HTMLDivElement>;
    pinnedTooltip: TooltipState;
    isTooltipAlwaysOn: boolean;
    setIsTooltipAlwaysOn: React.Dispatch<React.SetStateAction<boolean>>;
    isTocVisible: boolean;
    isSpotlightVisible: boolean;
    setIsSpotlightVisible: React.Dispatch<React.SetStateAction<boolean>>;
    handleScrollToTop: () => void;
    applyHighlights: (highlights: { text: string; color: string }[], scrollToFirst?: boolean) => void;
    clearAllHighlights: () => void;
    handleToggleAllKeywordsHighlight: () => void;
    handleRemoveEmptyLines: () => void;
    handleFixParagraphs: () => void;
    handleClearFormatting: () => void;
    handleToggleToc: () => void;
    handleHighlightStructureItem: (item: CheckResult) => void;
}

const InteractionContext = createContext<InteractionContextType | null>(null);

const ARTICLE_WIDE_TOOLTIP_EXCLUDED_RULES = new Set<keyof StructureAnalysis>([
    'wordCount',
    'h2Count',
    'interrogativeH2',
    'automaticLists',
]);

const escapeTooltipHtml = (value: unknown): string => (
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
);

const getRuleTooltipNote = (ruleTitle: string, uiLanguage: 'ar' | 'en'): string => {
    const normalizedTitle = ruleTitle.toLowerCase();
    const isStepsIntroduction = normalizedTitle.includes('تمهيد خطوات') || normalizedTitle.includes('steps introduction');
    if (!isStepsIntroduction) return '';

    return uiLanguage === 'ar'
        ? 'عند وجود جملة تمهيد قصيرة قبل القائمة، ادمجها مع الفقرة السابقة للحصول على فقرة تمهيدية واحدة فقط قبل القائمة.'
        : 'When there is a short list-intro sentence, merge it with the previous paragraph so there is only one introductory paragraph before the list.';
};

const formatTooltipTextBlock = (value: string): string => (
    escapeTooltipHtml(value.replace(/\s+/g, ' ').trim())
);

type StructureViolationItem = NonNullable<CheckResult['violatingItems']>[number];
type ResolvedStructureViolation = StructureViolationItem & { rule: CheckResult };

const normalizeViolationText = (value: string): string => (
    value
        .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
);

const getSafeDocTextBetween = (editor: EditorClass, from: number, to: number): string | null => {
    const docSize = editor.state.doc.content.size;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > docSize || from >= to) {
        return null;
    }

    return editor.state.doc.textBetween(from, to, ' ');
};

const resolveViolationRangeInCurrentDoc = (
    editor: EditorClass,
    violation: StructureViolationItem,
): StructureViolationItem | null => {
    const expectedText = typeof violation.text === 'string'
        ? normalizeViolationText(violation.text)
        : '';
    const currentRangeText = getSafeDocTextBetween(editor, violation.from, violation.to);

    if (!expectedText) {
        return currentRangeText === null ? null : violation;
    }

    if (currentRangeText !== null && normalizeViolationText(currentRangeText) === expectedText) {
        return violation;
    }

    let bestMatch: { from: number; to: number; score: number } | null = null;
    editor.state.doc.descendants((node, pos) => {
        if (!node.isBlock || !['paragraph', 'heading', 'listItem'].includes(node.type.name)) return;
        if (normalizeViolationText(node.textContent) !== expectedText) return;

        const score = Math.abs(pos - violation.from);
        if (!bestMatch || score < bestMatch.score) {
            bestMatch = { from: pos, to: pos + node.nodeSize, score };
        }
    });

    return bestMatch
        ? { ...violation, from: bestMatch.from, to: bestMatch.to }
        : null;
};

export const useInteraction = () => {
  const context = useContext(InteractionContext);
  if (!context) throw new Error("useInteraction must be used within an InteractionProvider");
  return context;
};

export const InteractionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { highlightStyle, uiLanguage, t } = useUser();
    const { editor, text, keywords, analysisResults, scrollContainerRef, articleLanguage } = useEditor();
    const { aiFixingInfo, handleAiFix } = useAI();
    
    const [highlightedItem, setHighlightedItem] = useState<string | any[] | null>(null);
    const [tooltip, setTooltip] = useState<TooltipState>(null);
    const [pinnedTooltip, setPinnedTooltip] = useState<TooltipState>(null);
    const [isTooltipAlwaysOn, setIsTooltipAlwaysOn] = useState(false);
    const tooltipRef = useRef<HTMLDivElement>(null);

    const [isTocVisible, setIsTocVisible] = useState(false);
    const [isSpotlightVisible, setIsSpotlightVisible] = useState(false);
    
    const hasRunFirstPasteCleanupRef = useRef(false);
    const isFirstPasteCleanupRunningRef = useRef(false);

    const isDocumentTextEmpty = (doc: any): boolean => {
        const rawText = typeof doc?.textBetween === 'function'
            ? doc.textBetween(0, doc.content?.size || 0, ' ', ' ')
            : doc?.textContent || '';
        return rawText.replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, '').trim().length === 0;
    };

    const didPasteStartFromEmptyDocument = (transaction: any): boolean => {
        if (!transaction?.before) return false;
        return isDocumentTextEmpty(transaction.before);
    };

    // Flatten rule results into clickable/highlightable ranges used by tooltips.
    const allViolations = useMemo(() => {
        const violations: ResolvedStructureViolation[] = [];
        if (!analysisResults?.structureAnalysis || !editor || editor.isDestroyed) return [];
        
        for (const [ruleKey, rule] of Object.entries(analysisResults.structureAnalysis) as [keyof StructureAnalysis, CheckResult][]) {
            if (ARTICLE_WIDE_TOOLTIP_EXCLUDED_RULES.has(ruleKey)) continue;
            const typedRule = rule as CheckResult;
            if (typedRule && typedRule.violatingItems) {
                for (const item of typedRule.violatingItems) {
                    const resolvedItem = resolveViolationRangeInCurrentDoc(editor, item);
                    if (resolvedItem) {
                        violations.push({ ...resolvedItem, rule: typedRule });
                    }
                }
            }
        }
        return violations;
    }, [analysisResults, editor, text]);

    const handleScrollToTop = () => {
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
        }
        if (editor) {
            (editor.chain() as any).focus().setTextSelection(1).run();
        }
    };
    
    const clearAllHighlights = useCallback(() => {
        setHighlightedItem(null);
        if (editor && !editor.isDestroyed) {
            const { tr } = editor.state;
            tr.removeMark(0, editor.state.doc.content.size, editor.schema.marks.highlight);
            editor.view.dispatch(tr);
        }
    }, [editor]);

    const createArabicInsensitiveRegexString = (text: string): string => {
        return text.replace(/ا|أ|إ|آ/g, '[اأإآ]')
                   .replace(/ي|ى/g, '[يى]')
                   .replace(/ه|ة/g, '[هة]')
                   .replace(/و|ؤ/g, '[وؤ]')
                   .replace(/ء|ئ/g, '[ءئ]');
    };

    // Shared keyword highlighter. Structure violations use handleHighlightStructureItem below.
    const applyHighlights = useCallback((highlights: { text: string; color: string }[], scrollToFirst = true) => {
        if (!editor) return;
        const { tr } = editor.state;
        const highlightMarkType = editor.schema.marks.highlight;
    
        tr.removeMark(0, editor.state.doc.content.size, highlightMarkType);
        let firstHighlightPos: number | null = null;
        
        const sortedHighlights = [...highlights].sort((a, b) => b.text.length - a.text.length);
    
        sortedHighlights.forEach(({ text, color }) => {
            const searchText = text.trim();
            if (!searchText) return;
    
            const escapedText = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            const regexPattern = articleLanguage === 'ar' ? createArabicInsensitiveRegexString(escapedText) : escapedText;
            const regexText = regexPattern.replace(/\s+/g, '\\s+');

            const searchRegex = new RegExp(regexText, 'gu');
    
            editor.state.doc.descendants((node, pos) => {
                if (node.isText && node.text) {
                    const nodeText = node.text;
                    let match;
                    while ((match = searchRegex.exec(nodeText)) !== null) {
                        const from = pos + match.index;
                        const to = from + match[0].length;
                        
                        if (firstHighlightPos === null) {
                            firstHighlightPos = from;
                        }
    
                        const highlightMark = (highlightMarkType as any).create({
                            color,
                            highlightStyle: highlightStyle,
                            isViolation: false,
                        });
                        tr.addMark(from, to, highlightMark);
                    }
                }
            });
        });
    
        editor.view.dispatch(tr);
        
        if (scrollToFirst && firstHighlightPos !== null) {
          setTimeout(() => {
            if (editor && !editor.isDestroyed) {
              (editor.chain() as any).focus().setTextSelection(firstHighlightPos).scrollIntoView().run();
            }
          }, 50);
        }
    
      }, [editor, highlightStyle, articleLanguage]);
    

    const handleToggleAllKeywordsHighlight = () => {
        if (highlightedItem === '__ALL_KEYWORDS__') {
            clearAllHighlights();
        } else {
            const allKeywords = [
                { text: keywords.primary, color: '#a7f3d0' },
                ...keywords.secondaries
                  .map((s, i) => ({ text: s, color: SECONDARY_COLORS[i % SECONDARY_COLORS.length] }))
                  .filter(k => k.text.trim() !== ''),
                { text: keywords.company, color: '#bae6fd' }
            ].filter(k => k.text.trim() !== '');
            applyHighlights(allKeywords, false);
            setHighlightedItem('__ALL_KEYWORDS__');
        }
      };

    const isVisuallyEmptyParagraph = (node: any): boolean => {
        if (!node.isBlock || node.type.name !== 'paragraph') return false;
        const normalizedText = node.textContent.replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, '').trim();
        if (normalizedText) return false;
        let hasVisibleChild = false;
        node.descendants((child: any) => {
            if (child.type.name !== 'text' && child.type.name !== 'hardBreak') {
                hasVisibleChild = true;
                return false;
            }
        });
        return !hasVisibleChild;
    };

    const handleRemoveEmptyLines = useCallback(() => {
        if (!editor) return;
        editor.view.focus();
        const { tr, doc } = editor.state;
        const rangesToRemove: { from: number; to: number }[] = [];
        let topLevelParagraphCount = 0;
        doc.descendants((node, pos) => {
            if (node.type.name === 'paragraph' && pos >= 0) {
                topLevelParagraphCount++;
            }
            if (isVisuallyEmptyParagraph(node)) {
                 rangesToRemove.push({ from: pos, to: pos + node.nodeSize });
            }
        });
        if (rangesToRemove.length > 0) {
            const safeRanges = rangesToRemove.length >= topLevelParagraphCount
                ? rangesToRemove.slice(1)
                : rangesToRemove;
            if (safeRanges.length === 0) return;
            safeRanges.reverse().forEach(range => tr.delete(range.from, range.to));
            editor.view.dispatch(tr);
        }
    }, [editor]);

    const handleFixParagraphs = useCallback(() => {
        if (!editor) return;
        const { tr } = editor.state;
        const positions: number[] = [];
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'hardBreak') positions.push(pos);
        });
        if (positions.length > 0) {
            positions.reverse().forEach(pos => {
                tr.delete(pos, pos + 1);
                tr.split(pos);
            });
            editor.view.dispatch(tr);
        }
    }, [editor]);

    const handleClearFormatting = useCallback(() => {
        if (!editor) return;
        editor.chain().focus().unsetAllMarks().clearNodes().run();
    }, [editor]);

    const applyArticleLanguageFlow = useCallback(() => {
        if (!editor || editor.isDestroyed) return;
        const direction = articleLanguage === 'ar' ? 'rtl' : 'ltr';
        const alignment = articleLanguage === 'ar' ? 'right' : 'left';
        const editorDom = editor.view.dom as HTMLElement;

        editorDom.setAttribute('dir', direction);
        editorDom.style.direction = direction;
        editorDom.style.textAlign = alignment;

        (editor.chain() as any)
            .focus()
            .selectAll()
            .setTextDirection(direction)
            .setTextAlign(alignment)
            .run();
    }, [editor, articleLanguage]);
    
    useEffect(() => {
        hasRunFirstPasteCleanupRef.current = false;
        isFirstPasteCleanupRunningRef.current = false;
    }, [editor]);

    useEffect(() => {
        if (!editor || editor.isDestroyed) return;
        if (text.replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, '').trim().length === 0) {
            hasRunFirstPasteCleanupRef.current = false;
            isFirstPasteCleanupRunningRef.current = false;
        }
    }, [editor, text]);

    // First paste cleanup normalizes copied articles before analysis starts flagging layout noise.
    useEffect(() => {
        if (!editor) return;
        let isCancelled = false;
        const wait = (delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs));
        const shouldStopCleanup = () => isCancelled || !editor || editor.isDestroyed;

        const runFirstPasteCleanup = async () => {
            if (hasRunFirstPasteCleanupRef.current || isFirstPasteCleanupRunningRef.current) return;
            hasRunFirstPasteCleanupRef.current = true;
            isFirstPasteCleanupRunningRef.current = true;

            try {
                if (shouldStopCleanup()) return;
                await wait(2000);
                if (shouldStopCleanup()) return;
                handleRemoveEmptyLines();
                await wait(350);
                if (shouldStopCleanup()) return;
                applyArticleLanguageFlow();
                await wait(650);
                if (shouldStopCleanup()) return;
                handleFixParagraphs();
                await wait(350);
                if (shouldStopCleanup()) return;
                applyArticleLanguageFlow();
                await wait(650);
                if (shouldStopCleanup()) return;
                applyArticleLanguageFlow();
                if (shouldStopCleanup()) return;
                scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
            } finally {
                isFirstPasteCleanupRunningRef.current = false;
            }
        };

        const handleTransaction = ({ transaction }: { transaction: any }) => {
            if (transaction.getMeta('paste') && didPasteStartFromEmptyDocument(transaction)) {
                void runFirstPasteCleanup();
            }
        };

        editor.on('transaction', handleTransaction);

        return () => {
            isCancelled = true;
            editor.off('transaction', handleTransaction);
        };
    }, [editor, handleRemoveEmptyLines, handleFixParagraphs, scrollContainerRef, applyArticleLanguageFlow]);

      const generateToc = useCallback((editorInstance: EditorClass | null) => {
        if (!editorInstance) return '';
        const tocItems: string[] = [];
        let introAdded = false;
        editorInstance.state.doc.forEach(node => {
            if (!introAdded && node.type.name !== 'heading' && node.textContent.trim().length > 0) {
                tocItems.push("- المقدمة");
                introAdded = true;
            }
            if (node.type.name === 'heading') {
                if (!introAdded) { tocItems.push("- المقدمة"); introAdded = true; }
                tocItems.push(`${'  '.repeat(node.attrs.level - 1)}- H${node.attrs.level}: ${node.textContent}`);
            }
        });
        if (!introAdded && editorInstance.state.doc.textContent.trim().length > 0) {
            tocItems.push("- المقدمة");
        }
        return tocItems.join('\n');
    }, []);

    const handleToggleToc = () => {
        if (!editor) return;
        const { tr } = editor.state;
        const tocIdentifier = '<!-- TOC -->';
        const firstTiptapNode = editor.state.doc.firstChild;
        if (firstTiptapNode && firstTiptapNode.textContent.startsWith(tocIdentifier)) {
            tr.delete(0, firstTiptapNode.nodeSize);
            editor.view.dispatch(tr);
            setIsTocVisible(false);
            return;
        }
        const tocList = generateToc(editor);
        if (tocList) {
            const tocNode = editor.schema.nodes.paragraph.create(null, editor.schema.text(`${tocIdentifier}\n${tocList}`));
            tr.insert(0, tocNode);
            editor.view.dispatch(tr);
            setIsTocVisible(true);
        }
    };
    
    const handleHighlightStructureItem = useCallback((item: CheckResult) => {
        if (!editor) return;
        const title = item.title;
    
        if (highlightedItem === title) {
            clearAllHighlights();
            return;
        }
        
        const resolvedViolations = (item.violatingItems || [])
            .map(violation => resolveViolationRangeInCurrentDoc(editor, violation))
            .filter((violation): violation is StructureViolationItem => Boolean(violation));

        if (resolvedViolations.length > 0) {
            const { tr } = editor.state;
            const highlightMarkType = editor.schema.marks.highlight;
            tr.removeMark(0, editor.state.doc.content.size, highlightMarkType);
    
            resolvedViolations.forEach(violation => {
                const highlightMark = (highlightMarkType as any).create({
                    color: item.status === 'pass' ? '#fde68a' : '#fda4af',
                    violation: title,
                    from: violation.from,
                    highlightStyle: highlightStyle,
                    isViolation: true,
                });
                tr.addMark(violation.from, violation.to, highlightMark);
            });
    
            if (tr.steps.length > 0) {
                editor.view.dispatch(tr);
            }
            setHighlightedItem(title);
            setTooltip(null);
            setPinnedTooltip(null);
    
            setTimeout(() => {
                if (editor && !editor.isDestroyed && resolvedViolations[0]) {
                    // This position points to the start of the node, outside its content.
                    // Adding 1 moves the cursor inside the node, which is a valid position for a TextSelection.
                    const selectionPos = Math.min(resolvedViolations[0].from + 1, editor.state.doc.content.size);
                    (editor.chain() as any)
                        .focus()
                        .setTextSelection(selectionPos)
                        .scrollIntoView()
                        .run();
                }
            }, 50);
    
        } else {
            clearAllHighlights();
        }
    }, [editor, highlightedItem, clearAllHighlights, setHighlightedItem, highlightStyle]);
    
    // Spotlight Search Keyboard Listener
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.code === 'Space') {
                event.preventDefault();
                setIsSpotlightVisible(prev => !prev);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // Tooltip event bridge: DOM hover/click -> React tooltip state -> optional AI fix action.
    useEffect(() => {
        if (!editor) return;
    
        const editorView = editor.view;
        const editorDom = editorView.dom;
    
        const handleMouseMove = (event: MouseEvent) => {
            const selectedRuleTitle = typeof highlightedItem === 'string' &&
                allViolations.some(v => v.rule.title === highlightedItem)
                    ? highlightedItem
                    : null;
            const shouldShowHoverTooltip = isTooltipAlwaysOn || Boolean(selectedRuleTitle);

            if (!shouldShowHoverTooltip) {
                if (tooltip) setTooltip(null);
                if (pinnedTooltip) setPinnedTooltip(null);
                return;
            }

            if (pinnedTooltip) {
                if (tooltip) setTooltip(null);
                return;
            }
    
            const posResult = editorView.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!posResult) {
                setTooltip(null);
                return;
            }
    
            const currentPos = posResult.pos;
            const activeViolations = allViolations.filter(v => {
                if (selectedRuleTitle && v.rule.title !== selectedRuleTitle) return false;
                return currentPos >= v.from && currentPos <= v.to;
            });

            if (activeViolations.length > 0) {
                const uniqueViolations: { [key: string]: { rule: CheckResult; from: number; message?: string; pairedFrom?: number; pairedText?: string } } = {};
                activeViolations.forEach(v => {
                    const key = [v.rule.title, v.from, v.pairedFrom ?? ''].join('|');
                    uniqueViolations[key] = {
                        rule: v.rule,
                        from: v.from,
                        message: v.message,
                        pairedFrom: v.pairedFrom,
                        pairedText: v.pairedText,
                    };
                });

                const violationsArray = Object.values(uniqueViolations)
                    .sort((a, b) => (VIOLATION_PRIORITY[a.rule.title] || DEFAULT_PRIORITY) - (VIOLATION_PRIORITY[b.rule.title] || DEFAULT_PRIORITY));
                
                const tooltipContent = violationsArray
                    .map(v => {
                        const rule = v.rule;
                        const isFixingThis = aiFixingInfo?.title === rule.title && aiFixingInfo?.from === v.from;
                        const isFixable = FIXABLE_RULES.has(rule.title);
                        const safeTitle = escapeTooltipHtml(rule.title);
                        const buttonHtml = isFixable ? `<button data-from="${v.from}" data-title="${safeTitle}" class="ai-fix-btn" ${isFixingThis ? 'disabled' : ''}>${isFixingThis ? '<span class="ai-fix-btn-spinner"></span>' : escapeTooltipHtml(t.fix)}</button>` : '';

                        const rawCurrentText = v.message || rule.current;
                        const currentText = escapeTooltipHtml(String(rawCurrentText).replace(/<[^>]*>/g, '').substring(0, 140));
                        const requiredText = escapeTooltipHtml(String(rule.required).replace(/<[^>]*>/g, '').substring(0, 90));
                        const currentLabel = v.message
                            ? (uiLanguage === 'ar' ? 'المشكلة' : 'Issue')
                            : t.leftSidebar.current;
                        const ruleNote = getRuleTooltipNote(rule.title, uiLanguage);
                        const noteHtml = ruleNote
                            ? `<span style="text-align: ${uiLanguage === 'ar' ? 'right' : 'left'};"><strong>${uiLanguage === 'ar' ? 'تلميح' : 'Tip'}:</strong> ${escapeTooltipHtml(ruleNote)}</span>`
                            : '';
                        const pairedParagraphHtml = v.pairedText
                            ? `<div style="margin-top: 4px; display: grid; gap: 3px; text-align: ${uiLanguage === 'ar' ? 'right' : 'left'};">
                                    <strong>${uiLanguage === 'ar' ? 'الفقرة الزوجية للمقارنة اليدوية' : 'Paired paragraph for manual comparison'}:</strong>
                                    <span style="display: block; max-width: 420px; max-height: 120px; overflow-y: auto; padding: 6px; border-radius: 6px; background: rgba(212, 175, 55, 0.08); color: inherit; line-height: 1.6;">${formatTooltipTextBlock(v.pairedText)}</span>
                                </div>`
                            : '';
                        
                        const detailsHtml = `
                            <div style="display: grid; gap: 4px; font-size: 11px; color: #6b7280;" class="dark:text-gray-400 w-full">
                                <span style="text-align: ${uiLanguage === 'ar' ? 'right' : 'left'};"><strong>${escapeTooltipHtml(currentLabel)}:</strong> ${currentText}</span>
                                <span style="text-align: ${uiLanguage === 'ar' ? 'right' : 'left'};"><strong>${escapeTooltipHtml(t.leftSidebar.required)}:</strong> ${requiredText}</span>
                                ${noteHtml}
                                ${pairedParagraphHtml}
                            </div>`;

                        return `<div class="flex flex-col items-start gap-1.5 w-full">
                                    <div class="flex items-center gap-2 font-semibold">${buttonHtml}${safeTitle}</div>
                                    ${detailsHtml}
                                </div>`;
                    })
                    .join('<hr class="border-gray-200 dark:border-[#3C3C3C] my-1.5 -mx-3 w-[calc(100%+1.5rem)]">');

                setTooltip({
                    content: tooltipContent,
                    top: event.clientY,
                    left: event.clientX,
                    violations: violationsArray.map(v => ({ title: v.rule.title, from: v.from }))
                });
            } else {
                 setTooltip(null);
            }
        };
    
        const handleClick = (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            const fixButton = target.closest('.ai-fix-btn');
            
            if (fixButton) {
                const from = fixButton.getAttribute('data-from');
                const title = fixButton.getAttribute('data-title');
                if (from && title) {
                    const violation = allViolations.find(v => v.rule.title === title && v.from === parseInt(from, 10));
                    if (violation) {
                        handleAiFix(violation.rule, violation);
                    }
                }
                return;
            }

            if (tooltipRef.current?.contains(event.target as Node)) {
                return;
            }
    
            if (!isTooltipAlwaysOn) {
                if (pinnedTooltip) setPinnedTooltip(null);
                return;
            }

            if (pinnedTooltip) {
                setPinnedTooltip(null);
                return;
            }

            if (tooltip) {
                setPinnedTooltip(tooltip);
            }
        };
    
        editorDom.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('click', handleClick);
    
        return () => {
            editorDom.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('click', handleClick);
        };
    }, [editor, highlightedItem, isTooltipAlwaysOn, pinnedTooltip, tooltip, aiFixingInfo, t.fix, allViolations, uiLanguage, t.leftSidebar.required, t.leftSidebar.current, handleAiFix]);
    

    const value = {
        highlightedItem,
        setHighlightedItem,
        tooltip,
        tooltipRef,
        pinnedTooltip,
        isTooltipAlwaysOn,
        setIsTooltipAlwaysOn,
        isTocVisible,
        isSpotlightVisible,
        setIsSpotlightVisible,
        handleScrollToTop,
        applyHighlights,
        clearAllHighlights,
        handleToggleAllKeywordsHighlight,
        handleRemoveEmptyLines,
        handleFixParagraphs,
        handleClearFormatting,
        handleToggleToc,
        handleHighlightStructureItem,
    };

    return <InteractionContext.Provider value={value}>{children}</InteractionContext.Provider>;
};
