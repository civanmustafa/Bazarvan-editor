import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PenLine, Wand2, Zap, Expand, BookText, ListChecks, HelpCircle, Loader2 } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useAI } from '../contexts/AIContext';
import { AI_PROMPTS } from '../constants/aiPrompts';


const SelectionToolbar: React.FC = () => {
  const { uiLanguage } = useUser();
  const { editor, scrollContainerRef } = useEditor();
  const { handleAiRequest: onAiRequest, isAiCommandLoading } = useAI();
  
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [localLoadingAction, setLocalLoadingAction] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const t = translations[uiLanguage];

  const SELECTION_COMMANDS = [
    { id: 'rephrase', label: t.aiMenu.rephrase, icon: PenLine, prompt: AI_PROMPTS.REPHRASE },
    { id: 'improve', label: t.aiMenu.improveWording, icon: Wand2, prompt: AI_PROMPTS.IMPROVE_WORDING },
    { id: 'simplify', label: t.aiMenu.simplify, icon: Zap, prompt: AI_PROMPTS.SIMPLIFY_TEXT },
    { id: 'expand', label: t.aiMenu.expand, icon: Expand, prompt: AI_PROMPTS.EXPAND },
    { id: 'summarize', label: t.aiMenu.summarize, icon: BookText, prompt: AI_PROMPTS.SUMMARIZE },
    { id: 'to_steps', label: t.aiMenu.toSteps, icon: ListChecks, prompt: AI_PROMPTS.TO_STEPS },
    { id: 'to_qa', label: t.aiMenu.toQA, icon: HelpCircle, prompt: AI_PROMPTS.TO_QA },
  ];

  const handleCommand = async (commandId: string, prompt: string) => {
    if (isAiCommandLoading || localLoadingAction) return;
    setLocalLoadingAction(commandId);
    await onAiRequest(prompt, 'replace-text');
    setLocalLoadingAction(null);
  };

  const updatePosition = useCallback(() => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');
    const wordCount = selectedText.trim().split(/\s+/).filter(Boolean).length;

    if (empty || wordCount < 8 || !scrollContainerRef.current) {
      setIsVisible(false);
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
      className="absolute z-10 p-1 flex items-center gap-1 bg-white dark:bg-[#2A2A2A] rounded-lg shadow-xl border border-gray-300 dark:border-[#3C3C3C]"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        transform: 'translateX(-50%) translateY(16px)',
        transition: 'opacity 0.15s ease-in-out',
        opacity: isVisible ? 1 : 0,
      }}
      aria-label={t.selectionToolbar}
    >
      {SELECTION_COMMANDS.map((command) => (
        <button
          key={command.id}
          onClick={() => handleCommand(command.id, command.prompt)}
          disabled={isAiCommandLoading || !!localLoadingAction}
          title={command.label}
          className="p-2 rounded-md transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-[#3C3C3C] disabled:text-gray-400 dark:disabled:text-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-[#2A2A2A] focus:ring-[#00778e]"
        >
          {localLoadingAction === command.id ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <command.icon size={16} />
          )}
        </button>
      ))}
    </div>
  );
};

export default SelectionToolbar;
