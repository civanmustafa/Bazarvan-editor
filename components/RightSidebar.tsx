
import React, { useState, useRef, useEffect } from 'react';
import { LayoutTemplate, Sparkles, ChevronDown, ExternalLink, Search, BrainCircuit, Wand2, FileSearch, ShieldAlert, Lightbulb, Users, Command } from 'lucide-react';
import StructureTab from './StructureTab';
import AIHistoryTab from './AIHistoryTab';
import { useUser } from '../contexts/UserContext';
import { useAI } from '../contexts/AIContext';
import { parseMarkdownToHtml } from '../utils/editorUtils';

const FULL_ARTICLE_SEO_AI_AUDIT_PROMPT = `أنت خبير محتوى SEO/AEO/GEO/LLM SEO. افحص المحتوى التالي بعمق ولكن باختصار، وقيّمه من حيث مطابقته لنية البحث، كفاية الإجابة، قابلية الاقتباس في AI Overviews، الفجوات المعرفية، الأسئلة الناقصة، الادعاءات غير المدعومة، الكيانات الناقصة، البنية، وقوة التحويل.

بيانات الصفحة:
- الكلمة المفتاحية الأساسية: استخدم الكلمة الأساسية المرفقة تلقائيًا مع الطلب.
- الكلمات الثانوية: استخدم الكلمات الثانوية المرفقة تلقائيًا مع الطلب.
- نوع الصفحة: استخدم نوع الصفحة المرفق تلقائيًا مع الطلب.
- هدف الصفحة: استخدم هدف الصفحة المرفق تلقائيًا مع الطلب.
- الجمهور المستهدف: استخدم الجمهور المستهدف المرفق تلقائيًا مع الطلب.
- العلامة التجارية: استخدم اسم العلامة التجارية المرفق تلقائيًا مع الطلب.

المحتوى:
استخدم نص المحرر المرفق تلقائيًا مع الطلب. إذا كانت هناك معلومات أخرى مرفقة مثل معايير الكلمات أو البنية أو هدف الصفحة، فاستفد منها أيضًا.

المطلوب:

أخرج التحليل بالعربية وفق هذا التنسيق فقط:

1. ملخص سريع:
- التقييم العام من 100:
- أقوى نقطة في المحتوى:
- أخطر ضعف:
- هل المحتوى مناسب لنية البحث؟ نعم/جزئيًا/لا، مع السبب.

2. نية البحث والفجوات:
- نية البحث الأساسية:
- نوايا فرعية ناقصة:
- 5 أسئلة مهمة يجب إضافتها مع مكان إضافتها.

3. جاهزية AEO/GEO/LLM:
- هل توجد إجابات قابلة للاقتباس؟
- أفضل 3 جمل قابلة للاقتباس من النص.
- 3 جمل جديدة مقترحة أقوى للاقتباس.
- جواب محتمل قد يستخرجه Google AI Overview من المحتوى.

4. الادعاءات والكيانات:
- أهم الادعاءات التي تحتاج دعمًا أو تخفيفًا.
- أهم الكيانات الناقصة التي يجب إضافتها.
- أين تُضاف هذه الكيانات داخل المحتوى؟

5. البنية والتحويل:
- مشاكل العناوين والترتيب.
- الفقرات التي تحتاج تقسيمًا أو توضيحًا.
- مدى قوة CTA.

6. إعادة صياغة:
اختر أضعف فقرة وأعد كتابتها لتصبح أوضح، أقوى، أكثر إقناعًا، وأكثر قابلية للاقتباس.

7. توصيات عملية:
قدّم 7 توصيات فقط. لكل توصية اذكر:
- ماذا أفعل؟
- أين أطبقه؟
- لماذا مهم؟
- مثال قصير.

قيود الإخراج:
- اجعل الإجابات شديدة التركيز.
- لا تكرر نفس الملاحظة.
- لا تقدم نصائح عامة.
- لا تقترح صورًا أو فيديوهات أو Schema.
- اجعل الإجابة عملية ومباشرة.`;

type AiAnalysisOptions = {
    manualCommand: boolean;
    editorText: boolean;
    targetKeywords: boolean;
    goalContext: boolean;
    keywordCriteria: boolean;
    structureCriteria: boolean;
    goalCriteria: boolean;
};

type ReadyCommand = {
    label: string;
    value: string;
    options?: Partial<AiAnalysisOptions>;
};

const RightSidebar: React.FC = () => {
    const { uiLanguage, t } = useUser();
    const { handleAiAnalyze, handlePerplexitySearch, aiResults, isAiLoading, generateContextAwarePrompt } = useAI();
    
    const [activeTab, setActiveTab] = useState<'structure' | 'ai'>('structure');
    const [aiSubTab, setAiSubTab] = useState<'new' | 'history'>('new');
    const [aiCommand, setAiCommand] = useState('');
    const [selectedReadyCommand, setSelectedReadyCommand] = useState('');
    const [perplexityModel, setPerplexityModel] = useState<'sonar' | 'sonar-pro'>('sonar');
    const [isGeminiExpanded, setIsGeminiExpanded] = useState(true);
    const [isPerplexityExpanded, setIsPerplexityExpanded] = useState(true);
    
    // Custom Dropdown State
    const [isCommandsMenuOpen, setIsCommandsMenuOpen] = useState(false);
    const commandsMenuRef = useRef<HTMLDivElement>(null);

    const [aiOptions, setAiOptions] = useState<AiAnalysisOptions>({
        manualCommand: true,
        editorText: true,
        targetKeywords: true,
        goalContext: true,
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

    const readyCommands: ReadyCommand[] = [
        { label: tRs.selectCommand, value: '' },
        { 
            label: tRs.analyzeFull, 
            value: FULL_ARTICLE_SEO_AI_AUDIT_PROMPT,
            options: {
                manualCommand: true,
                editorText: true,
                targetKeywords: true,
                goalContext: true,
                keywordCriteria: true,
                structureCriteria: true,
                goalCriteria: true,
            },
        },
        { 
            label: tRs.improveWeakest, 
            value: `باستخدام بيانات الصفحة، الكلمات، الجمهور، نية البحث، معايير التحليل، ونص المحرر المرفقة تلقائيًا:
حدّد أضعف قسم أو فقرة في المقال من حيث SEO/AEO/GEO/LLM SEO ومطابقة هدف الصفحة.
أخرج فقط:
1. اسم القسم أو بداية الفقرة الضعيفة.
2. سبب الضعف باختصار.
3. نسخة محسنة جاهزة للاستبدال.
4. لماذا النسخة الجديدة أفضل.
لا تقدّم نصائح عامة ولا تقترح صورًا أو فيديوهات أو Schema.`,
            options: {
                manualCommand: true,
                editorText: true,
                targetKeywords: true,
                goalContext: true,
                keywordCriteria: true,
                structureCriteria: true,
                goalCriteria: true,
            },
        },
        { 
            label: tRs.suggestNew, 
            value: `باستخدام بيانات الصفحة، الكلمات، الجمهور، نية البحث، ومعايير هدف الصفحة المرفقة تلقائيًا:
اقترح فكرة أو فقرة جديدة غير مذكورة في المقال وتضيف قيمة واضحة للقارئ وتزيد قابلية الاقتباس في AI Overviews.
أخرج فقط:
1. مكان الإضافة المقترح داخل المقال.
2. عنوان فرعي مناسب إن لزم.
3. الفقرة المقترحة جاهزة للإضافة.
4. سبب أهميتها للبحث والقرار والتحويل.
لا تقدّم أكثر من فكرة واحدة ولا تقترح صورًا أو فيديوهات أو Schema.`,
            options: {
                manualCommand: true,
                editorText: true,
                targetKeywords: true,
                goalContext: true,
                keywordCriteria: true,
                structureCriteria: true,
                goalCriteria: true,
            },
        },
        {
            label: tRs.peopleQuestions,
            value: `استخرج أهم أسئلة الباحثين المرتبطة بالكلمة المفتاحية ونية البحث والجمهور المستهدف المرفقين تلقائيًا.
أخرج 10 أسئلة فقط، مع تقسيمها إلى:
- أسئلة قبل القرار.
- أسئلة مقارنة أو اختيار.
- أسئلة تكلفة أو سعر.
- أسئلة اعتراضات أو مخاطر.
لكل سؤال اذكر أين يمكن إضافته داخل المقال باختصار.`,
            options: {
                manualCommand: true,
                editorText: true,
                targetKeywords: true,
                goalContext: true,
                keywordCriteria: false,
                structureCriteria: false,
                goalCriteria: true,
            },
        },
    ];

    const getCommandIcon = (index: number) => {
        switch (index) {
            case 1: return <FileSearch size={16} className="text-[#d4af37]" />;
            case 2: return <ShieldAlert size={16} className="text-[#d4af37]" />;
            case 3: return <Lightbulb size={16} className="text-[#d4af37]" />;
            case 4: return <Users size={16} className="text-[#d4af37]" />;
            default: return <Command size={16} className="text-gray-400" />;
        }
    };

    const handleCommandSelect = (command: ReadyCommand) => {
        setSelectedReadyCommand(command.value);
        if (command.value) setAiCommand(command.value);
        if (command.options) {
            setAiOptions(prev => ({ ...prev, ...command.options }));
        }
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

                        <div className="flex items-center justify-between border-t pt-3 dark:border-[#333]">
                            <label className="text-xs font-bold text-gray-700 dark:text-gray-300">نموذج البحث:</label>
                            <div className="flex bg-gray-100 dark:bg-[#333] p-1 rounded-md">
                                <button onClick={() => setPerplexityModel('sonar')} className={`px-2 py-1 text-[10px] rounded ${perplexityModel === 'sonar' ? 'bg-white dark:bg-[#111] shadow-xs' : ''}`}>Sonar (سريع)</button>
                                <button onClick={() => setPerplexityModel('sonar-pro')} className={`px-2 py-1 text-[10px] rounded ${perplexityModel === 'sonar-pro' ? 'bg-white dark:bg-[#111] shadow-xs' : ''}`}>Pro (متعمق)</button>
                            </div>
                        </div>

                        <div className="flex flex-col gap-2">
                            <div className="flex gap-2">
                                <button onClick={() => handleAiAnalyze(aiCommand, aiOptions)} disabled={isAiLoading.gemini} className="flex-1 flex items-center justify-center gap-2 py-2 bg-[#d4af37] text-white rounded-lg hover:bg-[#b8922e] disabled:opacity-50">
                                    {isAiLoading.gemini ? <Wand2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                    <span className="text-xs font-bold">Gemini</span>
                                </button>
                                <button onClick={() => handlePerplexitySearch(aiCommand, aiOptions, perplexityModel)} disabled={isAiLoading.perplexity} className="flex-1 flex items-center justify-center gap-2 py-2 bg-[#d4af37] text-white rounded-lg hover:bg-[#b8922e] disabled:opacity-50">
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
                            <div className="bg-[#d4af37]/10 dark:bg-[#d4af37]/10 rounded-lg overflow-hidden border border-[#d4af37]/20 dark:border-[#d4af37]/25">
                                <div className="p-2 bg-[#d4af37]/15 dark:bg-[#d4af37]/20 flex justify-between cursor-pointer" onClick={() => setIsGeminiExpanded(!isGeminiExpanded)}>
                                    <span className="text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">نتائج Gemini</span>
                                    <ChevronDown size={14} className={isGeminiExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isGeminiExpanded && (
                                    <div className="p-3 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {isAiLoading.gemini ? <div className="flex gap-2 animate-pulse text-[#d4af37]"><Wand2 size={14} /> جاري التفكير...</div> :
                                         aiResults.gemini ? <div dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(aiResults.gemini) }} /> : <span className="text-gray-400 italic">لا توجد نتائج.</span>}
                                    </div>
                                )}
                            </div>
                            {/* Results Perplexity */}
                            <div className="bg-[#d4af37]/10 dark:bg-[#d4af37]/10 rounded-lg overflow-hidden border border-[#d4af37]/20 dark:border-[#d4af37]/25">
                                <div className="p-2 bg-[#d4af37]/15 dark:bg-[#d4af37]/20 flex justify-between cursor-pointer" onClick={() => setIsPerplexityExpanded(!isPerplexityExpanded)}>
                                    <span className="text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">نتائج بحث الويب</span>
                                    <ChevronDown size={14} className={isPerplexityExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isPerplexityExpanded && (
                                    <div className="p-3 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {isAiLoading.perplexity ? <div className="flex gap-2 animate-pulse text-[#d4af37]"><Search size={14} /> جاري الاتصال بـ Perplexity...</div> :
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
