
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
import { recordArticleSave, recordTimeSpentOnArticle, ArticleActivity, renameArticleActivity } from '../hooks/useUserActivity';
import type { Keywords, FullAnalysis, GoalContext } from '../types';
import { INITIAL_CONTENT, INITIAL_KEYWORDS, MANUAL_DRAFT_KEY, MANUAL_DRAFT_TITLE_KEY, MANUAL_DRAFT_KEYWORDS_KEY, MANUAL_DRAFT_LANGUAGE_KEY, MANUAL_DRAFT_GOAL_CONTEXT_KEY, AUTO_DRAFT_KEY, AUTO_DRAFT_TITLE_KEY, AUTO_DRAFT_KEYWORDS_KEY, AUTO_DRAFT_LANGUAGE_KEY, AUTO_DRAFT_GOAL_CONTEXT_KEY } from '../constants';
import { useUser } from './UserContext';
import { normalizeGoalContext } from '../utils/goalContext';

// --- Helper Hooks ---
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
    const savedContent = localStorage.getItem(AUTO_DRAFT_KEY);
    if (savedContent) return JSON.parse(savedContent);
  } catch (error) {
    console.error("Failed to parse saved content from localStorage:", error);
    localStorage.removeItem(AUTO_DRAFT_KEY);
  }
  return INITIAL_CONTENT;
};

const getStoredLanguage = (key: string): 'ar' | 'en' | null => {
    const saved = localStorage.getItem(key);
    return saved === 'ar' || saved === 'en' ? saved : null;
};

const getStoredGoalContext = (key: string): GoalContext => {
    try {
        const saved = localStorage.getItem(key);
        return saved ? normalizeGoalContext(JSON.parse(saved)) : normalizeGoalContext();
    } catch {
        return normalizeGoalContext();
    }
};

const ViolationHighlight = Highlight.extend({
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
    saveStatus: 'idle' | 'saved';
    restoreStatus: 'idle' | 'restored';
    draftExists: boolean;
    scrollContainerRef: React.RefObject<HTMLDivElement>;
    handleLanguageChange: (lang: 'ar' | 'en') => void;
    handleClearKeywords: () => void;
    handleSaveDraft: () => void;
    handleRestoreDraft: () => void;
    handleNewArticle: () => void;
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
    const [title, setTitle] = useState<string>(() => localStorage.getItem(AUTO_DRAFT_TITLE_KEY) || '');
    const [articleKey, setArticleKey] = useState<string>(() => localStorage.getItem(AUTO_DRAFT_TITLE_KEY) || '');
    const [editorState, setEditorState] = useState<any | null>(null);
    const [text, setText] = useState<string>('');
    const [keywords, setKeywords] = useState<Keywords>(() => {
        try {
          const saved = localStorage.getItem(AUTO_DRAFT_KEYWORDS_KEY);
          return saved ? JSON.parse(saved) : INITIAL_KEYWORDS;
        } catch { return INITIAL_KEYWORDS; }
    });
    const [articleLanguage, setArticleLanguage] = useState<'ar' | 'en'>('ar');
    const [goalContext, setGoalContext] = useState<GoalContext>(() => getStoredGoalContext(AUTO_DRAFT_GOAL_CONTEXT_KEY));
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');
    const [restoreStatus, setRestoreStatus] = useState<'idle' | 'restored'>('idle');
    const [draftExists, setDraftExists] = useState(false);
    
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    
    // Debounce editor state and text content for performance
    const debouncedEditorState = useDebounce(editorState, 500);
    const debouncedText = useDebounce(text, 500);

    // Fix: Stabilize extensions array and move up to avoid block-scoped variable error
    const extensions = useMemo(() => [
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
        TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'], defaultAlignment: 'right' }),
        ViolationHighlight.configure({ multicolor: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        KeyboardShortcuts,
        TextDirection,
    ], []);

    // Fix: Move editor creation above handleLanguageChange and other callbacks to ensure 'editor' is defined when callbacks are created
    const editor = useTiptapEditor({
        extensions,
        content: getInitialContent(),
        onUpdate: ({ editor, transaction }) => {
            if (transaction.getMeta('preventUpdate')) return;
            const contentJSON = editor.getJSON();
            setEditorState(contentJSON);
            setText(editor.getText());
            localStorage.setItem(AUTO_DRAFT_KEY, JSON.stringify(contentJSON));
        },
        onCreate: ({ editor }) => {
            setEditorState(editor.getJSON());
            setText(editor.getText());
            const savedLang = getStoredLanguage(AUTO_DRAFT_LANGUAGE_KEY) || getStoredLanguage(MANUAL_DRAFT_LANGUAGE_KEY);
            const targetLang = savedLang || preferredLanguage || 'ar';
            setArticleLanguage(targetLang);
            
            // Set initial direction/alignment after a tiny delay to ensure editor is ready
            setTimeout(() => {
                const direction = targetLang === 'ar' ? 'rtl' : 'ltr';
                const alignment = targetLang === 'ar' ? 'right' : 'left';
                (editor.chain() as any).focus().selectAll().setTextDirection(direction).setTextAlign(alignment).run();
            }, 10);
        },
    });

    useEffect(() => {
        setDraftExists(!!localStorage.getItem(MANUAL_DRAFT_KEY));
    }, [currentView]);

    useEffect(() => {
        localStorage.setItem(AUTO_DRAFT_TITLE_KEY, title);
        localStorage.setItem(AUTO_DRAFT_KEYWORDS_KEY, JSON.stringify(keywords));
        localStorage.setItem(AUTO_DRAFT_LANGUAGE_KEY, articleLanguage);
        localStorage.setItem(AUTO_DRAFT_GOAL_CONTEXT_KEY, JSON.stringify(goalContext));
    }, [title, keywords, articleLanguage, goalContext]);

    const handleLanguageChange = useCallback((lang: 'ar' | 'en') => {
        if (!editor) return;
        setArticleLanguage(lang);
        const direction = lang === 'ar' ? 'rtl' : 'ltr';
        const alignment = lang === 'ar' ? 'right' : 'left';
        (editor.chain() as any).focus().selectAll().setTextDirection(direction).setTextAlign(alignment).run();
    }, [editor]);

    const analysisResults = useContentAnalysis(debouncedEditorState, debouncedText, keywords, goalContext, articleLanguage, uiLanguage);

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

    const handleSaveDraft = useCallback(() => {
        if (!editor || !currentUser) return;
        const contentJSON = editor.getJSON();
        if (title.trim() === '' && editor.getText().trim() === '') return;

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
        localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify(contentJSON));
        localStorage.setItem(MANUAL_DRAFT_TITLE_KEY, finalTitleToSave);
        localStorage.setItem(MANUAL_DRAFT_KEYWORDS_KEY, JSON.stringify(keywords));
        localStorage.setItem(MANUAL_DRAFT_LANGUAGE_KEY, articleLanguage);
        localStorage.setItem(MANUAL_DRAFT_GOAL_CONTEXT_KEY, JSON.stringify(goalContext));
        setDraftExists(true);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
    }, [editor, currentUser, title, articleKey, keywords, analysisResults, articleLanguage, goalContext]);
    
    const handleSaveDraftRef = useRef(handleSaveDraft);
    useEffect(() => {
        handleSaveDraftRef.current = handleSaveDraft;
    }, [handleSaveDraft]);

    useEffect(() => {
        const autosaveInterval = setInterval(() => {
            handleSaveDraftRef.current();
        }, 20 * 1000); // Autosave every 20 seconds
        return () => clearInterval(autosaveInterval);
    }, []);

    const handleRestoreDraft = useCallback(() => {
        if (!editor) return;
        const content = localStorage.getItem(MANUAL_DRAFT_KEY);
        const titleStr = localStorage.getItem(MANUAL_DRAFT_TITLE_KEY);
        const keywordsStr = localStorage.getItem(MANUAL_DRAFT_KEYWORDS_KEY);
        const lang = getStoredLanguage(MANUAL_DRAFT_LANGUAGE_KEY);
        if (content) editor.commands.setContent(JSON.parse(content));
        if (titleStr) {
            setTitle(titleStr);
            setArticleKey(titleStr);
        }
        if (keywordsStr) setKeywords(JSON.parse(keywordsStr));
        setGoalContext(getStoredGoalContext(MANUAL_DRAFT_GOAL_CONTEXT_KEY));
        if (lang) handleLanguageChange(lang);
        setRestoreStatus('restored');
        setTimeout(() => setRestoreStatus('idle'), 2000);
    }, [editor, handleLanguageChange]);

    const handleNewArticle = useCallback(() => {
        handleSaveDraft();
        if (editor) {
            setTitle('');
            setArticleKey('');
            setKeywords(INITIAL_KEYWORDS);
            setGoalContext(normalizeGoalContext());
            editor.commands.setContent(INITIAL_CONTENT);
            handleLanguageChange(preferredLanguage);
            setCurrentView('editor');
        }
    }, [editor, handleSaveDraft, preferredLanguage, setCurrentView, handleLanguageChange]);

    const handleLoadArticle = useCallback((titleStr: string, article: ArticleActivity) => {
        if (editor && article) {
            const lang = article.articleLanguage || 'ar';
            setTitle(titleStr);
            setArticleKey(titleStr);
            setKeywords(article.keywords || INITIAL_KEYWORDS);
            setGoalContext(normalizeGoalContext(article.goalContext));
            editor.commands.setContent(article.content || INITIAL_CONTENT);
            handleLanguageChange(lang);
            setCurrentView('editor');
        }
    }, [editor, setCurrentView, handleLanguageChange]);
    
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
