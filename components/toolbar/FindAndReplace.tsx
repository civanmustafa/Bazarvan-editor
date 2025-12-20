import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Editor } from '@tiptap/core';
import { translations } from '../translations';
import { ToolbarButton } from './ToolbarItems';
import { ChevronUp, ChevronDown } from 'lucide-react';

interface FindAndReplaceProps {
    editor: Editor;
    t: typeof translations.ar;
    clearAllHighlights: () => void;
    onClose: () => void;
}

const FindAndReplace: React.FC<FindAndReplaceProps> = ({ editor, t, clearAllHighlights, onClose }) => {
    const [findValue, setFindValue] = useState('');
    const [replaceValue, setReplaceValue] = useState('');
    const [matches, setMatches] = useState<{ from: number; to: number }[]>([]);
    const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);
    const findInputRef = useRef<HTMLInputElement>(null);

    const highlightMatches = useCallback((currentMatches: { from: number; to: number }[], currentIndex: number) => {
        if (editor.isDestroyed) return;
        const { tr } = editor.state;
        const highlightMarkType = editor.schema.marks.highlight;

        tr.removeMark(0, editor.state.doc.content.size, highlightMarkType);

        currentMatches.forEach((match, index) => {
            const color = index === currentIndex ? '#6ee7b7' : '#fef08a';
            const highlightMark = (highlightMarkType as any).create({ color, highlightStyle: 'background' });
            tr.addMark(match.from, match.to, highlightMark);
        });

        if (tr.steps.length > 0) {
            editor.view.dispatch(tr.setMeta('preventUpdate', true));
        }
    }, [editor]);

    const findAndHighlight = useCallback((value: string) => {
        if (editor.isDestroyed || !value) {
            setMatches([]);
            setCurrentMatchIndex(-1);
            const { tr } = editor.state;
            tr.removeMark(0, editor.state.doc.content.size, editor.schema.marks.highlight);
            if (tr.steps.length > 0) editor.view.dispatch(tr.setMeta('preventUpdate', true));
            return;
        }

        const newMatches: { from: number; to: number }[] = [];
        editor.state.doc.descendants((node, pos) => {
            if (node.isText && node.text) {
                let index = -1;
                while ((index = node.text.indexOf(value, index + 1)) !== -1) {
                    newMatches.push({ from: pos + index, to: pos + index + value.length });
                }
            }
        });

        setMatches(newMatches);
        setCurrentMatchIndex(newMatches.length > 0 ? 0 : -1);
        highlightMatches(newMatches, 0);
    }, [editor, highlightMatches]);

    const goToMatch = useCallback((index: number) => {
        if (!matches.length) return;
        setCurrentMatchIndex(index);
        const match = matches[index];
        editor.chain().focus().setTextSelection(match).scrollIntoView().run();
        highlightMatches(matches, index);
    }, [editor, matches, highlightMatches]);

    const goToNext = useCallback(() => {
        if (!matches.length) return;
        goToMatch((currentMatchIndex + 1) % matches.length);
    }, [matches, currentMatchIndex, goToMatch]);

    const goToPrev = useCallback(() => {
        if (!matches.length) return;
        goToMatch((currentMatchIndex - 1 + matches.length) % matches.length);
    }, [matches, currentMatchIndex, goToMatch]);

    const handleReplace = useCallback(() => {
        if (matches.length === 0 || currentMatchIndex === -1) return;
        const match = matches[currentMatchIndex];
        editor.chain().focus().setTextSelection(match).deleteSelection().insertContent(replaceValue).run();
        setTimeout(() => findAndHighlight(findValue), 50);
    }, [editor, matches, currentMatchIndex, replaceValue, findValue, findAndHighlight]);

    const handleReplaceAll = useCallback(() => {
        if (matches.length === 0 || !findValue) return;
        const transaction = editor.state.tr;
        [...matches].reverse().forEach(match => {
            transaction.replaceWith(match.from, match.to, editor.schema.text(replaceValue));
        });
        editor.view.dispatch(transaction);
        onClose();
    }, [editor, matches, findValue, replaceValue, onClose]);

    useEffect(() => {
        clearAllHighlights();
        setTimeout(() => findInputRef.current?.focus(), 100);

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [onClose, clearAllHighlights]);

    return (
        <div className="flex items-center gap-2 p-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-md">
            <input ref={findInputRef} type="text" placeholder={`${t.find}...`} value={findValue} onChange={e => { setFindValue(e.target.value); findAndHighlight(e.target.value); }} className="p-1 w-32 text-xs bg-white dark:bg-[#1F1F1F] rounded-md border-gray-300 dark:border-[#3C3C3C] focus:ring-0 focus:border-[#00778e]" />
            <span className="text-xs text-gray-500 dark:text-gray-400">{matches.length > 0 ? `${currentMatchIndex + 1}/${matches.length}` : '0/0'}</span>
            <ToolbarButton onClick={goToPrev} title={t.previous} disabled={matches.length < 2}><ChevronUp size={16} /></ToolbarButton>
            <ToolbarButton onClick={goToNext} title={t.next} disabled={matches.length < 2}><ChevronDown size={16} /></ToolbarButton>
            <input type="text" placeholder={`${t.replaceWith}...`} value={replaceValue} onChange={e => setReplaceValue(e.target.value)} className="p-1 w-32 text-xs bg-white dark:bg-[#1F1F1F] rounded-md border-gray-300 dark:border-[#3C3C3C] focus:ring-0 focus:border-[#00778e]" />
            <button onClick={handleReplace} disabled={matches.length === 0} className="px-2 py-1 text-xs font-semibold text-white bg-[#00778e] rounded-md hover:bg-[#005f73] disabled:bg-gray-400 dark:disabled:bg-gray-600">{t.replace}</button>
            <button onClick={handleReplaceAll} disabled={matches.length === 0} className="px-2 py-1 text-xs font-semibold text-white bg-[#00778e] rounded-md hover:bg-[#005f73] disabled:bg-gray-400 dark:disabled:bg-gray-600">{t.replaceAll}</button>
        </div>
    );
};

export default FindAndReplace;
