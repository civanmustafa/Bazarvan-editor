import React, { useEffect, useState, useCallback } from 'react';
import { useUser } from '../contexts/UserContext';
import { useEditorSelector } from '../contexts/EditorContext';
import { useInteractionSelector } from '../contexts/InteractionContext';
import { useAISelector } from '../contexts/AIContext';
import { FileInput, Focus } from 'lucide-react';

import { IconTooltip, Separator } from './toolbar/ToolbarItems';
import FormattingActions from './toolbar/FormattingActions';
import UtilityActions from './toolbar/UtilityActions';
import AIActions from './toolbar/AIActions';
import DocumentActions from './toolbar/DocumentActions';
import FindAndReplace from './toolbar/FindAndReplace';
import NewArticleLanguageModal from './NewArticleLanguageModal';
import ArticleImportModal from './ArticleImportModal';

/*
 * Toolbar composition:
 * - FormattingActions: TipTap formatting buttons.
 * - UtilityActions: cleanup, highlights, TOC, find/replace.
 * - AIActions: AI commands that create suggestions/analysis.
 * - DocumentActions: save/restore/new/dashboard/logout/theme.
 *
 * Add a new toolbar command in the matching toolbar/* component, then pass only the needed handler here.
 */
type EditorToolbarProps = {
    isFocusMode?: boolean;
    onToggleFocusMode?: () => void;
    onOpenInternalLinking?: () => void;
};

const EditorToolbar: React.FC<EditorToolbarProps> = ({
    isFocusMode = false,
    onToggleFocusMode,
    onOpenInternalLinking,
}) => {
    const {
        isDarkMode,
        setIsDarkMode,
        handleLogout: onLogout,
        setCurrentView,
        uiLanguage,
        t,
    } = useUser();

    const editor = useEditorSelector(context => context.editor);
    const title = useEditorSelector(context => context.title);
    const setTitle = useEditorSelector(context => context.setTitle);
    const analysisResults = useEditorSelector(context => context.analysisResults);
    const onSaveDraft = useEditorSelector(context => context.handleSaveDraft);
    const onRestoreDraft = useEditorSelector(context => context.handleRestoreDraft);
    const saveStatus = useEditorSelector(context => context.saveStatus);
    const saveError = useEditorSelector(context => context.saveError);
    const restoreStatus = useEditorSelector(context => context.restoreStatus);
    const draftExists = useEditorSelector(context => context.draftExists);
    const onNewArticle = useEditorSelector(context => context.handleNewArticle);
    const clearAllHighlights = useInteractionSelector(context => context.clearAllHighlights);
    const onToggleAllKeywordsHighlight = useInteractionSelector(context => context.handleToggleAllKeywordsHighlight);
    const onRemoveEmptyLines = useInteractionSelector(context => context.handleRemoveEmptyLines);
    const onFixParagraphs = useInteractionSelector(context => context.handleFixParagraphs);
    const onClearFormatting = useInteractionSelector(context => context.handleClearFormatting);
    const highlightedItem = useInteractionSelector(context => context.highlightedItem);
    const onToggleToc = useInteractionSelector(context => context.handleToggleToc);
    const isTocVisible = useInteractionSelector(context => context.isTocVisible);
    const isTooltipAlwaysOn = useInteractionSelector(context => context.isTooltipAlwaysOn);
    const setIsTooltipAlwaysOn = useInteractionSelector(context => context.setIsTooltipAlwaysOn);

    const onAiRequest = useAISelector(context => context.handleAiRequest);
    const isAiLoading = useAISelector(context => context.isAiLoading);
    const isAiCommandLoading = useAISelector(context => context.isAiCommandLoading);
    const onAnalyzeHeadings = useAISelector(context => context.handleAnalyzeHeadings);


    const handleShowDashboard = useCallback(async () => {
      try {
        await onSaveDraft();
      } catch (error) {
        console.error('Failed to save before opening dashboard:', error);
      } finally {
        setCurrentView('dashboard');
      }
    }, [onSaveDraft, setCurrentView]);

    const handleLogout = useCallback(async () => {
      await onSaveDraft();
      onLogout();
    }, [onSaveDraft, onLogout]);

    const totalWordCount = analysisResults.wordCount;
    const totalCharCount = editor?.getText().length ?? 0;

    const [activeState, setActiveState] = useState({
      isBold: false,
      isItalic: false,
      isH2: false,
      isH3: false,
      isH4: false,
      isParagraph: false,
      isBulletList: false,
      isOrderedList: false,
      isTableActive: false,
      canUndo: false,
      canRedo: false,
      hasSelection: false,
      isAlignLeft: false,
      isAlignCenter: false,
      isAlignRight: false,
      isAlignJustify: false,
      isRtl: false,
      isLtr: false,
    });
    const [selectionCount, setSelectionCount] = useState({ words: 0, chars: 0 });
    const isAllKeywordsHighlighted = highlightedItem === '__ALL_KEYWORDS__';

    const [isFindReplaceVisible, setIsFindReplaceVisible] = useState(false);
    const [isNewArticleLanguageModalOpen, setIsNewArticleLanguageModalOpen] = useState(false);
    const [isArticleImportModalOpen, setIsArticleImportModalOpen] = useState(false);
    const [articleImportUrl, setArticleImportUrl] = useState('');
  
    const isAnyGeminiLoading = isAiCommandLoading || isAiLoading.gemini || isAiLoading.geminiPaid || isAiLoading.chatgpt;
    const focusModeLabel = isFocusMode
      ? (uiLanguage === 'ar' ? 'إنهاء وضع التركيز' : 'Exit focus mode')
      : (uiLanguage === 'ar' ? 'وضع التركيز' : 'Focus mode');
  
    const handleToggleFindReplace = useCallback(() => {
        setIsFindReplaceVisible(prev => !prev);
    }, []);

    const handleStartNewArticle = useCallback(() => {
        setIsNewArticleLanguageModalOpen(true);
    }, []);

    const handleChooseNewArticleLanguage = useCallback((lang: 'ar' | 'en') => {
        setIsNewArticleLanguageModalOpen(false);
        onNewArticle(lang);
    }, [onNewArticle]);

    // Mirror TipTap selection/formatting state into button active states and counters.
    useEffect(() => {
      if (!editor) return;
      const updateToolbarState = () => {
        setActiveState({
          isBold: editor.isActive('bold'),
          isItalic: editor.isActive('italic'),
          isH2: editor.isActive('heading', { level: 2 }),
          isH3: editor.isActive('heading', { level: 3 }),
          isH4: editor.isActive('heading', { level: 4 }),
          isParagraph: editor.isActive('paragraph'),
          isBulletList: editor.isActive('bulletList'),
          isOrderedList: editor.isActive('orderedList'),
          isTableActive: editor.isActive('table'),
          canUndo: (editor.can() as any).undo(),
          canRedo: (editor.can() as any).redo(),
          hasSelection: !editor.state.selection.empty,
          isAlignLeft: editor.isActive({ textAlign: 'left' }),
          isAlignCenter: editor.isActive({ textAlign: 'center' }),
          isAlignRight: editor.isActive({ textAlign: 'right' }),
          isAlignJustify: editor.isActive({ textAlign: 'justify' }),
          isRtl: editor.isActive('paragraph', { dir: 'rtl' }) || editor.isActive('heading', { dir: 'rtl' }),
          isLtr: editor.isActive('paragraph', { dir: 'ltr' }) || editor.isActive('heading', { dir: 'ltr' }),
        });
        const { from, to, empty } = editor.state.selection;
        if (empty) {
          setSelectionCount({ words: 0, chars: 0 });
        } else {
          const selectedText = editor.state.doc.textBetween(from, to, ' ');
          const words = selectedText.trim().split(/\s+/).filter(Boolean).length;
          setSelectionCount({ words, chars: selectedText.length });
        }
      };
      editor.on('transaction', updateToolbarState);
      editor.on('selectionUpdate', updateToolbarState);
      editor.on('focus', updateToolbarState);
      editor.on('blur', () => setSelectionCount({ words: 0, chars: 0 }));
      updateToolbarState();
      return () => {
        editor.off('transaction', updateToolbarState);
        editor.off('selectionUpdate', updateToolbarState);
        editor.off('focus', updateToolbarState);
        editor.off('blur', () => setSelectionCount({ words: 0, chars: 0 }));
      };
    }, [editor]);

    if (!editor) return null;
    
    return (
      <>
      <div className="sticky top-0 z-20 flex flex-col gap-1 p-1 bg-[#F2F3F5] dark:bg-[#1F1F1F] border-b border-gray-300 dark:border-[#3C3C3C]">
        <div className="grid w-full grid-cols-[minmax(0,3fr)_minmax(0,1fr)] items-center gap-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t.titlePlaceholder}
            className="title-input min-w-0 py-1.5 px-2 text-base font-bold bg-transparent border-none rounded-md text-[#333333] placeholder:text-gray-400 focus:ring-0 focus:outline-none dark:text-gray-100 dark:placeholder:text-gray-500"
            aria-label={t.articleTitle}
          />
          <form
            className="flex min-w-0 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              setIsArticleImportModalOpen(true);
            }}
          >
            <input
              id="article-import-inline-url"
              type="url"
              dir="ltr"
              value={articleImportUrl}
              onChange={(event) => setArticleImportUrl(event.target.value)}
              placeholder={uiLanguage === 'ar' ? 'رابط المقالة أو الخبر' : 'Article or news URL'}
              aria-label={uiLanguage === 'ar' ? 'رابط المقالة أو الخبر' : 'Article or news URL'}
              className="h-9 min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-[#d4af37] focus:ring-2 focus:ring-[#d4af37]/20 dark:border-[#444] dark:bg-[#171717] dark:text-gray-100 dark:placeholder:text-gray-500"
            />
            <button
              type="submit"
              className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md bg-[#b28b22] px-3 text-xs font-black text-white transition hover:bg-[#94731c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#1F1F1F]"
              title={uiLanguage === 'ar' ? 'سحب المقالة من الرابط' : 'Fetch article from URL'}
            >
              <FileInput size={15} />
              <span>{uiLanguage === 'ar' ? 'سحب' : 'Fetch'}</span>
            </button>
          </form>
        </div>

        {isFindReplaceVisible && (
          <FindAndReplace editor={editor} t={t} clearAllHighlights={clearAllHighlights} onClose={handleToggleFindReplace} />
        )}
      
        <div className="flex flex-wrap items-center gap-1 w-full pt-1.5 mt-1.5 border-t border-gray-300 dark:border-[#3C3C3C]">
            <FormattingActions editor={editor} activeState={activeState} t={t} />

            <div className="ms-auto flex items-center gap-1">
                <div className="hidden whitespace-nowrap rounded-md bg-gray-200 px-2 py-1 text-xs text-gray-600 xl:block dark:bg-[#2A2A2A] dark:text-gray-400">
                  {selectionCount.chars > 0 ? (
                    <span>{`${selectionCount.words} ${t.words}`} / {`${selectionCount.chars} ${t.characters}`}</span>
                  ) : (
                    <span>{`${totalWordCount} ${t.words}`} / {`${totalCharCount} ${t.characters}`}</span>
                  )}
                </div>
                <Separator />
                {onToggleFocusMode && (
                  <>
                    <button
                      type="button"
                      onClick={onToggleFocusMode}
                      aria-pressed={isFocusMode}
                      aria-label={`${focusModeLabel} — Ctrl+Shift+F`}
                      title={`${focusModeLabel} — Ctrl+Shift+F`}
                      className={`group relative inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] ${
                        isFocusMode
                          ? 'bg-[#d4af37]/15 text-[#9a781c] ring-1 ring-inset ring-[#d4af37]/35 dark:text-[#f2d675]'
                          : 'text-gray-500 hover:bg-gray-200/80 hover:text-gray-800 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white'
                      }`}
                    >
                      <Focus size={17} />
                      <span className="hidden 2xl:inline">{uiLanguage === 'ar' ? 'تركيز' : 'Focus'}</span>
                      <IconTooltip label={`${focusModeLabel} (Ctrl+Shift+F)`} />
                    </button>
                    <Separator />
                  </>
                )}
                <UtilityActions 
                    t={t}
                    isAllKeywordsHighlighted={isAllKeywordsHighlighted}
                    isTooltipAlwaysOn={isTooltipAlwaysOn}
                    isTocVisible={isTocVisible}
                    isFindReplaceVisible={isFindReplaceVisible}
                    onClearAllHighlights={clearAllHighlights}
                    onToggleAllKeywordsHighlight={onToggleAllKeywordsHighlight}
                    onSetIsTooltipAlwaysOn={setIsTooltipAlwaysOn}
                    onToggleToc={onToggleToc}
                    onOpenInternalLinking={onOpenInternalLinking || (() => undefined)}
                    onFixParagraphs={onFixParagraphs}
                    onRemoveEmptyLines={onRemoveEmptyLines}
                    onToggleFindReplace={handleToggleFindReplace}
                    onClearFormatting={onClearFormatting}
                />
                
                <AIActions
                    hasSelection={activeState.hasSelection}
                    isAnyGeminiLoading={isAnyGeminiLoading}
                    uiLanguage={uiLanguage}
                    t={t}
                    onAiRequest={onAiRequest}
                    onAnalyzeHeadings={onAnalyzeHeadings}
                />
                
                <Separator />

                <DocumentActions
                    isDarkMode={isDarkMode}
                    t={t}
                    restoreStatus={restoreStatus}
                    draftExists={draftExists}
                    saveStatus={saveStatus}
                    saveError={saveError}
                    onRestoreDraft={onRestoreDraft}
                    onSaveDraft={onSaveDraft}
                    onNewArticle={handleStartNewArticle}
                    onShowDashboard={handleShowDashboard}
                    onLogout={handleLogout}
                    onSetIsDarkMode={setIsDarkMode}
                />
            </div>
        </div>
      </div>
      {isNewArticleLanguageModalOpen && (
        <NewArticleLanguageModal
          t={t}
          uiLanguage={uiLanguage}
          onChoose={handleChooseNewArticleLanguage}
        />
      )}
      {isArticleImportModalOpen && (
        <ArticleImportModal
          initialUrl={articleImportUrl}
          autoFetch={Boolean(articleImportUrl.trim())}
          onClose={() => setIsArticleImportModalOpen(false)}
        />
      )}
      </>
    );
};

export default EditorToolbar;
