
import React, { useState, useCallback, useEffect, useRef, createContext, useContext, useMemo } from 'react';
import type { Editor as EditorClass } from '@tiptap/core';

import { useUser } from './UserContext';
import { useEditor } from './EditorContext';
import { useAI } from './AIContext';
import type { CheckResult, StructureAnalysis } from '../types';
import { SECONDARY_COLORS, VIOLATION_PRIORITY, DEFAULT_PRIORITY } from '../constants';

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
  fixedWidth?: number;
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

const PARAGRAPH_PAIR_TOOLTIP_WIDTH_PX = 380;
const STRUCTURE_TOOLTIP_WIDTH_PX = 420;

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

const formatTooltipMultilineBlock = (value: string): string => (
    escapeTooltipHtml(value)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n/g, '<br>')
);

type StructureViolationItem = NonNullable<CheckResult['violatingItems']>[number];
type ResolvedStructureViolation = StructureViolationItem & { rule: CheckResult };

const isStructureHighlightedItem = (value: string | any[] | null): value is string => (
    typeof value === 'string' && value !== '__ALL_KEYWORDS__'
);

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

const findBestViolationTextMatch = (
    editor: EditorClass,
    expectedText: string,
    originalFrom: number,
): { from: number; to: number } | null => {
    const normalizedExpectedText = normalizeViolationText(expectedText);
    const exactExpectedText = expectedText.trim();
    let bestMatch: { from: number; to: number; score: number } | null = null;

    const considerMatch = (from: number, to: number, bonus = 0) => {
        const score = Math.abs(from - originalFrom) + bonus;
        if (!bestMatch || score < bestMatch.score) {
            bestMatch = { from, to, score };
        }
    };

    editor.state.doc.descendants((node, pos) => {
        if (node.isBlock && ['paragraph', 'heading', 'listItem'].includes(node.type.name)) {
            if (normalizeViolationText(node.textContent) === normalizedExpectedText) {
                considerMatch(pos, pos + node.nodeSize);
            }
        }

        if (!node.isText || !node.text || exactExpectedText.length === 0) return;

        let searchFrom = 0;
        while (searchFrom <= node.text.length) {
            const index = node.text.indexOf(exactExpectedText, searchFrom);
            if (index === -1) break;
            considerMatch(pos + index, pos + index + exactExpectedText.length, 2);
            searchFrom = index + Math.max(1, exactExpectedText.length);
        }
    });

    return bestMatch ? { from: bestMatch.from, to: bestMatch.to } : null;
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

    const bestMatch = findBestViolationTextMatch(editor, violation.text || expectedText, violation.from);
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
    const highlightedItemRef = useRef<string | any[] | null>(null);
    const activeStructureHighlightTitleRef = useRef<string | null>(null);
    const tooltipFixTargetsRef = useRef<Map<string, ResolvedStructureViolation>>(new Map());
    const pinnedTooltipHideTimerRef = useRef<number | null>(null);

    const [isTocVisible, setIsTocVisible] = useState(false);
    const [isSpotlightVisible, setIsSpotlightVisible] = useState(false);
    
    const hasRunFirstPasteCleanupRef = useRef(false);
    const isFirstPasteCleanupRunningRef = useRef(false);

    useEffect(() => {
        highlightedItemRef.current = highlightedItem;
    }, [highlightedItem]);

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
    }, [analysisResults, editor]);

    const handleScrollToTop = () => {
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
        }
        if (editor) {
            (editor.chain() as any).focus().setTextSelection(1).run();
        }
    };
    
    const clearAllHighlights = useCallback(() => {
        activeStructureHighlightTitleRef.current = null;
        setHighlightedItem(null);
        if (editor && !editor.isDestroyed) {
            const { tr } = editor.state;
            tr.removeMark(0, editor.state.doc.content.size, editor.schema.marks.highlight);
            tr.setMeta('internal-highlight-maintenance', true);
            editor.view.dispatch(tr);
        }
    }, [editor]);

    const applyStructureViolationMarks = useCallback((
        title: string,
        violations: StructureViolationItem[],
        status: CheckResult['status'],
        options: { scrollToFirst?: boolean; removeAllMarks?: boolean } = {}
    ): boolean => {
        if (!editor || editor.isDestroyed || violations.length === 0) return false;
        const { scrollToFirst = false, removeAllMarks = false } = options;
        const { tr } = editor.state;
        const highlightMarkType = editor.schema.marks.highlight;
        let firstHighlightPos: number | null = null;

        if (removeAllMarks) {
            tr.removeMark(0, editor.state.doc.content.size, highlightMarkType);
        } else {
            editor.state.doc.descendants((node, pos) => {
                if (!node.isText || !node.marks?.length) return;
                node.marks
                    .filter(mark => mark.type === highlightMarkType && mark.attrs?.isViolation)
                    .forEach(mark => {
                        tr.removeMark(pos, pos + node.nodeSize, mark);
                    });
            });
        }

        violations.forEach(violation => {
            const docSize = editor.state.doc.content.size;
            if (!Number.isFinite(violation.from) || !Number.isFinite(violation.to) || violation.from < 0 || violation.to > docSize || violation.from >= violation.to) {
                return;
            }
            if (firstHighlightPos === null) firstHighlightPos = violation.from;
            const highlightMark = (highlightMarkType as any).create({
                color: status === 'pass' ? '#fde68a' : '#fda4af',
                violation: title,
                from: violation.from,
                highlightStyle: highlightStyle,
                isViolation: true,
            });
            tr.addMark(violation.from, violation.to, highlightMark);
        });

        tr.setMeta('internal-highlight-maintenance', true);
        if (tr.steps.length > 0) {
            editor.view.dispatch(tr);
        }

        if (scrollToFirst && firstHighlightPos !== null) {
            setTimeout(() => {
                if (editor && !editor.isDestroyed) {
                    const selectionPos = Math.min(firstHighlightPos! + 1, editor.state.doc.content.size);
                    (editor.chain() as any)
                        .focus()
                        .setTextSelection(selectionPos)
                        .scrollIntoView()
                        .run();
                }
            }, 50);
        }

        return firstHighlightPos !== null;
    }, [editor, highlightStyle]);

    const clearViolationHighlights = useCallback(() => {
        if (!editor || editor.isDestroyed) return;
        const highlightMarkType = editor.schema.marks.highlight;
        const { tr } = editor.state;
        let changed = false;

        editor.state.doc.descendants((node, pos) => {
            if (!node.isText || !node.marks?.length) return;
            node.marks
                .filter(mark => mark.type === highlightMarkType && mark.attrs?.isViolation)
                .forEach(mark => {
                    tr.removeMark(pos, pos + node.nodeSize, mark);
                    changed = true;
                });
        });

        if (changed) {
            tr.setMeta('internal-highlight-maintenance', true);
            editor.view.dispatch(tr);
        }
    }, [editor]);

    useEffect(() => {
        if (!editor) return;

        const handleTransaction = ({ transaction }: { transaction: any }) => {
            if (!transaction.docChanged || transaction.getMeta('internal-highlight-maintenance')) return;
            if (!activeStructureHighlightTitleRef.current || !isStructureHighlightedItem(highlightedItemRef.current)) return;

            setTooltip(null);
            setPinnedTooltip(null);
        };

        editor.on('transaction', handleTransaction);
        return () => editor.off('transaction', handleTransaction);
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
        activeStructureHighlightTitleRef.current = null;
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

        if (editor.state.doc.content.size > 60_000) {
            return;
        }

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
            activeStructureHighlightTitleRef.current = title;
            applyStructureViolationMarks(title, resolvedViolations, item.status, { scrollToFirst: true, removeAllMarks: true });
            setHighlightedItem(title);
            setTooltip(null);
            setPinnedTooltip(null);
    
        } else {
            activeStructureHighlightTitleRef.current = null;
            clearAllHighlights();
        }
    }, [editor, highlightedItem, clearAllHighlights, setHighlightedItem, applyStructureViolationMarks]);

    useEffect(() => {
        if (!editor || editor.isDestroyed) return;
        const activeTitle = activeStructureHighlightTitleRef.current;
        if (!activeTitle || highlightedItem !== activeTitle) return;

        const activeRule = Object.values(analysisResults.structureAnalysis).find(rule => rule?.title === activeTitle);
        if (!activeRule || activeRule.status === 'pass' || !activeRule.violatingItems?.length) {
            activeStructureHighlightTitleRef.current = null;
            setHighlightedItem(null);
            setTooltip(null);
            setPinnedTooltip(null);
            clearViolationHighlights();
            return;
        }

        const resolvedViolations = (activeRule.violatingItems || [])
            .map(violation => resolveViolationRangeInCurrentDoc(editor, violation))
            .filter((violation): violation is StructureViolationItem => Boolean(violation));

        if (resolvedViolations.length === 0) {
            setTooltip(null);
            setPinnedTooltip(null);
            return;
        }

        applyStructureViolationMarks(activeTitle, resolvedViolations, activeRule.status, { scrollToFirst: false, removeAllMarks: false });
    }, [editor, analysisResults.structureAnalysis, highlightedItem, applyStructureViolationMarks, clearViolationHighlights]);
    
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

        const clearPinnedTooltipHideTimer = () => {
            if (pinnedTooltipHideTimerRef.current !== null) {
                window.clearTimeout(pinnedTooltipHideTimerRef.current);
                pinnedTooltipHideTimerRef.current = null;
            }
        };

        const getSelectedRuleTitle = () => (
            typeof highlightedItem === 'string' &&
                allViolations.some(v => v.rule.title === highlightedItem)
                    ? highlightedItem
                    : null
        );

        const getPointerViolations = (event: MouseEvent, selectedRuleTitle: string | null): ResolvedStructureViolation[] => {
            if (!editorDom.contains(event.target as Node)) return [];
            const posResult = editorView.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!posResult) return [];

            const currentPos = posResult.pos;
            return allViolations.filter(v => {
                if (selectedRuleTitle && v.rule.title !== selectedRuleTitle) return false;
                return currentPos >= v.from && currentPos <= v.to;
            });
        };

        const isPointerInsideTooltip = (event: MouseEvent, margin = 0): boolean => {
            const tooltipElement = tooltipRef.current;
            if (!tooltipElement) return false;
            if (tooltipElement.contains(event.target as Node)) return true;
            const rect = tooltipElement.getBoundingClientRect();
            return (
                event.clientX >= rect.left - margin &&
                event.clientX <= rect.right + margin &&
                event.clientY >= rect.top - margin &&
                event.clientY <= rect.bottom + margin
            );
        };

        const buildTooltipState = (event: MouseEvent, activeViolations: ResolvedStructureViolation[]): { tooltipState: NonNullable<TooltipState>; fixTargets: Map<string, ResolvedStructureViolation> } | null => {
            if (activeViolations.length === 0) return null;
            const uniqueViolations: { [key: string]: ResolvedStructureViolation } = {};
            activeViolations.forEach(v => {
                const key = [v.rule.title, v.from, v.to, v.pairedFrom ?? ''].join('|');
                uniqueViolations[key] = v;
            });

            const violationsArray = Object.values(uniqueViolations)
                .sort((a, b) => (VIOLATION_PRIORITY[a.rule.title] || DEFAULT_PRIORITY) - (VIOLATION_PRIORITY[b.rule.title] || DEFAULT_PRIORITY));

            const nextFixTargets = new Map<string, ResolvedStructureViolation>();

            const tooltipContent = violationsArray
                .map((v, index) => {
                    const rule = v.rule;
                    const isFixingThis = aiFixingInfo?.title === rule.title && aiFixingInfo?.from === v.from;
                    const isFixingAny = Boolean(aiFixingInfo);
                    const fixKey = `${rule.title}|${v.from}|${v.to}|${v.pairedFrom ?? ''}|${index}`;
                    nextFixTargets.set(fixKey, v);
                    const safeTitle = escapeTooltipHtml(rule.title);
                    const buttonLabel = isFixingThis
                        ? (uiLanguage === 'ar' ? 'جاري الإصلاح...' : 'Fixing...')
                        : (uiLanguage === 'ar' ? 'إصلاح هذه المخالفة' : 'Fix this');
                    const buttonHtml = `
                        <button
                            type="button"
                            data-fix-key="${escapeTooltipHtml(fixKey)}"
                            class="ai-fix-btn"
                            ${isFixingAny ? 'disabled' : ''}
                            style="display:inline-flex;align-items:center;gap:6px;border:0;border-radius:8px;background:${isFixingThis ? '#9ca3af' : '#d4af37'};color:white;padding:5px 8px;font-size:10px;font-weight:800;line-height:1;cursor:${isFixingAny ? 'not-allowed' : 'pointer'};opacity:${isFixingAny && !isFixingThis ? '0.55' : '1'};"
                        >
                            ${isFixingThis ? '<span style="display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,.55);border-top-color:white;border-radius:999px;"></span>' : ''}
                            ${escapeTooltipHtml(buttonLabel)}
                        </button>`;

                    const stripHtml = (value: unknown): string => String(value ?? '').replace(/<[^>]*>/g, '').trim();
                    const violationText = stripHtml(v.text || getSafeDocTextBetween(editor, v.from, v.to) || '');
                    const problemText = stripHtml(v.message || rule.description || rule.title);
                    const currentParts = [
                        rule.current != null && String(rule.current).trim()
                            ? `${uiLanguage === 'ar' ? 'نتيجة المعيار الحالية' : 'Current criterion result'}: ${stripHtml(rule.current)}`
                            : '',
                        violationText
                            ? `${uiLanguage === 'ar' ? 'النص المخالف' : 'Violating text'}: ${violationText}`
                            : '',
                    ].filter(Boolean);
                    const currentText = currentParts.join('\n') || stripHtml(rule.current || problemText || safeTitle);
                    const requiredText = stripHtml(rule.required || (uiLanguage === 'ar' ? 'راجع شروط المعيار.' : 'Review the criterion requirements.'));
                    const ruleNote = getRuleTooltipNote(rule.title, uiLanguage);
                    const correctionTips = [
                        ruleNote,
                        stripHtml(rule.details),
                        stripHtml(rule.description),
                    ]
                        .filter((item, itemIndex, allItems): item is string => Boolean(item) && allItems.indexOf(item) === itemIndex)
                        .join('\n\n') || (uiLanguage === 'ar'
                            ? 'عدّل النص المخالف حتى يطابق قيمة "المطلوب"، ثم أعد التحليل للتأكد من زوال المخالفة.'
                            : 'Edit the violating text so it matches the required value, then rerun analysis to confirm the issue is resolved.'
                        );
                    const pairedParagraphHtml = v.pairedText
                        ? `<div style="margin-top: 4px; display: grid; gap: 3px; width: 100%; text-align: ${uiLanguage === 'ar' ? 'right' : 'left'};">
                                <strong>${uiLanguage === 'ar' ? 'الفقرة الزوجية للمقارنة اليدوية' : 'Paired paragraph for manual comparison'}:</strong>
                                <span style="display: block; width: 100%; box-sizing: border-box; max-height: 120px; overflow-y: auto; padding: 6px; border-radius: 6px; background: rgba(212, 175, 55, 0.08); color: inherit; line-height: 1.6;">${formatTooltipTextBlock(v.pairedText)}</span>
                            </div>`
                        : '';

                    const detailsHtml = `
                        <div style="display: grid; gap: 8px; font-size: 11px; color: #6b7280; width: 100%; text-align: ${uiLanguage === 'ar' ? 'right' : 'left'};" class="dark:text-gray-400">
                            <div style="display: grid; gap: 3px;">
                                <strong style="color: inherit;">${uiLanguage === 'ar' ? 'المشكلة' : 'Problem'}</strong>
                                <span style="display: block; line-height: 1.65;">${formatTooltipMultilineBlock(problemText)}</span>
                            </div>
                            <div style="display: grid; gap: 3px;">
                                <strong style="color: inherit;">${uiLanguage === 'ar' ? 'الحالي' : 'Current'}</strong>
                                <span style="display: block; line-height: 1.65;">${formatTooltipMultilineBlock(currentText)}</span>
                            </div>
                            <div style="display: grid; gap: 3px;">
                                <strong style="color: inherit;">${uiLanguage === 'ar' ? 'المطلوب' : 'Required'}</strong>
                                <span style="display: block; line-height: 1.65;">${formatTooltipMultilineBlock(requiredText)}</span>
                            </div>
                            <div style="display: grid; gap: 3px;">
                                <strong style="color: inherit;">${uiLanguage === 'ar' ? 'نصائح للتصحيح حسب شروط المعيار' : 'Correction tips based on this criterion'}</strong>
                                <span style="display: block; box-sizing: border-box; max-height: 150px; overflow-y: auto; padding: 6px; border-radius: 6px; background: rgba(212, 175, 55, 0.08); line-height: 1.65;">${formatTooltipMultilineBlock(correctionTips)}</span>
                            </div>
                            ${pairedParagraphHtml}
                        </div>`;

                    return `<div class="flex flex-col items-start gap-2 w-full">
                                <div class="flex items-center gap-2 font-semibold" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${buttonHtml}<span>${safeTitle}</span></div>
                                ${detailsHtml}
                            </div>`;
                })
                .join('<hr class="border-gray-200 dark:border-[#3C3C3C] my-1.5 -mx-3 w-[calc(100%+1.5rem)]">');

            return {
                fixTargets: nextFixTargets,
                tooltipState: {
                    content: tooltipContent,
                    top: event.clientY,
                    left: event.clientX,
                    fixedWidth: violationsArray.some(v => Boolean(v.pairedText)) ? Math.max(PARAGRAPH_PAIR_TOOLTIP_WIDTH_PX, STRUCTURE_TOOLTIP_WIDTH_PX) : STRUCTURE_TOOLTIP_WIDTH_PX,
                    violations: violationsArray.map(v => ({ title: v.rule.title, from: v.from }))
                },
            };
        };

        const handleMouseMove = (event: MouseEvent) => {
            const selectedRuleTitle = getSelectedRuleTitle();
            const shouldShowHoverTooltip = isTooltipAlwaysOn || Boolean(selectedRuleTitle);

            if (!shouldShowHoverTooltip) {
                if (tooltip) setTooltip(null);
                if (pinnedTooltip) setPinnedTooltip(null);
                tooltipFixTargetsRef.current.clear();
                return;
            }

            if (pinnedTooltip) {
                if (tooltip) setTooltip(null);
                return;
            }

            const activeViolations = getPointerViolations(event, selectedRuleTitle);
            const builtTooltip = buildTooltipState(event, activeViolations);
            if (!builtTooltip) {
                setTooltip(null);
                tooltipFixTargetsRef.current.clear();
                return;
            }

            tooltipFixTargetsRef.current = builtTooltip.fixTargets;
            setTooltip(builtTooltip.tooltipState);
        };
    
        const handleClick = (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            const fixButton = target.closest('.ai-fix-btn');
            
            if (fixButton) {
                event.preventDefault();
                event.stopPropagation();
                const fixKey = fixButton.getAttribute('data-fix-key');
                const violation = fixKey ? tooltipFixTargetsRef.current.get(fixKey) : null;
                if (violation) {
                    handleAiFix(violation.rule, violation);
                }
                return;
            }

            if (tooltipRef.current?.contains(event.target as Node)) {
                return;
            }

            const selectedRuleTitle = getSelectedRuleTitle();
            if (!isTooltipAlwaysOn && selectedRuleTitle) {
                const activeViolations = getPointerViolations(event, selectedRuleTitle);
                const builtTooltip = buildTooltipState(event, activeViolations);
                if (builtTooltip) {
                    clearPinnedTooltipHideTimer();
                    tooltipFixTargetsRef.current = builtTooltip.fixTargets;
                    setTooltip(null);
                    setPinnedTooltip(builtTooltip.tooltipState);
                    return;
                }

                if (pinnedTooltip) setPinnedTooltip(null);
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
        const handleDocumentMouseMove = (event: MouseEvent) => {
            if (!pinnedTooltip || isTooltipAlwaysOn) return;
            const selectedRuleTitle = getSelectedRuleTitle();
            if (!selectedRuleTitle) return;
            if (isPointerInsideTooltip(event, 28) || getPointerViolations(event, selectedRuleTitle).length > 0) {
                clearPinnedTooltipHideTimer();
                return;
            }

            if (pinnedTooltipHideTimerRef.current === null) {
                pinnedTooltipHideTimerRef.current = window.setTimeout(() => {
                    pinnedTooltipHideTimerRef.current = null;
                    setPinnedTooltip(null);
                    setTooltip(null);
                }, 220);
            }
        };

        document.addEventListener('mousemove', handleDocumentMouseMove);
    
        return () => {
            clearPinnedTooltipHideTimer();
            editorDom.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('click', handleClick);
            document.removeEventListener('mousemove', handleDocumentMouseMove);
        };
    }, [editor, highlightedItem, isTooltipAlwaysOn, pinnedTooltip, tooltip, aiFixingInfo, t.fix, allViolations, uiLanguage, t.leftSidebar.current, handleAiFix]);
    

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
