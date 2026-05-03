import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LocateFixed, Sparkles, X } from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import { useAI } from '../contexts/AIContext';
import { useModal } from '../contexts/ModalContext';
import { useEditor } from '../contexts/EditorContext';
import { parseMarkdownToHtml } from '../utils/editorUtils';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const SuggestionModal: React.FC = () => {
  const { t } = useUser();
  const { editor, setTitle } = useEditor();
  const { suggestion, setSuggestion, markHistorySuggestionApplied } = useAI();
  const { closeModal } = useModal();

  const [position, setPosition] = useState({ x: 12, y: 72 });
  const [panelWidth, setPanelWidth] = useState(320);
  const [panelMaxHeight, setPanelMaxHeight] = useState(620);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  const getClampedPosition = useCallback((x: number, y: number) => ({
    x: clamp(x, 8, Math.max(8, window.innerWidth - panelWidth - 8)),
    y: clamp(y, 8, Math.max(8, window.innerHeight - 120)),
  }), [panelWidth]);

  useEffect(() => {
    if (!suggestion) return;

    const leftSidebar = document.querySelector('main > aside') as HTMLElement | null;
    const sidebarRect = leftSidebar?.getBoundingClientRect();
    const nextWidth = Math.max(280, Math.min(sidebarRect ? sidebarRect.width - 16 : 360, 420, window.innerWidth - 24));
    const nextX = sidebarRect ? sidebarRect.left + 8 : 12;
    const nextY = sidebarRect ? sidebarRect.top + 56 : 72;

    setPanelWidth(nextWidth);
    setPosition({
      x: clamp(nextX, 8, Math.max(8, window.innerWidth - nextWidth - 8)),
      y: clamp(nextY, 8, Math.max(8, window.innerHeight - 120)),
    });
  }, [suggestion]);

  useEffect(() => {
    setPanelMaxHeight(Math.max(280, window.innerHeight - position.y - 12));
  }, [position.y]);

  useEffect(() => {
    if (!isDragging) return;

    const handlePointerMove = (event: PointerEvent) => {
      setPosition(getClampedPosition(
        event.clientX - dragOffsetRef.current.x,
        event.clientY - dragOffsetRef.current.y
      ));
    };

    const handlePointerUp = () => setIsDragging(false);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [getClampedPosition, isDragging]);

  const handleCancel = () => {
    setSuggestion(null);
    closeModal();
  };

  const handleDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
    setIsDragging(true);
  };

  const handleLocate = () => {
    if (!editor || !suggestion || suggestion.action !== 'replace-text' || suggestion.from == null || suggestion.to == null) return;
    const docSize = editor.state.doc.content.size;
    if (suggestion.from < 0 || suggestion.to > docSize || suggestion.from >= suggestion.to) return;

    editor
      .chain()
      .focus()
      .setTextSelection({ from: suggestion.from, to: suggestion.to })
      .scrollIntoView()
      .run();
  };

  const handleAccept = (acceptedSuggestion: string) => {
    if (editor && suggestion) {
      switch (suggestion.action) {
        case 'replace-text':
          if (suggestion.from != null && suggestion.to != null) {
            const contentHtml = parseMarkdownToHtml(acceptedSuggestion);
            editor.chain().focus()
              .insertContentAt(
                { from: suggestion.from, to: suggestion.to },
                contentHtml
              )
              .run();
          }
          break;
        case 'replace-title':
          setTitle(acceptedSuggestion);
          break;
        case 'copy-meta':
          navigator.clipboard.writeText(acceptedSuggestion);
          break;
      }
    }
    if (suggestion?.historyItemId) {
      markHistorySuggestionApplied(suggestion.historyItemId, acceptedSuggestion);
    }
    setSuggestion(null);
    closeModal();
  };

  if (!suggestion) return null;

  const canLocate = suggestion.action === 'replace-text' && suggestion.from != null && suggestion.to != null;

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none"
      aria-modal="true"
      role="dialog"
    >
      <div
        className="fixed pointer-events-auto bg-white dark:bg-[#2A2A2A] rounded-lg shadow-2xl border border-gray-300 dark:border-[#3C3C3C] flex flex-col"
        style={{ left: position.x, top: position.y, width: panelWidth, maxHeight: panelMaxHeight }}
      >
        <div
          className={`flex justify-between items-center p-3 border-b border-gray-200 dark:border-[#3C3C3C] flex-shrink-0 cursor-move select-none ${isDragging ? 'bg-[#d4af37]/10 dark:bg-[#d4af37]/20' : ''}`}
          onPointerDown={handleDragStart}
        >
          <h3 className="text-base font-bold text-[#333333] dark:text-gray-100 flex items-center gap-2">
            <Sparkles size={16} className="text-[#d4af37]" />
            <span>{t.suggestion}</span>
          </h3>
          <button
            onPointerDown={(event) => event.stopPropagation()}
            onClick={handleCancel}
            className="p-1 rounded-full hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20"
            aria-label={t.close}
          >
            <X size={16} className="text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        <div className="p-3 space-y-3 overflow-y-auto custom-scrollbar">
          <div
            className="p-3 bg-gray-100 dark:bg-[#1F1F1F] rounded-md whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-300"
            role="region"
            aria-label={t.originalClickToClose}
          >
            <h4 className="font-semibold text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t.originalClickToClose}</h4>
            {suggestion.original}
          </div>

          <div className="flex flex-col gap-3">
            {suggestion.suggestions.map((suggestionText, index) => (
              <div
                key={index}
                className="flex-1 p-3 bg-[#d4af37]/10 dark:bg-[#d4af37]/20 rounded-md text-sm text-[#333333] dark:text-gray-100"
              >
                <h4 className="font-semibold text-xs text-[#b8922e] dark:text-[#f2d675] mb-1.5">
                  {t.suggestion} {index + 1}
                </h4>
                <div
                  className="ai-output"
                  dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(suggestionText) }}
                />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {canLocate && (
                    <button
                      type="button"
                      onClick={handleLocate}
                      className="flex items-center gap-1.5 rounded-md bg-white px-2 py-1 text-xs font-bold text-gray-700 hover:bg-[#d4af37]/15 dark:bg-[#1F1F1F] dark:text-gray-200 dark:hover:bg-[#d4af37]/20"
                    >
                      <LocateFixed size={13} />
                      <span>الموضع</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleAccept(suggestionText)}
                    className="flex items-center gap-1.5 rounded-md bg-[#d4af37] px-2 py-1 text-xs font-bold text-white hover:bg-[#b8922e]"
                    title={t.acceptSuggestion.replace('{number}', String(index + 1))}
                  >
                    <Check size={13} />
                    <span>{t.clickToAccept}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SuggestionModal;
