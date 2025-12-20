import React, { useEffect, useState, useCallback } from 'react';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useInteraction } from '../contexts/InteractionContext';
import { useAI } from '../contexts/AIContext';
import { Languages } from 'lucide-react';

import { Separator } from './toolbar/ToolbarItems';
import FormattingActions from './toolbar/FormattingActions';
import UtilityActions from './toolbar/UtilityActions';
import AIActions from './toolbar/AIActions';
import DocumentActions from './toolbar/DocumentActions';
import FindAndReplace from './toolbar/FindAndReplace';


const EditorToolbar: React.FC = () => {
    const {
        isDarkMode,
        setIsDarkMode,
        handleLogout: onLogout,
        setCurrentView,
        uiLanguage,
        t,
        isIdle,
    } = useUser();

    const {
        editor,
        title,
        setTitle,
        analysisResults,
        handleSaveDraft: onSaveDraft,
        handleRestoreDraft: onRestoreDraft,
        saveStatus,
        restoreStatus,
        draftExists,
        handleNewArticle: onNewArticle,
        handleClearKeywords: onClearKeywords,
        articleLanguage,
        handleLanguageChange: onLanguageChange,
    } = useEditor();
    
    const {
        clearAllHighlights,
        handleToggleAllKeywordsHighlight: onToggleAllKeywordsHighlight,
        handleRemoveEmptyLines: onRemoveEmptyLines,
        handleFixParagraphs: onFixParagraphs,
        handleClearFormatting: onClearFormatting,
        highlightedItem,
        handleToggleToc: onToggleToc,
        isTocVisible,
        isTooltipAlwaysOn,
        setIsTooltipAlwaysOn,
    } = useInteraction();

    const {
        handleAiRequest: onAiRequest,
        isAiLoading,
        isAiCommandLoading,
        handleAnalyzeHeadings: onAnalyzeHeadings,
    } = useAI();


    const onShowDashboard = () => setCurrentView('dashboard');
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
  
    const isAnyGeminiLoading = isAiCommandLoading || isAiLoading.gemini;
  
    const handleLanguageToggle = () => {
      const newLang = articleLanguage === 'ar' ? 'en' : 'ar';
      onLanguageChange(newLang);
    };

    const handleToggleFindReplace = useCallback(() => {
        setIsFindReplaceVisible(prev => !prev);
    }, []);

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
      <div className="sticky top-0 z-20 flex flex-col gap-1 p-1 bg-[#F2F3F5] dark:bg-[#1F1F1F] border-b border-gray-300 dark:border-[#3C3C3C]">
        <div className="flex items-center gap-4 w-full">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t.titlePlaceholder}
            className="title-input flex-grow py-0.5 px-2 text-base font-bold bg-transparent border-none rounded-md focus:ring-0 focus:outline-none"
            aria-label={t.articleTitle}
          />
          <div className="flex-shrink-0 flex items-center gap-4">
              <button
                onClick={handleLanguageToggle}
                title={t.toggleArticleLanguage}
                className="p-1.5 rounded-md text-gray-600 dark:text-gray-300 bg-transparent hover:bg-gray-200 dark:hover:bg-[#3C3C3C]"
              >
                <div className="flex items-center gap-1.5 px-1">
                  <Languages size={16} />
                  <span className="text-xs font-bold">{articleLanguage.toUpperCase()}</span>
                </div>
              </button>
            <div className="flex items-center gap-2" title={isIdle ? t.idle : t.active}>
                <div className={`w-3 h-3 rounded-full transition-colors duration-500 ${isIdle ? 'bg-yellow-500 animate-pulse' : 'bg-green-500'}`}></div>
                <span className="text-xs text-gray-500 dark:text-gray-400 select-none">{isIdle ? t.idle : t.active}</span>
            </div>

            <div className="text-sm text-gray-600 dark:text-gray-400 bg-gray-200 dark:bg-[#2A2A2A] px-3 py-1 rounded-md">
              {selectionCount.chars > 0 ? (
                <span>{`${selectionCount.words} ${t.words}`} / {`${selectionCount.chars} ${t.characters}`}</span>
              ) : (
                <span>{`${totalWordCount} ${t.words}`} / {`${totalCharCount} ${t.characters}`}</span>
              )}
            </div>
          </div>
        </div>

        {isFindReplaceVisible && (
          <FindAndReplace editor={editor} t={t} clearAllHighlights={clearAllHighlights} onClose={handleToggleFindReplace} />
        )}
      
        <div className="flex flex-wrap items-center gap-1 w-full pt-1.5 mt-1.5 border-t border-gray-300 dark:border-[#3C3C3C]">
            <FormattingActions editor={editor} activeState={activeState} t={t} />

            <div className="ms-auto flex items-center gap-1">
                <UtilityActions 
                    t={t}
                    isAllKeywordsHighlighted={isAllKeywordsHighlighted}
                    isTooltipAlwaysOn={isTooltipAlwaysOn}
                    isTocVisible={isTocVisible}
                    isFindReplaceVisible={isFindReplaceVisible}
                    onClearAllHighlights={clearAllHighlights}
                    onClearKeywords={onClearKeywords}
                    onToggleAllKeywordsHighlight={onToggleAllKeywordsHighlight}
                    onSetIsTooltipAlwaysOn={setIsTooltipAlwaysOn}
                    onToggleToc={onToggleToc}
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
                    onRestoreDraft={onRestoreDraft}
                    onSaveDraft={onSaveDraft}
                    onNewArticle={onNewArticle}
                    onShowDashboard={onShowDashboard}
                    onLogout={onLogout}
                    onSetIsDarkMode={setIsDarkMode}
                />
            </div>
        </div>
      </div>
    );
};

export default EditorToolbar;
