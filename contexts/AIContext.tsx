
import React, { useState, useCallback, createContext, useContext, useEffect, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import { useUser } from './UserContext';
import { useEditor } from './EditorContext';
import { useModal } from './ModalContext';
import type { CheckResult, HeadingAnalysisResult, AIHistoryItem } from '../types';
import { parseMarkdownToHtml, generateToc } from '../utils/editorUtils';
import { FIXABLE_RULES } from '../constants';

const GEMINI_MODEL = 'gemini-3.1-pro-preview';

const callGeminiAnalysis = async (prompt: string, userKey?: string): Promise<string> => {
    try {
      const trimmedUserKey = userKey?.trim();
      if (trimmedUserKey) {
        const ai = new GoogleGenAI({ apiKey: trimmedUserKey });
        const response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
        });
        return typeof response.text === 'string' ? response.text : '';
      }

      const response = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      const isJson = response.headers.get('content-type')?.includes('application/json');
      const data = isJson ? await response.json().catch(() => ({})) : {};

      if (!response.ok) {
          throw new Error(data.error || `Gemini request failed with status ${response.status}`);
      }

      if (typeof data.text !== 'string') {
          throw new Error('Gemini server route did not return a valid text response.');
      }

      return data.text;
    } catch (error) {
      console.error("Error calling Gemini API:", error);
      const errorMessage = error instanceof Error ? error.message : "خطأ غير معروف";
      return `حدث خطأ أثناء الاتصال بـ Gemini: ${errorMessage}`;
    }
};

const extractJson = (text: string): any | null => {
    if (!text) return null;
    try {
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```|({[\s\S]*})/);
        if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
            return JSON.parse(jsonMatch[1] || jsonMatch[2]);
        }
        if (text.trim().startsWith('{')) {
            return JSON.parse(text);
        }
        return null;
    } catch (e) {
        return null;
    }
};

type SuggestionState = {
  original?: string;
  suggestions: string[];
  action: 'replace-text' | 'replace-title' | 'copy-meta';
  from?: number;
  to?: number;
  historyItemId?: string;
};

type FixAllProgress = {
    current: number;
    total: number;
    running: boolean;
    failed: number;
    errors: string[];
};

interface AIContextType {
    aiResults: { gemini: string; perplexity: string };
    isAiLoading: { gemini: boolean; perplexity: boolean };
    isAiCommandLoading: boolean;
    aiFixingInfo: { title: string; from: number } | null;
    suggestion: SuggestionState | null;
    setSuggestion: React.Dispatch<React.SetStateAction<SuggestionState | null>>;
    headingsAnalysis: HeadingAnalysisResult[] | null;
    setHeadingsAnalysis: React.Dispatch<React.SetStateAction<HeadingAnalysisResult[] | null>>;
    isHeadingsAnalysisMinimized: boolean;
    setIsHeadingsAnalysisMinimized: React.Dispatch<React.SetStateAction<boolean>>;
    aiHistory: AIHistoryItem[];
    fixAllProgress: FixAllProgress;
    handleAiRequest: (promptTemplate: string, action: 'replace-text' | 'replace-title' | 'copy-meta') => Promise<void>;
    handleAnalyzeHeadings: () => Promise<void>;
    handleAiAnalyze: (userPrompt: string, options: any) => Promise<void>;
    handlePerplexitySearch: (userPrompt: string, options: any, model?: 'sonar' | 'sonar-pro') => Promise<void>;
    handleAiFix: (rule: CheckResult, item: NonNullable<CheckResult['violatingItems']>[0]) => Promise<void>;
    handleFixAllViolations: (rulesToFix: string[]) => Promise<void>;
    applySuggestionFromHistory: (historyItemId: string, suggestionText: string) => void;
    markHistorySuggestionApplied: (historyItemId: string, suggestionText: string) => void;
    removeFromAiHistory: (historyItemId: string) => void;
    generateContextAwarePrompt: (userPrompt: string, options: any) => string;
    openGoogleSearch: (query: string) => void;
}

const AIContext = createContext<AIContextType | null>(null);

export const useAI = () => {
  const context = useContext(AIContext);
  if (!context) throw new Error("useAI must be used within an AIProvider");
  return context;
};

export const AIProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { t, uiLanguage, apiKeys } = useUser();
    const { editor, title, text, keywords, analysisResults, aiGoal, articleKey } = useEditor();
    const { openModal } = useModal();
    
    const [aiResults, setAiResults] = useState({ gemini: '', perplexity: '' });
    const [isAiLoading, setIsAiLoading] = useState({ gemini: false, perplexity: false });
    const [isAiCommandLoading, setIsAiCommandLoading] = useState(false);
    const [suggestion, setSuggestion] = useState<SuggestionState | null>(null);
    const [headingsAnalysis, setHeadingsAnalysis] = useState<HeadingAnalysisResult[] | null>(null);
    const [isHeadingsAnalysisMinimized, setIsHeadingsAnalysisMinimized] = useState(false);
    const [aiFixingInfo, setAiFixingInfo] = useState<{ title: string; from: number } | null>(null);
    const [aiHistory, setAiHistory] = useState<AIHistoryItem[]>([]);
    const [fixAllProgress, setFixAllProgress] = useState<FixAllProgress>({ current: 0, total: 0, running: false, failed: 0, errors: [] });
    
    const isInitialMount = useRef(true);

    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        setAiHistory([]);
        setFixAllProgress({ current: 0, total: 0, running: false, failed: 0, errors: [] });
    }, [articleKey]);

    const logToAiHistory = useCallback((item: Omit<AIHistoryItem, 'id'>) => {
        const newItem: AIHistoryItem = { ...item, id: `${Date.now()}-${Math.random()}` };
        setAiHistory(prev => [newItem, ...prev]);
        return newItem.id;
    }, []);

    const normalizeRangeText = useCallback((value: string) => value.replace(/\s+/g, ' ').trim(), []);

    const getSafeRangeText = useCallback((from: number, to: number): string | null => {
        if (!editor) return null;
        const docSize = editor.state.doc.content.size;
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > docSize || from >= to) {
            return null;
        }
        return editor.state.doc.textBetween(from, to, ' ');
    }, [editor]);

    useEffect(() => {
        if (suggestion) openModal('suggestion');
    }, [suggestion, openModal]);
    
    useEffect(() => {
        if (headingsAnalysis && !isHeadingsAnalysisMinimized) openModal('headingsAnalysis');
    }, [headingsAnalysis, isHeadingsAnalysisMinimized, openModal]);

    const buildComprehensivePrompt = (basePrompt: string, sectionHeading?: string) => {
        const professionalRoleAndGoal = `أنت كاتب محتوى خبير في موضوع "${keywords.primary || 'المحتوى العام'}". هدفك إنتاج محتوى متوافق مع SEO و AEO و GEO.`;
        let contextParts: string[] = [];
        let kwContext = "**الكلمات المستهدفة:**\n";
        kwContext += `- الأساسية: ${keywords.primary || 'لم تحدد'}\n`;
        kwContext += `- المرادفة: ${keywords.secondaries.filter(Boolean).join(', ') || 'لم تحدد'}\n`;
        contextParts.push(kwContext);
        if (sectionHeading) contextParts.push(`**سياق العنوان:** "${sectionHeading}"`);
        const tocString = generateToc(editor);
        if (tocString) contextParts.push(`**هيكل المقال:**\n${tocString}`);
        return `${professionalRoleAndGoal}\n\n${contextParts.join('\n\n')}\n\n**المطلوب:**\n${basePrompt}`;
    };

    const generateContextAwarePrompt = useCallback((userPrompt: string, options: any) => {
        const { manualCommand, editorText, targetKeywords, keywordCriteria, structureCriteria, goalCriteria } = options;
        let parts: string[] = [];
        parts.push(`أنت خبير SEO وكاتب محتوى محترف. الهدف الحالي للمقال هو "${aiGoal}".`);
        if (targetKeywords) {
            parts.push(`**الكلمات المستهدفة:** الأساسية: ${keywords.primary}, المرادفات: ${keywords.secondaries.filter(Boolean).join(', ')}`);
        }
        if (keywordCriteria) {
            const keywordSummary: string[] = [];
            const kw = analysisResults.keywordAnalysis;
            keywordSummary.push(`- الأساسية: الحالي ${kw.primary.count}، المطلوب ${kw.primary.requiredCount.join('-')}، الحالة ${kw.primary.status}.`);
            const unmetPrimaryChecks = kw.primary.checks.filter(check => !check.isMet).map(check => check.text);
            if (unmetPrimaryChecks.length) keywordSummary.push(`- شروط أساسية غير محققة: ${unmetPrimaryChecks.join('، ')}.`);
            if (kw.secondariesDistribution.status !== 'info') {
                keywordSummary.push(`- المرادفات إجمالاً: الحالي ${kw.secondariesDistribution.count}، المطلوب ${kw.secondariesDistribution.requiredCount.join('-')}، الحالة ${kw.secondariesDistribution.status}.`);
            }
            kw.secondaries.forEach((secondary, index) => {
                const term = keywords.secondaries[index]?.trim();
                if (!term) return;
                const unmetChecks = secondary.checks.filter(check => !check.isMet).map(check => check.text);
                keywordSummary.push(`- المرادف "${term}": الحالي ${secondary.count}، المطلوب ${secondary.requiredCount.join('-')}، الحالة ${secondary.status}${unmetChecks.length ? `، غير محقق: ${unmetChecks.join('، ')}` : ''}.`);
            });
            if (kw.company.status !== 'info') {
                keywordSummary.push(`- اسم الشركة: الحالي ${kw.company.count}، المطلوب ${kw.company.requiredCount.join('-')}، الحالة ${kw.company.status}.`);
            }
            if (kw.lsi.distribution.status !== 'info') {
                keywordSummary.push(`- LSI: الحالي ${kw.lsi.distribution.count}، المطلوب ${kw.lsi.distribution.requiredCount.join('-')}، الحالة ${kw.lsi.distribution.status}.`);
                keywordSummary.push(`- توازن LSI: ${kw.lsi.balance.current}، المطلوب ${kw.lsi.balance.required}.`);
            }
            parts.push(`**معايير الكلمات الحالية:**\n${keywordSummary.join('\n') || '- لا توجد كلمات مستهدفة مدخلة.'}`);
        }
        if (editorText) {
            const truncatedText = text.length > 6000 ? text.substring(text.length - 6000) : text;
            parts.push(`**سياق من نص المقال الحالي:**\n---\n${truncatedText}\n---`);
        }
        if (structureCriteria) {
            const problematicRules = (Object.values(analysisResults.structureAnalysis) as CheckResult[])
                .filter(rule => rule.status === 'fail' || rule.status === 'warn')
                .slice(0, 25)
                .map(rule => {
                    const firstMessages = rule.violatingItems?.slice(0, 3).map(item => item.message).filter(Boolean).join(' | ');
                    return `- ${rule.title}: الحالة ${rule.status}، الحالي ${rule.current}، المطلوب ${rule.required}${firstMessages ? `، أمثلة: ${firstMessages}` : ''}.`;
                });
            parts.push(`**معايير البنية والجودة المخالفة:**\n${problematicRules.length ? problematicRules.join('\n') : '- لا توجد مخالفات بنيوية حالية.'}`);
        }
        if (goalCriteria) {
            const goalRules = (() => {
                const s = analysisResults.structureAnalysis;
                if (aiGoal === 'برنامج سياحي') {
                    return [s.firstTitle, s.secondTitle, s.includesExcludes, s.preTravelH2, s.pricingH2, s.whoIsItForH2];
                }
                if (aiGoal === 'بيع جهاز') {
                    return [s.mandatoryH2Sections, s.supportingH2Sections, s.tablesCount];
                }
                return [s.wordCount, s.summaryParagraph, s.faqSection, s.lastH2IsConclusion, s.conclusionWordCount];
            })();
            parts.push(`**معايير الهدف المختار:**\n${goalRules.map(rule => `- ${rule.title}: الحالة ${rule.status}، الحالي ${rule.current}، المطلوب ${rule.required}.`).join('\n')}`);
        }
        if (manualCommand && userPrompt.trim()) {
            parts.push(`**الأمر المطلوب:**\n${userPrompt}`);
        } else if (userPrompt.trim()) {
             parts.push(userPrompt);
        }
        return parts.join('\n\n');
    }, [keywords, text, aiGoal, analysisResults]);
    
    const handleAiAnalyze = useCallback(async (userPrompt: string, options: any) => {
        if (!editor) return;
        setIsAiLoading(prev => ({ ...prev, gemini: true }));
        try {
            const finalPrompt = generateContextAwarePrompt(userPrompt, options);
            const result = await callGeminiAnalysis(finalPrompt, apiKeys.gemini);
            setAiResults(prev => ({ ...prev, gemini: result }));
        } catch (e) {
            setAiResults(prev => ({ ...prev, gemini: "فشل التحليل." }));
        } finally {
            setIsAiLoading(prev => ({ ...prev, gemini: false }));
        }
    }, [generateContextAwarePrompt, apiKeys.gemini, editor]);

    const handlePerplexitySearch = useCallback(async (userPrompt: string, options: any, model: 'sonar' | 'sonar-pro' = 'sonar') => {
        setIsAiLoading(prev => ({ ...prev, perplexity: true }));
        setAiResults(prev => ({ ...prev, perplexity: '' }));

        // Timeout safety
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

        try {
            const finalPrompt = generateContextAwarePrompt(userPrompt, options);
            
            // Route Perplexity through the Vercel function.
            const userKey = apiKeys.perplexity?.find(k => k && k.trim() !== '');
            const apiKey = userKey?.trim();

            const response = await fetch('/api/perplexity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: finalPrompt,
                    model,
                    apiKey: apiKey || undefined,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.error?.message || data.error || `Perplexity request failed with status ${response.status}`);
            }

            setAiResults(prev => ({ ...prev, perplexity: data.text || "No results." }));

        } catch (error) {
            clearTimeout(timeoutId);
            console.error("Perplexity Search Error:", error);
            let msg = "حدث خطأ غير متوقع.";
            if (error instanceof Error) {
                if (error.name === 'AbortError') msg = "انتهت مهلة البحث (60 ثانية).";
                else msg = `خطأ: ${error.message}`;
            }
            setAiResults(prev => ({ ...prev, perplexity: msg }));
        } finally {
            setIsAiLoading(prev => ({ ...prev, perplexity: false }));
        }
    }, [generateContextAwarePrompt, apiKeys.perplexity]);
    
    const handleAiRequest = useCallback(async (promptTemplate: string, action: 'replace-text' | 'replace-title' | 'copy-meta') => {
        if (isAiCommandLoading || isAiLoading.gemini || !editor) return;
        setIsAiCommandLoading(true);
        try {
            let textToProcess = "";
            let originalText = "";
            let from, to;
            if (action === 'replace-text') {
                const { from: f, to: t } = editor.state.selection;
                from = f; to = t;
                textToProcess = editor.state.doc.textBetween(f, t, ' ');
                originalText = textToProcess;
            } else {
                textToProcess = text;
                originalText = action === 'replace-title' ? title : 'Meta Description';
            }
            const prompt = promptTemplate.replace('${selectedText}', textToProcess).replace('${fullArticleText}', textToProcess);
            const finalPrompt = `${buildComprehensivePrompt(prompt)}\n\nأرجع النتيجة بتنسيق JSON حصراً: { "suggestions": ["..."] }`;
            const resultJson = await callGeminiAnalysis(finalPrompt, apiKeys.gemini);
            const parsed = extractJson(resultJson);
            if (parsed?.suggestions) {
                const suggestions = parsed.suggestions.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0);
                if (suggestions.length > 0) {
                    let historyItemId: string | undefined;
                    if (action === 'replace-text' && from != null && to != null) {
                        historyItemId = logToAiHistory({
                            type: 'user-command',
                            originalText,
                            suggestions,
                            from,
                            to,
                        });
                    }
                    setSuggestion({ original: originalText, suggestions, action, from, to, historyItemId });
                }
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsAiCommandLoading(false);
        }
    }, [editor, title, text, buildComprehensivePrompt, apiKeys.gemini, logToAiHistory]);

    const handleAnalyzeHeadings = useCallback(async () => {
        if (isAiLoading.gemini || !editor) return;
        setIsAiLoading(prev => ({ ...prev, gemini: true }));
        try {
            const headings: any[] = [];
            editor.state.doc.descendants((node, pos) => {
                if (node.type.name === 'heading') headings.push({ level: node.attrs.level, text: node.textContent, from: pos, to: pos + node.nodeSize });
            });
            const headingsText = headings.map(h => `[H${h.level}] ${h.text}`).join('\n');
            const prompt = `${buildComprehensivePrompt("حلل العناوين التالية وقدم 3 بدائل لكل منها.")}\n\n${headingsText}\n\nأرجع مصفوفة JSON حصراً: [ { "original": "...", "level": 2, "flaws": [], "suggestions": [] } ]`;
            const resultJson = await callGeminiAnalysis(prompt, apiKeys.gemini);
            const parsed = extractJson(resultJson);
            if (Array.isArray(parsed)) {
                setHeadingsAnalysis(parsed.map((item, idx) => ({ ...item, from: headings[idx]?.from, to: headings[idx]?.to })));
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsAiLoading(prev => ({ ...prev, gemini: false }));
        }
    }, [editor, buildComprehensivePrompt, apiKeys.gemini]);

    const handleAiFix = useCallback(async (rule: CheckResult, item: any) => {
        if (!editor) return;
        setAiFixingInfo({ title: rule.title, from: item.from });
        try {
            const originalText = editor.state.doc.textBetween(item.from, item.to, ' ');
            const prompt = `${buildComprehensivePrompt(`أصلح النص التالي لحل مشكلة: ${rule.title}`)}\nالنص: "${originalText}"\nأرجع JSON: { "suggestions": ["..."] }`;
            const resultJson = await callGeminiAnalysis(prompt, apiKeys.gemini);
            const parsed = extractJson(resultJson);
            if (parsed?.suggestions) {
                const suggestions = parsed.suggestions.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0);
                if (suggestions.length > 0) {
                    const historyItemId = logToAiHistory({
                        type: 'fix-violation',
                        ruleTitle: rule.title,
                        originalText,
                        suggestions,
                        from: item.from,
                        to: item.to,
                    });
                    setSuggestion({ original: originalText, suggestions, action: 'replace-text', from: item.from, to: item.to, historyItemId });
                }
            }
        } finally {
            setAiFixingInfo(null);
        }
    }, [editor, buildComprehensivePrompt, apiKeys.gemini, logToAiHistory]);

    const handleFixAllViolations = useCallback(async (rulesToFix: string[]) => {
        if (!editor || !analysisResults.structureAnalysis) return;
        setFixAllProgress({ current: 0, total: 0, running: true, failed: 0, errors: [] });
        const allViolations: any[] = [];
        Object.values(analysisResults.structureAnalysis).forEach((rule: any) => {
            if (rulesToFix.includes(rule.title) && FIXABLE_RULES.has(rule.title) && rule.violatingItems) {
                rule.violatingItems.forEach((item: any) => allViolations.push({ rule, item }));
            }
        });
        setFixAllProgress(p => ({ ...p, total: allViolations.length }));
        allViolations.sort((a, b) => b.item.from - a.item.from);
        for (let i = 0; i < allViolations.length; i++) {
            const { rule, item } = allViolations[i];
            setFixAllProgress(p => ({ ...p, current: i + 1 }));
            try {
                const targetText = getSafeRangeText(item.from, item.to);
                if (targetText === null) {
                    throw new Error('Target range is no longer valid.');
                }
                const prompt = `${buildComprehensivePrompt(`أصلح هذا النص لمشكلة ${rule.title}`)}\nالنص: "${targetText}"\nأرجع JSON: { "fixedText": "..." }`;
                const res = await callGeminiAnalysis(prompt, apiKeys.gemini);
                const parsed = extractJson(res);
                if (parsed?.fixedText) {
                    editor.chain().focus().insertContentAt({ from: item.from, to: item.to }, parseMarkdownToHtml(parsed.fixedText)).run();
                } else {
                    throw new Error('AI did not return fixedText.');
                }
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Unknown fix error';
                console.error('Fix all item failed:', rule.title, e);
                setFixAllProgress(p => ({
                    ...p,
                    failed: p.failed + 1,
                    errors: [...p.errors, `${rule.title}: ${message}`].slice(-3),
                }));
            }
        }
        setFixAllProgress(p => ({ ...p, running: false }));
    }, [editor, analysisResults, buildComprehensivePrompt, apiKeys.gemini, getSafeRangeText]);

    const markHistorySuggestionApplied = (id: string, text: string) => {
        setAiHistory(history => history.map(historyItem => (
            historyItem.id === id ? { ...historyItem, appliedSuggestion: text, applyError: undefined } : historyItem
        )));
    };

    const applySuggestionFromHistory = (id: string, text: string) => {
        if (!editor) return;
        const item = aiHistory.find(historyItem => historyItem.id === id);
        if (!item || item.appliedSuggestion) return;
        const currentText = getSafeRangeText(item.from, item.to);
        if (currentText === null || normalizeRangeText(currentText) !== normalizeRangeText(item.originalText)) {
            setAiHistory(history => history.map(historyItem => (
                historyItem.id === id
                    ? { ...historyItem, applyError: 'Original text changed. Recreate this suggestion before applying it.' }
                    : historyItem
            )));
            return;
        }
        editor.chain().focus().insertContentAt({ from: item.from, to: item.to }, parseMarkdownToHtml(text)).run();
        markHistorySuggestionApplied(id, text);
    };

    const openGoogleSearch = (query: string) => {
        window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank');
    };

    const value = {
        aiResults, isAiLoading, isAiCommandLoading, aiFixingInfo, suggestion, setSuggestion,
        headingsAnalysis, setHeadingsAnalysis, isHeadingsAnalysisMinimized, setIsHeadingsAnalysisMinimized,
        aiHistory, fixAllProgress, handleAiRequest, handleAnalyzeHeadings, handleAiAnalyze,
        handlePerplexitySearch, handleAiFix, handleFixAllViolations, applySuggestionFromHistory,
        markHistorySuggestionApplied,
        removeFromAiHistory: (id: string) => setAiHistory(h => h.filter(x => x.id !== id)),
        generateContextAwarePrompt, openGoogleSearch
    };

    return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
};
