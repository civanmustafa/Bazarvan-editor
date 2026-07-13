import React, { useEffect, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import { ArrowUp, Sparkles } from 'lucide-react';

import { useAISelector } from '../contexts/AIContext';
import { useEditorSelector } from '../contexts/EditorContext';
import { EditorProviders } from '../contexts/EditorProviders';
import { useInteractionSelector } from '../contexts/InteractionContext';
import { useModal } from '../contexts/ModalContext';
import { useUser } from '../contexts/UserContext';
import {
  consumeNewEditorArticleRequest,
  navigateToAppPath,
} from '../utils/appRoutes';
import { getCachedRemoteArticleById, getRemoteArticleById } from '../utils/supabaseArticles';
import EditorToolbar from './EditorToolbar';
import LeftSidebar from './LeftSidebar';
import ModalManager from './ModalManager';
import RightSidebar from './RightSidebar';
import SelectionToolbar from './SelectionToolbar';
import SpotlightSearch from './SpotlightSearch';
import TipsCarousel from './TipsCarousel';
import '../styles/editor.css';

const EditorView: React.FC = () => {
  const { isDarkMode, t } = useUser();
  const editor = useEditorSelector(context => context.editor);
  const scrollContainerRef = useEditorSelector(context => context.scrollContainerRef);
  const handleScrollToTop = useInteractionSelector(context => context.handleScrollToTop);
  const tooltip = useInteractionSelector(context => context.tooltip);
  const tooltipRef = useInteractionSelector(context => context.tooltipRef);
  const pinnedTooltip = useInteractionSelector(context => context.pinnedTooltip);
  const isHeadingsAnalysisMinimized = useAISelector(context => context.isHeadingsAnalysisMinimized);
  const setIsHeadingsAnalysisMinimized = useAISelector(context => context.setIsHeadingsAnalysisMinimized);
  const headingsAnalysis = useAISelector(context => context.headingsAnalysis);
  const { openModal } = useModal();

  const displayTooltip = pinnedTooltip || tooltip;

  return (
    <div className={`h-screen overflow-hidden ${isDarkMode ? 'dark' : ''}`}>
      <main className="flex h-full p-2 gap-2 bg-[#FAFAFA] dark:bg-[#181818]">
        <LeftSidebar />
        <div className="relative basis-[60.73%] flex flex-col h-full min-w-0">
          <TipsCarousel />
          <EditorToolbar />
          <div
            ref={scrollContainerRef}
            data-bazarvan-editor-panel="true"
            className="relative flex-grow overflow-y-auto custom-scrollbar border-t border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F]"
          >
            <EditorContent editor={editor} />
            {editor && <SelectionToolbar />}
          </div>
          <button
            onClick={handleScrollToTop}
            className="absolute bottom-4 end-4 z-40 p-2 bg-[#d4af37] text-white rounded-full shadow-lg hover:bg-[#b8922e] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#d4af37] dark:focus:ring-offset-gray-800 transition-opacity duration-300"
            title={t.scrollToTop}
            aria-label={t.scrollToTop}
          >
            <ArrowUp size={16} />
          </button>
        </div>

        <RightSidebar />
        {displayTooltip && (
          <div
            ref={tooltipRef}
            className="fixed bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] text-[#333333] dark:text-gray-200 text-xs rounded-lg py-2 px-3 pointer-events-auto z-[10000] shadow-xl flex flex-col items-start gap-2"
            style={{
              top: displayTooltip.top,
              left: displayTooltip.left,
              width: displayTooltip.fixedWidth ? `${displayTooltip.fixedWidth}px` : undefined,
              maxWidth: 'calc(100vw - 24px)',
              boxSizing: 'border-box',
              overflowWrap: 'anywhere',
              transform: 'translate(-50%, calc(-100% - 16px))',
            }}
            dangerouslySetInnerHTML={{ __html: displayTooltip.content }}
          />
        )}

        {isHeadingsAnalysisMinimized && (
          <div
            className="fixed bottom-4 start-4 z-50"
            onClick={() => {
              setIsHeadingsAnalysisMinimized(false);
              openModal('headingsAnalysis');
            }}
          >
            <button className="flex items-center gap-2 px-4 py-2 bg-[#d4af37] text-white rounded-full shadow-lg hover:bg-[#b8922e] focus:outline-none focus:ring-2 ring-offset-2 ring-[#d4af37] dark:ring-offset-gray-800">
              <Sparkles size={16} />
              <span>{`${t.headingsAnalysis} (${headingsAnalysis?.length || 0})`}</span>
            </button>
          </div>
        )}

        <SpotlightSearch />
      </main>
    </div>
  );
};

const EditorRouteMessage: React.FC<{
  title: string;
  body: string;
  onAction: () => void;
}> = ({ title, body, onAction }) => {
  const { isDarkMode } = useUser();
  return (
    <div className={`min-h-screen flex items-center justify-center ${isDarkMode ? 'dark' : ''} bg-[#FAFAFA] p-4 dark:bg-[#181818]`}>
      <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
        <h1 className="text-2xl font-black text-gray-900 dark:text-gray-100">{title}</h1>
        <p className="mt-3 text-sm font-semibold leading-7 text-gray-500 dark:text-gray-300">{body}</p>
        <button
          type="button"
          onClick={onAction}
          className="mt-5 rounded-md bg-[#d4af37] px-4 py-2 text-sm font-bold text-white hover:bg-[#b8922e]"
        >
          العودة للوحة التحكم
        </button>
      </div>
    </div>
  );
};

const EditorRouteContent: React.FC<{ articleId: string | null }> = ({ articleId }) => {
  const { currentUser } = useUser();
  const editor = useEditorSelector(context => context.editor);
  const activeArticleId = useEditorSelector(context => context.activeArticleId);
  const handleLoadArticle = useEditorSelector(context => context.handleLoadArticle);
  const handleNewArticle = useEditorSelector(context => context.handleNewArticle);
  const [loadingArticleId, setLoadingArticleId] = useState<string | null>(null);
  const [articleLoadError, setArticleLoadError] = useState('');
  const [newArticleError, setNewArticleError] = useState('');
  const newArticleRequestHandledRef = useRef(false);

  useEffect(() => {
    if (articleId || !editor || newArticleRequestHandledRef.current) return;
    const requestedLanguage = consumeNewEditorArticleRequest();
    if (!requestedLanguage) return;
    newArticleRequestHandledRef.current = true;
    void handleNewArticle(requestedLanguage).catch(error => {
      console.error('Failed to prepare a new routed article:', error);
      setNewArticleError('تعذر تجهيز مقالة جديدة. أعد المحاولة من لوحة التحكم.');
    });
  }, [articleId, editor, handleNewArticle]);

  useEffect(() => {
    if (!articleId || !editor || !currentUser) {
      setArticleLoadError('');
      setLoadingArticleId(null);
      return;
    }
    setNewArticleError('');
    if (activeArticleId === articleId) {
      setArticleLoadError('');
      setLoadingArticleId(null);
      return;
    }

    let cancelled = false;
    setArticleLoadError('');
    setLoadingArticleId(articleId);

    const loadArticle = async () => {
      let openedFromCache = false;
      try {
        const cachedArticle = await getCachedRemoteArticleById(articleId).catch(error => {
          console.warn(`Could not read cached routed article "${articleId}":`, error);
          return null;
        });
        if (cachedArticle && !cancelled) {
          openedFromCache = true;
          await handleLoadArticle(cachedArticle.title, cachedArticle);
        }

        const article = await getRemoteArticleById(articleId);
        if (cancelled) return;
        if (!openedFromCache) {
          await handleLoadArticle(article.title, article);
        }
      } catch (error) {
        console.error(`Failed to open routed article "${articleId}":`, error);
        if (!cancelled && !openedFromCache) {
          setArticleLoadError('لا يمكن فتح هذه المقالة. قد يكون الرابط غير صحيح أو لا تملك صلاحية الوصول.');
        }
      } finally {
        if (!cancelled) setLoadingArticleId(null);
      }
    };

    void loadArticle();
    return () => {
      cancelled = true;
    };
  }, [activeArticleId, articleId, currentUser, editor, handleLoadArticle]);

  const loadError = newArticleError || articleLoadError;
  if (loadError) {
    return (
      <EditorRouteMessage
        title="تعذر فتح المقالة"
        body={loadError}
        onAction={() => navigateToAppPath('/dashboard')}
      />
    );
  }

  return (
    <>
      <EditorView />
      {loadingArticleId && (
        <div className="fixed left-1/2 top-4 z-[10000] -translate-x-1/2 rounded-md border border-[#d4af37]/30 bg-white px-4 py-2 text-sm font-bold text-[#8a6f1d] shadow-lg dark:bg-[#2A2A2A] dark:text-[#f2d675]">
          جار تحميل المقالة من Supabase...
        </div>
      )}
    </>
  );
};

const EditorApp: React.FC<{ articleId: string | null }> = ({ articleId }) => (
  <EditorProviders>
    <EditorRouteContent articleId={articleId} />
    <ModalManager />
  </EditorProviders>
);

export default EditorApp;
