
import React, { useState, useCallback, createContext, useContext, useEffect, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";
import { useUser } from './UserContext';
import { useEditor } from './EditorContext';
import { useModal } from './ModalContext';
import type { CheckResult, HeadingAnalysisResult, AIHistoryItem } from '../types';
import { parseMarkdownToHtml, generateToc } from '../utils/editorUtils';
import { FIXABLE_RULES } from '../constants';

const callGeminiAnalysis = async (prompt: string, userKey?: string): Promise<string> => {
    try {
      // Prioritize the user key from dashboard settings
      const apiKey = (userKey && userKey.trim().length > 0) ? userKey : process.env.API_KEY;

      if (!apiKey) {
          return "مفتاح API غير موجود. يرجى إدخال مفتاح Gemini الخاص بك في لوحة التحكم > الإعدادات > إدارة مفاتيح API.";
      }

      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: prompt,
      });
      
      const text = response.text;
      return text || '';
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
};

type FixAllProgress = {
    current: number;
    total: number;
    running: boolean;
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
    const [fixAllProgress, setFixAllProgress] = useState<FixAllProgress>({ current: 0, total: 0, running: false });
    
    const isInitialMount = useRef(true);

    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        setAiHistory([]);
        setFixAllProgress({ current: 0, total: 0, running: false });
    }, [articleKey]);

    const logToAiHistory = (item: Omit<AIHistoryItem, 'id'>) => {
        const newItem: AIHistoryItem = { ...item, id: `${Date.now()}-${Math.random()}` };
        setAiHistory(prev => [newItem, ...prev]);
    };

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
        if (editorText) {
            const truncatedText = text.length > 6000 ? text.substring(text.length - 6000) : text;
            parts.push(`**سياق من نص المقال الحالي:**\n---\n${truncatedText}\n---`);
        }
        if (manualCommand && userPrompt.trim()) {
            parts.push(`**الأمر المطلوب:**\n${userPrompt}`);
        } else if (userPrompt.trim()) {
             parts.push(userPrompt);
        }
        return parts.join('\n\n');
    }, [keywords, text, aiGoal]);
    
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
            
            // 1. Get API Key
            const userKey = apiKeys.perplexity?.find(k => k && k.trim() !== '');
            const apiKey = userKey || process.env.PERPLEXITY_API_KEY;

            if (!apiKey) {
                throw new Error("لم يتم العثور على مفتاح API. يرجى إضافته من الإعدادات أو التأكد من متغيرات البيئة.");
            }

            // 2. Direct Fetch (Bypassing local proxy to ensure connectivity)
            const response = await fetch("https://api.perplexity.ai/chat/completions", {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({ 
                    model: model, 
                    messages: [
                        { role: "system", content: "كن دقيقاً ومحايداً. أجب باللغة العربية." },
                        { role: "user", content: finalPrompt }
                    ],
                    stream: false 
                }),
                signal: controller.signal,
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error?.message || `خطأ من الخادم: ${response.status}`);
            }

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content || "لا توجد نتائج.";
            setAiResults(prev => ({ ...prev, perplexity: text }));

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
                setSuggestion({ original: originalText, suggestions: parsed.suggestions, action, from, to });
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsAiCommandLoading(false);
        }
    }, [editor, title, text, buildComprehensivePrompt, apiKeys.gemini]);

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
                setSuggestion({ original: originalText, suggestions: parsed.suggestions, action: 'replace-text', from: item.from, to: item.to });
            }
        } finally {
            setAiFixingInfo(null);
        }
    }, [editor, buildComprehensivePrompt, apiKeys.gemini]);

    const handleFixAllViolations = useCallback(async (rulesToFix: string[]) => {
        if (!editor || !analysisResults.structureAnalysis) return;
        setFixAllProgress({ current: 0, total: 0, running: true });
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
                const prompt = `${buildComprehensivePrompt(`أصلح هذا النص لمشكلة ${rule.title}`)}\nالنص: "${editor.state.doc.textBetween(item.from, item.to)}"\nأرجع JSON: { "fixedText": "..." }`;
                const res = await callGeminiAnalysis(prompt, apiKeys.gemini);
                const parsed = extractJson(res);
                if (parsed?.fixedText) {
                    editor.chain().focus().insertContentAt({ from: item.from, to: item.to }, parseMarkdownToHtml(parsed.fixedText)).run();
                }
            } catch (e) {}
        }
        setFixAllProgress({ current: 0, total: 0, running: false });
    }, [editor, analysisResults, buildComprehensivePrompt, apiKeys.gemini]);

    const applySuggestionFromHistory = (id: string, text: string) => {
        if (!editor) return;
        editor.chain().focus().insertContent(parseMarkdownToHtml(text)).run();
    };

    const openGoogleSearch = (query: string) => {
        window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank');
    };

    const value = {
        aiResults, isAiLoading, isAiCommandLoading, aiFixingInfo, suggestion, setSuggestion,
        headingsAnalysis, setHeadingsAnalysis, isHeadingsAnalysisMinimized, setIsHeadingsAnalysisMinimized,
        aiHistory, fixAllProgress, handleAiRequest, handleAnalyzeHeadings, handleAiAnalyze,
        handlePerplexitySearch, handleAiFix, handleFixAllViolations, applySuggestionFromHistory,
        removeFromAiHistory: (id: string) => setAiHistory(h => h.filter(x => x.id !== id)),
        generateContextAwarePrompt, openGoogleSearch
    };

    return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
};
