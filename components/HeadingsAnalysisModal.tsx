import React from 'react';
import { X, ThumbsDown, Lightbulb, Minus, FileSignature } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { useAI } from '../contexts/AIContext';
import { useModal } from '../contexts/ModalContext';

const HeadingsAnalysisModal: React.FC = () => {
  const { uiLanguage, t } = useUser();
  const { editor } = useEditor();
  const { headingsAnalysis: analysis, setHeadingsAnalysis, setIsHeadingsAnalysisMinimized } = useAI();
  const { closeModal } = useModal();

  const handleClose = () => {
    setHeadingsAnalysis(null);
    closeModal();
  };
  const handleMinimize = () => {
    setIsHeadingsAnalysisMinimized(true);
    closeModal();
  };

  const handleSuggestionClick = (originalFrom: number, suggestion: string) => {
    if (!analysis) return;
    const itemToUpdate = analysis.find(a => a.from === originalFrom);
    if (editor && itemToUpdate) {
        const newHeadingContent = {
            type: 'heading',
            attrs: { level: itemToUpdate.level },
            content: suggestion.trim() ? [{ type: 'text', text: suggestion }] : [],
        };
        editor.chain().focus()
            .insertContentAt({ from: itemToUpdate.from, to: itemToUpdate.to }, newHeadingContent, {
                updateSelection: true,
                parseOptions: {
                    preserveWhitespace: false,
                },
            })
            .run();
        
        const updatedAnalysis = analysis.filter(a => a.from !== originalFrom);
        
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
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-2"
      onClick={handleClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="bg-white dark:bg-[#2A2A2A] rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col border dark:border-[#3C3C3C]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-2 border-b border-gray-200 dark:border-[#3C3C3C]">
          <h3 className="text-base font-bold text-[#333333] dark:text-gray-100 flex items-center gap-2">
            <FileSignature size={16} />
            <span>{t.headingsAnalysis} ({analysis.length})</span>
          </h3>
          <div className="flex items-center">
            <button onClick={handleMinimize} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-[#3C3C3C]" aria-label={t.minimize}>
                <Minus size={16} className="text-gray-500 dark:text-gray-400" />
            </button>
            <button onClick={handleClose} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-[#3C3C3C]" aria-label={t.close}>
                <X size={16} className="text-gray-500 dark:text-gray-400" />
            </button>
          </div>
        </div>

        <div className="flex-grow overflow-y-auto custom-scrollbar p-2 space-y-2">
            {analysis.map((item, index) => (
              <div key={item.from} className="bg-gray-50 dark:bg-[#1F1F1F] p-2 rounded-md border border-gray-200 dark:border-[#3C3C3C]">
                <div className="mb-2">
                  <span className="text-xs font-semibold bg-gray-200 dark:bg-[#3C3C3C] text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded-full">H{item.level}</span>
                  <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mt-1">{item.original}</h4>
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
                    <div className="space-y-1">
                        {item.suggestions.map((suggestion, sugIndex) => (
                            <button
                                key={sugIndex}
                                onClick={() => handleSuggestionClick(item.from, suggestion)}
                                className="w-full text-start p-2 text-sm font-medium text-[#005f73] dark:text-[#94d2bd] bg-[#00778e]/10 dark:bg-[#00778e]/20 rounded-md hover:bg-[#00778e]/20 dark:hover:bg-[#00778e]/30 transition-colors"
                            >
                                {suggestion}
                            </button>
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
