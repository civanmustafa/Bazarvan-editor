import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PenLine, Wand2, Zap, Expand, BookText, ListChecks, HelpCircle, Loader2, MessageSquarePlus, Send, X, Heading1, Combine } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useAI } from '../contexts/AIContext';
import { AI_PROMPTS } from '../constants/aiPrompts';
import { IconTooltip } from './toolbar/ToolbarItems';

const MANUAL_COMMAND_ID = 'manual_command';
const MANUAL_COMMAND_PREFIX = 'أنت خبير محتوى SEO/AEO/GEO/LLM SEO.';

const SelectionToolbar: React.FC = () => {
  const { uiLanguage } = useUser();
  const { editor, scrollContainerRef } = useEditor();
  const { handleAiRequest: onAiRequest, isAiCommandLoading } = useAI();
  
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [localLoadingAction, setLocalLoadingAction] = useState<string | null>(null);
  const [isManualCommandOpen, setIsManualCommandOpen] = useState(false);
  const [manualCommand, setManualCommand] = useState('');
  const [manualSelectionRange, setManualSelectionRange] = useState<{ from: number; to: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const manualTextareaRef = useRef<HTMLTextAreaElement>(null);
  const t = translations[uiLanguage];

  const SELECTION_COMMANDS = [
    { id: 'rephrase', label: t.aiMenu.rephrase, icon: PenLine, prompt: AI_PROMPTS.REPHRASE },
    { id: 'improve', label: t.aiMenu.improveWording, icon: Wand2, prompt: AI_PROMPTS.IMPROVE_WORDING },
    { id: 'simplify', label: t.aiMenu.simplify, icon: Zap, prompt: AI_PROMPTS.SIMPLIFY_TEXT },
    { id: 'expand', label: t.aiMenu.expand, icon: Expand, prompt: AI_PROMPTS.EXPAND },
    { id: 'summarize', label: t.aiMenu.summarize, icon: BookText, prompt: AI_PROMPTS.SUMMARIZE },
    { id: 'suggest_title', label: t.aiMenu.suggestTitle, icon: Heading1, prompt: AI_PROMPTS.SUGGEST_TITLE },
    { id: 'merge', label: t.aiMenu.merge, icon: Combine, prompt: AI_PROMPTS.MERGE },
    { id: 'to_steps', label: t.aiMenu.toSteps, icon: ListChecks, prompt: AI_PROMPTS.TO_STEPS },
    { id: 'to_qa', label: t.aiMenu.toQA, icon: HelpCircle, prompt: AI_PROMPTS.TO_QA },
  ];

  const handleCommand = async (commandId: string, prompt: string) => {
    if (isAiCommandLoading || localLoadingAction) return;
    setIsManualCommandOpen(false);
    setLocalLoadingAction(commandId);
    await onAiRequest(prompt, 'replace-text');
    setLocalLoadingAction(null);
  };

  const handleManualCommandToggle = () => {
    if (!editor || isAiCommandLoading || localLoadingAction) return;
    const { from, to } = editor.state.selection;
    setManualSelectionRange({ from, to });
    setIsManualCommandOpen((current) => {
      const next = !current;
      if (next) {
        window.setTimeout(() => manualTextareaRef.current?.focus(), 0);
      }
      return next;
    });
  };

  const handleManualCommandSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedCommand = manualCommand.trim();
    if (!editor || !trimmedCommand || isAiCommandLoading || localLoadingAction) return;

    const range = manualSelectionRange ?? {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    if (range.from === range.to) return;

    setLocalLoadingAction(MANUAL_COMMAND_ID);
    editor.chain().focus().setTextSelection(range).run();

    try {
      await onAiRequest(`${MANUAL_COMMAND_PREFIX}\n\n${trimmedCommand}`, 'replace-text');
      setManualCommand('');
      setIsManualCommandOpen(false);
    } finally {
      setLocalLoadingAction(null);
    }
  };

  const updatePosition = useCallback(() => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');
    const wordCount = selectedText.trim().split(/\s+/).filter(Boolean).length;

    if (empty || wordCount < 8 || !scrollContainerRef.current) {
      setIsVisible(false);
      setIsManualCommandOpen(false);
      return;
    }

    const scrollEl = scrollContainerRef.current;
    const scrollRect = scrollEl.getBoundingClientRect();

    try {
        const selectionRange = window.getSelection()?.getRangeAt(0);
        if (!selectionRange) {
            setIsVisible(false);
            return;
        }
        
        const selectionRect = selectionRange.getBoundingClientRect();
        
        if (selectionRect.top < scrollRect.top || selectionRect.bottom > scrollRect.bottom || selectionRect.right < scrollRect.left || selectionRect.left > scrollRect.right) {
             setIsVisible(false);
             return;
        }

        const top = selectionRect.bottom - scrollRect.top + scrollEl.scrollTop;
        const left = selectionRect.left - scrollRect.left + scrollEl.scrollLeft + (selectionRect.width / 2);
        
        setPosition({ top, left });
        setManualSelectionRange({ from, to });
        setIsVisible(true);

    } catch (e) {
        setIsVisible(false);
    }

  }, [editor, scrollContainerRef]);

  useEffect(() => {
    if (!editor) return;
    const handler = () => updatePosition();
    
    editor.on('selectionUpdate', handler);
    editor.on('transaction', handler);

    const scrollEl = scrollContainerRef.current;
    if (scrollEl) {
        scrollEl.addEventListener('scroll', handler, { passive: true });
    }

    return () => {
      editor.off('selectionUpdate', handler);
      editor.off('transaction', handler);
      if (scrollEl) {
          scrollEl.removeEventListener('scroll', handler);
      }
    };
  }, [editor, updatePosition, scrollContainerRef]);
  
  if (!isVisible) {
    return null;
  }

  return (
    <div
      ref={toolbarRef}
      className="absolute z-10 p-1 bg-white dark:bg-[#2A2A2A] rounded-lg shadow-xl border border-gray-300 dark:border-[#3C3C3C]"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        transform: 'translateX(-50%) translateY(16px)',
        transition: 'opacity 0.15s ease-in-out',
        opacity: isVisible ? 1 : 0,
      }}
      aria-label={t.selectionToolbar}
    >
      <div className="flex items-center gap-1">
        {SELECTION_COMMANDS.map((command) => (
          <button
            key={command.id}
            onClick={() => handleCommand(command.id, command.prompt)}
            disabled={isAiCommandLoading || !!localLoadingAction}
            aria-label={command.label}
            className="group relative p-2 rounded-md transition-colors text-gray-600 dark:text-gray-300 hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20 disabled:text-gray-400 dark:disabled:text-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-[#2A2A2A] focus:ring-[#d4af37]"
          >
            {localLoadingAction === command.id ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <command.icon size={16} />
            )}
            <IconTooltip label={command.label} placement="top" />
          </button>
        ))}
        <button
          onClick={handleManualCommandToggle}
          disabled={isAiCommandLoading || !!localLoadingAction}
          aria-label={t.aiMenu.manualCommand}
          className={`group relative p-2 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-[#2A2A2A] focus:ring-[#d4af37] disabled:text-gray-400 dark:disabled:text-gray-600 ${
            isManualCommandOpen
              ? 'bg-[#d4af37]/10 text-[#d4af37] dark:bg-[#d4af37]/20 dark:text-[#f2d675]'
              : 'text-gray-600 dark:text-gray-300 hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20'
          }`}
        >
          <MessageSquarePlus size={16} />
          <IconTooltip label={t.aiMenu.manualCommand} placement="top" />
        </button>
      </div>
      {isManualCommandOpen && (
        <form onSubmit={handleManualCommandSubmit} className="mt-1 w-72 border-t border-gray-200 pt-2 dark:border-[#3C3C3C]">
          <textarea
            ref={manualTextareaRef}
            value={manualCommand}
            onChange={(event) => setManualCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setIsManualCommandOpen(false);
              }
            }}
            placeholder={t.aiMenu.manualCommandPlaceholder}
            aria-label={t.aiMenu.manualCommand}
            rows={3}
            dir={uiLanguage === 'ar' ? 'rtl' : 'ltr'}
            className="block w-full resize-none rounded-md border border-gray-300 bg-white p-2 text-xs leading-5 text-gray-800 shadow-inner focus:border-[#d4af37] focus:outline-none focus:ring-1 focus:ring-[#d4af37] dark:border-[#3C3C3C] dark:bg-[#1F1F1F] dark:text-gray-100"
          />
          <div className="mt-2 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => setIsManualCommandOpen(false)}
              aria-label={t.cancel}
              className="group relative rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-[#d4af37] dark:text-gray-300 dark:hover:bg-[#3C3C3C]"
            >
              <X size={15} />
              <IconTooltip label={t.cancel} placement="top" />
            </button>
            <button
              type="submit"
              disabled={!manualCommand.trim() || isAiCommandLoading || !!localLoadingAction}
              aria-label={t.aiMenu.sendManualCommand}
              className="group relative rounded-md bg-[#d4af37] p-1.5 text-white transition-colors hover:bg-[#b8922e] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#d4af37] disabled:bg-gray-400 disabled:opacity-70 dark:focus:ring-offset-[#2A2A2A] dark:disabled:bg-gray-600"
            >
              {localLoadingAction === MANUAL_COMMAND_ID ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              <IconTooltip label={t.aiMenu.sendManualCommand} placement="top" />
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

export default SelectionToolbar;
