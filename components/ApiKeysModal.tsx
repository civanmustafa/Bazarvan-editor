
import React, { useState } from 'react';
import { Key, X, Plus, Trash2 } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useModal } from '../contexts/ModalContext';

const ApiKeysModal: React.FC = () => {
  const { apiKeys, handleSaveApiKeys, uiLanguage, t } = useUser();
  const { closeModal } = useModal();
  const [keys, setKeys] = useState(apiKeys);

  const handleGeminiChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setKeys(prev => ({ ...prev, gemini: e.target.value }));
  };

  const handlePerplexityChange = (index: number, value: string) => {
    const newPerplexityKeys = [...keys.perplexity];
    newPerplexityKeys[index] = value;
    setKeys(prev => ({ ...prev, perplexity: newPerplexityKeys }));
  };

  const addPerplexityKey = () => {
    setKeys(prev => ({ ...prev, perplexity: [...prev.perplexity, ''] }));
  };

  const removePerplexityKey = (index: number) => {
    const newPerplexityKeys = keys.perplexity.filter((_, i) => i !== index);
    setKeys(prev => ({ ...prev, perplexity: newPerplexityKeys.length > 0 ? newPerplexityKeys : [''] }));
  };

  const handleSave = () => {
    handleSaveApiKeys(keys);
    closeModal();
  };
  
  const handleClose = () => {
    closeModal();
  }

  return (
    <div 
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={handleClose}
      aria-modal="true"
      role="dialog"
    >
      <div 
        className="bg-white dark:bg-[#2A2A2A] rounded-lg shadow-xl w-full max-w-lg p-6 border dark:border-[#3C3C3C]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4 pb-3 border-b border-gray-200 dark:border-[#3C3C3C]">
          <h3 className="text-xl font-bold text-[#333333] dark:text-gray-100 flex items-center gap-2">
            <Key size={20} />
            <span>{t.manageApiKeys}</span>
          </h3>
          <button onClick={handleClose} className="p-1 rounded-full hover:bg-[#d4af37]/10 dark:hover:bg-[#d4af37]/20" aria-label={t.close}>
            <X size={20} className="text-gray-500 dark:text-gray-400" />
          </button>
        </div>
        
        <div className="space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar px-1">
          <div>
            <label htmlFor="gemini-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t.geminiApiKey}
            </label>
            <input
              id="gemini-key"
              name="gemini"
              type="password"
              value={keys.gemini}
              onChange={handleGeminiChange}
              className="w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-start text-sm text-[#333333] dark:text-[#e0e0e0]"
              placeholder={t.enterGeminiKey}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t.perplexityApiKeys}
            </label>
            <div className="space-y-2">
              {keys.perplexity.map((key, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    aria-label={`Perplexity API Key ${index + 1}`}
                    name={`perplexity-${index}`}
                    type="password"
                    value={key}
                    onChange={(e) => handlePerplexityChange(index, e.target.value)}
                    className="w-full p-2 bg-gray-50 dark:bg-[#1F1F1F] rounded-md border border-gray-300 dark:border-[#3C3C3C] focus:ring-1 focus:ring-[#d4af37] focus:border-[#d4af37] text-start text-sm text-[#333333] dark:text-[#e0e0e0]"
                    placeholder={`${t.key} #${index + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => removePerplexityKey(index)}
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-md"
                    title={t.removeKey}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addPerplexityKey}
              className="mt-2 flex items-center gap-1.5 text-sm text-[#d4af37] font-semibold hover:underline"
            >
              <Plus size={14} />
              {t.addAnotherKey}
            </button>
          </div>
        </div>

        <div className={`mt-6 flex ${uiLanguage === 'ar' ? 'justify-end' : 'justify-start'} gap-3`}>
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm font-semibold text-gray-700 bg-gray-100 rounded-md hover:bg-[#d4af37]/15 dark:bg-[#3C3C3C] dark:text-gray-200 dark:hover:bg-[#d4af37]/25"
          >
            {t.cancel}
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-semibold text-white bg-[#d4af37] rounded-md hover:bg-[#b8922e]"
          >
            {t.saveKeys}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ApiKeysModal;
