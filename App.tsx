
import React, { Component } from 'react';
import { EditorContent } from '@tiptap/react';
import { ArrowUp, Sparkles } from 'lucide-react';

import { useUser } from './contexts/UserContext';
import { useEditor } from './contexts/EditorContext';
import { useInteraction } from './contexts/InteractionContext';
import { useAI } from './contexts/AIContext';
import { useModal } from './contexts/ModalContext';
import { AppProviders } from './contexts/Providers';
import LeftSidebar from './components/LeftSidebar';
import RightSidebar from './components/RightSidebar';
import EditorToolbar from './components/EditorToolbar';
import SelectionToolbar from './components/SelectionToolbar';
import TipsCarousel from './components/TipsCarousel';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import ModalManager from './components/ModalManager';
import SpotlightSearch from './components/SpotlightSearch';
import {
    AUTO_DRAFT_GOAL_CONTEXT_KEY,
    AUTO_DRAFT_KEY,
    AUTO_DRAFT_KEYWORDS_KEY,
    AUTO_DRAFT_LANGUAGE_KEY,
    AUTO_DRAFT_TITLE_KEY,
    MANUAL_DRAFT_GOAL_CONTEXT_KEY,
    MANUAL_DRAFT_KEY,
    MANUAL_DRAFT_KEYWORDS_KEY,
    MANUAL_DRAFT_LANGUAGE_KEY,
    MANUAL_DRAFT_TITLE_KEY,
} from './constants';
import './styles/global.css';
import './styles/editor.css';
import './styles/components.css';

/*
 * App shell map:
 * - AppProviders wires all global state providers.
 * - AppContent decides which screen is visible: login, dashboard, or editor.
 * - EditorView owns the three-column editor layout and shared floating UI.
 *
 * When adding a new full page, edit AppContent.
 * When changing editor layout, edit EditorView and the sidebar/toolbar components.
 */
type AppErrorBoundaryState = { hasError: boolean };

class AppErrorBoundary extends Component<{ children: React.ReactNode }, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(): AppErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('Application rendering failed:', error, errorInfo);
    }

    private reload = () => {
        window.location.reload();
    };

    private clearDraftAndReload = () => {
        [
            AUTO_DRAFT_KEY,
            AUTO_DRAFT_TITLE_KEY,
            AUTO_DRAFT_KEYWORDS_KEY,
            AUTO_DRAFT_LANGUAGE_KEY,
            AUTO_DRAFT_GOAL_CONTEXT_KEY,
            MANUAL_DRAFT_KEY,
            MANUAL_DRAFT_TITLE_KEY,
            MANUAL_DRAFT_KEYWORDS_KEY,
            MANUAL_DRAFT_LANGUAGE_KEY,
            MANUAL_DRAFT_GOAL_CONTEXT_KEY,
        ].forEach(key => {
            try {
                localStorage.removeItem(key);
            } catch (error) {
                console.error(`Failed to remove recovery field "${key}":`, error);
            }
        });
        this.reload();
    };

    private logoutAndReload = () => {
        try {
            sessionStorage.removeItem('currentUser');
        } catch (error) {
            console.error('Failed to clear session during recovery:', error);
        }
        this.reload();
    };

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        return (
            <div className="min-h-screen flex items-center justify-center bg-[#FAFAFA] dark:bg-[#181818] p-4" dir="rtl">
                <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-6 text-right shadow-lg dark:border-[#3C3C3C] dark:bg-[#1F1F1F]">
                    <h1 className="text-xl font-bold text-[#333333] dark:text-gray-100">تعذر فتح اللوحة</h1>
                    <p className="mt-3 text-sm leading-7 text-gray-600 dark:text-gray-300">
                        حدث خطأ أثناء تحميل بيانات محفوظة على هذا الجهاز. يمكنك إعادة المحاولة، أو إزالة بيانات المسودة المحلية فقط دون حذف المقالات المحفوظة.
                    </p>
                    <div className="mt-5 flex flex-wrap gap-2">
                        <button onClick={this.reload} className="rounded-md bg-[#d4af37] px-4 py-2 text-sm font-bold text-white hover:bg-[#b8922e]">
                            إعادة المحاولة
                        </button>
                        <button onClick={this.clearDraftAndReload} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-200 dark:hover:bg-[#2A2A2A]">
                            إزالة المسودة المحلية
                        </button>
                        <button onClick={this.logoutAndReload} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-200 dark:hover:bg-[#2A2A2A]">
                            تسجيل الخروج
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}

const EditorView: React.FC = () => {
    const { isDarkMode, t } = useUser();
    const { editor, scrollContainerRef } = useEditor();
    const {
        handleScrollToTop,
        tooltip,
        tooltipRef,
        pinnedTooltip,
    } = useInteraction();
    const {
        isHeadingsAnalysisMinimized,
        setIsHeadingsAnalysisMinimized,
        headingsAnalysis,
    } = useAI();
    const { openModal } = useModal();

    const displayTooltip = pinnedTooltip || tooltip;
    
    return (
        <div className={`h-screen overflow-hidden ${isDarkMode ? 'dark' : ''}`}>
            <main className="flex h-full p-2 gap-2 bg-[#FAFAFA] dark:bg-[#181818]">
                <LeftSidebar />
                <div className="relative basis-[60.73%] flex flex-col h-full min-w-0">
                    <TipsCarousel />
                    <EditorToolbar />
                    <div ref={scrollContainerRef} className="relative flex-grow overflow-y-auto custom-scrollbar border-t border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F]">
                        <EditorContent editor={editor} />
                        {editor && (
                          <SelectionToolbar />
                        )}
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
                        className="fixed bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] text-[#333333] dark:text-gray-200 text-xs rounded-lg py-2 px-3 pointer-events-auto z-50 shadow-xl flex flex-col items-start gap-2"
                        style={{ 
                            top: displayTooltip.top, 
                            left: displayTooltip.left, 
                            transform: 'translateY(calc(-100% - 16px))' 
                        }}
                        dangerouslySetInnerHTML={{ __html: displayTooltip.content }}
                    >
                    </div>
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


const AppContent: React.FC = () => {
    const { currentView } = useUser();
    
    // Keep route-like screen switching centralized here.
    const renderView = () => {
        if (currentView === 'login') {
            return <Login />;
        }
        
        if (currentView === 'dashboard') {
            return <Dashboard />;
        }
        
        return <EditorView />;
    };

    return (
      <>
        {renderView()}
        {currentView !== 'login' && <ModalManager />}
      </>
    );
}

const App: React.FC = () => {
  return (
    <AppErrorBoundary>
      <AppProviders>
        <AppContent />
      </AppProviders>
    </AppErrorBoundary>
  );
};

export default App;
