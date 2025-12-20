import React from 'react';
import { X, Sparkles } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useAI } from '../contexts/AIContext';
import { useModal } from '../contexts/ModalContext';
import { useEditor } from '../contexts/EditorContext';
import { parseMarkdownToHtml } from '../utils/editorUtils';

const SuggestionModal: React.FC = () => {
  const { uiLanguage, t } = useUser();
  const { editor, setTitle } = useEditor();
  const { suggestion, setSuggestion } = useAI();
  const { closeModal } = useModal();

  const handleCancel = () => {
    setSuggestion(null);
    closeModal();
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
    setSuggestion(null);
    closeModal();
  };
  
  if (!suggestion) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={handleCancel}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="bg-white dark:bg-[#2A2A2A] rounded-lg shadow-xl w-full max-w-3xl border dark:border-[#3C3C3C] flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-3 border-b border-gray-200 dark:border-[#3C3C3C] flex-shrink-0">
          <h3 className="text-base font-bold text-[#333333] dark:text-gray-100 flex items-center gap-2">
            <Sparkles size={16} className="text-[#00778e]" />
            <span>{t.suggestion}</span>
          </h3>
          <button onClick={handleCancel} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-[#3C3C3C]" aria-label={t.close}>
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

          <div className="flex flex-col md:flex-row gap-3">
            {suggestion.suggestions.map((suggestionText, index) => (
              <div
                key={index}
                onClick={() => handleAccept(suggestionText)}
                className="flex-1 p-3 bg-[#00778e]/10 dark:bg-[#00778e]/20 rounded-md text-sm text-[#005f73] dark:text-[#94d2bd] cursor-pointer transition-colors hover:bg-[#00778e]/20 dark:hover:bg-[#00778e]/30"
                role="button"
                tabIndex={0}
                title={t.acceptSuggestion.replace('{number}', String(index + 1))}
              >
                <h4 className="font-semibold text-xs text-[#005f73] dark:text-teal-300 mb-1.5">
                  {t.suggestion} {index + 1} ({t.clickToAccept})
                </h4>
                <div
                  className="ai-output"
                  dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(suggestionText) }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SuggestionModal;