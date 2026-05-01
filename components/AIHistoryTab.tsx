import React from 'react';
import { useAI } from '../contexts/AIContext';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import { BookCopy, Trash2, Check } from 'lucide-react';
import { parseMarkdownToHtml } from '../utils/editorUtils';

const AIHistoryTab: React.FC = () => {
    const { aiHistory, applySuggestionFromHistory, removeFromAiHistory } = useAI();
    const { t } = useUser();
    const { editor } = useEditor();

    if (aiHistory.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full p-4 text-center">
                <BookCopy size={48} className="text-gray-300 dark:text-gray-600 mb-4" />
                <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300">{t.aiHistory.noHistoryTitle}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t.aiHistory.noHistoryDescription}</p>
            </div>
        );
    }

    const handleOriginalTextClick = (from: number, to: number) => {
        if (!editor) return;
        const docSize = editor.state.doc.content.size;
        if (from < 0 || to > docSize || from >= to) return;
        editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
    };

    return (
        <div className="p-2 space-y-3">
            {aiHistory.map((item) => (
                <div key={item.id} className="bg-white dark:bg-[#2A2A2A] rounded-lg border border-gray-200 dark:border-[#3C3C3C] overflow-hidden">
                    <div className="p-3 border-b border-gray-200 dark:border-[#3C3C3C]">
                        <div className="flex justify-between items-start gap-2">
                            <div>
                                <h4 className="text-xs font-bold text-[#d4af37] dark:text-[#f2d675] uppercase tracking-wider">
                                    {item.type === 'fix-violation' ? t.aiHistory.violationFix : t.aiHistory.userCommand}
                                </h4>
                                {item.ruleTitle && (
                                    <p className="text-base font-semibold text-[#333333] dark:text-[#b7b7b7] mt-1 ai-history-content-text">{item.ruleTitle}</p>
                                )}
                            </div>
                            <button 
                                onClick={() => removeFromAiHistory(item.id)}
                                className="p-1.5 rounded-full text-gray-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                                title={t.aiHistory.remove}
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                        <p 
                            onClick={() => handleOriginalTextClick(item.from, item.to)}
                            className="mt-2 text-sm text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-[#1F1F1F] p-2 rounded-md line-clamp-2 cursor-pointer hover:bg-[#d4af37]/15 dark:hover:bg-[#d4af37]/20 transition-colors"
                            title={t.aiHistory.original}
                        >
                            <span className="font-semibold">{t.aiHistory.original}: </span><span className="ai-history-content-text">{item.originalText}</span>
                        </p>
                        {item.applyError && (
                            <p className="mt-2 text-xs font-semibold text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 p-2 rounded-md">
                                {item.applyError}
                            </p>
                        )}
                    </div>

                    <div className="p-3 space-y-2 bg-gray-50/50 dark:bg-[#2A2A2A]/50">
                        {item.suggestions.map((suggestion, index) => {
                            const isApplied = item.appliedSuggestion === suggestion;
                            const isDisabled = !!item.appliedSuggestion && !isApplied;

                            return (
                                <div
                                    key={index}
                                    onClick={() => !item.appliedSuggestion && applySuggestionFromHistory(item.id, suggestion)}
                                    className={`relative p-3 rounded-md transition-all duration-200 ${
                                        isApplied
                                            ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-300 dark:border-emerald-700/50 border'
                                            : isDisabled
                                                ? 'bg-gray-100 dark:bg-[#1F1F1F] opacity-50 cursor-not-allowed'
                                                : 'cursor-pointer bg-white dark:bg-[#1F1F1F] border border-gray-200 dark:border-[#3C3C3C] hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20'
                                    }`}
                                >
                                    {isApplied && (
                                        <div className="absolute top-2 end-2 flex items-center gap-1.5 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                                            <Check size={14} />
                                            <span>{t.aiHistory.applied}</span>
                                        </div>
                                    )}
                                    <div
                                        className="ai-output text-sm text-[#333333] dark:text-[#b7b7b7]"
                                        dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(suggestion) }}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
};

export default AIHistoryTab;
