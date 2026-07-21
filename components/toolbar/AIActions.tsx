import React, { useState, useRef, useEffect } from 'react';
import { BadgeDollarSign, BrainCircuit, Loader2, Sparkles, PenLine, Wand2, Zap, Expand, BookText, HelpCircle, List, ListChecks, Table, Milestone, FileSignature, Tag, TestTube, ChevronRight, ClipboardCheck, Heading1, Combine } from 'lucide-react';
import { translations } from '../translations';
import { ToolbarButton } from './ToolbarItems';
import { useUser } from '../../contexts/UserContext';
import { useAISelector } from '../../contexts/AIContext';
import { AI_PROMPTS } from '../../constants/aiPrompts';
import { DEFAULT_ENGINEERING_PROMPTS, ENGINEERING_PROMPT_IDS, getEngineeringPrompt, renderEngineeringPrompt } from '../../constants/engineeringPrompts';
import GeminiProgressStatus from '../GeminiProgressStatus';

interface AIActionsProps {
    hasSelection: boolean;
    isAnyGeminiLoading: boolean;
    uiLanguage: 'ar' | 'en';
    t: typeof translations.ar;
    onAiRequest: (promptTemplate: string, action: 'replace-text' | 'replace-title' | 'copy-meta') => Promise<void>;
    onAnalyzeHeadings: () => Promise<void>;
}

const AiMenuItem: React.FC<{ onClick: () => void; disabled: boolean; children: React.ReactNode; onMouseEnter?: () => void; onMouseLeave?: () => void; }> = ({ onClick, disabled, children, onMouseEnter, onMouseLeave }) => (
    <button
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        className="w-full text-start flex items-center gap-3 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20 disabled:opacity-50 disabled:cursor-not-allowed"
    >
        {children}
    </button>
);

const AIActions: React.FC<AIActionsProps> = ({ hasSelection, isAnyGeminiLoading, uiLanguage, t, onAiRequest, onAnalyzeHeadings }) => {
    const { engineeringPrompts, isAiProviderEnabled, isAiProviderAvailable } = useUser();
    const quickAiProvider = useAISelector(context => context.quickAiProvider);
    const setQuickAiProvider = useAISelector(context => context.setQuickAiProvider);
    const aiRequestProgress = useAISelector(context => context.aiRequestProgress);
    const cancelAiRequest = useAISelector(context => context.cancelAiRequest);
    const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
    const [isToneMenuOpen, setIsToneMenuOpen] = useState(false);
    const [isExpandMenuOpen, setIsExpandMenuOpen] = useState(false);
    const [isSummarizeMenuOpen, setIsSummarizeMenuOpen] = useState(false);
    const aiMenuRef = useRef<HTMLDivElement>(null);

    const TONES = [t.tones.professional, t.tones.friendly, t.tones.persuasive, t.tones.simple];
    const isChatGptQuickProvider = quickAiProvider === 'chatgpt';
    const isOpenAiEnabled = isAiProviderEnabled('chatgpt');
    const isOpenAiAvailable = isAiProviderAvailable('chatgpt');
    const isGeminiPaidQuickProvider = quickAiProvider === 'geminiPaid';
    const chatGptToggleTitle = !isOpenAiAvailable
        ? (uiLanguage === 'ar' ? 'OpenAI مفعّل دون مفتاح API مهيأ' : 'OpenAI is enabled without a configured API key')
        : (uiLanguage === 'ar' ? 'ChatGPT للأوامر السريعة' : 'ChatGPT for quick commands');
    const geminiPaidToggleTitle = uiLanguage === 'ar' ? 'Gemini Pro للأوامر السريعة' : 'Gemini Pro for quick commands';
    const toggleChatGptProvider = () => {
        setQuickAiProvider(provider => provider === 'chatgpt' ? 'gemini' : 'chatgpt');
    };
    const toggleGeminiPaidProvider = () => {
        setQuickAiProvider(provider => provider === 'geminiPaid' ? 'gemini' : 'geminiPaid');
    };
    const getPrompt = (id: string, variables: Record<string, string> = {}) => {
        const template = getEngineeringPrompt(engineeringPrompts, id);
        if (
            id === ENGINEERING_PROMPT_IDS.toolbar.changeTone &&
            variables.tone &&
            template.trim() === DEFAULT_ENGINEERING_PROMPTS[ENGINEERING_PROMPT_IDS.toolbar.changeTone].trim()
        ) {
            return AI_PROMPTS.CHANGE_TONE(variables.tone);
        }

        return renderEngineeringPrompt(template, variables);
    };

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (aiMenuRef.current && !aiMenuRef.current.contains(event.target as Node)) {
                setIsAiMenuOpen(false);
                setIsToneMenuOpen(false);
                setIsExpandMenuOpen(false);
                setIsSummarizeMenuOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [aiMenuRef]);

    const handleAiRequest = async (
        promptTemplate: string,
        action: 'replace-text' | 'replace-title' | 'copy-meta'
    ) => {
        setIsAiMenuOpen(false);
        setIsToneMenuOpen(false);
        setIsExpandMenuOpen(false);
        setIsSummarizeMenuOpen(false);
        await onAiRequest(promptTemplate, action);
    };

    const handleAnalyzeHeadings = async () => {
        setIsAiMenuOpen(false);
        await onAnalyzeHeadings();
    };

    return (
        <div className="relative flex items-center gap-1" ref={aiMenuRef}>
            <ToolbarButton
                onClick={() => setIsAiMenuOpen(!isAiMenuOpen)}
                title={t.aiCommands}
                isActive={isAiMenuOpen}
                disabled={isAnyGeminiLoading}
            >
                {isAnyGeminiLoading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            </ToolbarButton>
            {isOpenAiEnabled && (
                <ToolbarButton
                    onClick={toggleChatGptProvider}
                    title={chatGptToggleTitle}
                    isActive={isChatGptQuickProvider}
                    disabled={isAnyGeminiLoading || !isOpenAiAvailable}
                >
                    <BrainCircuit size={16} />
                </ToolbarButton>
            )}
            <ToolbarButton
                onClick={toggleGeminiPaidProvider}
                title={geminiPaidToggleTitle}
                isActive={isGeminiPaidQuickProvider}
                disabled={isAnyGeminiLoading}
            >
                <BadgeDollarSign size={16} />
            </ToolbarButton>
            {isAnyGeminiLoading && aiRequestProgress?.source === 'heading_analysis' && (
                <div className="absolute top-full z-[1000] mt-1 w-72 max-w-[calc(100vw-2rem)]">
                    <GeminiProgressStatus progress={aiRequestProgress} isArabic={uiLanguage === 'ar'} compact onCancel={cancelAiRequest} />
                </div>
            )}
            {isAiMenuOpen && (
                <div className={`absolute mt-2 max-h-[calc(100vh-5rem)] w-60 origin-top-left overflow-y-auto rounded-md bg-white dark:bg-[#2A2A2A] shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none py-1 z-[10000] ${uiLanguage === 'ar' ? 'left-0' : 'right-0'}`}>
                    <AiMenuItem onClick={handleAnalyzeHeadings} disabled={isAnyGeminiLoading}><FileSignature size={14} /> <span>{t.aiMenu.suggestHeadings}</span></AiMenuItem>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.generateMeta), 'copy-meta')} disabled={!hasSelection || isAnyGeminiLoading}><Tag size={14} /> <span>{t.aiMenu.generateMeta}</span></AiMenuItem>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.suggestTitle), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><Heading1 size={14} /> <span>{t.aiMenu.suggestTitle}</span></AiMenuItem>
                    <div className="my-1 h-px bg-gray-200 dark:bg-[#3C3C3C]"></div>

                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.rephrase), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><PenLine size={14} /> <span>{t.aiMenu.rephrase}</span></AiMenuItem>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.improveWording), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><Wand2 size={14} /> <span>{t.aiMenu.improveWording}</span></AiMenuItem>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.simplifyText), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><Zap size={14} /> <span>{t.aiMenu.simplify}</span></AiMenuItem>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.merge), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><Combine size={14} /> <span>{t.aiMenu.merge}</span></AiMenuItem>
                    
                    <div className="relative" onMouseEnter={() => setIsExpandMenuOpen(true)} onMouseLeave={() => setIsExpandMenuOpen(false)}>
                        <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.expand), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}>
                            <Expand size={14} />
                            <span>{t.aiMenu.expand}</span>
                            <ChevronRight size={14} className="ms-auto" />
                        </AiMenuItem>
                        {isExpandMenuOpen && (
                            <div className={`absolute top-0 z-[10001] ms-1 w-48 origin-top-left rounded-md bg-white dark:bg-[#2A2A2A] shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none py-1 ${uiLanguage === 'ar' ? 'left-full' : 'right-full'}`}>
                                <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.expand50), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><span>{t.aiMenu.expand50}</span></AiMenuItem>
                                <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.expand100), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><span>{t.aiMenu.expand100}</span></AiMenuItem>
                            </div>
                        )}
                    </div>
                    
                    <div className="relative" onMouseEnter={() => setIsSummarizeMenuOpen(true)} onMouseLeave={() => setIsSummarizeMenuOpen(false)}>
                        <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.summarize), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}>
                            <BookText size={14} />
                            <span>{t.aiMenu.summarize}</span>
                            <ChevronRight size={14} className="ms-auto" />
                        </AiMenuItem>
                        {isSummarizeMenuOpen && (
                            <div className={`absolute top-0 z-[10001] ms-1 w-48 origin-top-left rounded-md bg-white dark:bg-[#2A2A2A] shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none py-1 ${uiLanguage === 'ar' ? 'left-full' : 'right-full'}`}>
                                <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.summarize50), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><span>{t.aiMenu.summarize50}</span></AiMenuItem>
                                <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.summarize100), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><span>{t.aiMenu.summarize100}</span></AiMenuItem>
                            </div>
                        )}
                    </div>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.findStats), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><TestTube size={14} /> <span>{t.aiMenu.findStats}</span></AiMenuItem>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.evaluateSection), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><ClipboardCheck size={14} /> <span>{t.aiMenu.evaluateSection}</span></AiMenuItem>

                    <div className="my-1 h-px bg-gray-200 dark:bg-[#3C3C3C]"></div>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.toQa), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><HelpCircle size={14} /> <span>{t.aiMenu.toQA}</span></AiMenuItem>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.toBullets), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><List size={14} /> <span>{t.aiMenu.toBullets}</span></AiMenuItem>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.toSteps), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><ListChecks size={14} /> <span>{t.aiMenu.toSteps}</span></AiMenuItem>
                    <AiMenuItem onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.toTable), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}><Table size={14} /> <span>{t.aiMenu.toTable}</span></AiMenuItem>
                    <div className="my-1 h-px bg-gray-200 dark:bg-[#3C3C3C]"></div>
                    <div className="relative" onMouseEnter={() => setIsToneMenuOpen(true)} onMouseLeave={() => setIsToneMenuOpen(false)}>
                        <AiMenuItem onClick={() => {}} disabled={!hasSelection || isAnyGeminiLoading}>
                            <Milestone size={14} />
                            <span>{t.aiMenu.changeTone}</span>
                            <ChevronRight size={14} className="ms-auto" />
                        </AiMenuItem>
                        {isToneMenuOpen && (
                            <div className={`absolute top-0 z-[10001] ms-1 w-40 origin-top-left rounded-md bg-white dark:bg-[#2A2A2A] shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none py-1 ${uiLanguage === 'ar' ? 'left-full' : 'right-full'}`}>
                                {TONES.map(tone => (
                                    <AiMenuItem key={tone} onClick={() => handleAiRequest(getPrompt(ENGINEERING_PROMPT_IDS.toolbar.changeTone, { tone }), 'replace-text')} disabled={!hasSelection || isAnyGeminiLoading}>
                                        <span>{tone}</span>
                                    </AiMenuItem>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default AIActions;
