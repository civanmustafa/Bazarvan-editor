import React from 'react';
import { translations } from '../translations';
import { ToolbarButton, Separator } from './ToolbarItems';
import { History, Save, PlusSquare, LayoutDashboard, LogOut, Sun, Moon } from 'lucide-react';

interface DocumentActionsProps {
    isDarkMode: boolean;
    t: typeof translations.ar;
    restoreStatus: 'idle' | 'restored';
    draftExists: boolean;
    saveStatus: 'idle' | 'saving' | 'saved' | 'error';
    saveError?: string;
    onRestoreDraft: () => void | Promise<void>;
    onSaveDraft: () => void | Promise<unknown>;
    onNewArticle: () => void | Promise<void>;
    onShowDashboard: () => void | Promise<void>;
    onLogout: () => void | Promise<void>;
    onSetIsDarkMode: React.Dispatch<React.SetStateAction<boolean>>;
}

const DocumentActions: React.FC<DocumentActionsProps> = ({
    isDarkMode,
    t,
    restoreStatus,
    draftExists,
    saveStatus,
    saveError,
    onRestoreDraft,
    onSaveDraft,
    onNewArticle,
    onShowDashboard,
    onLogout,
    onSetIsDarkMode,
}) => {
    return (
        <>
            <ToolbarButton onClick={onRestoreDraft} title={restoreStatus === 'restored' ? t.restored : t.restore} disabled={!draftExists || restoreStatus === 'restored'}>
                <History size={16} className={restoreStatus === 'restored' ? 'text-[#d4af37]' : ''} />
            </ToolbarButton>
            <ToolbarButton
                onClick={() => { void onSaveDraft(); }}
                title={saveStatus === 'saved' ? t.saved : saveStatus === 'saving' ? 'جار الحفظ...' : saveStatus === 'error' ? (saveError || 'تعذر الحفظ. اضغط للمحاولة مرة أخرى.') : t.saveDraft}
                disabled={saveStatus === 'saving'}
            >
                <Save size={16} className={saveStatus === 'saved' ? 'text-green-500' : saveStatus === 'error' ? 'text-red-500' : saveStatus === 'saving' ? 'animate-pulse text-[#d4af37]' : ''} />
            </ToolbarButton>
            <ToolbarButton onClick={onNewArticle} title={t.newArticle}><PlusSquare size={16} /></ToolbarButton>
            <ToolbarButton onClick={onShowDashboard} title={t.dashboard}><LayoutDashboard size={16} /></ToolbarButton>
            <Separator />
            <ToolbarButton onClick={onLogout} title={t.logout}><LogOut size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => onSetIsDarkMode(!isDarkMode)} title={t.toggleTheme}>{isDarkMode ? <Sun size={16} /> : <Moon size={16} />}</ToolbarButton>
        </>
    );
};

export default DocumentActions;
