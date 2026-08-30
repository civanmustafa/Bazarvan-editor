
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { BadgeDollarSign, LayoutTemplate, Sparkles, ChevronDown, ChevronLeft, ChevronRight, BrainCircuit, Wand2, FileSearch, ShieldAlert, Lightbulb, Users, Command, Copy, FilePlus2, LocateFixed, CheckCircle2, AlertTriangle, FileText, Trash2, PenLine, Link2, Code2, X, ExternalLink } from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import { useAISelector } from '../contexts/AIContext';
import { useEditorSelector } from '../contexts/EditorContext';
import { copyMarkdownToClipboard, parseMarkdownToHtml } from '../utils/editorUtils';
import {
    COMPETITOR_HTML_STORAGE_KEY,
    COMPETITOR_RESET_EVENT,
    COMPETITOR_TEXT_STORAGE_KEY,
    COMPETITOR_TEXTS_CHANGED_EVENT,
    COMPETITOR_URLS_STORAGE_KEY,
} from '../utils/competitorStorage';
import type { StoredCompetitorInputs } from '../utils/competitorStorage';
import type { AiAnalysisOptions, AiContentPatch, AiPatchProvider, ExternalAiBridgeProvider, ReadyCommandAnalysisBatchItem, ReadyCommandAnalysisHistoryMeta } from '../types';
import { GEMINI_FREE_MODEL_VALUES, GEMINI_PAID_ANALYSIS_MODEL } from '../constants/aiModels';
import {
    buildGeminiFreeModelOptions,
    GEMINI_FREE_MODEL_CHANGED_EVENT,
    getSelectedGeminiFreeModel,
    isGeminiFreeModelFallbackEnabled,
    normalizeGeminiFreeModel,
} from '../utils/geminiModelPreference';
import { DEFAULT_SMART_ANALYSIS_OPTIONS, ENGINEERING_PROMPT_DEFINITIONS, ENGINEERING_PROMPT_IDS, getEngineeringPrompt } from '../constants/engineeringPrompts';
import { isRetiredEngineeringCommandId } from '../constants/externalAnalysisCommands';
import { truncatePromptTextDistributed } from '../utils/promptText';
import ExternalAiBridgePanel from './ExternalAiBridgePanel';
import CompetitorDiscoveryPanel from './CompetitorDiscoveryPanel';
import { runGeminiAnalysisEngine } from '../utils/geminiAnalysisEngine';
import { createEmptyCompetitorSlots, MAX_ARTICLE_COMPETITORS } from '../constants/competitors';
import {
    CompetitorDiscoveryRequestError,
    extractCompetitorProgrammatically,
    saveArticleCompetitorManualText,
    type CompetitorDiscoveryRow,
} from '../utils/competitorDiscovery';
import {
    getUsableCompetitorText,
    isCompetitorExtractionFailureText,
} from '../utils/competitorContent';
import {
    COMPETITOR_COMPARISON_COMMAND_ID,
    type CompetitorComparisonMapResult,
    type CompetitorComparisonSource,
} from '../utils/competitorComparisonWorkflow';
import {
    createCompetitorTextStats,
    createSharedCompetitorPhrases,
} from '../utils/competitorPhraseAnalysis';
import { IconTooltip } from './toolbar/ToolbarItems';

const AIHistoryTab = React.lazy(() => import('./AIHistoryTab'));
const ExternalAnalysisResultsTab = React.lazy(() => import('./ExternalAnalysisResultsTab'));
const ContentWritingPanel = React.lazy(() => import('./ContentWritingPanel'));
const InternalLinkingPanel = React.lazy(() => import('./InternalLinkingPanel'));
const CompetitorPhraseIntelligencePanel = React.lazy(() => import('./CompetitorPhraseIntelligencePanel'));

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
    canonicalUrl?: string;
    fetchedUrl: string;
    provider?: string;
    cacheHit?: boolean;
    fetchedAt?: string;
    qualityScore?: number;
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

type CompetitorExtractionSource = 'url' | 'programmatic' | 'firecrawl' | 'html' | 'text';

type CompetitorExtractionState = {
    status: 'idle' | 'loading' | 'success' | 'error';
    source?: CompetitorExtractionSource;
    content: CompetitorExtractedContent | null;
    error: string;
    notice?: string;
};

const COMPETITOR_COMPARISON_CATEGORY_LABELS: Record<string, { ar: string; en: string }> = {
    missing_idea: { ar: 'فكرة ناقصة', en: 'Missing idea' },
    partial_idea: { ar: 'تغطية جزئية', en: 'Partial coverage' },
    conflicting_claim: { ar: 'ادعاء متعارض', en: 'Conflicting claim' },
    article_advantage: { ar: 'تفوق المقالة', en: 'Article advantage' },
    structure_opportunity: { ar: 'فرصة بنيوية', en: 'Structure opportunity' },
    trust_gap: { ar: 'فجوة ثقة', en: 'Trust gap' },
    conversion_opportunity: { ar: 'فرصة تحويل', en: 'Conversion opportunity' },
    duplicate: { ar: 'مكرر', en: 'Duplicate' },
    irrelevant: { ar: 'غير ملائم', en: 'Irrelevant' },
};

const COMPETITOR_COMPARISON_IMPORTANCE_LABELS: Record<string, { ar: string; en: string }> = {
    high: { ar: 'مرتفعة', en: 'High' },
    medium: { ar: 'متوسطة', en: 'Medium' },
    low: { ar: 'منخفضة', en: 'Low' },
};

const toSafeCompetitorSourceUrl = (value?: string): string => {
    const trimmed = value?.trim() || '';
    if (!trimmed) return '';
    try {
        const url = new URL(trimmed);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
    } catch {
        return '';
    }
};

const getCompetitorSourceHost = (value?: string): string => {
    const safeUrl = toSafeCompetitorSourceUrl(value);
    if (!safeUrl) return '';
    return new URL(safeUrl).hostname.replace(/^www\./i, '');
};

const createEmptyCompetitorState = (): CompetitorExtractionState => ({
    status: 'idle',
    source: undefined,
    content: null,
    error: '',
    notice: '',
});

const createDefaultCompetitorUrls = createEmptyCompetitorSlots;
const createDefaultCompetitorHtmls = createEmptyCompetitorSlots;
const createDefaultCompetitorTexts = createEmptyCompetitorSlots;

const createDefaultCompetitorExtractions = () => Array.from(
    { length: MAX_ARTICLE_COMPETITORS },
    createEmptyCompetitorState,
);

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

    return sections.slice(0, MAX_ARTICLE_COMPETITORS);
};

const countPromptWords = (value: string): number => value.split(/\s+/).filter(Boolean).length;
const READY_COMMAND_COMPETITOR_TOTAL_MAX_CHARS = 30_000;
const READY_COMMAND_COMPETITOR_SINGLE_MAX_CHARS = 15_000;

const truncatePromptText = (value: string, maxLength = 9000): string => {
    return truncatePromptTextDistributed(value, maxLength, {
        middle: '[تم اختصار جزء من نص المنافس؛ المقطع التالي عينة من الوسط.]',
        tail: '[تم اختصار جزء آخر؛ المقطع التالي من نهاية نص المنافس.]',
    });
};

const formatCompetitorEvidenceParagraphs = (value: string, maxLength = 9000): string => {
    const paragraphs = truncatePromptText(value, maxLength)
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
        competitorContentComparison: { ar: 'تحليل المنافسين الشامل', en: 'Comprehensive competitor analysis' },
        repetitionAndFillerAudit: { ar: 'اكتشاف التكرار والحشو', en: 'Repetition and filler audit' },
        articleSectionOrder: { ar: 'ترتيب الأقسام', en: 'Section order analysis' },
    };
    return labels[key]?.[isArabic ? 'ar' : 'en'] || key;
};

const READY_COMMAND_DISPLAY_ORDER = [
    ENGINEERING_PROMPT_IDS.smartAnalysis.competitorContentComparison,
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
        canonicalUrl: typeof parsed.canonicalUrl === 'string' ? parsed.canonicalUrl.trim() : undefined,
        fetchedUrl: typeof parsed.fetchedUrl === 'string' && parsed.fetchedUrl.trim()
            ? parsed.fetchedUrl.trim()
            : typeof parsed.url === 'string' && parsed.url.trim() ? parsed.url.trim() : fallbackUrl,
        provider: typeof parsed.provider === 'string' ? parsed.provider.trim() : undefined,
        cacheHit: parsed.cacheHit === true,
        fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt.trim() : undefined,
        qualityScore: Number.isFinite(Number(parsed.qualityScore))
            ? Math.max(0, Math.min(100, Number(parsed.qualityScore)))
            : undefined,
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

    if (!content.text) {
        content.text = normalizePlainCompetitorText([
            ...content.headings.h1,
            ...content.headings.h2,
            ...content.headings.h3,
            ...content.paragraphs,
            ...content.listItems,
        ].join('\n\n'));
    }

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

const getCompetitorStatText = (
    index: number,
    plainTexts: string[],
    extractions: CompetitorExtractionState[],
): string => {
    if (isCompetitorExtractionFailureText(plainTexts[index])) return '';
    const plainText = stripExtractionLabels(normalizePlainCompetitorText(
        getUsableCompetitorText(plainTexts[index]),
    ));
    const extractedText = stripExtractionLabels(normalizePlainCompetitorText(
        extractions[index]?.content?.text || '',
    ));
    return plainText || extractedText;
};

const collectCompetitorStatTexts = (
    plainTexts: string[],
    extractions: CompetitorExtractionState[],
): string[] => {
    // competitorTexts is the canonical editor surface used by stats, ready commands,
    // saved article attachments, external analysis, and content writing. Extraction
    // content is retained only as a loss-prevention fallback and preview payload.
    const texts: string[] = [];
    const slotCount = Math.max(plainTexts.length, extractions.length);
    for (let index = 0; index < slotCount; index += 1) {
        const text = getCompetitorStatText(index, plainTexts, extractions);
        if (text) texts.push(text);
    }

    return texts.filter(Boolean);
};

const loadStoredCompetitorExtractions = (): CompetitorExtractionState[] => {
    return createDefaultCompetitorExtractions();
};

const buildReadyCommandCompetitorBlocks = (
    extractions: CompetitorExtractionState[],
    plainTexts: string[],
    urls: string[],
): string => {
    // Ready/manual commands receive exactly one text block per competitor. Prefer the
    // user-editable canonical field and never attach the preview card as a second copy.
    const slotCount = Math.max(extractions.length, plainTexts.length, urls.length);
    const slots = Array.from({ length: slotCount }, (_, index) => {
        const extraction = extractions[index];
        const content = extraction?.content;
        if (isCompetitorExtractionFailureText(plainTexts[index])) {
            return { index, extraction, content, text: '' };
        }
        const plainText = stripExtractionLabels(normalizePlainCompetitorText(
            getUsableCompetitorText(plainTexts[index]),
        ));
        const extractedText = stripExtractionLabels(normalizePlainCompetitorText(content?.text || ''));
        const text = plainText || extractedText;
        return { index, extraction, content, text };
    }).filter(slot => Boolean(slot.text));
    const perCompetitorLimit = slots.length > 0
        ? Math.min(
            READY_COMMAND_COMPETITOR_SINGLE_MAX_CHARS,
            Math.floor(READY_COMMAND_COMPETITOR_TOTAL_MAX_CHARS / slots.length),
        )
        : 0;

    return slots.map(({ index, extraction, content, text }) => {
        const sourceLabel = extraction?.source === 'programmatic'
            ? 'محتوى نصي مستخرج برمجيًا'
            : extraction?.source === 'firecrawl'
                ? 'محتوى نصي مسحوب عبر Firecrawl'
                : extraction?.source === 'url'
                    ? 'محتوى نصي مستخرج عبر الذكاء الاصطناعي'
                    : extraction?.source === 'html'
                        ? 'محتوى نصي مستخرج من HTML'
                        : 'نص معتمد مدخل يدويًا';
        return `### المنافس ${index + 1} - ${sourceLabel}
الرابط: ${content?.url || content?.fetchedUrl || urls[index]?.trim() || 'غير محدد'}
العنوان: ${content?.title || 'غير محدد'}
عدد الكلمات: ${countPromptWords(text)}
طريقة الاستشهاد عند استخدام فكرة من هذا النص: المصدر: المنافس ${index + 1}؛ فقرة الدليل: [فقرة رقمها] مقتطف قصير من الفقرة.

النص مرقم الفقرات:
---
${formatCompetitorEvidenceParagraphs(text, perCompetitorLimit)}
---`;
    }).join('\n\n');
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

type RightSidebarProps = {
    collapsed?: boolean;
    expandedFlexBasis?: string;
    isHidden?: boolean;
    onToggleCollapsed?: () => void;
};

const RightSidebar: React.FC<RightSidebarProps> = ({
    collapsed = false,
    expandedFlexBasis,
    isHidden = false,
    onToggleCollapsed,
}) => {
    const {
        t,
        engineeringPrompts,
        chatGptOpenMode,
        aiProviderCapabilities,
        isAiProviderEnabled,
        isAiProviderAvailable,
    } = useUser();
    const activeArticleId = useEditorSelector(context => context.activeArticleId);
    const articleTitle = useEditorSelector(context => context.title);
    const articleKeywords = useEditorSelector(context => context.keywords);
    const articleLanguage = useEditorSelector(context => context.articleLanguage);
    const articleGoalContext = useEditorSelector(context => context.goalContext);
    const handleAiAnalyze = useAISelector(context => context.handleAiAnalyze);
    const handleChatGptAnalyze = useAISelector(context => context.handleChatGptAnalyze);
    const handleGeminiReadyCommandsAnalyze = useAISelector(context => context.handleGeminiReadyCommandsAnalyze);
    const handleCompetitorComparisonAnalyze = useAISelector(context => context.handleCompetitorComparisonAnalyze);
    const buildSmartAnalysisPrompt = useAISelector(context => context.buildSmartAnalysisPrompt);
    const validateAiArticleContext = useAISelector(context => context.validateAiArticleContext);
    const importManualAiResponse = useAISelector(context => context.importManualAiResponse);
    const aiResults = useAISelector(context => context.aiResults);
    const aiInsertionPatches = useAISelector(context => context.aiInsertionPatches);
    const aiCompetitorComparisonResults = useAISelector(context => context.aiCompetitorComparisonResults);
    const isAiLoading = useAISelector(context => context.isAiLoading);
    const applyAiInsertionPatch = useAISelector(context => context.applyAiInsertionPatch);
    const selectAiInsertionPatchTarget = useAISelector(context => context.selectAiInsertionPatchTarget);
    const deleteAiInsertionPatchMergeDeleteTarget = useAISelector(context => context.deleteAiInsertionPatchMergeDeleteTarget);
    const selectAiInsertionPatchMergeDeleteTarget = useAISelector(context => context.selectAiInsertionPatchMergeDeleteTarget);
    
    const [activeTab, setActiveTab] = useState<'ai' | 'competitors' | 'writing' | 'links'>('ai');
    const [aiSubTab, setAiSubTab] = useState<'new' | 'history' | 'external'>('new');
    const [aiCommand, setAiCommand] = useState('');
    const [bulkCompetitorText, setBulkCompetitorText] = useState('');
    const [competitorUrls, setCompetitorUrls] = useState<string[]>(() => loadStoredCompetitorUrls());
    const [competitorHtmls, setCompetitorHtmls] = useState<string[]>(() => loadStoredCompetitorHtmls());
    const [competitorTexts, setCompetitorTexts] = useState<string[]>(() => loadStoredCompetitorTexts());
    const [competitorExtractions, setCompetitorExtractions] = useState<CompetitorExtractionState[]>(() => loadStoredCompetitorExtractions());
    const programmaticExtractionControllersRef = useRef<Record<number, AbortController>>({});
    const managedCompetitorPositionsRef = useRef<Set<number>>(new Set());
    const [selectedReadyCommandIds, setSelectedReadyCommandIds] = useState<string[]>([]);
    const [isGeminiExpanded, setIsGeminiExpanded] = useState(true);
    const [isGeminiPaidExpanded, setIsGeminiPaidExpanded] = useState(false);
    const [isChatGptExpanded, setIsChatGptExpanded] = useState(false);
    const [competitorGeminiProvider, setCompetitorGeminiProvider] = useState<'gemini' | 'geminiPaid'>('gemini');
    const [copiedPatchId, setCopiedPatchId] = useState('');
    const geminiFreeModelOptions = useMemo(() => buildGeminiFreeModelOptions(), []);
    const geminiFreeModelValues = useMemo(() => geminiFreeModelOptions.map(option => option.value), [geminiFreeModelOptions]);
    const [selectedSmartGeminiModel, setSelectedSmartGeminiModel] = useState(() => (
        normalizeGeminiFreeModel(getSelectedGeminiFreeModel(), geminiFreeModelValues)
    ));
    const isOpenAiEnabled = isAiProviderEnabled('chatgpt');
    const isOpenAiAvailable = isAiProviderAvailable('chatgpt');
    const isGeminiFreeEnabled = isAiProviderEnabled('gemini');
    const isGeminiFreeAvailable = isAiProviderAvailable('gemini');
    const isGeminiPaidEnabled = isAiProviderEnabled('geminiPaid');
    const isGeminiPaidAvailable = isAiProviderAvailable('geminiPaid');
    const enabledSmartProviderCount = Number(isGeminiFreeEnabled) + Number(isGeminiPaidEnabled) + Number(isOpenAiEnabled);
    const smartProviderGridClass = enabledSmartProviderCount >= 3
        ? 'grid-cols-3'
        : enabledSmartProviderCount === 2
            ? 'grid-cols-2'
            : 'grid-cols-1';
    
    // Custom Dropdown State
    const [isCommandsMenuOpen, setIsCommandsMenuOpen] = useState(false);
    const commandsMenuRef = useRef<HTMLDivElement>(null);
    const smartAnalysisTabRef = useRef<HTMLDivElement>(null);
    const clearReadyCommandSelectionOnNextOpenRef = useRef(false);
    const manualBridgeHistoryMetaRef = useRef<Partial<Record<ExternalAiBridgeProvider, ReadyCommandAnalysisHistoryMeta>>>({});

    const [aiOptions, setAiOptions] = useState<AiAnalysisOptions>(() => ({ ...DEFAULT_SMART_ANALYSIS_OPTIONS }));

    const tRs = t.rightSidebar;
    const competitorIsArabic = t.locale.toLowerCase().startsWith('ar');
    const competitorLocale = competitorIsArabic ? 'ar' : 'en';
    const competitorText = {
        ...tRs,
        ...(competitorIsArabic ? {
            programmaticExtractionPreview: 'معاينة الاستخراج البرمجي',
            htmlExtractionPreview: 'معاينة استخراج الصفحة',
            competitorLabel: 'المنافس',
            competitorUrlPlaceholder: 'أدخل رابط صفحة المنافس',
            competitorUrlField: 'رابط صفحة المنافس',
            extractCompetitorWithAiHint: 'استخرج النص الرئيسي من الرابط تلقائيًا',
            extractingCompetitor: 'جارٍ استخراج المحتوى…',
            extractCompetitorWithAi: 'استخراج تلقائي',
            stopProgrammaticExtraction: 'إيقاف الاستخراج',
            extractCompetitorProgrammaticallyHint: 'استخراج النص من الصفحة برمجيًا',
            extractCompetitorProgrammatically: 'استخراج برمجي',
            competitorPlainTextPlaceholder: 'الصق نص المنافس هنا أو اترك الحقل ليُملأ تلقائيًا بعد السحب',
            programmaticExtractionSource: 'استخراج برمجي',
            htmlExtractionSource: 'استخراج من الصفحة',
            cachedExtraction: 'نتيجة محفوظة مؤقتًا',
            extractionQuality: 'جودة الاستخراج',
            extractionPreviewUsageHint: 'هذه معاينة للمراجعة فقط؛ النص المعتمد يظهر في حقل المنافس أعلاه.',
            pageTableOfContents: 'عناوين الصفحة',
            noTableOfContents: 'لم تُستخرج عناوين من هذه الصفحة.',
            manualCompetitorTextSaved: 'تم حفظ نص المنافس.',
            manualCompetitorTextSaveFailed: 'تعذر حفظ نص المنافس.',
            competitorApiUnavailable: 'خدمة استخراج محتوى المنافس غير متاحة حاليًا.',
            competitorExtractionFailed: 'تعذر استخراج محتوى المنافس.',
            competitorUrlRequired: 'أدخل رابط المنافس أولًا.',
            programmaticExtractionRunning: 'جارٍ استخراج المحتوى برمجيًا…',
            programmaticExtractionCacheHit: 'تم استخدام محتوى محفوظ مؤقتًا.',
            programmaticExtractionSucceeded: 'اكتمل الاستخراج البرمجي.',
            programmaticExtractionCancelled: 'تم إيقاف الاستخراج البرمجي.',
            programmaticExtractionUnsafeUrl: 'رابط المنافس غير مسموح أو غير آمن.',
            programmaticExtractionFallback: 'تعذر الاستخراج البرمجي؛ جارٍ استخدام الاستخراج التلقائي كبديل.',
            competitorHtmlRequired: 'ألصق محتوى HTML أولًا.',
        } : {}),
    };
    const competitorActionText = competitorText;
    useEffect(() => {
        const currentProviderAvailable = competitorGeminiProvider === 'geminiPaid'
            ? isGeminiPaidAvailable
            : isGeminiFreeAvailable;
        if (!currentProviderAvailable) {
            setCompetitorGeminiProvider(isGeminiPaidAvailable ? 'geminiPaid' : 'gemini');
        }
    }, [competitorGeminiProvider, isGeminiFreeAvailable, isGeminiPaidAvailable]);

    useEffect(() => {
        const tabOrder = ['ai', 'competitors', 'writing', 'links'] as const;
        const handleTabShortcut = (event: KeyboardEvent) => {
            if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const digit = Number(event.code.replace('Digit', ''));
            if (!event.code.startsWith('Digit') || digit < 4 || digit > 7) return;

            event.preventDefault();
            setActiveTab(tabOrder[digit - 4]);
            if (collapsed) onToggleCollapsed?.();
        };

        window.addEventListener('keydown', handleTabShortcut);
        return () => window.removeEventListener('keydown', handleTabShortcut);
    }, [collapsed, onToggleCollapsed]);

    useEffect(() => () => {
        Object.values(programmaticExtractionControllersRef.current).forEach(controller => controller.abort());
        programmaticExtractionControllersRef.current = {};
    }, []);

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
            const normalizedUrls = urls.map(url => url.trim()).filter(Boolean).slice(0, MAX_ARTICLE_COMPETITORS);
            if (normalizedUrls.length === 0) return;

            managedCompetitorPositionsRef.current = new Set();
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

    const handleDiscoveredCompetitors = useCallback((rows: CompetitorDiscoveryRow[]) => {
        const rowsByPosition = new Map(rows.map(row => [row.position, row]));
        managedCompetitorPositionsRef.current = new Set(rows.map(row => row.position));
        setBulkCompetitorText('');
        setCompetitorUrls(createDefaultCompetitorUrls().map((_, index) => {
            const row = rowsByPosition.get(index + 1);
            return row?.canonicalUrl || row?.sourceUrl || '';
        }));
        setCompetitorHtmls(createDefaultCompetitorHtmls());
        setCompetitorTexts(createDefaultCompetitorTexts().map((_, index) => {
            const row = rowsByPosition.get(index + 1);
            return row && (
                row.status === 'completed'
                || isCompetitorExtractionFailureText(row.contentText)
            )
                ? row.contentText
                : '';
        }));
        setCompetitorExtractions(createDefaultCompetitorExtractions().map((emptyState, index) => {
            const row = rowsByPosition.get(index + 1);
            if (!row) return emptyState;
            if (row.status === 'completed') {
                return {
                    status: 'success',
                    source: row.extractionProvider.startsWith('firecrawl')
                        ? 'firecrawl'
                        : row.extractionProvider.startsWith('programmatic')
                            ? 'programmatic'
                            : row.extractionProvider === 'manual'
                                ? 'text'
                                : 'url',
                    error: '',
                    content: {
                        url: row.canonicalUrl || row.sourceUrl,
                        canonicalUrl: row.canonicalUrl || row.sourceUrl,
                        fetchedUrl: row.canonicalUrl || row.sourceUrl,
                        provider: row.extractionProvider,
                        title: row.title,
                        description: row.description,
                        headings: row.headings,
                        paragraphs: row.contentText.split(/\n{2,}/).map(item => item.trim()).filter(Boolean),
                        listItems: [],
                        text: row.contentText,
                        wordCount: row.wordCount,
                    },
                } satisfies CompetitorExtractionState;
            }
            if (row.status === 'failed' || row.status === 'cancelled') {
                return {
                    status: 'error',
                    source: row.extractionProvider === 'firecrawl_programmatic_failed'
                        ? 'programmatic'
                        : 'url',
                    content: null,
                    error: row.errorMessage || (row.status === 'cancelled' ? 'Extraction cancelled.' : 'Extraction failed.'),
                } satisfies CompetitorExtractionState;
            }
            return {
                status: 'loading',
                source: 'firecrawl',
                content: null,
                error: '',
            } satisfies CompetitorExtractionState;
        }));
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
            managedCompetitorPositionsRef.current = new Set();
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
            .filter(definition => (
                definition.source === 'smartAnalysis'
                && !isRetiredEngineeringCommandId(definition.id)
            ))
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

    const readyCommandCompetitorSources = useMemo<CompetitorComparisonSource[]>(() => {
        const slotCount = Math.max(competitorExtractions.length, competitorTexts.length, competitorUrls.length);
        return Array.from({ length: slotCount }, (_, index): CompetitorComparisonSource | null => {
            const extraction = competitorExtractions[index];
            const content = extraction?.content;
            if (isCompetitorExtractionFailureText(competitorTexts[index])) return null;
            const plainText = stripExtractionLabels(normalizePlainCompetitorText(
                getUsableCompetitorText(competitorTexts[index]),
            ));
            const extractedText = stripExtractionLabels(normalizePlainCompetitorText(content?.text || ''));
            return {
                competitorNumber: index + 1,
                url: content?.url || content?.fetchedUrl || competitorUrls[index]?.trim() || '',
                title: content?.title || '',
                text: plainText || extractedText,
            };
        }).filter((source): source is CompetitorComparisonSource => Boolean(
            source && (source.text.trim() || source.url.trim()),
        ));
    }, [competitorExtractions, competitorTexts, competitorUrls]);

    const competitorStatSources = useMemo(() => {
        const slotCount = Math.max(competitorTexts.length, competitorExtractions.length);
        return Array.from({ length: slotCount }, (_, index) => ({
            competitorNumber: index + 1,
            text: getCompetitorStatText(index, competitorTexts, competitorExtractions),
        })).filter(source => source.text);
    }, [competitorExtractions, competitorTexts]);

    useEffect(() => {
        window.dispatchEvent(new CustomEvent(COMPETITOR_TEXTS_CHANGED_EVENT, {
            detail: {
                texts: competitorStatSources.map(source => source.text),
            },
        }));
    }, [competitorStatSources]);

    const competitorPhraseAnalysisContext = useMemo(() => ({
        articleLanguage,
        primaryKeyword: articleKeywords.primary,
    }), [articleKeywords.primary, articleLanguage]);

    const competitorTextStats = useMemo(
        () => createCompetitorTextStats(
            competitorStatSources.map(source => source.text),
            competitorPhraseAnalysisContext,
        ),
        [competitorPhraseAnalysisContext, competitorStatSources],
    );

    const competitorTextStatsBySlot = useMemo(() => {
        const statsByCompetitor = new Map(
            competitorStatSources.map(source => [
                source.competitorNumber,
                createCompetitorTextStats([source.text], competitorPhraseAnalysisContext),
            ]),
        );
        return Array.from(
            { length: Math.max(competitorUrls.length, competitorTexts.length, competitorExtractions.length) },
            (_, index) => (
                statsByCompetitor.get(index + 1)
                || createCompetitorTextStats([], competitorPhraseAnalysisContext)
            ),
        );
    }, [
        competitorExtractions.length,
        competitorPhraseAnalysisContext,
        competitorStatSources,
        competitorTexts.length,
        competitorUrls.length,
    ]);

    const sharedCompetitorPhrases = useMemo(
        () => createSharedCompetitorPhrases(
            competitorStatSources,
            competitorPhraseAnalysisContext,
        ),
        [competitorPhraseAnalysisContext, competitorStatSources],
    );

    const competitorPhraseIntelligenceEnabled = (
        aiProviderCapabilities.contentWriting.competitorPhraseIntelligenceEnabled !== false
    );
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
        const isIndependentCompetitorCommand = command.id === COMPETITOR_COMPARISON_COMMAND_ID;
        return {
            commandId: command.id,
            commandLabel: command.label,
            userPrompt: isIndependentCompetitorCommand
                ? command.value
                : appendSelectedAttachments(command.value, options),
            options,
            skipPatchInstructions: command.skipPatchInstructions,
            savesContentSummary: command.savesContentSummary,
            competitorSources: isIndependentCompetitorCommand
                ? readyCommandCompetitorSources
                : undefined,
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

    // Keep API analysis and both external bridges aligned on attachments/options.
    const buildCurrentSmartAnalysisRequest = () => ({
        userPrompt: appendSelectedAttachments(aiCommand, aiOptions),
        options: aiOptions,
        historyMeta: selectedReadyCommands.length === 1 ? readyCommandHistoryMeta : undefined,
    });

    const buildManualBridgePrompt = (provider: ExternalAiBridgeProvider): string | null => {
        if (!validateAiArticleContext(isArabicLocale ? 'التحليل الذكي الخارجي' : 'External smart analysis')) return null;
        if (selectedReadyCommands.length > 1) {
            window.alert(isArabicLocale
                ? 'الأوامر المحددة تُنفذ كطلبات مستقلة. استخدم أزرار Gemini أو ChatGPT داخل المحرر بدل جمعها في مطالبة خارجية واحدة.'
                : 'Selected commands run as separate requests. Use the in-editor Gemini or ChatGPT buttons instead of combining them in one external prompt.');
            return null;
        }
        if (selectedReadyCommand?.id === COMPETITOR_COMPARISON_COMMAND_ID) {
            window.alert(isArabicLocale
                ? 'هذا الأمر يحتاج عدة طلبات مستقلة ثم دمجًا نهائيًا، لذلك شغّله من أزرار Gemini أو ChatGPT داخل المحرر.'
                : 'This command requires independent competitor requests and a final synthesis. Run it with the in-editor Gemini or ChatGPT buttons.');
            return null;
        }
        if (selectedReadyCommands.length > 0) {
            clearReadyCommandSelectionOnNextOpenRef.current = true;
        }
        const request = buildCurrentSmartAnalysisRequest();
        manualBridgeHistoryMetaRef.current[provider] = request.historyMeta;
        return buildSmartAnalysisPrompt(request.userPrompt, request.options, request.historyMeta);
    };

    const handleImportManualAiResponse = (provider: ExternalAiBridgeProvider, responseText: string) => {
        const historyMeta = manualBridgeHistoryMetaRef.current[provider]
            || (selectedReadyCommands.length === 1 ? readyCommandHistoryMeta : undefined);
        importManualAiResponse(responseText, provider, historyMeta);
        manualBridgeHistoryMetaRef.current[provider] = undefined;
        if (provider === 'gemini') setIsGeminiExpanded(true);
        else setIsChatGptExpanded(true);
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
            case ENGINEERING_PROMPT_IDS.smartAnalysis.competitorContentComparison:
                return <FilePlus2 size={16} className={iconClass} />;
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
        if (readyCommandBatchItems[0]?.commandId === COMPETITOR_COMPARISON_COMMAND_ID) {
            handleCompetitorComparisonAnalyze(readyCommandBatchItems[0], 'gemini', selectedSmartGeminiModel);
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
        if (readyCommandBatchItems[0]?.commandId === COMPETITOR_COMPARISON_COMMAND_ID) {
            handleCompetitorComparisonAnalyze(readyCommandBatchItems[0], 'geminiPaid');
            return;
        }

        const request = buildCurrentSmartAnalysisRequest();
        handleAiAnalyze(request.userPrompt, request.options, request.historyMeta, 'geminiPaid');
    };

    const handleRunChatGptAnalysis = () => {
        if (!isOpenAiAvailable) return;
        if (selectedReadyCommands.length > 0) {
            clearReadyCommandSelectionOnNextOpenRef.current = true;
        }
        setIsChatGptExpanded(true);
        if (selectedReadyCommands.length > 1) {
            handleGeminiReadyCommandsAnalyze(readyCommandBatchItems, 'chatgpt');
            return;
        }
        if (readyCommandBatchItems[0]?.commandId === COMPETITOR_COMPARISON_COMMAND_ID) {
            handleCompetitorComparisonAnalyze(readyCommandBatchItems[0], 'chatgpt');
            return;
        }
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
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index
            ? {
                status: value.trim() ? 'success' : 'idle',
                source: 'text',
                content: null,
                error: '',
                notice: '',
            }
            : item
        ));
    };

    const handleCompetitorTextCommit = async (index: number) => {
        const contentText = getUsableCompetitorText(competitorTexts[index]);
        if (
            !activeArticleId
            || !contentText
            || !managedCompetitorPositionsRef.current.has(index + 1)
        ) {
            return;
        }

        try {
            await saveArticleCompetitorManualText({
                articleId: activeArticleId,
                position: index + 1,
                contentText,
            });
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index
                ? {
                    ...item,
                    status: 'success',
                    source: 'text',
                    error: '',
                    notice: competitorActionText.manualCompetitorTextSaved,
                }
                : item
            ));
        } catch (error) {
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index
                ? {
                    ...item,
                    status: 'error',
                    source: 'text',
                    error: error instanceof Error
                        ? error.message
                        : competitorActionText.manualCompetitorTextSaveFailed,
                    notice: '',
                }
                : item
            ));
        }
    };

    const setCompetitorPlainTextFromExtraction = (
        index: number,
        content: CompetitorExtractedContent,
    ) => {
        // Every direct extraction method converges here. Firecrawl queue completion reaches
        // the same canonical field through handleDiscoveredCompetitors; downstream analysis
        // and content writing never consume a separate preview card.
        const extractedText = normalizePlainCompetitorText(content.text);
        if (!extractedText) return;
        setCompetitorTexts(prev => prev.map((text, textIndex) => (
            textIndex === index ? extractedText : text
        )));
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
        notice = '',
    ) => {
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            status: 'loading',
            source,
            error: '',
            notice,
        } : item));

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
                        articleId: activeArticleId || undefined,
                        articleTitle,
                        articleKey: activeArticleId || articleTitle || `competitor-${index + 1}`,
                        action: isArabicLocale
                            ? `استخراج المنافس ${index + 1} عبر الذكاء الاصطناعي`
                            : `AI extraction for competitor ${index + 1}`,
                        batchIndex: index + 1,
                        batchTotal: competitorExtractions.length,
                    },
                },
            });
            const { status, data } = engineResult;
            if (status === 404) {
                throw new Error(competitorActionText.competitorApiUnavailable);
            }
            if (status === 499 || data.cancelled === true) {
                setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                    status: 'idle',
                    source,
                    content: null,
                    error: '',
                    notice,
                } : item));
                return;
            }
            if (status < 200 || status >= 300) {
                throw new Error(data.error || `${competitorActionText.competitorExtractionFailed} (${status})`);
            }

            const parsed = extractJsonFromGeminiText(typeof data.text === 'string' ? data.text : '');
            if (!parsed || typeof parsed !== 'object') {
                throw new Error(competitorActionText.competitorExtractionFailed);
            }
            if (typeof parsed.error === 'string' && parsed.error.trim()) {
                throw new Error(parsed.error.trim());
            }

            const content = normalizeCompetitorContent({
                ...parsed,
                provider: data.provider || provider,
            }, fallbackUrl);
            setCompetitorPlainTextFromExtraction(index, content);

            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'success',
                source,
                content,
                error: '',
                notice,
            } : item));
        } catch (error) {
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'error',
                source,
                content: null,
                error: error instanceof Error ? error.message : competitorActionText.competitorExtractionFailed,
                notice,
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
                error: competitorActionText.competitorUrlRequired,
            } : item));
            return;
        }

        await runCompetitorExtraction(index, buildCompetitorPrompt(url), true, 'url', url);
    };

    const handleExtractCompetitorProgrammatically = async (index: number) => {
        const url = competitorUrls[index]?.trim();
        if (!url) {
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'error',
                source: 'programmatic',
                content: null,
                error: competitorActionText.competitorUrlRequired,
                notice: '',
            } : item));
            return;
        }

        const controller = new AbortController();
        programmaticExtractionControllersRef.current[index]?.abort();
        programmaticExtractionControllersRef.current[index] = controller;
        setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            status: 'loading',
            source: 'programmatic',
            error: '',
            notice: competitorActionText.programmaticExtractionRunning,
        } : item));

        try {
            const extracted = await extractCompetitorProgrammatically(url, {
                signal: controller.signal,
            });
            if (programmaticExtractionControllersRef.current[index] !== controller) return;
            const content = normalizeCompetitorContent(extracted, url);
            setCompetitorPlainTextFromExtraction(index, content);
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'success',
                source: 'programmatic',
                content,
                error: '',
                notice: extracted.cacheHit
                    ? competitorActionText.programmaticExtractionCacheHit
                    : competitorActionText.programmaticExtractionSucceeded,
            } : item));
        } catch (error) {
            if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
                setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                    ...item,
                    status: 'idle',
                    source: 'programmatic',
                    error: '',
                    notice: competitorActionText.programmaticExtractionCancelled,
                } : item));
                return;
            }

            if (
                error instanceof CompetitorDiscoveryRequestError
                && ['invalid_competitor_url', 'unsafe_competitor_url', 'unsafe_competitor_address'].includes(error.code)
            ) {
                setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                    status: 'error',
                    source: 'programmatic',
                    content: null,
                    error: competitorActionText.programmaticExtractionUnsafeUrl,
                    notice: '',
                } : item));
                return;
            }

            const fallbackNotice = competitorActionText.programmaticExtractionFallback;
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'loading',
                source: 'url',
                content: null,
                error: '',
                notice: fallbackNotice,
            } : item));
            await runCompetitorExtraction(
                index,
                buildCompetitorPrompt(url),
                true,
                'url',
                url,
                competitorGeminiProvider,
                fallbackNotice,
            );
        } finally {
            if (programmaticExtractionControllersRef.current[index] === controller) {
                delete programmaticExtractionControllersRef.current[index];
            }
        }
    };

    const handleCancelProgrammaticExtraction = (index: number) => {
        programmaticExtractionControllersRef.current[index]?.abort();
    };

    const handleExtractCompetitorHtml = (index: number) => {
        const html = competitorHtmls[index]?.trim();
        if (!html) {
            setCompetitorExtractions(prev => prev.map((item, itemIndex) => itemIndex === index ? {
                status: 'error',
                source: 'html',
                content: null,
                error: competitorActionText.competitorHtmlRequired,
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
                setCompetitorPlainTextFromExtraction(index, content);
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
                    error: error instanceof Error ? error.message : competitorActionText.competitorExtractionFailed,
                } : item));
            }
        }, 0);
    };

    const getPatchActionLabel = (operation: string) => (
        operation === 'replace_block' || operation === 'replace_text'
            ? (isArabicLocale ? 'استبدال' : 'Replace')
            : (isArabicLocale ? 'إضافة' : 'Add')
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
        const cleanPatchTitle = (patch.title || (isArabicLocale ? 'نص مقترح' : 'Suggested text'))
            .replace(/^(?:إضافة|اضافة|استبدال|add|replace)\s*(?:-|:|\u2013)\s*/i, '')
            .trim() || (isArabicLocale ? 'نص مقترح' : 'Suggested text');
        const patchLocationText = patch.placementLabel || patch.anchorText || patch.targetText || (isArabicLocale ? 'لم يتم تحديد موضع نصي دقيق.' : 'No exact editor location was provided.');
        const patchReason = patch.reason || (isArabicLocale ? 'سبب الاقتراح غير محدد.' : 'No reason was provided.');
        const reasonLabel = patch.operation === 'replace_block' || patch.operation === 'replace_text'
            ? (isArabicLocale ? 'سبب الاستبدال' : 'Replacement reason')
            : (isArabicLocale ? 'سبب إضافة النص المقترح' : 'Reason for adding');
        const hasMergeDeleteTarget = Boolean(
            patch.mergeDeleteTargetText?.trim() ||
            patch.mergeDeletePlacementLabel?.trim() ||
            patch.mergeDeleteAnchorText?.trim()
        );
        const mergeDeleteLocationText = patch.mergeDeletePlacementLabel || patch.mergeDeleteAnchorText || patch.mergeDeleteTargetText || (isArabicLocale ? 'لم يتم تحديد موضع فقرة الحذف نصيًا.' : 'No paragraph removal location was provided.');
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
                            <span className="font-semibold">{isArabicLocale ? 'مكان النص في المحرر' : 'Editor location'}: </span>
                            {patchLocationText}
                        </div>
                    </div>
                    {patch.status === 'applied' && (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 size={13} />
                            {isArabicLocale ? 'تم' : 'Done'}
                        </span>
                    )}
                    {patch.status === 'failed' && (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-red-600 dark:text-red-400">
                            <AlertTriangle size={13} />
                            {isArabicLocale ? 'تعذر' : 'Failed'}
                        </span>
                    )}
                </div>

                <div className="mt-2 rounded-md border border-gray-100 bg-gray-50/80 p-2 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]/80">
                    <div className="mb-1 text-[10px] font-bold text-[#8a6f1d] dark:text-[#f2d675]">{isArabicLocale ? 'النص المقترح' : 'Suggested text'}</div>
                    <div className="text-xs text-gray-700 dark:text-gray-300 ai-output" dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(patch.contentMarkdown) }} />
                </div>

                {hasMergeDeleteTarget && (
                    <div className="mt-2 rounded-md border border-red-100 bg-red-50/70 p-2 dark:border-red-900/30 dark:bg-red-900/10">
                        <div className="text-[10px] font-bold text-red-700 dark:text-red-300">{isArabicLocale ? 'الفقرة المدمجة المطلوب حذفها' : 'Merged paragraph to remove'}</div>
                        <div className="mt-1 text-[10px] leading-relaxed text-gray-600 dark:text-gray-300 break-words">
                            <span className="font-semibold">{isArabicLocale ? 'مكان الفقرة في المحرر' : 'Removal location'}: </span>
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
                                {isArabicLocale ? 'موضع الحذف' : 'Locate removal'}
                            </button>
                            <button
                                type="button"
                                onClick={() => deleteAiInsertionPatchMergeDeleteTarget(provider, patch.id)}
                                disabled={mergeDeleteStatus === 'applied'}
                                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {mergeDeleteStatus === 'applied' ? <CheckCircle2 size={13} /> : <Trash2 size={13} />}
                                {mergeDeleteStatus === 'applied'
                                    ? (isArabicLocale ? 'تم حذف الفقرة' : 'Paragraph removed')
                                    : (isArabicLocale ? 'حذف الفقرة' : 'Remove paragraph')}
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
                        {isArabicLocale ? 'الموضع' : 'Locate'}
                    </button>
                    <button
                        type="button"
                        onClick={() => handleCopyPatch(patch.id, patch.contentMarkdown)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-gray-100 dark:bg-[#2A2A2A] text-gray-700 dark:text-gray-200 hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20"
                    >
                        <Copy size={13} />
                        {isCopied ? (isArabicLocale ? 'تم النسخ' : 'Copied') : (isArabicLocale ? 'نسخ' : 'Copy')}
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

    const renderIndependentCompetitorResults = (
        provider: AiPatchProvider,
        results: CompetitorComparisonMapResult[] = aiCompetitorComparisonResults[provider],
    ) => {
        if (results.length === 0) return null;
        const locale = t.locale === 'en' ? 'en' : 'ar';

        return (
            <div className="mb-3 space-y-2" data-testid={`independent-competitor-results-${provider}`}>
                <div className="flex items-center justify-between gap-2 text-[11px] font-black text-gray-700 dark:text-gray-200">
                    <span>{locale === 'ar' ? 'نتيجة كل منافس بصورة مستقلة' : 'Each competitor result independently'}</span>
                    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[9px] text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
                        {results.length}
                    </span>
                </div>
                {results.map(result => {
                    const sourceUrl = toSafeCompetitorSourceUrl(result.sourceUrl);
                    return (
                        <section
                            key={`${provider}-competitor-result-${result.competitorNumber}`}
                            className="rounded-md border border-blue-200 bg-blue-50/40 p-2 dark:border-blue-500/20 dark:bg-blue-500/5"
                        >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="text-[11px] font-black text-blue-800 dark:text-blue-200">
                                    {locale === 'ar' ? `المنافس ${result.competitorNumber}` : `Competitor ${result.competitorNumber}`}
                                    {result.sourceTitle ? ` — ${result.sourceTitle}` : ''}
                                </div>
                                {sourceUrl && (
                                    <a
                                        href={sourceUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-[9px] font-bold text-blue-700 hover:underline dark:text-blue-300"
                                    >
                                        <ExternalLink size={11} />
                                        {locale === 'ar' ? 'فتح المصدر' : 'Open source'}
                                    </a>
                                )}
                            </div>
                            {result.items.length > 0 ? (
                                <div className="mt-2 space-y-1.5">
                                    {result.items.map((item, index) => (
                                        <article
                                            key={`${provider}-${result.competitorNumber}-${item.id}-${index}`}
                                            className="rounded border border-gray-200 bg-white p-2 dark:border-[#3C3C3C] dark:bg-[#242424]"
                                        >
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <span className="text-[10px] font-black text-gray-800 dark:text-gray-100">{item.topic}</span>
                                                <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[8px] font-black text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
                                                    {(COMPETITOR_COMPARISON_CATEGORY_LABELS[item.category] || { ar: item.category, en: item.category })[locale]}
                                                </span>
                                                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[8px] font-bold text-gray-500 dark:bg-[#333] dark:text-gray-300">
                                                    {locale === 'ar' ? 'الأهمية' : 'Importance'}:{' '}
                                                    {(COMPETITOR_COMPARISON_IMPORTANCE_LABELS[item.importance] || { ar: item.importance, en: item.importance })[locale]}
                                                </span>
                                            </div>
                                            <div className="mt-1 text-[10px] leading-5 text-gray-700 dark:text-gray-200">{item.summary}</div>
                                            {item.articleEvidence && (
                                                <div className="mt-1 border-s-2 border-emerald-400 ps-2 text-[9px] leading-5 text-gray-500 dark:text-gray-400">
                                                    <span className="font-black">{locale === 'ar' ? 'الموجود في المقالة' : 'In the article'}: </span>
                                                    {item.articleEvidence}
                                                </div>
                                            )}
                                            {item.competitorEvidence.map((evidence, evidenceIndex) => (
                                                <div
                                                    key={`${item.id}-evidence-${evidenceIndex}`}
                                                    className="mt-1 border-s-2 border-blue-300 ps-2 text-[9px] leading-5 text-gray-500 dark:text-gray-400"
                                                >
                                                    <span className="font-black">
                                                        {locale === 'ar' ? 'دليل المنافس' : 'Competitor evidence'}
                                                        {evidence.chunkId ? ` (${evidence.chunkId})` : ''}:{' '}
                                                    </span>
                                                    {evidence.excerpt}
                                                </div>
                                            ))}
                                        </article>
                                    ))}
                                </div>
                            ) : (
                                <div className="mt-2 text-[9px] text-gray-500 dark:text-gray-400">
                                    {locale === 'ar'
                                        ? 'اكتملت مقارنة هذا المنافس ولم تظهر نقطة مستقلة تستحق المعالجة.'
                                        : 'This competitor comparison completed with no independent item requiring action.'}
                                </div>
                            )}
                        </section>
                    );
                })}
            </div>
        );
    };

    const renderAiTab = () => (
        <div ref={smartAnalysisTabRef} className="flex flex-col h-full">
            <div className="flex p-[0.125rem] mx-[0.125rem] mt-[0.125rem] mb-[0.0625rem] bg-gray-200 dark:bg-[#2A2A2A] rounded-lg">
                <button onClick={() => setAiSubTab('new')} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${aiSubTab === 'new' ? 'bg-white dark:bg-[#1F1F1F] text-[#d4af37] shadow-sm' : 'text-gray-500'}`}>{tRs.newAnalysis}</button>
                <button onClick={() => setAiSubTab('history')} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${aiSubTab === 'history' ? 'bg-white dark:bg-[#1F1F1F] text-[#d4af37] shadow-sm' : 'text-gray-500'}`}>{t.aiHistory.title}</button>
                <button onClick={() => setAiSubTab('external')} className={`flex-1 px-1 py-1.5 text-[10px] font-bold leading-4 rounded-md transition-all ${aiSubTab === 'external' ? 'bg-white dark:bg-[#1F1F1F] text-[#d4af37] shadow-sm' : 'text-gray-500'}`}>{isArabicLocale ? 'السجل الخارجي' : 'External log'}</button>
            </div>

            <div className="flex-grow overflow-y-auto custom-scrollbar p-[0.25rem] space-y-[0.25rem]">
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
                                        ? `سيتم تنفيذ ${selectedReadyCommands.length} أوامر بصورة مستقلة ومتتابعة لدى مزود Gemini المختار.`
                                        : `${selectedReadyCommands.length} commands will run as separate sequential requests with the selected Gemini provider.`}
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
                            <div className={`grid gap-2 ${smartProviderGridClass}`}>
                                {isGeminiFreeEnabled && <div className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-[#d4af37] text-white">
                                    <button
                                        onClick={handleRunGeminiAnalysis}
                                        disabled={isAiLoading.gemini || !isGeminiFreeAvailable}
                                        title={!isGeminiFreeAvailable
                                            ? (isArabicLocale ? 'Gemini مفعّل دون مفتاح مسموح في خزنة اللوحة' : 'Gemini is enabled without an allowed dashboard credential')
                                            : (isArabicLocale ? 'تشغيل التحليل باستخدام Gemini' : 'Run analysis with Gemini')}
                                        className="flex min-h-9 items-center justify-center gap-1.5 px-1.5 py-1.5 hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {isAiLoading.gemini ? <Wand2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                        <span className="text-xs font-bold">Gemini</span>
                                    </button>
                                    <select
                                        value={selectedSmartGeminiModel}
                                        onChange={event => setSelectedSmartGeminiModel(normalizeGeminiFreeModel(event.target.value, geminiFreeModelValues))}
                                        onClick={event => event.stopPropagation()}
                                        disabled={isAiLoading.gemini || !isGeminiFreeAvailable}
                                        title={t.locale === 'ar' ? 'اختيار موديل Gemini المجاني' : 'Choose free Gemini model'}
                                        dir="ltr"
                                        className="mx-1 mb-1 min-w-0 rounded-md border border-white/40 bg-white/95 px-1 py-0.5 text-[10px] font-bold text-[#333] outline-none focus:ring-1 focus:ring-white disabled:opacity-70"
                                    >
                                        {geminiFreeModelOptions.map(option => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </div>}
                                {isGeminiPaidEnabled && (
                                    <button
                                        onClick={handleRunGeminiPaidAnalysis}
                                        disabled={isAiLoading.geminiPaid || !isGeminiPaidAvailable}
                                        title={!isGeminiPaidAvailable
                                            ? (isArabicLocale ? 'Gemini Pro مفعّل دون مفتاح مسموح في خزنة اللوحة' : 'Gemini Pro is enabled without an allowed dashboard credential')
                                            : (isArabicLocale ? 'تشغيل التحليل باستخدام Gemini Pro' : 'Run analysis with Gemini Pro')}
                                        className="flex items-center justify-center gap-2 rounded-lg bg-[#d4af37] py-2 text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {isAiLoading.geminiPaid ? <Wand2 size={16} className="animate-spin" /> : <BadgeDollarSign size={16} />}
                                        <span className="text-xs font-bold">Pro</span>
                                    </button>
                                )}
                                {isOpenAiEnabled && (
                                    <button
                                        onClick={handleRunChatGptAnalysis}
                                        disabled={isAiLoading.chatgpt || !isOpenAiAvailable}
                                        title={!isOpenAiAvailable
                                            ? (isArabicLocale ? 'OpenAI مفعّل دون مفتاح مسموح في خزنة اللوحة' : 'OpenAI is enabled without an allowed dashboard credential')
                                            : (isArabicLocale ? 'تشغيل التحليل باستخدام OpenAI' : 'Run analysis with OpenAI')}
                                        className="flex items-center justify-center gap-2 rounded-lg bg-[#d4af37] py-2 text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {isAiLoading.chatgpt ? <Wand2 size={16} className="animate-spin" /> : <BrainCircuit size={16} />}
                                        <span className="text-xs font-bold">ChatGPT</span>
                                    </button>
                                )}
                            </div>

                            <ExternalAiBridgePanel
                                isArabic={isArabicLocale}
                                openMode={chatGptOpenMode}
                                anchorRef={smartAnalysisTabRef}
                                getPrompt={buildManualBridgePrompt}
                                onImportResponse={handleImportManualAiResponse}
                            />
                        </div>

                        <div className="-mx-3 space-y-2 pt-3 border-t border-gray-200 dark:border-[#3C3C3C]">
                            {/* Results Gemini */}
                            {isGeminiFreeEnabled && <div className="bg-[#d4af37]/10 dark:bg-[#d4af37]/10 rounded-md overflow-hidden border border-[#d4af37]/20 dark:border-[#d4af37]/25">
                                <div className="p-2 bg-[#d4af37]/15 dark:bg-[#d4af37]/20 flex justify-between cursor-pointer" onClick={() => setIsGeminiExpanded(!isGeminiExpanded)}>
                                    <span className="text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">{isArabicLocale ? 'نتائج Gemini' : 'Gemini results'}</span>
                                    <ChevronDown size={14} className={isGeminiExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isGeminiExpanded && (
                                    <div className="p-2 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {renderIndependentCompetitorResults('gemini')}
                                        {aiCompetitorComparisonResults.gemini.length > 0
                                            && !isAiLoading.gemini
                                            && (aiResults.gemini || aiInsertionPatches.gemini.length > 0) && (
                                                <div className="mb-2 text-[11px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                                                    {isArabicLocale ? 'نتيجة الدمج النهائي لجميع المنافسين' : 'Final synthesis result for all competitors'}
                                                </div>
                                            )}
                                        {aiResults.gemini || aiInsertionPatches.gemini.length > 0
                                            ? renderAnalysisResult('gemini', aiResults.gemini)
                                            : aiCompetitorComparisonResults.gemini.length === 0
                                                ? <span className="text-gray-400 italic">{isArabicLocale ? 'لا توجد نتائج.' : 'No results.'}</span>
                                                : null}
                                        {aiCompetitorComparisonResults.gemini.length > 0
                                            && !isAiLoading.gemini
                                            && !aiResults.gemini
                                            && aiInsertionPatches.gemini.length === 0 && (
                                                <div className="rounded border border-gray-200 bg-white/60 p-2 text-[10px] text-gray-500 dark:border-[#3C3C3C] dark:bg-[#242424] dark:text-gray-400">
                                                    {isArabicLocale
                                                        ? 'اكتمل الدمج النهائي لجميع المنافسين، ولم ينتج عنه تعديل آمن يحتاج إلى تطبيق في المحرر.'
                                                        : 'The final competitor synthesis completed with no safe editor change requiring application.'}
                                                </div>
                                            )}
                                    </div>
                                )}
                            </div>}
                            {/* Results Gemini Pro */}
                            {isGeminiPaidEnabled && <div className="bg-[#d4af37]/10 dark:bg-[#d4af37]/10 rounded-md overflow-hidden border border-[#d4af37]/20 dark:border-[#d4af37]/25">
                                <div className="p-2 bg-[#d4af37]/15 dark:bg-[#d4af37]/20 flex justify-between cursor-pointer" onClick={() => setIsGeminiPaidExpanded(!isGeminiPaidExpanded)}>
                                    <span className="text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">{isArabicLocale ? 'نتائج Gemini Pro' : 'Gemini Pro results'}</span>
                                    <ChevronDown size={14} className={isGeminiPaidExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isGeminiPaidExpanded && (
                                    <div className="p-2 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {renderIndependentCompetitorResults('geminiPaid')}
                                        {aiCompetitorComparisonResults.geminiPaid.length > 0
                                            && !isAiLoading.geminiPaid
                                            && (aiResults.geminiPaid || aiInsertionPatches.geminiPaid.length > 0) && (
                                                <div className="mb-2 text-[11px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                                                    {isArabicLocale ? 'نتيجة الدمج النهائي لجميع المنافسين' : 'Final synthesis result for all competitors'}
                                                </div>
                                            )}
                                        {aiResults.geminiPaid || aiInsertionPatches.geminiPaid.length > 0
                                            ? renderAnalysisResult('geminiPaid', aiResults.geminiPaid)
                                            : aiCompetitorComparisonResults.geminiPaid.length === 0
                                                ? <span className="text-gray-400 italic">{isArabicLocale ? 'لا توجد نتائج.' : 'No results.'}</span>
                                                : null}
                                        {aiCompetitorComparisonResults.geminiPaid.length > 0
                                            && !isAiLoading.geminiPaid
                                            && !aiResults.geminiPaid
                                            && aiInsertionPatches.geminiPaid.length === 0 && (
                                                <div className="rounded border border-gray-200 bg-white/60 p-2 text-[10px] text-gray-500 dark:border-[#3C3C3C] dark:bg-[#242424] dark:text-gray-400">
                                                    {isArabicLocale
                                                        ? 'اكتمل الدمج النهائي لجميع المنافسين، ولم ينتج عنه تعديل آمن يحتاج إلى تطبيق في المحرر.'
                                                        : 'The final competitor synthesis completed with no safe editor change requiring application.'}
                                                </div>
                                            )}
                                    </div>
                                )}
                            </div>}
                            {/* Results ChatGPT */}
                            {isOpenAiEnabled && <div className="bg-[#d4af37]/10 dark:bg-[#d4af37]/10 rounded-md overflow-hidden border border-[#d4af37]/20 dark:border-[#d4af37]/25">
                                <div className="p-2 bg-[#d4af37]/15 dark:bg-[#d4af37]/20 flex justify-between cursor-pointer" onClick={() => setIsChatGptExpanded(!isChatGptExpanded)}>
                                    <span className="text-xs font-bold text-[#8a6f1d] dark:text-[#f2d675]">{isArabicLocale ? 'نتائج ChatGPT' : 'ChatGPT results'}</span>
                                    <ChevronDown size={14} className={isChatGptExpanded ? 'rotate-180' : ''} />
                                </div>
                                {isChatGptExpanded && (
                                    <div className="p-2 text-sm text-gray-700 dark:text-gray-300 ai-output min-h-[50px]">
                                        {renderIndependentCompetitorResults('chatgpt')}
                                        {aiCompetitorComparisonResults.chatgpt.length > 0
                                            && !isAiLoading.chatgpt
                                            && (aiResults.chatgpt || aiInsertionPatches.chatgpt.length > 0) && (
                                                <div className="mb-2 text-[11px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                                                    {isArabicLocale ? 'نتيجة الدمج النهائي لجميع المنافسين' : 'Final synthesis result for all competitors'}
                                                </div>
                                            )}
                                        {aiResults.chatgpt || aiInsertionPatches.chatgpt.length > 0
                                            ? renderAnalysisResult('chatgpt', aiResults.chatgpt)
                                            : aiCompetitorComparisonResults.chatgpt.length === 0
                                                ? <span className="text-gray-400 italic">{isArabicLocale ? 'لا توجد نتائج.' : 'No results.'}</span>
                                                : null}
                                        {aiCompetitorComparisonResults.chatgpt.length > 0
                                            && !isAiLoading.chatgpt
                                            && !aiResults.chatgpt
                                            && aiInsertionPatches.chatgpt.length === 0 && (
                                                <div className="rounded border border-gray-200 bg-white/60 p-2 text-[10px] text-gray-500 dark:border-[#3C3C3C] dark:bg-[#242424] dark:text-gray-400">
                                                    {isArabicLocale
                                                        ? 'اكتمل الدمج النهائي لجميع المنافسين، ولم ينتج عنه تعديل آمن يحتاج إلى تطبيق في المحرر.'
                                                        : 'The final competitor synthesis completed with no safe editor change requiring application.'}
                                                </div>
                                            )}
                                    </div>
                                )}
                            </div>}
                        </div>
                    </>
                ) : (
                    <React.Suspense fallback={<div className="p-4 text-center text-xs font-bold text-gray-400">{isArabicLocale ? 'جار تحميل النتائج...' : 'Loading results...'}</div>}>
                        {aiSubTab === 'history' ? <AIHistoryTab /> : <ExternalAnalysisResultsTab articleId={activeArticleId} articleTitle={articleTitle} />}
                    </React.Suspense>
                )}
            </div>
        </div>
    );

    const renderCompetitorsTab = () => {
        // Shadow the app-wide translation object only inside this tab so all
        // existing competitor labels follow the article language consistently.
        const t = {
            locale: competitorLocale,
            common: { words: competitorIsArabic ? 'كلمة' : 'words' },
        };
        const tRs = competitorText;
        return (
        <div className="flex h-full flex-col">
            <div className="flex-grow overflow-y-auto custom-scrollbar p-[0.25rem] space-y-[0.25rem]">
                <CompetitorDiscoveryPanel
                    articleId={activeArticleId}
                    articleTitle={articleTitle}
                    primaryKeyword={articleKeywords.primary}
                    alternativeKeywords={articleKeywords.secondaries}
                    articleLanguage={articleLanguage}
                    goalContext={articleGoalContext}
                    companyName={articleKeywords.company}
                    locale={competitorLocale}
                    onCompetitorsChange={handleDiscoveredCompetitors}
                />

                <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                    <div className="mb-2 text-xs font-bold text-gray-700 dark:text-gray-200">
                        {t.locale === 'ar'
                            ? 'نموذج الاستخراج الذكي لكل رابط'
                            : 'Gemini model for each link’s “AI extraction” button only'}
                    </div>
                    <div className={`grid gap-2 ${isGeminiFreeEnabled && isGeminiPaidEnabled ? 'grid-cols-2' : 'grid-cols-1'}`}>
                        {isGeminiFreeEnabled && <button
                            type="button"
                            onClick={() => setCompetitorGeminiProvider('gemini')}
                            disabled={!isGeminiFreeAvailable}
                            title={!isGeminiFreeAvailable
                                ? (t.locale === 'ar' ? 'النموذج المجاني مفعّل دون مفتاح مسموح في خزنة اللوحة' : 'Gemini is enabled without a permitted dashboard credential')
                                : (t.locale === 'ar' ? 'النموذج المجاني' : 'Gemini')}
                            className={`flex items-center justify-center gap-1 rounded-md px-3 py-2 text-xs font-bold transition-colors ${
                                competitorGeminiProvider === 'gemini'
                                    ? 'bg-[#d4af37] text-white'
                                    : 'border border-[#d4af37]/35 bg-[#d4af37]/10 text-[#8a6f1d] hover:bg-[#d4af37]/20 dark:text-[#f2d675]'
                            }`}
                        >
                            <Sparkles size={14} />
                            {t.locale === 'ar' ? 'النموذج المجاني' : 'Gemini'}
                        </button>}
                        {isGeminiPaidEnabled && (
                            <button
                                type="button"
                                onClick={() => setCompetitorGeminiProvider('geminiPaid')}
                                disabled={!isGeminiPaidAvailable}
                                title={!isGeminiPaidAvailable
                                    ? (t.locale === 'ar' ? 'النموذج المتقدم مفعّل دون مفتاح مسموح في خزنة اللوحة' : 'Gemini Pro is enabled without a permitted dashboard credential')
                                    : (t.locale === 'ar' ? 'النموذج المتقدم' : 'Gemini Pro')}
                                className={`flex items-center justify-center gap-1 rounded-md px-3 py-2 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                    competitorGeminiProvider === 'geminiPaid'
                                        ? 'bg-[#d4af37] text-white'
                                        : 'border border-[#d4af37]/35 bg-[#d4af37]/10 text-[#8a6f1d] hover:bg-[#d4af37]/20 dark:text-[#f2d675]'
                                }`}
                            >
                                <BadgeDollarSign size={14} />
                                {t.locale === 'ar' ? 'النموذج المتقدم' : 'Gemini Pro'}
                            </button>
                        )}
                    </div>
                </div>

                <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                    <textarea
                        value={bulkCompetitorText}
                        onChange={(event) => setBulkCompetitorText(event.target.value)}
                        onPaste={handleBulkCompetitorTextPaste}
                        placeholder={t.locale === 'ar'
                            ? 'نص المنافس الأول...\n--\nنص المنافس الثاني...\n--\nنص المنافس الثالث...\n--\nنص المنافس الرابع...\n--\nنص المنافس الخامس...'
                            : 'First competitor text...\n--\nSecond competitor text...\n--\nThird competitor text...\n--\nFourth competitor text...\n--\nFifth competitor text...'}
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
                        <span>{t.locale === 'ar' ? 'تعبئة النصوص المعتمدة' : 'Fill canonical analysis texts'}</span>
                    </button>
                </div>

                {competitorUrls.map((url, index) => {
                    const extraction = competitorExtractions[index] || createEmptyCompetitorState();
                    // Firecrawl, manual text, and AI extraction already fill the editable
                    // canonical text box. Do not duplicate any of them in a result card.
                    const content = extraction.source === 'text'
                        || extraction.source === 'firecrawl'
                        || extraction.source === 'url'
                        ? null
                        : extraction.content;
                    const plainText = competitorTexts[index] || '';
                    const competitorStats = competitorTextStatsBySlot[index];
                    const repeatedPhrases = competitorStats?.repeatedPhrases || [];
                    const competitorWordCount = competitorStats?.totalWords || 0;
                    const isLoading = extraction.status === 'loading';
                    const isUrlLoading = isLoading && extraction.source === 'url';
                    const isProgrammaticLoading = isLoading && extraction.source === 'programmatic';
                    const isFirecrawlLoading = isLoading && extraction.source === 'firecrawl';
                    const firecrawlPendingHint = competitorIsArabic
                        ? 'هذا الرابط ينتظر عامل سحب المنافسين؛ لم تبدأ خدمة السحب بعد.'
                        : 'This URL is waiting for the competitor extraction worker; the Firecrawl request has not started yet.';
                    const extractionPreviewTitle = extraction.source === 'programmatic'
                        ? tRs.programmaticExtractionPreview
                        : tRs.htmlExtractionPreview;
                    return (
                        <div key={index} className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                            <div className="mb-2 flex min-w-0 items-center gap-2">
                                <label
                                    htmlFor={`competitor-url-${index}`}
                                    className="shrink-0 text-xs font-bold text-gray-600 dark:text-gray-300"
                                >
                                    {tRs.competitorLabel} {index + 1}
                                </label>
                                <input
                                    id={`competitor-url-${index}`}
                                    type="url"
                                    value={url}
                                    onChange={(event) => handleCompetitorUrlChange(index, event.target.value)}
                                    placeholder={tRs.competitorUrlPlaceholder}
                                    aria-label={`${tRs.competitorLabel} ${index + 1} — ${tRs.competitorUrlField}`}
                                    className="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-2 py-2 text-xs text-[#333333] outline-none placeholder:text-gray-400 focus:border-[#d4af37] focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100 dark:placeholder:text-gray-500"
                                    dir="ltr"
                                />
                            </div>
                            <div className="space-y-3">
                                <div>
                                    <div className="space-y-2">
                                        <div className="grid grid-cols-2 gap-2">
                                            <button
                                                type="button"
                                                onClick={() => handleExtractCompetitorUrl(index)}
                                                disabled={isLoading}
                                                title={isFirecrawlLoading ? firecrawlPendingHint : tRs.extractCompetitorWithAiHint}
                                                className="flex min-w-0 items-center justify-center gap-1 rounded-md bg-[#d4af37] px-2 py-2 text-[11px] font-bold text-white hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-60"
                                            >
                                                {isUrlLoading ? <Wand2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                                                <span className="truncate">{isUrlLoading ? tRs.extractingCompetitor : tRs.extractCompetitorWithAi}</span>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => isProgrammaticLoading
                                                    ? handleCancelProgrammaticExtraction(index)
                                                    : handleExtractCompetitorProgrammatically(index)}
                                                disabled={isLoading && !isProgrammaticLoading}
                                                title={isFirecrawlLoading
                                                    ? firecrawlPendingHint
                                                    : isProgrammaticLoading
                                                    ? tRs.stopProgrammaticExtraction
                                                    : tRs.extractCompetitorProgrammaticallyHint}
                                                className={`flex min-w-0 items-center justify-center gap-1 rounded-md border px-2 py-2 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                                    isProgrammaticLoading
                                                        ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300'
                                                        : 'border-[#d4af37]/50 bg-[#d4af37]/10 text-[#8a6f1d] hover:bg-[#d4af37]/20 dark:text-[#f2d675]'
                                                }`}
                                            >
                                                {isProgrammaticLoading ? <X size={14} /> : <Code2 size={14} />}
                                                <span className="truncate">
                                                    {isProgrammaticLoading
                                                        ? tRs.stopProgrammaticExtraction
                                                        : tRs.extractCompetitorProgrammatically}
                                                </span>
                                            </button>
                                        </div>
                                        {isFirecrawlLoading && (
                                            <div className="rounded-md border border-[#d4af37]/30 bg-[#d4af37]/10 px-2 py-1.5 text-[10px] font-bold leading-4 text-[#8a6f1d] dark:border-[#d4af37]/25 dark:bg-[#d4af37]/10 dark:text-[#f2d675]">
                                                {firecrawlPendingHint}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <textarea
                                        value={plainText}
                                        onChange={(event) => handleCompetitorTextChange(index, event.target.value)}
                                        onFocus={(event) => {
                                            if (isCompetitorExtractionFailureText(event.currentTarget.value)) {
                                                event.currentTarget.select();
                                            }
                                        }}
                                        onBlur={() => void handleCompetitorTextCommit(index)}
                                        placeholder={tRs.competitorPlainTextPlaceholder}
                                        rows={5}
                                        className={`w-full resize-y rounded-md border px-2 py-2 text-xs leading-5 outline-none placeholder:text-gray-400 focus:ring-1 dark:bg-[#1F1F1F] dark:text-gray-100 dark:placeholder:text-gray-500 ${
                                            isCompetitorExtractionFailureText(plainText)
                                                ? 'border-red-300 bg-red-50 text-red-700 focus:border-red-400 focus:ring-red-300 dark:border-red-800 dark:bg-red-950/20 dark:text-red-300'
                                                : 'border-gray-300 bg-gray-50 text-[#333333] focus:border-[#d4af37] focus:ring-[#d4af37] dark:border-[#3C3C3C]'
                                        }`}
                                        dir="auto"
                                    />
                                </div>
                            </div>

                            {extraction.notice && (
                                <div className="mt-2 rounded-md border border-[#d4af37]/25 bg-[#d4af37]/10 px-2 py-2 text-[11px] font-semibold leading-5 text-[#8a6f1d] dark:border-[#d4af37]/20 dark:bg-[#d4af37]/10 dark:text-[#f2d675]">
                                    {extraction.notice}
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
                                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                            <span className="font-bold text-[#8a6f1d] dark:text-[#f2d675]">{extractionPreviewTitle}</span>
                                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600 dark:bg-[#333333] dark:text-gray-300">
                                                {extraction.source === 'programmatic'
                                                    ? tRs.programmaticExtractionSource
                                                    : tRs.htmlExtractionSource}
                                            </span>
                                            {content.cacheHit && (
                                                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">
                                                    {tRs.cachedExtraction}
                                                </span>
                                            )}
                                            {typeof content.qualityScore === 'number' && (
                                                <span className="rounded-full bg-[#d4af37]/10 px-2 py-0.5 text-[10px] font-bold text-[#8a6f1d] dark:bg-[#d4af37]/15 dark:text-[#f2d675]">
                                                    {tRs.extractionQuality}: {Math.round(content.qualityScore)}%
                                                </span>
                                            )}
                                        </div>
                                        <span className="shrink-0 text-[11px] text-gray-400">{content.wordCount} {t.common.words}</span>
                                    </div>
                                    <div className="rounded-md border border-[#d4af37]/20 bg-[#d4af37]/5 px-2 py-1.5 text-[10px] font-semibold leading-4 text-[#8a6f1d] dark:border-[#d4af37]/20 dark:bg-[#d4af37]/10 dark:text-[#f2d675]">
                                        {tRs.extractionPreviewUsageHint}
                                    </div>
                                    <div className="rounded-md bg-gray-50 p-2 dark:bg-[#1F1F1F]">
                                        <div className="mb-2 font-bold text-gray-700 dark:text-gray-200">{tRs.pageTableOfContents}</div>
                                        <div className="max-h-44 overflow-y-auto custom-scrollbar leading-5 text-gray-600 dark:text-gray-300">
                                            {content.headings.h1.length === 0 && content.headings.h2.length === 0 && content.headings.h3.length === 0 ? (
                                                <span className="text-gray-400">{tRs.noTableOfContents}</span>
                                            ) : (
                                                <ul className="space-y-1">
                                                    {content.headings.h1.map((item, itemIndex) => <li key={`h1-${itemIndex}`} className="font-bold">{t.locale === 'ar' ? 'العنوان الرئيسي' : 'H1'}: {item}</li>)}
                                                    {content.headings.h2.map((item, itemIndex) => <li key={`h2-${itemIndex}`} className="ps-3">{t.locale === 'ar' ? 'عنوان فرعي' : 'H2'}: {item}</li>)}
                                                    {content.headings.h3.map((item, itemIndex) => <li key={`h3-${itemIndex}`} className="ps-6 text-gray-500 dark:text-gray-400">{t.locale === 'ar' ? 'عنوان فرعي ثانوي' : 'H3'}: {item}</li>)}
                                                </ul>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-2 text-xs dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                        <span className="text-[11px] font-bold text-gray-600 dark:text-gray-300">
                                            {t.locale === 'ar' ? 'العبارات المكررة من 3 إلى 5 كلمات' : 'Repeated phrases of 3 to 5 words'}
                                        </span>
                                        <span
                                            className="shrink-0 rounded-full border border-[#d4af37]/30 bg-[#d4af37]/10 px-2 py-0.5 text-[10px] font-black tabular-nums text-[#8a6f1d] dark:border-[#d4af37]/25 dark:text-[#f2d675]"
                                            title={t.locale === 'ar'
                                                ? 'عدد كلمات نص المنافس المعتمد، ويُستخدم لحساب هدف الكتابة التلقائي.'
                                                : 'Word count of the canonical competitor text used for the automatic writing target.'}
                                        >
                                            {competitorWordCount.toLocaleString(t.locale === 'ar' ? 'ar' : 'en')}{' '}
                                            {t.locale === 'ar' ? 'كلمة' : 'words'}
                                        </span>
                                    </div>
                                    <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-gray-500 dark:bg-[#2A2A2A] dark:text-gray-400">
                                        {t.locale === 'ar'
                                            ? `${repeatedPhrases.length.toLocaleString('ar')} عبارات رئيسية`
                                            : `${repeatedPhrases.length.toLocaleString('en')} canonical`}
                                    </span>
                                </div>
                                {repeatedPhrases.length === 0 ? (
                                    <div className="text-gray-400">
                                        {t.locale === 'ar'
                                            ? 'لا توجد عبارات مكررة بهذا الطول لدى هذا المنافس.'
                                            : 'This competitor has no repeated phrases at these lengths.'}
                                    </div>
                                ) : (
                                    <div className="max-h-72 space-y-1.5 overflow-y-auto custom-scrollbar">
                                        {repeatedPhrases.map(item => (
                                            <div key={`${item.size}-${item.text}`} className="rounded border border-gray-200 bg-white px-2 py-1.5 dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                                                <div className="flex items-start justify-between gap-2">
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
                                                {Boolean(item.containedPhrases?.length) && (
                                                    <details className="mt-1.5 border-t border-gray-100 pt-1.5 dark:border-[#3C3C3C]">
                                                        <summary className="cursor-pointer text-[10px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                                                            {t.locale === 'ar'
                                                                ? `تتضمن ${item.containedPhrases!.length.toLocaleString('ar')} عبارات أقصر مدمجة`
                                                                : `Includes ${item.containedPhrases!.length.toLocaleString('en')} collapsed shorter phrases`}
                                                        </summary>
                                                        <div className="mt-1 space-y-1">
                                                            {item.containedPhrases!.map(phrase => (
                                                                <div
                                                                    key={`${phrase.size}-${phrase.normalizedText}`}
                                                                    className="flex items-start justify-between gap-2 rounded bg-gray-50 px-2 py-1 text-[10px] text-gray-500 dark:bg-[#1F1F1F] dark:text-gray-400"
                                                                >
                                                                    <span className="min-w-0 break-words">{phrase.text}</span>
                                                                    <span className="shrink-0 tabular-nums">
                                                                        {phrase.size} {t.locale === 'ar' ? 'كلمات' : 'words'}
                                                                    </span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </details>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}

                <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
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

                        </div>
                    )}
                </div>

                {competitorPhraseIntelligenceEnabled && (
                    <React.Suspense
                        fallback={(
                            <div className="rounded-xl border border-[#d4af37]/30 bg-[#d4af37]/10 p-3 text-xs font-bold text-[#8a6f1d] dark:border-[#d4af37]/25 dark:bg-[#d4af37]/10 dark:text-[#f2d675]">
                                {competitorIsArabic ? 'جارٍ تجهيز تحليل عبارات المنافسين…' : 'Preparing competitor phrase analysis…'}
                            </div>
                        )}
                    >
                        <CompetitorPhraseIntelligencePanel
                            locale={competitorLocale}
                            articleLanguage={articleLanguage}
                            sources={competitorStatSources}
                            keywords={articleKeywords}
                            competitorUrls={competitorUrls}
                        />
                    </React.Suspense>
                )}

                <div className="rounded-xl border border-[#d4af37]/35 bg-[#d4af37]/5 p-3 shadow-sm dark:border-[#d4af37]/25 dark:bg-[#d4af37]/10">
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2 text-xs font-bold text-gray-800 dark:text-gray-100">
                            <Lightbulb size={14} className="shrink-0 text-[#d4af37]" />
                            <span>
                                {t.locale === 'ar'
                                    ? 'العبارات المشتركة المقترحة للمقالة'
                                    : 'Shared phrases recommended for the article'}
                            </span>
                        </div>
                        <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-gray-500 dark:bg-[#2A2A2A] dark:text-gray-400">
                            {sharedCompetitorPhrases.length}
                        </span>
                    </div>
                    <p className="mb-3 text-[10px] font-semibold leading-5 text-gray-500 dark:text-gray-400">
                        {t.locale === 'ar'
                            ? 'تظهر هنا العبارات الرئيسية المشتركة فقط. تُدمج العبارات الأقصر داخل الأطول عندما لا يكون لها ظهور مستقل، حتى لا تصل إلى محرر المحتوى كمتطلبات مكررة.'
                            : 'Only canonical shared phrases appear here. Shorter phrases are collapsed into longer ones when they have no independent occurrence, preventing duplicate writing requirements.'}
                    </p>

                    {sharedCompetitorPhrases.length === 0 ? (
                        <div className="rounded-md bg-white/80 p-3 text-xs text-gray-400 dark:bg-[#1F1F1F]">
                            {competitorStatSources.length < 2
                                ? (t.locale === 'ar'
                                    ? 'أضف نصوص منافسين اثنين على الأقل لاكتشاف العبارات المشتركة.'
                                    : 'Add text for at least two competitors to find shared phrases.')
                                : (t.locale === 'ar'
                                    ? 'لا توجد عبارات مشتركة بهذا الطول بين المنافسين حاليًا.'
                                    : 'There are currently no shared phrases at these lengths.')}
                        </div>
                    ) : (
                        <div className="max-h-96 space-y-2 overflow-y-auto custom-scrollbar">
                            {sharedCompetitorPhrases.map(item => {
                                const isSharedByAll = item.competitors.length === competitorStatSources.length;
                                return (
                                    <div key={`${item.size}-${item.text}`} className="rounded-md border border-[#d4af37]/25 bg-white p-2 dark:border-[#d4af37]/20 dark:bg-[#2A2A2A]">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 whitespace-normal break-words text-xs font-semibold leading-5 text-gray-700 dark:text-gray-200">
                                                {item.text}
                                            </div>
                                            <span className="shrink-0 rounded bg-[#d4af37]/10 px-1.5 py-0.5 text-[10px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                                                {isSharedByAll
                                                    ? (t.locale === 'ar' ? 'جميع المنافسين' : 'All competitors')
                                                    : (t.locale === 'ar'
                                                        ? `${item.competitors.length} منافسين`
                                                        : `${item.competitors.length} competitors`)}
                                            </span>
                                        </div>
                                        <div className="mt-1 text-[10px] font-bold text-gray-400">
                                            {item.size} {t.locale === 'ar' ? 'كلمات' : 'words'}
                                            <span className="px-1">•</span>
                                            {t.locale === 'ar'
                                                ? `${item.totalCount} مرات إجمالًا`
                                                : `${item.totalCount} total occurrences`}
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            {item.competitors.map(occurrence => {
                                                const competitorIndex = occurrence.competitorNumber - 1;
                                                const sourceUrl = toSafeCompetitorSourceUrl(competitorUrls[competitorIndex]);
                                                const sourceHost = getCompetitorSourceHost(sourceUrl);
                                                const label = t.locale === 'ar'
                                                    ? `المنافس ${occurrence.competitorNumber}`
                                                    : `Competitor ${occurrence.competitorNumber}`;
                                                const chipContent = (
                                                    <>
                                                        <span>{label}{sourceHost ? ` · ${sourceHost}` : ''}</span>
                                                        <span className="tabular-nums opacity-70">×{occurrence.count}</span>
                                                    </>
                                                );
                                                return sourceUrl ? (
                                                    <a
                                                        key={occurrence.competitorNumber}
                                                        href={sourceUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] font-bold text-gray-600 hover:border-[#d4af37]/50 hover:text-[#8a6f1d] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-300 dark:hover:text-[#f2d675]"
                                                        title={sourceUrl}
                                                    >
                                                        {chipContent}
                                                        <ExternalLink size={10} className="shrink-0" />
                                                    </a>
                                                ) : (
                                                    <span
                                                        key={occurrence.competitorNumber}
                                                        className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] font-bold text-gray-600 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-300"
                                                    >
                                                        {chipContent}
                                                    </span>
                                                );
                                            })}
                                        </div>
                                        {Boolean(item.containedPhrases?.length) && (
                                            <details className="mt-2 border-t border-[#d4af37]/15 pt-2">
                                                <summary className="cursor-pointer text-[10px] font-black text-[#8a6f1d] dark:text-[#f2d675]">
                                                    {t.locale === 'ar'
                                                        ? `تتضمن ${item.containedPhrases!.length.toLocaleString('ar')} عبارات أقصر مدمجة`
                                                        : `Includes ${item.containedPhrases!.length.toLocaleString('en')} collapsed shorter phrases`}
                                                </summary>
                                                <div className="mt-1 flex flex-wrap gap-1">
                                                    {item.containedPhrases!.map(phrase => (
                                                        <span
                                                            key={`${phrase.size}-${phrase.normalizedText}`}
                                                            className="rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-[9px] font-bold text-gray-500 dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-400"
                                                        >
                                                            {phrase.text}
                                                        </span>
                                                    ))}
                                                </div>
                                            </details>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
        );
    };

    const sidebarTabs = ([
        {
            id: 'ai',
            label: t.locale === 'ar' ? 'التحليل الذكي' : 'Smart analysis',
            icon: <BrainCircuit size={18} />,
        },
        {
            id: 'competitors',
            label: competitorIsArabic ? 'المنافسون' : 'Competitors',
            icon: <Users size={18} />,
        },
        {
            id: 'writing',
            label: t.locale === 'ar' ? 'كتابة المحتوى' : 'Content writing',
            icon: <PenLine size={18} />,
        },
        {
            id: 'links',
            label: t.locale === 'ar' ? 'الربط الداخلي' : 'Internal linking',
            icon: <Link2 size={18} />,
        },
    ] as const).map((tab, index) => ({ ...tab, shortcut: `Alt+${index + 4}` }));
    const activeSidebarTab = sidebarTabs.find(tab => tab.id === activeTab) || sidebarTabs[0];

    return (
        <aside
            className={`${isHidden ? 'hidden' : 'flex'} h-full min-w-0 flex-none flex-col overflow-hidden rounded-lg border-s border-gray-300 bg-[#F2F3F5] shadow-lg transition-[width,flex-basis] duration-150 dark:border-[#333] dark:bg-[#1F1F1F] ${collapsed ? 'w-12 basis-12' : 'w-auto basis-[18.7%]'}`}
            style={collapsed || !expandedFlexBasis ? undefined : { flexBasis: expandedFlexBasis }}
        >
            <div className={`${collapsed ? 'flex' : 'hidden'} h-full flex-col items-center gap-[0.1875rem] px-[0.09375rem] py-[0.125rem]`}>
                <button
                    type="button"
                    onClick={onToggleCollapsed}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-white hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
                    aria-label={t.locale === 'ar' ? 'إظهار لوحة أدوات الذكاء الاصطناعي' : 'Show AI tools panel'}
                    title={t.locale === 'ar' ? 'إظهار لوحة أدوات الذكاء الاصطناعي' : 'Show AI tools panel'}
                >
                    {t.locale === 'ar' ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
                </button>
                <div
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-[#d4af37]/15 text-[#8a6f1d] ring-1 ring-inset ring-[#d4af37]/35 dark:text-[#f2d675]"
                    title={`${activeSidebarTab.label} — ${activeSidebarTab.shortcut}`}
                >
                    {activeSidebarTab.icon}
                </div>
            </div>

            <div className={`${collapsed ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col`}>
              <div className="relative z-40 flex items-stretch gap-[0.0625rem] border-b border-gray-200 p-[0.09375rem] dark:border-[#3C3C3C]">
                <div role="tablist" aria-label={t.locale === 'ar' ? 'أدوات الذكاء الاصطناعي' : 'AI tools'} className="flex min-w-0 flex-1 gap-[0.0625rem] rounded-lg bg-gray-200/70 p-[0.0625rem] dark:bg-black/20">
                {sidebarTabs.map((tab, tabIndex) => (
                    <button
                        type="button"
                        role="tab"
                        key={tab.id}
                        id={`analysis-sidebar-${tab.id}-tab`}
                        aria-controls="analysis-sidebar-panel"
                        aria-selected={activeTab === tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        aria-label={`${tab.label} — ${tab.shortcut}`}
                        className={`group relative flex h-9 min-w-0 flex-1 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] ${
                            activeTab === tab.id
                                ? 'bg-[#d4af37]/15 text-[#8a6f1d] ring-1 ring-inset ring-[#d4af37]/35 shadow-sm dark:text-[#f2d675]'
                                : 'text-gray-400 hover:bg-white/80 hover:text-gray-800 dark:hover:bg-white/5 dark:hover:text-white'
                        }`}
                    >
                        {tab.icon}
                        <span className="sr-only">{tab.label}</span>
                        <IconTooltip
                            label={tab.label}
                            align={tabIndex === 0 ? 'start' : tabIndex === sidebarTabs.length - 1 ? 'end' : 'center'}
                        />
                    </button>
                ))}
                </div>
                <button
                    type="button"
                    onClick={onToggleCollapsed}
                    className="inline-flex h-[44px] w-9 flex-none items-center justify-center rounded-md text-gray-400 hover:bg-gray-200/80 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] dark:hover:bg-white/5 dark:hover:text-white"
                    aria-label={t.locale === 'ar' ? 'طي لوحة أدوات الذكاء الاصطناعي' : 'Collapse AI tools panel'}
                    title={t.locale === 'ar' ? 'طي لوحة أدوات الذكاء الاصطناعي' : 'Collapse AI tools panel'}
                >
                    {t.locale === 'ar' ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
                </button>
              </div>
            <div
                id="analysis-sidebar-panel"
                role="tabpanel"
                aria-labelledby={`analysis-sidebar-${activeTab}-tab`}
                className="flex-grow overflow-y-auto custom-scrollbar"
            >
                {activeTab === 'ai'
                    ? renderAiTab()
                      : activeTab === 'competitors'
                        ? renderCompetitorsTab()
                        : activeTab === 'writing'
                          ? (
                            <React.Suspense fallback={(
                                <div className="flex h-full items-center justify-center p-[0.25rem] text-xs font-bold text-gray-400">
                                    {t.locale === 'ar' ? 'جار تحميل كتابة المحتوى...' : 'Loading content writing...'}
                                </div>
                            )}>
                                <ContentWritingPanel />
                            </React.Suspense>
                            )
                          : (
                            <React.Suspense fallback={(
                                <div className="flex h-full items-center justify-center p-[0.25rem] text-xs font-bold text-gray-400">
                                    {t.locale === 'ar' ? 'جار تحميل الربط الداخلي...' : 'Loading internal linking...'}
                                </div>
                            )}>
                                <InternalLinkingPanel />
                            </React.Suspense>
                            )}
            </div>
            </div>
        </aside>
    );
};

export default RightSidebar;
