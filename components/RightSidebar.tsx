
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { LayoutTemplate, Sparkles, ChevronDown, BrainCircuit, Wand2, FileSearch, ShieldAlert, Lightbulb, Users, Command, FilePlus2, LocateFixed, CheckCircle2, AlertTriangle } from 'lucide-react';
import StructureTab from './StructureTab';
import AIHistoryTab from './AIHistoryTab';
import { useUser } from '../contexts/UserContext';
import { useAI } from '../contexts/AIContext';
import { parseMarkdownToHtml } from '../utils/editorUtils';
import type { AiAnalysisOptions, AiPatchProvider } from '../types';
import { DEFAULT_SMART_ANALYSIS_OPTIONS, ENGINEERING_PROMPT_DEFINITIONS, getEngineeringPrompt } from '../constants/engineeringPrompts';

type ReadyCommand = {
    id: string;
    label: string;
    value: string;
    options?: Partial<AiAnalysisOptions>;
};

const RightSidebar: React.FC = () => {
    const { t, engineeringPrompts } = useUser();
    const {
        handleAiAnalyze,
        handleChatGptAnalyze,
        aiResults,
        aiInsertionPatches,
        isAiLoading,
        applyAiInsertionPatch,
        applyAllAiInsertionPatches,
        selectAiInsertionPatchTarget,
    } = useAI();
    
    const [activeTab, setActiveTab] = useState<'structure' | 'ai'>('structure');
    const [aiSubTab, setAiSubTab] = useState<'new' | 'history'>('new');
    const [aiCommand, setAiCommand] = useState('');
    const [selectedReadyCommandId, setSelectedReadyCommandId] = useState('');
    const [isGeminiExpanded, setIsGeminiExpanded] = useState(true);
    const [isChatGptExpanded, setIsChatGptExpanded] = useState(true);
    
    // Custom Dropdown State
    const [isCommandsMenuOpen, setIsCommandsMenuOpen] = useState(false);
    const commandsMenuRef = useRef<HTMLDivElement>(null);

    const [aiOptions, setAiOptions] = useState<AiAnalysisOptions>(() => ({ ...DEFAULT_SMART_ANALYSIS_OPTIONS }));

    const tRs = t.rightSidebar;

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (commandsMenuRef.current && !commandsMenuRef.current.contains(event.target as Node)) {
                setIsCommandsMenuOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    const readyCommands: ReadyCommand[] = useMemo(() => {
        return ENGINEERING_PROMPT_DEFINITIONS
            .filter(definition => definition.source === 'smartAnalysis')
            .map(definition => ({
                id: definition.id,
                label: (tRs as any)[definition.labelKey] || definition.labelKey,
                value: getEngineeringPrompt(engineeringPrompts, definition.id),
                options: definition.options,
            }));
    }, [engineeringPrompts, tRs]);

    useEffect(() => {
        if (!selectedReadyCommandId) return;
        const selectedCommand = readyCommands.find(command => command.id === selectedReadyCommandId);
        if (selectedCommand) {
            setAiCommand(selectedCommand.value);
        }
    }, [readyCommands, selectedReadyCommandId]);

    const getCommandIcon = (index: number) => {
        switch (index) {
            case 1: return <BrainCircuit size={16} className="text-[#d4af37]" />;
            case 2: return <FileSearch size={16} className="text-[#d4af37]" />;
            case 3: return <ShieldAlert size={16} className="text-[#d4af37]" />;
            case 4: return <Lightbulb size={16} className="text-[#d4af37]" />;
            case 5: return <Users size={16} className="text-[#d4af37]" />;
            default: return <Command size={16} className="text-gray-400" />;
        }
    };

    const handleCommandSelect = (command: ReadyCommand) => {
        setSelectedReadyCommandId(command.id);
        if (command.value) setAiCommand(command.value);
        setAiOptions({ ...DEFAULT_SMART_ANALYSIS_OPTIONS, ...(command.options || {}) });
        setIsCommandsMenuOpen(false);
    };

    const handleOptionChange = (key: keyof typeof aiOptions) => {
        setAiOptions(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const renderPatchActions = (provider: AiPatchProvider) => {
        const patches = aiInsertionPatches[provider];
        if (!patches.length) return null;

        const pendingCount = patches.filter(patch => patch.status === 'pending').length;

        return (
            <div className="mt-3 border-t border-[#d4af37]/20 dark:border-[#d4af37]/25 pt-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">
                        <FilePlus2 size={14} />
                        <span>تعديلات قابلة للتطبيق ({patches.length})</span>
                    </div>
                    <button
                        type="button"
                        onClick={() => applyAllAiInsertionPatches(provider)}
                        disabled={pendingCount === 0}
                        className="px-2 py-1 rounded-md text-xs font-bold bg-[#d4af37] text-white hover:bg-[#b8922e] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        تطبيق الكل
                    </button>
                </div>

                <div className="space-y-2">
                    {patches.map((patch) => (
                        <div key={patch.id} className="border border-[#d4af37]/20 dark:border-[#d4af37]/25 rounded-md bg-white/70 dark:bg-[#1F1F1F]/70 p-2">
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="text-xs font-bold text-[#333333] dark:text-gray-100 line-clamp-2">{patch.title}</div>
                                    {(patch.placementLabel || patch.anchorText) && (
                                        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                                            {patch.placementLabel || patch.anchorText}
                                        </div>
                                    )}
                                </div>
                                {patch.status === 'applied' && (
                                    <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                                        <CheckCircle2 size={13} />
                                        تم
                                    </span>
                                )}
                                {patch.status === 'failed' && (
                                    <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-red-600 dark:text-red-400">
                                        <AlertTriangle size={13} />
                                        تعذر
                                    </span>
                                )}
                            </div>

                            <div className="mt-2 text-xs text-gray-700 dark:text-gray-300 ai-output line-clamp-3" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(patch.contentMarkdown) }} />

                            {patch.reason && (
                                <div className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2">{patch.reason}</div>
                            )}

                            {patch.applyError && (
                                <div className="mt-1.5 text-[11px] font-semibold text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1">{patch.applyError}</div>
                            )}

                            <div className="mt-2 flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => selectAiInsertionPatchTarget(provider, patch.id)}
                                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-gray-100 dark:bg-[#2A2A2A] text-gray-700 dark:text-gray-200 hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20"
                                >
                                    <LocateFixed size={13} />
                                    الموضع
                                </button>
                                <button
                                    type="button"
                                    onClick={() => applyAiInsertionPatch(provider, patch.id)}
                                    disabled={patch.status !== 'pending'}
                                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold bg-[#d4af37] text-white hover:bg-[#b8922e] disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <FilePlus2 size={13} />
                                    تطبيق
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    const renderAiTab = () => (
        <div className="flex flex-col h-full">
            <div className="flex p-2 mx-2 mt-2 mb-1 bg-gray-200 dark:bg-[#2A2A2A] rounded-lg">
                <button onClick={() => setAiSubTab('new')} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${aiSubTab === 'new' ? 'bg-white dark:bg-[#1F1F1F] text-[#d4af37] shadow-sm' : 'text-gray-500'}`}>{tRs.newAnalysis}</button>
                <button onClick={() => setAiSubTab('history')} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${aiSubTab === 'history' ? 'bg-white dark:bg-[#1F1F1F] text-[#d4af37] shadow-sm' : 'text-gray-500'}`}>{t.aiHistory.title}</button>
            </div>

            <div className="flex-grow overflow-y-auto custom-scrollbar p-4 space-y-4">
                {aiSubTab === 'new' ? (
                    <>
                        <div ref={commandsMenuRef} className="relative">
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{tRs.readyCommands}</label>
                            <button
                                type="button"
                                onClick={() => setIsCommandsMenuOpen(!isCommandsMenuOpen)}
                                className="w-full flex items-center justify-between p-2.5 bg-white dark:bg-[#1F1F1F] border border-gray-300 dark:border-[#3C3C3C] rounded-lg text-sm text-start focus:outline-none focus:ring-1 focus:ring-[#d4af37] shadow-sm transition-all"
                            >
                                <span className="truncate text-gray-700 dark:text-gray-200 font-medium flex items-center gap-2">
                                    {selectedReadyCommandId ? (
                                        (() => {
                                            const cmdIndex = readyCommands.findIndex(c => c.id === selectedReadyCommandId);
                                            const cmd = readyCommands[cmdIndex];
                                            return (
                                                <>
                                                    {cmdIndex >= 0 && getCommandIcon(cmdIndex + 1)}
                                                    <span>{cmd ? cmd.label : tRs.selectCommand}</span>
                                                </>
                                            );
                                        })()
                                    ) : (
                                        <span className="text-gray-500">{tRs.selectCommand}</span>
                                    )}
                                </span>
                                <ChevronDown size={16} className={`transition-transform duration-200 text-gray-500 ${isCommandsMenuOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {isCommandsMenuOpen && (
                                <div className="absolute z-20 mt-2 w-full bg-white dark:bg-[#2A2A2A] border border-gray-200 dark:border-[#3C3C3C] rounded-lg shadow-xl max-h-60 overflow-y-auto custom-scrollbar ring-1 ring-black ring-opacity-5">
                                    {readyCommands.map((cmd, idx) => (
                                        <button
                                            key={cmd.id}
                                            onClick={() => handleCommandSelect(cmd)}
                                            className="w-full text-start px-3 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20 transition-colors flex items-center gap-3 border-b border-gray-50 dark:border-[#333] last:border-0"
                                        >
                                            {getCommandIcon(idx + 1)}
                                            <span>{cmd.label}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{tRs.aiCommand}</label>
                            <textarea value={aiCommand} onChange={(e) => setAiCommand(e.target.value)} rows={4} className="w-full p-2 bg-white dark:bg-[#1F1F1F] border border-gray-300 dark:border-[#3C3C3C] rounded-md text-sm resize-none text-[#333333] dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37]" placeholder={tRs.aiPlaceholder} />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            {Object.keys(aiOptions).map((opt) => (
                                <label key={opt} className="flex items-center gap-2 text-xs cursor-pointer text-gray-600 dark:text-gray-400">
                                    <input type="checkbox" checked={(aiOptions as any)[opt]} onChange={() => handleOptionChange(opt as any)} className="rounded text-[#d4af37]" />
                                    {(tRs as any)[opt] || opt}
                                </label>
                            ))}
                        </div>

                        <div className="flex flex-col gap-2">
                            <div className="flex gap-2">
                                <button onClick={() => handleAiAnalyze(aiCommand, aiOptions)} disabled={isAiLoading.gemini} className="flex-1 flex items-center justify-center gap-2 py-2 bg-[#d4af37] text-white rounded-lg hover:bg-[#b8922e] disabled:opacity-50">
                                    {isAiLoading.gemini ? <Wand2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                    <span className="text-xs font-bold">Gemini</span>
                                </button>
                                <button onClick={() => handleChatGptAnalyze(aiCommand, aiOptions)} disabled={isAiLoading.chatgpt} className="flex-1 flex items-center justify-center gap-2 py-2 bg-[#d4af37] text-white rounded-lg hover:bg-[#b8922e] disabled:opacity-50">
                                    {isAiLoading.chatgpt ? <Wand2 size={16} className="animate-spin" /> : <BrainCircuit size={16} />}
                                    <span className="text-xs font-bold">ChatGPT</span>
                                </button>
                            </div>
                        </div>

                        <div className="space-y-3 pt-4 border-t border-gray-200 dark:border-[#3C3C3C]">
                            {/* Results Gemini */}
                            <div className="bg-[#d4af37]/10 dark:bg-[#d4af37]/10 rounded-lg overflow-hidden border border-[#d4af37]/20 dark:border-[#d4af37]/25">
                                <div className="p-2 bg-[#d4af37]/15 dark:bg-[#d4af37]/20 flex justify-between cursor-pointer" onClick={() => setIsGeminiExpanded(!isGeminiExpanded)}>
                                    <span className="text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">نتائج Gemini</span>
                                    <ChevronDown size={14} className={isGeminiExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isGeminiExpanded && (
                                    <div className="p-3 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {isAiLoading.gemini ? <div className="flex gap-2 animate-pulse text-[#d4af37]"><Wand2 size={14} /> جاري التفكير...</div> :
                                         aiResults.gemini ? <div dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(aiResults.gemini) }} /> : <span className="text-gray-400 italic">لا توجد نتائج.</span>}
                                        {renderPatchActions('gemini')}
                                    </div>
                                )}
                            </div>
                            {/* Results ChatGPT */}
                            <div className="bg-[#d4af37]/10 dark:bg-[#d4af37]/10 rounded-lg overflow-hidden border border-[#d4af37]/20 dark:border-[#d4af37]/25">
                                <div className="p-2 bg-[#d4af37]/15 dark:bg-[#d4af37]/20 flex justify-between cursor-pointer" onClick={() => setIsChatGptExpanded(!isChatGptExpanded)}>
                                    <span className="text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">نتائج ChatGPT</span>
                                    <ChevronDown size={14} className={isChatGptExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isChatGptExpanded && (
                                    <div className="p-3 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {isAiLoading.chatgpt ? <div className="flex gap-2 animate-pulse text-[#d4af37]"><Wand2 size={14} /> جاري الاتصال بـ ChatGPT...</div> :
                                         aiResults.chatgpt ? <div dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(aiResults.chatgpt) }} /> : <span className="text-gray-400 italic">لا توجد نتائج.</span>}
                                        {renderPatchActions('chatgpt')}
                                    </div>
                                )}
                            </div>
                        </div>
                    </>
                ) : <AIHistoryTab />}
            </div>
        </div>
    );

    return (
        <aside className="basis-[18.7%] flex flex-col h-full min-w-0 bg-[#F2F3F5] dark:bg-[#1F1F1F] rounded-lg shadow-lg overflow-hidden border-s border-gray-300 dark:border-[#333]">
            <div className="flex border-b border-gray-200 dark:border-[#3C3C3C]">
                {(['structure', 'ai'] as const).map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)} className={`flex-1 py-3 flex justify-center items-center transition-colors ${activeTab === tab ? 'text-[#d4af37] border-b-2 border-[#d4af37] bg-white dark:bg-[#2A2A2A]' : 'text-gray-400 hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/15'}`}>
                        {tab === 'structure' ? <LayoutTemplate size={18} /> : <BrainCircuit size={18} />}
                    </button>
                ))}
            </div>
            <div className="flex-grow overflow-y-auto custom-scrollbar">{activeTab === 'structure' ? <StructureTab /> : renderAiTab()}</div>
        </aside>
    );
};

export default RightSidebar;
