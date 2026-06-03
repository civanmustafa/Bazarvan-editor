
import React, { useState, useCallback, useEffect, useRef, createContext, useContext, useMemo } from 'react';
import { useEditor as useTiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Highlight } from '@tiptap/extension-highlight';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import TextAlign from '@tiptap/extension-text-align';
import { Extension, Editor } from '@tiptap/core';
import { useContentAnalysis } from '../hooks/useContentAnalysis';
import { recordArticleSave, recordTimeSpentOnArticle, ArticleActivity, renameArticleActivity, normalizeKeywords } from '../hooks/useUserActivity';
import type { Keywords, FullAnalysis, GoalContext } from '../types';
import { INITIAL_CONTENT, INITIAL_KEYWORDS, MANUAL_DRAFT_KEY, MANUAL_DRAFT_TITLE_KEY, MANUAL_DRAFT_KEYWORDS_KEY, MANUAL_DRAFT_LANGUAGE_KEY, MANUAL_DRAFT_GOAL_CONTEXT_KEY, AUTO_DRAFT_KEY, AUTO_DRAFT_TITLE_KEY, AUTO_DRAFT_KEYWORDS_KEY, AUTO_DRAFT_LANGUAGE_KEY, AUTO_DRAFT_GOAL_CONTEXT_KEY } from '../constants';
import { CONTENT_SUMMARY_STORAGE_KEY } from '../constants/engineeringPrompts';
import { useUser } from './UserContext';
import { normalizeGoalContext } from '../utils/goalContext';
import { clearStoredCompetitorInputs, COMPETITOR_RESET_EVENT } from '../utils/competitorStorage';

/*
 * EditorContext is the owner of article editing state:
 * TipTap setup, title, keywords, article language, goal context, autosave/manual save,
 * draft restore, loading saved articles, and triggering content analysis.
 *
 * Edit here when changing editor persistence, language direction, or article lifecycle.
 * Edit hooks/useContentAnalysis.ts when changing SEO/content rules.
 */

// --- Local timing helpers ---
const EDITOR_SNAPSHOT_DELAY_MS = 300;
const ANALYSIS_DEBOUNCE_MS = 900;
const AUTOSAVE_INTERVAL_MS = 60 * 1000;

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

const isRecord = (value: unknown): value is Record<string, any> => (
    !!value && typeof value === 'object' && !Array.isArray(value)
);

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
        if (level !== undefined && (![1, 2, 3, 4] as const).includes(level)) return false;
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

const getSafeEditorContent = (value: unknown, fallback: any = INITIAL_CONTENT): any => {
    const normalized = normalizeStoredEditorContent(value);
    if (normalized !== null) return normalized;

    const recoveredText = extractTextFromStoredEditorContent(value).trim();
    return recoveredText || fallback;
};

const isUsableEditorContent = (value: unknown): boolean => (
    normalizeStoredEditorContent(value) !== null ||
    extractTextFromStoredEditorContent(value).trim().length > 0
);

const setEditorContentSafely = (editor: Editor, value: unknown, fallback: any = INITIAL_CONTENT): boolean => {
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
        if (isUsableEditorContent(parsedContent)) return getSafeEditorContent(parsedContent);
        removeStorageValue(AUTO_DRAFT_KEY);
    }
  } catch (error) {
    console.error("Failed to parse saved content from localStorage:", error);
    removeStorageValue(AUTO_DRAFT_KEY);
  }
  return INITIAL_CONTENT;
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

const applyArticleLanguageFormatting = (editor: Editor, lang: 'ar' | 'en') => {
    const direction = lang === 'ar' ? 'rtl' : 'ltr';
    const alignment = lang === 'ar' ? 'right' : 'left';
    const editorDom = editor.view.dom as HTMLElement;

    editorDom.setAttribute('dir', direction);
    editorDom.style.direction = direction;
    editorDom.style.textAlign = alignment;

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
    goalContext: GoalContext;
    setGoalContext: React.Dispatch<React.SetStateAction<GoalContext>>;
    analysisResults: FullAnalysis;
    isDuplicatesTabActive: boolean;
    setIsDuplicatesTabActive: React.Dispatch<React.SetStateAction<boolean>>;
    saveStatus: 'idle' | 'saved';
    restoreStatus: 'idle' | 'restored';
    draftExists: boolean;
    scrollContainerRef: React.RefObject<HTMLDivElement>;
    handleLanguageChange: (lang: 'ar' | 'en') => void;
    handleClearKeywords: () => void;
    handleSaveDraft: () => void;
    handleRestoreDraft: () => void;
    handleNewArticle: (lang: 'ar' | 'en') => void;
    handleLoadArticle: (title: string, article: ArticleActivity) => void;
}

const EditorContext = createContext<EditorContextType | null>(null);

export const useEditor = () => {
  const context = useContext(EditorContext);
  if (!context) throw new Error("useEditor must be used within an EditorProvider");
  return context;
};

export const EditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { currentUser, currentView, setCurrentView, preferredLanguage, uiLanguage, isIdle } = useUser();
    const [title, setTitle] = useState<string>(() => readStorageValue(AUTO_DRAFT_TITLE_KEY) || '');
    const [articleKey, setArticleKey] = useState<string>(() => readStorageValue(AUTO_DRAFT_TITLE_KEY) || '');
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
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');
    const [restoreStatus, setRestoreStatus] = useState<'idle' | 'restored'>('idle');
    const [draftExists, setDraftExists] = useState(false);
    const [isDuplicatesTabActive, setIsDuplicatesTabActive] = useState(false);
    
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const editorSnapshotTimerRef = useRef<number | null>(null);
    const latestDraftMetaRef = useRef({ title, keywords, articleLanguage, goalContext });
    
    // Debounce editor state and text content before analysis to keep typing responsive.
    const debouncedEditorState = useDebounce(editorState, ANALYSIS_DEBOUNCE_MS);
    const debouncedText = useDebounce(text, ANALYSIS_DEBOUNCE_MS);

    const clearEditorSnapshotTimer = useCallback(() => {
        if (editorSnapshotTimerRef.current) {
            clearTimeout(editorSnapshotTimerRef.current);
            editorSnapshotTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        latestDraftMetaRef.current = { title, keywords, articleLanguage, goalContext };
    }, [title, keywords, articleLanguage, goalContext]);

    const persistEditorSnapshotNow = useCallback((targetEditor: Editor) => {
        if (!targetEditor || targetEditor.isDestroyed) return;
        const { title, keywords, articleLanguage, goalContext } = latestDraftMetaRef.current;
        writeStorageValue(AUTO_DRAFT_KEY, JSON.stringify(targetEditor.getJSON()));
        writeStorageValue(AUTO_DRAFT_TITLE_KEY, title);
        writeStorageValue(AUTO_DRAFT_KEYWORDS_KEY, JSON.stringify(keywords));
        writeStorageValue(AUTO_DRAFT_LANGUAGE_KEY, articleLanguage);
        writeStorageValue(AUTO_DRAFT_GOAL_CONTEXT_KEY, JSON.stringify(goalContext));
    }, []);

    const captureEditorSnapshot = useCallback((targetEditor: Editor, persistDraft = true) => {
        const contentJSON = targetEditor.getJSON();
        setEditorState(contentJSON);
        setText(targetEditor.getText());
        if (persistDraft) {
            persistEditorSnapshotNow(targetEditor);
        }
    }, [persistEditorSnapshotNow]);

    const scheduleEditorSnapshot = useCallback((targetEditor: Editor) => {
        clearEditorSnapshotTimer();
        editorSnapshotTimerRef.current = window.setTimeout(() => {
            captureEditorSnapshot(targetEditor);
            editorSnapshotTimerRef.current = null;
        }, EDITOR_SNAPSHOT_DELAY_MS);
    }, [captureEditorSnapshot, clearEditorSnapshotTimer]);

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
        content: getInitialContent(),
        editorProps: {
            transformPastedHTML: removePastedSectionSeparatorsFromHtml,
            transformPastedText: removePastedSectionSeparatorsFromText,
        },
        onUpdate: ({ editor, transaction }) => {
            if (transaction.getMeta('preventUpdate')) return;
            scheduleEditorSnapshot(editor);
        },
        onCreate: ({ editor }) => {
            captureEditorSnapshot(editor, currentView === 'editor');
            const savedLang = getStoredLanguage(AUTO_DRAFT_LANGUAGE_KEY) || getStoredLanguage(MANUAL_DRAFT_LANGUAGE_KEY);
            const targetLang = savedLang || preferredLanguage || 'ar';
            setArticleLanguage(targetLang);
        },
    });

    useEffect(() => {
        if (!editor) return;

        const flushDraft = () => {
            clearEditorSnapshotTimer();
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
    }, [editor, clearEditorSnapshotTimer, persistEditorSnapshotNow]);

    // Keep the latest draft metadata mirrored in localStorage.
    useEffect(() => {
        setDraftExists(!!readStorageValue(MANUAL_DRAFT_KEY));
    }, [currentView]);

    useEffect(() => {
        writeStorageValue(AUTO_DRAFT_TITLE_KEY, title);
        writeStorageValue(AUTO_DRAFT_KEYWORDS_KEY, JSON.stringify(keywords));
        writeStorageValue(AUTO_DRAFT_LANGUAGE_KEY, articleLanguage);
        writeStorageValue(AUTO_DRAFT_GOAL_CONTEXT_KEY, JSON.stringify(goalContext));
    }, [title, keywords, articleLanguage, goalContext]);

    const handleLanguageChange = useCallback((lang: 'ar' | 'en') => {
        setArticleLanguage(lang);
        if (!editor || currentView !== 'editor') return;
        applyArticleLanguageFormatting(editor, lang);
    }, [editor, currentView]);

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
        if (!isDuplicatesTabActive || !editor || editor.isDestroyed) return;
        clearEditorSnapshotTimer();
        captureEditorSnapshot(editor, false);
    }, [isDuplicatesTabActive, editor, clearEditorSnapshotTimer, captureEditorSnapshot]);

    // Analysis is derived state: do not manually store rule results elsewhere.
    const analysisResults = useContentAnalysis(
        debouncedEditorState,
        debouncedText,
        keywords,
        goalContext,
        articleLanguage,
        uiLanguage,
        isDuplicatesTabActive,
        currentView === 'editor'
    );

    useEffect(() => {
        if (!currentUser) return;
        const intervalId = setInterval(() => {
          if (currentView === 'editor' && !document.hidden && !isIdle) {
            recordTimeSpentOnArticle(currentUser, articleKey, 10);
          }
        }, 10 * 1000);
        return () => clearInterval(intervalId);
      }, [currentUser, articleKey, isIdle, currentView]);

    const handleClearKeywords = useCallback(() => {
        setKeywords(INITIAL_KEYWORDS);
    }, []);

    // Manual save updates both per-user activity history and the manual restore draft.
    const handleSaveDraft = useCallback(() => {
        if (!editor || !currentUser) return;
        const contentJSON = editor.getJSON();
        const currentText = editor.getText();
        if (title.trim() === '' && currentText.trim() === '') return;
        clearEditorSnapshotTimer();
        setEditorState(contentJSON);
        setText(currentText);
        writeStorageValue(AUTO_DRAFT_KEY, JSON.stringify(contentJSON));

        let currentKey = articleKey;
        const newTitle = title.trim();
        let finalTitleToSave = newTitle || currentKey || '(بدون عنوان)';

        if (!currentKey && newTitle) {
            setArticleKey(newTitle);
        } else if (currentKey && newTitle && currentKey !== newTitle) {
            if (renameArticleActivity(currentUser, currentKey, newTitle)) {
                setArticleKey(newTitle);
            } else {
                setTitle(currentKey);
                finalTitleToSave = currentKey;
            }
        }
        recordArticleSave(currentUser, finalTitleToSave, contentJSON, keywords, analysisResults, articleLanguage, goalContext);
        writeStorageValue(MANUAL_DRAFT_KEY, JSON.stringify(contentJSON));
        writeStorageValue(MANUAL_DRAFT_TITLE_KEY, finalTitleToSave);
        writeStorageValue(MANUAL_DRAFT_KEYWORDS_KEY, JSON.stringify(keywords));
        writeStorageValue(MANUAL_DRAFT_LANGUAGE_KEY, articleLanguage);
        writeStorageValue(MANUAL_DRAFT_GOAL_CONTEXT_KEY, JSON.stringify(goalContext));
        setDraftExists(true);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
    }, [editor, currentUser, title, articleKey, keywords, analysisResults, articleLanguage, goalContext, clearEditorSnapshotTimer]);
    
    const handleSaveDraftRef = useRef(handleSaveDraft);
    useEffect(() => {
        handleSaveDraftRef.current = handleSaveDraft;
    }, [handleSaveDraft]);

    useEffect(() => {
        if (currentView !== 'editor') return;
        const autosaveInterval = setInterval(() => {
            handleSaveDraftRef.current();
        }, AUTOSAVE_INTERVAL_MS);
        return () => clearInterval(autosaveInterval);
    }, [currentView]);

    const handleRestoreDraft = useCallback(() => {
        if (!editor) return;
        const content = readStorageValue(MANUAL_DRAFT_KEY);
        const titleStr = readStorageValue(MANUAL_DRAFT_TITLE_KEY);
        const keywordsStr = readStorageValue(MANUAL_DRAFT_KEYWORDS_KEY);
        const lang = getStoredLanguage(MANUAL_DRAFT_LANGUAGE_KEY);
        if (content) {
            try {
                const parsedContent = JSON.parse(content);
                if (isUsableEditorContent(parsedContent)) {
                    const isOriginalContentValid = setEditorContentSafely(editor, parsedContent);
                    captureEditorSnapshot(editor);
                    if (!isOriginalContentValid) {
                        writeStorageValue(MANUAL_DRAFT_KEY, JSON.stringify(editor.getJSON()));
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

    const handleNewArticle = useCallback((lang: 'ar' | 'en') => {
        handleSaveDraft();
        if (editor) {
            clearStoredCompetitorInputs();
            removeStorageValue(CONTENT_SUMMARY_STORAGE_KEY);
            window.dispatchEvent(new CustomEvent(COMPETITOR_RESET_EVENT));
            setTitle('');
            setArticleKey('');
            setKeywords(INITIAL_KEYWORDS);
            setGoalContext(normalizeGoalContext());
            setEditorContentSafely(editor, INITIAL_CONTENT);
            captureEditorSnapshot(editor);
            handleLanguageChange(lang);
            setCurrentView('editor');
        }
    }, [editor, handleSaveDraft, setCurrentView, handleLanguageChange, captureEditorSnapshot]);

    const handleLoadArticle = useCallback((titleStr: string, article: ArticleActivity) => {
        if (editor && article) {
            const lang = article.articleLanguage || 'ar';
            setTitle(titleStr);
            setArticleKey(titleStr);
            setKeywords(article.keywords || INITIAL_KEYWORDS);
            setGoalContext(normalizeGoalContext(article.goalContext));
            setEditorContentSafely(editor, article.content || INITIAL_CONTENT);
            captureEditorSnapshot(editor);
            handleLanguageChange(lang);
            setCurrentView('editor');
        }
    }, [editor, setCurrentView, handleLanguageChange, captureEditorSnapshot]);
    
    const value: EditorContextType = {
        editor,
        title,
        setTitle,
        articleKey,
        text,
        keywords,
        setKeywords,
        articleLanguage,
        goalContext,
        setGoalContext,
        analysisResults,
        isDuplicatesTabActive,
        setIsDuplicatesTabActive,
        saveStatus,
        restoreStatus,
        draftExists,
        scrollContainerRef,
        handleLanguageChange,
        handleClearKeywords,
        handleSaveDraft,
        handleRestoreDraft,
        handleNewArticle,
        handleLoadArticle,
    };

    return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
};
