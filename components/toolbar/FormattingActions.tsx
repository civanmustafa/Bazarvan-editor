import React from 'react';
import { Editor } from '@tiptap/core';
import { translations } from '../translations';
import { ToolbarButton, Separator } from './ToolbarItems';
import { List, ListOrdered, Table, Table2, Trash2, Combine, SplitSquareVertical, ChevronLeftSquare, ChevronRightSquare, ChevronUpSquare, ChevronDownSquare, Bold, Italic, Pilcrow, Heading2, Heading3, Heading4, Undo, Redo, AlignLeft, AlignCenter, AlignRight, AlignJustify, AlignHorizontalJustifyStart, AlignHorizontalJustifyEnd } from 'lucide-react';

interface FormattingActionsProps {
    editor: Editor;
    activeState: any;
    t: typeof translations.ar;
}

const FormattingActions: React.FC<FormattingActionsProps> = ({ editor, activeState, t }) => {
    return (
        <>
            <ToolbarButton onClick={() => editor.chain().focus().setParagraph().run()} title={t.paragraph} isActive={activeState.isParagraph}><Pilcrow size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title={t.heading2} isActive={activeState.isH2}><Heading2 size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title={t.heading3} isActive={activeState.isH3}><Heading3 size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()} title={t.heading4} isActive={activeState.isH4}><Heading4 size={16} /></ToolbarButton>
            <Separator />

            <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} title={t.bulletList} isActive={activeState.isBulletList}><List size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} title={t.orderedList} isActive={activeState.isOrderedList}><ListOrdered size={16} /></ToolbarButton>
            <Separator />

            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('right').run()} title={t.alignRight} isActive={activeState.isAlignRight}><AlignRight size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('center').run()} title={t.alignCenter} isActive={activeState.isAlignCenter}><AlignCenter size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('left').run()} title={t.alignLeft} isActive={activeState.isAlignLeft}><AlignLeft size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('justify').run()} title={t.justify} isActive={activeState.isAlignJustify}><AlignJustify size={16} /></ToolbarButton>
            <Separator />

            <ToolbarButton onClick={() => (editor.chain() as any).focus().setTextDirection('rtl').run()} title={t.rtl} isActive={activeState.isRtl}><AlignHorizontalJustifyEnd size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => (editor.chain() as any).focus().setTextDirection('ltr').run()} title={t.ltr} isActive={activeState.isLtr}><AlignHorizontalJustifyStart size={16} /></ToolbarButton>
            <Separator />

            <ToolbarButton onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title={t.insertTable}><Table size={16} /></ToolbarButton>
            {activeState.isTableActive && (
                <>
                    <ToolbarButton onClick={() => editor.chain().focus().addColumnBefore().run()} title={t.addColumnBefore}><ChevronLeftSquare size={16} /></ToolbarButton>
                    <ToolbarButton onClick={() => editor.chain().focus().addColumnAfter().run()} title={t.addColumnAfter}><ChevronRightSquare size={16} /></ToolbarButton>
                    <ToolbarButton onClick={() => editor.chain().focus().addRowBefore().run()} title={t.addRowBefore}><ChevronUpSquare size={16} /></ToolbarButton>
                    <ToolbarButton onClick={() => editor.chain().focus().addRowAfter().run()} title={t.addRowAfter}><ChevronDownSquare size={16} /></ToolbarButton>
                    <ToolbarButton onClick={() => editor.chain().focus().deleteColumn().run()} title={t.deleteColumn}><SplitSquareVertical size={16} /></ToolbarButton>
                    <ToolbarButton onClick={() => editor.chain().focus().deleteRow().run()} title={t.deleteRow}><Combine size={16} /></ToolbarButton>
                    <ToolbarButton onClick={() => editor.chain().focus().mergeOrSplit().run()} title={t.mergeSplitCells}><Table2 size={16} /></ToolbarButton>
                    <ToolbarButton onClick={() => editor.chain().focus().deleteTable().run()} title={t.deleteTable}><Trash2 size={16} /></ToolbarButton>
                </>
            )}
            <Separator />

            <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} title={t.bold} isActive={activeState.isBold}><Bold size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} title={t.italic} isActive={activeState.isItalic}><Italic size={16} /></ToolbarButton>
            <Separator />

            <ToolbarButton onClick={() => editor.chain().focus().undo().run()} title={t.undo} disabled={!activeState.canUndo}><Undo size={16} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().redo().run()} title={t.redo} disabled={!activeState.canRedo}><Redo size={16} /></ToolbarButton>
        </>
    );
};

export default FormattingActions;
