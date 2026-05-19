
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { LayoutTemplate, Sparkles, ChevronDown, BrainCircuit, Wand2, FileSearch, ShieldAlert, Lightbulb, Users, Command, Copy, FilePlus2, LocateFixed, CheckCircle2, AlertTriangle, Code2, FileText } from 'lucide-react';
import StructureTab from './StructureTab';
import AIHistoryTab from './AIHistoryTab';
import { useUser } from '../contexts/UserContext';
import { useAI } from '../contexts/AIContext';
import { parseMarkdownToHtml } from '../utils/editorUtils';
import type { AiAnalysisOptions, AiContentPatch, AiPatchProvider, ReadyCommandAnalysisBatchItem, ReadyCommandAnalysisHistoryMeta } from '../types';
import { CONTENT_SUMMARY_STORAGE_KEY, DEFAULT_SMART_ANALYSIS_OPTIONS, ENGINEERING_PROMPT_DEFINITIONS, ENGINEERING_PROMPT_IDS, getEngineeringPrompt } from '../constants/engineeringPrompts';

type ReadyCommand = {
    id: string;
    label: string;
    value: string;
    options?: Partial<AiAnalysisOptions>;
    skipPatchInstructions?: boolean;
    savesContentSummary?: boolean;
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

type CompetitorExtractionSource = 'url' | 'html' | 'text';

type CompetitorExtractionState = {
    status: 'idle' | 'loading' | 'success' | 'error';
    source?: CompetitorExtractionSource;
    content: CompetitorExtractedContent | null;
    error: string;
};

type StoredContentSummary = {
    summary: string;
    savedAt?: string;
    provider?: string;
    commandId?: string;
    wordCount?: number;
};

type CompetitorComparisonState = {
    status: 'idle' | 'loading' | 'success' | 'error';
    result: string;
    error: string;
};

const COMPETITOR_STORAGE_KEY = 'bazarvan-competitor-links';
const COMPETITOR_HTML_STORAGE_KEY = 'bazarvan-competitor-html-snippets';
const COMPETITOR_TEXT_STORAGE_KEY = 'bazarvan-competitor-text-snippets';
const COMPETITOR_TIMEOUT_MS = 180000;

const createEmptyCompetitorState = (): CompetitorExtractionState => ({
    status: 'idle',
    source: undefined,
    content: null,
    error: '',
});

const createDefaultCompetitorUrls = () => ['', '', ''];
const createDefaultCompetitorHtmls = () => ['', '', ''];
const createDefaultCompetitorTexts = () => ['', '', ''];

const createDefaultCompetitorExtractions = () => [
    createEmptyCompetitorState(),
    createEmptyCompetitorState(),
    createEmptyCompetitorState(),
];

const isCompetitorTextSeparatorLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (trimmed.length < 2) return false;
    return !/[A-Za-z0-9\u0600-\u06FF]/.test(trimmed);
};

const splitBulkCompetitorTexts = (value: string): string[] => {
    const sections: string[] = [];
    let current: string[] = [];

    value.split(/\r?\n/).forEach(line => {
        if (isCompetitorTextSeparatorLine(line)) {
            const section = current.join('\n').trim();
            if (section) sections.push(section);
            current = [];
            return;
        }
        current.push(line);
    });

    const lastSection = current.join('\n').trim();
    if (lastSection) sections.push(lastSection);

    return sections.slice(0, 3);
};

const createEmptyCompetitorComparisonState = (): CompetitorComparisonState => ({
    status: 'idle',
    result: '',
    error: '',
});

const countPromptWords = (value: string): number => value.split(/\s+/).filter(Boolean).length;

const truncatePromptText = (value: string, maxLength = 9000): string => {
    const trimmed = value.trim();
    if (trimmed.length <= maxLength) return trimmed;
    return `${trimmed.slice(0, maxLength).trim()}\n\n[تم اختصار بقية النص لتخفيف حجم الطلب على API.]`;
};

const loadStoredContentSummary = (): StoredContentSummary | null => {
    try {
        const raw = localStorage.getItem(CONTENT_SUMMARY_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string' && parsed.trim()) {
            return { summary: parsed.trim(), wordCount: countPromptWords(parsed) };
        }
        if (!parsed || typeof parsed !== 'object') return null;
        const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
        if (!summary) return null;
        return {
            summary,
            savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
            provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
            commandId: typeof parsed.commandId === 'string' ? parsed.commandId : undefined,
            wordCount: Number.isFinite(Number(parsed.wordCount)) ? Number(parsed.wordCount) : countPromptWords(summary),
        };
    } catch {
        return null;
    }
};

const getSmartAnalysisLabelFallback = (key: string, isArabic: boolean): string => {
    const labels: Record<string, { ar: string; en: string }> = {
        improveConclusion: { ar: 'تحسين الخاتمة', en: 'Improve conclusion' },
        articleTitle: { ar: 'عنوان المقالة', en: 'Article Title' },
        articleToc: { ar: 'جدول المحتويات', en: 'Table of Contents' },
        currentConclusion: { ar: 'الخاتمة الحالية', en: 'Current Conclusion' },
        contentSummaryForCompetitors: { ar: 'تلخيص المحتوى للمنافسين', en: 'Content summary for competitors' },
        competitorGapAnalysis: { ar: 'مقارنة المحتوى مع المنافسين', en: 'Compare content with competitors' },
    };
    return labels[key]?.[isArabic ? 'ar' : 'en'] || key;
};

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

const loadStoredCompetitorTexts = (): string[] => {
    try {
        const parsed = JSON.parse(localStorage.getItem(COMPETITOR_TEXT_STORAGE_KEY) || '[]');
        const snippets = Array.isArray(parsed) ? parsed : [];
        return createDefaultCompetitorTexts().map((_, index) => typeof snippets[index] === 'string' ? snippets[index] : '');
    } catch {
        return createDefaultCompetitorTexts();
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

const stripExtractionLabels = (value: string): string => (
    value
        .split(/\r?\n/)
        .map(line => line
            .replace(/^\s*H[1-6]\s*[:：]\s*/i, '')
            .replace(/^\s*الفقرة\s+(?:الأولى|الثانية|الثالثة|الرابعة|الخامسة|السادسة|السابعة|الثامنة|التاسعة|العاشرة|\d+)\s*[:：]\s*/i, '')
            .replace(/^\s*عنصر\s+قائمة\s*[:：]\s*/i, '')
        )
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
);

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
        text: typeof parsed.text === 'string' ? stripExtractionLabels(parsed.text) : '',
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

const buildHtmlContentText = (blocks: HtmlContentBlock[]): string => {
    const lines: string[] = [];

    blocks.forEach(block => {
        lines.push(block.text);
    });

    return lines.join('\n\n');
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

const normalizePlainCompetitorText = (value: string): string => (
    value
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
);

const extractCompetitorContentFromText = (value: string, fallbackUrl: string): CompetitorExtractedContent => {
    const text = stripExtractionLabels(normalizePlainCompetitorText(value));
    if (!text) {
        throw new Error('أدخل نص المحتوى العادي أولًا.');
    }

    const paragraphs = text
        .split(/\n{2,}|\n/)
        .map(block => normalizeHtmlText(block))
        .filter(Boolean)
        .slice(0, 80);
    const titleCandidate = paragraphs[0] || '';

    return {
        url: fallbackUrl || 'text_input',
        fetchedUrl: fallbackUrl || 'text_input',
        title: titleCandidate.length <= 140 ? titleCandidate : '',
        description: '',
        headings: {
            h1: [],
            h2: [],
            h3: [],
        },
        paragraphs,
        listItems: [],
        text,
        wordCount: text.split(/\s+/).filter(Boolean).length,
    };
};

const buildCompetitorPromptBlocks = (
    competitors: CompetitorExtractedContent[],
    headingPrefix = '##',
): string => (
    competitors.map((competitor, index) => {
        const competitorText = competitor.text || [
            competitor.title,
            competitor.description,
            ...competitor.headings.h1,
            ...competitor.headings.h2,
            ...competitor.headings.h3,
            ...competitor.paragraphs,
            ...competitor.listItems,
        ].filter(Boolean).join('\n\n');

        return `${headingPrefix} المنافس ${index + 1}
الرابط: ${competitor.url || competitor.fetchedUrl || 'غير محدد'}
العنوان: ${competitor.title || 'غير محدد'}
عدد الكلمات المستخرجة: ${competitor.wordCount || countPromptWords(competitorText)}

النص المستخرج من المنافس:
---
${truncatePromptText(competitorText)}
---`;
    }).join('\n\n')
);

const buildCompetitorComparisonPrompt = (
    contentSummary: StoredContentSummary,
    competitors: CompetitorExtractedContent[],
): string => {
    const competitorBlocks = buildCompetitorPromptBlocks(competitors);

    return `أنت محلل محتوى SEO/AEO/GEO صارم.

استخدم ملخص المحتوى الحالي أدناه بدل المقال الكامل، لأن الهدف تقليل حجم الطلب على API.
قارن ملخص المحتوى الحالي مع محتوى المنافسين المستخرج، ولا تطلب النص الكامل للمقال.

ملخص المحتوى الحالي المحفوظ:
---
${truncatePromptText(contentSummary.summary, 12000)}
---

محتوى المنافسين:
${competitorBlocks}

المطلوب:
1. استخرج فجوات المحتوى الحالية مقارنة بالمنافسين.
2. حدد العناوين أو الأفكار أو الكيانات الموجودة عند المنافسين وغير واضحة في المحتوى الحالي.
3. حدد النقاط التي يغطيها المحتوى الحالي أفضل من المنافسين.
4. اقترح إضافات عملية مرتبة حسب الأولوية، مع مكان الإضافة داخل المقال إن أمكن.
5. لا تكرر نصوص المنافسين حرفيًا، ولا تضف معلومات خارج الملخص أو نصوص المنافسين.
6. اجعل النتيجة مختصرة ومنظمة وقابلة للتنفيذ.`;
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
- حقل text يجب أن يحتوي على النص التحريري الكامل كما يظهر للمستخدم فقط.
- لا تكتب أي تسميات توضيحية مثل H1 أو H2 أو H3 أو "الفقرة الأولى" أو "عنصر قائمة".
- لا تكتب نوع الوسم أو اسم الوسم أو أي شرح قبل النص.
- اكتب العناوين كنصوصها الأصلية فقط في أسطر مستقلة.
- اكتب الفقرات كما هي، كل فقرة كمقطع مستقل دون تعديل.
- اكتب عناصر القوائم كنصوصها الأصلية فقط، كل عنصر في سطر مستقل دون أي بادئة توضيحية.
- حافظ على ترتيب النص من الأعلى إلى الأسفل كما يظهر في الصفحة.
- استخدم فواصل الأسطر فقط للحفاظ على قابلية القراءة، دون إضافة أي كلمات غير موجودة في الصفحة.

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
- text: النص التحريري الكامل كما يظهر في الصفحة فقط، بدون تسميات أو شروحات أو أسماء وسوم.
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
        handleGeminiReadyCommandsAnalyze,
        aiResults,
        aiInsertionPatches,
        isAiLoading,
        applyAiInsertionPatch,
        selectAiInsertionPatchTarget,
    } = useAI();
    
    const [activeTab, setActiveTab] = useState<'structure' | 'ai' | 'competitors'>('structure');
    const [aiSubTab, setAiSubTab] = useState<'new' | 'history'>('new');
    const [aiCommand, setAiCommand] = useState('');
    const [bulkCompetitorText, setBulkCompetitorText] = useState('');
    const [competitorUrls, setCompetitorUrls] = useState<string[]>(() => loadStoredCompetitorUrls());
    const [competitorHtmls, setCompetitorHtmls] = useState<string[]>(() => loadStoredCompetitorHtmls());
    const [competitorTexts, setCompetitorTexts] = useState<string[]>(() => loadStoredCompetitorTexts());
    const [competitorExtractions, setCompetitorExtractions] = useState<CompetitorExtractionState[]>(() => createDefaultCompetitorExtractions());
    const [contentSummary, setContentSummary] = useState<StoredContentSummary | null>(() => loadStoredContentSummary());
    const [competitorComparison, setCompetitorComparison] = useState<CompetitorComparisonState>(() => createEmptyCompetitorComparisonState());
    const [selectedReadyCommandIds, setSelectedReadyCommandIds] = useState<string[]>([]);
    const [isGeminiExpanded, setIsGeminiExpanded] = useState(true);
    const [isChatGptExpanded, setIsChatGptExpanded] = useState(false);
    const [copiedPatchId, setCopiedPatchId] = useState('');
    
    // Custom Dropdown State
    const [isCommandsMenuOpen, setIsCommandsMenuOpen] = useState(false);
    const commandsMenuRef = useRef<HTMLDivElement>(null);
    const clearReadyCommandSelectionOnNextOpenRef = useRef(false);

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
        const handleAutoDistributedCompetitors = (event: Event) => {
            const urls = (event as CustomEvent<{ urls?: string[] }>).detail?.urls || [];
            const normalizedUrls = urls.map(url => url.trim()).filter(Boolean).slice(0, 3);
            if (normalizedUrls.length === 0) return;

            setCompetitorUrls(prev => createDefaultCompetitorUrls().map((_, index) => normalizedUrls[index] || prev[index] || ''));
            setCompetitorExtractions(prev => createDefaultCompetitorExtractions().map((emptyState, index) => (
                normalizedUrls[index] ? emptyState : prev[index] || emptyState
            )));
        };

        window.addEventListener('bazarvan:auto-distribute-competitors', handleAutoDistributedCompetitors);
        return () => {
            window.removeEventListener('bazarvan:auto-distribute-competitors', handleAutoDistributedCompetitors);
        };
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(COMPETITOR_HTML_STORAGE_KEY, JSON.stringify(competitorHtmls));
        } catch (error) {
            console.error('Could not save competitor HTML snippets:', error);
        }
    }, [competitorHtmls]);

    useEffect(() => {
        try {
            localStorage.setItem(COMPETITOR_TEXT_STORAGE_KEY, JSON.stringify(competitorTexts));
        } catch (error) {
            console.error('Could not save competitor text snippets:', error);
        }
    }, [competitorTexts]);

    useEffect(() => {
        const refreshSummary = () => setContentSummary(loadStoredContentSummary());
        window.addEventListener('bazarvan:content-summary-updated', refreshSummary);
        window.addEventListener('storage', refreshSummary);
        return () => {
            window.removeEventListener('bazarvan:content-summary-updated', refreshSummary);
            window.removeEventListener('storage', refreshSummary);
        };
    }, []);

    const readyCommands: ReadyCommand[] = useMemo(() => {
        const isArabic = t.locale === 'ar';
        return ENGINEERING_PROMPT_DEFINITIONS
            .filter(definition => definition.source === 'smartAnalysis')
            .map(definition => ({
                id: definition.id,
                label: (tRs as any)[definition.labelKey] || getSmartAnalysisLabelFallback(definition.labelKey, isArabic),
                value: getEngineeringPrompt(engineeringPrompts, definition.id),
                options: definition.options,
                skipPatchInstructions: definition.skipPatchInstructions,
                savesContentSummary: definition.savesContentSummary,
            }));
    }, [engineeringPrompts, t.locale, tRs]);

    const getReadyCommandOptions = (command: ReadyCommand): AiAnalysisOptions => ({
        ...DEFAULT_SMART_ANALYSIS_OPTIONS,
        ...(command.options || {}),
    });

    const selectedReadyCommands = useMemo(
        () => selectedReadyCommandIds
            .map(id => readyCommands.find(command => command.id === id))
            .filter((command): command is ReadyCommand => Boolean(command)),
        [readyCommands, selectedReadyCommandIds]
    );

    const readyCommandCompetitorBlocks = useMemo(() => {
        const competitors = competitorExtractions
            .map(item => item.content)
            .filter((content): content is CompetitorExtractedContent => Boolean(content?.text?.trim()));
        return buildCompetitorPromptBlocks(competitors, '###');
    }, [competitorExtractions]);

    const getReadyCommandPrompt = (command: ReadyCommand): string => {
        if (command.id !== ENGINEERING_PROMPT_IDS.smartAnalysis.competitorGapAnalysis) {
            return command.value;
        }

        return `${command.value}

محتوى المنافسين المرفقين:
${readyCommandCompetitorBlocks || 'لا يوجد محتوى منافسين مستخرج بعد. أضف محتوى المنافسين من تبويب المنافسين قبل تشغيل هذا الأمر.'}`;
    };

    useEffect(() => {
        setSelectedReadyCommandIds(prev => {
            const availableIds = new Set(readyCommands.map(command => command.id));
            const next = prev.filter(id => availableIds.has(id));
            return next.length === prev.length ? prev : next;
        });
    }, [readyCommands]);

    useEffect(() => {
        if (selectedReadyCommands.length === 0) return;
        if (selectedReadyCommands.length === 1) {
            const selectedCommand = selectedReadyCommands[0];
            setAiCommand(getReadyCommandPrompt(selectedCommand));
            setAiOptions(getReadyCommandOptions(selectedCommand));
            return;
        }

        setAiCommand(selectedReadyCommands
            .map((command, index) => `### ${index + 1}. ${command.label}\n${getReadyCommandPrompt(command)}`)
            .join('\n\n')
        );
        setAiOptions(selectedReadyCommands.reduce(
            (merged, command) => ({ ...merged, ...(command.options || {}) }),
            { ...DEFAULT_SMART_ANALYSIS_OPTIONS }
        ));
    }, [selectedReadyCommands, readyCommandCompetitorBlocks]);

    const selectedReadyCommand = selectedReadyCommands.length === 1 ? selectedReadyCommands[0] : null;

    const readyCommandHistoryMeta: ReadyCommandAnalysisHistoryMeta | undefined = selectedReadyCommand
        ? {
            commandId: selectedReadyCommand.id,
            commandLabel: selectedReadyCommand.label,
            skipPatchInstructions: selectedReadyCommand.skipPatchInstructions,
            savesContentSummary: selectedReadyCommand.savesContentSummary,
        }
        : undefined;

    const readyCommandBatchItems: ReadyCommandAnalysisBatchItem[] = selectedReadyCommands.map(command => ({
        commandId: command.id,
        commandLabel: command.label,
        userPrompt: getReadyCommandPrompt(command),
        options: getReadyCommandOptions(command),
        skipPatchInstructions: command.skipPatchInstructions,
        savesContentSummary: command.savesContentSummary,
    }));

    const selectedReadyCommandsLabel = selectedReadyCommands.length === 0
        ? tRs.selectCommand
        : selectedReadyCommands.length === 1
            ? selectedReadyCommands[0].label
            : t.locale === 'ar'
                ? `${selectedReadyCommands.length} أوامر محددة`
                : `${selectedReadyCommands.length} commands selected`;

    const getCommandIcon = (commandId: string) => {
        const iconClass = 'text-[#d4af37]';
        switch (commandId) {
            case ENGINEERING_PROMPT_IDS.smartAnalysis.entityMap:
                return <BrainCircuit size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.fullArticleAudit:
                return <FileSearch size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.contentSummaryForCompetitors:
                return <FileText size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.competitorGapAnalysis:
                return <Users size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.improveConclusion:
                return <FilePlus2 size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.improveWeakest:
                return <ShieldAlert size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.suggestNewIdea:
                return <Lightbulb size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.peopleQuestions:
                return <Users size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.structuredContent:
                return <LayoutTemplate size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.unsuitableSections:
                return <LocateFixed size={16} className={iconClass} />;
            default:
                return <Command size={16} className={iconClass} />;
        }
    };

    const handleCommandSelect = (command: ReadyCommand) => {
        setSelectedReadyCommandIds(prev => (
            prev.includes(command.id)
                ? prev.filter(id => id !== command.id)
                : [...prev, command.id]
        ));
    };

    const handleReadyCommandsMenuToggle = () => {
        const shouldOpen = !isCommandsMenuOpen;
        if (shouldOpen && clearReadyCommandSelectionOnNextOpenRef.current) {
            setSelectedReadyCommandIds([]);
            clearReadyCommandSelectionOnNextOpenRef.current = false;
        }
        setIsCommandsMenuOpen(shouldOpen);
    };

    const handleOptionChange = (key: keyof typeof aiOptions) => {
        setAiOptions(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const handleRunGeminiAnalysis = () => {
        if (selectedReadyCommands.length > 0) {
            clearReadyCommandSelectionOnNextOpenRef.current = true;
        }
        if (selectedReadyCommands.length > 1) {
            handleGeminiReadyCommandsAnalyze(readyCommandBatchItems);
            return;
        }

        handleAiAnalyze(aiCommand, aiOptions, readyCommandHistoryMeta);
    };

    const handleRunChatGptAnalysis = () => {
        if (selectedReadyCommands.length > 0) {
            clearReadyCommandSelectionOnNextOpenRef.current = true;
        }
        handleChatGptAnalyze(
            aiCommand,
            aiOptions,
            selectedReadyCommands.length === 1 ? readyCommandHistoryMeta : undefined
        );
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

    const handleCompetitorTextChange = (index: number, value: string) => {
        setCompetitorTexts(prev => prev.map((text, textIndex) => textIndex === index ? value : text));
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? createEmptyCompetitorState() : item));
    };

    const handleBulkCompetitorTextDistribute = (value: string) => {
        const sections = splitBulkCompetitorTexts(value);
        if (sections.length === 0) return;

        setCompetitorTexts(prev => createDefaultCompetitorTexts().map((_, index) => sections[index] || prev[index] || ''));
        setCompetitorExtractions(prev => createDefaultCompetitorExtractions().map((emptyState, index) => (
            sections[index] ? emptyState : prev[index] || emptyState
        )));
    };

    const handleBulkCompetitorTextPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        event.preventDefault();
        const pastedText = event.clipboardData.getData('text');
        handleBulkCompetitorTextDistribute(pastedText);
        setBulkCompetitorText('');
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

    const handleExtractCompetitorText = (index: number) => {
        const text = competitorTexts[index]?.trim();
        if (!text) {
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'error',
                source: 'text',
                content: null,
                error: tRs.competitorPlainTextRequired,
            } : item));
            return;
        }

        const fallbackUrl = competitorUrls[index]?.trim() || 'text_input';
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            status: 'loading',
            source: 'text',
            error: '',
        } : item));

        window.setTimeout(() => {
            try {
                const content = extractCompetitorContentFromText(text, fallbackUrl);
                setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                    status: 'success',
                    source: 'text',
                    content,
                    error: '',
                } : item));
            } catch (error) {
                setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                    status: 'error',
                    source: 'text',
                    content: null,
                    error: error instanceof Error ? error.message : tRs.competitorExtractionFailed,
                } : item));
            }
        }, 0);
    };

    const handleCompareCompetitors = async () => {
        const summary = contentSummary?.summary.trim();
        if (!summary) {
            setCompetitorComparison({
                status: 'error',
                result: '',
                error: tRs.competitorComparisonNoSummary,
            });
            return;
        }

        const competitors = competitorExtractions
            .map(item => item.content)
            .filter((content): content is CompetitorExtractedContent => Boolean(content?.text?.trim()));

        if (competitors.length === 0) {
            setCompetitorComparison({
                status: 'error',
                result: '',
                error: tRs.competitorComparisonNoContent,
            });
            return;
        }

        setCompetitorComparison({ status: 'loading', result: '', error: '' });

        try {
            const response = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: buildCompetitorComparisonPrompt({ ...contentSummary, summary }, competitors),
                    apiKeys: apiKeys.gemini.filter(Boolean),
                    useUrlContext: false,
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (response.status === 404) {
                throw new Error(tRs.competitorApiUnavailable);
            }
            if (!response.ok) {
                throw new Error(data.error || `${tRs.competitorComparisonFailed} (${response.status})`);
            }
            const result = typeof data.text === 'string' ? data.text.trim() : '';
            if (!result) {
                throw new Error(tRs.competitorComparisonFailed);
            }
            setCompetitorComparison({ status: 'success', result, error: '' });
        } catch (error) {
            setCompetitorComparison({
                status: 'error',
                result: '',
                error: error instanceof Error ? error.message : tRs.competitorComparisonFailed,
            });
        }
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
                                onClick={handleReadyCommandsMenuToggle}
                                className="w-full flex items-center justify-between p-2.5 bg-white dark:bg-[#1F1F1F] border border-gray-300 dark:border-[#3C3C3C] rounded-lg text-sm text-start focus:outline-none focus:ring-1 focus:ring-[#d4af37] shadow-sm transition-all"
                            >
                                <span className="truncate text-gray-700 dark:text-gray-200 font-medium flex items-center gap-2">
                                    {selectedReadyCommands.length > 0 ? (
                                        <>
                                            {selectedReadyCommands.length === 1
                                                ? getCommandIcon(selectedReadyCommands[0].id)
                                                : <Command size={16} className="text-[#d4af37]" />}
                                            <span>{selectedReadyCommandsLabel}</span>
                                        </>
                                    ) : (
                                        <span className="text-gray-500">{tRs.selectCommand}</span>
                                    )}
                                </span>
                                <ChevronDown size={16} className={`transition-transform duration-200 text-gray-500 ${isCommandsMenuOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {isCommandsMenuOpen && (
                                <div className="absolute z-20 mt-2 w-full bg-white dark:bg-[#2A2A2A] border border-gray-200 dark:border-[#3C3C3C] rounded-lg shadow-xl max-h-60 overflow-y-auto custom-scrollbar ring-1 ring-black ring-opacity-5">
                                    {readyCommands.map((cmd) => {
                                        const isSelected = selectedReadyCommandIds.includes(cmd.id);
                                        return (
                                        <button
                                            key={cmd.id}
                                            onClick={() => handleCommandSelect(cmd)}
                                            className={`w-full text-start px-3 py-2.5 text-sm transition-colors flex items-center gap-3 border-b border-gray-50 dark:border-[#333] last:border-0 ${
                                                isSelected
                                                    ? 'bg-[#d4af37]/10 text-[#8a6f1d] dark:bg-[#d4af37]/20 dark:text-[#f2d675]'
                                                    : 'text-gray-700 dark:text-gray-200 hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20'
                                            }`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={isSelected}
                                                readOnly
                                                className="rounded border-gray-300 text-[#d4af37] focus:ring-[#d4af37]"
                                                tabIndex={-1}
                                            />
                                            {getCommandIcon(cmd.id)}
                                            <span>{cmd.label}</span>
                                        </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{tRs.aiCommand}</label>
                            <textarea
                                value={aiCommand}
                                onChange={(e) => setAiCommand(e.target.value)}
                                rows={selectedReadyCommands.length > 1 ? 6 : 4}
                                readOnly={selectedReadyCommands.length > 1}
                                className={`w-full p-2 bg-white dark:bg-[#1F1F1F] border border-gray-300 dark:border-[#3C3C3C] rounded-md text-sm resize-none text-[#333333] dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] ${selectedReadyCommands.length > 1 ? 'cursor-default bg-gray-50 dark:bg-[#1F1F1F]/80' : ''}`}
                                placeholder={tRs.aiPlaceholder}
                            />
                            {selectedReadyCommands.length > 1 && (
                                <p className="mt-1.5 text-[11px] leading-5 text-gray-500 dark:text-gray-400">
                                    {t.locale === 'ar'
                                        ? `سيتم إرسال ${selectedReadyCommands.length} أوامر إلى Gemini دفعة واحدة، مع توزيعها على ${Math.max(1, apiKeys.gemini.filter(Boolean).length)} مفاتيح API متاحة.`
                                        : `${selectedReadyCommands.length} commands will be sent to Gemini together, distributed across ${Math.max(1, apiKeys.gemini.filter(Boolean).length)} available API keys.`}
                                </p>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            {Object.keys(aiOptions).map((opt) => (
                                <label key={opt} className="flex items-center gap-2 text-xs cursor-pointer text-gray-600 dark:text-gray-400">
                                    <input type="checkbox" checked={(aiOptions as any)[opt]} onChange={() => handleOptionChange(opt as any)} className="rounded text-[#d4af37]" />
                                    {(tRs as any)[opt] || getSmartAnalysisLabelFallback(opt, t.locale === 'ar')}
                                </label>
                            ))}
                        </div>

                        <div className="flex flex-col gap-2">
                            <div className="grid grid-cols-2 gap-2">
                                <button onClick={handleRunGeminiAnalysis} disabled={isAiLoading.gemini} className="flex items-center justify-center gap-2 py-2 bg-[#d4af37] text-white rounded-lg hover:bg-[#b8922e] disabled:opacity-50">
                                    {isAiLoading.gemini ? <Wand2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                    <span className="text-xs font-bold">
                                        {selectedReadyCommands.length > 0
                                            ? (t.locale === 'ar' ? 'Gemini الافتراضي للأوامر' : 'Gemini default for commands')
                                            : 'Gemini'}
                                    </span>
                                </button>
                                <button onClick={handleRunChatGptAnalysis} disabled={isAiLoading.chatgpt} className="flex items-center justify-center gap-2 py-2 bg-[#d4af37] text-white rounded-lg hover:bg-[#b8922e] disabled:opacity-50">
                                    {isAiLoading.chatgpt ? <Wand2 size={16} className="animate-spin" /> : <BrainCircuit size={16} />}
                                    <span className="text-xs font-bold">ChatGPT</span>
                                </button>
                            </div>
                        </div>

                        <div className="-mx-3 space-y-2 pt-3 border-t border-gray-200 dark:border-[#3C3C3C]">
                            {/* Results Gemini */}
                            <div className="bg-[#d4af37]/10 dark:bg-[#d4af37]/10 rounded-md overflow-hidden border border-[#d4af37]/20 dark:border-[#d4af37]/25">
                                <div className="p-2 bg-[#d4af37]/15 dark:bg-[#d4af37]/20 flex justify-between cursor-pointer" onClick={() => setIsGeminiExpanded(!isGeminiExpanded)}>
                                    <span className="text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">نتائج Gemini</span>
                                    <ChevronDown size={14} className={isGeminiExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isGeminiExpanded && (
                                    <div className="p-2 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {isAiLoading.gemini ? <div className="flex gap-2 animate-pulse text-[#d4af37]"><Wand2 size={14} /> جاري التفكير...</div> :
                                         aiResults.gemini ? renderAnalysisResult('gemini', aiResults.gemini) : <span className="text-gray-400 italic">لا توجد نتائج.</span>}
                                    </div>
                                )}
                            </div>
                            {/* Results ChatGPT */}
                            <div className="bg-[#d4af37]/10 dark:bg-[#d4af37]/10 rounded-md overflow-hidden border border-[#d4af37]/20 dark:border-[#d4af37]/25">
                                <div className="p-2 bg-[#d4af37]/15 dark:bg-[#d4af37]/20 flex justify-between cursor-pointer" onClick={() => setIsChatGptExpanded(!isChatGptExpanded)}>
                                    <span className="text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">نتائج ChatGPT</span>
                                    <ChevronDown size={14} className={isChatGptExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isChatGptExpanded && (
                                    <div className="p-2 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
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

                <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <div>
                            <div className="text-xs font-bold text-gray-700 dark:text-gray-200">
                                {t.locale === 'ar' ? 'توزيع نصوص المنافسين' : 'Distribute competitor texts'}
                            </div>
                            <p className="mt-1 text-[11px] leading-5 text-gray-500 dark:text-gray-400">
                                {t.locale === 'ar'
                                    ? 'الصق نصوص المنافسين مفصولة بأسطر رموز فقط مثل -- أو ** أو // أو == أو .. أو ،، وسيتم تعبئة خانات النص العادي فقط.'
                                    : 'Paste competitor texts separated by symbol-only lines such as --, **, //, ==, .., or ،،. Only plain text fields will be filled.'}
                            </p>
                        </div>
                    </div>
                    <textarea
                        value={bulkCompetitorText}
                        onChange={(event) => setBulkCompetitorText(event.target.value)}
                        onPaste={handleBulkCompetitorTextPaste}
                        placeholder={t.locale === 'ar'
                            ? 'نص المنافس الأول...\n--\nنص المنافس الثاني...\n**\nنص المنافس الثالث...'
                            : 'First competitor text...\n--\nSecond competitor text...\n**\nThird competitor text...'}
                        rows={5}
                        className="w-full resize-y rounded-md border border-gray-300 bg-gray-50 px-2 py-2 text-xs leading-5 text-[#333333] outline-none placeholder:text-gray-400 focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100 dark:placeholder:text-gray-500"
                        dir="auto"
                    />
                    <button
                        type="button"
                        onClick={() => {
                            handleBulkCompetitorTextDistribute(bulkCompetitorText);
                            setBulkCompetitorText('');
                        }}
                        disabled={!bulkCompetitorText.trim()}
                        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-[#d4af37]/40 bg-[#d4af37]/10 px-3 py-2 text-xs font-bold text-[#8a6f1d] hover:bg-[#d4af37]/20 disabled:cursor-not-allowed disabled:opacity-60 dark:text-[#f2d675]"
                    >
                        <FileText size={14} />
                        <span>{t.locale === 'ar' ? 'تعبئة النصوص العادية' : 'Fill plain text fields'}</span>
                    </button>
                </div>

                <div className="rounded-lg border border-[#d4af37]/25 bg-[#d4af37]/10 p-3 dark:border-[#d4af37]/30 dark:bg-[#d4af37]/10">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">
                                <FileText size={14} />
                                <span>{tRs.contentSummaryForCompetitors}</span>
                            </div>
                            <p className="mt-1 text-[11px] leading-5 text-gray-600 dark:text-gray-300">
                                {contentSummary
                                    ? `${tRs.contentSummarySaved} ${contentSummary.wordCount || countPromptWords(contentSummary.summary)} ${t.common.words}${contentSummary.savedAt ? ` - ${new Date(contentSummary.savedAt).toLocaleString()}` : ''}`
                                    : tRs.contentSummaryMissing}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={handleCompareCompetitors}
                            disabled={competitorComparison.status === 'loading' || !contentSummary || !competitorExtractions.some(item => item.content?.text?.trim())}
                            className="flex shrink-0 items-center justify-center gap-1 rounded-md bg-[#d4af37] px-3 py-2 text-xs font-bold text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {competitorComparison.status === 'loading' ? <Wand2 size={14} className="animate-spin" /> : <FileSearch size={14} />}
                            <span>{competitorComparison.status === 'loading' ? tRs.comparingCompetitors : tRs.compareWithCompetitors}</span>
                        </button>
                    </div>
                    {contentSummary?.summary && (
                        <div className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md bg-white/70 p-2 text-[11px] leading-5 text-gray-600 custom-scrollbar dark:bg-[#1F1F1F]/70 dark:text-gray-300">
                            {contentSummary.summary}
                        </div>
                    )}
                    {competitorComparison.status === 'error' && (
                        <div className="mt-2 flex items-start gap-2 rounded-md bg-red-50 px-2 py-2 text-[11px] font-semibold text-red-700 dark:bg-red-900/20 dark:text-red-300">
                            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                            <span>{competitorComparison.error}</span>
                        </div>
                    )}
                    {competitorComparison.status === 'success' && competitorComparison.result && (
                        <div className="mt-3 rounded-md bg-white/80 p-2 text-xs text-gray-700 ai-output dark:bg-[#1F1F1F]/80 dark:text-gray-300">
                            <div className="mb-2 font-bold text-[#8a6f1d] dark:text-[#f2d675]">{tRs.competitorComparisonResult}</div>
                            <div dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(competitorComparison.result) }} />
                        </div>
                    )}
                </div>

                {competitorUrls.map((url, index) => {
                    const extraction = competitorExtractions[index] || createEmptyCompetitorState();
                    const content = extraction.content;
                    const html = competitorHtmls[index] || '';
                    const plainText = competitorTexts[index] || '';
                    const isLoading = extraction.status === 'loading';
                    const isUrlLoading = isLoading && extraction.source === 'url';
                    const isHtmlLoading = isLoading && extraction.source === 'html';
                    const isTextLoading = isLoading && extraction.source === 'text';
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
                                <div>
                                    <div className="mb-1 text-[11px] font-bold text-gray-500 dark:text-gray-400">{tRs.competitorPlainTextField}</div>
                                    <textarea
                                        value={plainText}
                                        onChange={(event) => handleCompetitorTextChange(index, event.target.value)}
                                        placeholder={tRs.competitorPlainTextPlaceholder}
                                        rows={5}
                                        className="w-full resize-y rounded-md border border-gray-300 bg-gray-50 px-2 py-2 text-xs leading-5 text-[#333333] outline-none placeholder:text-gray-400 focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100 dark:placeholder:text-gray-500"
                                        dir="auto"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => handleExtractCompetitorText(index)}
                                        disabled={isLoading}
                                        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-xs font-bold text-gray-700 hover:border-[#d4af37]/50 hover:bg-[#d4af37]/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-200 dark:hover:border-[#d4af37]/50 dark:hover:bg-[#d4af37]/15"
                                    >
                                        {isTextLoading ? <Wand2 size={14} className="animate-spin" /> : <FileText size={14} />}
                                        <span>{isTextLoading ? tRs.extractingCompetitor : tRs.extractCompetitorFromText}</span>
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
