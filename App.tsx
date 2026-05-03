
import React from 'react';
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
import './styles/global.css';
import './styles/editor.css';
import './styles/components.css';

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
                <div className="relative basis-[62.6%] flex flex-col h-full min-w-0">
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
        <ModalManager />
      </>
    );
}

const App: React.FC = () => {
  return (
    <AppProviders>
      <AppContent />
    </AppProviders>
  );
};

export default App;
