import React from 'react';
import { translations } from '../translations';
import { ToolbarButton, Separator } from './ToolbarItems';
import { History, Save, PlusSquare, LayoutDashboard, LogOut, Sun, Moon } from 'lucide-react';

interface DocumentActionsProps {
    isDarkMode: boolean;
    t: typeof translations.ar;
    restoreStatus: 'idle' | 'restored';
    draftExists: boolean;
    saveStatus: 'idle' | 'saved';
    onRestoreDraft: () => void;
    onSaveDraft: () => void;
    onNewArticle: () => void;
    onShowDashboard: () => void;
    onLogout: () => void;
    onSetIsDarkMode: React.Dispatch<React.SetStateAction<boolean>>;
}

const DocumentActions: React.FC<DocumentActionsProps> = ({
    isDarkMode,
    t,
    restoreStatus,
    draftExists,
    saveStatus,
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
                <History size={16} className={restoreStatus === 'restored' ? 'text-blue-500' : ''} />
            </ToolbarButton>
            <ToolbarButton onClick={onSaveDraft} title={saveStatus === 'saved' ? t.saved : t.saveDraft} disabled={saveStatus === 'saved'}>
                <Save size={16} className={saveStatus === 'saved' ? 'text-green-500' : ''} />
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
