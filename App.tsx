
import React, { Component, useEffect, useState } from 'react';
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
import AdminApp from './components/AdminApp';
import SettingsPage from './components/SettingsPage';
import ModalManager from './components/ModalManager';
import SpotlightSearch from './components/SpotlightSearch';
import { APP_NAVIGATION_EVENT, navigateToAppPath, parseAppRoute, type AppRoute } from './utils/appRoutes';
import { getRemoteArticleById } from './utils/supabaseArticles';
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
import { CONTENT_SUMMARY_STORAGE_KEY } from './constants/engineeringPrompts';
import {
    COMPETITOR_HTML_STORAGE_KEY,
    COMPETITOR_TEXT_STORAGE_KEY,
    COMPETITOR_URLS_STORAGE_KEY,
} from './utils/competitorStorage';
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
type AppErrorBoundaryState = { hasError: boolean; errorMessage?: string };

const RECOVERY_STORAGE_KEYS = [
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
    CONTENT_SUMMARY_STORAGE_KEY,
    COMPETITOR_URLS_STORAGE_KEY,
    COMPETITOR_HTML_STORAGE_KEY,
    COMPETITOR_TEXT_STORAGE_KEY,
];

const RECOVERY_STORAGE_PREFIXES = [
    'bazarvan:gemini-chat:',
    'bazarvan:chatgpt-conversation:',
];

class AppErrorBoundary extends Component<{ children: React.ReactNode }, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
        return { hasError: true, errorMessage: error.message };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('Application rendering failed:', error, errorInfo);
    }

    private reload = () => {
        window.location.reload();
    };

    private removeRecoveryStorageKey = (key: string) => {
        try {
            localStorage.removeItem(key);
        } catch (error) {
            console.error(`Failed to remove recovery field "${key}":`, error);
        }
    };

    private clearDraftAndReload = () => {
        RECOVERY_STORAGE_KEYS.forEach(this.removeRecoveryStorageKey);

        try {
            Object.keys(localStorage).forEach(key => {
                if (RECOVERY_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) {
                    this.removeRecoveryStorageKey(key);
                }
            });
        } catch (error) {
            console.error('Failed to inspect local storage during recovery:', error);
        }

        try {
            sessionStorage.removeItem('currentUser');
            sessionStorage.removeItem('currentView');
        } catch (error) {
            console.error('Failed to clear session during recovery:', error);
        }

        this.reload();
    };

    private clearAllLocalDataAndReload = () => {
        if (!window.confirm('سيتم مسح كل البيانات المحلية على هذا الجهاز، بما في ذلك المقالات المحفوظة ومفاتيح API. هل تريد المتابعة؟')) {
            return;
        }

        try {
            localStorage.clear();
        } catch (error) {
            console.error('Failed to clear localStorage during recovery:', error);
        }
        try {
            sessionStorage.removeItem('currentUser');
            sessionStorage.removeItem('currentView');
        } catch (error) {
            console.error('Failed to clear session during recovery:', error);
        }
        this.reload();
    };

    private logoutAndReload = () => {
        try {
            sessionStorage.removeItem('currentUser');
            sessionStorage.removeItem('currentView');
        } catch (error) {
            console.error('Failed to clear session during recovery:', error);
        }
        this.reload();
    };

    private clearDraftOnlyAndReload = () => {
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
                    {this.state.errorMessage && (
                        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-200" dir="ltr">
                            {this.state.errorMessage}
                        </p>
                    )}
                    <div className="mt-5 flex flex-wrap gap-2">
                        <button onClick={this.reload} className="rounded-md bg-[#d4af37] px-4 py-2 text-sm font-bold text-white hover:bg-[#b8922e]">
                            إعادة المحاولة
                        </button>
                        <button onClick={this.clearDraftAndReload} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-200 dark:hover:bg-[#2A2A2A]">
                            إصلاح بيانات المحرر المحلية
                        </button>
                        <button onClick={this.clearDraftOnlyAndReload} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-200 dark:hover:bg-[#2A2A2A]">
                            إزالة المسودة فقط
                        </button>
                        <button onClick={this.logoutAndReload} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50 dark:border-[#3C3C3C] dark:text-gray-200 dark:hover:bg-[#2A2A2A]">
                            تسجيل الخروج
                        </button>
                        <button onClick={this.clearAllLocalDataAndReload} className="rounded-md border border-red-300 px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-900/20">
                            مسح كل البيانات المحلية
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
                    <div
                        ref={scrollContainerRef}
                        data-bazarvan-editor-panel="true"
                        className="relative flex-grow overflow-y-auto custom-scrollbar border-t border-gray-300 dark:border-[#3C3C3C] bg-white dark:bg-[#1F1F1F]"
                    >
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
                        className="fixed bg-white dark:bg-[#2A2A2A] border border-gray-300 dark:border-[#3C3C3C] text-[#333333] dark:text-gray-200 text-xs rounded-lg py-2 px-3 pointer-events-auto z-[10000] shadow-xl flex flex-col items-start gap-2"
                        style={{ 
                            top: displayTooltip.top, 
                            left: displayTooltip.left, 
                            width: displayTooltip.fixedWidth ? `${displayTooltip.fixedWidth}px` : undefined,
                            maxWidth: 'calc(100vw - 24px)',
                            boxSizing: 'border-box',
                            overflowWrap: 'anywhere',
                            transform: 'translate(-50%, calc(-100% - 16px))' 
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

const useAppRoute = (): AppRoute => {
    const [route, setRoute] = useState<AppRoute>(() => parseAppRoute());

    useEffect(() => {
        const syncRoute = () => setRoute(parseAppRoute());
        window.addEventListener('popstate', syncRoute);
        window.addEventListener(APP_NAVIGATION_EVENT, syncRoute);
        return () => {
            window.removeEventListener('popstate', syncRoute);
            window.removeEventListener(APP_NAVIGATION_EVENT, syncRoute);
        };
    }, []);

    return route;
};

const RouteMessage: React.FC<{
    title: string;
    body?: string;
    actionLabel?: string;
    onAction?: () => void;
}> = ({ title, body, actionLabel, onAction }) => {
    const { isDarkMode } = useUser();

    return (
        <div className={`min-h-screen flex items-center justify-center ${isDarkMode ? 'dark' : ''} bg-[#FAFAFA] p-4 dark:bg-[#181818]`}>
            <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm dark:border-[#3C3C3C] dark:bg-[#2A2A2A]">
                <h1 className="text-2xl font-black text-gray-900 dark:text-gray-100">{title}</h1>
                {body && <p className="mt-3 text-sm font-semibold leading-7 text-gray-500 dark:text-gray-300">{body}</p>}
                {actionLabel && onAction && (
                    <button
                        type="button"
                        onClick={onAction}
                        className="mt-5 rounded-md bg-[#d4af37] px-4 py-2 text-sm font-bold text-white hover:bg-[#b8922e]"
                    >
                        {actionLabel}
                    </button>
                )}
            </div>
        </div>
    );
};

const EditorRoute: React.FC<{ articleId: string | null }> = ({ articleId }) => {
    const { currentUser } = useUser();
    const { editor, activeArticleId, handleLoadArticle } = useEditor();
    const [loadingArticleId, setLoadingArticleId] = useState<string | null>(null);
    const [loadError, setLoadError] = useState('');

    useEffect(() => {
        if (!articleId || !editor || !currentUser) {
            setLoadError('');
            setLoadingArticleId(null);
            return;
        }
        if (activeArticleId === articleId) {
            setLoadError('');
            setLoadingArticleId(null);
            return;
        }

        let cancelled = false;
        setLoadError('');
        setLoadingArticleId(articleId);

        const loadArticle = async () => {
            try {
                const article = await getRemoteArticleById(articleId);
                if (cancelled) return;
                await handleLoadArticle(article.title, article);
            } catch (error) {
                console.error(`Failed to open routed article "${articleId}":`, error);
                if (!cancelled) {
                    setLoadError('لا يمكن فتح هذه المقالة. قد يكون الرابط غير صحيح أو لا تملك صلاحية الوصول.');
                }
            } finally {
                if (!cancelled) {
                    setLoadingArticleId(null);
                }
            }
        };

        void loadArticle();
        return () => {
            cancelled = true;
        };
    }, [activeArticleId, articleId, currentUser, editor, handleLoadArticle]);

    if (loadError) {
        return (
            <RouteMessage
                title="تعذر فتح المقالة"
                body={loadError}
                actionLabel="العودة للوحة التحكم"
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

const AppContent: React.FC = () => {
    const { currentView, isAuthLoading, isDarkMode } = useUser();
    const route = useAppRoute();
    
    // Keep route-like screen switching centralized here.
    const renderView = () => {
        if (isAuthLoading) {
            return (
                <div className={`min-h-screen flex items-center justify-center ${isDarkMode ? 'dark' : ''} bg-[#FAFAFA] dark:bg-[#181818]`}>
                    <div className="rounded-lg border border-gray-200 bg-white px-5 py-4 text-sm font-bold text-[#333333] shadow-sm dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100">
                        جار تحميل الجلسة...
                    </div>
                </div>
            );
        }

        if (currentView === 'login') {
            return <Login />;
        }

        if (route.name === 'notFound') {
            return (
                <RouteMessage
                    title="الصفحة غير موجودة"
                    body="الرابط المطلوب غير مسجل داخل التطبيق."
                    actionLabel="فتح لوحة التحكم"
                    onAction={() => navigateToAppPath('/dashboard')}
                />
            );
        }

        if (route.name === 'admin') {
            return <AdminApp section={route.section} id={route.id} date={route.date} />;
        }

        if (route.name === 'settings') {
            return <SettingsPage section={route.section} />;
        }

        if (route.name === 'editor') {
            return <EditorRoute articleId={route.articleId} />;
        }
        
        if (route.name === 'dashboard' || currentView === 'dashboard') {
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
