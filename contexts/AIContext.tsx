
import React, { useState, useCallback, createContext, useContext, useEffect, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import { useUser } from './UserContext';
import { useEditor } from './EditorContext';
import { useModal } from './ModalContext';
import type { AiAnalysisOptions, CheckResult, HeadingAnalysisResult, AIHistoryItem, GoalContext, StructureAnalysis } from '../types';
import { parseMarkdownToHtml, generateToc } from '../utils/editorUtils';
import { FIXABLE_RULES } from '../constants';
import { ENGINEERING_PROMPT_IDS, getEngineeringPrompt, renderEngineeringPrompt } from '../constants/engineeringPrompts';

const GEMINI_MODEL = 'gemini-3-flash-preview';
const OPENAI_MODEL = 'gpt-4.1-mini';
const CHATGPT_TIMEOUT_MS = 180000;

const GOAL_CONTEXT_LABELS: Record<string, string> = {
    pageType: 'نوع الصفحة',
    objective: 'هدف الصفحة',
    audienceScope: 'نطاق الجمهور',
    targetCountry: 'الدولة/السوق المستهدف',
    targetAudience: 'الجمهور المستهدف',
    searchIntent: 'نية البحث',
};

const GOAL_CONTEXT_VALUE_LABELS: Record<string, string> = {
    article: 'مقالة',
    news: 'خبر',
    service: 'صفحة خدمة',
    comparison: 'مقارنة',
    product: 'منتج',
    landing: 'صفحة هبوط',
    guide: 'دليل',
    faq: 'أسئلة وأجوبة',
    educate: 'شرح وتثقيف',
    compare: 'مقارنة ومساعدة على الاختيار',
    convert: 'تحويل مباشر: شراء/حجز/تواصل',
    trust: 'بناء الثقة وتقليل الاعتراضات',
    support: 'دعم بعد القرار أو الاستخدام',
    sell: 'تحويل مباشر: شراء/حجز/تواصل',
    bookings: 'تحويل مباشر: شراء/حجز/تواصل',
    leads: 'تحويل مباشر: شراء/حجز/تواصل',
    retention: 'دعم بعد القرار أو الاستخدام',
    local: 'مدينة أو منطقة محلية',
    global: 'عالمي دون سوق محدد',
    country: 'دولة واحدة محددة',
    regional: 'عدة دول أو إقليم',
    informational: 'فهم وتعلّم',
    commercial: 'مقارنة واختيار',
    transactional: 'تنفيذ إجراء',
    navigational: 'الوصول إلى علامة أو صفحة محددة',
    'support-intent': 'حل مشكلة أو معرفة طريقة الاستخدام',
    'local-intent': 'فهم وتعلّم',
};

const formatGoalContext = (goalContext: GoalContext): string => {
    return Object.entries(goalContext)
        .filter(([, value]) => value.trim().length > 0)
        .map(([key, value]) => `- ${GOAL_CONTEXT_LABELS[key] || key}: ${GOAL_CONTEXT_VALUE_LABELS[value] || value}`)
        .join('\n');
};

type StructureCriteriaAttachment = {
    optionKey: keyof Pick<
        AiAnalysisOptions,
        'basicStructureCriteria' | 'headingsSequenceCriteria' | 'interactionCtaCriteria' | 'conclusionCriteria'
    >;
    labelKey: 'basicStructure' | 'headingsSequence' | 'interactionCta' | 'conclusion';
    ruleKeys: (keyof StructureAnalysis)[];
};

const STRUCTURE_CRITERIA_ATTACHMENTS: StructureCriteriaAttachment[] = [
    {
        optionKey: 'basicStructureCriteria',
        labelKey: 'basicStructure',
        ruleKeys: [
            'wordCount',
            'summaryParagraph',
            'secondParagraph',
            'paragraphLength',
            'sentenceLength',
            'tableListOpportunities',
            'stepsIntroduction',
            'keywordStuffing',
            'automaticLists',
        ],
    },
    {
        optionKey: 'headingsSequenceCriteria',
        labelKey: 'headingsSequence',
        ruleKeys: [
            'h2Structure',
            'h2Count',
            'h3Structure',
            'h4Structure',
            'betweenH2H3',
            'faqSection',
            'answerParagraph',
            'ambiguousHeadings',
            'headingLength',
        ],
    },
    {
        optionKey: 'interactionCtaCriteria',
        labelKey: 'interactionCta',
        ruleKeys: [
            'ctaWords',
            'interactiveLanguage',
            'warningWords',
            'differentTransitionalWords',
            'slowWords',
        ],
    },
    {
        optionKey: 'conclusionCriteria',
        labelKey: 'conclusion',
        ruleKeys: [
            'lastH2IsConclusion',
            'conclusionParagraph',
            'conclusionWordCount',
            'conclusionHasNumber',
            'conclusionHasList',
        ],
    },
];

const formatStructureCriteriaRules = (sectionTitle: string, rules: CheckResult[]): string => {
    const formattedRules = rules
        .filter(Boolean)
        .map((rule) => {
            const violationExamples = rule.violatingItems
                ?.slice(0, 3)
                .map(item => item.message)
                .filter(Boolean)
                .join(' | ');

            return [
                `### ${rule.title}`,
                `- الحالة الحالية: ${rule.status}`,
                `- القيمة الحالية: ${rule.current}`,
                `- المطلوب: ${rule.required}`,
                rule.description ? `- القاعدة: ${rule.description}` : '',
                rule.details ? `- الشروط والتفاصيل:\n${rule.details}` : '',
                violationExamples ? `- أمثلة من المخالفات الحالية: ${violationExamples}` : '',
            ].filter(Boolean).join('\n');
        })
        .join('\n\n');

    return `**${sectionTitle} وشروطها وقواعدها:**\n${formattedRules || '- لا توجد معايير متاحة لهذه المجموعة.'}`;
};

const getGeminiErrorMessage = (error: unknown): string => {
    const rawMessage = error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'خطأ غير معروف';

    const jsonStart = rawMessage.indexOf('{');
    if (jsonStart !== -1) {
        try {
            const parsed = JSON.parse(rawMessage.slice(jsonStart));
            const apiError = parsed?.error;
            if (apiError?.code === 429 || apiError?.status === 'RESOURCE_EXHAUSTED') {
                return `تم تجاوز حصة Gemini أو لا توجد حصة متاحة للنموذج الحالي (${GEMINI_MODEL}). انتظر قليلا ثم أعد المحاولة، أو استخدم مفتاحا من مشروع Google مختلف لديه حصة متاحة.`;
            }
            if (typeof apiError?.message === 'string') {
                return apiError.message;
            }
        } catch {
            // Keep the original message if Google did not return JSON.
        }
    }

    if (/429|quota|RESOURCE_EXHAUSTED/i.test(rawMessage)) {
        return `تم تجاوز حصة Gemini أو لا توجد حصة متاحة للنموذج الحالي (${GEMINI_MODEL}). انتظر قليلا ثم أعد المحاولة، أو استخدم مفتاحا من مشروع Google مختلف لديه حصة متاحة.`;
    }

    return rawMessage;
};

const normalizeGeminiKeys = (keys?: string | string[]): string[] => {
    const keyList = Array.isArray(keys) ? keys : keys ? [keys] : [];
    return keyList.map(key => key.trim()).filter(Boolean);
};

const callGeminiAnalysis = async (prompt: string, userKeys?: string | string[]): Promise<string> => {
    const trimmedUserKeys = normalizeGeminiKeys(userKeys);

    if (trimmedUserKeys.length > 0) {
        const errors: string[] = [];

        for (const [index, apiKey] of trimmedUserKeys.entries()) {
            try {
                const ai = new GoogleGenAI({ apiKey });
                const response = await ai.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: prompt,
                });
                return typeof response.text === 'string' ? response.text : '';
            } catch (error) {
                console.error(`Gemini API key #${index + 1} failed:`, error);
                errors.push(getGeminiErrorMessage(error));
            }
        }

        const lastError = errors[errors.length - 1] || 'فشلت كل مفاتيح Gemini.';
        const prefix = trimmedUserKeys.length > 1
            ? `فشلت كل مفاتيح Gemini (${trimmedUserKeys.length}). آخر خطأ: `
            : '';
        return `حدث خطأ أثناء الاتصال بـ Gemini: ${prefix}${lastError}`;
    }

    try {
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
      const errorMessage = getGeminiErrorMessage(error);
      return `حدث خطأ أثناء الاتصال بـ Gemini: ${errorMessage}`;
    }
};

const normalizeChatGptKeys = (keys?: string | string[]): string[] => {
    const keyList = Array.isArray(keys) ? keys : keys ? [keys] : [];
    return keyList.map(key => key.trim()).filter(Boolean);
};

const callChatGptAnalysis = async (prompt: string, userKeys?: string | string[]): Promise<string> => {
    const trimmedUserKeys = normalizeChatGptKeys(userKeys);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), CHATGPT_TIMEOUT_MS);

    try {
        const response = await fetch('/api/chatgpt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                model: OPENAI_MODEL,
                apiKeys: trimmedUserKeys.length > 0 ? trimmedUserKeys : undefined,
            }),
            signal: controller.signal,
        });

        window.clearTimeout(timeoutId);

        const isJson = response.headers.get('content-type')?.includes('application/json');
        const data = isJson ? await response.json().catch(() => ({})) : {};

        if (response.status === 404) {
            throw new Error('مسار ChatGPT API غير مفعّل محليًا. أعد تشغيل خادم التطوير حتى يقرأ إعدادات Vite الجديدة.');
        }

        if (!response.ok) {
            throw new Error(data.error?.message || data.error || `ChatGPT request failed with status ${response.status}`);
        }

        if (typeof data.text !== 'string') {
            throw new Error('ChatGPT server route did not return a valid text response.');
        }

        return data.text;
    } catch (error) {
        window.clearTimeout(timeoutId);
        console.error("Error calling ChatGPT API:", error);
        if (error instanceof Error && error.name === 'AbortError') {
            return "انتهت مهلة الاتصال بـ ChatGPT (180 ثانية). إذا لم يظهر طلب في لوحة OpenAI فهذا يعني أن الخادم المحلي لم يصل إلى OpenAI.";
        }
        const message = error instanceof Error ? error.message : 'خطأ غير معروف';
        return `حدث خطأ أثناء الاتصال بـ ChatGPT: ${message}`;
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
    aiResults: { gemini: string; chatgpt: string };
    isAiLoading: { gemini: boolean; chatgpt: boolean };
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
    handleChatGptAnalyze: (userPrompt: string, options: any) => Promise<void>;
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
    const { t, uiLanguage, apiKeys, engineeringPrompts } = useUser();
    const { editor, title, text, keywords, analysisResults, goalContext, articleLanguage, articleKey } = useEditor();
    const { openModal } = useModal();
    
    const [aiResults, setAiResults] = useState({ gemini: '', chatgpt: '' });
    const [isAiLoading, setIsAiLoading] = useState({ gemini: false, chatgpt: false });
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
        if (title.trim()) contextParts.push(`**عنوان المقال الحالي:** ${title.trim()}`);
        contextParts.push(`**لغة المقال:** ${articleLanguage === 'ar' ? 'العربية' : 'الإنجليزية'}`);
        const keywordContext = [
            `- الأساسية: ${keywords.primary || 'لم تحدد'}`,
            `- المرادفة: ${keywords.secondaries.filter(Boolean).join(', ') || 'لم تحدد'}`,
            `- العلامة التجارية: ${keywords.company || 'لم تحدد'}`,
            `- LSI: ${keywords.lsi.filter(Boolean).join(', ') || 'لم تحدد'}`,
        ].join('\n');
        contextParts.push(`**الكلمات والعلامة المستهدفة:**\n${keywordContext}`);
        const goalContextText = formatGoalContext(goalContext);
        if (goalContextText) contextParts.push(`**سياق هدف الصفحة والجمهور:**\n${goalContextText}`);
        if (sectionHeading) contextParts.push(`**سياق العنوان:** "${sectionHeading}"`);
        const tocString = generateToc(editor);
        if (tocString) contextParts.push(`**هيكل المقال:**\n${tocString}`);
        return `${professionalRoleAndGoal}\n\n${contextParts.join('\n\n')}\n\n**المطلوب:**\n${basePrompt}`;
    };

    const generateContextAwarePrompt = useCallback((userPrompt: string, options: any) => {
        const {
            manualCommand,
            editorText,
            targetKeywords,
            companyName,
            goalContext: includeGoalContext,
            keywordCriteria,
        } = options;
        let parts: string[] = [];
        const pageObjective = GOAL_CONTEXT_VALUE_LABELS[goalContext.objective] || goalContext.objective || 'لم يحدد';
        parts.push(includeGoalContext
            ? `أنت خبير SEO وكاتب محتوى محترف. هدف الصفحة هو "${pageObjective}".`
            : 'أنت خبير SEO وكاتب محتوى محترف.'
        );
        if (title.trim()) {
            parts.push(`**عنوان المقال الحالي:** ${title.trim()}`);
        }
        parts.push(`**لغة المقال:** ${articleLanguage === 'ar' ? 'العربية' : 'الإنجليزية'}`);
        const goalContextText = formatGoalContext(goalContext);
        if (includeGoalContext && goalContextText) {
            parts.push(`**سياق هدف الصفحة والجمهور لاستخدامه في التقييم والتحليل:**\n${goalContextText}`);
        }
        if (targetKeywords) {
            parts.push(`**الكلمات المستهدفة:** الأساسية: ${keywords.primary || 'لم تحدد'}، المرادفات: ${keywords.secondaries.filter(Boolean).join(', ') || 'لم تحدد'}، LSI: ${keywords.lsi.filter(Boolean).join(', ') || 'لم تحدد'}`);
        }
        if (companyName) {
            parts.push(`**اسم الشركة / العلامة التجارية:** ${keywords.company || 'لم تحدد'}`);
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
            parts.push(`**نص المقال الحالي من المحرر:**\n---\n${text}\n---`);
        }
        STRUCTURE_CRITERIA_ATTACHMENTS.forEach((attachment) => {
            if (!options[attachment.optionKey]) return;

            const sectionTitle = t.structureTab[attachment.labelKey];
            const rules = attachment.ruleKeys
                .map(ruleKey => analysisResults.structureAnalysis[ruleKey])
                .filter(Boolean) as CheckResult[];

            parts.push(formatStructureCriteriaRules(sectionTitle, rules));
        });

        if (manualCommand && userPrompt.trim()) {
            parts.push(`**الأمر المطلوب:**\n${userPrompt}`);
        } else if (userPrompt.trim()) {
             parts.push(userPrompt);
        }
        return parts.join('\n\n');
    }, [title, keywords, text, goalContext, articleLanguage, analysisResults, t]);
    
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

    const handleChatGptAnalyze = useCallback(async (userPrompt: string, options: any) => {
        if (!editor) return;
        setIsAiLoading(prev => ({ ...prev, chatgpt: true }));
        setAiResults(prev => ({ ...prev, chatgpt: '' }));
        try {
            const finalPrompt = generateContextAwarePrompt(userPrompt, options);
            const result = await callChatGptAnalysis(finalPrompt, apiKeys.chatgpt);
            setAiResults(prev => ({ ...prev, chatgpt: result }));
        } catch (e) {
            setAiResults(prev => ({ ...prev, chatgpt: "فشل تحليل ChatGPT." }));
        } finally {
            setIsAiLoading(prev => ({ ...prev, chatgpt: false }));
        }
    }, [generateContextAwarePrompt, apiKeys.chatgpt, editor]);
    
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
            const prompt = renderEngineeringPrompt(promptTemplate, {
                selectedText: textToProcess,
                fullArticleText: textToProcess,
            });
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
            const promptTemplate = getEngineeringPrompt(engineeringPrompts, ENGINEERING_PROMPT_IDS.toolbar.suggestHeadings);
            const prompt = `${buildComprehensivePrompt(promptTemplate)}\n\n${headingsText}\n\nأرجع مصفوفة JSON حصراً: [ { "original": "...", "level": 2, "flaws": [], "suggestions": [] } ]`;
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
    }, [editor, buildComprehensivePrompt, apiKeys.gemini, engineeringPrompts]);

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
        handleChatGptAnalyze, handleAiFix, handleFixAllViolations, applySuggestionFromHistory,
        markHistorySuggestionApplied,
        removeFromAiHistory: (id: string) => setAiHistory(h => h.filter(x => x.id !== id)),
        generateContextAwarePrompt, openGoogleSearch
    };

    return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
};
