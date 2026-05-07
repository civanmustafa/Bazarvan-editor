
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { LayoutTemplate, Sparkles, ChevronDown, BrainCircuit, Wand2, FileSearch, ShieldAlert, Lightbulb, Users, Command, Copy, FilePlus2, LocateFixed, CheckCircle2, AlertTriangle, Code2 } from 'lucide-react';
import StructureTab from './StructureTab';
import AIHistoryTab from './AIHistoryTab';
import { useUser } from '../contexts/UserContext';
import { useAI } from '../contexts/AIContext';
import { parseMarkdownToHtml } from '../utils/editorUtils';
import type { AiAnalysisOptions, AiContentPatch, AiPatchProvider } from '../types';
import { DEFAULT_SMART_ANALYSIS_OPTIONS, ENGINEERING_PROMPT_DEFINITIONS, getEngineeringPrompt } from '../constants/engineeringPrompts';

type ReadyCommand = {
    id: string;
    label: string;
    value: string;
    options?: Partial<AiAnalysisOptions>;
};

type CompetitorExtractedContent = {
    url: string;
    fetchedUrl: string;
    title: string;
    description: string;
    headings: {
        h1: string[];
        h2: string[];
        h3: string[];
    };
    paragraphs: string[];
    listItems: string[];
    text: string;
    wordCount: number;
};

type CompetitorExtractionSource = 'url' | 'html';

type CompetitorExtractionState = {
    status: 'idle' | 'loading' | 'success' | 'error';
    source?: CompetitorExtractionSource;
    content: CompetitorExtractedContent | null;
    error: string;
};

const COMPETITOR_STORAGE_KEY = 'bazarvan-competitor-links';
const COMPETITOR_HTML_STORAGE_KEY = 'bazarvan-competitor-html-snippets';
const COMPETITOR_TIMEOUT_MS = 180000;

const createEmptyCompetitorState = (): CompetitorExtractionState => ({
    status: 'idle',
    source: undefined,
    content: null,
    error: '',
});

const createDefaultCompetitorUrls = () => ['', '', ''];
const createDefaultCompetitorHtmls = () => ['', '', ''];

const createDefaultCompetitorExtractions = () => [
    createEmptyCompetitorState(),
    createEmptyCompetitorState(),
    createEmptyCompetitorState(),
];

const loadStoredCompetitorUrls = (): string[] => {
    try {
        const parsed = JSON.parse(localStorage.getItem(COMPETITOR_STORAGE_KEY) || '[]');
        const urls = Array.isArray(parsed) ? parsed : [];
        return createDefaultCompetitorUrls().map((_, index) => typeof urls[index] === 'string' ? urls[index] : '');
    } catch {
        return createDefaultCompetitorUrls();
    }
};

const loadStoredCompetitorHtmls = (): string[] => {
    try {
        const parsed = JSON.parse(localStorage.getItem(COMPETITOR_HTML_STORAGE_KEY) || '[]');
        const snippets = Array.isArray(parsed) ? parsed : [];
        return createDefaultCompetitorHtmls().map((_, index) => typeof snippets[index] === 'string' ? snippets[index] : '');
    } catch {
        return createDefaultCompetitorHtmls();
    }
};

const extractJsonFromGeminiText = (value: string): any | null => {
    const tryParse = (candidate: string): any | null => {
        try {
            return JSON.parse(candidate);
        } catch {
            return null;
        }
    };
    const trimmed = value.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
        const parsed = tryParse(fenced[1].trim());
        if (parsed) return parsed;
    }
    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
        return tryParse(trimmed.slice(objectStart, objectEnd + 1));
    }
    return tryParse(trimmed);
};

const normalizeStringArray = (value: unknown, maxItems: number): string[] => {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value
        .map(item => typeof item === 'string' ? item.trim() : '')
        .filter(Boolean)
        .filter(item => {
            const key = item.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, maxItems);
};

const normalizeCompetitorContent = (parsed: any, fallbackUrl: string): CompetitorExtractedContent => {
    const content: CompetitorExtractedContent = {
        url: typeof parsed.url === 'string' && parsed.url.trim() ? parsed.url.trim() : fallbackUrl,
        fetchedUrl: typeof parsed.fetchedUrl === 'string' && parsed.fetchedUrl.trim()
            ? parsed.fetchedUrl.trim()
            : typeof parsed.url === 'string' && parsed.url.trim() ? parsed.url.trim() : fallbackUrl,
        title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
        description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
        headings: {
            h1: normalizeStringArray(parsed.headings?.h1, 8),
            h2: normalizeStringArray(parsed.headings?.h2, 30),
            h3: normalizeStringArray(parsed.headings?.h3, 30),
        },
        paragraphs: normalizeStringArray(parsed.paragraphs, 60),
        listItems: normalizeStringArray(parsed.listItems, 60),
        text: typeof parsed.text === 'string' ? parsed.text.trim() : '',
        wordCount: Number.isFinite(Number(parsed.wordCount)) ? Number(parsed.wordCount) : 0,
    };

    if (!content.wordCount) {
        content.wordCount = [
            content.title,
            content.description,
            ...content.headings.h1,
            ...content.headings.h2,
            ...content.headings.h3,
            ...content.paragraphs,
            ...content.listItems,
            content.text,
        ].join(' ').split(/\s+/).filter(Boolean).length;
    }

    return content;
};

type HtmlContentBlock = {
    type: 'h1' | 'h2' | 'h3' | 'p' | 'li';
    text: string;
};

const HTML_NOISE_SELECTOR = [
    'script',
    'style',
    'noscript',
    'svg',
    'canvas',
    'iframe',
    'template',
    'form',
    'input',
    'select',
    'textarea',
    'header',
    'footer',
    'nav',
    'aside',
    '[hidden]',
    '[aria-hidden="true"]',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
].join(',');

const HTML_NOISE_ATTRIBUTE_PATTERN = /(^|[\s_-])(nav|navbar|menu|header|footer|sidebar|aside|widget|comment|comments|reply|share|social|breadcrumb|breadcrumbs|cookie|cookies|banner|advertisement|advert|ads|popup|modal|newsletter|subscribe|search|recent|popular|related|tagcloud|tags|category|categories|pagination|preloader|offcanvas|login|post-meta)([\s_-]|$)/i;

const HTML_MAIN_CANDIDATE_SELECTOR = [
    'article',
    'main',
    '[role="main"]',
    '[class*="post-content"]',
    '[class*="entry-content"]',
    '[class*="article-content"]',
    '[class*="blog-content"]',
    '[class*="post-body"]',
    '[class*="article-body"]',
    '[class*="content-area"]',
    '[id*="article"]',
    '[id*="content"]',
    '[id*="post"]',
].join(',');

const normalizeHtmlText = (value: string): string => (
    value
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t\r\n\f]+/g, ' ')
        .trim()
);

const getHtmlMetaContent = (doc: Document, selectors: string[]): string => {
    for (const selector of selectors) {
        const content = doc.querySelector(selector)?.getAttribute('content');
        const normalized = normalizeHtmlText(content || '');
        if (normalized) return normalized;
    }
    return '';
};

const getHtmlAttribute = (doc: Document, selector: string, attribute: string): string => (
    normalizeHtmlText(doc.querySelector(selector)?.getAttribute(attribute) || '')
);

const resolveHtmlUrl = (value: string, baseUrl: string): string => {
    const normalized = normalizeHtmlText(value);
    if (!normalized) return baseUrl || 'html_input';
    try {
        return new URL(normalized, baseUrl && baseUrl !== 'html_input' ? baseUrl : undefined).href;
    } catch {
        return normalized;
    }
};

const isHtmlElementHidden = (element: Element): boolean => {
    let current: Element | null = element;
    while (current) {
        if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return true;
        const style = current.getAttribute('style') || '';
        if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
        current = current.parentElement;
    }
    return false;
};

const isHtmlNoiseElement = (element: Element): boolean => {
    const marker = [
        element.id,
        element.className,
        element.getAttribute('role') || '',
        element.getAttribute('aria-label') || '',
    ].join(' ');
    return HTML_NOISE_ATTRIBUTE_PATTERN.test(marker);
};

const removeHtmlNoise = (root: ParentNode) => {
    root.querySelectorAll(HTML_NOISE_SELECTOR).forEach(element => element.remove());
    root.querySelectorAll('*').forEach(element => {
        if (isHtmlNoiseElement(element)) {
            element.remove();
        }
    });
};

const getHtmlElementScore = (element: Element): number => {
    const text = normalizeHtmlText(element.textContent || '');
    if (text.length < 40) return -Infinity;
    const linkTextLength = Array.from(element.querySelectorAll('a'))
        .reduce((sum, link) => sum + normalizeHtmlText(link.textContent || '').length, 0);
    const paragraphCount = element.querySelectorAll('p').length;
    const headingCount = element.querySelectorAll('h1,h2,h3').length;
    const listCount = element.querySelectorAll('li').length;
    const linkRatio = text.length ? linkTextLength / text.length : 0;
    const linkPenalty = linkRatio > 0.35 ? linkTextLength * 1.5 : linkTextLength * 0.35;
    const focusedBonus = element.tagName.toLowerCase() === 'body' ? 0 : 1500;
    return text.length + paragraphCount * 140 + headingCount * 90 + listCount * 20 + focusedBonus - linkPenalty;
};

const selectHtmlMainContentRoot = (doc: Document): Element => {
    const candidates = Array.from(doc.body.querySelectorAll(HTML_MAIN_CANDIDATE_SELECTOR));
    const uniqueCandidates = Array.from(new Set<Element>([doc.body, ...candidates]))
        .filter(element => !isHtmlElementHidden(element) && !isHtmlNoiseElement(element));

    let bestElement: Element = doc.body;
    let bestScore = getHtmlElementScore(doc.body);
    uniqueCandidates.forEach(element => {
        const score = getHtmlElementScore(element);
        if (score > bestScore) {
            bestElement = element;
            bestScore = score;
        }
    });

    return bestElement;
};

const collectHtmlContentBlocks = (root: Element): HtmlContentBlock[] => {
    const blocks: HtmlContentBlock[] = [];
    const seen = new Set<string>();

    root.querySelectorAll('h1,h2,h3,p,li').forEach(element => {
        if (isHtmlElementHidden(element) || isHtmlNoiseElement(element)) return;
        const tagName = element.tagName.toLowerCase() as HtmlContentBlock['type'];
        if (tagName === 'p' && element.closest('li')) return;
        const text = normalizeHtmlText(element.textContent || '');
        if (!text || text.length < 2) return;
        const duplicateKey = `${tagName}:${text.toLowerCase()}`;
        if (seen.has(duplicateKey)) return;
        seen.add(duplicateKey);
        blocks.push({ type: tagName, text });
    });

    return blocks;
};

const getArabicParagraphOrdinal = (index: number): string => {
    const ordinals = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة', 'التاسعة', 'العاشرة'];
    return ordinals[index - 1] || String(index);
};

const buildHtmlContentText = (blocks: HtmlContentBlock[]): string => {
    const lines: string[] = [];
    let paragraphIndex = 0;

    blocks.forEach(block => {
        if (block.type === 'h1' || block.type === 'h2' || block.type === 'h3') {
            lines.push(`${block.type.toUpperCase()}: ${block.text}`);
            paragraphIndex = 0;
            return;
        }

        if (block.type === 'li') {
            lines.push(`عنصر قائمة: ${block.text}`);
            return;
        }

        paragraphIndex += 1;
        lines.push(`الفقرة ${getArabicParagraphOrdinal(paragraphIndex)}: ${block.text}`);
    });

    return lines.join('\n');
};

const extractCompetitorContentFromHtml = (html: string, fallbackUrl: string): CompetitorExtractedContent => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const baseHref = getHtmlAttribute(doc, 'base[href]', 'href');
    const canonicalUrl = getHtmlAttribute(doc, 'link[rel~="canonical"][href]', 'href');
    const ogUrl = getHtmlMetaContent(doc, ['meta[property="og:url"]']);
    const resolvedUrl = resolveHtmlUrl(canonicalUrl || ogUrl || baseHref || fallbackUrl || 'html_input', baseHref || fallbackUrl || 'html_input');

    const title = normalizeHtmlText(
        doc.querySelector('title')?.textContent || getHtmlMetaContent(doc, [
            'meta[property="og:title"]',
            'meta[name="twitter:title"]',
        ])
    );
    const description = getHtmlMetaContent(doc, [
        'meta[name="description"]',
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
    ]);

    removeHtmlNoise(doc);
    const root = selectHtmlMainContentRoot(doc);
    removeHtmlNoise(root);
    const blocks = collectHtmlContentBlocks(root);
    const headings = {
        h1: blocks.filter(block => block.type === 'h1').map(block => block.text).slice(0, 8),
        h2: blocks.filter(block => block.type === 'h2').map(block => block.text).slice(0, 30),
        h3: blocks.filter(block => block.type === 'h3').map(block => block.text).slice(0, 30),
    };
    const paragraphs = blocks.filter(block => block.type === 'p').map(block => block.text).slice(0, 80);
    const listItems = blocks.filter(block => block.type === 'li').map(block => block.text).slice(0, 80);
    const text = buildHtmlContentText(blocks);

    if (!text || (!paragraphs.length && !headings.h1.length && !headings.h2.length && !headings.h3.length)) {
        throw new Error('تعذر العثور على محتوى تحريري واضح داخل كود HTML.');
    }

    return {
        url: resolvedUrl,
        fetchedUrl: resolvedUrl,
        title: title || headings.h1[0] || '',
        description,
        headings,
        paragraphs,
        listItems,
        text,
        wordCount: text.split(/\s+/).filter(Boolean).length,
    };
};

const buildCompetitorPrompt = (url: string): string => `أنت محلل محتوى SEO تقني صارم داخل أداة تحرير محتوى.

مهمتك الوحيدة هي استخدام أداة URL Context في Gemini لقراءة الرابط التالي فقط:
${url}

ثم استخراج المحتوى التحريري الأساسي الظاهر في الصفحة بدقة، وتنظيمه كخريطة أفكار تحريرية مرتبة حسب بنية الصفحة الأصلية.

ممنوع تمامًا:
- استخدام الذاكرة أو المعرفة العامة.
- توقع محتوى غير ظاهر في الصفحة.
- إعادة الصياغة أو التحسين أو التلخيص.
- إضافة عناوين أو أفكار أو فقرات غير موجودة نصيًا.
- استخراج الهيدر أو الفوتر أو القوائم الجانبية أو عناصر التنقل أو الكوكيز أو التعليقات أو الإعلانات المتكررة أو الدعوات العامة المتكررة غير المرتبطة بالمحتوى الأساسي.
- كتابة أي شرح خارج JSON.
- استخدام Markdown.

قواعد الاستخراج:
- ركّز فقط على المحتوى التحريري الرئيسي للصفحة.
- استخرج كما يظهر في الصفحة قدر الإمكان:
  - عنوان الصفحة title
  - وصف الصفحة description
  - H1
  - H2
  - H3
  - الفقرات الأساسية
  - عناصر القوائم المهمة المرتبطة بالمحتوى التحريري
- حافظ على ترتيب المحتوى من الأعلى إلى الأسفل كما يظهر في الصفحة.
- كل عنوان أو فقرة أو عنصر قائمة يجب أن يكون مستندًا إلى نص ظاهر في الصفحة فقط.
- إذا لم تجد دليلًا نصيًا واضحًا على فكرة معينة، لا تضفها.
- إذا كان هناك نص مكرر أو دعائي يظهر في أكثر من موضع، تجاهله ما لم يكن جزءًا مباشرًا من المحتوى التحريري الأساسي.
- إذا تعذر الوصول إلى الرابط أو قراءة محتواه، أرجع JSON صالحًا يحتوي على وصف الخطأ داخل حقل "error".

طريقة تنظيم حقل text:
- ابدأ بـ H1 إن وجد.
- بعد ذلك، نظّم المحتوى حسب H2 ثم H3 التابعة له.
- لكل H2 مهم، اكتب:
  "H2: العنوان"
  ثم أدرج الفقرات التابعة له بهذا النمط:
  "الفقرة الأولى: النص الكامل للفقرة كما يظهر في الصفحة."
  "الفقرة الثانية: النص الكامل للفقرة كما يظهر في الصفحة."
- لكل H3 تابع، اكتب:
  "H3: العنوان"
  ثم أدرج الفقرات التابعة له بنفس النمط.
- عند وجود قائمة مهمة تحت H2 أو H3، أدرج عناصرها داخل text بهذا النمط:
  "عنصر قائمة: النص كما يظهر في الصفحة."
- لا تكتب أي تفسير أو تعليق خارج هذا التنظيم داخل text.

طريقة ملء الحقول:
- url: الرابط الأصلي المُدخل.
- fetchedUrl: الرابط النهائي بعد الفتح إن وُجد تحويل، وإلا نفس الرابط.
- title: عنوان الصفحة كما يظهر في المصدر أو نتيجة القراءة.
- description: وصف الصفحة إن وُجد.
- headings.h1: جميع عناوين H1 كما تظهر.
- headings.h2: جميع عناوين H2 المهمة المرتبطة بالمحتوى الأساسي.
- headings.h3: جميع عناوين H3 المهمة المرتبطة بالمحتوى الأساسي.
- paragraphs: الفقرات الأساسية المستخرجة من المحتوى التحريري فقط، دون تعديل.
- listItems: عناصر القوائم المهمة المرتبطة بالمحتوى التحريري فقط، دون تعديل.
- text: الخريطة التحريرية الكاملة المنظمة حسب H1/H2/H3 والفقرات والقوائم.
- wordCount: عدد كلمات النص الموجود داخل حقل text فقط.
- error: اتركه فارغًا إذا تم الاستخراج بنجاح، أو اكتب سبب الخطأ إذا فشلت القراءة.

أرجع JSON صالحًا فقط، بدون Markdown وبدون أي شرح خارجي.

صيغة الإخراج المطلوبة:
{
  "url": "...",
  "fetchedUrl": "...",
  "title": "...",
  "description": "...",
  "headings": {
    "h1": ["..."],
    "h2": ["..."],
    "h3": ["..."]
  },
  "paragraphs": ["..."],
  "listItems": ["..."],
  "text": "...",
  "wordCount": 0,
  "error": ""
}`;

const RightSidebar: React.FC = () => {
    const { t, engineeringPrompts, apiKeys } = useUser();
    const {
        handleAiAnalyze,
        handleChatGptAnalyze,
        aiResults,
        aiInsertionPatches,
        isAiLoading,
        applyAiInsertionPatch,
        selectAiInsertionPatchTarget,
    } = useAI();
    
    const [activeTab, setActiveTab] = useState<'structure' | 'ai' | 'competitors'>('structure');
    const [aiSubTab, setAiSubTab] = useState<'new' | 'history'>('new');
    const [aiCommand, setAiCommand] = useState('');
    const [competitorUrls, setCompetitorUrls] = useState<string[]>(() => loadStoredCompetitorUrls());
    const [competitorHtmls, setCompetitorHtmls] = useState<string[]>(() => loadStoredCompetitorHtmls());
    const [competitorExtractions, setCompetitorExtractions] = useState<CompetitorExtractionState[]>(() => createDefaultCompetitorExtractions());
    const [selectedReadyCommandId, setSelectedReadyCommandId] = useState('');
    const [isGeminiExpanded, setIsGeminiExpanded] = useState(true);
    const [isChatGptExpanded, setIsChatGptExpanded] = useState(true);
    const [copiedPatchId, setCopiedPatchId] = useState('');
    
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

    useEffect(() => {
        try {
            localStorage.setItem(COMPETITOR_STORAGE_KEY, JSON.stringify(competitorUrls));
        } catch (error) {
            console.error('Could not save competitor links:', error);
        }
    }, [competitorUrls]);

    useEffect(() => {
        try {
            localStorage.setItem(COMPETITOR_HTML_STORAGE_KEY, JSON.stringify(competitorHtmls));
        } catch (error) {
            console.error('Could not save competitor HTML snippets:', error);
        }
    }, [competitorHtmls]);

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

    const handleCopyPatch = async (patchId: string, content: string) => {
        try {
            await navigator.clipboard.writeText(content);
            setCopiedPatchId(patchId);
            window.setTimeout(() => {
                setCopiedPatchId(current => current === patchId ? '' : current);
            }, 1500);
        } catch (error) {
            console.error('Could not copy AI patch:', error);
        }
    };

    const handleCompetitorUrlChange = (index: number, value: string) => {
        setCompetitorUrls(prev => prev.map((url, urlIndex) => urlIndex === index ? value : url));
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? createEmptyCompetitorState() : item));
    };

    const handleCompetitorHtmlChange = (index: number, value: string) => {
        setCompetitorHtmls(prev => prev.map((html, htmlIndex) => htmlIndex === index ? value : html));
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? createEmptyCompetitorState() : item));
    };

    const runCompetitorExtraction = async (
        index: number,
        prompt: string,
        useUrlContext: boolean,
        source: CompetitorExtractionSource,
        fallbackUrl: string,
    ) => {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), COMPETITOR_TIMEOUT_MS);
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            status: 'loading',
            source,
            error: '',
        } : item));

        try {
            const response = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt,
                    apiKeys: apiKeys.gemini.filter(Boolean),
                    useUrlContext,
                }),
                signal: controller.signal,
            });
            window.clearTimeout(timeoutId);
            const data = await response.json().catch(() => ({}));
            if (response.status === 404) {
                throw new Error(tRs.competitorApiUnavailable);
            }
            if (!response.ok) {
                throw new Error(data.error || `${tRs.competitorExtractionFailed} (${response.status})`);
            }

            const parsed = extractJsonFromGeminiText(typeof data.text === 'string' ? data.text : '');
            if (!parsed || typeof parsed !== 'object') {
                throw new Error(tRs.competitorExtractionFailed);
            }
            if (typeof parsed.error === 'string' && parsed.error.trim()) {
                throw new Error(parsed.error.trim());
            }

            const content = normalizeCompetitorContent(parsed, fallbackUrl);

            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'success',
                source,
                content,
                error: '',
            } : item));
        } catch (error) {
            window.clearTimeout(timeoutId);
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'error',
                source,
                content: null,
                error: error instanceof Error && error.name === 'AbortError'
                    ? tRs.competitorExtractionTimeout
                    : error instanceof Error ? error.message : tRs.competitorExtractionFailed,
            } : item));
        }
    };

    const handleExtractCompetitorUrl = async (index: number) => {
        const url = competitorUrls[index]?.trim();
        if (!url) {
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'error',
                source: 'url',
                content: null,
                error: tRs.competitorUrlRequired,
            } : item));
            return;
        }

        await runCompetitorExtraction(index, buildCompetitorPrompt(url), true, 'url', url);
    };

    const handleExtractCompetitorHtml = (index: number) => {
        const html = competitorHtmls[index]?.trim();
        if (!html) {
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'error',
                source: 'html',
                content: null,
                error: tRs.competitorHtmlRequired,
            } : item));
            return;
        }

        const fallbackUrl = competitorUrls[index]?.trim() || 'html_input';
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            status: 'loading',
            source: 'html',
            error: '',
        } : item));

        window.setTimeout(() => {
            try {
                const content = extractCompetitorContentFromHtml(html, fallbackUrl);
                setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                    status: 'success',
                    source: 'html',
                    content,
                    error: '',
                } : item));
            } catch (error) {
                setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                    status: 'error',
                    source: 'html',
                    content: null,
                    error: error instanceof Error ? error.message : tRs.competitorExtractionFailed,
                } : item));
            }
        }, 0);
    };

    const getPatchActionLabel = (operation: string) => (
        operation === 'replace_block' || operation === 'replace_text' ? 'استبدال' : 'إضافة'
    );

    const renderPatchCard = (provider: AiPatchProvider, patch: AiContentPatch) => {
        const actionLabel = getPatchActionLabel(patch.operation);
        const isCopied = copiedPatchId === patch.id;

        return (
            <div key={patch.id} className="my-3 border border-[#d4af37]/25 dark:border-[#d4af37]/30 rounded-md bg-white/80 dark:bg-[#1F1F1F]/80 p-2 not-prose">
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                            <span className="rounded bg-[#d4af37]/15 px-1.5 py-0.5 text-[11px] font-bold text-[#8a6f1d] dark:text-[#f2d675]">{actionLabel}</span>
                            <div className="text-xs font-bold text-[#333333] dark:text-gray-100 line-clamp-2">{patch.title}</div>
                        </div>
                        {(patch.placementLabel || patch.anchorText || patch.targetText) && (
                            <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
                                {patch.placementLabel || patch.anchorText || patch.targetText}
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

                <div className="mt-2 text-xs text-gray-700 dark:text-gray-300 ai-output line-clamp-4" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(patch.contentMarkdown) }} />

                {patch.reason && (
                    <div className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2">{patch.reason}</div>
                )}

                {patch.applyError && (
                    <div className="mt-1.5 text-[11px] font-semibold text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1">{patch.applyError}</div>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-2">
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
                        onClick={() => handleCopyPatch(patch.id, patch.contentMarkdown)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-gray-100 dark:bg-[#2A2A2A] text-gray-700 dark:text-gray-200 hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20"
                    >
                        <Copy size={13} />
                        {isCopied ? 'تم النسخ' : 'نسخ'}
                    </button>
                    <button
                        type="button"
                        onClick={() => applyAiInsertionPatch(provider, patch.id)}
                        disabled={patch.status !== 'pending'}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold bg-[#d4af37] text-white hover:bg-[#b8922e] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <FilePlus2 size={13} />
                        {actionLabel}
                    </button>
                </div>
            </div>
        );
    };

    const renderAnalysisResult = (provider: AiPatchProvider, result: string) => {
        const patches = aiInsertionPatches[provider];
        if (!patches.length) {
            return <div dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(result) }} />;
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
                    <div key={`text-${lastIndex}`} dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(textChunk) }} />
                );
            }

            const patch = patches.find(item => item.marker === marker || item.title === marker);
            if (patch) {
                usedPatchIds.add(patch.id);
                parts.push(renderPatchCard(provider, patch));
            }
            lastIndex = markerPattern.lastIndex;
        }

        const tail = result.slice(lastIndex);
        if (tail.trim()) {
            parts.push(
                <div key="text-tail" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(tail) }} />
            );
        }

        patches
            .filter(patch => !usedPatchIds.has(patch.id))
            .forEach(patch => parts.push(renderPatchCard(provider, patch)));

        return <>{parts}</>;
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
                                         aiResults.gemini ? renderAnalysisResult('gemini', aiResults.gemini) : <span className="text-gray-400 italic">لا توجد نتائج.</span>}
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
                                         aiResults.chatgpt ? renderAnalysisResult('chatgpt', aiResults.chatgpt) : <span className="text-gray-400 italic">لا توجد نتائج.</span>}
                                    </div>
                                )}
                            </div>
                        </div>
                    </>
                ) : <AIHistoryTab />}
            </div>
        </div>
    );

    const renderCompetitorsTab = () => (
        <div className="flex h-full flex-col">
            <div className="flex-grow overflow-y-auto custom-scrollbar p-4 space-y-4">
                <div>
                    <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100">{tRs.competitors}</h3>
                    <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">{tRs.competitorsHint}</p>
                </div>

                {competitorUrls.map((url, index) => {
                    const extraction = competitorExtractions[index] || createEmptyCompetitorState();
                    const content = extraction.content;
                    const html = competitorHtmls[index] || '';
                    const isLoading = extraction.status === 'loading';
                    const isUrlLoading = isLoading && extraction.source === 'url';
                    const isHtmlLoading = isLoading && extraction.source === 'html';
                    return (
                        <div key={index} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                            <label className="mb-2 block text-xs font-bold text-gray-600 dark:text-gray-300">
                                {tRs.competitorLabel} {index + 1}
                            </label>
                            <div className="space-y-3">
                                <div>
                                    <div className="mb-1 text-[11px] font-bold text-gray-500 dark:text-gray-400">{tRs.competitorUrlField}</div>
                                    <div className="flex items-stretch gap-2">
                                        <input
                                            type="url"
                                            value={url}
                                            onChange={(event) => handleCompetitorUrlChange(index, event.target.value)}
                                            placeholder={tRs.competitorUrlPlaceholder}
                                            className="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-2 py-2 text-xs text-[#333333] outline-none placeholder:text-gray-400 focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100 dark:placeholder:text-gray-500"
                                            dir="ltr"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => handleExtractCompetitorUrl(index)}
                                            disabled={isLoading}
                                            className="flex shrink-0 items-center justify-center gap-1 rounded-md bg-[#d4af37] px-3 py-2 text-xs font-bold text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-60"
                                        >
                                            {isUrlLoading ? <Wand2 size={14} className="animate-spin" /> : <FileSearch size={14} />}
                                            <span>{isUrlLoading ? tRs.extractingCompetitor : tRs.extractCompetitorFromUrl}</span>
                                        </button>
                                    </div>
                                </div>
                                <div>
                                    <div className="mb-1 text-[11px] font-bold text-gray-500 dark:text-gray-400">{tRs.competitorHtmlField}</div>
                                    <textarea
                                        value={html}
                                        onChange={(event) => handleCompetitorHtmlChange(index, event.target.value)}
                                        placeholder={tRs.competitorHtmlPlaceholder}
                                        rows={5}
                                        className="w-full rounded-md border border-gray-300 bg-gray-50 px-2 py-2 font-mono text-[11px] leading-5 text-[#333333] outline-none placeholder:text-gray-400 focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100 dark:placeholder:text-gray-500"
                                        dir="ltr"
                                        spellCheck={false}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => handleExtractCompetitorHtml(index)}
                                        disabled={isLoading}
                                        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-[#d4af37]/40 bg-[#d4af37]/10 px-3 py-2 text-xs font-bold text-[#8a6f1d] hover:bg-[#d4af37]/20 disabled:cursor-not-allowed disabled:opacity-60 dark:text-[#f2d675]"
                                    >
                                        {isHtmlLoading ? <Wand2 size={14} className="animate-spin" /> : <Code2 size={14} />}
                                        <span>{isHtmlLoading ? tRs.extractingCompetitor : tRs.extractCompetitorFromHtml}</span>
                                    </button>
                                </div>
                            </div>

                            {extraction.status === 'error' && (
                                <div className="mt-2 flex items-start gap-2 rounded-md bg-red-50 px-2 py-2 text-[11px] font-semibold text-red-700 dark:bg-red-900/20 dark:text-red-300">
                                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                                    <span>{extraction.error}</span>
                                </div>
                            )}

                            {content && (
                                <div className="mt-3 space-y-3 border-t border-gray-100 pt-3 text-xs dark:border-[#3C3C3C]">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="font-bold text-[#8a6f1d] dark:text-[#f2d675]">{tRs.extractedContent}</span>
                                        <span className="shrink-0 text-[11px] text-gray-400">{content.wordCount} {t.common.words}</span>
                                    </div>
                                    <div className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                                        <div className="mb-2 font-bold text-gray-700 dark:text-gray-200">{tRs.pageTableOfContents}</div>
                                        <div className="max-h-44 overflow-y-auto custom-scrollbar leading-5 text-gray-600 dark:text-gray-300">
                                            {content.headings.h1.length === 0 && content.headings.h2.length === 0 && content.headings.h3.length === 0 ? (
                                                <span className="text-gray-400">{tRs.noTableOfContents}</span>
                                            ) : (
                                                <ul className="space-y-1">
                                                    {content.headings.h1.map((item, itemIndex) => <li key={`h1-${itemIndex}`} className="font-bold">H1: {item}</li>)}
                                                    {content.headings.h2.map((item, itemIndex) => <li key={`h2-${itemIndex}`} className="ps-3">H2: {item}</li>)}
                                                    {content.headings.h3.map((item, itemIndex) => <li key={`h3-${itemIndex}`} className="ps-6 text-gray-500 dark:text-gray-400">H3: {item}</li>)}
                                                </ul>
                                            )}
                                        </div>
                                    </div>
                                    {content.text && (
                                        <div className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                                            <div className="font-bold text-gray-700 dark:text-gray-200">{tRs.fullExtractedText}</div>
                                            <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap custom-scrollbar leading-5 text-gray-600 dark:text-gray-300">
                                                {content.text}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );

    return (
        <aside className="basis-[18.7%] flex flex-col h-full min-w-0 bg-[#F2F3F5] dark:bg-[#1F1F1F] rounded-lg shadow-lg overflow-hidden border-s border-gray-300 dark:border-[#333]">
            <div className="flex border-b border-gray-200 dark:border-[#3C3C3C]">
                {(['structure', 'ai', 'competitors'] as const).map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)} className={`flex-1 py-3 flex justify-center items-center transition-colors ${activeTab === tab ? 'text-[#d4af37] border-b-2 border-[#d4af37] bg-white dark:bg-[#2A2A2A]' : 'text-gray-400 hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/15'}`}>
                        {tab === 'structure' ? <LayoutTemplate size={18} /> : tab === 'ai' ? <BrainCircuit size={18} /> : <Users size={18} />}
                    </button>
                ))}
            </div>
            <div className="flex-grow overflow-y-auto custom-scrollbar">
                {activeTab === 'structure' ? <StructureTab /> : activeTab === 'ai' ? renderAiTab() : renderCompetitorsTab()}
            </div>
        </aside>
    );
};

export default RightSidebar;
