import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronDown, ClipboardCopy } from 'lucide-react';
import { useEditorSelector } from '../../contexts/EditorContext';
import {
  buildStructuredArticleExport,
  copyUtf8Text,
} from '../../utils/articleStructuredExport';
import StructuredArticleExportModal from '../StructuredArticleExportModal';
import { IconTooltip } from './ToolbarItems';

type StructuredArticleExportActionsProps = {
  locale: 'ar' | 'en';
};

const StructuredArticleExportActions: React.FC<StructuredArticleExportActionsProps> = ({ locale }) => {
  const editor = useEditorSelector(context => context.editor);
  const title = useEditorSelector(context => context.title);
  const metaDescription = useEditorSelector(context => context.metaDescription);
  const language = useEditorSelector(context => context.articleLanguage);
  const keywords = useEditorSelector(context => context.keywords);
  const [modalDocument, setModalDocument] = useState<unknown | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimerRef = useRef<number | null>(null);
  const isArabic = locale === 'ar';
  const canExport = Boolean(editor && !editor.isDestroyed);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const scheduleReset = useCallback(() => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2200);
  }, []);

  const handleQuickCopy = useCallback(async () => {
    if (!editor || editor.isDestroyed) return;
    try {
      const result = buildStructuredArticleExport({
        title,
        metaDescription,
        language,
        keywords,
        document: editor.getJSON(),
      });
      await copyUtf8Text(result.content);
      setCopyState('copied');
    } catch (error) {
      console.error('Could not copy the structured article export:', error);
      setCopyState('error');
    }
    scheduleReset();
  }, [editor, keywords, language, metaDescription, scheduleReset, title]);

  const quickCopyLabel = copyState === 'copied'
    ? (isArabic ? 'تم نسخ المقالة والسياق' : 'Article and context copied')
    : copyState === 'error'
      ? (isArabic ? 'تعذر نسخ المقالة' : 'Could not copy article')
      : (isArabic ? 'نسخ المقالة والسياق بصيغة Markdown منظمة' : 'Copy article and context as structured Markdown');

  return (
    <>
      <div className="flex h-8 items-stretch overflow-visible rounded-md border border-[#d4af37]/45 bg-[#d4af37]/10 dark:bg-[#d4af37]/10">
        <button
          type="button"
          onClick={() => void handleQuickCopy()}
          disabled={!canExport}
          aria-label={quickCopyLabel}
          title={quickCopyLabel}
          data-structured-export-quick-copy="true"
          className={`group relative inline-flex min-w-0 items-center justify-center gap-1.5 px-2 text-xs font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] disabled:cursor-not-allowed disabled:opacity-40 ${copyState === 'copied' ? 'text-emerald-700 dark:text-emerald-300' : copyState === 'error' ? 'text-red-600 dark:text-red-300' : 'text-[#806416] hover:bg-[#d4af37]/15 dark:text-[#f2d675]'}`}
        >
          {copyState === 'copied' ? <Check size={16} /> : copyState === 'error' ? <AlertCircle size={16} /> : <ClipboardCopy size={16} />}
          <span className="hidden whitespace-nowrap 2xl:inline">
            {copyState === 'copied'
              ? (isArabic ? 'تم النسخ' : 'Copied')
              : (isArabic ? 'نسخ منظم' : 'Structured copy')}
          </span>
          <IconTooltip label={quickCopyLabel} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (editor && !editor.isDestroyed) setModalDocument(editor.getJSON());
          }}
          disabled={!canExport}
          aria-label={isArabic ? 'معاينة وخيارات تصدير المقالة' : 'Preview and article export options'}
          title={isArabic ? 'معاينة وخيارات التصدير' : 'Preview and export options'}
          data-structured-export-preview="true"
          className="group relative inline-flex w-7 items-center justify-center border-s border-[#d4af37]/35 text-[#806416] transition hover:bg-[#d4af37]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37] disabled:cursor-not-allowed disabled:opacity-40 dark:text-[#f2d675]"
        >
          <ChevronDown size={14} />
          <IconTooltip label={isArabic ? 'معاينة، تخصيص، أو تنزيل .md' : 'Preview, customize, or download .md'} />
        </button>
      </div>
      <span className="sr-only" aria-live="polite">{copyState === 'idle' ? '' : quickCopyLabel}</span>
      {modalDocument !== null && (
        <StructuredArticleExportModal
          title={title}
          metaDescription={metaDescription}
          language={language}
          locale={locale}
          keywords={keywords}
          document={modalDocument}
          onClose={() => setModalDocument(null)}
        />
      )}
    </>
  );
};

export default StructuredArticleExportActions;
