
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { BadgeDollarSign, LayoutTemplate, Sparkles, ChevronDown, BrainCircuit, Wand2, FileSearch, ShieldAlert, Lightbulb, Users, Command, Copy, FilePlus2, LocateFixed, CheckCircle2, AlertTriangle, FileText, Trash2, ExternalLink, ClipboardPaste } from 'lucide-react';
import StructureTab from './StructureTab';
import { useUser } from '../contexts/UserContext';
import { useAISelector } from '../contexts/AIContext';
import { useEditorSelector } from '../contexts/EditorContext';
import { copyMarkdownToClipboard, parseMarkdownToHtml } from '../utils/editorUtils';
import { COMPETITOR_HTML_STORAGE_KEY, COMPETITOR_RESET_EVENT, COMPETITOR_TEXT_STORAGE_KEY, COMPETITOR_URLS_STORAGE_KEY } from '../utils/competitorStorage';
import type { StoredCompetitorInputs } from '../utils/competitorStorage';
import type { AiAnalysisOptions, AiContentPatch, AiPatchProvider, ReadyCommandAnalysisBatchItem, ReadyCommandAnalysisHistoryMeta } from '../types';
import { GEMINI_FREE_MODEL_VALUES, GEMINI_PAID_ANALYSIS_MODEL } from '../constants/aiModels';
import {
    buildGeminiFreeModelOptions,
    GEMINI_FREE_MODEL_CHANGED_EVENT,
    getSelectedGeminiFreeModel,
    isGeminiFreeModelFallbackEnabled,
    normalizeGeminiFreeModel,
} from '../utils/geminiModelPreference';
import { DEFAULT_SMART_ANALYSIS_OPTIONS, ENGINEERING_PROMPT_DEFINITIONS, ENGINEERING_PROMPT_IDS, getEngineeringPrompt } from '../constants/engineeringPrompts';
import GeminiProgressStatus from './GeminiProgressStatus';
import { runGeminiAnalysisEngine, type GeminiProgressSnapshot } from '../utils/geminiAnalysisEngine';

const AIHistoryTab = React.lazy(() => import('./AIHistoryTab'));
const ExternalAnalysisResultsTab = React.lazy(() => import('./ExternalAnalysisResultsTab'));

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

type LocalGeminiProgressSnapshot = GeminiProgressSnapshot & {
    active?: boolean;
};

type CompetitorRepeatedPhrase = {
    text: string;
    size: number;
    count: number;
};

type CompetitorWordFrequency = {
    word: string;
    count: number;
};

type CompetitorTextStats = {
    totalWords: number;
    uniqueWords: number;
    topWords: CompetitorWordFrequency[];
    repeatedPhrases: CompetitorRepeatedPhrase[];
};

const COMPETITOR_STOP_WORDS = new Set([
    'في', 'من', 'إلى', 'الى', 'عن', 'على', 'علي', 'مع', 'حتى', 'ثم', 'أو', 'او', 'أم', 'ام', 'بل', 'لا', 'نعم',
    'و', 'ف', 'ب', 'ك', 'ل', 'لل', 'والى', 'وإلى', 'ومن', 'وعلى', 'وفي', 'عنها', 'عنه', 'منها', 'منه',
    'الذي', 'التي', 'الذين', 'اللذين', 'اللتين', 'اللاتي', 'اللواتي', 'هذا', 'هذه', 'ذلك', 'تلك', 'هؤلاء', 'أولئك',
    'هو', 'هي', 'هما', 'هم', 'هن', 'أنا', 'انا', 'نحن', 'أنت', 'انت', 'أنتم', 'انتم', 'أنتن', 'انتن', 'أنتما', 'انتما',
    'كان', 'كانت', 'كانوا', 'يكون', 'تكون', 'يتم', 'تم', 'قد', 'لقد', 'إن', 'ان', 'أن', 'الى', 'كما', 'كل', 'أي', 'اي',
    'غير', 'سوى', 'ما', 'ماذا', 'لماذا', 'كيف', 'متى', 'أين', 'اين', 'إذا', 'اذا', 'لكن', 'لذلك', 'لذا',
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by', 'at', 'as', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'it', 'its', 'you', 'your', 'we', 'our',
]);

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

const countPromptWords = (value: string): number => value.split(/\s+/).filter(Boolean).length;

const truncatePromptText = (value: string, maxLength = 9000): string => {
    const trimmed = value.trim();
    if (trimmed.length <= maxLength) return trimmed;
    return `${trimmed.slice(0, maxLength).trim()}\n\n[تم اختصار بقية النص لتخفيف حجم الطلب على API.]`;
};

const formatCompetitorEvidenceParagraphs = (value: string): string => {
    const paragraphs = truncatePromptText(value)
        .split(/\n{2,}/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean);

    return paragraphs
        .map((paragraph, index) => `[فقرة ${index + 1}] ${paragraph}`)
        .join('\n\n');
};

const getSmartAnalysisLabelFallback = (key: string, isArabic: boolean): string => {
    const labels: Record<string, { ar: string; en: string }> = {
        improveConclusion: { ar: 'تحسين الخاتمة', en: 'Improve conclusion' },
        articleTitle: { ar: 'عنوان المقالة', en: 'Article Title' },
        articleToc: { ar: 'جدول المحتويات', en: 'Table of Contents' },
        currentConclusion: { ar: 'الخاتمة الحالية', en: 'Current Conclusion' },
        contentSummaryForCompetitors: { ar: 'تلخيص المحتوى للمنافسين', en: 'Content summary for competitors' },
        competitorGapAnalysis: { ar: 'مقارنة محتوى المنافسين', en: 'Compare content with competitors' },
        competitorContentComparison: { ar: 'أفكار جديدة/متضاربة مع منافسين', en: 'New/conflicting competitor ideas' },
        combinedCommands: { ar: 'تجميعة أوامر', en: 'Commands bundle' },
        repetitionAndFillerAudit: { ar: 'اكتشاف التكرار والحشو', en: 'Repetition and filler audit' },
        articleSectionOrder: { ar: 'ترتيب الأقسام', en: 'Section order analysis' },
    };
    return labels[key]?.[isArabic ? 'ar' : 'en'] || key;
};

const READY_COMMAND_DISPLAY_ORDER = [
    ENGINEERING_PROMPT_IDS.smartAnalysis.competitorContentComparison,
    ENGINEERING_PROMPT_IDS.smartAnalysis.competitorGapAnalysis,
    ENGINEERING_PROMPT_IDS.smartAnalysis.combinedCommands,
    ENGINEERING_PROMPT_IDS.smartAnalysis.repetitionAndFillerAudit,
    ENGINEERING_PROMPT_IDS.smartAnalysis.fullArticleAudit,
];

const getReadyCommandDisplayOrder = (id: string): number => {
    const index = READY_COMMAND_DISPLAY_ORDER.indexOf(id as typeof READY_COMMAND_DISPLAY_ORDER[number]);
    return index === -1 ? READY_COMMAND_DISPLAY_ORDER.length : index;
};

const loadStoredCompetitorUrls = (): string[] => {
    try {
        const parsed = JSON.parse(localStorage.getItem(COMPETITOR_URLS_STORAGE_KEY) || '[]');
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

const normalizeCompetitorToken = (value: string): string => (
    value
        .normalize('NFKC')
        .replace(/[ًٌٍَُِّْـ]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .toLowerCase()
);

const tokenizeCompetitorText = (value: string): string[] => (
    normalizePlainCompetitorText(value)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/)
        .map(normalizeCompetitorToken)
        .filter(Boolean)
);

const collectCompetitorStatTexts = (
    plainTexts: string[],
    extractions: CompetitorExtractionState[],
): string[] => {
    const texts: string[] = [];

    plainTexts.forEach(value => {
        const text = stripExtractionLabels(normalizePlainCompetitorText(value));
        if (text) texts.push(text);
    });

    extractions.forEach(extraction => {
        const text = extraction.content?.text?.trim();
        if (text) texts.push(stripExtractionLabels(text));
    });

    return texts.filter(Boolean);
};

const createCompetitorTextStats = (
    plainTexts: string[],
    extractions: CompetitorExtractionState[],
): CompetitorTextStats => {
    const words = collectCompetitorStatTexts(plainTexts, extractions).flatMap(tokenizeCompetitorText);
    const wordCounts = new Map<string, number>();
    const filteredWordCounts = new Map<string, number>();
    const phraseCounts = new Map<string, { size: number; count: number }>();

    words.forEach(word => {
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
        if (word.length > 1 && !COMPETITOR_STOP_WORDS.has(word)) {
            filteredWordCounts.set(word, (filteredWordCounts.get(word) || 0) + 1);
        }
    });

    [3, 4, 5].forEach(size => {
        for (let index = 0; index <= words.length - size; index += 1) {
            const phrase = words.slice(index, index + size).join(' ');
            phraseCounts.set(phrase, {
                size,
                count: (phraseCounts.get(phrase)?.count || 0) + 1,
            });
        }
    });

    const topWords = Array.from(filteredWordCounts.entries())
        .map(([word, count]) => ({ word, count }))
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
        .slice(0, 5);

    const repeatedPhrases = Array.from(phraseCounts.entries())
        .map(([text, value]) => ({ text, size: value.size, count: value.count }))
        .filter(item => item.count > 1)
        .sort((a, b) => b.count - a.count || a.size - b.size || a.text.localeCompare(b.text));

    return {
        totalWords: words.length,
        uniqueWords: wordCounts.size,
        topWords,
        repeatedPhrases,
    };
};

const loadStoredCompetitorExtractions = (): CompetitorExtractionState[] => {
    return createDefaultCompetitorExtractions();
};

const buildReadyCommandCompetitorBlocks = (
    extractions: CompetitorExtractionState[],
    plainTexts: string[],
    urls: string[],
): string => {
    const blocks: string[] = [];

    plainTexts.forEach((value, index) => {
        const text = stripExtractionLabels(normalizePlainCompetitorText(value));
        if (!text) return;

        blocks.push(`### المنافس ${index + 1} - محتوى نص عادي
الرابط: ${urls[index]?.trim() || 'غير محدد'}
عدد الكلمات: ${countPromptWords(text)}
طريقة الاستشهاد عند استخدام فكرة من هذا النص: المصدر: المنافس ${index + 1}؛ فقرة الدليل: [فقرة رقمها] مقتطف قصير من الفقرة.

النص مرقم الفقرات:
---
${formatCompetitorEvidenceParagraphs(text)}
---`);
    });

    extractions.forEach((extraction, index) => {
        if (extraction.source !== 'html') return;
        const content = extraction.content;
        const extractedText = content?.text?.trim();
        if (!content || !extractedText) return;

        blocks.push(`### المنافس ${index + 1} - المحتوى المستخرج من كود HTML
الرابط: ${content.url || content.fetchedUrl || urls[index]?.trim() || 'غير محدد'}
العنوان: ${content.title || 'غير محدد'}
عدد الكلمات المستخرجة: ${content.wordCount || countPromptWords(extractedText)}
طريقة الاستشهاد عند استخدام فكرة من هذا النص: المصدر: المنافس ${index + 1}؛ فقرة الدليل: [فقرة رقمها] مقتطف قصير من الفقرة.

النص المستخرج مرقم الفقرات:
---
${formatCompetitorEvidenceParagraphs(extractedText)}
---`);
    });

    return blocks.join('\n\n');
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
    const { t, engineeringPrompts, chatGptOpenMode } = useUser();
    const setIsStructureTabActive = useEditorSelector(context => context.setIsStructureTabActive);
    const activeArticleId = useEditorSelector(context => context.activeArticleId);
    const handleAiAnalyze = useAISelector(context => context.handleAiAnalyze);
    const handleChatGptAnalyze = useAISelector(context => context.handleChatGptAnalyze);
    const handleGeminiReadyCommandsAnalyze = useAISelector(context => context.handleGeminiReadyCommandsAnalyze);
    const buildSmartAnalysisPrompt = useAISelector(context => context.buildSmartAnalysisPrompt);
    const importManualChatGptResponse = useAISelector(context => context.importManualChatGptResponse);
    const aiResults = useAISelector(context => context.aiResults);
    const aiInsertionPatches = useAISelector(context => context.aiInsertionPatches);
    const isAiLoading = useAISelector(context => context.isAiLoading);
    const aiRequestProgress = useAISelector(context => context.aiRequestProgress);
    const cancelAiRequest = useAISelector(context => context.cancelAiRequest);
    const applyAiInsertionPatch = useAISelector(context => context.applyAiInsertionPatch);
    const selectAiInsertionPatchTarget = useAISelector(context => context.selectAiInsertionPatchTarget);
    const deleteAiInsertionPatchMergeDeleteTarget = useAISelector(context => context.deleteAiInsertionPatchMergeDeleteTarget);
    const selectAiInsertionPatchMergeDeleteTarget = useAISelector(context => context.selectAiInsertionPatchMergeDeleteTarget);
    
    const [activeTab, setActiveTab] = useState<'structure' | 'ai' | 'competitors'>('structure');
    const [aiSubTab, setAiSubTab] = useState<'new' | 'history' | 'external'>('new');
    const [aiCommand, setAiCommand] = useState('');
    const [bulkCompetitorText, setBulkCompetitorText] = useState('');
    const [competitorUrls, setCompetitorUrls] = useState<string[]>(() => loadStoredCompetitorUrls());
    const [competitorHtmls, setCompetitorHtmls] = useState<string[]>(() => loadStoredCompetitorHtmls());
    const [competitorTexts, setCompetitorTexts] = useState<string[]>(() => loadStoredCompetitorTexts());
    const [competitorExtractions, setCompetitorExtractions] = useState<CompetitorExtractionState[]>(() => loadStoredCompetitorExtractions());
    const [competitorGeminiProgress, setCompetitorGeminiProgress] = useState<Record<number, LocalGeminiProgressSnapshot>>({});
    const [selectedReadyCommandIds, setSelectedReadyCommandIds] = useState<string[]>([]);
    const [isGeminiExpanded, setIsGeminiExpanded] = useState(true);
    const [isGeminiPaidExpanded, setIsGeminiPaidExpanded] = useState(false);
    const [isChatGptExpanded, setIsChatGptExpanded] = useState(false);
    const [competitorGeminiProvider, setCompetitorGeminiProvider] = useState<'gemini' | 'geminiPaid'>('gemini');
    const [copiedPatchId, setCopiedPatchId] = useState('');
    const [manualBridgeImportText, setManualBridgeImportText] = useState('');
    const [manualBridgeStatus, setManualBridgeStatus] = useState('');
    const geminiFreeModelOptions = useMemo(() => buildGeminiFreeModelOptions(), []);
    const geminiFreeModelValues = useMemo(() => geminiFreeModelOptions.map(option => option.value), [geminiFreeModelOptions]);
    const [selectedSmartGeminiModel, setSelectedSmartGeminiModel] = useState(() => (
        normalizeGeminiFreeModel(getSelectedGeminiFreeModel(), geminiFreeModelValues)
    ));
    
    // Custom Dropdown State
    const [isCommandsMenuOpen, setIsCommandsMenuOpen] = useState(false);
    const commandsMenuRef = useRef<HTMLDivElement>(null);
    const smartAnalysisTabRef = useRef<HTMLDivElement>(null);
    const clearReadyCommandSelectionOnNextOpenRef = useRef(false);

    const [aiOptions, setAiOptions] = useState<AiAnalysisOptions>(() => ({ ...DEFAULT_SMART_ANALYSIS_OPTIONS }));

    const tRs = t.rightSidebar;
    const isGeminiSmartProgress = Boolean(
        aiRequestProgress &&
        (aiRequestProgress.source === 'smart_analysis' || aiRequestProgress.source === 'ready_commands_batch')
    );

    useEffect(() => {
        setIsStructureTabActive(activeTab === 'structure');
        return () => setIsStructureTabActive(false);
    }, [activeTab, setIsStructureTabActive]);

    useEffect(() => {
        const syncSelectedGeminiModel = () => {
            setSelectedSmartGeminiModel(normalizeGeminiFreeModel(getSelectedGeminiFreeModel(), geminiFreeModelValues));
        };

        window.addEventListener(GEMINI_FREE_MODEL_CHANGED_EVENT, syncSelectedGeminiModel);
        return () => window.removeEventListener(GEMINI_FREE_MODEL_CHANGED_EVENT, syncSelectedGeminiModel);
    }, [geminiFreeModelValues]);

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
            localStorage.setItem(COMPETITOR_URLS_STORAGE_KEY, JSON.stringify(competitorUrls));
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
        const normalizeStoredList = (items: unknown, fallback: string[]) => (
            fallback.map((emptyValue, index) => (
                Array.isArray(items) && typeof items[index] === 'string' ? items[index] : emptyValue
            ))
        );

        const resetCompetitors = (event: Event) => {
            const restoredInputs = (event as CustomEvent<StoredCompetitorInputs | undefined>).detail;
            setBulkCompetitorText('');
            setCompetitorUrls(normalizeStoredList(restoredInputs?.urls, createDefaultCompetitorUrls()));
            setCompetitorHtmls(normalizeStoredList(restoredInputs?.htmls, createDefaultCompetitorHtmls()));
            setCompetitorTexts(normalizeStoredList(restoredInputs?.texts, createDefaultCompetitorTexts()));
            setCompetitorExtractions(createDefaultCompetitorExtractions());
        };

        window.addEventListener(COMPETITOR_RESET_EVENT, resetCompetitors);
        return () => window.removeEventListener(COMPETITOR_RESET_EVENT, resetCompetitors);
    }, []);

    const readyCommands: ReadyCommand[] = useMemo(() => {
        const isArabic = t.locale === 'ar';
        return ENGINEERING_PROMPT_DEFINITIONS
            .filter(definition => definition.source === 'smartAnalysis')
            .sort((first, second) => (
                getReadyCommandDisplayOrder(first.id) - getReadyCommandDisplayOrder(second.id)
            ))
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
        return buildReadyCommandCompetitorBlocks(competitorExtractions, competitorTexts, competitorUrls);
    }, [competitorExtractions, competitorTexts, competitorUrls]);

    const competitorTextStats = useMemo(() => {
        return createCompetitorTextStats(competitorTexts, competitorExtractions);
    }, [competitorExtractions, competitorTexts]);

    const appendSelectedAttachments = (prompt: string, options: AiAnalysisOptions): string => {
        if (!options.competitorContent) return prompt;
        if (!readyCommandCompetitorBlocks.trim()) return prompt;

        return `${prompt}

**محتوى المنافسين المرفق:**
${readyCommandCompetitorBlocks}`;
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
            setAiCommand(selectedCommand.value);
            setAiOptions(getReadyCommandOptions(selectedCommand));
            return;
        }

        setAiCommand(selectedReadyCommands
            .map((command, index) => `### ${index + 1}. ${command.label}\n${command.value}`)
            .join('\n\n')
        );
        setAiOptions(selectedReadyCommands.reduce(
            (merged, command) => ({ ...merged, ...(command.options || {}) }),
            { ...DEFAULT_SMART_ANALYSIS_OPTIONS }
        ));
    }, [selectedReadyCommands]);

    const selectedReadyCommand = selectedReadyCommands.length === 1 ? selectedReadyCommands[0] : null;

    const readyCommandHistoryMeta: ReadyCommandAnalysisHistoryMeta | undefined = selectedReadyCommand
        ? {
            commandId: selectedReadyCommand.id,
            commandLabel: selectedReadyCommand.label,
            skipPatchInstructions: selectedReadyCommand.skipPatchInstructions,
            savesContentSummary: selectedReadyCommand.savesContentSummary,
        }
        : undefined;

    const readyCommandBatchItems: ReadyCommandAnalysisBatchItem[] = selectedReadyCommands.map(command => {
        const options = getReadyCommandOptions(command);
        return {
            commandId: command.id,
            commandLabel: command.label,
            userPrompt: appendSelectedAttachments(command.value, options),
            options,
            skipPatchInstructions: command.skipPatchInstructions,
            savesContentSummary: command.savesContentSummary,
        };
    });

    const isArabicLocale = t.locale.toLowerCase().startsWith('ar');

    const selectedReadyCommandsLabel = selectedReadyCommands.length === 0
        ? tRs.selectCommand
        : selectedReadyCommands.length === 1
            ? selectedReadyCommands[0].label
            : isArabicLocale
                ? `${selectedReadyCommands.length} أوامر محددة`
                : `${selectedReadyCommands.length} commands selected`;

    // Keep Gemini, ChatGPT, and the manual ChatGPT copy button aligned on attachments/options.
    const buildCurrentSmartAnalysisRequest = () => ({
        userPrompt: appendSelectedAttachments(aiCommand, aiOptions),
        options: aiOptions,
        historyMeta: selectedReadyCommands.length === 1 ? readyCommandHistoryMeta : undefined,
    });

    const buildManualBridgePrompt = (): string => {
        const request = buildCurrentSmartAnalysisRequest();
        return buildSmartAnalysisPrompt(request.userPrompt, request.options, request.historyMeta);
    };

    const openManualChatGptWindow = () => {
        if (chatGptOpenMode === 'tab') {
            window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer');
            return;
        }

        const tabRect = smartAnalysisTabRef.current?.getBoundingClientRect();
        const editorPanel = document.querySelector('[data-bazarvan-editor-panel="true"]') as HTMLElement | null;
        const editorRect = editorPanel?.getBoundingClientRect();
        const screenInfo = window.screen as Screen & { availLeft?: number; availTop?: number };
        const availableLeft = screenInfo.availLeft ?? 0;
        const availableTop = screenInfo.availTop ?? 0;
        const availableWidth = screenInfo.availWidth || 1200;
        const availableHeight = screenInfo.availHeight || 900;
        const availableRight = availableLeft + availableWidth;
        const availableBottom = availableTop + availableHeight;
        const browserTop = window.screenY ?? window.screenTop ?? 0;
        const fallbackWidth = Math.min(420, Math.max(320, Math.floor(availableWidth * 0.24)));
        const measuredWidth = Math.round(tabRect?.width || fallbackWidth);
        const popupWidth = Math.max(320, Math.min(availableWidth, measuredWidth));
        const measuredTop = browserTop + Math.round(editorRect?.top ?? tabRect?.top ?? 0);
        const popupTop = Math.max(availableTop, Math.min(availableBottom - 520, Math.floor(measuredTop)));
        const popupHeight = Math.max(520, Math.min(availableHeight, availableBottom - popupTop));
        const popupLeft = Math.max(availableLeft, Math.floor(availableRight - popupWidth));
        const popupFeatures = [
            'popup=yes',
            `width=${popupWidth}`,
            `height=${popupHeight}`,
            `left=${popupLeft}`,
            `top=${popupTop}`,
            'resizable=yes',
            'scrollbars=yes',
            'noopener',
            'noreferrer',
        ].join(',');

        window.open('https://chatgpt.com/', 'bazarvan-chatgpt-bridge', popupFeatures);
    };

    const handleCopyManualBridgePrompt = async (openChat = false) => {
        if (selectedReadyCommands.length > 0) {
            clearReadyCommandSelectionOnNextOpenRef.current = true;
        }

        try {
            const prompt = buildManualBridgePrompt();
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(prompt);
            } else {
                await copyMarkdownToClipboard(prompt);
            }
            setManualBridgeStatus(isArabicLocale ? 'تم نسخ الأمر.' : 'Prompt copied.');
            if (openChat) {
                openManualChatGptWindow();
            }
            window.setTimeout(() => setManualBridgeStatus(''), 2200);
        } catch (error) {
            console.error('Could not copy manual ChatGPT bridge prompt:', error);
            setManualBridgeStatus(isArabicLocale ? 'تعذر نسخ الأمر.' : 'Could not copy prompt.');
        }
    };

    const handleImportManualChatGptResponse = () => {
        const responseText = manualBridgeImportText.trim();
        if (!responseText) {
            setManualBridgeStatus(isArabicLocale ? 'ألصق رد ChatGPT أولا.' : 'Paste the ChatGPT response first.');
            return;
        }

        importManualChatGptResponse(
            responseText,
            selectedReadyCommands.length === 1 ? readyCommandHistoryMeta : undefined
        );
        setIsChatGptExpanded(true);
        setManualBridgeImportText('');
        setManualBridgeStatus(isArabicLocale ? 'تم تنظيم الرد.' : 'Response organized.');
        window.setTimeout(() => setManualBridgeStatus(''), 2200);
    };

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
            case ENGINEERING_PROMPT_IDS.smartAnalysis.competitorContentComparison:
                return <FilePlus2 size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.combinedCommands:
                return <Sparkles size={16} className={iconClass} />;
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
            case ENGINEERING_PROMPT_IDS.smartAnalysis.repetitionAndFillerAudit:
                return <FileSearch size={16} className={iconClass} />;
            case ENGINEERING_PROMPT_IDS.smartAnalysis.articleSectionOrder:
                return <LayoutTemplate size={16} className={iconClass} />;
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
            handleGeminiReadyCommandsAnalyze(readyCommandBatchItems, 'gemini', selectedSmartGeminiModel);
            return;
        }

        const request = buildCurrentSmartAnalysisRequest();
        handleAiAnalyze(request.userPrompt, request.options, request.historyMeta, 'gemini', selectedSmartGeminiModel);
    };

    const handleRunGeminiPaidAnalysis = () => {
        if (selectedReadyCommands.length > 0) {
            clearReadyCommandSelectionOnNextOpenRef.current = true;
        }
        setIsGeminiPaidExpanded(true);
        if (selectedReadyCommands.length > 1) {
            handleGeminiReadyCommandsAnalyze(readyCommandBatchItems, 'geminiPaid');
            return;
        }

        const request = buildCurrentSmartAnalysisRequest();
        handleAiAnalyze(request.userPrompt, request.options, request.historyMeta, 'geminiPaid');
    };

    const handleRunChatGptAnalysis = () => {
        if (selectedReadyCommands.length > 0) {
            clearReadyCommandSelectionOnNextOpenRef.current = true;
        }
        setIsChatGptExpanded(true);
        const request = buildCurrentSmartAnalysisRequest();
        handleChatGptAnalyze(request.userPrompt, request.options, request.historyMeta);
    };

    const handleCopyPatch = async (patchId: string, content: string) => {
        try {
            await copyMarkdownToClipboard(content);
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
    };

    const handleCompetitorHtmlChange = (index: number, value: string) => {
        setCompetitorHtmls(prev => prev.map((html, htmlIndex) => htmlIndex === index ? value : html));
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? createEmptyCompetitorState() : item));
    };

    const handleCompetitorTextChange = (index: number, value: string) => {
        setCompetitorTexts(prev => prev.map((text, textIndex) => textIndex === index ? value : text));
    };

    const handleBulkCompetitorTextDistribute = (value: string) => {
        const sections = splitBulkCompetitorTexts(value);
        if (sections.length === 0) return;

        setCompetitorTexts(prev => createDefaultCompetitorTexts().map((_, index) => sections[index] || prev[index] || ''));
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
        provider: 'gemini' | 'geminiPaid' = competitorGeminiProvider,
    ) => {
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            status: 'loading',
            source,
            error: '',
        } : item));
        setCompetitorGeminiProgress(prev => ({
            ...prev,
            [index]: {
                provider,
                model: provider === 'geminiPaid' ? GEMINI_PAID_ANALYSIS_MODEL : getSelectedGeminiFreeModel(),
                active: true,
                completed: false,
                message: isArabicLocale ? 'بدء الاتصال بـ Gemini...' : 'Starting Gemini request...',
            },
        }));

        try {
            const engineResult = await runGeminiAnalysisEngine({
                request: {
                    prompt,
                    provider,
                    model: provider === 'geminiPaid' ? GEMINI_PAID_ANALYSIS_MODEL : getSelectedGeminiFreeModel(),
                    useUrlContext,
                    allowModelFallback: provider === 'gemini' && isGeminiFreeModelFallbackEnabled(),
                    fallbackModels: provider === 'gemini' ? [...GEMINI_FREE_MODEL_VALUES] : undefined,
                    telemetry: {
                        source: 'competitor_extraction',
                        action: source,
                        batchIndex: index + 1,
                        batchTotal: competitorExtractions.length,
                    },
                },
                onProgress: progress => {
                    setCompetitorGeminiProgress(prev => ({
                        ...prev,
                        [index]: {
                            ...progress,
                            active: !progress.completed,
                        },
                    }));
                },
            });
            const { status, data } = engineResult;
            if (status === 404) {
                throw new Error(tRs.competitorApiUnavailable);
            }
            if (status === 499 || data.cancelled === true) {
                setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                    status: 'idle',
                    source,
                    content: null,
                    error: '',
                } : item));
                setCompetitorGeminiProgress(prev => ({
                    ...prev,
                    [index]: {
                        ...(prev[index] || {}),
                        stage: 'cancelled',
                        status: 499,
                        active: false,
                        completed: true,
                        message: isArabicLocale ? 'تم إيقاف التحليل يدويًا.' : 'Analysis stopped manually.',
                    },
                }));
                return;
            }
            if (status < 200 || status >= 300) {
                throw new Error(data.error || `${tRs.competitorExtractionFailed} (${status})`);
            }
            setCompetitorGeminiProgress(prev => ({
                ...prev,
                [index]: {
                    ...(prev[index] || {}),
                    provider: data.provider || provider,
                    model: data.model,
                    requestedModel: data.requestedModel,
                    keyCount: typeof data.keyCount === 'number' ? data.keyCount : undefined,
                    attemptedKeyCount: typeof data.attemptedKeyCount === 'number' ? data.attemptedKeyCount : undefined,
                    keySuffix: typeof data.keySuffix === 'string' ? data.keySuffix : undefined,
                    status,
                    completed: true,
                    active: false,
                    message: isArabicLocale ? 'تم تلقي رد Gemini بنجاح.' : 'Gemini responded successfully.',
                },
            }));

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
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'error',
                source,
                content: null,
                error: error instanceof Error ? error.message : tRs.competitorExtractionFailed,
            } : item));
            setCompetitorGeminiProgress(prev => {
                const current = prev[index];
                return {
                    ...prev,
                    [index]: current
                        ? { ...current, active: false, completed: true }
                        : {
                            active: false,
                            completed: true,
                            message: error instanceof Error ? error.message : tRs.competitorExtractionFailed,
                        },
                    };
            });
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

    const normalizePatchMarkerForMatch = (value?: string): string => (
        (value || '')
            .replace(/^\s*\[\[PATCH:/i, '')
            .replace(/\]\]\s*$/i, '')
            .trim()
    );

    const renderPatchCard = (
        provider: AiPatchProvider,
        patch: AiContentPatch,
        handlers?: {
            onSelectPatch?: (patch: AiContentPatch) => void;
            onApplyPatch?: (patch: AiContentPatch) => void;
        }
    ) => {
        const actionLabel = getPatchActionLabel(patch.operation);
        const isCopied = copiedPatchId === patch.id;
        const cleanPatchTitle = (patch.title || 'نص مقترح')
            .replace(/^(?:إضافة|اضافة|استبدال)\s*(?:-|:|\u2013)\s*/i, '')
            .trim() || 'نص مقترح';
        const patchLocationText = patch.placementLabel || patch.anchorText || patch.targetText || 'لم يتم تحديد موضع نصي دقيق.';
        const patchReason = patch.reason || 'سبب الاقتراح غير محدد.';
        const reasonLabel = actionLabel === 'استبدال' ? 'سبب الاستبدال' : 'سبب إضافة النص المقترح';
        const hasMergeDeleteTarget = Boolean(
            patch.mergeDeleteTargetText?.trim() ||
            patch.mergeDeletePlacementLabel?.trim() ||
            patch.mergeDeleteAnchorText?.trim()
        );
        const mergeDeleteLocationText = patch.mergeDeletePlacementLabel || patch.mergeDeleteAnchorText || patch.mergeDeleteTargetText || 'لم يتم تحديد موضع فقرة الحذف نصيًا.';
        const mergeDeleteStatus = patch.mergeDeleteStatus || 'pending';

        return (
            <div key={patch.id} className="my-3 border border-[#d4af37]/25 dark:border-[#d4af37]/30 rounded-md bg-white/80 dark:bg-[#1F1F1F]/80 p-2 not-prose">
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <div className="text-xs font-bold text-[#333333] dark:text-gray-100">
                            {actionLabel} - {cleanPatchTitle}
                        </div>
                        <div className="mt-1.5 text-[11px] leading-relaxed text-gray-600 dark:text-gray-300">
                            <span className="font-bold text-[#8a6f1d] dark:text-[#f2d675]">{reasonLabel}: </span>
                            {patchReason}
                        </div>
                        <div className="mt-1 text-[10px] leading-relaxed text-gray-500 dark:text-gray-400 break-words">
                            <span className="font-semibold">{'مكان النص في المحرر'}: </span>
                            {patchLocationText}
                        </div>
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

                <div className="mt-2 rounded-md border border-gray-100 bg-gray-50/80 p-2 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]/80">
                    <div className="mb-1 text-[10px] font-bold text-[#8a6f1d] dark:text-[#f2d675]">النص المقترح</div>
                    <div className="text-xs text-gray-700 dark:text-gray-300 ai-output" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(patch.contentMarkdown) }} />
                </div>

                {hasMergeDeleteTarget && (
                    <div className="mt-2 rounded-md border border-red-100 bg-red-50/70 p-2 dark:border-red-900/30 dark:bg-red-900/10">
                        <div className="text-[10px] font-bold text-red-700 dark:text-red-300">الفقرة المدمجة المطلوب حذفها</div>
                        <div className="mt-1 text-[10px] leading-relaxed text-gray-600 dark:text-gray-300 break-words">
                            <span className="font-semibold">مكان الفقرة في المحرر: </span>
                            {mergeDeleteLocationText}
                        </div>
                        {patch.mergeDeleteTargetText && (
                            <div className="mt-1.5 max-h-24 overflow-y-auto rounded border border-red-100 bg-white/70 p-1.5 text-[11px] leading-relaxed text-gray-700 dark:border-red-900/30 dark:bg-[#1F1F1F]/60 dark:text-gray-200">
                                {patch.mergeDeleteTargetText}
                            </div>
                        )}
                        {patch.mergeDeleteApplyError && (
                            <div className="mt-1.5 rounded bg-red-100 px-2 py-1 text-[11px] font-semibold text-red-700 dark:bg-red-900/20 dark:text-red-300">{patch.mergeDeleteApplyError}</div>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() => selectAiInsertionPatchMergeDeleteTarget(provider, patch.id)}
                                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-white dark:bg-[#2A2A2A] text-gray-700 dark:text-gray-200 hover:bg-red-100 dark:hover:bg-red-900/25"
                            >
                                <LocateFixed size={13} />
                                موضع الحذف
                            </button>
                            <button
                                type="button"
                                onClick={() => deleteAiInsertionPatchMergeDeleteTarget(provider, patch.id)}
                                disabled={mergeDeleteStatus === 'applied'}
                                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {mergeDeleteStatus === 'applied' ? <CheckCircle2 size={13} /> : <Trash2 size={13} />}
                                {mergeDeleteStatus === 'applied' ? 'تم حذف الفقرة' : 'حذف الفقرة'}
                            </button>
                        </div>
                    </div>
                )}

                {patch.applyError && (
                    <div className="mt-1.5 text-[11px] font-semibold text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1">{patch.applyError}</div>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={() => handlers?.onSelectPatch ? handlers.onSelectPatch(patch) : selectAiInsertionPatchTarget(provider, patch.id)}
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
                        onClick={() => handlers?.onApplyPatch ? handlers.onApplyPatch(patch) : applyAiInsertionPatch(provider, patch.id)}
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

    const renderAnalysisResult = (
        provider: AiPatchProvider,
        result: string,
        patches = aiInsertionPatches[provider],
        handlers?: {
            onSelectPatch?: (patch: AiContentPatch) => void;
            onApplyPatch?: (patch: AiContentPatch) => void;
        }
    ) => {
        const uniquePatches = patches.filter((patch, index, source) => {
            const key = [
                patch.marker,
                patch.title,
                patch.operation,
                patch.anchorText,
                patch.targetText,
                patch.placementLabel,
                patch.contentMarkdown,
                patch.mergeDeleteTargetText,
                patch.mergeDeletePlacementLabel,
                patch.mergeDeleteAnchorText,
            ].join('|').replace(/\s+/g, ' ').trim().toLowerCase();

            return key && source.findIndex(item => [
                item.marker,
                item.title,
                item.operation,
                item.anchorText,
                item.targetText,
                item.placementLabel,
                item.contentMarkdown,
                item.mergeDeleteTargetText,
                item.mergeDeletePlacementLabel,
                item.mergeDeleteAnchorText,
            ].join('|').replace(/\s+/g, ' ').trim().toLowerCase() === key) === index;
        });

        if (!uniquePatches.length) {
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

            const normalizedMarker = normalizePatchMarkerForMatch(marker);
            const matchingPatches = uniquePatches.filter(item => (
                !usedPatchIds.has(item.id) &&
                (
                    normalizePatchMarkerForMatch(item.marker) === normalizedMarker ||
                    normalizePatchMarkerForMatch(item.title) === normalizedMarker
                )
            ));
            matchingPatches.forEach(patch => {
                usedPatchIds.add(patch.id);
                parts.push(renderPatchCard(provider, patch, handlers));
            });
            lastIndex = markerPattern.lastIndex;
        }

        const tail = result.slice(lastIndex);
        if (tail.trim()) {
            parts.push(
                <div key="text-tail" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(tail) }} />
            );
        }

        uniquePatches
            .filter(patch => !usedPatchIds.has(patch.id))
            .forEach(patch => parts.push(renderPatchCard(provider, patch, handlers)));

        return <>{parts}</>;
    };

    const renderAiTab = () => (
        <div ref={smartAnalysisTabRef} className="flex flex-col h-full">
            <div className="flex p-2 mx-2 mt-2 mb-1 bg-gray-200 dark:bg-[#2A2A2A] rounded-lg">
                <button onClick={() => setAiSubTab('new')} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${aiSubTab === 'new' ? 'bg-white dark:bg-[#1F1F1F] text-[#d4af37] shadow-sm' : 'text-gray-500'}`}>{tRs.newAnalysis}</button>
                <button onClick={() => setAiSubTab('history')} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${aiSubTab === 'history' ? 'bg-white dark:bg-[#1F1F1F] text-[#d4af37] shadow-sm' : 'text-gray-500'}`}>{t.aiHistory.title}</button>
                <button onClick={() => setAiSubTab('external')} className={`flex-1 px-1 py-1.5 text-[10px] font-bold leading-4 rounded-md transition-all ${aiSubTab === 'external' ? 'bg-white dark:bg-[#1F1F1F] text-[#d4af37] shadow-sm' : 'text-gray-500'}`}>{t.locale === 'ar' ? 'نتائج التحليل الخارجي' : 'External results'}</button>
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
                                        ? `سيتم إرسال ${selectedReadyCommands.length} أوامر دفعة واحدة إلى مزود Gemini الذي تختاره، مع توزيعها على مفاتيح API المتاحة له.`
                                        : `${selectedReadyCommands.length} commands will be sent together to the Gemini provider you choose, distributed across its available API keys.`}
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
                            <div className="grid grid-cols-4 gap-2">
                                <div className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-[#d4af37] text-white">
                                    <button onClick={handleRunGeminiAnalysis} disabled={isAiLoading.gemini} className="flex min-h-9 items-center justify-center gap-1.5 px-1.5 py-1.5 hover:bg-[#b8922e] disabled:opacity-50">
                                        {isAiLoading.gemini ? <Wand2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                        <span className="text-xs font-bold">Gemini</span>
                                    </button>
                                    <select
                                        value={selectedSmartGeminiModel}
                                        onChange={event => setSelectedSmartGeminiModel(normalizeGeminiFreeModel(event.target.value, geminiFreeModelValues))}
                                        onClick={event => event.stopPropagation()}
                                        disabled={isAiLoading.gemini}
                                        title={t.locale === 'ar' ? 'اختيار موديل Gemini المجاني' : 'Choose free Gemini model'}
                                        dir="ltr"
                                        className="mx-1 mb-1 min-w-0 rounded-md border border-white/40 bg-white/95 px-1 py-0.5 text-[10px] font-bold text-[#333] outline-none focus:ring-1 focus:ring-white disabled:opacity-70"
                                    >
                                        {geminiFreeModelOptions.map(option => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </div>
                                <button onClick={handleRunGeminiPaidAnalysis} disabled={isAiLoading.geminiPaid} className="flex items-center justify-center gap-2 py-2 bg-[#d4af37] text-white rounded-lg hover:bg-[#b8922e] disabled:opacity-50">
                                    {isAiLoading.geminiPaid ? <Wand2 size={16} className="animate-spin" /> : <BadgeDollarSign size={16} />}
                                    <span className="text-xs font-bold">Pro</span>
                                </button>
                                <button onClick={handleRunChatGptAnalysis} disabled={isAiLoading.chatgpt} className="flex items-center justify-center gap-2 py-2 bg-[#d4af37] text-white rounded-lg hover:bg-[#b8922e] disabled:opacity-50">
                                    {isAiLoading.chatgpt ? <Wand2 size={16} className="animate-spin" /> : <BrainCircuit size={16} />}
                                    <span className="text-xs font-bold">ChatGPT</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleCopyManualBridgePrompt(true)}
                                    className="flex min-w-0 items-center justify-center gap-1 rounded-lg bg-[#d4af37] px-1.5 py-2 text-center text-[11px] font-bold leading-4 text-white hover:bg-[#b8922e]"
                                >
                                    <ExternalLink size={14} />
                                    <span className="min-w-0 whitespace-normal break-words">
                                        {isArabicLocale ? 'نسخ وفتح ChatGPT' : 'Copy and open ChatGPT'}
                                    </span>
                                </button>
                            </div>

                            <div className="space-y-2">
                                <textarea
                                    value={manualBridgeImportText}
                                    onChange={(event) => setManualBridgeImportText(event.target.value)}
                                    rows={5}
                                    placeholder={isArabicLocale ? 'ألصق رد ChatGPT هنا...' : 'Paste the ChatGPT response here...'}
                                    className="w-full resize-y rounded-md border border-gray-300 bg-gray-50 px-2 py-2 text-xs leading-5 text-[#333333] outline-none placeholder:text-gray-400 focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100 dark:placeholder:text-gray-500"
                                    dir="auto"
                                />
                                <button
                                    type="button"
                                    onClick={handleImportManualChatGptResponse}
                                    disabled={!manualBridgeImportText.trim()}
                                    className="flex w-full items-center justify-center gap-1 rounded-md bg-[#d4af37] px-3 py-2 text-xs font-bold text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    <ClipboardPaste size={14} />
                                    {isArabicLocale ? 'تنظيم الرد' : 'Organize response'}
                                </button>
                            </div>
                            {manualBridgeStatus && (
                                <div className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                                    {manualBridgeStatus}
                                </div>
                            )}
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
                                        {isAiLoading.gemini ? (
                                            isGeminiSmartProgress && aiRequestProgress?.provider !== 'geminiPaid'
                                                ? <GeminiProgressStatus progress={aiRequestProgress} isArabic={isArabicLocale} compact onCancel={cancelAiRequest} />
                                                : <div className="flex gap-2 animate-pulse text-[#d4af37]"><Wand2 size={14} /> جاري التفكير...</div>
                                        ) :
                                         aiResults.gemini ? renderAnalysisResult('gemini', aiResults.gemini) : <span className="text-gray-400 italic">لا توجد نتائج.</span>}
                                    </div>
                                )}
                            </div>
                            {/* Results Gemini Pro */}
                            <div className="bg-[#d4af37]/10 dark:bg-[#d4af37]/10 rounded-md overflow-hidden border border-[#d4af37]/20 dark:border-[#d4af37]/25">
                                <div className="p-2 bg-[#d4af37]/15 dark:bg-[#d4af37]/20 flex justify-between cursor-pointer" onClick={() => setIsGeminiPaidExpanded(!isGeminiPaidExpanded)}>
                                    <span className="text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">نتائج Gemini Pro</span>
                                    <ChevronDown size={14} className={isGeminiPaidExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isGeminiPaidExpanded && (
                                    <div className="p-2 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {isAiLoading.geminiPaid ? (
                                            isGeminiSmartProgress && aiRequestProgress?.provider === 'geminiPaid'
                                                ? <GeminiProgressStatus progress={aiRequestProgress} isArabic={isArabicLocale} compact onCancel={cancelAiRequest} />
                                                : <div className="flex gap-2 animate-pulse text-[#d4af37]"><Wand2 size={14} /> جاري التفكير...</div>
                                        ) :
                                         aiResults.geminiPaid ? renderAnalysisResult('geminiPaid', aiResults.geminiPaid) : <span className="text-gray-400 italic">لا توجد نتائج.</span>}
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
                ) : (
                    <React.Suspense fallback={<div className="p-4 text-center text-xs font-bold text-gray-400">جار تحميل النتائج...</div>}>
                        {aiSubTab === 'history' ? <AIHistoryTab /> : <ExternalAnalysisResultsTab articleId={activeArticleId} />}
                    </React.Suspense>
                )}
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
                    <div className="mb-2 text-xs font-bold text-gray-700 dark:text-gray-200">
                        {t.locale === 'ar' ? 'نموذج Gemini لاستخراج المنافسين' : 'Gemini model for competitor extraction'}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => setCompetitorGeminiProvider('gemini')}
                            className={`flex items-center justify-center gap-1 rounded-md px-3 py-2 text-xs font-bold transition-colors ${
                                competitorGeminiProvider === 'gemini'
                                    ? 'bg-[#d4af37] text-white'
                                    : 'border border-[#d4af37]/35 bg-[#d4af37]/10 text-[#8a6f1d] hover:bg-[#d4af37]/20 dark:text-[#f2d675]'
                            }`}
                        >
                            <Sparkles size={14} />
                            Gemini
                        </button>
                        <button
                            type="button"
                            onClick={() => setCompetitorGeminiProvider('geminiPaid')}
                            className={`flex items-center justify-center gap-1 rounded-md px-3 py-2 text-xs font-bold transition-colors ${
                                competitorGeminiProvider === 'geminiPaid'
                                    ? 'bg-[#d4af37] text-white'
                                    : 'border border-[#d4af37]/35 bg-[#d4af37]/10 text-[#8a6f1d] hover:bg-[#d4af37]/20 dark:text-[#f2d675]'
                            }`}
                        >
                            <BadgeDollarSign size={14} />
                            Gemini Pro
                        </button>
                    </div>
                </div>

                <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
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

                {competitorUrls.map((url, index) => {
                    const extraction = competitorExtractions[index] || createEmptyCompetitorState();
                    const content = extraction.source === 'text' ? null : extraction.content;
                    const plainText = competitorTexts[index] || '';
                    const isLoading = extraction.status === 'loading';
                    const isUrlLoading = isLoading && extraction.source === 'url';
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
                                    <div className="mb-1 text-[11px] font-bold text-gray-500 dark:text-gray-400">{tRs.competitorPlainTextField}</div>
                                    <textarea
                                        value={plainText}
                                        onChange={(event) => handleCompetitorTextChange(index, event.target.value)}
                                        placeholder={tRs.competitorPlainTextPlaceholder}
                                        rows={5}
                                        className="w-full resize-y rounded-md border border-gray-300 bg-gray-50 px-2 py-2 text-xs leading-5 text-[#333333] outline-none placeholder:text-gray-400 focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100 dark:placeholder:text-gray-500"
                                        dir="auto"
                                    />
                                </div>
                            </div>

                            {isLoading && competitorGeminiProgress[index] && (
                                <div className="mt-2">
                                    <GeminiProgressStatus progress={competitorGeminiProgress[index]} isArabic={isArabicLocale} compact onCancel={cancelAiRequest} />
                                </div>
                            )}

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

                <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                    <div className="mb-3 flex items-center gap-2 text-xs font-bold text-gray-800 dark:text-gray-100">
                        <FileText size={14} className="text-[#d4af37]" />
                        <span>{t.locale === 'ar' ? 'إحصاءات نصوص المنافسين' : 'Competitor Text Stats'}</span>
                    </div>

                    {competitorTextStats.totalWords === 0 ? (
                        <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-400 dark:bg-[#1F1F1F]">
                            {t.locale === 'ar' ? 'لا توجد نصوص منافسين بعد.' : 'No competitor text yet.'}
                        </div>
                    ) : (
                        <div className="space-y-3 text-xs">
                            <div className="grid grid-cols-2 gap-2">
                                <div className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                                    <div className="text-[11px] font-bold text-gray-500 dark:text-gray-400">
                                        {t.locale === 'ar' ? 'الكلمات الفريدة' : 'Unique words'}
                                    </div>
                                    <div className="mt-1 text-lg font-black tabular-nums text-[#8a6f1d] dark:text-[#f2d675]">
                                        {competitorTextStats.uniqueWords}
                                    </div>
                                </div>
                                <div className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                                    <div className="text-[11px] font-bold text-gray-500 dark:text-gray-400">
                                        {t.locale === 'ar' ? 'إجمالي الكلمات' : 'Total words'}
                                    </div>
                                    <div className="mt-1 text-lg font-black tabular-nums text-[#8a6f1d] dark:text-[#f2d675]">
                                        {competitorTextStats.totalWords}
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                                <div className="mb-2 text-[11px] font-bold text-gray-600 dark:text-gray-300">
                                    {t.locale === 'ar' ? 'أكثر 5 كلمات تكرارًا' : 'Top 5 repeated words'}
                                </div>
                                {competitorTextStats.topWords.length === 0 ? (
                                    <div className="text-gray-400">{t.locale === 'ar' ? 'لا توجد كلمات كافية بعد التصفية.' : 'No enough words after filtering.'}</div>
                                ) : (
                                    <div className="flex flex-wrap gap-1.5">
                                        {competitorTextStats.topWords.map(item => (
                                            <span key={item.word} className="rounded-md border border-[#d4af37]/25 bg-[#d4af37]/10 px-2 py-1 font-bold text-[#8a6f1d] dark:text-[#f2d675]">
                                                {item.word} <span className="tabular-nums text-gray-500 dark:text-gray-400">({item.count})</span>
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-bold text-gray-600 dark:text-gray-300">
                                        {t.locale === 'ar' ? 'عبارات 3-4-5 كلمات المكررة' : 'Repeated 3-4-5 word phrases'}
                                    </span>
                                    <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-gray-500 dark:bg-[#2A2A2A] dark:text-gray-400">
                                        {competitorTextStats.repeatedPhrases.length}
                                    </span>
                                </div>
                                {competitorTextStats.repeatedPhrases.length === 0 ? (
                                    <div className="text-gray-400">{t.locale === 'ar' ? 'لا توجد عبارات مكررة بهذا الطول.' : 'No repeated phrases at these lengths.'}</div>
                                ) : (
                                    <div className="max-h-72 overflow-y-auto custom-scrollbar space-y-1.5">
                                        {competitorTextStats.repeatedPhrases.map((item) => (
                                            <div key={`${item.size}-${item.text}`} className="flex items-start justify-between gap-2 rounded border border-gray-200 bg-white px-2 py-1.5 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                                                <div className="min-w-0">
                                                    <div className="whitespace-normal break-words leading-5 text-gray-700 dark:text-gray-200">{item.text}</div>
                                                    <div className="mt-0.5 text-[10px] font-bold text-gray-400">
                                                        {item.size} {t.locale === 'ar' ? 'كلمات' : 'words'}
                                                    </div>
                                                </div>
                                                <span className="shrink-0 rounded bg-[#d4af37]/10 px-1.5 py-0.5 text-[11px] font-black tabular-nums text-[#8a6f1d] dark:text-[#f2d675]">
                                                    {item.count}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );

    return (
        <aside className="basis-[18.7%] flex flex-col h-full min-w-0 bg-[#F2F3F5] dark:bg-[#1F1F1F] rounded-lg shadow-lg overflow-hidden border-s border-gray-300 dark:border-[#333]">
            <div className="flex border-b border-gray-200 dark:border-[#3C3C3C]">
                {(['structure', 'ai', 'competitors'] as const).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        aria-label={tab === 'structure'
                            ? (t.locale === 'ar' ? 'تحليل الهيكل' : 'Structure analysis')
                            : tab === 'ai'
                              ? (t.locale === 'ar' ? 'التحليل الذكي' : 'Smart analysis')
                              : (t.locale === 'ar' ? 'المنافسون' : 'Competitors')}
                        className={`flex-1 py-3 flex justify-center items-center transition-colors ${activeTab === tab ? 'text-[#d4af37] border-b-2 border-[#d4af37] bg-white dark:bg-[#2A2A2A]' : 'text-gray-400 hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/15'}`}
                    >
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
