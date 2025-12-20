
import React, { useState, useRef, useEffect } from 'react';
import { LayoutTemplate, Target, Sparkles, ChevronDown, ExternalLink, Search, BrainCircuit, Wand2, FileSearch, ShieldAlert, Lightbulb, Users, Command } from 'lucide-react';
import StructureTab from './StructureTab';
import GoalTab from './GoalTab';
import AIHistoryTab from './AIHistoryTab';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useAI } from '../contexts/AIContext';
import { parseMarkdownToHtml } from '../utils/editorUtils';

const RightSidebar: React.FC = () => {
    const { uiLanguage, t } = useUser();
    const { keywords } = useEditor();
    const { handleAiAnalyze, handlePerplexitySearch, aiResults, isAiLoading, generateContextAwarePrompt } = useAI();
    
    const [activeTab, setActiveTab] = useState<'structure' | 'goal' | 'ai'>('structure');
    const [aiSubTab, setAiSubTab] = useState<'new' | 'history'>('new');
    const [aiCommand, setAiCommand] = useState('');
    const [selectedReadyCommand, setSelectedReadyCommand] = useState('');
    const [perplexityModel, setPerplexityModel] = useState<'sonar' | 'sonar-pro'>('sonar');
    const [isGeminiExpanded, setIsGeminiExpanded] = useState(true);
    const [isPerplexityExpanded, setIsPerplexityExpanded] = useState(true);
    
    // Custom Dropdown State
    const [isCommandsMenuOpen, setIsCommandsMenuOpen] = useState(false);
    const commandsMenuRef = useRef<HTMLDivElement>(null);

    const [aiOptions, setAiOptions] = useState({
        manualCommand: true,
        editorText: true,
        targetKeywords: true,
        keywordCriteria: false,
        structureCriteria: false,
        goalCriteria: false,
    });

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

    const readyCommands = [
        { label: tRs.selectCommand, value: '' },
        { 
            label: tRs.analyzeFull, 
            value: `اعتبر نفسك كاتب محتوى محترف وخبير في موضوع وتخصص "${keywords.primary || 'الكلمات المفتاحية الأساسية'}" المرفقة مع هذا الأمر.
أرغب في تحليل محتوى هذا ليكون محسّن لـ SEO التقليدي وميزات الذكاء الاصطناعي (AEO, GEO, LLM SEO).
أرغب في انشاء محتوى يتفوق على المواقع المتصدرة والمنافسة في النتائج الاولى من البحث عبر كتابة محتوى متعدد الأبعاد يخدم: SEO التقليدي + AEO + GEO + LLM SEO وأن يكون المحتوى قابلاً للفهرسة والاستخلاص من Google وميزات AI Overviews/AI Mode للاقتباس والتلخيص بواسطة نماذج اللغة الكبيرة ولإقناع وكلاء الذكاء (AI Agents) والمستخدمين البشر.
قم فقط بالتركيز على نقاط الضعف الموجودة في المحتوى مع اقتراحات محتوى جاهزة مكتوب ومعدل.
لا تقم بذكر اقتراحات حول الصور وبيانات المنظمة والروابط الداخلية، قم بالتركيز على المحتوى فقط.
بناء على ذلك قم بالتحليل بشكل كامل.` 
        },
        { 
            label: tRs.improveWeakest, 
            value: `اعتبر نفسك محرر ومدقق محتوى محترف وخبير في السيو وخبير في "${keywords.primary || 'موضوع الكلمة المفتاحية الأساسية'}"
الهدف: أرغب بتدقيق المحتوى هذا ومعرفة هل هو محسّن لـ SEO التقليدي وميزات الذكاء الاصطناعي (AEO, GEO, LLM SEO) والهدف هو إنتاج محتوى متعدد الأبعاد يخدم: SEO التقليدي + AEO + GEO + LLM SEO وأن يكون المحتوى قابلاً للفهرسة والاستخلاص من Google وميزات AI Overviews/AI Mode للاقتباس والتلخيص بواسطة نماذج اللغة الكبيرة ولإقناع وكلاء الذكاء (AI Agents) والمستخدمين البشر.
قم بالبحث عن أضعف قسم في المقالة متعارض او غير متطابق مع الهدف وقم بتحسينه.
قم بالتركيز على الأمر فقط وقدم إجابة مباشرة دون توضيحات ونصائح.` 
        },
        { 
            label: tRs.suggestNew, 
            value: `اعتبر نفسك محرر ومدقق محتوى محترف وخبير في السيو وخبير في "${keywords.primary || 'موضوع الكلمة المفتاحية الأساسية'}"
الهدف: أرغب بتدقيق المحتوى هذا ومعرفة هل هو محسّن لـ SEO التقليدي وميزات الذكاء الاصطناعي (AEO, GEO, LLM SEO) والهدف هو إنتاج محتوى متعدد الأبعاد يخدم: SEO التقليدي + AEO + GEO + LLM SEO وأن يكون المحتوى قابلاً للفهرسة والاستخلاص من Google وميزات AI Overviews/AI Mode للاقتباس والتلخيص بواسطة نماذج اللغة الكبيرة ولإقناع وكلاء الذكاء (AI Agents) والمستخدمين البشر.
اقترح فقرة فكرة جديدة لم تذكر في المقال وتضيف قيمة عالية.
قم بالتركيز على الأمر فقط وقدم إجابة مباشرة دون توضيحات ونصائح.` 
        },
        { label: tRs.peopleQuestions, value: `استخرج أهم الأسئلة التي يطرحها الناس حول الكلمة المفتاحية.` },
    ];

    const getCommandIcon = (index: number) => {
        switch (index) {
            case 1: return <FileSearch size={16} className="text-blue-500" />;
            case 2: return <ShieldAlert size={16} className="text-amber-500" />;
            case 3: return <Lightbulb size={16} className="text-yellow-500" />;
            case 4: return <Users size={16} className="text-green-500" />;
            default: return <Command size={16} className="text-gray-400" />;
        }
    };

    const handleCommandSelect = (value: string) => {
        setSelectedReadyCommand(value);
        if (value) setAiCommand(value);
        setIsCommandsMenuOpen(false);
    };

    const handleOptionChange = (key: keyof typeof aiOptions) => {
        setAiOptions(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const handleOpenPerplexityWeb = () => {
        const fullPrompt = generateContextAwarePrompt(aiCommand, aiOptions);
        window.open(`https://www.perplexity.ai/search?q=${encodeURIComponent(fullPrompt)}`, '_blank');
    };

    const renderAiTab = () => (
        <div className="flex flex-col h-full">
            <div className="flex p-2 mx-2 mt-2 mb-1 bg-gray-200 dark:bg-[#2A2A2A] rounded-lg">
                <button onClick={() => setAiSubTab('new')} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${aiSubTab === 'new' ? 'bg-white dark:bg-[#1F1F1F] text-[#00778e] shadow-sm' : 'text-gray-500'}`}>{tRs.newAnalysis}</button>
                <button onClick={() => setAiSubTab('history')} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${aiSubTab === 'history' ? 'bg-white dark:bg-[#1F1F1F] text-[#00778e] shadow-sm' : 'text-gray-500'}`}>{t.aiHistory.title}</button>
            </div>

            <div className="flex-grow overflow-y-auto custom-scrollbar p-4 space-y-4">
                {aiSubTab === 'new' ? (
                    <>
                        <div ref={commandsMenuRef} className="relative">
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{tRs.readyCommands}</label>
                            <button
                                type="button"
                                onClick={() => setIsCommandsMenuOpen(!isCommandsMenuOpen)}
                                className="w-full flex items-center justify-between p-2.5 bg-white dark:bg-[#1F1F1F] border border-gray-300 dark:border-[#3C3C3C] rounded-lg text-sm text-start focus:outline-none focus:ring-1 focus:ring-[#00778e] shadow-sm transition-all"
                            >
                                <span className="truncate text-gray-700 dark:text-gray-200 font-medium flex items-center gap-2">
                                    {selectedReadyCommand ? (
                                        (() => {
                                            const cmdIndex = readyCommands.findIndex(c => c.value === selectedReadyCommand);
                                            const cmd = readyCommands[cmdIndex];
                                            return (
                                                <>
                                                    {cmdIndex > 0 && getCommandIcon(cmdIndex)}
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
                                    {readyCommands.slice(1).map((cmd, idx) => (
                                        <button
                                            key={idx}
                                            onClick={() => handleCommandSelect(cmd.value)}
                                            className="w-full text-start px-3 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-[#3C3C3C] transition-colors flex items-center gap-3 border-b border-gray-50 dark:border-[#333] last:border-0"
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
                            <textarea value={aiCommand} onChange={(e) => setAiCommand(e.target.value)} rows={4} className="w-full p-2 bg-white dark:bg-[#1F1F1F] border border-gray-300 dark:border-[#3C3C3C] rounded-md text-sm resize-none" placeholder={tRs.aiPlaceholder} />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            {Object.keys(aiOptions).map((opt) => (
                                <label key={opt} className="flex items-center gap-2 text-xs cursor-pointer text-gray-600 dark:text-gray-400">
                                    <input type="checkbox" checked={(aiOptions as any)[opt]} onChange={() => handleOptionChange(opt as any)} className="rounded text-[#00778e]" />
                                    {(tRs as any)[opt] || opt}
                                </label>
                            ))}
                        </div>

                        <div className="flex items-center justify-between border-t pt-3 dark:border-[#333]">
                            <label className="text-xs font-bold text-gray-700 dark:text-gray-300">نموذج البحث:</label>
                            <div className="flex bg-gray-100 dark:bg-[#333] p-1 rounded-md">
                                <button onClick={() => setPerplexityModel('sonar')} className={`px-2 py-1 text-[10px] rounded ${perplexityModel === 'sonar' ? 'bg-white dark:bg-[#111] shadow-xs' : ''}`}>Sonar (سريع)</button>
                                <button onClick={() => setPerplexityModel('sonar-pro')} className={`px-2 py-1 text-[10px] rounded ${perplexityModel === 'sonar-pro' ? 'bg-white dark:bg-[#111] shadow-xs' : ''}`}>Pro (متعمق)</button>
                            </div>
                        </div>

                        <div className="flex flex-col gap-2">
                            <div className="flex gap-2">
                                <button onClick={() => handleAiAnalyze(aiCommand, aiOptions)} disabled={isAiLoading.gemini} className="flex-1 flex items-center justify-center gap-2 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                                    {isAiLoading.gemini ? <Wand2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                    <span className="text-xs font-bold">Gemini</span>
                                </button>
                                <button onClick={() => handlePerplexitySearch(aiCommand, aiOptions, perplexityModel)} disabled={isAiLoading.perplexity} className="flex-1 flex items-center justify-center gap-2 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50">
                                    {isAiLoading.perplexity ? <Wand2 size={16} className="animate-spin" /> : <Search size={16} />}
                                    <span className="text-xs font-bold">بحث ويب</span>
                                </button>
                            </div>
                            <button onClick={handleOpenPerplexityWeb} className="flex items-center justify-center gap-2 py-2 bg-gray-100 dark:bg-[#2A2A2A] text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-[#444] rounded-lg">
                                <ExternalLink size={16} /> <span className="text-xs font-bold">فتح Perplexity في نافذة جديدة</span>
                            </button>
                        </div>

                        <div className="space-y-3 pt-4 border-t border-gray-200 dark:border-[#3C3C3C]">
                            {/* Results Gemini */}
                            <div className="bg-blue-50 dark:bg-blue-900/10 rounded-lg overflow-hidden border border-blue-100 dark:border-blue-800/30">
                                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 flex justify-between cursor-pointer" onClick={() => setIsGeminiExpanded(!isGeminiExpanded)}>
                                    <span className="text-xs font-bold text-blue-800 dark:text-blue-300">نتائج Gemini</span>
                                    <ChevronDown size={14} className={isGeminiExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isGeminiExpanded && (
                                    <div className="p-3 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {isAiLoading.gemini ? <div className="flex gap-2 animate-pulse text-blue-500"><Wand2 size={14} /> جاري التفكير...</div> : 
                                         aiResults.gemini ? <div dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(aiResults.gemini) }} /> : <span className="text-gray-400 italic">لا توجد نتائج.</span>}
                                    </div>
                                )}
                            </div>
                            {/* Results Perplexity */}
                            <div className="bg-teal-50 dark:bg-teal-900/10 rounded-lg overflow-hidden border border-teal-100 dark:border-teal-800/30">
                                <div className="p-2 bg-teal-100 dark:bg-teal-900/30 flex justify-between cursor-pointer" onClick={() => setIsPerplexityExpanded(!isPerplexityExpanded)}>
                                    <span className="text-xs font-bold text-teal-800 dark:text-teal-300">نتائج بحث الويب</span>
                                    <ChevronDown size={14} className={isPerplexityExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isPerplexityExpanded && (
                                    <div className="p-3 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {isAiLoading.perplexity ? <div className="flex gap-2 animate-pulse text-teal-500"><Search size={14} /> جاري الاتصال بـ Perplexity...</div> : 
                                         aiResults.perplexity ? <div dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(aiResults.perplexity) }} /> : <span className="text-gray-400 italic">لا توجد نتائج.</span>}
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
        <aside className="basis-[17%] flex flex-col h-full min-w-0 bg-[#F2F3F5] dark:bg-[#1F1F1F] rounded-lg shadow-lg overflow-hidden border-s border-gray-300 dark:border-[#333]">
            <div className="flex border-b border-gray-200 dark:border-[#3C3C3C]">
                {(['structure', 'goal', 'ai'] as const).map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)} className={`flex-1 py-3 flex justify-center items-center transition-colors ${activeTab === tab ? 'text-[#00778e] border-b-2 border-[#00778e] bg-white dark:bg-[#2A2A2A]' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-[#2A2A2A]'}`}>
                        {tab === 'structure' ? <LayoutTemplate size={18} /> : tab === 'goal' ? <Target size={18} /> : <BrainCircuit size={18} />}
                    </button>
                ))}
            </div>
            <div className="flex-grow overflow-y-auto custom-scrollbar">{activeTab === 'structure' ? <StructureTab /> : activeTab === 'goal' ? <GoalTab /> : renderAiTab()}</div>
        </aside>
    );
};

export default RightSidebar;
