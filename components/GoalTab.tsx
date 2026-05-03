import React from 'react';
import { CheckCircle, Save, Target } from 'lucide-react';
import { translations } from './translations';
import { useUser } from '../contexts/UserContext';
import { useEditor } from '../contexts/EditorContext';
import GoalContextFields from './GoalContextFields';

const GoalTab: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
    const {
        uiLanguage,
        clientGoalContexts,
        handleSaveClientGoalContext,
    } = useUser();
    const { 
        goalContext,
        setGoalContext,
        keywords,
    } = useEditor();
    const [lastSavedCompany, setLastSavedCompany] = React.useState('');

  const t = translations[uiLanguage].goalTab;
  const companyName = keywords.company.trim();
  const isClientSaved = Boolean(companyName && clientGoalContexts[companyName]);
  const savedMessage = companyName && lastSavedCompany === companyName
    ? t.clientContextSaved.replace('{company}', companyName)
    : '';
  const contextStatusMessage = savedMessage || (isClientSaved ? t.clientAlreadySaved : '');

  const updateGoalContext = (key: keyof typeof goalContext, value: string) => {
    setGoalContext(prev => ({ ...prev, [key]: value }));
  };

  const handleSaveClientContext = () => {
    if (!companyName || isClientSaved) return;
    handleSaveClientGoalContext(companyName, goalContext);
    setLastSavedCompany(companyName);
  };

  return (
    <div className={`${embedded ? 'p-0' : 'p-4'} space-y-4`}>
      <div className="bg-white dark:bg-[#2A2A2A] rounded-xl shadow-sm border dark:border-[#3C3C3C] p-4 space-y-4 transition-all duration-300 border-gray-200 dark:border-transparent">
        <div className="space-y-3">
            <div>
                <div className="flex items-center gap-2">
                    <span className="text-[#d4af37]"><Target size={20} /></span>
                    <h4 className="text-sm font-bold text-[#333333] dark:text-gray-100">{t.contextTitle}</h4>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t.contextDescription}</p>
            </div>
            <GoalContextFields goalContext={goalContext} onChange={updateGoalContext} />
            <div className="space-y-2 pt-2">
                <button
                    type="button"
                    onClick={handleSaveClientContext}
                    disabled={!companyName || isClientSaved}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-[#d4af37] px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-[#b8922e] disabled:cursor-not-allowed disabled:opacity-50"
                    title={!companyName ? t.companyRequiredForContextSave : undefined}
                >
                    <Save size={16} />
                    <span>{t.saveClientContext}</span>
                </button>
                {contextStatusMessage && (
                    <p className="flex items-start gap-2 text-xs font-bold text-green-600 dark:text-green-400" aria-live="polite">
                        <CheckCircle size={14} className="mt-0.5 flex-shrink-0" />
                        <span>{contextStatusMessage}</span>
                    </p>
                )}
                {!companyName && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t.companyRequiredForContextSave}
                    </p>
                )}
            </div>
        </div>

      </div>
    </div>
  );
};

export default GoalTab;
