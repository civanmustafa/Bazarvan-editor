import React from 'react';
import { translations } from '../translations';
import { ToolbarButton } from './ToolbarItems';
import { Eraser, KeyRound, Trash2, MessageSquare, Bookmark, Split, Shrink, Search, ListRestart } from 'lucide-react';

interface UtilityActionsProps {
    t: typeof translations.ar;
    isAllKeywordsHighlighted: boolean;
    isTooltipAlwaysOn: boolean;
    isTocVisible: boolean;
    isFindReplaceVisible: boolean;
    onClearAllHighlights: () => void;
    onClearKeywords: () => void;
    onToggleAllKeywordsHighlight: () => void;
    onSetIsTooltipAlwaysOn: React.Dispatch<React.SetStateAction<boolean>>;
    onToggleToc: () => void;
    onFixParagraphs: () => void;
    onRemoveEmptyLines: () => void;
    onToggleFindReplace: () => void;
    onClearFormatting: () => void;
}

const UtilityActions: React.FC<UtilityActionsProps> = ({
    t,
    isAllKeywordsHighlighted,
    isTooltipAlwaysOn,
    isTocVisible,
    isFindReplaceVisible,
    onClearAllHighlights,
    onClearKeywords,
    onToggleAllKeywordsHighlight,
    onSetIsTooltipAlwaysOn,
    onToggleToc,
    onFixParagraphs,
    onRemoveEmptyLines,
    onToggleFindReplace,
    onClearFormatting,
}) => {
    return (
        <>
            <ToolbarButton onClick={onClearAllHighlights} title={t.removeAllHighlights}><Eraser size={16} /></ToolbarButton>
            <ToolbarButton onClick={onClearKeywords} title={t.clearKeywords}><Trash2 size={16} /></ToolbarButton>
            <ToolbarButton onClick={onToggleAllKeywordsHighlight} title={t.highlightAllKeywords} isActive={isAllKeywordsHighlighted}><KeyRound size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => onSetIsTooltipAlwaysOn(prev => !prev)} title={t.toggleTooltips} isActive={isTooltipAlwaysOn}><MessageSquare size={16} /></ToolbarButton>
            <ToolbarButton onClick={onToggleToc} title={isTocVisible ? t.hideToc : t.createToc} isActive={isTocVisible}><Bookmark size={16} /></ToolbarButton>
            <ToolbarButton onClick={onFixParagraphs} title={t.fixParagraphs}><Split size={16} /></ToolbarButton>
            <ToolbarButton onClick={onRemoveEmptyLines} title={t.removeEmptyLines}><Shrink size={16} /></ToolbarButton>
            <ToolbarButton onClick={onToggleFindReplace} title={t.findAndReplace} isActive={isFindReplaceVisible}><Search size={16} /></ToolbarButton>
            <ToolbarButton onClick={onClearFormatting} title={t.clearFormatting}><ListRestart size={16} /></ToolbarButton>
        </>
    );
};

export default UtilityActions;
