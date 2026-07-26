import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Editor } from '@tiptap/core';
import { translations } from '../translations';
import { ToolbarButton } from './ToolbarItems';
import { ChevronUp, ChevronDown } from 'lucide-react';
import {
    findReplaceMatches,
    type FindReplaceTextBlock,
} from '../../utils/findAndReplace';

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

        const blocks: FindReplaceTextBlock[] = [];
        editor.state.doc.descendants((node, pos) => {
            if (!node.isTextblock) return true;
            const segments: FindReplaceTextBlock['segments'] = [];
            node.descendants((child, childPos) => {
                const absoluteFrom = pos + 1 + childPos;
                if (child.isText && child.text) {
                    segments.push({ text: child.text, from: absoluteFrom });
                } else if (child.type.name === 'hardBreak') {
                    segments.push({ text: ' ', from: absoluteFrom });
                }
            });
            if (segments.length > 0) blocks.push({ segments });
            return false;
        });
        const newMatches = findReplaceMatches(blocks, value);

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
            if (replaceValue) {
                transaction.replaceWith(match.from, match.to, editor.schema.text(replaceValue));
            } else {
                transaction.delete(match.from, match.to);
            }
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

    useEffect(() => {
        const handleTransaction = ({ transaction }: { transaction: any }) => {
            if (
                !transaction.docChanged
                || transaction.getMeta('preventUpdate')
                || !findValue
            ) return;
            window.setTimeout(() => findAndHighlight(findValue), 0);
        };
        editor.on('transaction', handleTransaction);
        return () => {
            editor.off('transaction', handleTransaction);
        };
    }, [editor, findValue, findAndHighlight]);

    return (
        <div className="flex items-center gap-2 p-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-md">
            <input ref={findInputRef} type="text" placeholder={`${t.find}...`} value={findValue} onChange={e => { setFindValue(e.target.value); findAndHighlight(e.target.value); }} className="p-1 w-32 text-xs bg-white dark:bg-[#1F1F1F] rounded-md border-gray-300 dark:border-[#3C3C3C] focus:ring-0 focus:border-[#d4af37]" />
            <span className="text-xs text-gray-500 dark:text-gray-400">{matches.length > 0 ? `${currentMatchIndex + 1}/${matches.length}` : '0/0'}</span>
            <ToolbarButton onClick={goToPrev} title={t.previous} disabled={matches.length < 2}><ChevronUp size={16} /></ToolbarButton>
            <ToolbarButton onClick={goToNext} title={t.next} disabled={matches.length < 2}><ChevronDown size={16} /></ToolbarButton>
            <input type="text" placeholder={`${t.replaceWith}...`} value={replaceValue} onChange={e => setReplaceValue(e.target.value)} className="p-1 w-32 text-xs bg-white dark:bg-[#1F1F1F] rounded-md border-gray-300 dark:border-[#3C3C3C] focus:ring-0 focus:border-[#d4af37]" />
            <button onClick={handleReplace} disabled={matches.length === 0} className="px-2 py-1 text-xs font-semibold text-white bg-[#d4af37] rounded-md hover:bg-[#b8922e] disabled:bg-gray-400 dark:disabled:bg-gray-600">{t.replace}</button>
            <button onClick={handleReplaceAll} disabled={matches.length === 0} className="px-2 py-1 text-xs font-semibold text-white bg-[#d4af37] rounded-md hover:bg-[#b8922e] disabled:bg-gray-400 dark:disabled:bg-gray-600">{t.replaceAll}</button>
        </div>
    );
};

export default FindAndReplace;
