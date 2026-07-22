
import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { createContext, useContext, useContextSelector } from 'use-context-selector';
import { useEditor as useTiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Highlight } from '@tiptap/extension-highlight';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import TextAlign from '@tiptap/extension-text-align';
import { Extension, Editor } from '@tiptap/core';
import { useContentAnalysis, type ContentAnalysisRefreshScope } from '../hooks/useContentAnalysis';
import { getActivityData, ArticleActivity, normalizeKeywords } from '../hooks/useUserActivity';
import type { Keywords, FullAnalysis, GoalContext } from '../types';
import { INITIAL_KEYWORDS, MANUAL_DRAFT_KEY, MANUAL_DRAFT_TITLE_KEY, MANUAL_DRAFT_KEYWORDS_KEY, MANUAL_DRAFT_LANGUAGE_KEY, MANUAL_DRAFT_GOAL_CONTEXT_KEY, AUTO_DRAFT_KEY, AUTO_DRAFT_TITLE_KEY, AUTO_DRAFT_KEYWORDS_KEY, AUTO_DRAFT_LANGUAGE_KEY, AUTO_DRAFT_GOAL_CONTEXT_KEY } from '../constants';
import { CONTENT_SUMMARY_STORAGE_KEY } from '../constants/engineeringPrompts';
import { useUser } from './UserContext';
import { normalizeGoalContext } from '../utils/goalContext';
import { clearStoredCompetitorInputs, COMPETITOR_RESET_EVENT, readStoredCompetitorInputs, writeStoredCompetitorInputs } from '../utils/competitorStorage';
import {
    ArticleStorageSnapshot,
    createEditorContentReference,
    createEditorContentReferenceWithChunkFallback,
    createEditorContentReferenceWithFallback,
    getArticleContentKey,
    getAutoDraftContentKey,
    getManualDraftContentKey,
    isEditorContentReference,
    loadArticleSnapshot,
    loadRemoteArticleSnapshotCache,
    resolveEditorContentReference,
    saveArticleSnapshotDurably,
    saveEditorContentDurably,
} from '../utils/editorContentStore';
import {
    loadRemoteArticleSnapshot,
    recordRemoteArticleTime,
    saveRemoteArticleSnapshot,
    updateRemoteArticleSettings,
    type RemoteArticleActivity,
    type RemoteArticleStatus,
} from '../utils/supabaseArticles';
import { buildEditorArticlePath, navigateToAppPath } from '../utils/appRoutes';
import { recordAppActivity } from '../utils/appActivity';
import { runDuplicateAnalysis } from '../utils/analysis/runDuplicateAnalysis';
import { shouldClearArticleAiResults } from '../constants/articleStatuses';
import { parseMarkdownToArticleHtml } from '../utils/editorUtils';
import { prepareContentWritingResultForEditor } from '../utils/contentWritingWorkflow';

/*
 * EditorContext is the owner of article editing state:
 * TipTap setup, title, keywords, article language, goal context, autosave/manual save,
 * draft restore, loading saved articles, and triggering content analysis.
 *
 * Edit here when changing editor persistence, language direction, or article lifecycle.
 * Edit hooks/useContentAnalysis.ts when changing SEO/content rules.
 */

// --- Local timing helpers ---
const EDITOR_SNAPSHOT_DELAY_MS = 900;
const DRAFT_PERSIST_DELAY_MS = 4500;
const ANALYSIS_DEBOUNCE_MS = 900;
const AUTOSAVE_INTERVAL_MS = 60 * 1000;
const ARTICLE_TIME_TICK_SECONDS = 10;
const ARTICLE_TIME_FLUSH_SECONDS = 60;
const MAX_DOCUMENT_LANGUAGE_FORMATTING_SIZE = 60_000;
const ACTIVE_ARTICLE_TITLE_KEY = 'bazarvan-active-article-title';
const ACTIVE_ARTICLE_ID_KEY = 'bazarvan-active-article-id';

const createEmptyEditorContent = () => ({
    type: 'doc',
    content: [{ type: 'paragraph' }],
});

const readStorageValue = (key: string): string | null => {
    try {
        return localStorage.getItem(key);
    } catch (error) {
        console.error(`Failed to read local draft field "${key}":`, error);
        return null;
    }
};

const writeStorageValue = (key: string, value: string): boolean => {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (error) {
        console.error(`Failed to save local draft field "${key}":`, error);
        return false;
    }
};

const removeStorageValue = (key: string) => {
    try {
        localStorage.removeItem(key);
    } catch (error) {
        console.error(`Failed to remove invalid local draft field "${key}":`, error);
    }
};

const readSessionValue = (key: string): string | null => {
    try {
        return sessionStorage.getItem(key);
    } catch (error) {
        console.error(`Failed to read session field "${key}":`, error);
        return null;
    }
};

const writeSessionValue = (key: string, value: string): boolean => {
    try {
        sessionStorage.setItem(key, value);
        return true;
    } catch (error) {
        console.error(`Failed to save session field "${key}":`, error);
        return false;
    }
};

const removeSessionValue = (key: string) => {
    try {
        sessionStorage.removeItem(key);
    } catch (error) {
        console.error(`Failed to remove session field "${key}":`, error);
    }
};

const readActiveArticleTitle = (): string | null => {
    const value = readSessionValue(ACTIVE_ARTICLE_TITLE_KEY)?.trim();
    return value || null;
};

const readActiveArticleId = (): string | null => {
    const value = readSessionValue(ACTIVE_ARTICLE_ID_KEY)?.trim();
    return value || null;
};

const readJsonStorageValue = (key: string): any | null => {
    const value = readStorageValue(key);
    if (!value) return null;

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

const readCurrentArticleAttachments = (): ArticleStorageSnapshot['attachments'] => ({
    competitors: readStoredCompetitorInputs(),
    contentSummary: readJsonStorageValue(CONTENT_SUMMARY_STORAGE_KEY),
});

const ARTICLE_AI_RESULTS_RESTORE_EVENT = 'bazarvan:article-ai-results-restored';

const dispatchSavedAiResults = (
    articleId: string | null,
    savedAiResults?: ArticleStorageSnapshot['savedAiResults'],
) => {
    if (!savedAiResults) return;
    if (!savedAiResults.gemini && !savedAiResults.geminiPaid && !savedAiResults.chatgpt) return;
    window.dispatchEvent(new CustomEvent(ARTICLE_AI_RESULTS_RESTORE_EVENT, {
        detail: {
            articleId,
            aiResults: savedAiResults,
        },
    }));
};

const restoreArticleAttachments = (attachments?: ArticleStorageSnapshot['attachments']) => {
    const competitors = attachments?.competitors;
    if (competitors) {
        writeStoredCompetitorInputs(competitors);
    } else {
        clearStoredCompetitorInputs();
    }
    window.dispatchEvent(new CustomEvent(COMPETITOR_RESET_EVENT, { detail: competitors }));

    const contentSummary = attachments?.contentSummary;
    if (contentSummary) {
        writeStorageValue(CONTENT_SUMMARY_STORAGE_KEY, JSON.stringify(contentSummary));
        window.dispatchEvent(new CustomEvent('bazarvan:content-summary-updated', { detail: contentSummary }));
    } else {
        removeStorageValue(CONTENT_SUMMARY_STORAGE_KEY);
        window.dispatchEvent(new CustomEvent('bazarvan:content-summary-updated', { detail: null }));
    }
};

const readStoredContentReference = (key: string) => {
    try {
        const rawValue = readStorageValue(key);
        if (!rawValue) return null;
        const parsed = JSON.parse(rawValue);
        return isEditorContentReference(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

const isRecord = (value: unknown): value is Record<string, any> => (
    !!value && typeof value === 'object' && !Array.isArray(value)
);

const getRemoteArticleId = (article?: ArticleActivity | RemoteArticleActivity | null): string | null => {
    const id = (article as RemoteArticleActivity | undefined)?.id;
    return typeof id === 'string' && id.trim() ? id : null;
};

export type ActiveArticleSettings = {
    status: string;
    accessRole: string;
    claimedAt: string;
    claimedBy: string;
};

const EMPTY_ACTIVE_ARTICLE_SETTINGS: ActiveArticleSettings = {
    status: '',
    accessRole: '',
    claimedAt: '',
    claimedBy: '',
};

const getActiveArticleSettings = (article?: ArticleActivity | RemoteArticleActivity | null): ActiveArticleSettings => {
    const remoteArticle = article as RemoteArticleActivity | undefined;
    const metadata = isRecord(remoteArticle?.metadata) ? remoteArticle.metadata : {};
    const settings = isRecord(metadata.n8nSettings) ? metadata.n8nSettings : {};
    const claim = isRecord(metadata.claim) ? metadata.claim : {};

    return {
        status: typeof settings.status === 'string' ? settings.status : remoteArticle?.status || '',
        accessRole: typeof settings.accessRole === 'string' ? settings.accessRole : '',
        claimedAt: typeof claim.claimedAt === 'string' ? claim.claimedAt : '',
        claimedBy: typeof claim.claimedBy === 'string' ? claim.claimedBy : '',
    };
};

const ALLOWED_EDITOR_NODE_TYPES = new Set([
    'doc',
    'paragraph',
    'text',
    'heading',
    'blockquote',
    'bulletList',
    'orderedList',
    'listItem',
    'codeBlock',
    'hardBreak',
    'horizontalRule',
    'table',
    'tableRow',
    'tableHeader',
    'tableCell',
]);

const ALLOWED_EDITOR_MARK_TYPES = new Set([
    'bold',
    'italic',
    'strike',
    'code',
    'highlight',
]);

const INLINE_EDITOR_NODE_TYPES = new Set(['text', 'hardBreak']);
const BLOCK_EDITOR_NODE_TYPES = new Set([
    'paragraph',
    'heading',
    'blockquote',
    'bulletList',
    'orderedList',
    'codeBlock',
    'horizontalRule',
    'table',
]);

const isValidEditorMark = (value: unknown): boolean => {
    if (!isRecord(value) || typeof value.type !== 'string') return false;
    if (!ALLOWED_EDITOR_MARK_TYPES.has(value.type)) return false;
    return value.attrs === undefined || isRecord(value.attrs);
};

const hasValidEditorChildren = (type: string, children: Record<string, any>[]): boolean => {
    const childTypes = children.map(child => child.type);

    switch (type) {
        case 'doc':
            return childTypes.every(childType => BLOCK_EDITOR_NODE_TYPES.has(childType));
        case 'paragraph':
        case 'heading':
            return childTypes.every(childType => INLINE_EDITOR_NODE_TYPES.has(childType));
        case 'blockquote':
            return childTypes.every(childType => BLOCK_EDITOR_NODE_TYPES.has(childType));
        case 'bulletList':
        case 'orderedList':
            return childTypes.every(childType => childType === 'listItem');
        case 'listItem':
            return childTypes.every(childType => BLOCK_EDITOR_NODE_TYPES.has(childType));
        case 'codeBlock':
            return childTypes.every(childType => childType === 'text');
        case 'table':
            return childTypes.every(childType => childType === 'tableRow');
        case 'tableRow':
            return childTypes.every(childType => childType === 'tableCell' || childType === 'tableHeader');
        case 'tableCell':
        case 'tableHeader':
            return childTypes.every(childType => BLOCK_EDITOR_NODE_TYPES.has(childType));
        case 'text':
        case 'hardBreak':
        case 'horizontalRule':
            return children.length === 0;
        default:
            return false;
    }
};

const isValidEditorNode = (value: unknown): boolean => {
    if (!isRecord(value) || typeof value.type !== 'string') return false;
    if (!ALLOWED_EDITOR_NODE_TYPES.has(value.type)) return false;
    if (value.attrs !== undefined && !isRecord(value.attrs)) return false;
    if (value.marks !== undefined && (!Array.isArray(value.marks) || !value.marks.every(isValidEditorMark))) return false;

    if (value.type === 'text') {
        return typeof value.text === 'string' && value.content === undefined;
    }

    if (value.type === 'heading') {
        const level = value.attrs?.level;
        const normalizedLevel = typeof level === 'string' ? Number(level) : level;
        if (normalizedLevel !== undefined && ![1, 2, 3, 4].includes(Number(normalizedLevel))) return false;
    }

    if (value.type === 'hardBreak' || value.type === 'horizontalRule') {
        return value.content === undefined;
    }

    if (value.content === undefined) {
        if (value.type === 'doc' || value.type === 'table' || value.type === 'tableRow' || value.type === 'bulletList' || value.type === 'orderedList') {
            return false;
        }
        return true;
    }

    if (!Array.isArray(value.content) || !value.content.every(isValidEditorNode)) return false;
    return hasValidEditorChildren(value.type, value.content);
};

const normalizeStoredEditorContent = (value: unknown): any | null => {
    if (typeof value === 'string') return value;

    if (Array.isArray(value)) {
        return value.every(isValidEditorNode) ? { type: 'doc', content: value } : null;
    }

    if (!isRecord(value)) return null;

    const content = Array.isArray(value.content) ? value.content : undefined;
    const normalizedValue = typeof value.type === 'string'
        ? value
        : content
          ? { ...value, type: 'doc' }
          : value;

    return isValidEditorNode(normalizedValue) ? normalizedValue : null;
};

const extractTextFromStoredEditorContent = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.map(extractTextFromStoredEditorContent).filter(Boolean).join('\n');
    }
    if (!isRecord(value)) return '';
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.content)) {
        return value.content.map(extractTextFromStoredEditorContent).filter(Boolean).join('\n');
    }
    return '';
};

const countWordsInText = (value: string): number => (
    value.trim().split(/\s+/).filter(Boolean).length
);

const getSafeEditorContent = (value: unknown, fallback: any = createEmptyEditorContent()): any => {
    const normalized = normalizeStoredEditorContent(value);
    if (normalized !== null) return normalized;

    const recoveredText = extractTextFromStoredEditorContent(value).trim();
    return recoveredText || fallback;
};

const isUsableEditorContent = (value: unknown): boolean => (
    normalizeStoredEditorContent(value) !== null ||
    extractTextFromStoredEditorContent(value).trim().length > 0
);

const setEditorContentSafely = (editor: Editor, value: unknown, fallback: any = createEmptyEditorContent()): boolean => {
    try {
        editor.commands.setContent(getSafeEditorContent(value, fallback));
        return normalizeStoredEditorContent(value) !== null;
    } catch (error) {
        console.error('Failed to set stored editor content:', error);
        try {
            editor.commands.setContent(fallback);
        } catch (fallbackError) {
            console.error('Failed to set fallback editor content:', fallbackError);
        }
        return false;
    }
};

function useDebounce<T>(value: T, delay: number): T {
    const [debouncedValue, setDebouncedValue] = useState<T>(value);
    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedValue(value);
        }, delay);
        return () => {
            clearTimeout(handler);
        };
    }, [value, delay]);
    return debouncedValue;
}

const getInitialContent = () => {
  try {
    const savedContent = readStorageValue(AUTO_DRAFT_KEY);
    if (savedContent) {
        const parsedContent = JSON.parse(savedContent);
        if (isEditorContentReference(parsedContent)) return createEmptyEditorContent();
        if (isUsableEditorContent(parsedContent)) return getSafeEditorContent(parsedContent);
        removeStorageValue(AUTO_DRAFT_KEY);
    }
  } catch (error) {
    console.error("Failed to parse saved content from localStorage:", error);
    removeStorageValue(AUTO_DRAFT_KEY);
  }
  return createEmptyEditorContent();
};

const persistEditorContentValue = async (
    storageKey: string,
    backupKey: string,
    content: any,
    options: {
        awaitBackup?: boolean;
        includeFallback?: boolean;
        localFallback?: boolean;
        localContentFallback?: boolean;
        localTextFallback?: boolean;
        textFallback?: string;
    } = {},
): Promise<boolean> => {
    const backupPromise = saveEditorContentDurably(backupKey, content, {
        saveLocalFallback: options.localFallback,
        saveLocalContentFallback: options.localContentFallback,
        saveLocalTextFallback: options.localTextFallback,
        textFallback: options.textFallback,
    });

    if (options.awaitBackup) {
        const result = await backupPromise;
        const hasLocalFallback = result.localChunkCount > 0 || result.localTextChunkCount > 0;
        const reference = hasLocalFallback
            ? createEditorContentReferenceWithChunkFallback(backupKey, result.localChunkCount, result.localTextChunkCount)
            : options.includeFallback
              ? createEditorContentReferenceWithFallback(backupKey, content)
              : createEditorContentReference(backupKey);
        const wroteReference = writeStorageValue(storageKey, JSON.stringify(reference));

        if (!result.indexedDb && !hasLocalFallback && options.includeFallback) {
            return writeStorageValue(storageKey, JSON.stringify(createEditorContentReferenceWithFallback(backupKey, content)));
        }

        return (result.indexedDb || hasLocalFallback) && wroteReference;
    }

    void backupPromise.catch(error => {
        console.error(`Failed to save editor content backup "${backupKey}":`, error);
    });

    return writeStorageValue(storageKey, JSON.stringify(createEditorContentReference(backupKey)));
};

const resolveStoredEditorContent = async (
    value: unknown,
    options: { allowUnreferencedLocalFallback?: boolean } = {},
): Promise<any | null> => {
    if (isEditorContentReference(value)) {
        return resolveEditorContentReference(value, options);
    }

    return value;
};

const resolveStoredContentFromLocalKey = async (storageKey: string): Promise<any | null> => {
    const storedContent = readStorageValue(storageKey);
    if (!storedContent) return null;

    try {
        return resolveStoredEditorContent(JSON.parse(storedContent));
    } catch (error) {
        console.error(`Failed to resolve stored editor content "${storageKey}":`, error);
        return null;
    }
};

const resolveArticleContent = async (
    article: ArticleActivity,
): Promise<any | null> => {
    const resolvedArticleContent = await resolveStoredEditorContent(article.content, {
        allowUnreferencedLocalFallback: true,
    });
    if (isUsableEditorContent(resolvedArticleContent)) {
        return resolvedArticleContent;
    }

    return null;
};

const resolveArticleContentByTitle = async (
    username: string,
    titleStr: string,
): Promise<any | null> => {
    const articleContentKey = getArticleContentKey(username, titleStr);
    const directContent = await resolveEditorContentReference(createEditorContentReference(articleContentKey), {
        allowUnreferencedLocalFallback: true,
    });

    return isUsableEditorContent(directContent) ? directContent : null;
};

const getFreshArticleActivity = (
    username: string | null,
    titleStr: string,
    fallback?: ArticleActivity,
): ArticleActivity | undefined => {
    if (!username) return fallback;
    const freshArticle = getActivityData()[username]?.articles?.[titleStr];
    return freshArticle || fallback;
};

const titlesMatch = (left: string | null, right: string): boolean => (
    (left || '').trim() === right.trim()
);

const resolveDraftContentForTitle = async (titleStr: string, username?: string | null): Promise<any | null> => {
    const candidates = [
        { titleKey: AUTO_DRAFT_TITLE_KEY, contentKey: AUTO_DRAFT_KEY },
        { titleKey: MANUAL_DRAFT_TITLE_KEY, contentKey: MANUAL_DRAFT_KEY },
    ];

    for (const candidate of candidates) {
        if (!titlesMatch(readStorageValue(candidate.titleKey), titleStr)) continue;
        const storedContent = readStorageValue(candidate.contentKey);
        if (!storedContent) continue;

        try {
            const parsedContent = JSON.parse(storedContent);
            if (
                candidate.contentKey === AUTO_DRAFT_KEY &&
                username &&
                isEditorContentReference(parsedContent) &&
                parsedContent.key.startsWith('draft:auto:') &&
                parsedContent.key !== getAutoDraftContentKey(username, titleStr)
            ) {
                continue;
            }

            const resolvedContent = await resolveStoredEditorContent(parsedContent, {
                allowUnreferencedLocalFallback: true,
            });
            if (isUsableEditorContent(resolvedContent)) {
                return resolvedContent;
            }
        } catch (error) {
            console.error(`Failed to resolve same-title draft fallback "${titleStr}":`, error);
        }
    }

    return null;
};

const getSnapshotSavedAtTime = (snapshot?: ArticleStorageSnapshot | null): number => {
    const time = snapshot?.savedAt ? new Date(snapshot.savedAt).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
};

const sortForSignature = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortForSignature);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map(key => [key, sortForSignature(value[key])])
    );
};

const createArticleSaveSignature = (input: {
    title: string;
    content: unknown;
    plainText: string;
    keywords: Keywords;
    goalContext?: GoalContext;
    articleLanguage: 'ar' | 'en';
    attachments?: ArticleStorageSnapshot['attachments'];
}): string => JSON.stringify(sortForSignature({
    title: input.title.trim() || '(untitled)',
    content: input.content,
    plainText: input.plainText,
    keywords: input.keywords,
    goalContext: input.goalContext || null,
    articleLanguage: input.articleLanguage,
    attachments: input.attachments || null,
}));

const createArticleSaveIdempotencyKey = (): string => {
    const requestId = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    return `article-save:${requestId}`;
};

const countKeywordViolations = (analysis: FullAnalysis): number => {
    const keywordAnalysis = analysis.keywordAnalysis;
    let count = keywordAnalysis.primary.status === 'fail' ? 1 : 0;
    count += keywordAnalysis.primary.checks.filter(check => !check.isMet).length;
    if (keywordAnalysis.secondariesDistribution.status === 'fail') count += 1;
    keywordAnalysis.secondaries.forEach(secondary => {
        if (secondary.status === 'fail') count += 1;
        count += secondary.checks.filter(check => !check.isMet).length;
    });
    if (keywordAnalysis.company.status === 'fail') count += 1;
    return count;
};

type SaveDraftReason = 'manual' | 'auto' | 'lifecycle';

type SaveDraftOptions = {
    reason?: SaveDraftReason;
    force?: boolean;
};

export type GeneratedContentApplicationResult = {
    ok: boolean;
    previousWordCount: number;
    nextWordCount: number;
    errorCode?: 'article_changed' | 'editor_unavailable' | 'empty_result' | 'backup_failed' | 'save_failed';
    error?: string;
};

type PendingRemoteSaveRequest = {
    articleId: string | null;
    signature: string;
    idempotencyKey: string;
};

const getStoredLanguage = (key: string): 'ar' | 'en' | null => {
    const saved = readStorageValue(key);
    return saved === 'ar' || saved === 'en' ? saved : null;
};

const getStoredGoalContext = (key: string): GoalContext => {
    try {
        const saved = readStorageValue(key);
        return saved ? normalizeGoalContext(JSON.parse(saved)) : normalizeGoalContext();
    } catch {
        return normalizeGoalContext();
    }
};

const applyArticleLanguageFormatting = (editor: Editor, lang: 'ar' | 'en', updateDocument = false) => {
    const direction = lang === 'ar' ? 'rtl' : 'ltr';
    const alignment = lang === 'ar' ? 'right' : 'left';
    const editorDom = editor.view.dom as HTMLElement;

    editorDom.setAttribute('dir', direction);
    editorDom.style.direction = direction;
    editorDom.style.textAlign = alignment;

    if (!updateDocument || editor.state.doc.content.size > MAX_DOCUMENT_LANGUAGE_FORMATTING_SIZE) {
        return;
    }

    (editor.chain() as any)
        .focus()
        .selectAll()
        .setTextDirection(direction)
        .setTextAlign(alignment)
        .run();
};

const removePastedSectionSeparatorsFromText = (text: string): string => {
    return text
        .split(/\r?\n/)
        .filter(line => !/^\s*[-_=*─━—]{3,}\s*$/.test(line))
        .join('\n');
};

const removePastedSectionSeparatorsFromHtml = (html: string): string => {
    if (typeof DOMParser === 'undefined') {
        return html.replace(/<hr\b[^>]*\/?>/gi, '');
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('hr, [data-type="horizontalRule"]').forEach(node => node.remove());
    doc.body.querySelectorAll<HTMLElement>('*').forEach(element => {
        const text = (element.textContent || '').replace(/\u00a0/g, ' ').trim();
        const style = element.getAttribute('style') || '';
        const hasBorderSeparator = /border-(top|bottom)\s*:/i.test(style);
        const isTextSeparator = /^[-_=*─━—]{3,}$/.test(text);
        if ((!text && hasBorderSeparator) || isTextSeparator) {
            element.remove();
        }
    });

    return removePastedSectionSeparatorsFromText(doc.body.innerHTML);
};

const ViolationHighlight = Highlight.extend({
    // Custom highlight mark used by keyword highlights and structure violations.
    // UI behavior is controlled in InteractionContext; this only defines stored attrs/rendering.
    addAttributes() {
        return {
            ...this.parent?.(),
            color: { default: (this.options as any).color, parseHTML: e => e.style.backgroundColor, renderHTML: a => !a.color || a.highlightStyle === 'underline' ? {} : { style: `background-color: ${a.color}; color: #1e293b;` } },
            violation: { default: null, parseHTML: e => e.getAttribute('data-violation'), renderHTML: a => a.violation ? { 'data-violation': a.violation } : {} },
            from: { default: null, parseHTML: e => e.getAttribute('data-from'), renderHTML: a => a.from === null ? {} : { 'data-from': a.from } },
            isViolation: { default: false, parseHTML: e => e.getAttribute('data-is-violation') === 'true', renderHTML: a => a.isViolation ? { 'data-is-violation': 'true' } : {} },
            highlightStyle: {
                default: 'background', parseHTML: e => e.getAttribute('data-highlight-style'), renderHTML: a => {
                    const htmlAttrs: { [key: string]: any } = {};
                    if (a.highlightStyle) htmlAttrs['data-highlight-style'] = a.highlightStyle;
                    if (a.highlightStyle === 'underline') {
                        const hexColor = a.color || (a.isViolation ? '#ef4444' : '#3b82f6');
                        const encodedColor = encodeURIComponent(hexColor);
                        const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 4'><path fill='none' stroke='${encodedColor}' d='M0 2 Q 3 0, 6 2 Q 9 4, 12 2' stroke-width='2'/></svg>`;
                        htmlAttrs.style = `text-decoration: none; background-image: url("data:image/svg+xml,${svg}"); background-repeat: repeat-x; background-position: 0 100%; background-size: 12px 4px; background-color: transparent; color: inherit;`;
                    }
                    return htmlAttrs;
                },
            },
        };
    },
});

const KeyboardShortcuts = Extension.create({
  name: 'keyboardShortcuts',
  addKeyboardShortcuts() { return { 'Alt-2': () => this.editor.commands.toggleHeading({ level: 2 }), 'Alt-3': () => this.editor.commands.toggleHeading({ level: 3 }), 'Alt-4': () => this.editor.commands.toggleHeading({ level: 4 }), 'Alt-5': () => this.editor.commands.setParagraph() } },
});

const TextDirection = Extension.create({
  name: 'customTextDirection', // Renamed to avoid collisions
  addOptions() { return { types: ['heading', 'paragraph', 'listItem', 'bulletList', 'orderedList'] } },
  addGlobalAttributes() { return [{ types: this.options.types, attributes: { dir: { default: null, renderHTML: a => (a.dir === 'auto' || !a.dir) ? {} : { dir: a.dir }, parseHTML: e => e.getAttribute('dir') } } }] },
  addCommands() {
    return {
      setTextDirection: (direction: 'ltr' | 'rtl' | 'auto') => ({ state, dispatch }: any) => {
        const { tr } = state;
        let changed = false;
        const types = new Set(this.options.types);
        const editorDom = this.editor?.view?.dom as HTMLElement | undefined;

        if (editorDom) {
            if (direction === 'auto') {
                editorDom.removeAttribute('dir');
                editorDom.style.direction = '';
            } else {
                editorDom.setAttribute('dir', direction);
                editorDom.style.direction = direction;
            }
        }

        state.doc.descendants((node: any, pos: any) => {
            if (types.has(node.type.name)) {
                if (node.attrs.dir !== direction) {
                    tr.setNodeMarkup(pos, undefined, { ...node.attrs, dir: direction });
                    changed = true;
                }
            }
        });

        if (changed && dispatch) {
          dispatch(tr);
        }
        return changed;
      },
      unsetTextDirection: () => ({ state, dispatch }: any) => {
        const { tr } = state;
        let changed = false;
        const types = new Set(this.options.types);
        
        state.doc.descendants((node: any, pos: any) => {
          if (types.has(node.type.name)) {
            if (node.attrs.dir) {
              const { dir, ...rest } = node.attrs;
              tr.setNodeMarkup(pos, undefined, rest);
              changed = true;
            }
          }
        });

        if (changed && dispatch) {
          dispatch(tr);
        }
        return changed;
      },
    };
  },
});

interface EditorContextType {
    editor: Editor | null;
    title: string;
    setTitle: React.Dispatch<React.SetStateAction<string>>;
    articleKey: string;
    text: string;
    keywords: Keywords;
    setKeywords: React.Dispatch<React.SetStateAction<Keywords>>;
    articleLanguage: 'ar' | 'en';
    activeArticleId: string | null;
    activeArticleSettings: ActiveArticleSettings;
    goalContext: GoalContext;
    setGoalContext: React.Dispatch<React.SetStateAction<GoalContext>>;
    analysisResults: FullAnalysis;
    isDuplicatesTabActive: boolean;
    setIsDuplicatesTabActive: React.Dispatch<React.SetStateAction<boolean>>;
    setIsStructureTabActive: React.Dispatch<React.SetStateAction<boolean>>;
    saveStatus: 'idle' | 'saving' | 'saved' | 'error';
    saveError: string;
    restoreStatus: 'idle' | 'restored';
    draftExists: boolean;
    scrollContainerRef: React.RefObject<HTMLDivElement>;
    handleLanguageChange: (lang: 'ar' | 'en') => void;
    handleActiveArticleStatusChange: (status: RemoteArticleStatus) => Promise<boolean>;
    handleClearKeywords: () => void;
    handleSaveDraft: (options?: SaveDraftOptions) => Promise<boolean>;
    applyGeneratedArticleContent: (options: {
        expectedArticleId: string;
        markdown: string;
    }) => Promise<GeneratedContentApplicationResult>;
    handleRestoreDraft: () => void;
    handleNewArticle: (lang: 'ar' | 'en') => Promise<void>;
    handleLoadArticle: (title: string, article: ArticleActivity | RemoteArticleActivity) => Promise<void>;
}

const EditorContext = createContext<EditorContextType | null>(null);

export const useEditor = () => {
  const context = useContext(EditorContext);
  if (!context) throw new Error("useEditor must be used within an EditorProvider");
  return context;
};

export const useEditorSelector = <Selected,>(
  selector: (context: EditorContextType) => Selected,
): Selected => useContextSelector(EditorContext, context => {
  if (!context) throw new Error("useEditorSelector must be used within an EditorProvider");
  return selector(context);
});

export const EditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { currentUser, currentUserId, currentView, setCurrentView, preferredLanguage, uiLanguage, isIdle } = useUser();
    const initialActiveArticleTitleRef = useRef<string | null>(currentView === 'editor' ? readActiveArticleTitle() : null);
    const initialActiveArticleIdRef = useRef<string | null>(currentView === 'editor' ? readActiveArticleId() : null);
    const initialAutoDraftTitle = currentView === 'editor' && !initialActiveArticleTitleRef.current
        ? readStorageValue(AUTO_DRAFT_TITLE_KEY) || ''
        : '';
    const [title, setTitle] = useState<string>(() => initialActiveArticleTitleRef.current || initialAutoDraftTitle);
    const [articleKey, setArticleKey] = useState<string>(() => initialActiveArticleTitleRef.current || initialAutoDraftTitle);
    const [activeArticleId, setActiveArticleId] = useState<string | null>(() => initialActiveArticleIdRef.current);
    const [activeArticleSettings, setActiveArticleSettings] = useState<ActiveArticleSettings>(EMPTY_ACTIVE_ARTICLE_SETTINGS);
    const [editorState, setEditorState] = useState<any | null>(null);
    const [text, setText] = useState<string>('');
    const [keywords, setKeywords] = useState<Keywords>(() => {
        try {
          const saved = readStorageValue(AUTO_DRAFT_KEYWORDS_KEY);
          return saved ? normalizeKeywords(JSON.parse(saved)) : INITIAL_KEYWORDS;
        } catch { return INITIAL_KEYWORDS; }
    });
    const [articleLanguage, setArticleLanguage] = useState<'ar' | 'en'>('ar');
    const [goalContext, setGoalContext] = useState<GoalContext>(() => getStoredGoalContext(AUTO_DRAFT_GOAL_CONTEXT_KEY));
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [saveError, setSaveError] = useState('');
    const [restoreStatus, setRestoreStatus] = useState<'idle' | 'restored'>('idle');
    const [draftExists, setDraftExists] = useState(false);
    const [activeAnalysisPanels, setActiveAnalysisPanels] = useState<ContentAnalysisRefreshScope>({
        keywords: true,
        structure: true,
        duplicates: false,
    });
    
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const editorSnapshotTimerRef = useRef<number | null>(null);
    const draftPersistTimerRef = useRef<number | null>(null);
    const articleLoadRequestIdRef = useRef(0);
    const isArticleContentLoadingRef = useRef(false);
    const hasEditorChangedAfterArticleLoadRef = useRef(false);
    const loadedArticleSnapshotSavedAtRef = useRef(0);
    const saveInFlightRef = useRef<Promise<boolean> | null>(null);
    const queuedForcedSaveRef = useRef<SaveDraftOptions | null>(null);
    const lastSavedArticleSignatureRef = useRef('');
    const pendingRemoteSaveRequestRef = useRef<PendingRemoteSaveRequest | null>(null);
    const skipNextAutoDraftMetadataWriteRef = useRef(false);
    const latestDraftMetaRef = useRef({ title, keywords, articleLanguage, goalContext });
    const pendingInitialArticleRestoreRef = useRef<string | null>(initialActiveArticleTitleRef.current);
    const pendingAutoDraftRestoreRef = useRef(
        currentView === 'editor' &&
        !initialActiveArticleTitleRef.current &&
        Boolean(readStoredContentReference(AUTO_DRAFT_KEY))
    );
    
    // Debounce editor state and text content before analysis to keep typing responsive.
    const debouncedEditorState = useDebounce(editorState, ANALYSIS_DEBOUNCE_MS);
    const debouncedText = useDebounce(text, ANALYSIS_DEBOUNCE_MS);
    const isDuplicatesTabActive = activeAnalysisPanels.duplicates;
    const setIsDuplicatesTabActive = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
        setActiveAnalysisPanels(prev => {
            const nextValue = typeof value === 'function' ? value(prev.duplicates) : value;
            return {
                ...prev,
                duplicates: nextValue,
                keywords: !nextValue,
            };
        });
    }, []);
    const setIsStructureTabActive = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
        setActiveAnalysisPanels(prev => {
            const nextValue = typeof value === 'function' ? value(prev.structure) : value;
            return {
                ...prev,
                structure: nextValue,
            };
        });
    }, []);

    const clearEditorSnapshotTimer = useCallback(() => {
        if (editorSnapshotTimerRef.current) {
            clearTimeout(editorSnapshotTimerRef.current);
            editorSnapshotTimerRef.current = null;
        }
    }, []);

    const clearDraftPersistTimer = useCallback(() => {
        if (draftPersistTimerRef.current) {
            clearTimeout(draftPersistTimerRef.current);
            draftPersistTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        latestDraftMetaRef.current = { title, keywords, articleLanguage, goalContext };
    }, [title, keywords, articleLanguage, goalContext]);

    const persistEditorSnapshotNow = useCallback((targetEditor: Editor) => {
        if (!targetEditor || targetEditor.isDestroyed) return;
        if (currentView !== 'editor') return;
        if (isArticleContentLoadingRef.current) return;
        const { title, keywords, articleLanguage, goalContext } = latestDraftMetaRef.current;
        void persistEditorContentValue(AUTO_DRAFT_KEY, getAutoDraftContentKey(currentUser, title), targetEditor.getJSON());
        writeStorageValue(AUTO_DRAFT_TITLE_KEY, title);
        writeStorageValue(AUTO_DRAFT_KEYWORDS_KEY, JSON.stringify(keywords));
        writeStorageValue(AUTO_DRAFT_LANGUAGE_KEY, articleLanguage);
        writeStorageValue(AUTO_DRAFT_GOAL_CONTEXT_KEY, JSON.stringify(goalContext));
    }, [currentUser, currentView]);

    const updateEditorAnalysisSnapshot = useCallback((targetEditor: Editor) => {
        const contentJSON = targetEditor.getJSON();
        setEditorState(contentJSON);
        setText(targetEditor.getText());
    }, []);

    const captureEditorSnapshot = useCallback((targetEditor: Editor, persistDraft = true) => {
        updateEditorAnalysisSnapshot(targetEditor);
        if (persistDraft) {
            persistEditorSnapshotNow(targetEditor);
        }
    }, [persistEditorSnapshotNow, updateEditorAnalysisSnapshot]);

    const scheduleDraftPersistence = useCallback((targetEditor: Editor) => {
        clearDraftPersistTimer();
        draftPersistTimerRef.current = window.setTimeout(() => {
            persistEditorSnapshotNow(targetEditor);
            draftPersistTimerRef.current = null;
        }, DRAFT_PERSIST_DELAY_MS);
    }, [clearDraftPersistTimer, persistEditorSnapshotNow]);

    const scheduleEditorSnapshot = useCallback((targetEditor: Editor) => {
        clearEditorSnapshotTimer();
        editorSnapshotTimerRef.current = window.setTimeout(() => {
            updateEditorAnalysisSnapshot(targetEditor);
            editorSnapshotTimerRef.current = null;
        }, EDITOR_SNAPSHOT_DELAY_MS);
        scheduleDraftPersistence(targetEditor);
    }, [clearEditorSnapshotTimer, scheduleDraftPersistence, updateEditorAnalysisSnapshot]);

    // TipTap extensions live here. Add editor-level behavior or formatting support in this list.
    const extensions = useMemo(() => [
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
        TextAlign.configure({ types: ['heading', 'paragraph', 'listItem', 'tableCell', 'tableHeader'], alignments: ['left', 'center', 'right', 'justify'] }),
        ViolationHighlight.configure({ multicolor: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        KeyboardShortcuts,
        TextDirection,
    ], []);

    // TipTap editor instance. onUpdate is also the automatic local draft writer.
    const editor = useTiptapEditor({
        extensions,
        content: currentView === 'editor' && !initialActiveArticleTitleRef.current
            ? getInitialContent()
            : createEmptyEditorContent(),
        editorProps: {
            transformPastedHTML: removePastedSectionSeparatorsFromHtml,
            transformPastedText: removePastedSectionSeparatorsFromText,
        },
        onUpdate: ({ editor, transaction }) => {
            if (transaction.getMeta('preventUpdate')) return;
            if (isArticleContentLoadingRef.current) return;
            hasEditorChangedAfterArticleLoadRef.current = true;
            scheduleEditorSnapshot(editor);
        },
        onCreate: ({ editor }) => {
            captureEditorSnapshot(editor, currentView === 'editor' && !pendingAutoDraftRestoreRef.current);
            const savedLang = getStoredLanguage(AUTO_DRAFT_LANGUAGE_KEY) || getStoredLanguage(MANUAL_DRAFT_LANGUAGE_KEY);
            const targetLang = savedLang || preferredLanguage || 'ar';
            setArticleLanguage(targetLang);
        },
    });

    const applyArticleSnapshotToEditor = useCallback(async (
        targetEditor: Editor,
        options: {
            requestId: number;
            titleToUse: string;
            article?: ArticleActivity | RemoteArticleActivity | null;
            snapshot?: ArticleStorageSnapshot | null;
            remoteArticleId?: string | null;
            clearWhenEmpty?: boolean;
        },
    ): Promise<boolean> => {
        if (articleLoadRequestIdRef.current !== options.requestId || targetEditor.isDestroyed) return false;

        const snapshot = options.snapshot || null;
        const latestArticle = options.article || null;
        const resolvedTitle = snapshot?.title || options.titleToUse;
        const snapshotContent = snapshot?.content;
        const snapshotPlainText = snapshot?.plainText?.trim();
        let resolvedContent = isUsableEditorContent(snapshotContent) ? snapshotContent : null;

        if (!resolvedContent && snapshotPlainText) {
            resolvedContent = snapshotPlainText;
        }
        if (!resolvedContent && currentUser) {
            resolvedContent = await resolveArticleContentByTitle(currentUser, resolvedTitle);
        }
        if (!resolvedContent && latestArticle) {
            resolvedContent = await resolveArticleContent(latestArticle);
        }
        if (!resolvedContent) {
            resolvedContent = await resolveDraftContentForTitle(resolvedTitle, currentUser);
        }
        if (articleLoadRequestIdRef.current !== options.requestId || targetEditor.isDestroyed) return false;

        const lang = snapshot?.articleLanguage || latestArticle?.articleLanguage || 'ar';
        const nextKeywords = normalizeKeywords(snapshot?.keywords || latestArticle?.keywords || INITIAL_KEYWORDS);
        const nextGoalContext = normalizeGoalContext(snapshot?.goalContext || latestArticle?.goalContext);
        const hasResolvedContent = isUsableEditorContent(resolvedContent);

        if (!hasResolvedContent && (latestArticle?.stats?.wordCount || 0) > 0) {
            console.warn(`Article "${resolvedTitle}" has saved stats but no recoverable editor content.`);
        }

        const previousLoading = isArticleContentLoadingRef.current;
        isArticleContentLoadingRef.current = true;
        try {
            setTitle(resolvedTitle);
            setArticleKey(resolvedTitle);
            setActiveArticleId(options.remoteArticleId || null);
            setActiveArticleSettings(getActiveArticleSettings(latestArticle));
            setKeywords(nextKeywords);
            setGoalContext(nextGoalContext);
            setArticleLanguage(lang);

            if (hasResolvedContent || options.clearWhenEmpty !== false) {
                setEditorContentSafely(
                    targetEditor,
                    hasResolvedContent ? resolvedContent : createEmptyEditorContent(),
                    createEmptyEditorContent(),
                );
                captureEditorSnapshot(targetEditor, false);
                applyArticleLanguageFormatting(targetEditor, lang);
            }

            restoreArticleAttachments(snapshot?.attachments);
            dispatchSavedAiResults(options.remoteArticleId || null, snapshot?.savedAiResults);
            loadedArticleSnapshotSavedAtRef.current = getSnapshotSavedAtTime(snapshot);
            hasEditorChangedAfterArticleLoadRef.current = false;
            if (hasResolvedContent) {
                lastSavedArticleSignatureRef.current = createArticleSaveSignature({
                    title: resolvedTitle,
                    content: targetEditor.getJSON(),
                    plainText: targetEditor.getText(),
                    keywords: nextKeywords,
                    goalContext: nextGoalContext,
                    articleLanguage: lang,
                    attachments: snapshot?.attachments,
                });
            }
        } finally {
            isArticleContentLoadingRef.current = previousLoading;
        }

        if (hasResolvedContent && currentUser) {
            await persistEditorContentValue(AUTO_DRAFT_KEY, getAutoDraftContentKey(currentUser, resolvedTitle), targetEditor.getJSON(), {
                localTextFallback: true,
                textFallback: targetEditor.getText(),
            });
            writeStorageValue(AUTO_DRAFT_TITLE_KEY, resolvedTitle);
            writeStorageValue(AUTO_DRAFT_KEYWORDS_KEY, JSON.stringify(nextKeywords));
            writeStorageValue(AUTO_DRAFT_LANGUAGE_KEY, lang);
            writeStorageValue(AUTO_DRAFT_GOAL_CONTEXT_KEY, JSON.stringify(nextGoalContext));
        } else if (options.clearWhenEmpty !== false) {
            removeStorageValue(AUTO_DRAFT_KEY);
            removeStorageValue(AUTO_DRAFT_TITLE_KEY);
            removeStorageValue(AUTO_DRAFT_KEYWORDS_KEY);
            removeStorageValue(AUTO_DRAFT_LANGUAGE_KEY);
            removeStorageValue(AUTO_DRAFT_GOAL_CONTEXT_KEY);
        }

        return hasResolvedContent;
    }, [captureEditorSnapshot, currentUser]);

    const refreshArticleFromRemoteInBackground = useCallback((
        targetEditor: Editor,
        options: {
            requestId: number;
            remoteArticleId: string;
            username: string;
            article?: ArticleActivity | RemoteArticleActivity | null;
            fallbackTitle: string;
            baseSavedAt: number;
        },
    ) => {
        void loadRemoteArticleSnapshot(options.remoteArticleId, options.username)
            .then(async remoteSnapshot => {
                if (!remoteSnapshot) return;
                if (articleLoadRequestIdRef.current !== options.requestId || targetEditor.isDestroyed) return;
                if (hasEditorChangedAfterArticleLoadRef.current) return;
                const remoteSavedAt = getSnapshotSavedAtTime(remoteSnapshot);
                if (remoteSavedAt <= Math.max(options.baseSavedAt, loadedArticleSnapshotSavedAtRef.current)) return;

                await applyArticleSnapshotToEditor(targetEditor, {
                    requestId: options.requestId,
                    titleToUse: remoteSnapshot.title || options.fallbackTitle,
                    article: options.article,
                    snapshot: remoteSnapshot,
                    remoteArticleId: options.remoteArticleId,
                });
            })
            .catch(error => {
                console.error(`Failed to refresh article "${options.remoteArticleId}" from Supabase in the background:`, error);
            });
    }, [applyArticleSnapshotToEditor]);

    useEffect(() => {
        if (!editor || !currentUser || !pendingInitialArticleRestoreRef.current) return;

        let cancelled = false;
        const titleToRestore = pendingInitialArticleRestoreRef.current;
        const requestId = articleLoadRequestIdRef.current + 1;
        articleLoadRequestIdRef.current = requestId;
        isArticleContentLoadingRef.current = true;
        skipNextAutoDraftMetadataWriteRef.current = true;

        const restoreInitialArticle = async () => {
            try {
                const remoteArticleId = initialActiveArticleIdRef.current;
                if (cancelled || articleLoadRequestIdRef.current !== requestId || editor.isDestroyed) return;

                const cachedRemoteSnapshot = remoteArticleId
                    ? await loadRemoteArticleSnapshotCache(remoteArticleId)
                    : null;
                const cachedTitle = cachedRemoteSnapshot?.title || titleToRestore;
                const freshArticle = getFreshArticleActivity(currentUser, cachedTitle);
                const localSnapshot = cachedRemoteSnapshot || await loadArticleSnapshot(currentUser, cachedTitle);
                const hasLocalContent = await applyArticleSnapshotToEditor(editor, {
                    requestId,
                    titleToUse: cachedTitle,
                    article: freshArticle,
                    snapshot: localSnapshot,
                    remoteArticleId,
                });

                if (cancelled || articleLoadRequestIdRef.current !== requestId || editor.isDestroyed) return;

                if (remoteArticleId) {
                    if (hasLocalContent) {
                        isArticleContentLoadingRef.current = false;
                        refreshArticleFromRemoteInBackground(editor, {
                            requestId,
                            remoteArticleId,
                            username: currentUser,
                            article: freshArticle,
                            fallbackTitle: cachedTitle,
                            baseSavedAt: getSnapshotSavedAtTime(localSnapshot),
                        });
                        return;
                    }

                    const remoteSnapshot = await loadRemoteArticleSnapshot(remoteArticleId, currentUser);
                    if (cancelled || articleLoadRequestIdRef.current !== requestId || editor.isDestroyed) return;
                    if (remoteSnapshot) {
                        await applyArticleSnapshotToEditor(editor, {
                            requestId,
                            titleToUse: remoteSnapshot.title || cachedTitle,
                            article: freshArticle,
                            snapshot: remoteSnapshot,
                            remoteArticleId,
                        });
                        return;
                    }
                }

                if (!hasLocalContent) {
                    await applyArticleSnapshotToEditor(editor, {
                        requestId,
                        titleToUse: cachedTitle,
                        article: freshArticle,
                        snapshot: null,
                        remoteArticleId,
                    });
                }
            } catch (error) {
                console.error(`Failed to restore active article "${titleToRestore}" after refresh:`, error);
            } finally {
                if (!cancelled && articleLoadRequestIdRef.current === requestId) {
                    isArticleContentLoadingRef.current = false;
                    pendingInitialArticleRestoreRef.current = null;
                }
            }
        };

        void restoreInitialArticle();

        return () => {
            cancelled = true;
        };
    }, [editor, currentUser, applyArticleSnapshotToEditor, refreshArticleFromRemoteInBackground]);

    useEffect(() => {
        if (!editor || !pendingAutoDraftRestoreRef.current) return;

        let cancelled = false;
        const restoreAutoDraftBackup = async () => {
            const reference = readStoredContentReference(AUTO_DRAFT_KEY);
            if (!reference) {
                pendingAutoDraftRestoreRef.current = false;
                return;
            }

            try {
                const backupContent = await resolveEditorContentReference(reference, {
                    allowUnreferencedLocalFallback: true,
                });
                if (cancelled) return;
                if (!backupContent || !isUsableEditorContent(backupContent)) {
                    pendingAutoDraftRestoreRef.current = false;
                    return;
                }
                setEditorContentSafely(editor, backupContent);
                pendingAutoDraftRestoreRef.current = false;
                captureEditorSnapshot(editor);
            } catch (error) {
                console.error('Failed to restore large auto draft backup:', error);
                pendingAutoDraftRestoreRef.current = false;
            }
        };

        void restoreAutoDraftBackup();

        return () => {
            cancelled = true;
        };
    }, [editor, captureEditorSnapshot]);

    useEffect(() => {
        if (!editor) return;

        const flushDraft = () => {
            clearEditorSnapshotTimer();
            clearDraftPersistTimer();
            persistEditorSnapshotNow(editor);
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                flushDraft();
            }
        };

        window.addEventListener('beforeunload', flushDraft);
        window.addEventListener('pagehide', flushDraft);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            flushDraft();
            window.removeEventListener('beforeunload', flushDraft);
            window.removeEventListener('pagehide', flushDraft);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [editor, clearEditorSnapshotTimer, clearDraftPersistTimer, persistEditorSnapshotNow]);

    // Keep the latest draft metadata mirrored in localStorage.
    useEffect(() => {
        setDraftExists(!!readStorageValue(MANUAL_DRAFT_KEY));
    }, [currentView]);

    useEffect(() => {
        if (currentView !== 'editor') return;
        if (skipNextAutoDraftMetadataWriteRef.current) {
            skipNextAutoDraftMetadataWriteRef.current = false;
            return;
        }
        if (isArticleContentLoadingRef.current) return;
        writeStorageValue(AUTO_DRAFT_TITLE_KEY, title);
        writeStorageValue(AUTO_DRAFT_KEYWORDS_KEY, JSON.stringify(keywords));
        writeStorageValue(AUTO_DRAFT_LANGUAGE_KEY, articleLanguage);
        writeStorageValue(AUTO_DRAFT_GOAL_CONTEXT_KEY, JSON.stringify(goalContext));
    }, [title, keywords, articleLanguage, goalContext, currentView]);

    const handleLanguageChange = useCallback((lang: 'ar' | 'en') => {
        setArticleLanguage(lang);
        if (!editor || currentView !== 'editor') return;
        applyArticleLanguageFormatting(editor, lang, true);
    }, [editor, currentView]);

    const handleActiveArticleStatusChange = useCallback(async (status: RemoteArticleStatus): Promise<boolean> => {
        if (!activeArticleId) return false;
        try {
            const updatedArticle = await updateRemoteArticleSettings(activeArticleId, { status });
            setActiveArticleSettings(getActiveArticleSettings(updatedArticle));
            window.dispatchEvent(new CustomEvent('smart-editor-activity-updated'));
            if (shouldClearArticleAiResults(status)) {
                window.dispatchEvent(new CustomEvent('bazarvan:article-ai-clear-request', {
                    detail: { articleId: activeArticleId },
                }));
            }
            return true;
        } catch (error) {
            console.error(`Failed to update active article status "${activeArticleId}":`, error);
            return false;
        }
    }, [activeArticleId]);

    useEffect(() => {
        if (!editor || editor.isDestroyed || currentView !== 'editor') return;

        const formattingTimer = window.setTimeout(() => {
            if (editor.isDestroyed) return;
            try {
                applyArticleLanguageFormatting(editor, articleLanguage);
            } catch (error) {
                console.error("Failed to apply editor language formatting after mounting:", error);
            }
        }, 0);

        return () => window.clearTimeout(formattingTimer);
    }, [editor, articleLanguage, currentView]);

    useEffect(() => {
        if (!editor || editor.isDestroyed) return;
        clearEditorSnapshotTimer();
        captureEditorSnapshot(editor, false);
    }, [
        activeAnalysisPanels.keywords,
        activeAnalysisPanels.structure,
        activeAnalysisPanels.duplicates,
        editor,
        clearEditorSnapshotTimer,
        captureEditorSnapshot,
    ]);

    // Analysis is derived state: do not manually store rule results elsewhere.
    const analysisResults = useContentAnalysis(
        debouncedEditorState,
        debouncedText,
        keywords,
        goalContext,
        articleLanguage,
        uiLanguage,
        activeAnalysisPanels,
        currentView === 'editor',
        title,
    );

    useEffect(() => {
        if (!currentUser || !activeArticleId) return;
        let pendingSeconds = 0;
        const flushPendingTime = () => {
            if (pendingSeconds <= 0) return;
            const secondsToRecord = pendingSeconds;
            pendingSeconds = 0;
            void recordRemoteArticleTime(activeArticleId, secondsToRecord).catch(error => {
                pendingSeconds += secondsToRecord;
                console.error(`Failed to record article time for "${activeArticleId}":`, error);
            });
        };
        const intervalId = setInterval(() => {
          if (currentView === 'editor' && !document.hidden && !isIdle) {
            pendingSeconds += ARTICLE_TIME_TICK_SECONDS;
            if (pendingSeconds >= ARTICLE_TIME_FLUSH_SECONDS) {
                flushPendingTime();
            }
          }
        }, ARTICLE_TIME_TICK_SECONDS * 1000);
        const handleVisibilityChange = () => {
            if (document.hidden) {
                flushPendingTime();
            }
        };
        window.addEventListener('pagehide', flushPendingTime);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            clearInterval(intervalId);
            window.removeEventListener('pagehide', flushPendingTime);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            flushPendingTime();
        };
      }, [currentUser, activeArticleId, isIdle, currentView]);

    const handleClearKeywords = useCallback(() => {
        setKeywords(INITIAL_KEYWORDS);
    }, []);

    // Writes the canonical article to Supabase. The public wrapper below handles overlap and unchanged autosaves.
    const performSaveDraft = useCallback(async (options: SaveDraftOptions = {}): Promise<boolean> => {
        const reason = options.reason || 'manual';
        const forceSave = options.force ?? reason === 'manual';
        const showStatus = reason === 'manual';
        if (!editor || !currentUser || !currentUserId) return false;
        if (isArticleContentLoadingRef.current) return false;
        const contentJSON = editor.getJSON();
        const contentHTML = editor.getHTML();
        const currentText = editor.getText();
        const currentTextTrimmed = currentText.trim();
        if (title.trim() === '' && currentTextTrimmed === '') return false;
        if (currentTextTrimmed === '' && (title.trim() || articleKey.trim())) {
            console.warn('Skipped saving empty editor content for a titled article to avoid overwriting saved content.');
            return false;
        }
        if (showStatus) {
            setSaveStatus('saving');
            setSaveError('');
        }

        try {
            clearEditorSnapshotTimer();
            clearDraftPersistTimer();
            setEditorState(contentJSON);
            setText(currentText);
            const currentWordCount = countWordsInText(currentText);
            let totalDuplicates = analysisResults.duplicateStats.totalDuplicates;
            try {
                totalDuplicates = runDuplicateAnalysis(
                    currentText,
                    keywords,
                    currentWordCount,
                    articleLanguage,
                ).duplicateStats.totalDuplicates;
            } catch (duplicateError) {
                console.warn('Could not refresh the compact duplicate count before saving.', duplicateError);
            }
            const newTitle = title.trim();
            const finalTitleToSave = newTitle || articleKey || '(untitled)';
            const attachments = readCurrentArticleAttachments();

            if (!articleKey && newTitle) {
                setArticleKey(newTitle);
            } else if (articleKey && newTitle && articleKey !== newTitle) {
                setArticleKey(newTitle);
            }

            const saveSignature = createArticleSaveSignature({
                title: finalTitleToSave,
                content: contentJSON,
                plainText: currentText,
                keywords,
                goalContext,
                articleLanguage,
                attachments,
            });
            if (!forceSave && saveSignature === lastSavedArticleSignatureRef.current) {
                return true;
            }

            writeSessionValue(ACTIVE_ARTICLE_TITLE_KEY, finalTitleToSave);
            if (activeArticleId) {
                writeSessionValue(ACTIVE_ARTICLE_ID_KEY, activeArticleId);
            }
            await persistEditorContentValue(AUTO_DRAFT_KEY, getAutoDraftContentKey(currentUser, finalTitleToSave), contentJSON, {
                awaitBackup: reason !== 'auto',
                localTextFallback: true,
                textFallback: currentText,
            });

            const articleSnapshot: ArticleStorageSnapshot = {
                kind: 'articleSnapshot',
                version: 1,
                username: currentUser,
                title: finalTitleToSave,
                content: contentJSON,
                contentHtml: contentHTML,
                plainText: currentText,
                keywords,
                goalContext,
                articleLanguage,
                analysisSummary: {
                    wordCount: currentWordCount,
                    keywordViolations: countKeywordViolations(analysisResults),
                    structureViolations: analysisResults.structureStats.violatingCriteriaCount,
                    totalDuplicates,
                },
                attachments,
                savedAt: new Date().toISOString(),
            };
            void saveArticleSnapshotDurably(articleSnapshot).catch(error => {
                console.error(`Failed to save local article snapshot "${finalTitleToSave}":`, error);
            });
            const currentPendingRequest = pendingRemoteSaveRequestRef.current;
            const pendingRequest = currentPendingRequest
                && currentPendingRequest.articleId === activeArticleId
                && currentPendingRequest.signature === saveSignature
                ? currentPendingRequest
                : {
                    articleId: activeArticleId,
                    signature: saveSignature,
                    idempotencyKey: createArticleSaveIdempotencyKey(),
                };
            pendingRemoteSaveRequestRef.current = pendingRequest;
            const savedArticle = await saveRemoteArticleSnapshot(articleSnapshot, {
                articleId: activeArticleId,
                idempotencyKey: pendingRequest.idempotencyKey,
                saveReason: reason,
            });
            pendingRemoteSaveRequestRef.current = null;
            setActiveArticleId(savedArticle.id);
            setActiveArticleSettings(getActiveArticleSettings(savedArticle));
            setArticleKey(savedArticle.title || finalTitleToSave);
            writeSessionValue(ACTIVE_ARTICLE_ID_KEY, savedArticle.id);
            writeSessionValue(ACTIVE_ARTICLE_TITLE_KEY, savedArticle.title || finalTitleToSave);
            navigateToAppPath(buildEditorArticlePath(savedArticle.id), { replace: true });
            if (reason === 'manual') {
                void recordAppActivity(currentUserId, {
                    eventType: 'article_save',
                    entityType: 'article',
                    entityId: savedArticle.id,
                    path: buildEditorArticlePath(savedArticle.id),
                    metadata: {
                        title: savedArticle.title,
                        status: savedArticle.status,
                        source: savedArticle.source,
                    },
                });
                window.dispatchEvent(new CustomEvent('smart-editor-activity-updated'));

                const manualDraftContentKey = getManualDraftContentKey();
                await persistEditorContentValue(MANUAL_DRAFT_KEY, manualDraftContentKey, contentJSON, {
                    awaitBackup: true,
                    localTextFallback: true,
                    textFallback: currentText,
                });
                writeStorageValue(MANUAL_DRAFT_TITLE_KEY, finalTitleToSave);
                writeStorageValue(MANUAL_DRAFT_KEYWORDS_KEY, JSON.stringify(keywords));
                writeStorageValue(MANUAL_DRAFT_LANGUAGE_KEY, articleLanguage);
                writeStorageValue(MANUAL_DRAFT_GOAL_CONTEXT_KEY, JSON.stringify(goalContext));
                setDraftExists(true);
            }
            lastSavedArticleSignatureRef.current = saveSignature;
            if (showStatus) {
                setSaveStatus('saved');
                setTimeout(() => setSaveStatus('idle'), 2000);
            }
            return true;
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : isRecord(error) && typeof error.message === 'string'
                    ? error.message
                    : 'تعذر حفظ المقالة.';
            console.error('Failed to save article draft:', error);
            if (showStatus) {
                setSaveError(message);
                setSaveStatus('error');
            }
            return false;
        }
    }, [editor, currentUser, currentUserId, title, articleKey, activeArticleId, keywords, articleLanguage, goalContext, analysisResults, clearEditorSnapshotTimer, clearDraftPersistTimer]);

    const handleSaveDraft = useCallback(async (options: SaveDraftOptions = {}): Promise<boolean> => {
        const reason = options.reason || 'manual';
        const forceSave = options.force ?? reason === 'manual';

        if (saveInFlightRef.current) {
            if (forceSave) {
                queuedForcedSaveRef.current = { reason: 'manual', force: true };
                await saveInFlightRef.current.catch(() => false);
                const queuedSave = queuedForcedSaveRef.current;
                if (queuedSave) {
                    queuedForcedSaveRef.current = null;
                    return handleSaveDraft(queuedSave);
                }
            }
            const followUpSave = saveInFlightRef.current;
            return followUpSave || true;
        }

        const savePromise = performSaveDraft({ reason, force: forceSave }).finally(() => {
            saveInFlightRef.current = null;
        });
        saveInFlightRef.current = savePromise;
        const saved = await savePromise;

        const queuedSave = queuedForcedSaveRef.current;
        if (queuedSave) {
            queuedForcedSaveRef.current = null;
            return handleSaveDraft(queuedSave);
        }
        return saved;
    }, [performSaveDraft]);

    const applyGeneratedArticleContent = useCallback(async (options: {
        expectedArticleId: string;
        markdown: string;
    }): Promise<GeneratedContentApplicationResult> => {
        const previousWordCount = editor && !editor.isDestroyed
            ? countWordsInText(editor.getText())
            : 0;
        const fail = (
            errorCode: NonNullable<GeneratedContentApplicationResult['errorCode']>,
            error: string,
            nextWordCount = 0,
        ): GeneratedContentApplicationResult => ({
            ok: false,
            previousWordCount,
            nextWordCount,
            errorCode,
            error,
        });

        if (!editor || editor.isDestroyed) {
            return fail('editor_unavailable', 'The article editor is not available.');
        }
        if (!options.expectedArticleId || activeArticleId !== options.expectedArticleId) {
            return fail('article_changed', 'The active article changed before the generated result was applied.');
        }

        const prepared = prepareContentWritingResultForEditor(options.markdown, title);
        if (!prepared.markdown) {
            return fail('empty_result', 'The generated article body is empty.');
        }

        // Preserve any unsaved human edits before replacing the whole article body.
        if (editor.getText().trim()) {
            const backupSaved = await handleSaveDraft({ reason: 'manual', force: true });
            if (!backupSaved) {
                return fail('backup_failed', 'The current article could not be saved before replacement.');
            }
        }
        if (activeArticleId !== options.expectedArticleId || editor.isDestroyed) {
            return fail('article_changed', 'The active article changed before the generated result was applied.');
        }

        const html = parseMarkdownToArticleHtml(prepared.markdown, articleLanguage);
        isArticleContentLoadingRef.current = true;
        try {
            setEditorContentSafely(editor, html, createEmptyEditorContent());
            applyArticleLanguageFormatting(editor, articleLanguage, false);
        } finally {
            isArticleContentLoadingRef.current = false;
        }
        hasEditorChangedAfterArticleLoadRef.current = true;
        clearEditorSnapshotTimer();
        clearDraftPersistTimer();
        captureEditorSnapshot(editor);

        const nextWordCount = countWordsInText(editor.getText());
        const saved = await handleSaveDraft({ reason: 'manual', force: true });
        if (!saved) {
            return fail(
                'save_failed',
                'The generated article was inserted locally but could not be saved to the server.',
                nextWordCount,
            );
        }

        return { ok: true, previousWordCount, nextWordCount };
    }, [
        activeArticleId,
        articleLanguage,
        captureEditorSnapshot,
        clearDraftPersistTimer,
        clearEditorSnapshotTimer,
        editor,
        handleSaveDraft,
        title,
    ]);

    const handleSaveDraftRef = useRef(handleSaveDraft);
    useEffect(() => {
        handleSaveDraftRef.current = handleSaveDraft;
    }, [handleSaveDraft]);

    useEffect(() => {
        const handleAutoSaveRequest = () => {
            void handleSaveDraftRef.current({ reason: 'auto', force: false });
        };

        window.addEventListener('bazarvan:auto-save-request', handleAutoSaveRequest);
        return () => window.removeEventListener('bazarvan:auto-save-request', handleAutoSaveRequest);
    }, []);

    useEffect(() => {
        if (currentView !== 'editor') return;
        const autosaveInterval = setInterval(() => {
            void handleSaveDraftRef.current({ reason: 'auto', force: false });
        }, AUTOSAVE_INTERVAL_MS);
        return () => clearInterval(autosaveInterval);
    }, [currentView]);

    useEffect(() => {
        if (currentView !== 'editor') return;

        const saveCurrentArticle = () => {
            void handleSaveDraftRef.current({ reason: 'lifecycle', force: false });
        };
        const handleVisibilityChange = () => {
            if (document.hidden) {
                saveCurrentArticle();
            }
        };

        window.addEventListener('pagehide', saveCurrentArticle);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            window.removeEventListener('pagehide', saveCurrentArticle);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [currentView]);

    const handleRestoreDraft = useCallback(async () => {
        if (!editor) return;
        const content = readStorageValue(MANUAL_DRAFT_KEY);
        const titleStr = readStorageValue(MANUAL_DRAFT_TITLE_KEY);
        const keywordsStr = readStorageValue(MANUAL_DRAFT_KEYWORDS_KEY);
        const lang = getStoredLanguage(MANUAL_DRAFT_LANGUAGE_KEY);
        if (content) {
            try {
                const parsedContent = JSON.parse(content);
                const resolvedContent = await resolveStoredEditorContent(parsedContent);
                if (isUsableEditorContent(resolvedContent)) {
                    const isOriginalContentValid = setEditorContentSafely(editor, resolvedContent);
                    captureEditorSnapshot(editor);
                    if (!isOriginalContentValid) {
                        void persistEditorContentValue(MANUAL_DRAFT_KEY, getManualDraftContentKey(), editor.getJSON(), {
                            awaitBackup: true,
                        });
                    }
                } else {
                    removeStorageValue(MANUAL_DRAFT_KEY);
                }
            } catch (error) {
                console.error("Failed to restore saved draft content:", error);
                removeStorageValue(MANUAL_DRAFT_KEY);
            }
        }
        if (titleStr) {
            setTitle(titleStr);
            setArticleKey(titleStr);
        }
        if (keywordsStr) {
            try {
                setKeywords(normalizeKeywords(JSON.parse(keywordsStr)));
            } catch (error) {
                console.error("Failed to restore saved draft keywords:", error);
                removeStorageValue(MANUAL_DRAFT_KEYWORDS_KEY);
            }
        }
        setGoalContext(getStoredGoalContext(MANUAL_DRAFT_GOAL_CONTEXT_KEY));
        if (lang) handleLanguageChange(lang);
        setRestoreStatus('restored');
        setTimeout(() => setRestoreStatus('idle'), 2000);
    }, [editor, handleLanguageChange, captureEditorSnapshot]);

    const handleNewArticle = useCallback(async (lang: 'ar' | 'en') => {
        await handleSaveDraft();
        if (editor) {
            articleLoadRequestIdRef.current += 1;
            removeSessionValue(ACTIVE_ARTICLE_TITLE_KEY);
            removeSessionValue(ACTIVE_ARTICLE_ID_KEY);
            clearStoredCompetitorInputs();
            removeStorageValue(CONTENT_SUMMARY_STORAGE_KEY);
            window.dispatchEvent(new CustomEvent(COMPETITOR_RESET_EVENT));
            setTitle('');
            setArticleKey('');
            setActiveArticleId(null);
            setActiveArticleSettings(EMPTY_ACTIVE_ARTICLE_SETTINGS);
            setKeywords(INITIAL_KEYWORDS);
            setGoalContext(normalizeGoalContext());
            setEditorContentSafely(editor, createEmptyEditorContent(), createEmptyEditorContent());
            captureEditorSnapshot(editor);
            handleLanguageChange(lang);
            setCurrentView('editor');
        }
    }, [editor, handleSaveDraft, setCurrentView, handleLanguageChange, captureEditorSnapshot]);

    const handleLoadArticle = useCallback(async (titleStr: string, article: ArticleActivity | RemoteArticleActivity) => {
        if (editor && article) {
            const requestId = articleLoadRequestIdRef.current + 1;
            articleLoadRequestIdRef.current = requestId;
            isArticleContentLoadingRef.current = true;
            skipNextAutoDraftMetadataWriteRef.current = true;
            const remoteArticleId = getRemoteArticleId(article);
            writeSessionValue(ACTIVE_ARTICLE_TITLE_KEY, titleStr);
            if (remoteArticleId) {
                writeSessionValue(ACTIVE_ARTICLE_ID_KEY, remoteArticleId);
            } else {
                removeSessionValue(ACTIVE_ARTICLE_ID_KEY);
            }
            clearEditorSnapshotTimer();
            clearDraftPersistTimer();
            setTitle(titleStr);
            setArticleKey(titleStr);
            setActiveArticleId(remoteArticleId);
            setActiveArticleSettings(getActiveArticleSettings(article));
            navigateToAppPath(buildEditorArticlePath(remoteArticleId));
            if (remoteArticleId && currentUserId) {
                void recordAppActivity(currentUserId, {
                    eventType: 'article_open',
                    entityType: 'article',
                    entityId: remoteArticleId,
                    path: buildEditorArticlePath(remoteArticleId),
                    metadata: {
                        title: titleStr,
                    },
                });
            }

            try {
                const latestArticle = getFreshArticleActivity(currentUser, titleStr, article) || article;
                setActiveArticleSettings(getActiveArticleSettings(latestArticle));
                if (articleLoadRequestIdRef.current !== requestId || editor.isDestroyed) return;

                const cachedRemoteSnapshot = remoteArticleId
                    ? await loadRemoteArticleSnapshotCache(remoteArticleId)
                    : null;
                const localSnapshot = cachedRemoteSnapshot || (currentUser ? await loadArticleSnapshot(currentUser, titleStr) : null);
                const hasLocalContent = await applyArticleSnapshotToEditor(editor, {
                    requestId,
                    titleToUse: localSnapshot?.title || titleStr,
                    article: latestArticle,
                    snapshot: localSnapshot,
                    remoteArticleId,
                });

                if (articleLoadRequestIdRef.current !== requestId || editor.isDestroyed) return;

                if (remoteArticleId && currentUser) {
                    if (hasLocalContent) {
                        isArticleContentLoadingRef.current = false;
                        refreshArticleFromRemoteInBackground(editor, {
                            requestId,
                            remoteArticleId,
                            username: currentUser,
                            article: latestArticle,
                            fallbackTitle: localSnapshot?.title || titleStr,
                            baseSavedAt: getSnapshotSavedAtTime(localSnapshot),
                        });
                        return;
                    }

                    const remoteSnapshot = await loadRemoteArticleSnapshot(remoteArticleId, currentUser);
                    if (articleLoadRequestIdRef.current !== requestId || editor.isDestroyed) return;
                    if (remoteSnapshot) {
                        await applyArticleSnapshotToEditor(editor, {
                            requestId,
                            titleToUse: remoteSnapshot.title || titleStr,
                            article: latestArticle,
                            snapshot: remoteSnapshot,
                            remoteArticleId,
                        });
                        return;
                    }
                }

                if (!hasLocalContent) {
                    await applyArticleSnapshotToEditor(editor, {
                        requestId,
                        titleToUse: titleStr,
                        article: latestArticle,
                        snapshot: null,
                        remoteArticleId,
                    });
                }
            } finally {
                if (articleLoadRequestIdRef.current === requestId) {
                    isArticleContentLoadingRef.current = false;
                }
            }
        }
    }, [editor, currentUser, currentUserId, applyArticleSnapshotToEditor, refreshArticleFromRemoteInBackground, clearEditorSnapshotTimer, clearDraftPersistTimer]);
    
    const value = useMemo<EditorContextType>(() => ({
        editor,
        title,
        setTitle,
        articleKey,
        text,
        keywords,
        setKeywords,
        articleLanguage,
        activeArticleId,
        activeArticleSettings,
        goalContext,
        setGoalContext,
        analysisResults,
        isDuplicatesTabActive,
        setIsDuplicatesTabActive,
        setIsStructureTabActive,
        saveStatus,
        saveError,
        restoreStatus,
        draftExists,
        scrollContainerRef,
        handleLanguageChange,
        handleActiveArticleStatusChange,
        handleClearKeywords,
        handleSaveDraft,
        applyGeneratedArticleContent,
        handleRestoreDraft,
        handleNewArticle,
        handleLoadArticle,
    }), [
        editor,
        title,
        articleKey,
        text,
        keywords,
        articleLanguage,
        activeArticleId,
        activeArticleSettings,
        goalContext,
        analysisResults,
        isDuplicatesTabActive,
        saveStatus,
        saveError,
        restoreStatus,
        draftExists,
        handleLanguageChange,
        handleActiveArticleStatusChange,
        handleClearKeywords,
        handleSaveDraft,
        applyGeneratedArticleContent,
        handleRestoreDraft,
        handleNewArticle,
        handleLoadArticle,
    ]);

    return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
};
