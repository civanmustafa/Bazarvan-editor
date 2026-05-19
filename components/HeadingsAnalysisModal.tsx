import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileSignature, Lightbulb, LocateFixed, Minus, ThumbsDown, X } from 'lucide-react';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useAI } from '../contexts/AIContext';
import { useModal } from '../contexts/ModalContext';
import type { HeadingAnalysisResult } from '../types';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

type LiveHeadingTarget = {
  from: number;
  to: number;
  level: number;
  text: string;
};

const normalizeHeadingText = (value: string): string => value
  .normalize('NFKC')
  .replace(/[ًٌٍَُِّْـ]/g, '')
  .replace(/[\u200c\u200d\u200e\u200f]/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const HeadingsAnalysisModal: React.FC = () => {
  const { t } = useUser();
  const { editor } = useEditor();
  const { headingsAnalysis: analysis, setHeadingsAnalysis, setIsHeadingsAnalysisMinimized } = useAI();
  const { closeModal } = useModal();

  const [position, setPosition] = useState({ x: 12, y: 72 });
  const [panelWidth, setPanelWidth] = useState(300);
  const [panelMaxHeight, setPanelMaxHeight] = useState(620);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  const getClampedPosition = useCallback((x: number, y: number) => ({
    x: clamp(x, 8, Math.max(8, window.innerWidth - panelWidth - 8)),
    y: clamp(y, 8, Math.max(8, window.innerHeight - 120)),
  }), [panelWidth]);

  useEffect(() => {
    if (!analysis) return;

    const leftSidebar = document.querySelector('main > aside') as HTMLElement | null;
    const sidebarRect = leftSidebar?.getBoundingClientRect();
    const nextWidth = Math.max(220, Math.min(sidebarRect ? sidebarRect.width - 16 : 320, 360, window.innerWidth - 24));
    const nextX = sidebarRect ? sidebarRect.left + 8 : 12;
    const nextY = sidebarRect ? sidebarRect.top + 56 : 72;

    setPanelWidth(nextWidth);
    setPosition({
      x: clamp(nextX, 8, Math.max(8, window.innerWidth - nextWidth - 8)),
      y: clamp(nextY, 8, Math.max(8, window.innerHeight - 120)),
    });
  }, [analysis]);

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

  const handleClose = () => {
    setHeadingsAnalysis(null);
    closeModal();
  };

  const handleMinimize = () => {
    setIsHeadingsAnalysisMinimized(true);
    closeModal();
  };

  const handleDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
    setIsDragging(true);
  };

  const resolveLiveHeadingTarget = useCallback((item: HeadingAnalysisResult): LiveHeadingTarget | null => {
    if (!editor) return null;
    const normalizedOriginal = normalizeHeadingText(item.original);
    if (!normalizedOriginal) return null;
    const docSize = editor.state.doc.content.size;
    let bestTarget: (LiveHeadingTarget & { score: number }) | null = null;

    editor.state.doc.descendants((node: any, pos: number) => {
      if (node.type.name !== 'heading') return true;
      const text = node.textContent || '';
      const normalizedText = normalizeHeadingText(text);
      if (!normalizedText) return true;

      let score = 0;
      if (normalizedText === normalizedOriginal) {
        score = 4;
      } else if (normalizedText.includes(normalizedOriginal) || normalizedOriginal.includes(normalizedText)) {
        score = 3;
      } else {
        const originalWords = normalizedOriginal.split(' ').filter(word => word.length > 2);
        const overlap = originalWords.length
          ? originalWords.filter(word => normalizedText.includes(word)).length / originalWords.length
          : 0;
        score = overlap >= 0.7 ? overlap : 0;
      }

      if (score <= 0) return true;
      if ((node.attrs.level || 2) === item.level) score += 0.25;
      const target = {
        from: pos,
        to: pos + node.nodeSize,
        level: node.attrs.level || 2,
        text,
        score,
      };

      if (!bestTarget || target.score > bestTarget.score) {
        bestTarget = target;
        return true;
      }

      if (Math.abs(target.score - bestTarget.score) <= 0.001) {
        const nextDistance = Math.abs(target.from - item.from);
        const currentDistance = Math.abs(bestTarget.from - item.from);
        if (nextDistance < currentDistance) bestTarget = target;
      }
      return true;
    });

    if (!bestTarget || bestTarget.from < 0 || bestTarget.to > docSize || bestTarget.from >= bestTarget.to) {
      return null;
    }

    return {
      from: bestTarget.from,
      to: bestTarget.to,
      level: bestTarget.level,
      text: bestTarget.text,
    };
  }, [editor]);

  const refreshAnalysisTargets = useCallback((items: HeadingAnalysisResult[]): HeadingAnalysisResult[] => (
    items
      .map(item => {
        const target = resolveLiveHeadingTarget(item);
        return target
          ? { ...item, from: target.from, to: target.to, level: target.level, original: target.text }
          : null;
      })
      .filter((item): item is HeadingAnalysisResult => Boolean(item))
  ), [resolveLiveHeadingTarget]);

  const handleLocateHeading = (item: HeadingAnalysisResult) => {
    if (!editor) return;
    const target = resolveLiveHeadingTarget(item);
    if (!target) return;

    editor
      .chain()
      .focus()
      .setTextSelection({ from: target.from, to: target.to })
      .scrollIntoView()
      .run();
  };

  const handleSuggestionClick = (item: HeadingAnalysisResult, suggestion: string) => {
    if (!analysis) return;
    const target = resolveLiveHeadingTarget(item);
    if (editor && target) {
        const newHeadingContent = {
            type: 'heading',
            attrs: { level: target.level },
            content: suggestion.trim() ? [{ type: 'text', text: suggestion }] : [],
        };
        editor.chain().focus()
            .insertContentAt({ from: target.from, to: target.to }, newHeadingContent, {
                updateSelection: true,
                parseOptions: {
                    preserveWhitespace: false,
                },
            })
            .run();

        const updatedAnalysis = refreshAnalysisTargets(analysis.filter(a => a !== item));

        if (updatedAnalysis.length > 0) {
            setHeadingsAnalysis(updatedAnalysis);
        } else {
            handleClose();
        }
    }
  };

  if (!analysis) return null;

  return (
    <div
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 9999 }}
      aria-modal="true"
      role="dialog"
    >
      <div
        data-toolbar-ai-headings-panel="true"
        className="fixed pointer-events-auto bg-white dark:bg-[#2A2A2A] rounded-lg shadow-2xl border border-gray-300 dark:border-[#3C3C3C] flex flex-col"
        style={{ left: position.x, top: position.y, width: panelWidth, maxHeight: panelMaxHeight, zIndex: 10000 }}
      >
        <div
          className={`flex justify-between items-center p-2 border-b border-gray-200 dark:border-[#3C3C3C] cursor-move select-none ${isDragging ? 'bg-[#d4af37]/10 dark:bg-[#d4af37]/20' : ''}`}
          onPointerDown={handleDragStart}
        >
          <h3 className="text-base font-bold text-[#333333] dark:text-gray-100 flex items-center gap-2">
            <FileSignature size={16} />
            <span>{t.headingsAnalysis} ({analysis.length})</span>
          </h3>
          <div className="flex items-center">
            <button
              onPointerDown={(event) => event.stopPropagation()}
              onClick={handleMinimize}
              className="p-1 rounded-full hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20"
              aria-label={t.minimize}
            >
              <Minus size={16} className="text-gray-500 dark:text-gray-400" />
            </button>
            <button
              onPointerDown={(event) => event.stopPropagation()}
              onClick={handleClose}
              className="p-1 rounded-full hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20"
              aria-label={t.close}
            >
              <X size={16} className="text-gray-500 dark:text-gray-400" />
            </button>
          </div>
        </div>

        <div className="flex-grow overflow-y-auto custom-scrollbar p-2 space-y-2">
          {analysis.map((item) => (
            <div key={item.from} className="bg-gray-50 dark:bg-[#1F1F1F] p-2 rounded-md border border-gray-200 dark:border-[#3C3C3C]">
              <div className="mb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-xs font-semibold bg-gray-200 dark:bg-[#3C3C3C] text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded-full">H{item.level}</span>
                    <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mt-1">{item.original}</h4>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleLocateHeading(item)}
                    className="shrink-0 flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs font-bold text-gray-700 hover:bg-[#d4af37]/15 dark:bg-[#2A2A2A] dark:text-gray-200 dark:hover:bg-[#d4af37]/20"
                  >
                    <LocateFixed size={13} />
                    <span>الموضع</span>
                  </button>
                </div>
              </div>

              <div className="bg-red-50 dark:bg-red-900/20 p-2 rounded-md mb-2">
                <h5 className="flex items-center gap-1.5 text-xs font-semibold text-red-800 dark:text-red-300 mb-1">
                  <ThumbsDown size={14} />
                  <span>{t.flaws}</span>
                </h5>
                <ul className="list-disc list-inside space-y-0.5 text-xs text-red-700 dark:text-red-300/90 ps-1">
                  {item.flaws.map((flaw, i) => <li key={i}>{flaw}</li>)}
                </ul>
              </div>

              <div>
                <h5 className="flex items-center gap-1.5 text-xs font-semibold text-green-800 dark:text-green-300 mb-1.5">
                  <Lightbulb size={14} />
                  <span>{t.suggestionsClickToReplace}</span>
                </h5>
                <div className="space-y-1.5">
                  {item.suggestions.map((suggestion, sugIndex) => (
                    <div
                      key={sugIndex}
                      className="rounded-md bg-[#d4af37]/10 dark:bg-[#d4af37]/20 p-2"
                    >
                      <div className="text-sm font-medium text-[#b8922e] dark:text-[#f2d675]">{suggestion}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleLocateHeading(item)}
                          className="flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs font-bold text-gray-700 hover:bg-[#d4af37]/15 dark:bg-[#1F1F1F] dark:text-gray-200 dark:hover:bg-[#d4af37]/20"
                        >
                          <LocateFixed size={13} />
                          <span>الموضع</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSuggestionClick(item, suggestion)}
                          className="rounded-md bg-[#d4af37] px-2 py-1 text-xs font-bold text-white hover:bg-[#b8922e]"
                        >
                          استبدال
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default HeadingsAnalysisModal;
